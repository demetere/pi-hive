import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import type { PersistedDelegationTask } from "../../src/workflows/delegation.ts";
import {
  WorkerSessionPool,
  workerTranscriptPath,
  type WorkerSessionFactory,
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
  if (result.status === "suspended") assert.fail("non-delegating worker must return a terminal result");
  assert.ok(Buffer.byteLength(result.summary, "utf8") <= 64);
  assert.equal(await pool.waitForSettlement(100), true);
  assert.equal(aborts, 1);
  assert.equal(disposals, 1);
  assert.equal(pool.activeSessionCount, 0);
  assert.equal(pool.hasLiveHandles(), false);
});
