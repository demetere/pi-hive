import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { DelegationRuntime, type PersistedDelegationTask } from "../../src/workflows/delegation.ts";
import { QuestionService } from "../../src/workflows/questions.ts";
import { QUESTION_LIMITS } from "../../src/workflows/question-validation.ts";
import { AttemptRuntime, attemptDescriptorForModel, executeWithConservativeRetry } from "../../src/workflows/attempts.ts";
import { readWorkflowJournal } from "../../src/workflows/journal.ts";
import {
  WorkerSessionPool,
  workerTranscriptPath,
  type WorkerSessionFactory,
  type WorkerModelDispatcher,
} from "../../src/workflows/workers.ts";

function snapshot(): ActivationSnapshotFileV1 {
  return { snapshotHash: "d".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", payload: {
    project: { projectId: "project-1", rootRef: "." },
    workflow: { id: "delivery", instructions: { shared: "shared workflow rules", root: "root-only transcript policy" }, artifact: { adapter: "openspec", profile: "delivery", contractVersion: "v1", checkpoints: ["verified"] }, team: { rootId: "root", nodes: [
      { id: "root", agentId: "lead", memberIds: ["alpha", "beta"], depth: 1 },
      { id: "alpha", agentId: "shared-agent", parentId: "root", memberIds: [], depth: 2, role: "Implementer", responsibilities: ["ship patches"], skills: { resolved: ["coding"] }, knowledge: { resolved: ["architecture"] } },
      { id: "beta", agentId: "shared-agent", parentId: "root", memberIds: [], depth: 2, skills: { resolved: [] }, knowledge: { resolved: [] } },
    ] } },
    authority: { capabilityContractVersion: 1, nodes: [
      { nodeId: "root", capabilities: {}, tools: ["workflow_finish"] },
      { nodeId: "alpha", capabilities: { effective: { shell: ["inspect"] }, provenance: { shell: ["agent-ceiling", "workflow-node"] } }, tools: ["delegate_agent", "read"], model: "model-alpha", thinking: "medium" },
      { nodeId: "beta", capabilities: {}, tools: ["read"], model: "model-beta", thinking: "low" },
    ] },
    agents: [
      { id: "lead", name: "Lead", prompt: "root" },
      { id: "shared-agent", name: "Shared", prompt: "worker" },
    ],
    skills: [{ id: "coding", treeHash: "skill-hash", files: [{ relativePath: "SKILL.md", content: "coding skill content", hash: "file-hash" }] }],
    knowledge: [{ id: "architecture", provider: "okf", path: ".pi/hive/knowledge/architecture", attachedNodeIds: ["alpha"] }],
    models: [
      { nodeId: "root", modelId: "root-model", thinking: "medium", staticTokens: 1, dynamicReserve: 1, contextWindow: 10 },
      { nodeId: "alpha", modelId: "model-alpha", thinking: "medium", staticTokens: 1, dynamicReserve: 1, contextWindow: 10 },
      { nodeId: "beta", modelId: "model-beta", thinking: "low", staticTokens: 1, dynamicReserve: 1, contextWindow: 10 },
    ],
    sources: [], versions: {} as never,
  } } as unknown as ActivationSnapshotFileV1;
}

function task(taskId: string, targetNodeId: string, objective: string): PersistedDelegationTask {
  return {
    taskId, runId: "run-1", parentNodeId: "root", targetNodeId, objective,
    contextRefs: [], deliverables: ["bounded result"], provenance: { source: "delegate_agent" },
    creationSequence: Number(taskId.split("-")[1]), createdAt: "2026-01-01T00:00:00.000Z",
    queueState: "active", attempts: [{ attemptId: `attempt-${taskId}`, startedSequence: 2 }],
    lastStartedSequence: 2,
  };
}

function completedTask(input: PersistedDelegationTask, summary: string): PersistedDelegationTask {
  return {
    ...input,
    queueState: "terminal",
    result: {
      status: "completed", summary, outputRefs: [], evidenceRefs: [], data: {},
      attemptId: input.attempts.at(-1)?.attemptId,
      recordedAt: "2026-01-01T00:00:01.000Z", recordedSequence: input.creationSequence + 10,
    },
  };
}

test("worker transcripts and immutable snapshot execution config are scoped by run and node", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-"));
  const created: Array<{ nodeId: string; agentId: string; modelId: string; thinking: string; transcriptPath: string; tools: readonly string[] }> = [];
  const prompts = new Map<string, string[]>();
  const factory: WorkerSessionFactory = async (input) => {
    created.push({ nodeId: input.nodeId, agentId: input.agentId, modelId: input.modelId, thinking: input.thinking, transcriptPath: input.transcriptPath, tools: input.tools });
    const nodePrompts = prompts.get(input.nodeId) ?? [];
    prompts.set(input.nodeId, nodePrompts);
    return {
      linkedSessionId: `linked-${input.runId}-${input.nodeId}`,
      async prompt(text) { nodePrompts.push(text); return `result from ${input.nodeId}`; },
      async abort() {},
      dispose() {},
    };
  };
  const pool = new WorkerSessionPool({ projectRoot, sessionId: "session-1", runId: "run-1", snapshot: snapshot(), factory });
  await pool.execute(task("task-1", "alpha", "alpha objective"));
  await pool.execute(task("task-2", "beta", "beta objective"));

  assert.deepEqual(created.map(({ nodeId, agentId, modelId, thinking, tools }) => ({ nodeId, agentId, modelId, thinking, tools })), [
    { nodeId: "alpha", agentId: "shared-agent", modelId: "model-alpha", thinking: "medium", tools: ["delegate_agent", "read"] },
    { nodeId: "beta", agentId: "shared-agent", modelId: "model-beta", thinking: "low", tools: ["read"] },
  ]);
  assert.notEqual(created[0].transcriptPath, created[1].transcriptPath);
  assert.equal(created.every((entry) => entry.tools.includes("workflow_finish") === false), true);
  assert.equal(prompts.get("alpha")?.[0].includes("beta objective"), false);
  assert.equal(prompts.get("alpha")?.[0].includes("alpha objective"), true);
  assert.match(workerTranscriptPath(projectRoot, "session-1", "run-1", "alpha"), /runs[/\\]run-1[/\\]workers[/\\]alpha\.jsonl$/);
});

test("worker prompt invocation exposes full immutable snapshot and task context without root transcript", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-prompt-context-"));
  let invocation: unknown;
  const pool = new WorkerSessionPool({ projectRoot, sessionId: "session-1", runId: "run-1", snapshot: snapshot(), factory: async () => ({
    linkedSessionId: "linked-alpha",
    async prompt(_text, _signal, value) { invocation = value; return "ok"; },
    dispose() {},
  }) });
  await pool.execute(task("task-1", "alpha", "immutable objective"));
  const context = invocation as { promptContext: Record<string, unknown> };
  const promptContext = context.promptContext as Record<string, unknown>;
  assert.equal(promptContext.agentPrompt, "worker");
  assert.equal(promptContext.sharedInstructions, "shared workflow rules");
  assert.equal("rootInstructions" in promptContext, false);
  assert.equal(promptContext.role, "Implementer");
  assert.deepEqual(promptContext.responsibilities, ["ship patches"]);
  assert.deepEqual((promptContext.skills as Array<{ id: string }>).map((entry) => entry.id), ["coding"]);
  assert.deepEqual((promptContext.knowledge as Array<{ id: string }>).map((entry) => entry.id), ["architecture"]);
  assert.deepEqual(promptContext.adapterContract, { adapter: "openspec", profile: "delivery", contractVersion: "v1", checkpoints: ["verified"] });
  assert.deepEqual(promptContext.effectivePolicy, { effective: { shell: ["inspect"] }, provenance: { shell: ["agent-ceiling", "workflow-node"] } });
  assert.equal((promptContext.taskContract as { objective: string }).objective, "immutable objective");
  assert.equal(Object.isFrozen(promptContext), true);
  assert.equal(JSON.stringify(promptContext).includes("root-only transcript policy"), false);
});

test("worker compaction boundary is installed for each prompt and rejects rewritten immutable markers", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-compaction-"));
  let preservation = "";
  let validate!: (value: string) => void;
  const pool = new WorkerSessionPool({ projectRoot, sessionId: "session-1", runId: "run-1", snapshot: snapshot(), factory: async () => ({
    linkedSessionId: "linked-alpha",
    installCompactionBoundary(boundary) { preservation = boundary.preservation; validate = boundary.validate; },
    async prompt() { return { output: "ok", compactionSummary: preservation.replace(/"contractHash":"[0-9a-f]{64}"/, `"contractHash":"${"0".repeat(64)}"`) }; },
    dispose() {},
  }) });
  const result = await pool.execute(task("task-1", "alpha", "immutable objective"));
  assert.equal(result.status, "failed");
  assert.match(result.summary, /compaction\/resume rejected/i);
  assert.doesNotThrow(() => validate(preservation));
  assert.throws(() => validate(preservation.replace("run_id=run-1", "run_id=spoof")), /missing or rewritten/i);
});

test("sequential tasks reuse one node/run session and boundaries project only committed journal state", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-reuse-"));
  let creations = 0;
  const factory: WorkerSessionFactory = async (input) => {
    creations++;
    return { linkedSessionId: `linked-${input.nodeId}`, async prompt(text) { return text.includes("second") ? "second result" : "first result"; }, dispose() {} };
  };
  const pool = new WorkerSessionPool({ projectRoot, sessionId: "session-1", runId: "run-1", snapshot: snapshot(), factory });
  const firstTask = task("task-1", "alpha", "first");
  const secondTask = task("task-2", "alpha", "second");
  const first = await pool.execute(firstTask);
  const second = await pool.execute(secondTask);
  assert.equal(creations, 1);
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  const boundaryDir = join(projectRoot, ".pi", "hive", "sessions", "session-1", "runs", "run-1", "workers", "alpha.boundaries");
  assert.equal(existsSync(boundaryDir), false, "executor output must not outrun authoritative result publication");

  pool.rebuildBoundaries([completedTask(firstTask, first.summary), completedTask(secondTask, second.summary)]);
  const files = readdirSync(boundaryDir).sort();
  assert.equal(files.length, 4);
  const records = files.map((file) => JSON.parse(readFileSync(join(boundaryDir, file), "utf8")));
  assert.deepEqual(records.map((record) => `${record.taskId}:${record.kind}`), ["task-1:start", "task-1:result", "task-2:start", "task-2:result"]);
  pool.rebuildBoundaries([completedTask(firstTask, first.summary), completedTask(secondTask, second.summary)]);
  assert.equal(readdirSync(boundaryDir).length, 4, "journal projection rebuild is idempotent after a crash");
});

test("boundary rebuild remains stable when a takeover appends a retry attempt", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-retry-boundary-"));
  const pool = new WorkerSessionPool({ projectRoot, sessionId: "session-1", runId: "run-1", snapshot: snapshot(), factory: async () => ({
    linkedSessionId: "unused", prompt: async () => "unused", dispose() {},
  }) });
  const active = task("task-1", "alpha", "retry after crash");
  pool.rebuildBoundaries([active]);
  const retried = {
    ...active,
    attempts: [
      { ...active.attempts[0], interruptedSequence: 5 },
      { attemptId: "attempt-retry", startedSequence: 6, startedAt: "2026-01-01T00:00:01.000Z" },
    ],
    lastStartedSequence: 6,
  };
  assert.doesNotThrow(() => pool.rebuildBoundaries([retried]));
});

test("structured authorized refs are the only resolved context and prose carries an explicit no-DLP limitation", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-context-"));
  let prompt = "";
  const pool = new WorkerSessionPool({ projectRoot, sessionId: "session-1", runId: "run-1", snapshot: snapshot(), factory: async () => ({
    linkedSessionId: "linked", async prompt(text) { prompt = text; return "ok"; }, dispose() {},
  }) });
  const withRefs = { ...task("task-1", "alpha", "inspect"), contextRefs: [
    { ref: { kind: "artifact", id: "allowed" }, authorization: "authorized" as const, resolved: { excerpt: "visible" } },
    { ref: { kind: "knowledge", id: "secret" }, authorization: "denied" as const, diagnostic: "not attached" },
  ] };
  await pool.execute(withRefs);
  assert.match(prompt, /visible/);
  assert.match(prompt, /secret.*denied|denied.*secret/i);
  assert.match(prompt, /prose.*not.*DLP|not information-flow control/i);
});

test("question answers resume the same task and node transcript with durable provenance", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-question-resume-"));
  const activeSnapshot = snapshot() as any;
  const authority = activeSnapshot.payload.authority.nodes.find((entry: any) => entry.nodeId === "alpha");
  authority.capabilities.effective = { ...(authority.capabilities.effective ?? {}), "human-input": true };
  authority.tools = [...new Set([...authority.tools, "human_question"])].sort();
  const delegation = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, createTaskId: () => "task-1" });
  delegation.accept(delegation.rootExecutionContext(), { targetNodeId: "alpha", objective: "same objective", deliverables: [] });
  delegation.start("task-1", "attempt-task-1");
  const questions = new QuestionService({
    projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot,
    createQuestionId: () => "question-1", authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
  });
  let creations = 0;
  const invocations: any[] = [];
  const pool = new WorkerSessionPool({
    projectRoot, sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, questions,
    factory: async (input) => {
      creations++;
      return {
        linkedSessionId: "linked-alpha",
        async prompt(text, _signal, invocation) {
          invocations.push({ text, invocation, transcriptPath: input.transcriptPath });
          if (invocations.length === 1) questions.create({ nodeId: "alpha", taskId: "task-1", definition: { prompt: "Proceed?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "call-1" } });
          return invocations.length === 1 ? "waiting" : "resumed";
        },
        dispose() {},
      };
    },
  });
  const activeTask = task("task-1", "alpha", "same objective");
  const suspended = await pool.execute(activeTask);
  assert.equal(suspended.status, "suspended");
  if (suspended.status !== "suspended") return;
  assert.deepEqual((suspended as any).questionIds, ["question-1"]);
  questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "question-1", expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "answer-1" });
  const resumed = await pool.execute(activeTask);
  assert.equal(resumed.status, "completed");
  assert.equal(creations, 1, "node/run session and transcript must be reused");
  assert.equal(invocations[0].transcriptPath, invocations[1].transcriptPath);
  assert.equal(invocations[1].invocation.promptContext.taskContract.taskId, "task-1");
  assert.equal(invocations[1].invocation.promptContext.taskContract.acceptedAnswers[0].questionId, "question-1");
  assert.equal(invocations[1].invocation.promptContext.taskContract.acceptedAnswers[0].answer.channel, "dashboard");
  assert.match(invocations[1].text, /question-1|Proceed\?/);
});

test("worker answer delivery is accepted once across sequential question cycles and pool restart", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-question-cycles-"));
  const activeSnapshot = snapshot() as any;
  const authority = activeSnapshot.payload.authority.nodes.find((entry: any) => entry.nodeId === "alpha");
  authority.capabilities.effective = { ...(authority.capabilities.effective ?? {}), "human-input": true };
  authority.tools = [...new Set([...authority.tools, "human_question"])].sort();
  const delegation = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, createTaskId: () => "task-1" });
  delegation.accept(delegation.rootExecutionContext(), { targetNodeId: "alpha", objective: "two cycles", deliverables: [] });
  delegation.start("task-1", "attempt-task-1");
  let questionSequence = 0;
  const questions = new QuestionService({
    projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot,
    createQuestionId: () => `question-${++questionSequence}`, authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
  });
  const activeTask = task("task-1", "alpha", "two cycles");
  const seen: string[][] = [];
  const makePool = () => new WorkerSessionPool({
    projectRoot, sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, questions,
    factory: async () => ({
      linkedSessionId: "linked-alpha",
      async prompt(_text, _signal, invocation) {
        seen.push(invocation!.promptContext.taskContract.acceptedAnswers.map((entry) => entry.questionId));
        return "accepted containing turn";
      },
      dispose() {},
    }),
  });
  const q1 = questions.create({ nodeId: "alpha", taskId: "task-1", definition: { prompt: "First?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "cycle-q1" } });
  questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: q1.questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "cycle-a1" });
  await makePool().execute(activeTask);

  const q2 = questions.create({ nodeId: "alpha", taskId: "task-1", definition: { prompt: "Second?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "cycle-q2" } });
  questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: q2.questionId, expectedState: "pending", value: false, channel: "command", claimedIdentity: "human", credential: "secret", operationId: "cycle-a2" });
  await makePool().execute(activeTask);
  await makePool().execute(activeTask);
  assert.deepEqual(seen, [[q1.questionId], [q2.questionId], []]);
});

test("failed worker turns retain prepared answers while successful retry accepts each answer once", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-question-fault-"));
  const activeSnapshot = snapshot() as any;
  const authority = activeSnapshot.payload.authority.nodes.find((entry: any) => entry.nodeId === "alpha");
  authority.capabilities.effective = { ...(authority.capabilities.effective ?? {}), "human-input": true };
  authority.tools = [...new Set([...authority.tools, "human_question"])].sort();
  const delegation = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, createTaskId: () => "task-1" });
  delegation.accept(delegation.rootExecutionContext(), { targetNodeId: "alpha", objective: "fault", deliverables: [] });
  delegation.start("task-1", "attempt-task-1");
  const questions = new QuestionService({
    projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot,
    createQuestionId: () => "question-fault", authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
  });
  const question = questions.create({ nodeId: "alpha", taskId: "task-1", definition: { prompt: "Retry?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "fault-q" } });
  questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: question.questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "fault-a" });
  const seen: string[][] = [];
  let fail = true;
  const execute = () => new WorkerSessionPool({
    projectRoot, sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, questions: new QuestionService({ ...questions.options }),
    factory: async () => ({ linkedSessionId: "linked-alpha", async prompt(_text, _signal, invocation) {
      seen.push(invocation!.promptContext.taskContract.acceptedAnswers.map((entry) => entry.questionId));
      if (fail) { fail = false; throw new Error("fault before containing transcript acceptance"); }
      return "accepted";
    }, dispose() {} }),
  }).execute(task("task-1", "alpha", "fault"));
  assert.equal((await execute()).status, "failed");
  assert.equal((await execute()).status, "completed");
  assert.equal((await execute()).status, "completed");
  assert.deepEqual(seen, [[question.questionId], [question.questionId], []]);
});

test("worker consumer receipts reconcile a before-acceptance publication fault across restart without re-injecting an older answer", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-question-receipt-fault-"));
  const activeSnapshot = snapshot() as any;
  const authority = activeSnapshot.payload.authority.nodes.find((entry: any) => entry.nodeId === "alpha");
  authority.capabilities.effective = { ...(authority.capabilities.effective ?? {}), "human-input": true };
  authority.tools = [...new Set([...authority.tools, "human_question"])].sort();
  const delegation = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, createTaskId: () => "task-1" });
  delegation.accept(delegation.rootExecutionContext(), { targetNodeId: "alpha", objective: "receipt fault", deliverables: [] });
  delegation.start("task-1", "attempt-task-1");
  let questionSequence = 0;
  const base = new QuestionService({
    projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot,
    createQuestionId: () => `receipt-question-${++questionSequence}`, authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
  });
  const q1 = base.create({ nodeId: "alpha", taskId: "task-1", definition: { prompt: "First?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "receipt-q1" } });
  base.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: q1.questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "receipt-a1" });
  base.prepareTaskAnswerDeliveries("task-1");

  let markerWrites = 0;
  const faulted = new QuestionService({ ...base.options, journalFault: (_type, stage) => {
    if (stage === "beforeRename" && ++markerWrites >= 2) throw new Error("process stopped before acceptance publication");
  } });
  const seen: string[][] = [];
  const makePool = (questions: QuestionService) => new WorkerSessionPool({
    projectRoot, sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, questions,
    factory: async () => ({ linkedSessionId: "linked-alpha", async prompt(_text, _signal, invocation) {
      seen.push(invocation!.promptContext.taskContract.acceptedAnswers.map((entry) => entry.questionId));
      return "consumer succeeded";
    }, dispose() {} }),
  });
  assert.equal((await makePool(faulted).execute(task("task-1", "alpha", "receipt fault"))).status, "continuation", "a durable consumer receipt prevents terminal failure when acceptance publication faults");
  const receipt = readWorkflowJournal(projectRoot, "session-1").find((event) => event.type === "question.transition" && (event.payload as any).operation === "task-delivery-consumed");
  assert.equal(typeof (receipt?.payload as any)?.promptHash, "string");
  assert.equal((receipt?.payload as any)?.attemptId, "attempt-task-1");
  assert.match((receipt?.payload as any)?.transcriptRef ?? "", /run:run-1\/node:alpha\/task:task-1\/transcript/);

  const restarted = new QuestionService({ ...base.options });
  const q2 = restarted.create({ nodeId: "alpha", taskId: "task-1", definition: { prompt: "Second?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "receipt-q2" } });
  restarted.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: q2.questionId, expectedState: "pending", value: false, channel: "command", claimedIdentity: "human", credential: "secret", operationId: "receipt-a2" });
  assert.equal((await makePool(restarted).execute(task("task-1", "alpha", "receipt fault"))).status, "completed");
  assert.equal((await makePool(new QuestionService({ ...base.options })).execute(task("task-1", "alpha", "receipt fault"))).status, "completed");
  assert.deepEqual(seen, [[q1.questionId], [q2.questionId], []]);
});

test("maximum JSON-escaped whitespace question and answer are included losslessly before consumption", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-max-question-"));
  const activeSnapshot = snapshot() as any;
  const authority = activeSnapshot.payload.authority.nodes.find((entry: any) => entry.nodeId === "alpha");
  authority.capabilities.effective = { ...(authority.capabilities.effective ?? {}), "human-input": true };
  authority.tools = [...new Set([...authority.tools, "human_question"])].sort();
  const delegation = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, createTaskId: () => "task-1" });
  delegation.accept(delegation.rootExecutionContext(), { targetNodeId: "alpha", objective: "maximum answer", deliverables: [] });
  delegation.start("task-1", "attempt-task-1");
  const questions = new QuestionService({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot,
    createQuestionId: () => "maximum-question", authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined });
  const maximum = "\n".repeat(QUESTION_LIMITS.textAnswerBytes);
  const maximumPrompt = `${"\n".repeat(QUESTION_LIMITS.promptBytes - 1)}x`;
  const question = questions.create({ nodeId: "alpha", taskId: "task-1", definition: { prompt: maximumPrompt, kind: "text", validation: { maxLength: QUESTION_LIMITS.textAnswerBytes }, required: true }, provenance: { source: "human_question", toolCallId: "maximum-call" } });
  questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: question.questionId, expectedState: "pending", value: maximum, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "maximum-answer" });
  let prompt = "";
  const result = await new WorkerSessionPool({ projectRoot, sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, questions,
    factory: async () => ({ linkedSessionId: "maximum", async prompt(text) { prompt = text; return "consumed"; }, dispose() {} }) }).execute(task("task-1", "alpha", "maximum answer"));
  assert.equal(result.status, "completed");
  assert.match(prompt, /human-answer:maximum-question/);
  assert.ok(questions.restore().questions[question.questionId].taskDeliveryAcceptedSequence);
});

test("maximum-size JSON-escaped worker answers are delivered in exact lossless pages across failure and restart", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-answer-pages-"));
  const activeSnapshot = snapshot() as any;
  const authority = activeSnapshot.payload.authority.nodes.find((entry: any) => entry.nodeId === "alpha");
  authority.capabilities.effective = { ...(authority.capabilities.effective ?? {}), "human-input": true };
  authority.tools = [...new Set([...authority.tools, "human_question"])].sort();
  const delegation = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, createTaskId: () => "task-1" });
  delegation.accept(delegation.rootExecutionContext(), { targetNodeId: "alpha", objective: "paged maximum answers", deliverables: [] });
  delegation.start("task-1", "attempt-task-1");
  let questionSequence = 0;
  const questionOptions = {
    projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot,
    createQuestionId: () => `paged-question-${++questionSequence}`, authenticateControl: (request: any) => request.claimedIdentity,
  };
  const questions = new QuestionService(questionOptions);
  const maximum = "\n".repeat(QUESTION_LIMITS.textAnswerBytes);
  const maximumPrompt = `${"\n".repeat(QUESTION_LIMITS.promptBytes - 1)}x`;
  const questionIds: string[] = [];
  for (let index = 0; index < 3; index++) {
    const question = questions.create({ nodeId: "alpha", taskId: "task-1", definition: { prompt: maximumPrompt, kind: "text", required: true }, provenance: { source: "human_question", toolCallId: `paged-call-${index}` } });
    questionIds.push(question.questionId);
    questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: question.questionId, expectedState: "pending", value: maximum, channel: "dashboard", claimedIdentity: "human", operationId: `paged-answer-${index}` });
    questions.prepareTaskAnswerDeliveries("task-1", [question.questionId]);
  }
  assert.equal(questions.preparedTaskAnswerDeliveries("task-1").length, 3);

  const pages: string[][] = [];
  let failFirstPage = true;
  const execute = (service: QuestionService) => new WorkerSessionPool({
    projectRoot, sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, questions: service,
    factory: async () => ({ linkedSessionId: "paged-worker", async prompt(_text, _signal, invocation) {
      const answers = invocation!.promptContext.taskContract.acceptedAnswers;
      assert.ok(answers.length > 0);
      assert.equal(answers.every((answer) => answer.answer.value === maximum), true);
      pages.push(answers.map((answer) => answer.questionId));
      if (failFirstPage) {
        failFirstPage = false;
        throw Object.assign(new Error("known page provider failure"), { effectNotApplied: true, assistantOutputObserved: false, toolCallObserved: false });
      }
      return "page consumed";
    }, dispose() {} }),
  }).execute(task("task-1", "alpha", "paged maximum answers"));

  assert.equal((await execute(questions)).status, "continuation");
  assert.equal(questionIds.every((questionId) => questions.restore().questions[questionId].taskDeliveryReceipt === undefined), true, "a failed page acknowledges nothing");
  const restarted = new QuestionService(questionOptions);
  await execute(restarted);
  const firstAcceptedPage = new Set(pages[1]);
  for (const questionId of questionIds) {
    const restored = restarted.restore().questions[questionId];
    assert.equal(restored.taskDeliveryReceipt !== undefined, firstAcceptedPage.has(questionId), "only the exact fitting page receives a consumer receipt");
    assert.equal(restored.taskDeliveryAcceptedSequence !== undefined, firstAcceptedPage.has(questionId), "only the exact fitting page is accepted");
  }
  for (let page = 1; page < 10 && restarted.preparedTaskAnswerDeliveries("task-1").length; page++) await execute(restarted);

  assert.deepEqual(pages[1], pages[0], "the failed exact page is retried unchanged after restart");
  assert.ok(pages[0].length < questionIds.length, "the aggregate must require more than one prompt page");
  const successfulIds = pages.slice(1).flat();
  assert.deepEqual(successfulIds, questionIds, "successful pages are ordered, lossless, and non-overlapping");
  assert.equal(new Set(successfulIds).size, questionIds.length);
  assert.equal(restarted.preparedTaskAnswerDeliveries("task-1").length, 0);
  for (const questionId of questionIds) {
    const restored = restarted.restore().questions[questionId];
    assert.ok(restored.taskDeliveryReceipt);
    assert.ok(restored.taskDeliveryAcceptedSequence);
  }
});

test("worker retries a before-publication consumer receipt without presenting the answer twice", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-receipt-before-"));
  const activeSnapshot = snapshot() as any;
  const authority = activeSnapshot.payload.authority.nodes.find((entry: any) => entry.nodeId === "alpha");
  authority.capabilities.effective = { ...(authority.capabilities.effective ?? {}), "human-input": true };
  authority.tools = [...new Set([...authority.tools, "human_question"])].sort();
  const delegation = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, createTaskId: () => "task-1" });
  delegation.accept(delegation.rootExecutionContext(), { targetNodeId: "alpha", objective: "receipt before", deliverables: [] });
  delegation.start("task-1", "attempt-task-1");
  const base = new QuestionService({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot,
    createQuestionId: () => "receipt-before-question", authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined });
  const question = base.create({ nodeId: "alpha", taskId: "task-1", definition: { prompt: "Receipt?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "receipt-before-call" } });
  base.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: question.questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "receipt-before-answer" });
  base.prepareTaskAnswerDeliveries("task-1");
  let failed = false;
  const questions = new QuestionService({ ...base.options, journalFault: (_type, stage) => {
    if (!failed && stage === "beforeRename") { failed = true; throw new Error("receipt before-publication fault"); }
  } });
  const seen: string[][] = [];
  const result = await new WorkerSessionPool({
    projectRoot, sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, questions,
    factory: async () => ({ linkedSessionId: "receipt-before", async prompt(_text, _signal, invocation) {
      seen.push(invocation!.promptContext.taskContract.acceptedAnswers.map((answer) => answer.questionId));
      return "completed";
    }, dispose() {} }),
  }).execute(task("task-1", "alpha", "receipt before"));
  assert.equal(result.status, "completed");
  assert.deepEqual(seen, [[question.questionId]]);
  const restored = base.restore().questions[question.questionId];
  assert.ok(restored.taskDeliveryReceipt);
  assert.ok(restored.taskDeliveryAcceptedSequence);
});

test("persistent live-worker receipt fault survives pool restart and replays the successful attempt without provider redispatch", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-live-receipt-restart-"));
  const activeSnapshot = snapshot() as any;
  const authority = activeSnapshot.payload.authority.nodes.find((entry: any) => entry.nodeId === "alpha");
  authority.capabilities.effective = { ...(authority.capabilities.effective ?? {}), "human-input": true };
  authority.tools = [...new Set([...authority.tools, "human_question"])].sort();
  const delegation = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, createTaskId: () => "task-1" });
  delegation.accept(delegation.rootExecutionContext(), { targetNodeId: "alpha", objective: "live receipt restart", deliverables: [] });
  delegation.start("task-1", "attempt-task-1");
  let transitionWrites = 0;
  const baseOptions = { projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot,
    createQuestionId: () => "live-receipt-question", authenticateControl: (request: any) => request.credential === "secret" ? request.claimedIdentity : undefined };
  const faulted = new QuestionService({ ...baseOptions, journalFault: (_type, stage) => {
    if (stage === "beforeRename" && ++transitionWrites >= 5) throw new Error("persistent worker receipt stop");
  } });
  const attempts = new AttemptRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1" });
  const dispatchModel: WorkerModelDispatcher = (input) => executeWithConservativeRetry<string | import("../../src/workflows/workers.ts").WorkerPromptResponse>(attempts, {
    correlationId: `live-worker-${input.promptHash}`, nodeId: "alpha", operation: "worker.provider.prompt", input: { taskId: "task-1", promptHash: input.promptHash },
    descriptor: attemptDescriptorForModel(),
    consumerReceipt: { deliveryIds: input.questionDeliveryIds, promptHash: input.promptHash, transcriptRef: input.transcriptRef },
    consumerReceiptAfterDispatch: () => ({ deliveryIds: input.resolveQuestionDeliveryIds(), promptHash: input.promptHash, transcriptRef: input.transcriptRef }),
    onConsumerCompleted: input.onConsumerSuccess,
    dispatch: input.invoke,
  });
  let providerCalls = 0;
  const makePool = (questions: QuestionService) => new WorkerSessionPool({
    projectRoot, sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, questions, dispatchModel,
    factory: async () => ({ linkedSessionId: "live-receipt-linked", async prompt(_text, _signal, invocation) {
      providerCalls++;
      await questions.createAndPresent({ nodeId: "alpha", taskId: "task-1", definition: { prompt: "Live receipt?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "live-receipt-call" } },
        async () => ({ value: true, claimedIdentity: "human", credential: "secret", operationId: "live-receipt-answer" }));
      assert.equal(invocation!.promptContext.taskContract.acceptedAnswers.length, 0);
      return "durable live worker result";
    }, dispose() {} }),
  });
  assert.equal((await makePool(faulted).execute(task("task-1", "alpha", "live receipt restart"))).status, "continuation");
  const completed = Object.values(attempts.restore().attempts)[0];
  assert.equal(completed.status, "completed");
  assert.equal(completed.intentConsumerReceipt?.deliveryIds.length, 0);
  assert.equal(completed.consumerReceipt?.deliveryIds.length, 1);

  const restartedQuestions = new QuestionService(baseOptions);
  restartedQuestions.reconcileAnswerDeliveryReceipts();
  const restoredQuestion = restartedQuestions.restore().questions["live-receipt-question"];
  assert.ok(restoredQuestion.taskDeliveryReceipt);
  assert.ok(restoredQuestion.taskDeliveryAcceptedSequence);
  const restartedAttempts = new AttemptRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1" });
  const replayPool = new WorkerSessionPool({
    projectRoot, sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, questions: restartedQuestions,
    dispatchModel: (input: any) => executeWithConservativeRetry(restartedAttempts, {
      correlationId: `live-worker-${input.promptHash}`, nodeId: "alpha", operation: "worker.provider.prompt", input: { taskId: "task-1", promptHash: input.promptHash },
      descriptor: attemptDescriptorForModel(), consumerReceipt: { deliveryIds: input.questionDeliveryIds, promptHash: input.promptHash, transcriptRef: input.transcriptRef },
      consumerReceiptAfterDispatch: () => ({ deliveryIds: input.resolveQuestionDeliveryIds(), promptHash: input.promptHash, transcriptRef: input.transcriptRef }),
      onConsumerCompleted: input.onConsumerSuccess, dispatch: input.invoke,
    }),
    factory: async () => ({ linkedSessionId: "live-receipt-restarted", async prompt() { providerCalls++; return "must not redispatch"; }, dispose() {} }),
  });
  const replayed = await replayPool.execute(task("task-1", "alpha", "live receipt restart"));
  assert.equal(replayed.status, "completed");
  assert.equal(providerCalls, 1);
  assert.deepEqual(restartedQuestions.prepareTaskAnswerDeliveries("task-1"), []);
});

test("worker restart replay receipts only durable final deliveries and leaves a newer answer for same-attempt continuation", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-replay-new-answer-"));
  const activeSnapshot = snapshot() as any;
  const authority = activeSnapshot.payload.authority.nodes.find((entry: any) => entry.nodeId === "alpha");
  authority.capabilities.effective = { ...(authority.capabilities.effective ?? {}), "human-input": true };
  authority.tools = [...new Set([...authority.tools, "human_question"])].sort();
  const delegation = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, createTaskId: () => "task-1" });
  delegation.accept(delegation.rootExecutionContext(), { targetNodeId: "alpha", objective: "replay then continue", deliverables: [] });
  delegation.start("task-1", "attempt-task-1");
  let questionSequence = 0;
  const questionOptions = {
    projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot,
    createQuestionId: () => `replay-question-${++questionSequence}`, authenticateControl: (request: any) => request.claimedIdentity,
  };
  const questions = new QuestionService(questionOptions);
  const q1 = questions.create({ nodeId: "alpha", taskId: "task-1", definition: { prompt: "First?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "replay-q1" } });
  questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: q1.questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", operationId: "replay-a1" });

  const attempts = new AttemptRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1" });
  let q3Id = "";
  let firstProviderCalls = 0;
  const firstPool = new WorkerSessionPool({
    projectRoot, sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, questions,
    dispatchModel: (input) => executeWithConservativeRetry(attempts, {
      correlationId: "worker-reused-correlation", nodeId: "alpha", operation: "worker.provider.prompt",
      input: { taskId: "task-1", promptHash: input.promptHash }, replayInput: { taskId: "task-1" }, descriptor: attemptDescriptorForModel(),
      consumerReceipt: { deliveryIds: input.questionDeliveryIds, promptHash: input.promptHash, transcriptRef: input.transcriptRef },
      consumerReceiptAfterDispatch: () => ({ deliveryIds: input.resolveQuestionDeliveryIds(), promptHash: input.promptHash, transcriptRef: input.transcriptRef }),
      onConsumerCompleted: () => { throw new Error("process stopped before receipt settlement"); }, dispatch: input.invoke,
    }),
    factory: async () => ({ linkedSessionId: "first-worker", async prompt() {
      firstProviderCalls++;
      await questions.createAndPresent({ nodeId: "alpha", taskId: "task-1", definition: { prompt: "Second live?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "replay-q2" } },
        async () => ({ value: true, claimedIdentity: "human", operationId: "replay-a2" }));
      q3Id = questions.create({ nodeId: "alpha", taskId: "task-1", definition: { prompt: "Third later?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "replay-q3" } }).questionId;
      return "old durable result";
    }, dispose() {} }),
  });
  await firstPool.execute(delegation.restore().tasks["task-1"]);
  const completedAttempt = Object.values(attempts.restore().attempts).find((attempt) => attempt.status === "completed")!;
  assert.equal(firstProviderCalls, 1);
  assert.equal(completedAttempt.consumerReceipt?.deliveryIds.length, 2);
  questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: q3Id, expectedState: "pending", value: false, channel: "dashboard", claimedIdentity: "human", operationId: "replay-a3" });

  const restartedQuestions = new QuestionService(questionOptions);
  restartedQuestions.reconcileAnswerDeliveryReceipts();
  delegation.start("task-1", "attempt-task-1");
  const resumeTask = delegation.restore().tasks["task-1"];
  const recoveryAttemptId = restartedQuestions.containingAttemptForTaskContinuation("task-1", resumeTask.resumedByQuestionSequence);
  assert.equal(recoveryAttemptId, completedAttempt.attemptId);
  let replayProviderCalls = 0;
  const replayPool = new WorkerSessionPool({
    projectRoot, sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, questions: restartedQuestions,
    dispatchModel: (input) => executeWithConservativeRetry(new AttemptRuntime(attempts.options), {
      correlationId: "worker-reused-correlation", nodeId: "alpha", operation: "worker.provider.prompt",
      input: { taskId: "task-1", promptHash: input.promptHash }, replayInput: { taskId: "task-1" }, recoveryAttemptId,
      recoveryConsumerReceipt: completedAttempt.consumerReceipt,
      descriptor: attemptDescriptorForModel(), consumerReceipt: { deliveryIds: input.questionDeliveryIds, promptHash: input.promptHash, transcriptRef: input.transcriptRef },
      onConsumerCompleted: input.onConsumerSuccess, dispatch: input.invoke,
    }),
    factory: async () => ({ linkedSessionId: "replay-worker", async prompt() { replayProviderCalls++; return "must not redispatch old result"; }, dispose() {} }),
  });
  const replayed = await replayPool.execute(resumeTask);
  assert.equal(replayed.status, "continuation");
  assert.equal(replayProviderCalls, 0);
  let durableQ3 = restartedQuestions.restore().questions[q3Id];
  assert.equal(durableQ3.taskDeliveryReceipt, undefined, "old attempt must not receipt the newer answer");
  assert.equal(durableQ3.taskDeliveryAcceptedSequence, undefined);
  if (replayed.status !== "continuation") assert.fail("replayed containing turn must continue to the newer answer");
  delegation.start("task-1", "attempt-task-1");
  const nextTask = delegation.restore().tasks["task-1"];
  assert.equal(restartedQuestions.containingAttemptForTaskContinuation("task-1", nextTask.resumedByQuestionSequence), undefined,
    "the durable containing attempt may be replayed only by the first launch for its resume marker");

  let subsequentQuestionIds: readonly string[] = [];
  const continuationPool = new WorkerSessionPool({
    projectRoot, sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, questions: restartedQuestions,
    factory: async () => ({ linkedSessionId: "continuation-worker", async prompt(_text, _signal, invocation) {
      subsequentQuestionIds = invocation!.promptContext.taskContract.acceptedAnswers.map((answer) => answer.questionId);
      return "new continuation result";
    }, dispose() {} }),
  });
  const continued = await continuationPool.execute(resumeTask);
  assert.equal(continued.status, "completed");
  assert.deepEqual(subsequentQuestionIds, [q3Id]);
  durableQ3 = restartedQuestions.restore().questions[q3Id];
  assert.ok(durableQ3.taskDeliveryAcceptedSequence);
});

test("after-publication live-worker receipt faults reconcile without duplicate provider or answer delivery", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-live-receipt-after-"));
  const activeSnapshot = snapshot() as any;
  const authority = activeSnapshot.payload.authority.nodes.find((entry: any) => entry.nodeId === "alpha");
  authority.capabilities.effective = { ...(authority.capabilities.effective ?? {}), "human-input": true };
  authority.tools = [...new Set([...authority.tools, "human_question"])].sort();
  const delegation = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, createTaskId: () => "task-1" });
  delegation.accept(delegation.rootExecutionContext(), { targetNodeId: "alpha", objective: "after receipt", deliverables: [] });
  delegation.start("task-1", "attempt-task-1");
  let writes = 0;
  const questions = new QuestionService({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot,
    createQuestionId: () => "live-after-question", authenticateControl: (request) => request.claimedIdentity,
    journalFault: (_type, stage) => { if (stage === "afterRename" && ++writes >= 5) throw new Error("stop after receipt publication"); } });
  let providerCalls = 0;
  const result = await new WorkerSessionPool({ projectRoot, sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, questions,
    factory: async () => ({ linkedSessionId: "live-after", async prompt() {
      providerCalls++;
      await questions.createAndPresent({ nodeId: "alpha", taskId: "task-1", definition: { prompt: "After?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "live-after-call" } },
        async () => ({ value: true, claimedIdentity: "human", operationId: "live-after-answer" }));
      return "after publication";
    }, dispose() {} }) }).execute(task("task-1", "alpha", "after receipt"));
  assert.equal(result.status, "completed");
  assert.equal(providerCalls, 1);
  const restored = new QuestionService({ ...questions.options, journalFault: undefined }).restore().questions["live-after-question"];
  assert.ok(restored.taskDeliveryReceipt);
  assert.ok(restored.taskDeliveryAcceptedSequence);
});

test("a live first answer followed by an offline second question does not re-inject the live answer", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-question-live-offline-"));
  const activeSnapshot = snapshot() as any;
  const authority = activeSnapshot.payload.authority.nodes.find((entry: any) => entry.nodeId === "alpha");
  authority.capabilities.effective = { ...(authority.capabilities.effective ?? {}), "human-input": true };
  authority.tools = [...new Set([...authority.tools, "human_question"])].sort();
  const delegation = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, createTaskId: () => "task-1" });
  delegation.accept(delegation.rootExecutionContext(), { targetNodeId: "alpha", objective: "live then offline", deliverables: [] });
  delegation.start("task-1", "attempt-task-1");
  let sequence = 0;
  const questions = new QuestionService({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot,
    createQuestionId: () => `live-offline-${++sequence}`, authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined });
  const seen: string[][] = [];
  let q2 = "";
  let turn = 0;
  const pool = new WorkerSessionPool({ projectRoot, sessionId: "session-1", runId: "run-1", snapshot: activeSnapshot, questions,
    factory: async () => ({ linkedSessionId: "linked-alpha", async prompt(_text, _signal, invocation) {
      seen.push(invocation!.promptContext.taskContract.acceptedAnswers.map((entry) => entry.questionId));
      if (turn++ === 0) {
        await questions.createAndPresent({ nodeId: "alpha", taskId: "task-1", definition: { prompt: "Live?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "live-q1" } },
          async () => ({ value: true, claimedIdentity: "human", credential: "secret", operationId: "live-a1" }));
        q2 = questions.create({ nodeId: "alpha", taskId: "task-1", definition: { prompt: "Offline?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "offline-q2" } }).questionId;
      }
      return "turn";
    }, dispose() {} }),
  });
  assert.equal((await pool.execute(task("task-1", "alpha", "live then offline"))).status, "suspended");
  questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: q2, expectedState: "pending", value: false, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "offline-a2" });
  assert.equal((await pool.execute(task("task-1", "alpha", "live then offline"))).status, "completed");
  assert.deepEqual(seen, [[], [q2]]);
});

test("worker result output is bounded and active execution settlement is observable", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workers-cleanup-"));
  let aborts = 0;
  let disposals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pool = new WorkerSessionPool({ projectRoot, sessionId: "session-1", runId: "run-1", snapshot: snapshot(), resultSummaryBytes: 64, factory: async () => ({
    linkedSessionId: "linked",
    async prompt() { await gate; return "x".repeat(1_000); },
    async abort() { aborts++; },
    dispose() { disposals++; },
  }) });
  const pending = pool.execute(task("task-1", "alpha", "long"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.activeExecutionCount, 1);
  await pool.closeSessions();
  assert.equal(await pool.waitForSettlement(20), false, "a provider ignoring abort remains explicitly unsettled");
  assert.equal(pool.hasLiveHandles(), true);
  release();
  const result = await pending;
  if (result.status === "suspended" || result.status === "continuation") assert.fail("non-delegating worker must return a terminal result");
  assert.ok(Buffer.byteLength(result.summary, "utf8") <= 64);
  assert.equal(await pool.waitForSettlement(100), true);
  assert.equal(aborts, 1);
  assert.equal(disposals, 1);
  assert.equal(pool.activeSessionCount, 0);
  assert.equal(pool.hasLiveHandles(), false);
});
