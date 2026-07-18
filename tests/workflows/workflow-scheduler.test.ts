import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { DelegationRuntime, type WorkerResultInput } from "../../src/workflows/delegation.ts";
import { DurableDelegationScheduler } from "../../src/workflows/scheduler.ts";

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
