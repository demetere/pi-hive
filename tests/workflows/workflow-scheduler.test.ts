import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { DelegationRuntime, type WorkerResultInput } from "../../src/workflows/delegation.ts";
import { DurableDelegationScheduler } from "../../src/workflows/scheduler.ts";
import { QuestionService } from "../../src/workflows/questions.ts";

function snapshot(): ActivationSnapshotFileV1 {
  return { snapshotHash: "c".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", payload: {
    project: { projectId: "project-1", rootRef: "." }, workflow: { id: "delivery", team: { rootId: "root", nodes: [
      { id: "root", agentId: "lead", memberIds: ["a", "b"], depth: 1 },
      { id: "a", agentId: "shared", parentId: "root", memberIds: ["a1"], depth: 2 },
      { id: "b", agentId: "shared", parentId: "root", memberIds: [], depth: 2 },
      { id: "a1", agentId: "leaf", parentId: "a", memberIds: [], depth: 3 },
    ] } }, authority: { capabilityContractVersion: 1, nodes: [] }, agents: [], skills: [], knowledge: [], models: [], sources: [], versions: {} as never,
  } } as unknown as ActivationSnapshotFileV1;
}

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-scheduler-"));
  let task = 0;
  let attempt = 0;
  const runtime = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: snapshot(), createTaskId: () => `task-${++task}` });
  const root = runtime.rootExecutionContext();
  const ids = {
    a1: runtime.accept(root, { targetNodeId: "a", objective: "a-one", deliverables: [] }).taskId,
    a2: runtime.accept(root, { targetNodeId: "a", objective: "a-two", deliverables: [] }).taskId,
    b1: runtime.accept(root, { targetNodeId: "b", objective: "b-one", deliverables: [] }).taskId,
    b2: runtime.accept(root, { targetNodeId: "b", objective: "b-two", deliverables: [] }).taskId,
  };
  return { projectRoot, runtime, ids, createAttemptId: () => `attempt-${++attempt}` };
}

const completed = (summary: string): WorkerResultInput => ({ status: "completed", summary, outputRefs: [], evidenceRefs: [] });

test("scheduler preserves per-node FIFO and durable least-recently-dispatched fairness", async () => {
  const f = fixture();
  const order: string[] = [];
  const scheduler = new DurableDelegationScheduler({
    runtime: f.runtime,
    maxParallel: 1,
    createAttemptId: f.createAttemptId,
    execute: async (task) => { order.push(task.taskId); return completed(task.objective); },
  });
  await scheduler.runUntilSettled();
  assert.deepEqual(order, [f.ids.a1, f.ids.b1, f.ids.a2, f.ids.b2]);
  assert.equal(scheduler.activeCount, 0);
  assert.equal(scheduler.hasLiveHandles(), false);
  assert.equal(f.runtime.status(f.runtime.rootExecutionContext(), { limit: 10 }).summary.completed, 4);

  const restartedOrder: string[] = [];
  const restarted = new DurableDelegationScheduler({
    runtime: new DelegationRuntime(f.runtime.options), maxParallel: 1, createAttemptId: f.createAttemptId,
    verifiedTakeover: () => true,
    execute: async (task) => { restartedOrder.push(task.taskId); return completed("unexpected"); },
  });
  await restarted.runUntilSettled();
  assert.deepEqual(restartedOrder, [], "terminal work must not restart after journal replay");
});

test("different node IDs sharing one agent identity run independently", async () => {
  const f = fixture();
  let active = 0;
  let maximum = 0;
  const seenNodes = new Set<string>();
  const scheduler = new DurableDelegationScheduler({
    runtime: f.runtime, maxParallel: 2, createAttemptId: f.createAttemptId,
    execute: async (task) => {
      seenNodes.add(task.targetNodeId);
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return completed(task.taskId);
    },
  });
  await scheduler.runUntilSettled();
  assert.equal(maximum, 2);
  assert.deepEqual(seenNodes, new Set(["a", "b"]));
});

test("max-parallel one nested delegation yields and resumes only after accepted delivery", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-scheduler-nested-"));
  let taskNumber = 0;
  let attempt = 0;
  const options = { projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: snapshot(), createTaskId: () => `task-${++taskNumber}` };
  const runtime = new DelegationRuntime(options);
  const parent = runtime.accept(runtime.rootExecutionContext(), { targetNodeId: "a", objective: "parent", deliverables: [] }).taskId;
  let childId = "";
  let parentExecutions = 0;
  const executionOrder: string[] = [];
  const scheduler = new DurableDelegationScheduler({
    runtime, maxParallel: 1, createAttemptId: () => `attempt-${++attempt}`,
    execute: async (task, control) => {
      executionOrder.push(task.targetNodeId);
      if (task.taskId === parent && parentExecutions++ === 0) {
        childId = runtime.accept(control.executionContext, { targetNodeId: "a1", objective: "child", deliverables: [] }).taskId;
        return { status: "suspended", dependencyTaskIds: [childId] };
      }
      return completed(task.objective);
    },
    onResultDurable: (task) => {
      if (task.parentNodeId !== "root") {
        const deliveryId = `delivery-${task.taskId}`;
        runtime.deliverPendingResultsToSuspendedTask(parent, deliveryId);
      }
    },
  });
  await scheduler.runUntilSettled();
  assert.deepEqual(executionOrder, ["a", "a1", "a"]);
  assert.equal(runtime.restore().tasks[parent].result?.status, "completed");
  assert.equal(runtime.restore().tasks[parent].attempts.length, 1);
  assert.equal(runtime.restore().tasks[childId].result?.status, "completed");
});

test("task acceptance fault atomically preserves parent dependency linkage for takeover replay and child delivery", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-scheduler-accept-fault-"));
  let taskNumber = 0;
  let injectAcceptanceFault = false;
  const options = {
    projectRoot,
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-1",
    snapshot: snapshot(),
    createTaskId: () => `task-${++taskNumber}`,
    journalFault: (eventType: string, stage: string) => {
      if (injectAcceptanceFault && eventType === "task.accepted" && stage === "afterRename") {
        injectAcceptanceFault = false;
        throw new Error("simulated crash after child acceptance publication");
      }
    },
  };
  const runtime = new DelegationRuntime(options);
  const parentId = runtime.accept(runtime.rootExecutionContext(), { targetNodeId: "a", objective: "parent", deliverables: [] }).taskId;
  runtime.start(parentId, "attempt-parent");
  injectAcceptanceFault = true;
  assert.throws(() => runtime.accept(runtime.workerExecutionContext(parentId, "attempt-parent"), {
    targetNodeId: "a1", objective: "child accepted at crash", deliverables: [],
  }), /simulated crash/i);

  const replayed = new DelegationRuntime(options);
  assert.deepEqual(replayed.restore().tasks[parentId].suspendedOn, ["task-2"], "child acceptance must atomically persist the parent linkage");
  assert.equal(replayed.restore().tasks[parentId].queueState, "active");

  const executionOrder: string[] = [];
  const deliveredToParent: string[] = [];
  const scheduler = new DurableDelegationScheduler({
    runtime: replayed,
    maxParallel: 1,
    verifiedTakeover: () => true,
    createAttemptId: () => "unexpected-new-attempt",
    execute: async (task) => {
      executionOrder.push(task.targetNodeId);
      if (task.taskId === parentId) {
        const child = replayed.restore().tasks["task-2"];
        if (child.resultAcceptedSequence !== undefined) deliveredToParent.push(child.result?.summary ?? "");
      }
      return completed(task.objective);
    },
    onResultDurable: (task) => {
      if (task.taskId === "task-2") replayed.deliverPendingResultsToSuspendedTask(parentId, "delivery-task-2");
    },
  });
  await scheduler.runUntilSettled();

  const parent = replayed.restore().tasks[parentId];
  assert.deepEqual(executionOrder, ["a1", "a"]);
  assert.deepEqual(deliveredToParent, ["child accepted at crash"]);
  assert.deepEqual(parent.attempts.map((attempt) => attempt.attemptId), ["attempt-parent"]);
  assert.equal(parent.attempts[0].interruptedSequence, undefined, "linked parent takeover must suspend rather than restart the attempt");
  assert.equal(parent.result?.status, "completed");
});

test("a durable resume-ready task continues the same attempt after scheduler restart", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-scheduler-resume-replay-"));
  let taskNumber = 0;
  const runtime = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: snapshot(), createTaskId: () => `task-${++taskNumber}` });
  const parentId = runtime.accept(runtime.rootExecutionContext(), { targetNodeId: "a", objective: "parent", deliverables: [] }).taskId;
  runtime.start(parentId, "attempt-parent");
  const parentContext = runtime.workerExecutionContext(parentId, "attempt-parent");
  const childId = runtime.accept(parentContext, { targetNodeId: "a1", objective: "child", deliverables: [] }).taskId;
  runtime.suspend(parentId, [childId]);
  runtime.start(childId, "attempt-child");
  runtime.recordResult(childId, completed("child"));
  runtime.deliverPendingResultsToSuspendedTask(parentId, "delivery-replay-child");

  const replayed = new DelegationRuntime(runtime.options);
  const scheduler = new DurableDelegationScheduler({
    runtime: replayed, maxParallel: 1,
    execute: async (task) => completed(task.objective),
  });
  await scheduler.runUntilSettled();
  assert.equal(replayed.restore().tasks[parentId].result?.status, "completed");
  assert.deepEqual(replayed.restore().tasks[parentId].attempts.map((attempt) => attempt.attemptId), ["attempt-parent"]);
});

test("human question suspension releases the slot and an answer resumes the same task attempt", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-scheduler-question-"));
  let taskNumber = 0;
  const authoritySnapshot = snapshot() as any;
  authoritySnapshot.payload.authority.nodes = [{ nodeId: "a", capabilities: { effective: { "human-input": true } }, tools: ["human_question"] }];
  authoritySnapshot.payload.agents = [{ id: "shared", name: "Shared", prompt: "worker" }];
  const runtime = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: authoritySnapshot, createTaskId: () => `task-${++taskNumber}` });
  const taskId = runtime.accept(runtime.rootExecutionContext(), { targetNodeId: "a", objective: "ask then resume", deliverables: [] }).taskId;
  const questions = new QuestionService({
    projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: authoritySnapshot,
    createQuestionId: () => "question-1", authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
  });
  let executions = 0;
  const scheduler = new DurableDelegationScheduler({
    runtime, maxParallel: 1, createAttemptId: () => "attempt-1",
    execute: async (task) => {
      if (executions++ === 0) {
        const question = questions.create({ nodeId: task.targetNodeId, taskId: task.taskId, definition: { prompt: "Proceed?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "call-1" } });
        return { status: "suspended", questionIds: [question.questionId] };
      }
      assert.equal(questions.acceptedAnswersForTask(task.taskId)[0].answer.value, true);
      return completed("resumed same task");
    },
  });
  await scheduler.runUntilSettled();
  assert.equal(scheduler.activeCount, 0, "waiting questions must not occupy max-parallel slots");
  assert.equal(runtime.restore().tasks[taskId].queueState, "suspended");
  assert.deepEqual(runtime.restore().tasks[taskId].attempts.map((attempt) => attempt.attemptId), ["attempt-1"]);
  questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "question-1", expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "answer-1" });
  await scheduler.runUntilSettled();
  assert.equal(runtime.restore().tasks[taskId].result?.summary, "resumed same task");
  assert.deepEqual(runtime.restore().tasks[taskId].attempts.map((attempt) => attempt.attemptId), ["attempt-1"], "question resume must preserve the task attempt");
});

test("offline question answer resumes after scheduler restart without takeover", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-scheduler-question-restart-"));
  const authoritySnapshot = snapshot() as any;
  authoritySnapshot.payload.authority.nodes = [{ nodeId: "a", capabilities: { effective: { "human-input": true } }, tools: ["human_question"] }];
  authoritySnapshot.payload.agents = [{ id: "shared", name: "Shared", prompt: "worker" }];
  const options = { projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: authoritySnapshot, createTaskId: () => "task-question-restart" };
  const runtime = new DelegationRuntime(options);
  const taskId = runtime.accept(runtime.rootExecutionContext(), { targetNodeId: "a", objective: "resume after owner restart", deliverables: [] }).taskId;
  runtime.start(taskId, "attempt-question-restart");
  const questions = new QuestionService({
    projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: authoritySnapshot,
    createQuestionId: () => "question-restart", authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
  });
  questions.create({ nodeId: "a", taskId, definition: { prompt: "Proceed?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "call-restart" } });
  questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "question-restart", expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "answer-restart" });

  let takeoverChecks = 0;
  const replayed = new DelegationRuntime(options);
  const scheduler = new DurableDelegationScheduler({
    runtime: replayed, maxParallel: 1,
    verifiedTakeover: () => { takeoverChecks++; return false; },
    execute: async (_task, control) => {
      assert.equal(control.attemptId, "attempt-question-restart");
      return completed("continued after offline answer");
    },
  });
  await scheduler.runUntilSettled();
  assert.equal(takeoverChecks, 0);
  assert.equal(replayed.restore().tasks[taskId].result?.summary, "continued after offline answer");
  assert.deepEqual(replayed.restore().tasks[taskId].attempts.map((attempt) => attempt.attemptId), ["attempt-question-restart"]);
});

test("mixed takeover preserves question and consumed-receipt resume-ready attempts", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-scheduler-mixed-takeover-"));
  const authoritySnapshot = snapshot() as any;
  authoritySnapshot.payload.authority.nodes = [
    { nodeId: "a", capabilities: { effective: { "human-input": true } }, tools: ["human_question"] },
    { nodeId: "b", capabilities: { effective: { "human-input": true } }, tools: ["human_question"] },
  ];
  authoritySnapshot.payload.agents = [{ id: "shared", name: "Shared", prompt: "worker" }];
  let taskNumber = 0;
  const options = { projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: authoritySnapshot, createTaskId: () => `mixed-${++taskNumber}` };
  const runtime = new DelegationRuntime(options);
  const root = runtime.rootExecutionContext();
  const unknown = runtime.accept(root, { targetNodeId: "a", objective: "unknown active", deliverables: [] }).taskId;
  const resume = runtime.accept(root, { targetNodeId: "b", objective: "question resume", deliverables: [] }).taskId;
  runtime.start(unknown, "attempt-unknown");
  runtime.start(resume, "attempt-resume");
  const questions = new QuestionService({
    projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: authoritySnapshot,
    createQuestionId: () => "mixed-question", authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
  });
  questions.create({ nodeId: "b", taskId: resume, definition: { prompt: "Resume?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "mixed-call" } });
  questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "mixed-question", expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "mixed-answer" });
  const [delivery] = questions.prepareTaskAnswerDeliveries(resume);
  questions.recordTaskAnswerDeliveryReceipt(delivery, { promptHash: "a".repeat(64), attemptId: "attempt-resume", transcriptRef: `run:run-1/node:b/task:${resume}/transcript` });

  const recovered = new DelegationRuntime(options);
  recovered.reconcileActiveAfterTakeover(true);
  assert.equal(recovered.restore().tasks[unknown].queueState, "queued");
  assert.equal(recovered.restore().tasks[resume].queueState, "active");
  assert.equal(recovered.restore().tasks[resume].attempts[0].interruptedSequence, undefined);
});

test("task start admission CAS leaves queued work unchanged when approval wins the race", () => {
  const f = fixture();
  const runtime = new DelegationRuntime({
    ...f.runtime.options,
    startAuthority: { admit: () => ({ ok: false as const, reason: "approval wait won admission" }) },
  });
  assert.throws(() => runtime.start(f.ids.a1, "attempt-raced"), /approval wait/i);
  assert.equal(runtime.restore().tasks[f.ids.a1].queueState, "queued");
  assert.equal(runtime.restore().tasks[f.ids.a1].attempts.length, 0);
});

test("worker terminal publication loses to an answered undelivered question and preserves the attempt", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-scheduler-terminal-question-cas-"));
  const authoritySnapshot = snapshot() as any;
  authoritySnapshot.payload.authority.nodes = [{ nodeId: "a", capabilities: { effective: { "human-input": true } }, tools: ["human_question"] }];
  authoritySnapshot.payload.agents = [{ id: "shared", name: "Shared", prompt: "worker" }];
  const base = { projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: authoritySnapshot, createTaskId: () => "terminal-race" };
  const runtime = new DelegationRuntime(base);
  const taskId = runtime.accept(runtime.rootExecutionContext(), { targetNodeId: "a", objective: "terminal race", deliverables: [] }).taskId;
  runtime.start(taskId, "attempt-terminal-race");
  const questions = new QuestionService({ ...base, createQuestionId: () => "terminal-question", authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined });
  questions.create({ nodeId: "a", taskId, definition: { prompt: "Late?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "terminal-call" } });
  questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "terminal-question", expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "terminal-answer" });
  const guarded = new DelegationRuntime({ ...base, terminalAuthority: { assertTaskMayTerminal: (events: any, id: string) => questions.assertTaskMayTerminal(events, id) } });
  assert.throws(() => guarded.recordResult(taskId, completed("must lose")), /undelivered|unaccepted|answer/i);
  const preserved = guarded.restore().tasks[taskId];
  assert.equal(preserved.queueState, "active");
  assert.equal(preserved.resumedByQuestionSequence !== undefined, true);
  assert.deepEqual(preserved.attempts.map((attempt) => attempt.attemptId), ["attempt-terminal-race"]);
});

test("ordinary worker terminal publication rejects pending task questions and preserves the exact attempt across restart", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-scheduler-pending-terminal-cas-"));
  const authoritySnapshot = snapshot() as any;
  authoritySnapshot.payload.authority.nodes = [{ nodeId: "a", capabilities: { effective: { "human-input": true } }, tools: ["human_question"] }];
  authoritySnapshot.payload.agents = [{ id: "shared", name: "Shared", prompt: "worker" }];
  const base = { projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: authoritySnapshot, createTaskId: () => "pending-terminal-task" };
  const questions = new QuestionService({ ...base, createQuestionId: () => "pending-terminal-question", authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined });
  const runtime = new DelegationRuntime({ ...base, terminalAuthority: { assertTaskMayTerminal: (events, id) => questions.assertTaskMayTerminal(events, id) } });
  const taskId = runtime.accept(runtime.rootExecutionContext(), { targetNodeId: "a", objective: "pending terminal", deliverables: [] }).taskId;
  runtime.start(taskId, "pending-terminal-attempt");
  questions.create({ nodeId: "a", taskId, definition: { prompt: "Still needed?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "pending-terminal-call" } });

  assert.throws(() => runtime.recordResult(taskId, completed("must not publish")), /pending|question|undelivered/i);
  const restarted = new DelegationRuntime(runtime.options).restore().tasks[taskId];
  assert.equal(restarted.queueState, "suspended");
  assert.deepEqual(restarted.attempts.map((attempt) => attempt.attemptId), ["pending-terminal-attempt"]);
});

test("task-bound answer rejects a terminal exact task attempt without creating an answered orphan", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-scheduler-terminal-first-answer-cas-"));
  const authoritySnapshot = snapshot() as any;
  authoritySnapshot.payload.authority.nodes = [{ nodeId: "a", capabilities: { effective: { "human-input": true } }, tools: ["human_question"] }];
  authoritySnapshot.payload.agents = [{ id: "shared", name: "Shared", prompt: "worker" }];
  const base = { projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: authoritySnapshot, createTaskId: () => "terminal-first-task" };
  const runtime = new DelegationRuntime(base);
  const taskId = runtime.accept(runtime.rootExecutionContext(), { targetNodeId: "a", objective: "terminal first", deliverables: [] }).taskId;
  runtime.start(taskId, "terminal-first-attempt");
  const questions = new QuestionService({ ...base, createQuestionId: () => "terminal-first-question", authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined });
  const question = questions.create({ nodeId: "a", taskId, definition: { prompt: "Too late?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "terminal-first-call" } });
  runtime.recordResult(taskId, completed("terminal won without the production guard"));

  assert.throws(() => questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: question.questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "terminal-first-answer" }), /task|attempt|terminal|live|late/i);
  const restored = new QuestionService({ ...questions.options }).restore().questions[question.questionId];
  assert.equal(restored.state, "pending");
  assert.equal(restored.answer, undefined);
});

test("cross-process answer and ordinary terminal publication serialize through the journal CAS", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-scheduler-question-cross-process-"));
  const authoritySnapshot = snapshot() as any;
  authoritySnapshot.payload.authority.nodes = [{ nodeId: "a", capabilities: { effective: { "human-input": true } }, tools: ["human_question"] }];
  authoritySnapshot.payload.agents = [{ id: "shared", name: "Shared", prompt: "worker" }];
  const base = { projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: authoritySnapshot, createTaskId: () => "cross-task" };
  const runtime = new DelegationRuntime(base);
  const taskId = runtime.accept(runtime.rootExecutionContext(), { targetNodeId: "a", objective: "cross process race", deliverables: [] }).taskId;
  runtime.start(taskId, "cross-attempt");
  const questions = new QuestionService({ ...base, createQuestionId: () => "cross-question", authenticateControl: (request) => request.claimedIdentity });
  questions.create({ nodeId: "a", taskId, definition: { prompt: "Race?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "cross-call" } });
  const common = `const projectRoot=${JSON.stringify(projectRoot)}; const snapshot=${JSON.stringify(authoritySnapshot)};`;
  const scripts = [
    `${common} const {QuestionService}=await import('./src/workflows/questions.ts'); const q=new QuestionService({projectRoot,projectId:'project-1',sessionId:'session-1',runId:'run-1',snapshot,authenticateControl:r=>r.claimedIdentity}); q.answer({projectId:'project-1',sessionId:'session-1',runId:'run-1',questionId:'cross-question',expectedState:'pending',value:true,channel:'dashboard',claimedIdentity:'human',operationId:'cross-answer'});`,
    `${common} const [{DelegationRuntime},{QuestionService}]=await Promise.all([import('./src/workflows/delegation.ts'),import('./src/workflows/questions.ts')]); const q=new QuestionService({projectRoot,projectId:'project-1',sessionId:'session-1',runId:'run-1',snapshot,authenticateControl:r=>r.claimedIdentity}); const d=new DelegationRuntime({projectRoot,projectId:'project-1',sessionId:'session-1',runId:'run-1',snapshot,terminalAuthority:{assertTaskMayTerminal:(events,id)=>q.assertTaskMayTerminal(events,id)}}); d.recordResult('cross-task',{status:'completed',summary:'race terminal',outputRefs:[],evidenceRefs:[]});`,
  ];
  const run = (script: string) => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: process.cwd(), env: { ...process.env, NODE_V8_COVERAGE: "" }, stdio: ["ignore", "ignore", "ignore"] });
    child.once("error", reject); child.once("exit", resolve);
  });
  const codes = await Promise.all(scripts.map(run));
  assert.equal(codes.filter((code) => code === 0).length, 1);
  const restoredTask = new DelegationRuntime(base).restore().tasks[taskId];
  const restoredQuestion = new QuestionService({ ...questions.options }).restore().questions["cross-question"];
  assert.equal(restoredTask.queueState, "active");
  assert.equal(restoredQuestion.state, "answered");
  assert.deepEqual(restoredTask.attempts.map((attempt) => attempt.attemptId), ["cross-attempt"]);
});

test("scheduler terminal CAS loses to a late answer and continues the same attempt", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-scheduler-late-answer-"));
  const authoritySnapshot = snapshot() as any;
  authoritySnapshot.payload.authority.nodes = [{ nodeId: "a", capabilities: { effective: { "human-input": true } }, tools: ["human_question"] }];
  authoritySnapshot.payload.agents = [{ id: "shared", name: "Shared", prompt: "worker" }];
  const base = { projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: authoritySnapshot, createTaskId: () => "late-task" };
  const questions = new QuestionService({ ...base, createQuestionId: () => "late-question", authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined });
  const runtime = new DelegationRuntime({ ...base, terminalAuthority: { assertTaskMayTerminal: (events, id) => questions.assertTaskMayTerminal(events, id) } });
  const taskId = runtime.accept(runtime.rootExecutionContext(), { targetNodeId: "a", objective: "late answer", deliverables: [] }).taskId;
  let executions = 0;
  const scheduler = new DurableDelegationScheduler({
    runtime, maxParallel: 1, createAttemptId: () => "late-attempt",
    execute: async () => {
      executions++;
      if (executions === 1) {
        questions.create({ nodeId: "a", taskId, definition: { prompt: "Late?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "late-call" } });
        questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "late-question", expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "late-answer" });
        return completed("stale terminal result");
      }
      const [delivery] = questions.prepareTaskAnswerDeliveries(taskId);
      questions.recordTaskAnswerDeliveryReceipt(delivery, { promptHash: "e".repeat(64), attemptId: "late-attempt", transcriptRef: `run:run-1/node:a/task:${taskId}/transcript` });
      questions.acceptTaskAnswerDelivery(delivery);
      return completed("continued after late answer");
    },
  });
  await scheduler.runUntilSettled();
  const yielded = runtime.restore().tasks[taskId];
  assert.equal(executions, 1, "terminal CAS loss durably yields instead of relaunching in the same scheduler drain");
  assert.equal(yielded.result, undefined);
  assert.equal(yielded.questionContinuationTurn, 1);
  await scheduler.runUntilSettled();
  const terminal = runtime.restore().tasks[taskId];
  assert.equal(executions, 2);
  assert.equal(terminal.result?.summary, "continued after late answer");
  assert.deepEqual(terminal.attempts.map((attempt) => attempt.attemptId), ["late-attempt"]);
});

test("verified takeover interrupts and requeues journal-active tasks", async () => {
  const f = fixture();
  f.runtime.start(f.ids.a1, "crashed-attempt");
  const replayed = new DelegationRuntime(f.runtime.options);
  const seen: string[] = [];
  const scheduler = new DurableDelegationScheduler({
    runtime: replayed,
    maxParallel: 1,
    verifiedTakeover: () => true,
    createAttemptId: f.createAttemptId,
    execute: async (task) => { seen.push(task.taskId); return completed(task.taskId); },
  });
  await scheduler.runUntilSettled();
  assert.equal(replayed.restore().tasks[f.ids.a1].attempts[0].interruptedSequence !== undefined, true);
  assert.equal(replayed.restore().tasks[f.ids.a1].attempts.length, 2);
  assert.equal(seen.includes(f.ids.a1), true);

  const unsafe = fixture();
  unsafe.runtime.start(unsafe.ids.a1, "still-owned-attempt");
  const denied = new DurableDelegationScheduler({ runtime: new DelegationRuntime(unsafe.runtime.options), maxParallel: 1, verifiedTakeover: () => false, execute: async () => completed("no") });
  await assert.rejects(denied.runUntilSettled(), /verified takeover/i);
});

test("worker failure becomes a bounded task result and does not terminate the run", async () => {
  const f = fixture();
  const scheduler = new DurableDelegationScheduler({
    runtime: f.runtime, maxParallel: 1, createAttemptId: f.createAttemptId,
    execute: async (task) => { if (task.taskId === f.ids.a1) throw new Error("provider unavailable"); return completed(task.taskId); },
  });
  await scheduler.runUntilSettled();
  assert.equal(f.runtime.restore().tasks[f.ids.a1].result?.status, "failed");
  assert.match(f.runtime.restore().tasks[f.ids.a1].result?.summary ?? "", /provider unavailable/);
  assert.equal(f.runtime.restore().tasks[f.ids.b2].result?.status, "completed");
});

test("invalid worker executor outcomes fail their tasks without stopping later work", async () => {
  const f = fixture();
  const scheduler = new DurableDelegationScheduler({
    runtime: f.runtime, maxParallel: 1, createAttemptId: f.createAttemptId,
    execute: async (task) => {
      if (task.taskId === f.ids.a1) return undefined as never;
      if (task.taskId === f.ids.b1) return { status: "suspended", dependencyTaskIds: [] };
      if (task.taskId === f.ids.a2) return { status: "unknown" } as never;
      return completed("valid result");
    },
  });

  await scheduler.runUntilSettled();
  const tasks = f.runtime.restore().tasks;
  assert.match(tasks[f.ids.a1].result?.summary ?? "", /no result/i);
  assert.match(tasks[f.ids.b1].result?.summary ?? "", /no dependency/i);
  assert.match(tasks[f.ids.a2].result?.summary ?? "", /invalid terminal status/i);
  assert.equal(tasks[f.ids.b2].result?.status, "completed");
});

test("pause aborts cooperative work and restart resumes queued tasks", async () => {
  const f = fixture();
  let releases = 0;
  const scheduler = new DurableDelegationScheduler({
    runtime: f.runtime, maxParallel: 1, createAttemptId: f.createAttemptId,
    execute: async (task, control) => {
      if (!control.signal.aborted) await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve(), { once: true }));
      releases++;
      return completed(task.taskId);
    },
  });
  const running = scheduler.runUntilSettled();
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.pauseAdmission("process shutdown");
  scheduler.abortOwnedWork("process shutdown");
  assert.equal(await scheduler.waitForSettlement(100), true);
  await running;
  assert.equal(releases, 1);
  assert.equal(Object.values(f.runtime.restore().tasks).every((task) => task.queueState === "queued"), true);
  scheduler.resume();
});

test("answer and pause in either order preserve question resume-ready work on the same attempt across restart", async () => {
  for (const answerFirst of [true, false]) {
    const projectRoot = mkdtempSync(join(tmpdir(), `hive-scheduler-answer-pause-${answerFirst ? "answer-first" : "pause-first"}-`));
    const authoritySnapshot = snapshot() as any;
    authoritySnapshot.payload.authority.nodes = [{ nodeId: "a", capabilities: { effective: { "human-input": true } }, tools: ["human_question"] }];
    authoritySnapshot.payload.agents = [{ id: "shared", name: "Shared", prompt: "worker" }];
    const options = { projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: authoritySnapshot, createTaskId: () => "pause-question-task" };
    const runtime = new DelegationRuntime(options);
    const taskId = runtime.accept(runtime.rootExecutionContext(), { targetNodeId: "a", objective: "pause answer race", deliverables: [] }).taskId;
    const questions = new QuestionService({ ...options, createQuestionId: () => "pause-question", authenticateControl: (request) => request.claimedIdentity });
    let questionCreated!: () => void;
    const created = new Promise<void>((resolve) => { questionCreated = resolve; });
    const scheduler = new DurableDelegationScheduler({
      runtime, maxParallel: 1, createAttemptId: () => "immutable-attempt",
      execute: async (_task, control) => {
        questions.create({ nodeId: "a", taskId, definition: { prompt: "Resume?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "pause-call" } });
        questionCreated();
        if (!control.signal.aborted) await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve(), { once: true }));
        return completed("aborted containing turn");
      },
    });
    const running = scheduler.runUntilSettled();
    await created;
    const answer = () => questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "pause-question", expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", operationId: `pause-answer-${answerFirst}` });
    if (answerFirst) answer();
    scheduler.pauseAdmission("process shutdown");
    scheduler.abortOwnedWork("process shutdown");
    if (!answerFirst) answer();
    assert.equal(await scheduler.waitForSettlement(500), true);
    await running;

    const pausedTask = runtime.restore().tasks[taskId];
    assert.equal(pausedTask.queueState, "active");
    assert.equal(pausedTask.resumedByQuestionSequence !== undefined, true);
    assert.deepEqual(pausedTask.attempts.map((attempt) => attempt.attemptId), ["immutable-attempt"]);

    const replayed = new DelegationRuntime(options);
    const restarted = new DurableDelegationScheduler({
      runtime: replayed, maxParallel: 1, createAttemptId: () => "must-not-create",
      execute: async (_task, control) => {
        assert.equal(control.attemptId, "immutable-attempt");
        const [delivery] = questions.prepareTaskAnswerDeliveries(taskId);
        questions.recordTaskAnswerDeliveryReceipt(delivery, { promptHash: "f".repeat(64), attemptId: control.attemptId, transcriptRef: `run:run-1/node:a/task:${taskId}/transcript` });
        questions.acceptTaskAnswerDelivery(delivery);
        return completed("resumed after restart");
      },
    });
    restarted.resume();
    await restarted.runUntilSettled();
    assert.equal(replayed.restore().tasks[taskId].result?.summary, "resumed after restart");
    assert.deepEqual(replayed.restore().tasks[taskId].attempts.map((attempt) => attempt.attemptId), ["immutable-attempt"]);
  }
});

test("cancellation settles interrupted queued work without claiming its stale attempt", async () => {
  const f = fixture();
  const scheduler = new DurableDelegationScheduler({
    runtime: f.runtime, maxParallel: 1, createAttemptId: f.createAttemptId,
    execute: async (task, control) => {
      if (!control.signal.aborted) await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve(), { once: true }));
      return completed(task.taskId);
    },
  });
  const running = scheduler.runUntilSettled();
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.pauseAdmission("process shutdown");
  scheduler.abortOwnedWork("process shutdown");
  assert.equal(await scheduler.waitForSettlement(100), true);
  await running;

  const interrupted = f.runtime.restore().tasks[f.ids.a1];
  assert.equal(interrupted.queueState, "queued");
  assert.equal(interrupted.attempts[0]?.interruptedSequence !== undefined, true);

  scheduler.closeAdmission("cancelled");
  scheduler.cancelPending("cancelled");
  const settled = f.runtime.restore();
  assert.equal(settled.tasks[f.ids.a1].result?.attemptId, undefined);
  assert.equal(settled.tasks[f.ids.a1].attempts[0]?.resultSequence, undefined);
  assert.equal(Object.values(settled.tasks).every((task) => task.queueState === "terminal"), true);
  assert.equal(Object.values(settled.tasks).every((task) => task.result?.status === "cancelled"), true);
});

test("hung abort is bounded and remains unsettled until the execution actually exits", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new DurableDelegationScheduler({
    runtime: f.runtime, maxParallel: 1, createAttemptId: f.createAttemptId,
    execute: async () => { await gate; return completed("late"); },
  });
  const running = scheduler.runUntilSettled();
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.closeAdmission("cancelled");
  scheduler.cancelPending("cancelled");
  scheduler.abortOwnedWork("cancelled");
  const started = Date.now();
  assert.equal(await scheduler.waitForSettlement(20), false);
  assert.ok(Date.now() - started < 500, "settlement wait must be bounded");
  assert.equal(scheduler.hasLiveHandles(), true);
  release();
  assert.equal(await scheduler.waitForSettlement(500), true);
  await running;
  assert.equal(scheduler.hasLiveHandles(), false);
});
