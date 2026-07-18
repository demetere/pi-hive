import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { RunOrchestrationService } from "../../src/workflows/orchestration.ts";
import type { WorkerSessionFactory, WorkerPromptInvocation } from "../../src/workflows/workers.ts";
import {
  GENERIC_WORKFLOW_TOOL_CONTRACTS,
  GENERIC_WORKFLOW_TOOL_SCHEMAS,
  TOOL_CONTRACT_LIMITS,
  genericWorkflowToolContractsForNode,
} from "../../src/workflows/tools.ts";
import { acquireRuntimeOwnership } from "../../src/workflows/ownership.ts";

function snapshot(): ActivationSnapshotFileV1 {
  return { snapshotHash: "b".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", payload: {
    project: { projectId: "project-1", rootRef: "." },
    workflow: { id: "delivery", instructions: { shared: "shared", root: "root" }, artifact: { adapter: "none", profile: "default", binding: "none", options: {} }, team: { rootId: "root", nodes: [
      { id: "root", agentId: "lead", memberIds: ["worker"], depth: 1, responsibilities: [] },
      { id: "worker", agentId: "builder", parentId: "root", memberIds: ["leaf"], depth: 2, role: "Builder", responsibilities: ["implementation"] },
      { id: "leaf", agentId: "tester", parentId: "worker", memberIds: [], depth: 3, role: "Tester", responsibilities: ["verification"] },
    ] } },
    authority: { capabilityContractVersion: 1, nodes: [
      { nodeId: "root", capabilities: { effective: {}, budgets: {}, attachments: { skills: [], knowledge: [] }, directMemberIds: ["worker"] }, tools: ["delegate_agent", "route_agent", "team_status", "workflow_finish", "workflow_status"], model: "root-model", thinking: "medium" },
      { nodeId: "worker", capabilities: { effective: {}, budgets: {}, attachments: { skills: [], knowledge: [] }, directMemberIds: ["leaf"] }, tools: ["delegate_agent", "route_agent", "team_status"], model: "worker-model", thinking: "low" },
      { nodeId: "leaf", capabilities: { effective: {}, budgets: {}, attachments: { skills: [], knowledge: [] }, directMemberIds: [] }, tools: [], model: "leaf-model", thinking: "low" },
    ] },
    agents: [
      { id: "lead", name: "Lead", tags: [], prompt: "lead" },
      { id: "builder", name: "Builder", tags: ["implementation"], prompt: "build" },
      { id: "tester", name: "Tester", tags: ["verification"], prompt: "test" },
    ],
    skills: [], knowledge: [], models: [
      { nodeId: "root", modelId: "root-model", thinking: "medium", staticTokens: 1, dynamicReserve: 1, contextWindow: 100_000 },
      { nodeId: "worker", modelId: "worker-model", thinking: "low", staticTokens: 1, dynamicReserve: 1, contextWindow: 100_000 },
      { nodeId: "leaf", modelId: "leaf-model", thinking: "low", staticTokens: 1, dynamicReserve: 1, contextWindow: 100_000 },
    ], sources: [], versions: {} as never,
  } } as unknown as ActivationSnapshotFileV1;
}

function tool(name: string) {
  const found = GENERIC_WORKFLOW_TOOL_CONTRACTS.find((entry) => entry.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
}

let toolCallSequence = 0;
async function call(name: string, input: unknown, batch: readonly string[] = [name]): Promise<any> {
  const toolCallId = `call-${name}-${++toolCallSequence}`;
  const content = batch.map((toolName, index) => ({ type: "toolCall", id: index === 0 ? toolCallId : `${toolCallId}-${index}`, name: toolName, arguments: {} }));
  const ctx = { sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", content } }] } };
  return tool(name).execute(toolCallId, input as never, undefined, undefined, ctx as never);
}

function fixture(factoryOverride?: WorkerSessionFactory) {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-tools-"));
  const ownerNonce = "owner-1";
  assert.equal(acquireRuntimeOwnership(projectRoot, "session-1", { nonce: ownerNonce }).ok, true);
  let task = 0;
  const factory: WorkerSessionFactory = factoryOverride ?? (async (input) => ({
    linkedSessionId: `linked-${input.nodeId}`, prompt: async () => "ok", dispose() {},
  }));
  const service = new RunOrchestrationService({
    projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: snapshot(), runtimeOwnerNonce: ownerNonce,
    maxParallel: 1, workerFactory: factory, createRunId: () => "run-1", createTaskId: () => `task-${++task}`, createAttemptId: () => `attempt-${task}`,
    pauseAuthority: { captureState: () => ({}), releaseLeases: () => {}, releaseOwnership: () => {} },
    resumeAuthority: { acquireOwnership: () => {}, acquireLeases: () => {}, revalidateHashes: () => true, rollbackAuthority: () => {} },
    cancellationAuthority: { terminateProcessTrees: () => {}, capturePartialState: () => ({}), releaseLeases: () => {} },
  });
  service.lifecycle.recordUserInput({ inputId: "input-1", text: "deliver", source: "interactive" });
  const delivery = service.lifecycle.prepareInputDelivery("delivery-1");
  service.lifecycle.confirmInputDelivery(delivery.requestId);
  return { projectRoot, service };
}

test("generic TypeBox schemas are exact and reject unknown or oversized fields", () => {
  assert.equal(Value.Check(GENERIC_WORKFLOW_TOOL_SCHEMAS.route_agent, { objective: "route", callerNodeId: "root" }), false);
  assert.equal(Value.Check(GENERIC_WORKFLOW_TOOL_SCHEMAS.delegate_agent, {
    targetNodeId: "worker", objective: "x".repeat(TOOL_CONTRACT_LIMITS.objectiveCharacters + 1), deliverables: [],
  }), false);
  assert.equal(Value.Check(GENERIC_WORKFLOW_TOOL_SCHEMAS.team_status, { limit: 1, extra: true }), false);
  assert.equal(Value.Check(GENERIC_WORKFLOW_TOOL_SCHEMAS.workflow_status, { section: "unknown" }), false);
  assert.equal(Value.Check(GENERIC_WORKFLOW_TOOL_SCHEMAS.workflow_finish, { status: "cancelled", summary: "no" }), false);
});

test("generic tool exposure follows frozen topology and reserves inactive subsystem names", () => {
  assert.deepEqual(genericWorkflowToolContractsForNode(snapshot(), "root").map((entry) => entry.name).sort(), [
    "delegate_agent", "route_agent", "team_status", "workflow_finish", "workflow_status",
  ]);
  assert.deepEqual(genericWorkflowToolContractsForNode(snapshot(), "worker").map((entry) => entry.name).sort(), [
    "delegate_agent", "route_agent", "team_status",
  ]);
  assert.deepEqual(genericWorkflowToolContractsForNode(snapshot(), "leaf"), []);
  assert.equal(GENERIC_WORKFLOW_TOOL_CONTRACTS.some((entry) => entry.name === "artifact_status"), false);
  assert.equal(GENERIC_WORKFLOW_TOOL_CONTRACTS.some((entry) => entry.name === "knowledge_read"), false);
  assert.equal(GENERIC_WORKFLOW_TOOL_CONTRACTS.some((entry) => entry.name === "human_question"), false);
});

test("tools require trusted async runtime identity and route/delegate only through direct-member authority", async () => {
  await assert.rejects(() => call("route_agent", { objective: "implementation", includeUnmatched: true }), /trusted workflow tool runtime/i);
  const { service } = fixture();
  const root = service.rootServices();
  const routed = await root.runWithToolRuntime(() => call("route_agent", { objective: "implementation", includeUnmatched: true }));
  assert.match(routed.content[0].text, /worker/);
  await assert.rejects(
    () => root.runWithToolRuntime(() => call("delegate_agent", { targetNodeId: "leaf", objective: "spoof hierarchy", deliverables: [] })),
    /not a direct member/i,
  );
  await assert.rejects(
    () => root.runWithToolRuntime(() => call("delegate_agent", { callerNodeId: "worker", targetNodeId: "worker", objective: "spoof caller", deliverables: [] })),
    /schema|parameters|invalid/i,
  );
  const accepted = await root.runWithToolRuntime(() => call("delegate_agent", { targetNodeId: "worker", objective: "implement", deliverables: ["patch"] }));
  assert.match(accepted.content[0].text, /task-1/);
});

test("accepted multiline delegation content remains delimited and assembles into a worker prompt", async () => {
  let assembledPrompt = "";
  const { service } = fixture(async (input) => ({
    linkedSessionId: `linked-${input.nodeId}`,
    async prompt(text) { assembledPrompt = text; return "ok"; },
    dispose() {},
  }));
  const root = service.rootServices();
  const objective = "inspect line one\nthen line two\twithout escaping the task envelope";
  const deliverable = "report one\nreport two\twith evidence";
  await root.runWithToolRuntime(() => call("delegate_agent", {
    targetNodeId: "worker", objective, deliverables: [deliverable],
  }));
  await service.runWorkers();
  const persisted = Object.values(service.delegationState().tasks)[0];
  assert.equal(persisted.objective, objective);
  assert.equal(persisted.result?.status, "completed", "an accepted task must not fail later prompt assembly");
  assert.ok(assembledPrompt.includes("line one\\\\nthen line two\\\\t"), "multiline objective must remain escaped inside canonical JSON");
  assert.ok(assembledPrompt.includes("report one\\\\nreport two\\\\t"), "multiline deliverable must remain escaped inside canonical JSON");
});

test("team and workflow status are bounded, cursor-paginated, and expose explicit readback refs", async () => {
  const { service } = fixture();
  const root = service.rootServices();
  for (let index = 0; index < 3; index++) root.delegate({ targetNodeId: "worker", objective: `task ${index}`, deliverables: [] });
  const teamPage = await root.runWithToolRuntime(() => call("team_status", { limit: 2 }));
  const teamDetails = teamPage.details as { nextCursor?: string; items: Array<{ objectiveHash: string; objectiveTruncated: boolean; readRef: string }> };
  assert.equal(teamDetails.items.length, 2);
  assert.match(teamDetails.items[0].objectiveHash, /^[0-9a-f]{64}$/);
  assert.equal(typeof teamDetails.items[0].objectiveTruncated, "boolean");
  assert.match(teamDetails.items[0].readRef, /^run:run-1\/task:/);
  assert.ok(teamDetails.nextCursor);
  assert.ok(Buffer.byteLength(teamPage.content[0].text, "utf8") <= TOOL_CONTRACT_LIMITS.outputBytes);

  service.lifecycle.recordUserInput({ inputId: "input-2", text: "steering data ".repeat(500), source: "interactive" });
  const prepared = service.lifecycle.prepareInputDelivery("delivery-2");
  service.lifecycle.confirmInputDelivery(prepared.requestId);
  const inputPage = await root.runWithToolRuntime(() => call("workflow_status", { section: "inputs", limit: 1 }));
  const details = inputPage.details as { items: Array<{ contentHash: string; truncated: boolean; readRef: string }>; nextCursor?: string };
  assert.equal(details.items.length, 1);
  assert.match(details.items[0].contentHash, /^[0-9a-f]{64}$/);
  assert.equal(typeof details.items[0].readRef, "string");
  assert.ok(details.nextCursor);
  assert.ok(Buffer.byteLength(inputPage.content[0].text, "utf8") <= TOOL_CONTRACT_LIMITS.outputBytes);
});

test("workflow_finish is root-only, sole-call, policy-rechecked, and returns harness-derived identity", async () => {
  let invocation: WorkerPromptInvocation | undefined;
  let workerFinishError = "";
  const { service } = fixture(async (input) => ({
    linkedSessionId: `linked-${input.nodeId}`,
    async prompt(_text, _signal, current) {
      invocation = current;
      try {
        await current!.runWithToolRuntime!(() => call("workflow_finish", { status: "completed", summary: "worker spoof" }));
      } catch (error) {
        workerFinishError = String(error instanceof Error ? error.message : error);
      }
      return "worker result";
    },
    dispose() {},
  }));
  const root = service.rootServices();
  await assert.rejects(
    () => root.runWithToolRuntime(() => call("workflow_finish", { status: "completed", summary: "spoof batch" }, ["workflow_finish", "team_status"])),
    /sole call/i,
  );

  root.delegate({ targetNodeId: "worker", objective: "work", deliverables: [] });
  await service.runWorkers();
  assert.ok(invocation?.runWithToolRuntime);
  assert.match(workerFinishError, /not enabled|policy denied|root-only/i);
  const delivery = await root.runWithToolRuntime(() => call("team_status", { action: "deliver-results", deliveryId: "results-1", limit: 20 }));
  assert.match(delivery.content[0].text, /worker result/);
  assert.equal((delivery.details as { accepted: boolean }).accepted, true);
  const finished = await root.runWithToolRuntime(() => call("workflow_finish", { status: "completed", summary: "done" }));
  const details = finished.details as { ok: boolean; finishedByNodeId: string; runId: string; snapshotId: string };
  assert.equal(details.ok, true);
  assert.equal(details.finishedByNodeId, "root");
  assert.equal(details.runId, "run-1");
  assert.equal(details.snapshotId, snapshot().snapshotHash);
  assert.equal((details as Record<string, unknown>).fileChanges, undefined, "large authority state must be read back through workflow_status pagination");
});

test("all reference and evidence strings are rejected by UTF-8 bytes before dispatch", async () => {
  const { service } = fixture();
  const root = service.rootServices();
  const oversized = "😀".repeat(600);
  await assert.rejects(
    () => root.runWithToolRuntime(() => call("delegate_agent", { targetNodeId: "worker", objective: "work", contextRefs: [{ kind: "repository", id: oversized }], deliverables: [] })),
    /UTF-8 byte limit/i,
  );
  await assert.rejects(
    () => root.runWithToolRuntime(() => call("workflow_finish", { status: "completed", summary: "done", artifactRefs: [{ workspaceId: oversized, checkpoint: "verified", digest: `sha256:${"a".repeat(64)}` }] })),
    /UTF-8 byte limit/i,
  );
  assert.equal(Object.keys(service.attemptRuntime().restore().attempts).length, 0, "invalid byte fields must not reach trusted dispatch");
});
