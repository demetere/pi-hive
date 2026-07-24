import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { DelegationRuntime } from "../../src/workflows/delegation.ts";
import { RunOrchestrationService, type RunOrchestrationServiceOptions } from "../../src/workflows/orchestration.ts";
import { acquireRuntimeOwnership } from "../../src/workflows/ownership.ts";
import { WorkflowRunLifecycle } from "../../src/workflows/runs.ts";
import { QuestionService } from "../../src/workflows/questions.ts";
import { appendWorkflowEvent, readWorkflowJournal } from "../../src/workflows/journal.ts";
import { createWorkflowEvent } from "../../src/workflows/events.ts";
import { hashAttemptInput } from "../../src/workflows/attempts.ts";
import type { WorkerSessionFactory } from "../../src/workflows/workers.ts";
import type { EffectiveRuntimeBudgetLimits } from "../../src/workflows/budgets.ts";
import { analyzeCommand } from "../../src/capabilities/command.ts";

function snapshot(): ActivationSnapshotFileV1 {
  return { snapshotHash: "e".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", payload: {
    project: { projectId: "project-1", rootRef: "." },
    workflow: { id: "delivery", team: { rootId: "root", nodes: [
      { id: "root", agentId: "lead", memberIds: ["worker"], depth: 1, responsibilities: [] },
      { id: "worker", agentId: "builder", parentId: "root", memberIds: ["leaf"], depth: 2, role: "API builder", responsibilities: ["implementation"] },
      { id: "leaf", agentId: "database", parentId: "worker", memberIds: [], depth: 3, role: "Database reviewer", responsibilities: ["schema review"] },
    ] } },
    authority: { capabilityContractVersion: 1, nodes: [
      { nodeId: "root", capabilities: { effective: { shell: [] } }, tools: ["delegate_agent", "route_agent", "workflow_status", "workflow_finish"], model: "root-model", thinking: "medium" },
      { nodeId: "worker", capabilities: { effective: { shell: ["inspect", "mutate"] } }, tools: ["delegate_agent", "route_agent", "read", "write", "bash"], model: "worker-model", thinking: "low" },
      { nodeId: "leaf", capabilities: { effective: { shell: ["inspect"] } }, tools: ["read"], model: "leaf-model", thinking: "low" },
    ] },
    agents: [
      { id: "lead", name: "Lead", tags: [], prompt: "lead" },
      { id: "builder", name: "Builder", tags: ["implementation"], prompt: "build" },
      { id: "database", name: "Database", tags: ["schema"], prompt: "review schema" },
    ],
    skills: [], knowledge: [], models: [
      { nodeId: "root", modelId: "root-model", thinking: "medium", staticTokens: 1, dynamicReserve: 1, contextWindow: 100_000 },
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

function seedCuratorJob(projectRoot: string): void {
  const evidence = appendWorkflowEvent(projectRoot, createWorkflowEvent({
    eventId: "curator-provider-evidence", projectId: "project-1", sessionId: "session-1", runId: "curator-run", type: "artifact.recorded", producer: "harness",
    payload: { formatVersion: 1, nodeId: "root", sourceHashes: [`sha256:${"a".repeat(64)}`] },
  }));
  const conclusion = "A stable candidate exists for provider limit dispatch.";
  const candidate = { formatVersion: 1, candidateId: "curator-provider-candidate", projectId: "project-1", sessionId: "session-1", runId: "curator-run", nodeId: "root", agentId: "lead", scope: "shared", conclusion,
    requestHash: hashAttemptInput({ scope: "shared", conclusion, evidenceEventIds: [evidence.eventId] }), citations: [{ eventId: evidence.eventId, eventHash: evidence.eventHash, payloadHash: evidence.payloadHash, sequence: evidence.sequence, type: evidence.type }],
    sourceHashes: [`sha256:${"a".repeat(64)}`], createdAt: "2026-01-01T00:00:00.000Z" };
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "curator-run", type: "knowledge.transition", producer: "runtime", correlationId: "curator-provider-attempt", attemptId: "curator-provider-attempt",
    payload: { formatVersion: 1, operation: "candidate-recorded", candidate } as never,
  }));
  const terminal = appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "curator-run", type: "terminal.recorded", producer: "harness", payload: { formatVersion: 1, status: "completed" },
  }));
  const job = { formatVersion: 1, jobId: "curator-provider-job", projectId: "project-1", sessionId: "session-1", runId: "curator-run", terminalEventHash: terminal.eventHash, scope: "shared", candidateIds: [candidate.candidateId],
    targets: [{ bundleId: "provider-target", providerId: "okf", path: ".pi/hive/knowledge/provider-target", policy: "automatic", expectedContentHash: `sha256:${"b".repeat(64)}` }],
    model: { nodeId: "root", modelId: "root-model", thinking: "medium", reason: "agent-lowest-participating-node;shared-workflow-root" }, state: "queued", attemptCount: 0, staleReevaluations: 0,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "curator-run", type: "knowledge.transition", producer: "harness",
    payload: { formatVersion: 1, operation: "jobs-enqueued", terminalEventHash: terminal.eventHash, preservedCancelled: false, jobs: [job] } as never,
  }));
}

test("root model and pause/resume boundaries preserve exact immutable compaction markers", async () => {
  const { service } = fixture();
  deliverInitial(service, "first");
  const root = service.rootServices();
  let preservation = "";
  const response = await root.dispatch.model({
    correlationId: "root-compaction-valid", operation: "root.prompt", input: {},
    installCompactionBoundary(boundary) { preservation = boundary.preservation; },
    dispatch: () => ({ output: "ok", compactionSummary: preservation }),
  });
  assert.equal(typeof response === "string" ? response : response.output, "ok");
  assert.match(preservation, /run_id=run-1/);
  assert.equal(await service.pause("switch"), true);
  assert.equal(await service.resume(), true);
});

test("production knowledge takeover bridge binds death proof to the persisted owner nonce", async () => {
  let provedNonce: string | undefined;
  const { service } = fixture(undefined, { verifiedTakeover: async (ownerNonce) => { provedNonce = ownerNonce; return ownerNonce === "persisted-owner"; } });
  const verified = await (service as any).knowledgeQueue.options.verifyOwnerDead("persisted-owner");
  assert.equal(verified, true);
  assert.equal(provedNonce, "persisted-owner");
  await service.shutdown();
});

test("production terminal reconciliation starts on a later macrotask and never delays the awaited terminal return", async () => {
  const { service } = fixture();
  await new Promise((resolve) => setImmediate(resolve));
  deliverInitial(service, "terminal-macrotask");
  let reconciliationDone = false;
  (service as any).reconcileTerminalEnrichment = () => {
    const until = Date.now() + 150;
    while (Date.now() < until) { /* simulate synchronous journal/provider consolidation */ }
    reconciliationDone = true;
  };
  const before = Date.now();
  const finished = await service.lifecycle.finish({ status: "completed", summary: "terminal is already durable" }, { callerNodeId: "root", toolBatch: ["workflow_finish"] });
  assert.equal(finished.ok, true);
  const elapsed = Date.now() - before;
  assert.equal(reconciliationDone, false, `heavy reconciliation ran before terminal return (${elapsed}ms)`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reconciliationDone, true);
  await service.shutdown();
});

test("active knowledge reconciliation remains live-accounted across bounded shutdown until safe settlement", async () => {
  const { service } = fixture();
  await new Promise((resolve) => setImmediate(resolve));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  (service as any).reconcileTerminalEnrichment = async () => hold;
  const reconciliation = (service as any).executeKnowledgeReconciliation() as Promise<void>;
  assert.equal(service.hasLiveHandles(), true);
  const before = Date.now();
  await service.shutdown();
  assert.ok(Date.now() - before < 500, "shutdown stays bounded while reconciliation remains honestly live-accounted");
  assert.equal(service.hasLiveHandles(), true, "effect-capable reconciliation cannot disappear from lifecycle accounting");
  release();
  await reconciliation;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.hasLiveHandles(), false);
});

test("production curator dispatch carries exact provider token caps through factory and prompt and fails closed when unsupported", async () => {
  let factoryLimits: unknown;
  let promptLimits: unknown;
  const supported: WorkerSessionFactory = async (input) => {
    factoryLimits = (input as any).providerTokenLimits;
    return {
      linkedSessionId: "limited-curator",
      enforcedTokenLimits: (input as any).providerTokenLimits,
      async prompt(_text: string, _signal?: AbortSignal, _invocation?: unknown, options?: unknown) {
        promptLimits = (options as any)?.providerTokenLimits;
        return { output: JSON.stringify({ formatVersion: 1, conclusions: [] }), usage: { inputTokens: 4, outputTokens: 4, costMicroUsd: 1, precision: "provider-confirmed" } };
      },
      dispose() {},
    } as any;
  };
  const first = fixture(supported);
  (first.options.snapshot.payload.models[0] as any).staticTokens = 8_192;
  (first.options.snapshot.payload.models[0] as any).contextWindow = 49_152;
  seedCuratorJob(first.projectRoot);
  const request = { jobId: "curator-provider-job", modelId: "root-model", thinking: "medium", prompt: "bounded curator prompt", maxInputTokens: 32_768, maxOutputTokens: 8_192, timeoutMs: 120_000, evaluation: 0, signal: new AbortController().signal };
  await (first.service as any).runCuratorModel(request);
  assert.deepEqual(factoryLimits, { maxInputTokens: 32_768, maxOutputTokens: 8_192 });
  assert.deepEqual(promptLimits, factoryLimits);

  let shortFactoryCalls = 0;
  const short = fixture(async (input) => {
    shortFactoryCalls++;
    return { linkedSessionId: "short-context-curator", enforcedTokenLimits: input.providerTokenLimits, prompt: async () => "must not dispatch", dispose() {} } as any;
  });
  (short.options.snapshot.payload.models[0] as any).staticTokens = 8_192;
  (short.options.snapshot.payload.models[0] as any).contextWindow = 49_151;
  seedCuratorJob(short.projectRoot);
  await assert.rejects(() => (short.service as any).runCuratorModel(request), /curator|context|static|input|output/i);
  assert.equal(shortFactoryCalls, 0);

  let unsupportedPromptCalls = 0;
  const unsupported = fixture(async () => ({ linkedSessionId: "unsupported-curator", prompt: async () => { unsupportedPromptCalls++; return "must not dispatch"; }, dispose() {} }));
  seedCuratorJob(unsupported.projectRoot);
  await assert.rejects(() => (unsupported.service as any).runCuratorModel(request), /token limit|provider.*cap|unsupported/i);
  assert.equal(unsupportedPromptCalls, 0);
});

test("production curator conservatively rejects an input that cannot fit before provider construction", async () => {
  let factoryCalls = 0;
  const { projectRoot, service } = fixture(async () => { factoryCalls++; return { linkedSessionId: "oversized-curator", enforcedTokenLimits: { maxInputTokens: 32_768, maxOutputTokens: 8_192 }, prompt: async () => "must not dispatch", dispose() {} } as any; });
  seedCuratorJob(projectRoot);
  await assert.rejects(() => (service as any).runCuratorModel({ jobId: "curator-provider-job", modelId: "root-model", thinking: "medium", prompt: "x".repeat(32_769), maxInputTokens: 32_768, maxOutputTokens: 8_192, timeoutMs: 120_000, evaluation: 0, signal: new AbortController().signal }), /input|fit|token|bound/i);
  assert.equal(factoryCalls, 0);
});

test("provider-confirmed usage cannot omit cost and be converted to confirmed zero", async () => {
  const { service } = fixture();
  deliverInitial(service, "missing-provider-cost");
  await service.rootServices().dispatch.model({
    correlationId: "missing-provider-cost", operation: "root.prompt", input: {},
    dispatch: () => ({ output: "provider omitted cost", usage: { inputTokens: 10, outputTokens: 4, precision: "provider-confirmed" } as any }),
  });
  const state = service.budgetState() as any;
  assert.equal(state.run.providerConfirmedTokens, 0);
  assert.ok(state.run.estimatedTokens >= 14, "missing cost downgrades the whole usage claim to explicit conservative estimated semantics");
  await service.shutdown();
});

test("failed terminal reconciliation retries durably without another user wake", async () => {
  const { service } = fixture();
  await new Promise((resolve) => setImmediate(resolve));
  deliverInitial(service, "terminal-retry");
  const original = (service as any).reconcileTerminalEnrichment.bind(service);
  let calls = 0;
  (service as any).reconcileTerminalEnrichment = async (...args: unknown[]) => {
    calls++;
    if (calls === 1) throw new Error("transient reconciliation fault");
    return original(...args);
  };
  const finished = await service.lifecycle.finish({ status: "completed", summary: "retry terminal reconciliation" }, { callerNodeId: "root", toolBatch: ["workflow_finish"] });
  assert.equal(finished.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.ok(calls >= 2);
  await service.shutdown();
});

test("run orchestration integrates descendants, route/delegate, durable delivery, and sequential runs", async () => {
  const { service } = fixture();
  assert.equal((await service.lifecycle.failBudgetExhaustion("no run")).ok, false);
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
  assert.equal((await service.lifecycle.failBudgetExhaustion("too late")).ok, false);
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
  assert.ok(child, JSON.stringify(state));
  assert.deepEqual(executionOrder, ["worker", "leaf", "worker"]);
  assert.equal(deliveredChildResult, true);
  assert.equal(parent.attempts.length, 1, "recursive continuation must preserve the parent attempt");
  assert.equal(parent.result?.status, "completed");
  assert.equal(child.resultAcceptedSequence !== undefined, true);
});

test("W13 run orchestration enforces delegation/worker budgets and derives terminal changes", async () => {
  const budgetLimits: EffectiveRuntimeBudgetLimits = {
    run: { maxParallel: 1, maxDelegations: 3, maxToolCalls: 10, tokenBudget: 100, activeWallTimeMs: 10_000 },
    nodes: {
      root: { maxAgentTurns: 3, maxToolCalls: 10, tokenBudget: 100, activeWallTimeMs: 10_000 },
      worker: { maxAgentTurns: 1, maxToolCalls: 5, tokenBudget: 20, activeWallTimeMs: 10_000 },
      leaf: { maxAgentTurns: 1, maxToolCalls: 5, tokenBudget: 20, activeWallTimeMs: 10_000 },
    },
  };
  const budgetedFactory: WorkerSessionFactory = async (input) => ({
    linkedSessionId: `linked-${input.nodeId}`,
    async prompt() { return { output: "budgeted result", usage: { inputTokens: 3, outputTokens: 2, costMicroUsd: 0, precision: "provider-confirmed" as const } }; },
    dispose() {},
  });
  const { service, projectRoot } = fixture(budgetedFactory, { budgetLimits });
  deliverInitial(service, "budgeted");
  writeFileSync(join(projectRoot, "harness-observed.txt"), "changed during run\n");
  const root = service.rootServices();
  const first = root.delegate({ targetNodeId: "worker", objective: "first", deliverables: [] });
  const second = root.delegate({ targetNodeId: "worker", objective: "second", deliverables: [] });
  await service.runWorkers();
  assert.equal(service.delegationState().tasks[first.taskId].result?.status, "completed");
  assert.equal(service.delegationState().tasks[second.taskId].result?.status, "blocked");
  assert.equal(service.budgetState().nodes.worker.turns, 1);
  assert.equal(service.budgetState().nodes.worker.tokens, 5);
  assert.equal(service.lifecycle.restore().latestRun?.status, "running", "node exhaustion must not settle the run");
  assert.equal(service.delegationState().admissionOpen, true);
  const delivery = root.prepareResultDelivery("budget-results");
  root.acceptResultDelivery(delivery.deliveryId);
  const finished = await service.lifecycle.finish({ status: "completed", summary: "budgeted run done" }, { callerNodeId: "root", toolBatch: ["workflow_finish"] });
  assert.equal(finished.ok, true, finished.ok ? "" : finished.issues.join(" "));
  if (finished.ok) {
    assert.equal(finished.envelope.fileChanges.some((change) => change.path === "harness-observed.txt"), true);
    assert.equal(finished.envelope.changeCoverage, "scoped-reconciled");
  }
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
  assert.equal((await service.lifecycle.failBudgetExhaustion("conflicts with prepared completion")).ok, false);

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

test("unknown side-effect recovery pauses the integrated run without redispatch", async () => {
  const { service } = fixture();
  deliverInitial(service, "unknown-effect");
  service.attemptRuntime().begin({
    attemptId: "shell-crash", correlationId: "shell", nodeId: "root", operation: "bash",
    input: { commandHash: "abc" }, descriptor: { effect: "shell", readOnly: false, idempotent: false },
  });
  let redispatched = 0;
  const report = await service.recoverSideEffects({ redispatch: async () => { redispatched++; } });
  assert.equal(report.paused, true);
  assert.equal(redispatched, 0);
  assert.equal(service.lifecycle.restore().latestRun?.status, "paused");
  assert.equal(service.attemptRuntime().restore().attempts["shell-crash"].status, "unknown_side_effect");
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

test("budget fatal settlement refuses a run whose cancellation is already authoritative", async () => {
  const { service } = fixture();
  deliverInitial(service, "cancelling-budget-refusal");
  service.lifecycle.requestCancellation("cancel first");
  assert.equal((await service.lifecycle.failBudgetExhaustion("late budget signal")).ok, false);
  const cancelled = await service.cancel("cancel first");
  assert.equal(cancelled.envelope.status, "cancelled");
});

test("integrated cancellation settles scheduler and worker sessions through W11 semantics", async () => {
  const { service } = fixture();
  deliverInitial(service, "cancel-me");
  writeFileSync(join(service.lifecycle.options.projectRoot, "partial-on-cancel.txt"), "partial\n");
  service.rootServices().delegate({ targetNodeId: "worker", objective: "cancel task", deliverables: [] });
  const result = await service.cancel("user cancelled");
  assert.equal(result.envelope.status, "cancelled");
  assert.equal(result.envelope.fileChanges.some((change) => change.path === "partial-on-cancel.txt"), true);
  assert.equal(result.envelope.changeCoverage, "scoped-reconciled");
  assert.equal(Object.values(service.delegationState().tasks).every((task) => task.result?.status === "cancelled"), true);
  assert.equal(service.hasLiveHandles(), false);
});

test("trusted worker dispatch wraps model retries and tool attempts with attempts, budgets, denials, and estimated usage", async () => {
  let modelCalls = 0;
  let deniedDispatches = 0;
  const factory: WorkerSessionFactory = async () => ({
    linkedSessionId: "trusted-worker",
    async prompt(_text, _signal, invocation) {
      modelCalls++;
      if (modelCalls === 1) throw Object.assign(new Error("temporary provider failure"), { transient: true, assistantOutputObserved: false, toolCallObserved: false });
      const trustedDispatch = invocation?.dispatch;
      assert.ok(trustedDispatch, "trusted tool dispatch must be injected into worker invocation");
      const value = await trustedDispatch.tool({
        correlationId: "worker-read", toolName: "read", operation: "read", input: { path: "README.md" }, policyOutcome: "allowed",
        dispatch: async () => ({ text: "read result" }),
      });
      assert.deepEqual(value, { text: "read result" });
      await assert.rejects(() => trustedDispatch.tool({
        correlationId: "worker-denied", toolName: "write", operation: "write", input: { path: "x" }, policyOutcome: "denied", denialReason: "policy denied",
        dispatch: async () => { deniedDispatches++; return "must not run"; },
      }), /policy denied/i);
      return "worker output without provider usage";
    },
    dispose() {},
  });
  const budgetLimits: EffectiveRuntimeBudgetLimits = {
    run: { maxParallel: 1, maxDelegations: 2, maxToolCalls: 10, tokenBudget: 10_000, activeWallTimeMs: 10_000 },
    nodes: {
      root: { maxAgentTurns: 4, maxToolCalls: 10, tokenBudget: 10_000, activeWallTimeMs: 10_000 },
      worker: { maxAgentTurns: 4, maxToolCalls: 5, tokenBudget: 10_000, activeWallTimeMs: 10_000 },
      leaf: { maxAgentTurns: 2, maxToolCalls: 5, tokenBudget: 10_000, activeWallTimeMs: 10_000 },
    },
  };
  const { service } = fixture(factory, { budgetLimits });
  deliverInitial(service, "trusted-dispatch");
  service.rootServices().delegate({ targetNodeId: "worker", objective: "exercise dispatch", deliverables: [] });
  await service.runWorkers();

  const budget = service.budgetState();
  assert.equal(modelCalls, 2);
  assert.equal(deniedDispatches, 0);
  assert.equal(budget.nodes.worker.turns, 2, "every provider retry counts as a turn");
  assert.equal(budget.nodes.worker.toolCalls, 2, `allowed and policy-denied tools both count: ${JSON.stringify(service.delegationState())}`);
  assert.ok(budget.nodes.worker.estimatedTokens > 0, "missing provider usage gets a conservative estimate");
  const attempts = Object.values(service.attemptRuntime().restore().attempts);
  assert.equal(attempts.filter((attempt) => attempt.descriptor.effect === "model").length, 2);
  assert.equal(attempts.some((attempt) => attempt.result?.policyDenied), true);
});

test("schema-v1 worker dispatch threads the authoritative direct mutation attempt and recorder", async () => {
  let observedAttemptId = "";
  const factory: WorkerSessionFactory = async () => ({
    linkedSessionId: "direct-mutation-worker",
    async prompt(_text, _signal, invocation) {
      assert.equal(invocation?.schemaVersion, 1);
      assert.equal(invocation?.dispatch?.schemaVersion, 1);
      const dispatch = invocation?.dispatch;
      assert.ok(dispatch);
      await dispatch.tool({
        correlationId: "direct-write", toolName: "write", operation: "write", input: { path: "direct.txt" }, policyOutcome: "allowed",
        dispatch: async (context) => {
          assert.equal(context.schemaVersion, 1);
          assert.ok(context.mutationAccounting);
          assert.equal(context.mutationAccounting.attemptId, context.attemptId);
          observedAttemptId = context.attemptId;
          const intent = context.mutationAccounting.recorder.begin(context.attemptId, "direct.txt");
          writeFileSync(join(service.lifecycle.options.projectRoot, "direct.txt"), "direct mutation\n");
          context.mutationAccounting.recorder.complete(intent);
        },
      });
      return "direct mutation complete";
    },
    dispose() {},
  });
  const { service } = fixture(factory);
  deliverInitial(service, "direct-mutation-accounting");
  service.rootServices().delegate({ targetNodeId: "worker", objective: "write directly", deliverables: [] });
  await service.runWorkers();
  assert.match(observedAttemptId, /^attempt-/);
  assert.equal(service.changeAccounting().restore().mutations.some((mutation) => mutation.attemptId === observedAttemptId), true);
  assert.equal(service.changeAccounting().reconcile().fileChanges.find((change) => change.path === "direct.txt")?.attribution, "recorded");
});

test("successful mutating bash dispatch durably completes its command and path intents", async () => {
  let commandAttemptId = "";
  const factory: WorkerSessionFactory = async () => ({
    linkedSessionId: "mutating-bash-worker",
    async prompt(_text, _signal, invocation) {
      const dispatch = invocation?.dispatch;
      assert.ok(dispatch);
      const result = await dispatch.tool({
        correlationId: "successful-bash", toolName: "bash", operation: "bash", input: { command: "touch command-created.txt" },
        commandMetadata: analyzeCommand("touch command-created.txt"), policyOutcome: "allowed",
        dispatch: async (context) => {
          commandAttemptId = context.attemptId;
          writeFileSync(join(service.lifecycle.options.projectRoot, "command-created.txt"), "created by command\n");
          return "created";
        },
      });
      assert.equal(result, "created");
      return "command complete";
    },
    dispose() {},
  });
  const { service } = fixture(factory);
  deliverInitial(service, "successful-mutating-bash");
  const task = service.rootServices().delegate({ targetNodeId: "worker", objective: "run mutating command", deliverables: [] });
  await service.runWorkers();

  const changes = service.changeAccounting().restore();
  assert.equal(service.delegationState().tasks[task.taskId].result?.status, "completed");
  assert.equal(changes.commandAttempts[commandAttemptId]?.status, "completed");
  assert.equal(changes.mutations.some((mutation) => mutation.attemptId === `${commandAttemptId}-effect-1`), true);
  assert.equal(service.changeAccounting().reconcile().fileChanges.find((change) => change.path === "command-created.txt")?.attribution, "recorded");
});

test("successful mutating bash accounting completes before an unrelated unknown effect pauses admission", async () => {
  let commandAttemptId = "";
  const factory: WorkerSessionFactory = async () => ({
    linkedSessionId: "mutating-bash-unknown-worker",
    async prompt(_text, _signal, invocation) {
      const dispatch = invocation?.dispatch;
      assert.ok(dispatch);
      await assert.rejects(() => dispatch.tool({
        correlationId: "bash-before-unrelated-unknown", toolName: "bash", operation: "bash", input: { command: "touch before-unknown.txt" },
        commandMetadata: analyzeCommand("touch before-unknown.txt"), policyOutcome: "allowed",
        dispatch: async (context) => {
          commandAttemptId = context.attemptId;
          writeFileSync(join(service.lifecycle.options.projectRoot, "before-unknown.txt"), "durable mutation\n");
          service.attemptRuntime().begin({
            attemptId: "unrelated-external-effect", correlationId: "unrelated-effect", nodeId: "worker", operation: "external.post", input: {},
            descriptor: { effect: "external", readOnly: false, idempotent: false },
          });
          return "command itself succeeded";
        },
      }), /unresolved|unknown.side.effect|recovery/i);
      return "must not complete while recovery is unresolved";
    },
    abort() {},
    dispose() {},
  });
  const { service } = fixture(factory);
  deliverInitial(service, "successful-bash-before-unknown");
  service.rootServices().delegate({ targetNodeId: "worker", objective: "account then pause", deliverables: [] });
  await assert.rejects(() => service.runWorkers(), /unknown side effects|recovery/i);

  const changes = service.changeAccounting().restore();
  assert.equal(changes.commandAttempts[commandAttemptId]?.status, "completed");
  assert.equal(changes.mutations.some((mutation) => mutation.attemptId === `${commandAttemptId}-effect-1`), true);
  assert.equal(service.attemptRuntime().restore().attempts["unrelated-external-effect"].result, undefined);
  assert.equal(service.lifecycle.restore().latestRun?.status, "paused");
});

test("unknown effect inside a worker prompt aborts that prompt and pauses before the next queued task", async () => {
  let prompts = 0;
  let postUnknownDispatches = 0;
  const factory: WorkerSessionFactory = async () => ({
    linkedSessionId: "unknown-prompt-worker",
    async prompt(_text, _signal, invocation) {
      prompts++;
      const dispatch = invocation?.dispatch;
      assert.ok(dispatch);
      await assert.rejects(() => dispatch.tool({
        correlationId: "unknown-shell", toolName: "bash", operation: "bash", input: { command: "touch unknown.txt" },
        commandMetadata: analyzeCommand("touch unknown.txt"), policyOutcome: "allowed",
        dispatch: async () => { throw new Error("transport lost after shell dispatch"); },
      }), /transport lost|unknown|recovery/i);
      await assert.rejects(() => dispatch.tool({
        correlationId: "after-unknown", toolName: "read", operation: "read", input: { path: "README.md" }, policyOutcome: "allowed",
        dispatch: async () => { postUnknownDispatches++; return "must not run"; },
      }), /admission|recovery|running/i);
      return "must not be accepted";
    },
    abort() {},
    dispose() {},
  });
  const { service } = fixture(factory);
  deliverInitial(service, "unknown-mid-prompt");
  const root = service.rootServices();
  root.delegate({ targetNodeId: "worker", objective: "first", deliverables: [] });
  root.delegate({ targetNodeId: "worker", objective: "must not launch", deliverables: [] });
  await assert.rejects(() => service.runWorkers(), /unknown side effects|recovery/i);
  assert.equal(prompts, 1);
  assert.equal(postUnknownDispatches, 0);
  assert.equal(service.lifecycle.restore().latestRun?.status, "paused");
  assert.equal(service.delegationState().schedulerStatus, "paused");
  assert.equal(Object.values(service.delegationState().tasks).every((task) => task.queueState !== "terminal"), true);
});

test("root trusted dispatch uses the same budget/attempt boundary and preserves the finalization reserve", async () => {
  const { service } = fixture();
  deliverInitial(service, "root-dispatch");
  const root = service.rootServices();
  const model = await root.dispatch.model({ correlationId: "root-model", operation: "root.prompt", input: { prompt: "finish" }, finalization: true, dispatch: async () => ({ output: "done", usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 0, precision: "provider-confirmed" as const } }) });
  assert.equal(typeof model, "object");
  const status = await root.dispatch.tool({ correlationId: "root-finish-tool", toolName: "workflow_finish", operation: "finish", input: {}, finalization: true, policyOutcome: "allowed", dispatch: async () => "ok" });
  assert.equal(status, "ok");
  assert.equal(service.budgetState().nodes.root.turns, 1);
  assert.equal(service.budgetState().nodes.root.toolCalls, 1);
  assert.equal(Object.values(service.attemptRuntime().restore().attempts).length, 2);
});

test("trusted tool dispatch counts active wall time and closes the clock on failure", async () => {
  let nowMs = 100;
  const { service } = fixture(undefined, { nowMs: () => nowMs });
  deliverInitial(service, "tool-clock");
  const root = service.rootServices();
  assert.equal(await root.dispatch.tool({
    correlationId: "status-clock", toolName: "workflow_status", operation: "status", input: {}, policyOutcome: "allowed",
    dispatch: async () => { nowMs = 175; return undefined; },
  }), undefined);
  await assert.rejects(() => root.dispatch.tool({
    correlationId: "status-clock-failure", toolName: "workflow_status", operation: "status", input: {}, policyOutcome: "allowed",
    dispatch: async () => { nowMs = 225; throw Object.assign(new Error("read transport failed"), { transient: false, effectNotApplied: true }); },
  }), /transport failed/);
  const budget = service.budgetState();
  assert.equal(budget.nodes.root.activeWallTimeMs, 125);
  assert.equal(budget.activeBatches.length, 0);
});

test("root reserve exhaustion durably terminal-fails the run and replays budget_exhausted", async () => {
  const { service, options, projectRoot } = fixture();
  deliverInitial(service, "root-reserve-exhausted");
  writeFileSync(join(projectRoot, "budget-partial.txt"), "preserved\n");
  const root = service.rootServices();
  const queued = root.delegate({ targetNodeId: "worker", objective: "must settle on exhaustion", deliverables: [] });
  await root.dispatch.model({ correlationId: "root-finalization-once", operation: "root.finalize", input: {}, finalization: true, dispatch: async () => "done" });
  await assert.rejects(() => root.dispatch.model({ correlationId: "root-finalization-twice", operation: "root.finalize", input: {}, finalization: true, dispatch: async () => "must not run" }), /reserve|budget/i);
  const task = service.delegationState().tasks[queued.taskId];
  assert.equal(task.queueState, "terminal");
  assert.equal(task.result?.status, "cancelled");
  const exhausted = Object.values(service.attemptRuntime().restore().attempts).find((attempt) => attempt.correlationId === "root-finalization-twice");
  assert.equal(exhausted?.status, "failed");
  assert.match(exhausted?.result?.budgetExhausted?.join(" ") ?? "", /finalization.*reserve/i);
  const terminal = service.lifecycle.restore().latestRun?.terminal;
  assert.equal(terminal?.status, "failed");
  assert.equal(terminal?.data.failureCode, "budget_exhausted");
  assert.match(terminal?.summary ?? "", /budget_exhausted/);
  assert.equal(terminal?.fileChanges.some((change) => change.path === "budget-partial.txt"), true);
  const restarted = new RunOrchestrationService(options);
  const replay = await restarted.lifecycle.failBudgetExhaustion("replayed reserve exhaustion");
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.envelope.terminalEventHash, terminal?.terminalEventHash);
});

test("root finalization tool reserve exhaustion also terminal-fails exactly once", async () => {
  const budgetLimits: EffectiveRuntimeBudgetLimits = {
    run: { maxParallel: 1, maxDelegations: 2, maxToolCalls: 2, tokenBudget: 100, activeWallTimeMs: 10_000 },
    nodes: {
      root: { maxAgentTurns: 2, maxToolCalls: 2, tokenBudget: 100, activeWallTimeMs: 10_000 },
      worker: { maxAgentTurns: 2, maxToolCalls: 2, tokenBudget: 100, activeWallTimeMs: 10_000 },
      leaf: { maxAgentTurns: 2, maxToolCalls: 2, tokenBudget: 100, activeWallTimeMs: 10_000 },
    },
  };
  const { service } = fixture(undefined, { budgetLimits });
  deliverInitial(service, "tool-reserve-exhaustion");
  const root = service.rootServices();
  assert.equal(await root.dispatch.tool({ correlationId: "final-tool-once", toolName: "workflow_finish", operation: "finish", input: {}, finalization: true, policyOutcome: "allowed", dispatch: async () => "ok" }), "ok");
  await assert.rejects(() => root.dispatch.tool({ correlationId: "final-tool-twice", toolName: "workflow_finish", operation: "finish", input: {}, finalization: true, policyOutcome: "allowed", dispatch: async () => "must not run" }), /reserve|budget/i);
  const terminal = service.lifecycle.restore().latestRun?.terminal;
  assert.equal(terminal?.status, "failed");
  assert.equal(terminal?.data.failureCode, "budget_exhausted");
  assert.equal(Object.values(service.attemptRuntime().restore().attempts).filter((attempt) => attempt.result?.budgetExhausted).length, 1);
});

test("root finalization reserve remains usable after its bounded response crosses the ordinary token budget", async () => {
  const budgetLimits: EffectiveRuntimeBudgetLimits = {
    run: { maxParallel: 1, maxDelegations: 2, maxToolCalls: 2, tokenBudget: 5, activeWallTimeMs: 10_000 },
    nodes: {
      root: { maxAgentTurns: 2, maxToolCalls: 2, tokenBudget: 5, activeWallTimeMs: 10_000 },
      worker: { maxAgentTurns: 2, maxToolCalls: 2, tokenBudget: 5, activeWallTimeMs: 10_000 },
      leaf: { maxAgentTurns: 2, maxToolCalls: 2, tokenBudget: 5, activeWallTimeMs: 10_000 },
    },
  };
  const { service } = fixture(undefined, { budgetLimits });
  deliverInitial(service, "finalization-overage");
  const root = service.rootServices();
  const response = await root.dispatch.model({
    correlationId: "finalization-overage-model", operation: "root.finalize", input: {}, finalization: true,
    dispatch: async () => ({ output: "bounded final synthesis", usage: { inputTokens: 5, outputTokens: 5, costMicroUsd: 0, precision: "provider-confirmed" as const } }),
  });
  assert.equal(typeof response, "object");
  assert.equal(await root.dispatch.tool({ correlationId: "finalization-overage-tool", toolName: "workflow_finish", operation: "finish", input: {}, finalization: true, policyOutcome: "allowed", dispatch: async () => "ok" }), "ok");
  await assert.rejects(() => root.dispatch.model({ correlationId: "ordinary-after-finalization", operation: "root.prompt", input: {}, dispatch: async () => "must not run" }), /budget|token/i);
  assert.equal(service.lifecycle.restore().latestRun?.terminal?.data.failureCode, "budget_exhausted");
});

test("run-wide budget preparation freezes questions before descendant cancellation across answer and restart races", async () => {
  for (const answerWins of [false, true]) {
    const active = snapshot() as any;
    active.payload.workflow.team.nodes[0].memberIds = ["worker", "other"];
    active.payload.workflow.team.nodes.push({ id: "other", agentId: "other-agent", parentId: "root", memberIds: [], depth: 2, role: "Other", responsibilities: [] });
    active.payload.authority.nodes[0].capabilities.directMemberIds = ["worker", "other"];
    active.payload.authority.nodes.push({ nodeId: "other", capabilities: { effective: {} }, tools: [], model: "other-model", thinking: "low" });
    active.payload.agents.push({ id: "other-agent", name: "Other", tags: [], prompt: "other" });
    active.payload.models.push({ nodeId: "other", modelId: "other-model", thinking: "low", staticTokens: 1, dynamicReserve: 1, contextWindow: 10 });
    const workerAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "worker");
    workerAuthority.capabilities.effective = { ...(workerAuthority.capabilities.effective ?? {}), "human-input": true };
    workerAuthority.tools = [...new Set([...workerAuthority.tools, "human_question"])].sort();
    const limits: EffectiveRuntimeBudgetLimits = {
      run: { maxParallel: 1, maxDelegations: 4, maxToolCalls: 20, tokenBudget: 10_000, activeWallTimeMs: 10_000 },
      nodes: {
        root: { maxAgentTurns: 4, maxToolCalls: 20, tokenBudget: 10_000, activeWallTimeMs: 10_000 },
        worker: { maxAgentTurns: 4, maxToolCalls: 20, tokenBudget: 10_000, activeWallTimeMs: 10_000 },
        leaf: { maxAgentTurns: 4, maxToolCalls: 20, tokenBudget: 10_000, activeWallTimeMs: 10_000 },
        other: { maxAgentTurns: 4, maxToolCalls: 20, tokenBudget: 10_000, activeWallTimeMs: 10_000 },
      },
    };
    const holder: { service?: RunOrchestrationService; questionId?: string; answered?: boolean } = {};
    const built = fixture(async (input) => ({ linkedSessionId: `budget-${answerWins}-${input.nodeId}`, async prompt() {
      if (input.nodeId === "worker") {
        holder.questionId = holder.service!.questionControls().create({ nodeId: "worker", taskId: "task-1", definition: { prompt: "Budget race?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: `budget-question-${answerWins}` } }).questionId;
        return "suspend on question";
      }
      return { output: "run budget exhausted", usage: { inputTokens: 20_000, outputTokens: 1, costMicroUsd: 0, precision: "provider-confirmed" as const } };
    }, dispose() {} }), {
      snapshot: active,
      budgetLimits: limits,
      questionControl: { authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined },
      completion: { projectState: () => {
        if (answerWins && !holder.answered && holder.questionId) {
          holder.answered = true;
          holder.service!.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: holder.questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "budget-race-answer" });
        }
        return { state: "satisfied" as const, fileChanges: [], changeCoverage: "recorded" };
      } },
    });
    holder.service = built.service;
    deliverInitial(built.service, `budget-question-${answerWins}`);
    const root = built.service.rootServices();
    const suspended = root.delegate({ targetNodeId: "worker", objective: "wait on question", deliverables: [] });
    const exhausted = root.delegate({ targetNodeId: "other", objective: "exhaust run budget", deliverables: [] });
    await assert.rejects(() => built.service.runWorkers(), /budget|token|question/i);
    const run = built.service.lifecycle.restore().latestRun!;
    assert.equal(run.status, "failed");
    assert.equal(run.terminal?.data.failureCode, "budget_exhausted");
    assert.deepEqual(run.terminal?.closedQuestionIds, answerWins ? [] : [holder.questionId]);
    const delegation = built.service.delegationState();
    assert.equal(delegation.schedulerStatus, "closed");
    assert.equal(delegation.tasks[suspended.taskId].result?.status, "cancelled");
    assert.equal(delegation.tasks[exhausted.taskId].queueState, "terminal");
    assert.equal(Object.values(delegation.tasks).some((task) => task.queueState !== "terminal"), false);
    const question = new QuestionService({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, authenticateControl: (request) => request.claimedIdentity }).restore().questions[holder.questionId!];
    assert.equal(question.state, answerWins ? "answered" : "closed");
    assert.equal(question.taskDeliveryAcceptedSequence, undefined);
    const ordered = readWorkflowJournal(built.projectRoot, "session-1");
    const preparedSequence = ordered.find((event) => event.type === "run.terminal.prepared")!.sequence;
    const cancelledSequence = ordered.find((event) => event.type === "task.result.recorded" && (event.payload as any).taskId === suspended.taskId)!.sequence;
    assert.ok(preparedSequence < cancelledSequence);
    if (!answerWins) {
      const closedSequence = ordered.find((event) => event.type === "question.transition" && (event.payload as any).operation === "close-pending")!.sequence;
      assert.ok(preparedSequence < closedSequence && closedSequence < cancelledSequence);
    }
    const replayed = await new RunOrchestrationService(built.options).lifecycle.failBudgetExhaustion("restart replay");
    assert.equal(replayed.ok, true);
    if (replayed.ok) assert.equal(replayed.envelope.terminalEventHash, run.terminal?.terminalEventHash);
  }
});

test("post-response token overage produces a budget-blocked worker result and closes ordinary admission", async () => {
  const factory: WorkerSessionFactory = async () => ({
    linkedSessionId: "overage-worker",
    prompt: async () => ({ output: "over budget", usage: { inputTokens: 5, outputTokens: 5, costMicroUsd: 0, precision: "provider-confirmed" as const } }),
    dispose() {},
  });
  const budgetLimits: EffectiveRuntimeBudgetLimits = {
    run: { maxParallel: 1, maxDelegations: 3, maxToolCalls: 5, tokenBudget: 5, activeWallTimeMs: 10_000 },
    nodes: {
      root: { maxAgentTurns: 3, maxToolCalls: 5, tokenBudget: 5, activeWallTimeMs: 10_000 },
      worker: { maxAgentTurns: 2, maxToolCalls: 5, tokenBudget: 5, activeWallTimeMs: 10_000 },
      leaf: { maxAgentTurns: 2, maxToolCalls: 5, tokenBudget: 5, activeWallTimeMs: 10_000 },
    },
  };
  const { service } = fixture(factory, { budgetLimits });
  deliverInitial(service, "overage");
  const root = service.rootServices();
  const task = root.delegate({ targetNodeId: "worker", objective: "overrun", deliverables: [] });
  await assert.rejects(() => service.runWorkers(), /budget|token/i);
  assert.equal(service.delegationState().tasks[task.taskId].result?.status, "blocked");
  assert.match(service.delegationState().tasks[task.taskId].result?.summary ?? "", /budget|token/i);
  assert.equal(service.lifecycle.restore().latestRun?.status, "failed");
  assert.equal(service.lifecycle.restore().latestRun?.terminal?.data.failureCode, "budget_exhausted");
  assert.throws(() => root.delegate({ targetNodeId: "worker", objective: "ordinary work after overage", deliverables: [] }), /budget|terminal|stale|current run/i);
});

test("restored unresolved effects recover before admission and block completion until reconciled", async () => {
  const { service } = fixture();
  deliverInitial(service, "recovery-gate");
  service.attemptRuntime().begin({ attemptId: "interrupted-write", correlationId: "write", nodeId: "root", operation: "write", input: {}, descriptor: { effect: "filesystem", readOnly: false, idempotent: false } });
  assert.throws(() => service.rootServices(), /unresolved|unknown.side.effect|reconciliation/i);
  assert.equal(service.attemptRuntime().restore().attempts["interrupted-write"].status, "unknown_side_effect");
  const finish = await service.lifecycle.finish({ status: "completed", summary: "must not finish" }, { callerNodeId: "root", toolBatch: ["workflow_finish"] });
  assert.equal(finish.ok, false);
  if (!finish.ok) assert.match(finish.issues.join(" "), /attempt|side.effect|reconciliation/i);
});

test("restart auto-reconciles an unknown model attempt and pauses a root-only run before admission", async () => {
  const { service, options } = fixture();
  deliverInitial(service, "model-recovery-gate");
  service.attemptRuntime().begin({ attemptId: "interrupted-model", correlationId: "model", nodeId: "root", operation: "provider.request", input: {}, descriptor: { effect: "model", readOnly: true, idempotent: true } });
  const restarted = new RunOrchestrationService(options);
  assert.throws(() => restarted.rootServices(), /recovery|unknown.side.effect|reconciliation/i);
  await assert.rejects(() => restarted.runWorkers(), /paused|unknown side effects|recovery/i);
  assert.equal(restarted.lifecycle.restore().latestRun?.status, "paused");
  assert.equal(restarted.attemptRuntime().restore().attempts["interrupted-model"].status, "unknown_side_effect");
});

test("restart fails closed when a durable run start has no durable change baseline", () => {
  const { projectRoot, options } = fixture();
  const lifecycle = new WorkflowRunLifecycle({
    projectRoot, projectId: options.projectId, sessionId: options.sessionId, snapshotId: options.snapshot.snapshotHash,
    rootNodeId: "root", runtimeOwnerNonce: options.runtimeOwnerNonce, createRunId: () => "orphaned-baseline-run",
  });
  lifecycle.recordUserInput({ inputId: "baseline-crash", text: "start", source: "interactive" });
  const restarted = new RunOrchestrationService(options);
  assert.throws(() => restarted.rootServices(), /baseline.*missing|missing.*baseline/i);
});

test("restored active clocks close at the recovered owner's last heartbeat before new admission", () => {
  let nowMs = 1_000;
  const { service, options } = fixture(undefined, { nowMs: () => nowMs });
  deliverInitial(service, "clock-recovery");
  assert.equal(service.budgetRuntime().beginActive("worker", "abandoned").ok, true);
  nowMs = 5_000;
  const restarted = new RunOrchestrationService({ ...options, nowMs: () => nowMs, recoveredOwnerHeartbeatAt: new Date(1_200).toISOString() });
  restarted.delegationState();
  const state = restarted.budgetState();
  assert.equal(state.activeBatches.length, 0);
  assert.equal(state.nodes.worker.activeWallTimeMs, 200);
});
