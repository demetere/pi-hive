import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  BUDGET_POLICY_V1,
  BudgetRuntime,
  createBudgetState,
  effectiveRuntimeBudgetLimitsFromSnapshot,
  reduceBudgetState,
  type BudgetState,
  type EffectiveRuntimeBudgetLimits,
} from "../../src/workflows/budgets.ts";
import { PACKAGE_BUDGET_CAPS } from "../../src/config/budgets.ts";
import { DelegationRuntime } from "../../src/workflows/delegation.ts";
import { createWorkflowEvent, sealWorkflowEvent, type WorkflowEventType } from "../../src/workflows/events.ts";

const limits: EffectiveRuntimeBudgetLimits = {
  run: { maxParallel: 2, maxDelegations: 2, maxToolCalls: 4, tokenBudget: 10, activeWallTimeMs: 1_000 },
  nodes: {
    root: { maxAgentTurns: 3, maxToolCalls: 4, tokenBudget: 10, activeWallTimeMs: 1_000 },
    worker: { maxAgentTurns: 2, maxToolCalls: 2, tokenBudget: 10, activeWallTimeMs: 500 },
  },
};

function fixture(nowMs = 0) {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-budgets-"));
  let current = nowMs;
  const runtime = new BudgetRuntime({
    projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", rootNodeId: "root", limits,
    nowMs: () => current,
    now: () => new Date(current).toISOString(),
  });
  return { projectRoot, runtime, setNow: (value: number) => { current = value; } };
}

let budgetEventId = 0;
function budgetEvent(type: WorkflowEventType, payload: unknown, overrides: { sessionId?: string; runId?: string; sequence?: number } = {}) {
  return sealWorkflowEvent(createWorkflowEvent({
    eventId: `budget-event-${++budgetEventId}`,
    projectId: "project-1", sessionId: overrides.sessionId ?? "session-1", runId: overrides.runId ?? "run-1",
    type, payload: payload as never, producer: type === "task.accepted" ? "runtime" : "harness", timestamp: "2026-01-01T00:00:00.000Z",
  }), overrides.sequence ?? 1, null);
}

async function waitForFiles(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for concurrent children: ${paths.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function spawnScript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Node propagates its internal coverage directory to children even when the
    // variable is omitted; an explicit empty value keeps these race actors from
    // diluting the parent test process's source-map coverage.
    const env = { ...process.env, NODE_V8_COVERAGE: "" };
    const child = spawn(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Concurrent child exited ${code}: ${stderr}`)));
  });
}

const concurrentLimits: EffectiveRuntimeBudgetLimits = {
  run: { maxParallel: 2, maxDelegations: 1, maxToolCalls: 2, tokenBudget: 100, activeWallTimeMs: 10_000 },
  nodes: {
    root: { maxAgentTurns: 2, maxToolCalls: 2, tokenBudget: 100, activeWallTimeMs: 10_000 },
    worker: { maxAgentTurns: 1, maxToolCalls: 1, tokenBudget: 100, activeWallTimeMs: 10_000 },
  },
};

const delegationSnapshot = {
  snapshotHash: "d".repeat(64), createdAt: "2026-01-01T00:00:00.000Z",
  payload: {
    project: { projectId: "project-1", rootRef: "." },
    workflow: { id: "delegation-race", team: { rootId: "root", nodes: [
      { id: "root", agentId: "lead", memberIds: ["worker"], depth: 1, responsibilities: [] },
      { id: "worker", agentId: "builder", parentId: "root", memberIds: [], depth: 2, responsibilities: [] },
    ] } },
    authority: { capabilityContractVersion: 1, nodes: [] }, agents: [], skills: [], knowledge: [], models: [], sources: [], versions: {},
  },
};

async function concurrentBudgetAdmissions(kind: "model" | "tool") {
  const projectRoot = mkdtempSync(join(tmpdir(), `hive-budget-${kind}-race-`));
  const go = join(projectRoot, "go");
  const ready = [join(projectRoot, "ready-1"), join(projectRoot, "ready-2")];
  const results = [join(projectRoot, "result-1.json"), join(projectRoot, "result-2.json")];
  const children = ready.map((readyPath, index) => spawnScript(`
    import { existsSync, writeFileSync } from "node:fs";
    import { BudgetRuntime } from "./src/workflows/budgets.ts";
    let synchronized = false;
    const nowMs = () => {
      if (!synchronized) {
        writeFileSync(${JSON.stringify(readyPath)}, "ready");
        while (!existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        synchronized = true;
      }
      return 0;
    };
    const runtime = new BudgetRuntime({ projectRoot: ${JSON.stringify(projectRoot)}, projectId: "project-1", sessionId: "session-1", runId: "run-1", rootNodeId: "root", limits: ${JSON.stringify(concurrentLimits)}, nowMs, now: () => "1970-01-01T00:00:00.000Z" });
    const result = ${kind === "model"
      ? `runtime.startModelAttempt("worker", "model-correlation-${index + 1}")`
      : `runtime.recordToolAttempt("worker", "tool-correlation-${index + 1}", { toolName: "read", policyOutcome: "allowed" })`};
    writeFileSync(${JSON.stringify(results[index])}, JSON.stringify(result));
  `));
  await waitForFiles(ready);
  writeFileSync(go, "go");
  await Promise.all(children);
  return {
    runtime: new BudgetRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", rootNodeId: "root", limits: concurrentLimits, nowMs: () => 0 }),
    results: results.map((path) => JSON.parse(readFileSync(path, "utf8")) as { ok: boolean }),
  };
}

async function concurrentDelegationAdmissions() {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-delegation-budget-race-"));
  const go = join(projectRoot, "go");
  const ready = [join(projectRoot, "ready-1"), join(projectRoot, "ready-2")];
  const results = [join(projectRoot, "result-1.json"), join(projectRoot, "result-2.json")];
  const children = ready.map((readyPath, index) => spawnScript(`
    import { existsSync, writeFileSync } from "node:fs";
    import { BudgetRuntime } from "./src/workflows/budgets.ts";
    import { DelegationRuntime } from "./src/workflows/delegation.ts";
    const budgets = new BudgetRuntime({ projectRoot: ${JSON.stringify(projectRoot)}, projectId: "project-1", sessionId: "session-1", runId: "run-1", rootNodeId: "root", limits: ${JSON.stringify(concurrentLimits)}, nowMs: () => 0, now: () => "1970-01-01T00:00:00.000Z" });
    const runtime = new DelegationRuntime({ projectRoot: ${JSON.stringify(projectRoot)}, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: ${JSON.stringify(delegationSnapshot)}, createTaskId: () => "task-${index + 1}", now: () => "1970-01-01T00:00:00.000Z", acceptanceAuthority: { admit: (events, nodeId) => budgets.admitDelegationAgainst(events, nodeId) } });
    writeFileSync(${JSON.stringify(readyPath)}, "ready");
    while (!existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    let result;
    try { result = { ok: true, value: runtime.accept(runtime.rootExecutionContext(), { targetNodeId: "worker", objective: "concurrent-${index + 1}", deliverables: [] }) }; }
    catch (error) { result = { ok: false, message: String(error instanceof Error ? error.message : error) }; }
    writeFileSync(${JSON.stringify(results[index])}, JSON.stringify(result));
  `));
  await waitForFiles(ready);
  writeFileSync(go, "go");
  await Promise.all(children);
  const budgets = new BudgetRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", rootNodeId: "root", limits: concurrentLimits, nowMs: () => 0 });
  const runtime = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: delegationSnapshot as never });
  return { budgets, runtime, results: results.map((path) => JSON.parse(readFileSync(path, "utf8")) as { ok: boolean; message?: string }) };
}

test("budget admission reserves exactly one root finalization model/tool attempt", () => {
  const { runtime } = fixture();
  const first = runtime.startModelAttempt("root", "root-turn-1");
  assert.equal(first.ok, true);
  const second = runtime.startModelAttempt("root", "root-turn-2");
  assert.equal(second.ok, true);
  const denied = runtime.startModelAttempt("root", "ordinary-would-consume-reserve");
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.reason, /finalization reserve|turn/i);

  const finalization = runtime.startModelAttempt("root", "finalize", { finalization: true });
  assert.equal(finalization.ok, true);
  assert.equal(runtime.startModelAttempt("root", "second-finalize", { finalization: true }).ok, false);

  runtime.recordToolAttempt("worker", "worker-tool-1", { toolName: "read", policyOutcome: "allowed" });
  runtime.recordToolAttempt("worker", "worker-tool-2", { toolName: "read", policyOutcome: "denied" });
  runtime.recordToolAttempt("root", "root-tool", { toolName: "workflow_status", policyOutcome: "allowed" });
  assert.equal(runtime.recordToolAttempt("root", "ordinary-tool-reserve", { toolName: "read", policyOutcome: "allowed" }).ok, false);
  assert.equal(runtime.recordToolAttempt("root", "finish-tool", { toolName: "workflow_finish", policyOutcome: "allowed", finalization: true }).ok, true);
  assert.equal(runtime.recordToolAttempt("root", "bad-final-tool", { toolName: "write", policyOutcome: "allowed", finalization: true }).ok, false);
});

test("concurrent distinct model and tool admissions atomically publish counters under the journal lock", async () => {
  const model = await concurrentBudgetAdmissions("model");
  assert.equal(model.results.filter((result) => result.ok).length, 1);
  assert.equal(model.runtime.restore().nodes.worker.turns, 1);
  assert.equal(Object.keys(model.runtime.restore().modelAttempts).length, 1);

  const tool = await concurrentBudgetAdmissions("tool");
  assert.equal(tool.results.filter((result) => result.ok).length, 1);
  assert.equal(tool.runtime.restore().nodes.worker.toolCalls, 1);
  assert.equal(Object.keys(tool.runtime.restore().toolAttempts).length, 1);
});

test("concurrent delegation admission and task acceptance share one atomic maxDelegations authority boundary", async () => {
  const raced = await concurrentDelegationAdmissions();
  assert.equal(raced.results.filter((result) => result.ok).length, 1);
  assert.match(raced.results.find((result) => !result.ok)?.message ?? "", /max-delegations|budget/i);
  assert.equal(raced.budgets.restore().run.delegations, 1);
  assert.equal(Object.keys(raced.runtime.restore().tasks).length, 1);
});

test("turn/tool/token counters are replayable, per-node and run-wide, and post-response usage may overrun once", () => {
  const { runtime } = fixture();
  const w1 = runtime.startModelAttempt("worker", "worker-provider-1");
  assert.equal(w1.ok, true);
  if (!w1.ok) return;
  runtime.recordModelUsage(w1.attemptId, { inputTokens: 2, outputTokens: 2, precision: "estimated" });
  runtime.recordModelUsage(w1.attemptId, { inputTokens: 3, outputTokens: 4, precision: "provider-confirmed" });
  assert.equal(runtime.restore().run.tokens, 7, "confirmed usage replaces the estimate for one attempt");
  assert.equal(runtime.restore().run.estimatedTokens, 0);
  assert.equal(runtime.restore().run.providerConfirmedTokens, 7);

  const w2 = runtime.startModelAttempt("worker", "worker-provider-2");
  assert.equal(w2.ok, true);
  if (!w2.ok) return;
  runtime.recordModelUsage(w2.attemptId, { inputTokens: 2, outputTokens: 2, precision: "provider-confirmed" });
  assert.equal(runtime.restore().run.tokens, 11, "response-known usage records one overage");
  assert.equal(runtime.startModelAttempt("worker", "worker-provider-3").ok, false);
  assert.equal(runtime.recordToolAttempt("worker", "policy-denial", { toolName: "write", policyOutcome: "denied" }).ok, false, "run token exhaustion blocks new tools");

  const replayed = new BudgetRuntime(runtime.options).restore();
  assert.deepEqual(replayed.run, runtime.restore().run);
  assert.equal(replayed.nodes.worker.turns, 2);
});

test("warning thresholds are deterministic and emitted once per scope/resource/threshold", () => {
  const { runtime } = fixture();
  const attempt = runtime.startModelAttempt("worker", "warning-turn");
  assert.equal(attempt.ok, true);
  if (!attempt.ok) return;
  runtime.recordModelUsage(attempt.attemptId, { inputTokens: 8, outputTokens: 0, precision: "estimated" });
  runtime.recordModelUsage(attempt.attemptId, { inputTokens: 9, outputTokens: 0, precision: "provider-confirmed" });
  const warnings = runtime.restore().warnings;
  assert.deepEqual(BUDGET_POLICY_V1.warningFractions, [0.8, 0.9]);
  assert.equal(warnings.filter((warning) => warning.scope === "node" && warning.resource === "tokens").length, 2);
  assert.equal(new Set(warnings.map((warning) => warning.key)).size, warnings.length);
});

test("active wall time excludes paused intervals and restart recovery closes an abandoned ownership segment", () => {
  const { runtime, setNow } = fixture(1_000);
  assert.equal(runtime.beginActive("worker", "batch-1").ok, true);
  setNow(1_300);
  runtime.pauseActive("waiting_for_human");
  assert.equal(runtime.restore().run.activeWallTimeMs, 300);
  setNow(5_000);
  runtime.resumeActive();
  assert.equal(runtime.beginActive("worker", "batch-2").ok, true);
  setNow(5_250);
  runtime.reconcileAbandonedActiveTime(5_200, "verified owner death");
  const state = new BudgetRuntime(runtime.options).restore();
  assert.equal(state.run.activeWallTimeMs, 500);
  assert.equal(state.nodes.worker.activeWallTimeMs, 500);
  assert.equal(state.activeBatches.length, 0);
});

test("snapshot limits use resolved minima with package fallbacks", () => {
  const field = (effective: number) => ({ scope: "run", effective, candidates: [] });
  const snapshot = { payload: { workflow: {
    budgets: { run: { "max-parallel": field(3), "max-delegations": field(7), "max-tool-calls": field(9), "token-budget": field(11), "active-wall-time": field(13) } },
    team: { rootId: "root", nodes: [
      { id: "root", budgets: { node: { "max-agent-turns": field(2), "max-tool-calls": field(4), "token-budget": field(6), "active-wall-time": field(8) } } },
      { id: "worker" },
    ] },
  } } } as never;
  const resolved = effectiveRuntimeBudgetLimitsFromSnapshot(snapshot);
  assert.deepEqual(resolved.run, { maxParallel: 3, maxDelegations: 7, maxToolCalls: 9, tokenBudget: 11, activeWallTimeMs: 13 });
  assert.deepEqual(resolved.nodes.root, { maxAgentTurns: 2, maxToolCalls: 4, tokenBudget: 6, activeWallTimeMs: 8 });
  assert.ok(resolved.nodes.worker.maxAgentTurns > 2);
});

test("overlapping node batches count run wall time once and node time independently", () => {
  const { runtime, setNow } = fixture(100);
  assert.equal(runtime.beginActive("root", "root-batch").ok, true);
  setNow(150);
  assert.equal(runtime.beginActive("worker", "worker-batch").ok, true);
  setNow(200);
  runtime.endActive("root-batch");
  assert.equal(runtime.restore().run.activeWallTimeMs, 0, "run clock stays open while another batch is active");
  setNow(250);
  runtime.endActive("worker-batch");
  const state = runtime.restore();
  assert.equal(state.run.activeWallTimeMs, 150);
  assert.equal(state.nodes.root.activeWallTimeMs, 100);
  assert.equal(state.nodes.worker.activeWallTimeMs, 100);
  assert.throws(() => runtime.endActive("missing"), /stale/i);
});

test("clock and usage reconciliation reject stale regressions while idempotent pause/resume is harmless", () => {
  const { runtime } = fixture();
  runtime.pauseActive("paused");
  runtime.pauseActive("paused twice");
  runtime.resumeActive();
  runtime.resumeActive();
  const attempt = runtime.startModelAttempt("worker", "confirmed");
  assert.equal(attempt.ok, true);
  if (!attempt.ok) return;
  runtime.recordModelUsage(attempt.attemptId, { inputTokens: 1, outputTokens: 1, precision: "provider-confirmed" });
  runtime.recordModelUsage(attempt.attemptId, { inputTokens: 1, outputTokens: 1, precision: "provider-confirmed" });
  assert.equal(runtime.restore().run.tokens, 2, "identical confirmed usage replay is idempotent");
  assert.throws(() => runtime.recordModelUsage(attempt.attemptId, { inputTokens: 0, outputTokens: 0, precision: "provider-confirmed" }), /immutable|conflict|regress/i);
  assert.throws(() => runtime.recordModelUsage(attempt.attemptId, { inputTokens: 1, outputTokens: 0, precision: "estimated" }), /regress/i);
  assert.throws(() => runtime.recordModelUsage("missing", { inputTokens: 0, outputTokens: 0, precision: "estimated" }), /matching/i);
});

test("invalid limit envelopes fail closed and injected limits clamp to package caps", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-budgets-invalid-"));
  assert.throws(() => new BudgetRuntime({ projectRoot, projectId: "p", sessionId: "s", runId: "r", rootNodeId: "root", limits: { ...limits, run: { ...limits.run, maxParallel: 0 } } }), /positive/i);
  assert.throws(() => new BudgetRuntime({ projectRoot, projectId: "p", sessionId: "s", runId: "r", rootNodeId: "missing", limits }), /incomplete/i);
  const oversized = new BudgetRuntime({
    projectRoot, projectId: "p", sessionId: "caps", runId: "caps-run", rootNodeId: "root",
    limits: {
      run: { maxParallel: Number.MAX_SAFE_INTEGER, maxDelegations: Number.MAX_SAFE_INTEGER, maxToolCalls: Number.MAX_SAFE_INTEGER, tokenBudget: Number.MAX_SAFE_INTEGER, activeWallTimeMs: Number.MAX_SAFE_INTEGER },
      nodes: { root: { maxAgentTurns: Number.MAX_SAFE_INTEGER, maxToolCalls: Number.MAX_SAFE_INTEGER, tokenBudget: Number.MAX_SAFE_INTEGER, activeWallTimeMs: Number.MAX_SAFE_INTEGER } },
    },
  }).restore().limits;
  assert.deepEqual(oversized.run, {
    maxParallel: PACKAGE_BUDGET_CAPS["max-parallel"], maxDelegations: PACKAGE_BUDGET_CAPS["max-delegations"],
    maxToolCalls: PACKAGE_BUDGET_CAPS["max-tool-calls"], tokenBudget: PACKAGE_BUDGET_CAPS["token-budget"], activeWallTimeMs: PACKAGE_BUDGET_CAPS["active-wall-time"],
  });
  assert.deepEqual(oversized.nodes.root, {
    maxAgentTurns: PACKAGE_BUDGET_CAPS["max-agent-turns"], maxToolCalls: PACKAGE_BUDGET_CAPS["max-tool-calls"],
    tokenBudget: PACKAGE_BUDGET_CAPS["token-budget"], activeWallTimeMs: PACKAGE_BUDGET_CAPS["active-wall-time"],
  });
});

test("invalid or unknown nodes and duplicate correlation IDs fail closed", () => {
  const { runtime } = fixture();
  assert.equal(runtime.startModelAttempt("unknown", "x").ok, false);
  assert.equal(runtime.beginActive("unknown", "batch").ok, false);
  const first = runtime.startModelAttempt("worker", "same");
  assert.equal(first.ok, true);
  assert.equal(runtime.startModelAttempt("worker", "same").ok, false);
});

test("budget helper boundaries reject malformed IDs, stale clocks, and unmatched usage", () => {
  const { runtime } = fixture();
  assert.equal(runtime.startModelAttempt("worker", "").ok, false);
  assert.equal(runtime.recordToolAttempt("worker", "tool", { toolName: "", policyOutcome: "allowed" }).ok, false);
  assert.deepEqual(runtime.postResponseOverages("unknown"), ["unknown node"]);
  assert.throws(() => runtime.recordModelUsage("missing", { inputTokens: 0, outputTokens: 0, precision: "estimated" }), /matching/i);
  assert.equal(runtime.beginActive("worker", "one").ok, true);
  assert.equal(runtime.beginActive("worker", "two").ok, false);
  runtime.endActive("one");
  runtime.reconcileAbandonedActiveTime(0, "nothing active");
  assert.throws(() => runtime.reconcileAbandonedActiveTime(Number.NaN, "invalid"), /boundary/i);
});

test("budget admissions cover locked delegation denial, duplicate tools, exhausted clocks, and invalid clocks", () => {
  const { runtime } = fixture();
  const accepted = budgetEvent("task.accepted", { taskId: "already-accepted" });
  const lockedRoot = mkdtempSync(join(tmpdir(), "hive-budget-locked-delegation-"));
  const lockedRuntime = new BudgetRuntime({ projectRoot: lockedRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", rootNodeId: "root", limits: concurrentLimits, nowMs: () => 0 });
  const lockedDenial = lockedRuntime.admitDelegationAgainst([accepted], "root");
  assert.equal(lockedDenial.ok, false);
  if (!lockedDenial.ok) {
    assert.deepEqual(lockedDenial.exhausted, ["run max-delegations"]);
    assert.equal(lockedDenial.scope, "run");
  }
  const unknown = runtime.admitDelegation("missing");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.deepEqual(unknown.exhausted, ["unknown node"]);

  assert.equal(runtime.recordToolAttempt("worker", "duplicate-tool", { toolName: "read", policyOutcome: "allowed" }).ok, true);
  const duplicate = runtime.recordToolAttempt("worker", "duplicate-tool", { toolName: "read", policyOutcome: "allowed" });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.budgetExhausted, false);

  const wall = fixture(0);
  assert.equal(wall.runtime.beginActive("worker", "wall-limit").ok, true);
  wall.setNow(1_001);
  wall.runtime.endActive("wall-limit");
  const wallDenied = wall.runtime.beginActive("worker", "after-wall-limit");
  assert.equal(wallDenied.ok, false);
  if (!wallDenied.ok) assert.deepEqual(new Set(wallDenied.exhausted), new Set(["run active-wall-time", "node active-wall-time"]));
  assert.deepEqual(new Set(wall.runtime.postResponseOverages("worker")), new Set(["run active-wall-time overage", "node active-wall-time overage"]));

  const invalidClockRoot = mkdtempSync(join(tmpdir(), "hive-budget-invalid-clock-"));
  const invalidClock = new BudgetRuntime({ projectRoot: invalidClockRoot, projectId: "p", sessionId: "s", runId: "r", rootNodeId: "root", limits: { ...limits, nodes: { root: limits.nodes.root } }, nowMs: () => Number.NaN });
  assert.throws(() => invalidClock.beginActive("root", "invalid-clock"), /clock is invalid/i);
});

test("budget reducer fails closed across malformed, duplicate, stale, and cross-run event branches", () => {
  const zero = createBudgetState("session-1", "run-1", "root", limits);
  const reduce = (state: BudgetState, type: WorkflowEventType, payload: unknown, overrides?: { sessionId?: string; runId?: string; sequence?: number }) =>
    reduceBudgetState(state, budgetEvent(type, payload, overrides));

  assert.strictEqual(reduce(zero, "control.requested", {}), zero);
  assert.strictEqual(reduce(zero, "budget.model.attempted", { formatVersion: 1 }, { runId: "run-2" }), zero);
  assert.throws(() => reduce(zero, "budget.model.attempted", { formatVersion: 1 }, { sessionId: "session-2" }), /session identity/i);
  assert.throws(() => reduce(zero, "task.accepted", {}), /accepted task/i);
  const accepted = reduce(zero, "task.accepted", { taskId: "task-1" });
  assert.strictEqual(reduce(accepted, "task.accepted", { taskId: "task-1" }), accepted);
  assert.throws(() => reduce(zero, "budget.model.attempted", { formatVersion: 2 }), /payload/i);

  const modelPayload = { formatVersion: 1, attemptId: "model-1", correlationId: "correlation-1", nodeId: "worker", finalization: false };
  let model = reduce(zero, "budget.model.attempted", modelPayload);
  assert.throws(() => reduce(zero, "budget.model.attempted", { ...modelPayload, attemptId: "", correlationId: "correlation-2" }), /attempt ID/i);
  assert.throws(() => reduce(zero, "budget.model.attempted", { ...modelPayload, correlationId: "", attemptId: "model-2" }), /correlation ID/i);
  assert.throws(() => reduce(zero, "budget.model.attempted", { ...modelPayload, nodeId: "", attemptId: "model-2", correlationId: "correlation-2" }), /node ID/i);
  assert.throws(() => reduce(zero, "budget.model.attempted", { ...modelPayload, nodeId: "missing" }), /unknown node|duplicated/i);
  assert.throws(() => reduce(model, "budget.model.attempted", modelPayload), /duplicated/i);
  assert.throws(() => reduce(model, "budget.model.attempted", { ...modelPayload, attemptId: "model-2" }), /duplicated/i);
  assert.throws(() => reduce(zero, "budget.model.usage.recorded", { formatVersion: 1, attemptId: "missing", usage: { inputTokens: 0, outputTokens: 0, precision: "estimated" } }), /matching/i);
  for (const usage of [
    null,
    { inputTokens: -1, outputTokens: 0, precision: "estimated" },
    { inputTokens: 0, outputTokens: -1, precision: "estimated" },
    { inputTokens: 0, outputTokens: 0, precision: "unknown" },
  ]) assert.throws(() => reduce(model, "budget.model.usage.recorded", { formatVersion: 1, attemptId: "model-1", usage }), /usage/i);
  model = reduce(model, "budget.model.usage.recorded", { formatVersion: 1, attemptId: "model-1", usage: { inputTokens: 2, outputTokens: 2, precision: "estimated" } });
  assert.throws(() => reduce(model, "budget.model.usage.recorded", { formatVersion: 1, attemptId: "model-1", usage: { inputTokens: 1, outputTokens: 2, precision: "provider-confirmed" } }), /regress/i);

  const toolPayload = { formatVersion: 1, attemptId: "tool-1", correlationId: "tool-correlation-1", nodeId: "worker", toolName: "read", policyOutcome: "allowed", finalization: false };
  const tool = reduce(zero, "budget.tool.attempted", toolPayload);
  assert.throws(() => reduce(zero, "budget.tool.attempted", { ...toolPayload, attemptId: "" }), /attempt ID/i);
  assert.throws(() => reduce(zero, "budget.tool.attempted", { ...toolPayload, correlationId: "" }), /correlation ID/i);
  assert.throws(() => reduce(zero, "budget.tool.attempted", { ...toolPayload, nodeId: "" }), /node ID/i);
  assert.throws(() => reduce(zero, "budget.tool.attempted", { ...toolPayload, toolName: "" }), /tool name/i);
  assert.throws(() => reduce(zero, "budget.tool.attempted", { ...toolPayload, nodeId: "missing" }), /unknown node|duplicated/i);
  assert.throws(() => reduce(tool, "budget.tool.attempted", toolPayload), /duplicated/i);
  assert.throws(() => reduce(tool, "budget.tool.attempted", { ...toolPayload, attemptId: "tool-2" }), /duplicated/i);
  assert.throws(() => reduce(zero, "budget.tool.attempted", { ...toolPayload, policyOutcome: "maybe" }), /policy outcome/i);

  const clockPayload = { formatVersion: 1, activityId: "activity-1", nodeId: "worker" };
  const active = reduce(zero, "budget.clock.started", clockPayload);
  assert.throws(() => reduce({ ...zero, paused: true }, "budget.clock.started", clockPayload), /clock start/i);
  assert.throws(() => reduce(zero, "budget.clock.started", { ...clockPayload, nodeId: "missing" }), /clock start/i);
  assert.throws(() => reduce(active, "budget.clock.started", clockPayload), /clock start/i);
  assert.throws(() => reduce(active, "budget.clock.started", { ...clockPayload, activityId: "activity-2" }), /clock start/i);
  assert.throws(() => reduce(zero, "budget.clock.stopped", { formatVersion: 1, activityId: "missing" }), /stale/i);
  assert.throws(() => reduce(zero, "budget.clock.resumed", { formatVersion: 1 }), /resume/i);
  assert.throws(() => reduce({ ...zero, paused: true, activeBatches: active.activeBatches }, "budget.clock.resumed", { formatVersion: 1 }), /resume/i);

  const warningPayload = { formatVersion: 1, key: "run-tools-80", scope: "run", resource: "tools", fraction: 0.8, used: 1, limit: 1 };
  const warned = reduce(zero, "budget.warning.recorded", warningPayload);
  assert.throws(() => reduce(warned, "budget.warning.recorded", warningPayload), /duplicated/i);
  assert.throws(() => reduce(zero, "budget.warning.recorded", { ...warningPayload, scope: "other" }), /warning is invalid/i);
  assert.throws(() => reduce(zero, "budget.warning.recorded", { ...warningPayload, resource: 1 }), /warning is invalid/i);
  assert.throws(() => reduce(zero, "budget.warning.recorded", { ...warningPayload, fraction: "0.8" }), /warning is invalid/i);
});
