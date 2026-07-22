import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { killProcessTree, spawnManaged } from "../../src/core/process.ts";
import { readWorkflowJournal } from "../../src/workflows/journal.ts";
import { acquireRuntimeOwnership } from "../../src/workflows/ownership.ts";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { QuestionService } from "../../src/workflows/questions.ts";
import {
  CANCELLATION_TIMING,
  WorkflowRunLifecycle,
  type CancellationCoordinator,
  type CompletionValidationHooks,
} from "../../src/workflows/runs.ts";

function questionSnapshot(): ActivationSnapshotFileV1 {
  return { snapshotHash: "q".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", payload: {
    project: { projectId: "project-1", rootRef: "." }, workflow: { id: "w", team: { rootId: "root", nodes: [{ id: "root", agentId: "lead", memberIds: [], depth: 1 }] } },
    authority: { capabilityContractVersion: 1, nodes: [{ nodeId: "root", capabilities: { effective: { "human-input": true } }, tools: ["human_question"] }] },
    agents: [{ id: "lead", name: "Lead", prompt: "lead" }], skills: [], knowledge: [], models: [], sources: [], versions: {} as never,
  } } as unknown as ActivationSnapshotFileV1;
}

function fixture(completion?: CompletionValidationHooks, journalFault?: (eventType: string, stage: string) => void) {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-run-cancel-"));
  let tick = 0;
  const options = {
    projectRoot,
    projectId: "project-1",
    sessionId: "session-1",
    snapshotId: "snapshot-1",
    rootNodeId: "root",
    runtimeOwnerNonce: "owner-1",
    createRunId: () => "run-1",
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    ...(completion ? { completion } : {}),
    ...(journalFault ? { journalFault: journalFault as any } : {}),
  };
  const lifecycle = new WorkflowRunLifecycle(options);
  lifecycle.recordUserInput({ inputId: "initial", text: "mutate files", source: "interactive" });
  assert.equal(acquireRuntimeOwnership(projectRoot, options.sessionId, { nonce: options.runtimeOwnerNonce }).ok, true);
  return { projectRoot, options, lifecycle };
}

test("two-phase idle cancellation settles before final capture without rollback claims", async () => {
  const f = fixture();
  const calls: string[] = [];
  const coordinator: CancellationCoordinator = {
    rejectNewWork: async () => { calls.push("reject"); },
    cancelQueuedWork: async () => { calls.push("queue"); },
    abortOwnedWork: async () => { calls.push("abort"); },
    waitForSettlement: async (timeoutMs) => { calls.push(`wait:${timeoutMs}`); return true; },
    capturePartialState: async () => { calls.push("capture"); return {}; },
    releaseLeases: async () => { calls.push("release"); },
  };

  const result = await f.lifecycle.cancel("user stopped idle run", coordinator);
  assert.equal(result.envelope.status, "cancelled");
  assert.equal(result.envelope.changeCoverage, "partial");
  assert.doesNotMatch(result.envelope.summary, /rollback|reverted/i);
  assert.deepEqual(calls.slice(0, 3), ["reject", "queue", "abort"]);
  assert.ok(calls.indexOf("capture") < calls.indexOf("release"), "final partial hashes and evidence must be captured while leases are still held");
  assert.equal(calls.at(-1), "release", "lease release must be the final coordinator step before terminal persistence");
  assert.deepEqual(JSON.parse(result.rendered), result.envelope);
  assert.deepEqual(readWorkflowJournal(f.projectRoot, "session-1").slice(-2).map((event) => event.type), ["run.cancel.requested", "terminal.recorded"]);
  assert.deepEqual(CANCELLATION_TIMING, { settleGraceMs: 2_000, killSettleMs: 1_000, coordinatorStepMs: 2_000 });
});

test("cancellation persists the exact pending question closure IDs", async () => {
  const f = fixture({ questions: async () => ({ state: "unsatisfied", issues: ["pending"], pendingQuestionIds: ["q-cancel"] }) });
  const result = await f.lifecycle.cancel("cancel with question", { waitForSettlement: async () => true });
  assert.deepEqual(result.envelope.closedQuestionIds, ["q-cancel"]);
  assert.deepEqual((readWorkflowJournal(f.projectRoot, "session-1").find((event) => event.type === "terminal.recorded")!.payload as any).closedQuestionIds, ["q-cancel"]);
});

test("cancellation retry after closure preserves its originally prepared question IDs", async () => {
  let gateCalls = 0;
  let fault = true;
  const f = fixture({ questions: async () => gateCalls++ === 0
    ? ({ state: "unsatisfied", issues: ["pending"], pendingQuestionIds: ["q-retry"] })
    : ({ state: "satisfied" }) }, (eventType, stage) => {
    if (fault && eventType === "terminal.recorded" && stage === "beforeRename") { fault = false; throw new Error("cancel terminal fault"); }
  });
  await assert.rejects(() => f.lifecycle.cancel("retry cancellation", { waitForSettlement: async () => true }), /cancel terminal fault/i);
  const retried = await new WorkflowRunLifecycle(f.lifecycle.options).cancel("retry cancellation", { waitForSettlement: async () => true });
  assert.deepEqual(retried.envelope.closedQuestionIds, ["q-retry"]);
});

test("cancellation freezes the exact real question set in its journal CAS for both answer race outcomes and restart", async () => {
  for (const answerWins of [true, false]) {
    const projectRoot = mkdtempSync(join(tmpdir(), "hive-cancel-question-race-"));
    const question = new QuestionService({
      projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: questionSnapshot(), createQuestionId: () => "question-1",
      authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
    });
    let raced = false;
    const completion: CompletionValidationHooks = {
      questions: () => {
        const gate = question.completionGate();
        if (answerWins && !raced) {
          raced = true;
          question.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "question-1", expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "answer-before-cancel" });
        }
        return gate;
      },
      validateQuestionSet: (events, expected) => question.assertPendingSet(events, expected),
    } as CompletionValidationHooks;
    const options = {
      projectRoot, projectId: "project-1", sessionId: "session-1", snapshotId: "snapshot-1", rootNodeId: "root",
      runtimeOwnerNonce: "owner-1", createRunId: () => "run-1", completion,
    };
    const lifecycle = new WorkflowRunLifecycle(options);
    lifecycle.recordUserInput({ inputId: "initial", text: "work", source: "interactive" });
    assert.equal(acquireRuntimeOwnership(projectRoot, "session-1", { nonce: "owner-1" }).ok, true);
    question.create({ nodeId: "root", definition: { prompt: "Proceed?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "cancel-race" } });
    let losingAnswerRejected = false;
    const result = await lifecycle.cancel("stop", {
      rejectNewWork: () => {
        if (!answerWins) {
          try { question.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "question-1", expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "answer-after-cancel" }); }
          catch { losingAnswerRejected = true; }
        }
      },
      waitForSettlement: async () => true,
      releaseLeases: () => { question.closePending({ reason: "stop", operationId: "cancel-run-1", expectedQuestionIds: lifecycle.restore().latestRun?.cancellationQuestionIds ?? [] }); },
    });
    assert.deepEqual(result.envelope.closedQuestionIds, answerWins ? [] : ["question-1"]);
    assert.equal(question.restore().questions["question-1"].state, answerWins ? "answered" : "closed");
    assert.equal(losingAnswerRejected, !answerWins);
    const restarted = await new WorkflowRunLifecycle(options).cancel("retry", { waitForSettlement: async () => true });
    assert.deepEqual(restarted.envelope, result.envelope);
  }
});

test("concurrent cancellation callers share one settlement without releasing leases during capture", async () => {
  const f = fixture();
  const concurrent = new WorkflowRunLifecycle(f.options);
  let resolveCapture!: () => void;
  let markCaptureStarted!: () => void;
  const captureGate = new Promise<void>((resolve) => { resolveCapture = resolve; });
  const captureStarted = new Promise<void>((resolve) => { markCaptureStarted = resolve; });
  let firstCaptureInProgress = false;
  let releasedDuringFirstCapture = false;
  const secondCalls: string[] = [];

  const first = f.lifecycle.cancel("stop concurrently", {
    waitForSettlement: async () => true,
    capturePartialState: async () => {
      firstCaptureInProgress = true;
      markCaptureStarted();
      await captureGate;
      firstCaptureInProgress = false;
      return { settledBy: "first caller" };
    },
    releaseLeases: async () => {
      assert.equal(firstCaptureInProgress, false, "leases must remain held until the shared capture finishes");
    },
  });
  await captureStarted;

  const second = concurrent.cancel("duplicate cancellation", {
    waitForSettlement: async () => { secondCalls.push("wait"); return true; },
    capturePartialState: async () => { secondCalls.push("capture"); return { settledBy: "second caller" }; },
    releaseLeases: async () => {
      secondCalls.push("release");
      releasedDuringFirstCapture = firstCaptureInProgress;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  resolveCapture();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(releasedDuringFirstCapture, false, "a concurrent caller must not release leases while capture is in progress");
  assert.deepEqual(secondCalls, [], "only the coordinator that owns the single-flight settlement may run");
  assert.strictEqual(secondResult, firstResult, "concurrent callers must receive the shared idempotent result");
  assert.equal(firstResult.envelope.partialState.settledBy, "first caller");
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").filter((event) => event.type === "terminal.recorded").length, 1);
});

test("alias project roots share the canonical journal cancellation settlement", async () => {
  const f = fixture();
  const alias = new WorkflowRunLifecycle({ ...f.options, projectRoot: `${f.projectRoot}/.` });
  let resolveCapture!: () => void;
  let markCaptureStarted!: () => void;
  const captureGate = new Promise<void>((resolve) => { resolveCapture = resolve; });
  const captureStarted = new Promise<void>((resolve) => { markCaptureStarted = resolve; });
  const aliasCalls: string[] = [];

  const first = f.lifecycle.cancel("stop through canonical root", {
    waitForSettlement: async () => true,
    capturePartialState: async () => {
      markCaptureStarted();
      await captureGate;
      return { settledBy: "canonical root" };
    },
  });
  await captureStarted;
  const second = alias.cancel("stop through alias root", {
    waitForSettlement: async () => { aliasCalls.push("wait"); return true; },
    capturePartialState: async () => { aliasCalls.push("capture"); return { settledBy: "alias root" }; },
    releaseLeases: async () => { aliasCalls.push("release"); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  resolveCapture();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(aliasCalls, [], "root aliases must not start independent settlement coordinators");
  assert.strictEqual(secondResult, firstResult);
  assert.equal(firstResult.envelope.partialState.settledBy, "canonical root");
});

test("cancellation settlement rejects a lifecycle running outside the recorded owner process", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-run-cancel-owner-"));
  const options = {
    projectRoot,
    projectId: "project-1",
    sessionId: "session-1",
    snapshotId: "snapshot-1",
    rootNodeId: "root",
    runtimeOwnerNonce: "foreign-process-owner",
    createRunId: () => "run-1",
  };
  const lifecycle = new WorkflowRunLifecycle(options);
  lifecycle.recordUserInput({ inputId: "initial", text: "mutate files", source: "interactive" });
  assert.equal(acquireRuntimeOwnership(projectRoot, options.sessionId, {
    nonce: options.runtimeOwnerNonce,
    pid: process.pid + 100_000,
    processMarker: "foreign-process",
  }).ok, true);
  let coordinatorCalled = false;

  await assert.rejects(() => lifecycle.cancel("foreign process attempted settlement", {
    rejectNewWork: async () => { coordinatorCalled = true; },
    waitForSettlement: async () => true,
  }), /current runtime owner/i);
  assert.equal(coordinatorCalled, false);
  assert.equal(lifecycle.restore().latestRun?.cancellationRequested, false);
});

test("active abortable model and queued mutation boundaries settle through distinct controls", async () => {
  const active = fixture();
  const modelAbort = new AbortController();
  const activeResult = await active.lifecycle.cancel("abort provider", {
    abortOwnedWork: async () => { modelAbort.abort("cancelled"); },
    waitForSettlement: async () => modelAbort.signal.aborted,
    capturePartialState: async () => ({ modelAborted: modelAbort.signal.aborted }),
  });
  assert.equal(activeResult.envelope.partialState.modelAborted, true, "the model request must be observably abortable before terminal state");

  const queued = fixture();
  let queuedMutationRan = false;
  const queuedTools = [() => { queuedMutationRan = true; }];
  const queuedResult = await queued.lifecycle.cancel("cancel queued write", {
    cancelQueuedWork: async () => { queuedTools.splice(0); },
    waitForSettlement: async () => queuedTools.length === 0,
    capturePartialState: async () => ({ queuedTools: queuedTools.length }),
  });
  for (const tool of queuedTools) tool();
  assert.equal(queuedMutationRan, false, "a queued mutating tool must never start after cancellation admission closes");
  assert.equal(queuedResult.envelope.partialState.queuedTools, 0);
});

test("partial filesystem mutation is preserved and hash-captured rather than rolled back", async () => {
  const f = fixture();
  const changedPath = join(f.projectRoot, "partial.txt");
  writeFileSync(changedPath, "partially written output\n");
  const expectedHash = `sha256:${createHash("sha256").update(readFileSync(changedPath)).digest("hex")}`;

  const result = await f.lifecycle.cancel("stop after partial write", {
    waitForSettlement: async () => true,
    capturePartialState: async () => ({ path: "partial.txt", afterHash: `sha256:${createHash("sha256").update(readFileSync(changedPath)).digest("hex")}` }),
  });
  assert.equal(readFileSync(changedPath, "utf8"), "partially written output\n");
  assert.equal(result.envelope.partialState.afterHash, expectedHash);
  assert.doesNotMatch(result.envelope.summary, /rollback|reverted/i);
});

test("cancellation terminates a real owned process group before final partial-state capture", async () => {
  const f = fixture();
  const managed = spawnManaged(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  let settlementChecks = 0;
  const settled = async (timeoutMs: number): Promise<boolean> => {
    if (++settlementChecks === 1) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (managed.proc.exitCode !== null || managed.proc.signalCode !== null) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return managed.proc.exitCode !== null || managed.proc.signalCode !== null;
  };
  try {
    const result = await f.lifecycle.cancel("terminate real child", {
      abortOwnedWork: async () => {},
      waitForSettlement: settled,
      terminateProcessTrees: async () => { killProcessTree(managed, "SIGKILL"); },
      releaseLeases: async () => {},
      capturePartialState: async () => ({ observedExit: managed.proc.exitCode !== null || managed.proc.signalCode !== null }),
    });
    assert.equal(result.envelope.partialState.observedExit, true);
    assert.equal(result.envelope.status, "cancelled");
  } finally {
    killProcessTree(managed, "SIGKILL");
  }
});

test("cancellation summaries truncate ASCII and multibyte reasons at exact UTF-8 byte boundaries", async () => {
  const limit = 8_192;
  const prefix = "Cancelled: ";
  const asciiAtLimit = "a".repeat(limit - Buffer.byteLength(prefix));
  const asciiOverLimit = `${asciiAtLimit}b`;
  const emojiCount = Math.floor((limit - Buffer.byteLength(prefix)) / Buffer.byteLength("😀"));
  const multibyteAtLimit = `${"😀".repeat(emojiCount - 1)}${"x".repeat(limit - Buffer.byteLength(prefix) - (emojiCount - 1) * 4)}`;
  const multibyteOverLimit = `${"😀".repeat(emojiCount - 1)}xx😀`;

  for (const [label, reason, expectedBytes] of [
    ["ascii N", asciiAtLimit, limit],
    ["ascii N+1", asciiOverLimit, limit],
    ["multibyte N", multibyteAtLimit, limit],
    ["multibyte N+1", multibyteOverLimit, limit - 3],
  ] as const) {
    const f = fixture();
    let cleanupStarted = false;
    const result = await f.lifecycle.cancel(reason, {
      rejectNewWork: async () => { cleanupStarted = true; },
      waitForSettlement: async () => true,
    });
    assert.equal(cleanupStarted, true, label);
    assert.equal(Buffer.byteLength(result.envelope.summary, "utf8"), expectedBytes, label);
    assert.equal(result.envelope.summary.includes("�"), false, `${label} must not split a code point`);
    assert.ok(Buffer.byteLength(f.lifecycle.restore().latestRun?.cancellationReason ?? "", "utf8") <= limit, `${label} persisted reason`);
  }
});

test("terminal cancellation reconciles an after-rename publication fault without repeating cleanup", async () => {
  let injected = false;
  let cleanup = 0;
  const f = fixture();
  const lifecycle = new WorkflowRunLifecycle({
    ...f.options,
    journalFault(eventType, stage) {
      if (!injected && eventType === "terminal.recorded" && stage === "afterRename") {
        injected = true;
        throw new Error("simulated terminal publication fault");
      }
    },
  });
  const result = await lifecycle.cancel("publish terminal", {
    rejectNewWork: async () => { cleanup += 1; },
    waitForSettlement: async () => true,
  });
  assert.equal(injected, true);
  assert.equal(cleanup, 1);
  assert.equal(result.envelope.status, "cancelled");
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").filter((event) => event.type === "terminal.recorded").length, 1);
});

test("cancel request rejects new work and replay resumes settlement idempotently after crashes", async () => {
  const f = fixture();
  f.lifecycle.requestCancellation("stop now");
  assert.equal(f.lifecycle.restore().latestRun?.cancellationRequested, true);
  assert.throws(() => f.lifecycle.recordUserInput({ inputId: "late", text: "new work", source: "interactive" }), /cancel|reject/i);

  const replayed = new WorkflowRunLifecycle(f.options);
  const settled = await replayed.cancel("stop now", {
    waitForSettlement: async () => true,
    capturePartialState: async () => ({ checkpointHash: "sha256:partial" }),
  });
  assert.equal(settled.envelope.status, "cancelled");
  assert.equal(settled.envelope.partialState.checkpointHash, "sha256:partial");
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").filter((event) => event.type === "run.cancel.requested").length, 1);

  const eventCount = readWorkflowJournal(f.projectRoot, "session-1").length;
  const afterTerminalReplay = await new WorkflowRunLifecycle(f.options).cancel("duplicate callback", {});
  assert.deepEqual(afterTerminalReplay.envelope, settled.envelope);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").length, eventCount, "terminal cancellation replay must not append");
});

test("unsettled owned work persists a retryable settlement failure and never becomes terminal", async () => {
  const f = fixture();
  await assert.rejects(() => f.lifecycle.cancel("stop despite cleanup errors", {
    abortOwnedWork: async () => { throw new Error("provider abort failed"); },
    waitForSettlement: async () => false,
    terminateProcessTrees: async () => { throw new Error("kill failed"); },
    capturePartialState: async () => { throw new Error("must not capture while work can still mutate"); },
    releaseLeases: async () => { throw new Error("must not release before conclusive settlement"); },
  }), /retry|settle|cancel/i);
  const run = f.lifecycle.restore().latestRun;
  assert.equal(run?.status, "running");
  assert.equal(run?.cancellationRequested, true);
  assert.match(run?.cancellationSettlementFailure ?? "", /provider abort failed|kill failed|settled/i);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").at(-1)?.type, "run.cancel.settlement.failed");
});

test("lease release failure remains retryable and a later settlement attempt can finish cancellation", async () => {
  const f = fixture();
  let firstCapture = false;
  await assert.rejects(() => f.lifecycle.cancel("stop", {
    waitForSettlement: async () => true,
    releaseLeases: async () => {
      assert.equal(firstCapture, true, "lease release cannot precede final partial-state capture");
      throw new Error("lease backend unavailable");
    },
    capturePartialState: async () => { firstCapture = true; return { capturedBeforeFailedRelease: true }; },
  }), /lease|retry|settle/i);
  assert.equal(firstCapture, true);
  assert.equal(f.lifecycle.restore().latestRun?.status, "running");

  const result = await new WorkflowRunLifecycle(f.options).cancel("stop", {
    waitForSettlement: async () => true,
    releaseLeases: async () => {},
    capturePartialState: async () => ({ finalHash: "sha256:settled" }),
  });
  assert.equal(result.envelope.status, "cancelled");
  assert.equal(result.envelope.partialState.finalHash, "sha256:settled");
});

test("timed-out coordinator promises cannot be followed by final capture or terminal persistence", async () => {
  const f = fixture();
  let resolveAbort!: () => void;
  let captured = false;
  const abort = new Promise<void>((resolve) => { resolveAbort = resolve; });
  await assert.rejects(() => f.lifecycle.cancel("stop", {
    abortOwnedWork: async () => abort,
    waitForSettlement: async () => true,
    capturePartialState: async () => { captured = true; return {}; },
  }), /timed out|retry|settle/i);
  assert.equal(captured, false);
  assert.equal(f.lifecycle.restore().latestRun?.status, "running");
  await assert.rejects(() => new WorkflowRunLifecycle(f.options).cancel("retry too soon", {
    waitForSettlement: async () => true,
    capturePartialState: async () => { captured = true; return {}; },
  }), /still running|timed-out|retry/i);
  assert.equal(captured, false);
  resolveAbort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.lifecycle.restore().latestRun?.status, "running", "late completion must not race a final capture");
});
