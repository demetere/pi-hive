import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { DelegationRuntime } from "../../src/workflows/delegation.ts";
import { RunOrchestrationService, type RunOrchestrationServiceOptions } from "../../src/workflows/orchestration.ts";
import { acquireRuntimeOwnership } from "../../src/workflows/ownership.ts";
import type { WorkerSessionFactory } from "../../src/workflows/workers.ts";

function snapshot(): ActivationSnapshotFileV1 {
  return { snapshotHash: "e".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", payload: {
    project: { projectId: "project-1", rootRef: "." },
    workflow: { id: "delivery", team: { rootId: "root", nodes: [
      { id: "root", agentId: "lead", memberIds: ["worker"], depth: 1, responsibilities: [] },
      { id: "worker", agentId: "builder", parentId: "root", memberIds: ["leaf"], depth: 2, role: "API builder", responsibilities: ["implementation"] },
      { id: "leaf", agentId: "database", parentId: "worker", memberIds: [], depth: 3, role: "Database reviewer", responsibilities: ["schema review"] },
    ] } },
    authority: { capabilityContractVersion: 1, nodes: [
      { nodeId: "root", capabilities: { effective: { shell: [] } }, tools: ["delegate_agent", "route_agent", "workflow_finish"], model: "root-model", thinking: "medium" },
      { nodeId: "worker", capabilities: { effective: { shell: ["inspect"] } }, tools: ["delegate_agent", "route_agent", "read"], model: "worker-model", thinking: "low" },
      { nodeId: "leaf", capabilities: { effective: { shell: ["inspect"] } }, tools: ["read"], model: "leaf-model", thinking: "low" },
    ] },
    agents: [
      { id: "lead", name: "Lead", tags: [], prompt: "lead" },
      { id: "builder", name: "Builder", tags: ["implementation"], prompt: "build" },
      { id: "database", name: "Database", tags: ["schema"], prompt: "review schema" },
    ],
    skills: [], knowledge: [], models: [
      { nodeId: "root", modelId: "root-model", thinking: "medium", staticTokens: 1, dynamicReserve: 1, contextWindow: 10 },
      { nodeId: "worker", modelId: "worker-model", thinking: "low", staticTokens: 1, dynamicReserve: 1, contextWindow: 10 },
      { nodeId: "leaf", modelId: "leaf-model", thinking: "low", staticTokens: 1, dynamicReserve: 1, contextWindow: 10 },
    ], sources: [], versions: {} as never,
  } } as unknown as ActivationSnapshotFileV1;
}

function fixture(factoryOverride?: WorkerSessionFactory, overrides: Partial<RunOrchestrationServiceOptions> = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-orchestration-"));
  const ownerNonce = "owner-1";
  const ownership = acquireRuntimeOwnership(projectRoot, "session-1", { nonce: ownerNonce });
  assert.equal(ownership.ok, true);
  let run = 0;
  let task = 0;
  let attempt = 0;
  const factory: WorkerSessionFactory = async (input) => ({
    linkedSessionId: `linked-${input.runId}-${input.nodeId}`,
    async prompt(text) { return `durable result:${text.includes("Objective")}`; },
    async abort() {},
    dispose() {},
  });
  const options: RunOrchestrationServiceOptions = {
    projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: snapshot(), runtimeOwnerNonce: ownerNonce,
    maxParallel: 1, workerFactory: factoryOverride ?? factory,
    createRunId: () => `run-${++run}`, createTaskId: () => `task-${++task}`, createAttemptId: () => `attempt-${++attempt}`,
    pauseAuthority: { captureState: () => ({ digest: "pause" }), releaseLeases: () => {}, releaseOwnership: () => {} },
    resumeAuthority: { acquireOwnership: () => {}, acquireLeases: () => {}, revalidateHashes: () => true, rollbackAuthority: () => {} },
    cancellationAuthority: { terminateProcessTrees: () => {}, capturePartialState: () => ({}), releaseLeases: () => {} },
    ...overrides,
  };
  const service = new RunOrchestrationService(options);
  return { projectRoot, service, options };
}

function deliverInitial(service: RunOrchestrationService, inputId: string) {
  const recorded = service.lifecycle.recordUserInput({ inputId, text: inputId, source: "interactive" });
  const delivery = service.lifecycle.prepareInputDelivery(`input-delivery-${inputId}`);
  service.lifecycle.confirmInputDelivery(delivery.requestId);
  return recorded.runId;
}

test("run orchestration integrates descendants, route/delegate, durable delivery, and sequential runs", async () => {
  const { service } = fixture();
  const run1 = deliverInitial(service, "first");
  assert.equal(run1, "run-1");
  const root = service.rootServices();
  assert.equal(root.route({ objective: "API implementation", includeUnmatched: true })[0].nodeId, "worker");
  const delegated = root.delegate({ targetNodeId: "worker", objective: "Implement API", deliverables: ["patch"] });

  const blocked = await service.lifecycle.finish({ status: "completed", summary: "too early" }, { callerNodeId: "root", toolBatch: ["workflow_finish"] });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.issues.join(" "), /descendants/i);

  await service.runWorkers();
  const stillBlocked = await service.lifecycle.finish({ status: "completed", summary: "not delivered" }, { callerNodeId: "root", toolBatch: ["workflow_finish"] });
  assert.equal(stillBlocked.ok, false);
  const prepared = root.prepareResultDelivery("root-result-delivery");
  assert.equal(prepared.items[0].taskId, delegated.taskId);
  root.acceptResultDelivery(prepared.deliveryId);
  const finished = await service.lifecycle.finish({ status: "completed", summary: "run one complete" }, { callerNodeId: "root", toolBatch: ["workflow_finish"] });
  assert.equal(finished.ok, true);
  assert.equal(service.hasLiveHandles(), false, "terminal finish must dispose worker sessions immediately");
  assert.equal(service.delegationState().schedulerStatus, "closed");
  assert.throws(() => root.route({ objective: "post-terminal routing", includeUnmatched: true }), /terminal|closed|stale|current run/i);
  assert.throws(() => root.delegate({ targetNodeId: "worker", objective: "post-terminal", deliverables: [] }), /terminal|closed|stale|current run/i);
  assert.throws(() => root.status(), /terminal|closed|stale|current run/i);

  const run2 = deliverInitial(service, "second");
  assert.equal(run2, "run-2");
  const secondRoot = service.rootServices();
  assert.throws(() => root.delegate({ targetNodeId: "worker", objective: "stale run spoof", deliverables: [] }), /current run|stale/i);
  secondRoot.delegate({ targetNodeId: "worker", objective: "Second run task", deliverables: [] });
  await service.runWorkers();
  const secondPrepared = secondRoot.prepareResultDelivery("run-2-results");
  secondRoot.acceptResultDelivery(secondPrepared.deliveryId);
  assert.equal(service.delegationState().runId, "run-2");
  assert.deepEqual(Object.values(service.delegationState().tasks).map((task) => task.runId), ["run-2"]);
  await service.shutdown("session shutdown");
  assert.equal(service.hasLiveHandles(), false);
});

test("maxParallel one recursively delegates through worker tool context and resumes the same attempt after durable delivery", async () => {
  const executionOrder: string[] = [];
  let parentPrompts = 0;
  let deliveredChildResult = false;
  const factory: WorkerSessionFactory = async (input) => ({
    linkedSessionId: `linked-${input.nodeId}`,
    async prompt(text, _signal, invocation) {
      executionOrder.push(input.nodeId);
      assert.ok(invocation, "worker prompt invocation context is required");
      if (input.nodeId === "leaf") return "leaf durable result";
      if (parentPrompts++ === 0) {
        const delegation = invocation.delegation;
        assert.ok(delegation, "worker delegation context is required");
        const recommendation = delegation.route({ objective: "schema review", includeUnmatched: true });
        assert.equal(recommendation[0].nodeId, "leaf");
        delegation.delegate({ targetNodeId: "leaf", objective: "Review schema", deliverables: ["findings"] });
        return "yield after recursive delegation";
      }
      deliveredChildResult = text.includes("leaf durable result");
      return "parent synthesis";
    },
    dispose() {},
  });
  const { service } = fixture(factory);
  deliverInitial(service, "nested");
  const parentId = service.rootServices().delegate({ targetNodeId: "worker", objective: "Coordinate review", deliverables: ["synthesis"] }).taskId;

  await service.runWorkers();

  const state = service.delegationState();
  const parent = state.tasks[parentId];
  const child = Object.values(state.tasks).find((task) => task.provenance.parentTaskId === parentId);
  assert.ok(child);
  assert.deepEqual(executionOrder, ["worker", "leaf", "worker"]);
  assert.equal(deliveredChildResult, true);
  assert.equal(parent.attempts.length, 1, "recursive continuation must preserve the parent attempt");
  assert.equal(parent.result?.status, "completed");
  assert.equal(child.resultAcceptedSequence !== undefined, true);
});

test("terminal preparation crash restores fail-closed admission and cancels a raced queued descendant before commit", async () => {
  let injected = false;
  const { service, options } = fixture(undefined, {
    journalFault: (eventType, stage) => {
      if (!injected && eventType === "run.terminal.prepared" && stage === "afterRename") {
        injected = true;
        throw new Error("simulated crash after terminal preparation publication");
      }
    },
  });
  const runId = deliverInitial(service, "terminal-crash");
  const root = service.rootServices();

  const interrupted = await service.lifecycle.finish(
    { status: "completed", summary: "terminal crash replay" },
    { callerNodeId: "root", toolBatch: ["workflow_finish"] },
  );
  assert.equal(interrupted.ok, false);
  assert.equal(service.lifecycle.restore().latestRun?.pendingTerminal !== undefined, true);

  const racer = new DelegationRuntime({
    projectRoot: options.projectRoot,
    projectId: options.projectId,
    sessionId: options.sessionId,
    runId,
    snapshot: options.snapshot,
    createTaskId: () => "raced-task",
  });
  racer.accept(racer.rootExecutionContext(), { targetNodeId: "worker", objective: "raced after terminal preparation", deliverables: [] });
  assert.equal(racer.restore().tasks["raced-task"].queueState, "queued");
  assert.throws(() => root.delegate({ targetNodeId: "worker", objective: "rejected after terminal preparation", deliverables: [] }), /terminal|finalizing|closed/i);
  assert.equal(racer.restore().admissionOpen, false, "cached root services must immediately close durable admission");
  assert.equal(racer.restore().tasks["raced-task"].result?.status, "cancelled");

  const restarted = new RunOrchestrationService({ ...options, journalFault: undefined });
  const restored = restarted.delegationState();
  assert.equal(restored.admissionOpen, false, "pending terminal restore must durably fail closed");
  assert.equal(restored.schedulerStatus, "closed");
  assert.equal(restored.tasks["raced-task"].result?.status, "cancelled", "raced queued work must settle before terminal commit");
  assert.throws(() => restarted.rootServices(), /terminal|finalizing|closed|current open/i);

  const replayed = await restarted.lifecycle.finish(
    { status: "completed", summary: "terminal crash replay" },
    { callerNodeId: "root", toolBatch: ["workflow_finish"] },
  );
  assert.equal(replayed.ok, true, replayed.ok ? "" : replayed.issues.join(" "));
  assert.equal(Object.values(restarted.delegationState().tasks).every((task) => task.queueState === "terminal"), true);
  assert.equal(restarted.hasLiveHandles(), false);
});

test("integrated pause, resume, and shutdown settle and rebuild run-scoped resources", async () => {
  const { service } = fixture();
  deliverInitial(service, "pause-me");
  service.rootServices().delegate({ targetNodeId: "worker", objective: "resume task", deliverables: [] });
  assert.equal(await service.pause("native navigation"), true);
  assert.equal(service.delegationState().schedulerStatus, "paused");
  assert.equal(service.hasLiveHandles(), false);
  assert.equal(await service.resume(), true);
  assert.equal(service.delegationState().schedulerStatus, "running");
  await service.runWorkers();
  const root = service.rootServices();
  const prepared = root.prepareResultDelivery("pause-result-delivery");
  root.acceptResultDelivery(prepared.deliveryId);
  await service.shutdown();
  assert.equal(service.hasLiveHandles(), false);
});

test("integrated cancellation settles scheduler and worker sessions through W11 semantics", async () => {
  const { service } = fixture();
  deliverInitial(service, "cancel-me");
  service.rootServices().delegate({ targetNodeId: "worker", objective: "cancel task", deliverables: [] });
  const result = await service.cancel("user cancelled");
  assert.equal(result.envelope.status, "cancelled");
  assert.equal(Object.values(service.delegationState().tasks).every((task) => task.result?.status === "cancelled"), true);
  assert.equal(service.hasLiveHandles(), false);
});
