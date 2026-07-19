import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readWorkflowJournal } from "../../src/workflows/journal.ts";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { QuestionService } from "../../src/workflows/questions.ts";
import {
  WorkflowRunLifecycle,
  terminalEnvelopeFromEvent,
  type CompletionValidationHooks,
  type FinishRequest,
  type FinishResult,
} from "../../src/workflows/runs.ts";

function questionSnapshot(): ActivationSnapshotFileV1 {
  return { snapshotHash: "q".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", payload: {
    project: { projectId: "project-1", rootRef: "." }, workflow: { id: "w", team: { rootId: "root", nodes: [{ id: "root", agentId: "lead", memberIds: [], depth: 1 }] } },
    authority: { capabilityContractVersion: 1, nodes: [{ nodeId: "root", capabilities: { effective: { "human-input": true } }, tools: ["human_question"] }] },
    agents: [{ id: "lead", name: "Lead", prompt: "lead" }], skills: [], knowledge: [], models: [], sources: [], versions: {} as never,
  } } as unknown as ActivationSnapshotFileV1;
}

function fixture(hooks: CompletionValidationHooks = {}, journalFault?: (eventType: string, stage: string) => void) {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-run-finish-"));
  let run = 0;
  let tick = 0;
  const lifecycle = new WorkflowRunLifecycle({
    projectRoot,
    projectId: "project-1",
    sessionId: "session-1",
    snapshotId: "snapshot-1",
    rootNodeId: "root",
    createRunId: () => `run-${++run}`,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    completion: hooks,
    journalFault: journalFault as any,
  });
  return { projectRoot, lifecycle };
}

function startAndDeliver(lifecycle: WorkflowRunLifecycle) {
  lifecycle.recordUserInput({ inputId: "initial", text: "do the work", source: "interactive" });
  lifecycle.prepareInputDelivery("request-1");
  lifecycle.confirmInputDelivery("request-1");
}

const request: FinishRequest = {
  status: "completed",
  summary: "Work completed and verified.",
  artifactRefs: [],
  evidenceRefs: [],
  data: { outcome: "ok" },
};
const rootBatch = { callerNodeId: "root", toolBatch: ["workflow_finish"] } as const;
const issuesOf = (result: FinishResult): string => result.ok ? "" : result.issues.join("\n");

test("workflow_finish is root-only, sole-call, rejects harness fields, and atomically blocks pending-input races", async () => {
  const f = fixture();
  startAndDeliver(f.lifecycle);

  assert.match(issuesOf(await f.lifecycle.finish(request, { callerNodeId: "worker", toolBatch: ["workflow_finish"] })), /root/i);
  assert.match(issuesOf(await f.lifecycle.finish(request, { callerNodeId: "root", toolBatch: ["read", "workflow_finish"] })), /sole|batch/i);
  assert.match(issuesOf(await f.lifecycle.finish({ ...request, finishedAt: "forged" } as any, rootBatch)), /field|finishedAt/i);
  assert.equal(f.lifecycle.restore().latestRun?.status, "running");

  f.lifecycle.recordUserInput({ inputId: "late", text: "include this too", source: "interactive" });
  const pending = await f.lifecycle.finish(request, rootBatch);
  assert.equal(pending.ok, false);
  assert.match(pending.issues.join("\n"), /input|deliver/i);

  f.lifecycle.prepareInputDelivery("request-2");
  f.lifecycle.confirmInputDelivery("request-2");
  let raced = false;
  const racing = fixture({
    async descendants() {
      if (!raced) {
        raced = true;
        racing.lifecycle.recordUserInput({ inputId: "raced", text: "arrived during validation", source: "rpc" });
      }
      return { state: "satisfied" };
    },
  });
  startAndDeliver(racing.lifecycle);
  const raceResult = await racing.lifecycle.finish(request, rootBatch);
  assert.equal(raceResult.ok, false);
  assert.match(raceResult.issues.join("\n"), /input|changed|race/i);
  assert.equal(racing.lifecycle.restore().latestRun?.status, "running");
});

test("completed finish persists one bounded authoritative envelope and the next message starts a fresh run", async () => {
  const f = fixture();
  startAndDeliver(f.lifecycle);
  const result = await f.lifecycle.finish(request, rootBatch);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const terminalEvent = readWorkflowJournal(f.projectRoot, "session-1").at(-1)!;
  assert.equal(terminalEvent.type, "terminal.recorded");
  assert.deepEqual(result.envelope, terminalEnvelopeFromEvent(terminalEvent));
  assert.deepEqual(JSON.parse(result.rendered), result.envelope);
  assert.ok(Buffer.byteLength(result.rendered, "utf8") <= 131_072);
  assert.equal(result.envelope.finishedByNodeId, "root");
  assert.equal(result.envelope.snapshotId, "snapshot-1");
  assert.equal(result.envelope.terminalEventHash, terminalEvent.eventHash);
  assert.equal(f.lifecycle.restore().latestRun?.status, "completed");

  const next = f.lifecycle.recordUserInput({ inputId: "next", text: "new objective", source: "interactive" });
  assert.equal(next.created, true);
  assert.equal(next.runId, "run-2");
});

test("completion gates are status-specific and blocked/failed closures require verified evidence", async () => {
  const settlements: any[] = [];
  const unsatisfied: CompletionValidationHooks = {
    descendants: async () => ({ state: "satisfied" }),
    questions: async () => ({ state: "unsatisfied", issues: ["question pending"], pendingQuestionIds: ["question-1"] }),
    adapter: async () => ({ state: "unsatisfied", issues: ["adapter incomplete"] }),
    approvals: async () => ({ state: "unsatisfied", issues: ["approval missing"] }),
    lease: async () => ({ state: "unsatisfied", issues: ["writer lease invalid"] }),
    evidence: async (refs) => ({ state: refs.length ? "satisfied" : "not-present" }),
    artifacts: async () => ({ state: "not-present" }),
    projectState: async () => ({ state: "satisfied", fileChanges: [], changeCoverage: "recorded" }),
    settleTerminal: async (settlement) => { settlements.push(settlement); },
  };

  const completed = fixture(unsatisfied);
  startAndDeliver(completed.lifecycle);
  const completedResult = await completed.lifecycle.finish(request, rootBatch);
  assert.equal(completedResult.ok, false);
  assert.match(completedResult.issues.join("\n"), /question|adapter|approval|lease/i);

  for (const status of ["blocked", "failed"] as const) {
    const withoutEvidence = fixture(unsatisfied);
    startAndDeliver(withoutEvidence.lifecycle);
    const denied = await withoutEvidence.lifecycle.finish({ ...request, status, summary: `${status} for a durable reason.` }, rootBatch);
    assert.equal(denied.ok, false);
    assert.match(denied.issues.join("\n"), /evidence/i);

    const withEvidence = fixture(unsatisfied);
    startAndDeliver(withEvidence.lifecycle);
    const closed = await withEvidence.lifecycle.finish({
      ...request,
      status,
      summary: `${status} because the external dependency is unavailable.`,
      evidenceRefs: [{ kind: "tool-result", toolCallId: "call-1", claim: "dependency probe failed" }],
    }, rootBatch);
    assert.equal(closed.ok, true, issuesOf(closed));
    if (!closed.ok) continue;
    assert.deepEqual(closed.envelope.closedQuestionIds, ["question-1"]);
    assert.ok(closed.envelope.unsatisfiedGates.some((gate) => /question pending/.test(gate)));
    assert.ok(closed.envelope.unsatisfiedGates.some((gate) => /adapter incomplete/.test(gate)));
    const settlement = settlements.at(-1);
    assert.deepEqual(settlement.closedQuestionIds, ["question-1"]);
    assert.ok(settlement.unsatisfiedGates.some((gate: string) => /adapter incomplete/.test(gate)));
    assert.equal(settlement.releaseLease, true);
  }
});

test("terminal settlement intent makes question closure and lease release replay-safe", async () => {
  const operationIds: string[] = [];
  let attempts = 0;
  const f = fixture({
    questions: async () => ({ state: "unsatisfied", issues: ["question pending"], pendingQuestionIds: ["q-1"] }),
    adapter: async () => ({ state: "unsatisfied", issues: ["checkpoint incomplete"] }),
    evidence: async () => ({ state: "satisfied" }),
    lease: async () => ({ state: "satisfied" }),
    settleTerminal: async (settlement) => {
      operationIds.push(settlement.operationId);
      assert.equal(readWorkflowJournal(f.projectRoot, "session-1").at(-1)?.type, "run.terminal.prepared", "intent must be durable before external settlement");
      if (++attempts === 1) throw new Error("lease release interrupted");
    },
  });
  startAndDeliver(f.lifecycle);
  const blocked = { ...request, status: "blocked" as const, evidenceRefs: [{ kind: "tool-result", claim: "durable blocker" }] };
  const first = await f.lifecycle.finish(blocked, rootBatch);
  assert.equal(first.ok, false);
  assert.match(issuesOf(first), /lease release interrupted|settlement/i);
  assert.equal(f.lifecycle.restore().latestRun?.status, "running");
  assert.equal(f.lifecycle.restore().latestRun?.pendingTerminal?.closedQuestionIds[0], "q-1");

  const replayed = await new WorkflowRunLifecycle(f.lifecycle.options).finish(blocked, rootBatch);
  assert.equal(replayed.ok, true, issuesOf(replayed));
  assert.equal(operationIds.length, 2);
  assert.equal(operationIds[0], operationIds[1], "retries must reuse the durable idempotency key");
  assert.deepEqual(readWorkflowJournal(f.projectRoot, "session-1").slice(-2).map((event) => event.type), ["run.terminal.prepared", "terminal.recorded"]);
});

test("fault after question closure but before terminal publication retries one closure and one terminal", async () => {
  let closureEffects = 0;
  let failCommit = true;
  const operationIds: string[] = [];
  const f = fixture({
    questions: async () => ({ state: "unsatisfied", issues: ["question pending"], pendingQuestionIds: ["q-1"] }),
    evidence: async () => ({ state: "satisfied" }),
    settleTerminal: async (settlement) => {
      operationIds.push(settlement.operationId);
      if (closureEffects === 0) closureEffects++;
      else assert.equal(settlement.operationId, operationIds[0], "closure retry must reconcile the same durable operation");
    },
  }, (eventType, stage) => {
    if (failCommit && eventType === "terminal.recorded" && stage === "beforeRename") {
      failCommit = false;
      throw new Error("crash after closure before terminal publication");
    }
  });
  startAndDeliver(f.lifecycle);
  const failed = { ...request, status: "failed" as const, evidenceRefs: [{ kind: "test", claim: "failure evidence" }] };
  const first = await f.lifecycle.finish(failed, rootBatch);
  assert.equal(first.ok, false);
  assert.match(issuesOf(first), /crash after closure/i);
  const second = await new WorkflowRunLifecycle(f.lifecycle.options).finish(failed, rootBatch);
  assert.equal(second.ok, true, issuesOf(second));
  assert.equal(closureEffects, 1);
  assert.deepEqual(operationIds, [operationIds[0], operationIds[0]]);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").filter((event) => event.type === "terminal.recorded").length, 1);
});

test("automatic budget failure persists and settles exact pending question IDs", async () => {
  const settlements: any[] = [];
  const f = fixture({
    questions: async () => ({ state: "unsatisfied", issues: ["pending"], pendingQuestionIds: ["q-budget"] }),
    settleTerminal: async (settlement) => { settlements.push(settlement); },
  });
  f.lifecycle.recordUserInput({ inputId: "budget-input", text: "work", source: "interactive" });
  const result = await f.lifecycle.failBudgetExhaustion("tokens exhausted");
  assert.equal(result.ok, true, issuesOf(result));
  if (!result.ok) return;
  assert.deepEqual(result.envelope.closedQuestionIds, ["q-budget"]);
  assert.deepEqual(settlements[0].closedQuestionIds, ["q-budget"]);
  assert.deepEqual(f.lifecycle.restore().latestRun?.terminal?.closedQuestionIds, ["q-budget"]);
});

test("budget failure freezes the exact real question set in its preparation CAS for both answer race outcomes and restart", async () => {
  for (const answerWins of [true, false]) {
    const projectRoot = mkdtempSync(join(tmpdir(), "hive-budget-question-race-"));
    const question = new QuestionService({
      projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: questionSnapshot(), createQuestionId: () => "question-1",
      authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
    });
    let raced = false;
    let losingAnswerRejected = false;
    const hooks: CompletionValidationHooks = {
      questions: () => {
        const gate = question.completionGate();
        if (answerWins && !raced) {
          raced = true;
          question.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "question-1", expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "answer-before-budget" });
        }
        return gate;
      },
      validateQuestionSet: (events, expected) => question.assertPendingSet(events, expected),
      settleTerminal: (settlement) => {
        if (!answerWins) {
          try { question.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "question-1", expectedState: "pending", value: true, channel: "command", claimedIdentity: "human", credential: "secret", operationId: "answer-after-budget" }); }
          catch { losingAnswerRejected = true; }
        }
        question.closePending({ reason: "run failed", operationId: settlement.operationId, expectedQuestionIds: settlement.closedQuestionIds });
      },
    } as CompletionValidationHooks;
    const options = { projectRoot, projectId: "project-1", sessionId: "session-1", snapshotId: "snapshot-1", rootNodeId: "root", createRunId: () => "run-1", completion: hooks };
    const lifecycle = new WorkflowRunLifecycle(options);
    lifecycle.recordUserInput({ inputId: "initial", text: "work", source: "interactive" });
    question.create({ nodeId: "root", definition: { prompt: "Proceed?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "budget-race" } });
    const result = await lifecycle.failBudgetExhaustion("tokens exhausted");
    assert.equal(result.ok, true, issuesOf(result));
    if (!result.ok) continue;
    assert.deepEqual(result.envelope.closedQuestionIds, answerWins ? [] : ["question-1"]);
    assert.equal(question.restore().questions["question-1"].state, answerWins ? "answered" : "closed");
    assert.equal(losingAnswerRejected, !answerWins);
    const restarted = await new WorkflowRunLifecycle(options).failBudgetExhaustion("retry");
    assert.equal(restarted.ok, true, issuesOf(restarted));
    if (restarted.ok) assert.deepEqual(restarted.envelope, result.envelope);
  }
});

test("strict terminal validation runs before append so malformed subsystem records cannot corrupt replay", async () => {
  const f = fixture({
    projectState: async () => ({
      state: "satisfied",
      fileChanges: [{ path: "src/file.ts", operation: "overwrite" as any, attribution: "recorded" }],
      changeCoverage: "recorded",
    }),
  });
  startAndDeliver(f.lifecycle);
  const before = readWorkflowJournal(f.projectRoot, "session-1").length;
  const result = await f.lifecycle.finish(request, rootBatch);
  assert.equal(result.ok, false);
  assert.match(issuesOf(result), /fileChanges|operation|terminal/i);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").length, before, "invalid terminal data must be rejected before append");
  assert.equal(f.lifecycle.restore().latestRun?.status, "running");
});

test("project-state envelopes require normalized relative paths, operation hashes, digest grammar, and coverage vocabulary", async () => {
  const hashA = `sha256:${"a".repeat(64)}`;
  const hashB = `sha256:${"b".repeat(64)}`;
  const valid = fixture({
    projectState: async () => ({
      state: "satisfied",
      changeCoverage: "git-reconciled",
      fileChanges: [
        { path: "src/new.ts", operation: "create", afterHash: hashA, attribution: "recorded" },
        { path: "src/changed.ts", operation: "update", beforeHash: hashA, afterHash: hashB, attribution: "reconciled" },
        { path: "src/deleted.ts", operation: "delete", beforeHash: hashB, attribution: "unknown" },
      ],
    }),
  });
  startAndDeliver(valid.lifecycle);
  const accepted = await valid.lifecycle.finish(request, rootBatch);
  assert.equal(accepted.ok, true, issuesOf(accepted));
  if (accepted.ok) {
    assert.equal(accepted.envelope.changeCoverage, "git-reconciled");
    assert.deepEqual(accepted.envelope.fileChanges.map(({ path, operation }) => ({ path, operation })), [
      { path: "src/new.ts", operation: "create" },
      { path: "src/changed.ts", operation: "update" },
      { path: "src/deleted.ts", operation: "delete" },
    ]);
  }

  for (const projectState of [
    { state: "satisfied" as const, changeCoverage: "recorded", fileChanges: [{ path: "../escape.ts", operation: "create" as const, afterHash: hashA, attribution: "recorded" as const }] },
    { state: "satisfied" as const, changeCoverage: "recorded", fileChanges: [{ path: "src/new.ts", operation: "create" as const, attribution: "recorded" as const }] },
    { state: "satisfied" as const, changeCoverage: "complete", fileChanges: [] },
  ]) {
    const invalid = fixture({ projectState: async () => projectState });
    startAndDeliver(invalid.lifecycle);
    const before = readWorkflowJournal(invalid.projectRoot, "session-1").length;
    const denied = await invalid.lifecycle.finish(request, rootBatch);
    assert.equal(denied.ok, false);
    assert.match(issuesOf(denied), /path|hash|coverage|terminal|require/i);
    assert.equal(readWorkflowJournal(invalid.projectRoot, "session-1").length, before);
  }

  const badDigest = fixture();
  startAndDeliver(badDigest.lifecycle);
  assert.match(issuesOf(await badDigest.lifecycle.finish({ ...request, artifactRefs: [{ workspaceId: "w", checkpoint: "tasks", digest: "sha256:short" }] }, rootBatch)), /digest/i);
});

test("all statuses reject unsettled descendants, unsafe project state, and unverifiable claimed references", async () => {
  for (const status of ["completed", "blocked", "failed"] as const) {
    const f = fixture({
      descendants: async () => ({ state: "unsatisfied", issues: ["worker still running"] }),
      projectState: async () => ({ state: "unsatisfied", issues: ["protected path conflict"] }),
      evidence: async () => ({ state: "unsatisfied", issues: ["unknown tool result"] }),
      artifacts: async () => ({ state: "unsatisfied", issues: ["artifact digest mismatch"] }),
    });
    startAndDeliver(f.lifecycle);
    const denied = await f.lifecycle.finish({
      ...request,
      status,
      evidenceRefs: [{ kind: "tool-result", claim: "claim" }],
      artifactRefs: [{ workspaceId: "w", checkpoint: "tasks", digest: `sha256:${"a".repeat(64)}` }],
    }, rootBatch);
    assert.equal(denied.ok, false);
    assert.match(denied.issues.join("\n"), /worker still running|protected path conflict|unknown tool result|artifact digest mismatch/);
  }
});
