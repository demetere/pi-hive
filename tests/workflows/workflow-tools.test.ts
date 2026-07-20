import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { RunOrchestrationService } from "../../src/workflows/orchestration.ts";
import { deriveWorkerPromptContext, type WorkerSessionFactory, type WorkerPromptInvocation } from "../../src/workflows/workers.ts";
import { QuestionService } from "../../src/workflows/questions.ts";
import { QUESTION_LIMITS } from "../../src/workflows/question-validation.ts";
import {
  ROOT_LOSSLESS_DYNAMIC_DELIVERY_LIMITS,
  losslessDynamicPromptInputs,
  measureLosslessDynamicPromptDelivery,
} from "../../src/workflows/prompts.ts";
import { createHandoffPacket, type HandoffPacket } from "../../src/workflows/handoff.ts";
import {
  GENERIC_WORKFLOW_TOOL_CONTRACTS,
  GENERIC_WORKFLOW_TOOL_SCHEMAS,
  TOOL_CONTRACT_LIMITS,
  genericWorkflowToolContractsForNode,
} from "../../src/workflows/tools.ts";
import { acquireRuntimeOwnership } from "../../src/workflows/ownership.ts";
import { appendWorkflowEvent, readWorkflowJournal } from "../../src/workflows/journal.ts";
import { createWorkflowEvent } from "../../src/workflows/events.ts";
import { AttemptRuntime, attemptDescriptorForModel, executeWithConservativeRetry } from "../../src/workflows/attempts.ts";
import { KnowledgeEnrichmentService, restoreKnowledgeEnrichmentState } from "../../src/knowledge/enrichment.ts";
import { DurableKnowledgeQueue } from "../../src/knowledge/queue.ts";
import type { KnowledgeMutationQueue } from "../../src/knowledge/proposals.ts";
import type { EffectiveRuntimeBudgetLimits } from "../../src/workflows/budgets.ts";

const [NODE_MAJOR = 0, NODE_MINOR = 0] = process.versions.node.split(".").map(Number);
const PI_RUNTIME_ENGINE_SUPPORTED = NODE_MAJOR > 22 || (NODE_MAJOR === 22 && NODE_MINOR >= 19);
const PI_RUNTIME_ENGINE_SKIP_REASON = "locked @earendil-works/pi-coding-agent 0.80.7 requires Node >=22.19.0; the older-Node lane tests utility compatibility only";

function snapshot(): ActivationSnapshotFileV1 {
  return { snapshotHash: "b".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", payload: {
    project: { projectId: "project-1", rootRef: "." },
    workflow: { id: "delivery", instructions: { shared: "shared", root: "root" }, artifact: { adapter: "none", adapterVersion: "1", profile: "default", profileVersion: "1", binding: "none", options: {}, optionsSchemaVersion: "1", contractVersion: "pi-hive-artifact-contract-v1", checkpoints: [], actionIds: [], viewVersion: 1, approvals: {} }, team: { rootId: "root", nodes: [
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

async function callSequentialQuestionBatch(inputs: readonly unknown[]): Promise<readonly any[]> {
  const batchId = `call-human-question-batch-${++toolCallSequence}`;
  const calls = inputs.map((input, index) => ({ id: `${batchId}-${index}`, input }));
  const content = calls.map(({ id, input }) => ({ type: "toolCall", id, name: "human_question", arguments: input }));
  const ctx = { sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", content } }] } };
  const results = [];
  for (const entry of calls) results.push(await tool("human_question").execute(entry.id, entry.input as never, undefined, undefined, ctx as never));
  return results;
}

async function callMixedSuspensionBatch(order: readonly ["delegate_agent" | "human_question", "delegate_agent" | "human_question"], concurrent: boolean): Promise<readonly PromiseSettledResult<any>[]> {
  const batchId = `call-mixed-suspension-${++toolCallSequence}`;
  const calls = order.map((name, index) => ({
    id: `${batchId}-${index}`,
    name,
    input: name === "delegate_agent"
      ? { targetNodeId: "worker", objective: "must not publish", deliverables: [] }
      : { prompt: "Must not publish?", kind: "confirm", required: true },
  }));
  const content = calls.map(({ id, name, input }) => ({ type: "toolCall", id, name, arguments: input }));
  const ctx = { sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", content } }] } };
  const invoke = (entry: (typeof calls)[number]) => tool(entry.name).execute(entry.id, entry.input as never, undefined, undefined, ctx as never);
  if (concurrent) return Promise.allSettled(calls.map(invoke));
  const results: PromiseSettledResult<any>[] = [];
  for (const entry of calls) results.push(...await Promise.allSettled([invoke(entry)]));
  return results;
}

function fixture(
  factoryOverride?: WorkerSessionFactory,
  snapshotOverride: ActivationSnapshotFileV1 = snapshot(),
  presentLive?: any,
  overrides: { runId?: string; createRunId?: () => string; initialInputText?: string; stagedHandoff?: HandoffPacket; cancellationReleaseLeases?: () => void | Promise<void>; questionJournalFault?: (eventType: "question.transition", stage: "beforeWrite" | "afterFileFsync" | "beforeRename" | "afterRename" | "beforeDirFsync") => void; budgetLimits?: EffectiveRuntimeBudgetLimits; knowledgeMutationQueue?: KnowledgeMutationQueue; prepareProject?: (projectRoot: string) => void } = {},
) {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-tools-"));
  overrides.prepareProject?.(projectRoot);
  const ownerNonce = "owner-1";
  assert.equal(acquireRuntimeOwnership(projectRoot, "session-1", { nonce: ownerNonce }).ok, true);
  let task = 0;
  const configuredFactory: WorkerSessionFactory = factoryOverride ?? (async (input) => ({
    linkedSessionId: `linked-${input.nodeId}`, prompt: async () => "ok", dispose() {},
  }));
  const factory: WorkerSessionFactory = async (input) => {
    const handle = await configuredFactory(input);
    if (input.providerTokenLimits && !handle.enforcedTokenLimits) Object.defineProperty(handle, "enforcedTokenLimits", { value: input.providerTokenLimits, enumerable: true });
    return handle;
  };
  const options = {
    projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: snapshotOverride, runtimeOwnerNonce: ownerNonce,
    maxParallel: 1, workerFactory: factory, createRunId: overrides.createRunId ?? (() => overrides.runId ?? "run-1"), createTaskId: () => `task-${++task}`, createAttemptId: () => `attempt-${task}`,
    ...(overrides.budgetLimits ? { budgetLimits: overrides.budgetLimits } : {}),
    ...(overrides.knowledgeMutationQueue ? { knowledgeMutationQueue: overrides.knowledgeMutationQueue } : {}),
    pauseAuthority: { captureState: () => ({}), releaseLeases: () => {}, releaseOwnership: () => {} },
    resumeAuthority: { acquireOwnership: () => {}, acquireLeases: () => {}, revalidateHashes: () => true, rollbackAuthority: () => {} },
    cancellationAuthority: { terminateProcessTrees: () => {}, capturePartialState: () => ({}), releaseLeases: overrides.cancellationReleaseLeases ?? (() => {}) },
    questionControl: { authenticateControl: (request: any) => request.credential === "secret" ? request.claimedIdentity : undefined, ...(presentLive ? { presentLive } : {}), ...(overrides.questionJournalFault ? { journalFault: overrides.questionJournalFault } : {}) },
  } as const;
  const service = new RunOrchestrationService(options);
  if (overrides.stagedHandoff) appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", type: "handoff.recorded", producer: "harness",
    payload: { formatVersion: 1, operation: "stage", packet: overrides.stagedHandoff } as never,
  }));
  service.lifecycle.recordUserInput({ inputId: "input-1", text: overrides.initialInputText ?? "deliver", source: "interactive" });
  const delivery = service.lifecycle.prepareInputDelivery("delivery-1");
  service.lifecycle.confirmInputDelivery(delivery.requestId);
  return { projectRoot, service, options };
}

test("generic TypeBox schemas are exact and reject unknown or oversized fields", () => {
  assert.equal(Value.Check(GENERIC_WORKFLOW_TOOL_SCHEMAS.route_agent, { objective: "route", callerNodeId: "root" }), false);
  assert.equal(Value.Check(GENERIC_WORKFLOW_TOOL_SCHEMAS.delegate_agent, {
    targetNodeId: "worker", objective: "x".repeat(TOOL_CONTRACT_LIMITS.objectiveCharacters + 1), deliverables: [],
  }), false);
  assert.equal(Value.Check(GENERIC_WORKFLOW_TOOL_SCHEMAS.team_status, { limit: 1, extra: true }), false);
  assert.equal(Value.Check(GENERIC_WORKFLOW_TOOL_SCHEMAS.workflow_status, { section: "unknown" }), false);
  assert.equal(Value.Check(GENERIC_WORKFLOW_TOOL_SCHEMAS.artifact_status, { limit: 1, workspaceId: "spoof" }), false);
  assert.equal(Value.Check(GENERIC_WORKFLOW_TOOL_SCHEMAS.artifact_action, { actionId: "x", arguments: {}, operationId: "spoof" }), false);
  assert.equal(Value.Check((GENERIC_WORKFLOW_TOOL_SCHEMAS as any).knowledge_search, { query: "architecture", callerNodeId: "spoof" }), false);
  assert.equal(Value.Check((GENERIC_WORKFLOW_TOOL_SCHEMAS as any).knowledge_read, { bundleId: "shared", documentId: "api", path: "../../secret" }), false);
  assert.equal(Value.Check((GENERIC_WORKFLOW_TOOL_SCHEMAS as any).knowledge_read, { bundleId: "shared", documentId: "x".repeat(1_716) }), true);
  assert.equal(Value.Check((GENERIC_WORKFLOW_TOOL_SCHEMAS as any).knowledge_read, { bundleId: "shared", documentId: "x".repeat(1_717) }), false);
  assert.equal(Value.Check((GENERIC_WORKFLOW_TOOL_SCHEMAS as any).knowledge_propose, { scope: "agent", conclusion: "A stable evidence-backed conclusion.", evidenceEventIds: ["event-1"] }), true);
  assert.equal(Value.Check((GENERIC_WORKFLOW_TOOL_SCHEMAS as any).knowledge_propose, { scope: "agent", conclusion: "No citations", evidenceEventIds: [] }), false);
  assert.equal(Value.Check((GENERIC_WORKFLOW_TOOL_SCHEMAS as any).knowledge_propose, { scope: "agent", conclusion: "Transcript line\nsecond line", evidenceEventIds: ["event-1"] }), false);
  assert.equal(Value.Check((GENERIC_WORKFLOW_TOOL_SCHEMAS as any).knowledge_propose, { scope: "agent", conclusion: "A stable evidence-backed conclusion.", evidenceEventIds: ["event-1"], authority: true }), false);
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
  assert.equal(GENERIC_WORKFLOW_TOOL_CONTRACTS.some((entry) => entry.name === "artifact_status"), true);
  assert.equal(GENERIC_WORKFLOW_TOOL_CONTRACTS.some((entry) => entry.name === "artifact_action"), true);
  assert.equal(GENERIC_WORKFLOW_TOOL_CONTRACTS.some((entry) => entry.name === "knowledge_read"), true);
  assert.equal(GENERIC_WORKFLOW_TOOL_CONTRACTS.some((entry) => entry.name === "knowledge_propose"), true);
  assert.equal(GENERIC_WORKFLOW_TOOL_CONTRACTS.some((entry) => entry.name === "human_question"), true, "the generic contract is registered while immutable authority still controls exposure");
  assert.equal(Value.Check((GENERIC_WORKFLOW_TOOL_SCHEMAS as any).human_question, {
    prompt: "Which database?", kind: "single", choices: [{ value: "postgres", label: "PostgreSQL" }], required: true,
  }), true);
  assert.equal(Value.Check((GENERIC_WORKFLOW_TOOL_SCHEMAS as any).human_question, {
    prompt: "Which database?", kind: "single", choices: [{ value: "postgres", label: "PostgreSQL" }], required: true, html: "<b>unsafe</b>",
  }), false);
  assert.equal(Value.Check((GENERIC_WORKFLOW_TOOL_SCHEMAS as any).human_question, {
    prompt: "unsafe\u0001control", kind: "text", required: true,
  }), false);
  assert.equal(Value.Check((GENERIC_WORKFLOW_TOOL_SCHEMAS as any).human_question, {
    prompt: "structured\nwhitespace", kind: "text", required: true,
  }), true);
});

test("artifact tools remain profile/capability gated and none exposes only bounded status", async () => {
  const active = snapshot();
  const rootAuthority = active.payload.authority.nodes.find((node) => node.nodeId === "root") as any;
  rootAuthority.capabilities.effective.artifact = ["read"];
  rootAuthority.tools = [...rootAuthority.tools, "artifact_status"].sort();
  const { service } = fixture(undefined, active);
  const root = service.rootServices();
  assert.deepEqual(genericWorkflowToolContractsForNode(active, "root").map((entry) => entry.name).sort(), [
    "artifact_status", "delegate_agent", "route_agent", "team_status", "workflow_finish", "workflow_status",
  ]);
  assert.equal(genericWorkflowToolContractsForNode(active, "root").some((entry) => entry.name === "artifact_action"), false);
  const status = await root.runWithToolRuntime(() => call("artifact_status", { limit: 5 }));
  const details = status.details as { status: string; workspace: { id: string; kind: string }; actions: unknown[]; checkpoints: unknown[] };
  assert.equal(details.status, "complete");
  assert.deepEqual(details.workspace, { id: "none", kind: "logical-empty", binding: "none" });
  assert.deepEqual(details.actions, []);
  assert.deepEqual(details.checkpoints, []);
});

test("knowledge tools are attached-only, locally retrieved, bounded, and journal exact provenance", async () => {
  const active = snapshot() as any;
  active.payload.workflow.team.nodes[0].knowledge = { resolved: ["shared"] };
  active.payload.knowledge = [{ id: "shared", provider: "okf", path: ".pi/hive/knowledge/shared", updates: "reviewed", metadataFingerprint: "a".repeat(64), attachedNodeIds: ["root"] }];
  const rootAuthority = active.payload.authority.nodes.find((node: any) => node.nodeId === "root");
  rootAuthority.capabilities.effective = { ...rootAuthority.capabilities.effective, knowledge: ["read"] };
  rootAuthority.capabilities.attachments.knowledge = ["shared"];
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "knowledge_read", "knowledge_search"])].sort();
  const built = fixture(undefined, active);
  const directory = join(built.projectRoot, ".pi/hive/knowledge/shared");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "api.md"), "---\ntype: Reference\ntitle: Public API\ndescription: Gateway behavior\n---\n\nThe gateway routes requests.\n");
  const root = built.service.rootServices();
  const searched = await root.runWithToolRuntime(() => call("knowledge_search", { query: "gateway", limit: 5 }));
  const searchDetails = searched.details as any;
  assert.equal(searchDetails.items[0].documentId, "api");
  const read = await root.runWithToolRuntime(() => call("knowledge_read", { bundleId: "shared", documentId: "api" }));
  const readDetails = read.details as any;
  assert.match(readDetails.content, /gateway routes/);
  assert.equal(readDetails.returnedContentHash, `sha256:${createHash("sha256").update(readDetails.content, "utf8").digest("hex")}`);
  const provenance = readWorkflowJournal(built.projectRoot, "session-1").filter((event) => event.type === "knowledge.transition");
  assert.deepEqual(provenance.map((event) => (event.payload as any).operation), ["search", "read"]);
});

test("knowledge_propose is capability-gated and persists only bounded citation-derived candidates", async () => {
  const active = snapshot() as any;
  active.payload.workflow.team.nodes[0].knowledge = { resolved: ["shared"] };
  active.payload.knowledge = [{ id: "shared", provider: "okf", path: ".pi/hive/knowledge/shared", updates: "reviewed", metadataFingerprint: "a".repeat(64), attachedNodeIds: ["root"] }];
  const rootAuthority = active.payload.authority.nodes.find((node: any) => node.nodeId === "root");
  rootAuthority.capabilities.effective = { ...rootAuthority.capabilities.effective, knowledge: ["propose", "curate"] };
  rootAuthority.capabilities.attachments.knowledge = ["shared"];
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "knowledge_propose"])].sort();
  let curatorPrompts = 0;
  const built = fixture(async (input) => ({
    linkedSessionId: `knowledge-${input.nodeId}`,
    async prompt(text) {
      curatorPrompts++;
      const candidateId = /"candidateId":"([^"]+)"/u.exec(text)?.[1];
      assert.ok(candidateId, "production curator receives the durable candidate prompt");
      return { output: JSON.stringify({ formatVersion: 1, conclusions: [{ text: "The project uses a deterministic build graph.", citationIds: [candidateId] }] }), usage: { inputTokens: 50, outputTokens: 20, costMicroUsd: 321, precision: "provider-confirmed" as const } };
    },
    abort() {}, dispose() {},
  }), active, undefined, {
    prepareProject: (projectRoot) => {
      const bundleRoot = join(projectRoot, ".pi/hive/knowledge/shared");
      mkdirSync(bundleRoot, { recursive: true });
      writeFileSync(join(bundleRoot, "existing.md"), "---\ntype: Knowledge\ntitle: Existing\n---\n\nExisting verified knowledge.\n");
    },
  });
  appendWorkflowEvent(built.projectRoot, createWorkflowEvent({
    eventId: "verified-evidence", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "artifact.recorded", producer: "harness",
    payload: { formatVersion: 1, nodeId: "root", operation: "verified-evidence", contentHash: `sha256:${"e".repeat(64)}` },
  }));
  const root = built.service.rootServices();
  const result = await root.runWithToolRuntime(() => call("knowledge_propose", { scope: "shared", conclusion: "The project uses a deterministic build graph.", evidenceEventIds: ["verified-evidence"] }));
  assert.equal((result.details as any).scope, "shared");
  assert.deepEqual((result.details as any).sourceHashes, [`sha256:${"e".repeat(64)}`]);
  assert.equal(readWorkflowJournal(built.projectRoot, "session-1").filter((event) => (event.payload as any).operation === "candidate-recorded").length, 1);

  rootAuthority.tools = rootAuthority.tools.filter((name: string) => name !== "knowledge_propose");
  await assert.rejects(() => root.runWithToolRuntime(() => call("knowledge_propose", { scope: "shared", conclusion: "This must be denied by frozen authority.", evidenceEventIds: ["verified-evidence"] })), /denied|not enabled/i);
  rootAuthority.tools = [...rootAuthority.tools, "knowledge_propose"].sort();
  const finished = await root.runWithToolRuntime(() => call("workflow_finish", { status: "completed", summary: "Knowledge candidate recorded without waiting for curation.", artifactRefs: [], evidenceRefs: [] }));
  assert.equal((finished.details as any).status, "completed");
  await built.service.runKnowledgeEnrichment();
  const jobs = readWorkflowJournal(built.projectRoot, "session-1").filter((event) => (event.payload as any).operation === "jobs-enqueued");
  assert.equal(jobs.length, 1);
  assert.equal((jobs[0].payload as any).jobs[0].state, "queued");
  assert.equal(curatorPrompts, 1, "idle terminal enrichment executes through a dedicated production model handle");
  const usage = readWorkflowJournal(built.projectRoot, "session-1").find((event) => (event.payload as any).operation === "curator-model-usage");
  assert.equal((usage?.payload as any).usage.costMicroUsd, 321, "typed provider cost is durably charged in integer micro-USD");
  assert.equal(built.service.knowledgeProposals().status({ projectId: "project-1", sessionId: "session-1", state: "pending", limit: 10 }).items.length, 1);
  assert.equal(built.service.activeWorkerCount(), 0, "curation consumes no scheduler worker slot");
  await built.service.shutdown();
  assert.equal(built.service.hasLiveHandles(), false);
});

test("production automatic enrichment uses Pi's mutation queue without an injected test seam", {
  skip: PI_RUNTIME_ENGINE_SUPPORTED ? false : PI_RUNTIME_ENGINE_SKIP_REASON,
}, async () => {
  const active = snapshot() as any;
  active.payload.workflow.team.nodes[0].knowledge = { resolved: ["shared"] };
  active.payload.knowledge = [{ id: "shared", provider: "okf", path: ".pi/hive/knowledge/shared", updates: "automatic", metadataFingerprint: "a".repeat(64), attachedNodeIds: ["root"] }];
  const authority = active.payload.authority.nodes.find((node: any) => node.nodeId === "root");
  authority.capabilities.effective = { ...authority.capabilities.effective, knowledge: ["propose", "curate"] };
  authority.capabilities.attachments.knowledge = ["shared"];
  authority.tools = [...new Set([...authority.tools, "knowledge_propose"])].sort();
  const built = fixture(async (input) => ({
    linkedSessionId: `knowledge-${input.nodeId}`,
    async prompt(text) {
      const candidateId = /"candidateId":"([^"]+)"/u.exec(text)?.[1];
      return JSON.stringify({ formatVersion: 1, conclusions: [{ text: "Automatic production enrichment uses the Pi mutation queue.", citationIds: [candidateId] }] });
    },
    abort() {}, dispose() {},
  }), active, undefined, {
    prepareProject: (projectRoot) => {
      const bundleRoot = join(projectRoot, ".pi/hive/knowledge/shared");
      mkdirSync(bundleRoot, { recursive: true });
      writeFileSync(join(bundleRoot, "existing.md"), "---\ntype: Knowledge\ntitle: Existing\n---\n\nExisting verified knowledge.\n");
    },
  });
  try {
    const evidence = appendWorkflowEvent(built.projectRoot, createWorkflowEvent({
      eventId: "automatic-evidence", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "artifact.recorded", producer: "harness",
      payload: { formatVersion: 1, nodeId: "root", contentHash: `sha256:${"5".repeat(64)}` },
    }));
    new KnowledgeEnrichmentService({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, createCandidateId: () => "automatic-candidate" })
      .propose("root", "automatic-attempt", { scope: "shared", conclusion: "Automatic production enrichment uses the Pi mutation queue.", evidenceEventIds: [evidence.eventId] });
    const root = built.service.rootServices();
    await root.runWithToolRuntime(() => call("workflow_finish", { status: "completed", summary: "Apply automatic knowledge.", artifactRefs: [], evidenceRefs: [] }));
    await built.service.runKnowledgeEnrichment();
    const durable = restoreKnowledgeEnrichmentState(readWorkflowJournal(built.projectRoot, "session-1"));
    assert.equal(Object.values(durable.jobs).every((job) => job.state === "completed" && durable.curatorPlanEffectsComplete[job.jobId]), true, JSON.stringify(Object.values(durable.jobs)));
    assert.match(readFileSync(join(built.projectRoot, ".pi/hive/knowledge/shared/curated.md"), "utf8"), /Pi mutation queue/u);
  } finally {
    await built.service.shutdown();
    assert.equal(built.service.hasLiveHandles(), false);
  }
});

test("runKnowledgeEnrichment follows an older reconciliation snapshot with exactly one terminal disposition and mutation", async () => {
  const active = snapshot() as any;
  active.payload.workflow.team.nodes[0].knowledge = { resolved: ["shared"] };
  active.payload.knowledge = [{ id: "shared", provider: "okf", path: ".pi/hive/knowledge/shared", updates: "automatic", metadataFingerprint: "a".repeat(64), attachedNodeIds: ["root"] }];
  const authority = active.payload.authority.nodes.find((node: any) => node.nodeId === "root");
  authority.capabilities.effective = { ...authority.capabilities.effective, knowledge: ["propose", "curate"] };
  authority.capabilities.attachments.knowledge = ["shared"];
  authority.tools = [...new Set([...authority.tools, "knowledge_propose"])].sort();
  let mutationCalls = 0;
  const mutationQueue: KnowledgeMutationQueue = async (_canonicalPath, _operationId, callback) => {
    mutationCalls++;
    return await callback();
  };
  const built = fixture(async (input) => ({
    linkedSessionId: `knowledge-${input.nodeId}`,
    async prompt(text) {
      const candidateId = /"candidateId":"([^"]+)"/u.exec(text)?.[1];
      assert.ok(candidateId);
      return JSON.stringify({ formatVersion: 1, conclusions: [{ text: "A follow-up reconciliation applies the newly durable terminal exactly once.", citationIds: [candidateId] }] });
    },
    abort() {}, dispose() {},
  }), active, undefined, {
    knowledgeMutationQueue: mutationQueue,
    prepareProject: (projectRoot) => {
      const bundleRoot = join(projectRoot, ".pi/hive/knowledge/shared");
      mkdirSync(bundleRoot, { recursive: true });
      writeFileSync(join(bundleRoot, "existing.md"), "---\ntype: Knowledge\ntitle: Existing\n---\n\nExisting verified knowledge.\n");
    },
  });
  const reconcileTerminalEnrichment = (built.service as any).reconcileTerminalEnrichment.bind(built.service);
  let releaseOlderPass = (): void => {};
  let olderPass: Promise<void> | undefined;
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const evidence = appendWorkflowEvent(built.projectRoot, createWorkflowEvent({
      eventId: "follow-up-evidence", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "artifact.recorded", producer: "harness",
      payload: { formatVersion: 1, nodeId: "root", contentHash: `sha256:${"6".repeat(64)}` },
    }));
    new KnowledgeEnrichmentService({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, createCandidateId: () => "follow-up-candidate" })
      .propose("root", "follow-up-attempt", { scope: "shared", conclusion: "A follow-up reconciliation applies the newly durable terminal exactly once.", evidenceEventIds: [evidence.eventId] });

    let snapshotTaken!: () => void;
    const didTakeSnapshot = new Promise<void>((resolve) => { snapshotTaken = resolve; });
    const holdOlderPass = new Promise<void>((resolve) => { releaseOlderPass = resolve; });
    // Run the prior one-snapshot shape through the real reconciliation lock,
    // then hold it after its snapshot so the terminal is durably newer.
    (built.service as any).reconcileTerminalEnrichment = async (...args: unknown[]) => {
      await reconcileTerminalEnrichment(...args);
      snapshotTaken();
      await holdOlderPass;
    };
    olderPass = (built.service as any).executeKnowledgeReconciliation();
    await didTakeSnapshot;
    (built.service as any).reconcileTerminalEnrichment = reconcileTerminalEnrichment;

    const root = built.service.rootServices();
    await root.runWithToolRuntime(() => call("workflow_finish", { status: "completed", summary: "Publish after the older reconciliation snapshot.", artifactRefs: [], evidenceRefs: [] }));
    const terminal = readWorkflowJournal(built.projectRoot, "session-1").find((event) => event.type === "terminal.recorded" && event.runId === "run-1");
    assert.ok(terminal);
    assert.equal(restoreKnowledgeEnrichmentState(readWorkflowJournal(built.projectRoot, "session-1")).terminalEnqueueCompleted[terminal.eventHash], undefined,
      "the held older pass took its only snapshot before the terminal became durable");

    const enrichment = built.service.runKnowledgeEnrichment();
    releaseOlderPass();
    await enrichment;

    const events = readWorkflowJournal(built.projectRoot, "session-1");
    const durable = restoreKnowledgeEnrichmentState(events);
    const jobs = Object.values(durable.jobs);
    assert.equal(durable.terminalEnqueueCompleted[terminal.eventHash], true);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].state, "completed");
    assert.equal(durable.curatorPlanEffectsComplete[jobs[0].jobId], true);
    assert.equal(events.filter((event) => (event.payload as any).operation === "jobs-enqueued").length, 1);
    assert.equal(events.filter((event) => (event.payload as any).operation === "jobs-enqueue-completed").length, 1);
    assert.equal(mutationCalls, 1);
    assert.match(readFileSync(join(built.projectRoot, ".pi/hive/knowledge/shared/curated.md"), "utf8"), /newly durable terminal exactly once/u);
  } finally {
    (built.service as any).reconcileTerminalEnrichment = reconcileTerminalEnrichment;
    releaseOlderPass();
    await olderPass?.catch(() => undefined);
    await built.service.shutdown();
    assert.equal(built.service.hasLiveHandles(), false);
  }
});

test("active root user work preempts curation and prevents idle restart until the user model settles", async () => {
  const active = snapshot() as any;
  active.payload.workflow.team.nodes[0].knowledge = { resolved: ["shared"] };
  active.payload.knowledge = [{ id: "shared", provider: "okf", path: ".pi/hive/knowledge/shared", updates: "reviewed", metadataFingerprint: "a".repeat(64), attachedNodeIds: ["root"] }];
  const authority = active.payload.authority.nodes.find((node: any) => node.nodeId === "root");
  authority.capabilities.effective = { ...authority.capabilities.effective, knowledge: ["propose", "curate"] };
  authority.capabilities.attachments.knowledge = ["shared"];
  authority.tools = [...new Set([...authority.tools, "knowledge_propose"])].sort();
  let curatorStarts = 0;
  let firstStarted!: () => void;
  const didFirstStart = new Promise<void>((resolve) => { firstStarted = resolve; });
  const built = fixture(async (input) => ({
    linkedSessionId: `knowledge-${input.nodeId}`,
    async prompt(text, signal) {
      curatorStarts++;
      const candidateId = /"candidateId":"([^"]+)"/u.exec(text)?.[1];
      if (curatorStarts === 1) {
        firstStarted();
        await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return JSON.stringify({ formatVersion: 1, conclusions: [{ text: "User work has strict priority over background curation.", citationIds: [candidateId] }] });
    },
    abort() {}, dispose() {},
  }), active, undefined, {
    createRunId: (() => { let run = 0; return () => `run-${++run}`; })(),
    prepareProject: (projectRoot) => {
      const bundleRoot = join(projectRoot, ".pi/hive/knowledge/shared");
      mkdirSync(bundleRoot, { recursive: true });
      writeFileSync(join(bundleRoot, "existing.md"), "---\ntype: Knowledge\ntitle: Existing\n---\n\nExisting verified knowledge.\n");
    },
  });
  const evidence = appendWorkflowEvent(built.projectRoot, createWorkflowEvent({
    eventId: "priority-evidence", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "artifact.recorded", producer: "harness",
    payload: { formatVersion: 1, nodeId: "root", contentHash: `sha256:${"4".repeat(64)}` },
  }));
  new KnowledgeEnrichmentService({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, createCandidateId: () => "priority-candidate" })
    .propose("root", "priority-attempt", { scope: "shared", conclusion: "User work has strict priority over background curation.", evidenceEventIds: [evidence.eventId] });
  const firstRoot = built.service.rootServices();
  await firstRoot.runWithToolRuntime(() => call("workflow_finish", { status: "completed", summary: "Queue priority curation.", artifactRefs: [], evidenceRefs: [] }));
  await didFirstStart;

  built.service.lifecycle.recordUserInput({ inputId: "input-2", text: "new user work", source: "interactive" });
  const delivery = built.service.lifecycle.prepareInputDelivery("delivery-2");
  built.service.lifecycle.confirmInputDelivery(delivery.requestId);
  let rootStarted!: () => void;
  let releaseRoot!: () => void;
  const didRootStart = new Promise<void>((resolve) => { rootStarted = resolve; });
  const rootHold = new Promise<void>((resolve) => { releaseRoot = resolve; });
  const rootDispatch = built.service.rootServices().dispatch.model({
    correlationId: "priority-root-model", operation: "workflow.root.model", input: { text: "new user work" },
    dispatch: async () => { rootStarted(); await rootHold; return "root complete"; },
  });
  await didRootStart;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(curatorStarts, 1, "curation must not restart while root user work is active");
  assert.equal(built.service.activeWorkerCount(), 0, "curation never consumes a normal worker slot");
  releaseRoot();
  await rootDispatch;
  await built.service.runKnowledgeEnrichment();
  assert.equal(curatorStarts, 2);
  await built.service.shutdown();
});

test("a non-cooperative older curator cannot delay durable reconciliation of a newer terminal", async () => {
  const active = snapshot() as any;
  active.payload.workflow.team.nodes[0].knowledge = { resolved: ["shared"] };
  active.payload.knowledge = [{ id: "shared", provider: "okf", path: ".pi/hive/knowledge/shared", updates: "reviewed", metadataFingerprint: "a".repeat(64), attachedNodeIds: ["root"] }];
  const authority = active.payload.authority.nodes.find((node: any) => node.nodeId === "root");
  authority.capabilities.effective = { ...authority.capabilities.effective, knowledge: ["propose", "curate"] };
  authority.capabilities.attachments.knowledge = ["shared"];
  authority.tools = [...new Set([...authority.tools, "knowledge_propose"])].sort();
  let oldStarted!: () => void;
  const didStart = new Promise<void>((resolve) => { oldStarted = resolve; });
  const never = new Promise<string>(() => undefined);
  let run = 0;
  const built = fixture(async (input) => ({
    linkedSessionId: `older-${input.nodeId}`,
    prompt: async () => { oldStarted(); return never; },
    abort() {}, dispose() {},
  }), active, undefined, {
    createRunId: () => `run-${++run}`,
    prepareProject: (projectRoot) => {
      const bundleRoot = join(projectRoot, ".pi/hive/knowledge/shared");
      mkdirSync(bundleRoot, { recursive: true });
      writeFileSync(join(bundleRoot, "existing.md"), "---\ntype: Knowledge\ntitle: Existing\n---\n\nExisting verified knowledge.\n");
    },
  });
  const firstEvidence = appendWorkflowEvent(built.projectRoot, createWorkflowEvent({
    eventId: "older-curator-evidence", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "artifact.recorded", producer: "harness",
    payload: { formatVersion: 1, nodeId: "root", contentHash: `sha256:${"3".repeat(64)}` },
  }));
  new KnowledgeEnrichmentService({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, createCandidateId: () => "older-candidate" })
    .propose("root", "older-attempt", { scope: "shared", conclusion: "Older curation may remain non-cooperative without blocking journal persistence.", evidenceEventIds: [firstEvidence.eventId] });
  await built.service.rootServices().runWithToolRuntime(() => call("workflow_finish", { status: "completed", summary: "Start older curation.", artifactRefs: [], evidenceRefs: [] }));
  await didStart;
  await new Promise((resolve) => setImmediate(resolve));

  (built.service as any).knowledgeQueue.preemptForUserWork = async () => undefined;
  built.service.lifecycle.recordUserInput({ inputId: "newer-input", text: "newer run", source: "interactive" });
  const newerDelivery = built.service.lifecycle.prepareInputDelivery("newer-delivery");
  built.service.lifecycle.confirmInputDelivery(newerDelivery.requestId);
  const newerEvidence = appendWorkflowEvent(built.projectRoot, createWorkflowEvent({
    eventId: "newer-terminal-evidence", projectId: "project-1", sessionId: "session-1", runId: "run-2", type: "artifact.recorded", producer: "harness",
    payload: { formatVersion: 1, nodeId: "root", contentHash: `sha256:${"4".repeat(64)}` },
  }));
  new KnowledgeEnrichmentService({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-2", snapshot: active, createCandidateId: () => "newer-candidate" })
    .propose("root", "newer-attempt", { scope: "shared", conclusion: "New terminal candidates become durable before any older queue drain.", evidenceEventIds: [newerEvidence.eventId] });
  assert.equal((await built.service.lifecycle.finish({ status: "completed", summary: "Newer terminal is durable." }, { callerNodeId: "root", toolBatch: ["workflow_finish"] })).ok, true);
  const newerTerminal = readWorkflowJournal(built.projectRoot, "session-1").find((event) => event.type === "terminal.recorded" && event.runId === "run-2")!;
  const reconciled = await Promise.race([
    (built.service as any).executeKnowledgeReconciliation().then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  const completed = restoreKnowledgeEnrichmentState(readWorkflowJournal(built.projectRoot, "session-1")).terminalEnqueueCompleted[newerTerminal.eventHash] === true;
  await built.service.shutdown();
  assert.equal(reconciled, true, "terminal reconciliation must not await an older non-cooperative queue drain");
  assert.equal(completed, true);
});

test("restart idle admission blocks curation while durable user delegation is runnable", async () => {
  const active = snapshot() as any;
  active.payload.workflow.team.nodes[0].knowledge = { resolved: ["shared"] };
  active.payload.knowledge = [{ id: "shared", provider: "okf", path: ".pi/hive/knowledge/shared", updates: "reviewed", metadataFingerprint: "a".repeat(64), attachedNodeIds: ["root"] }];
  const authority = active.payload.authority.nodes.find((node: any) => node.nodeId === "root");
  authority.capabilities.effective = { ...authority.capabilities.effective, knowledge: ["propose", "curate"] };
  authority.capabilities.attachments.knowledge = ["shared"];
  authority.tools = [...new Set([...authority.tools, "knowledge_propose"])].sort();
  let run = 0;
  let curatorStarts = 0;
  const built = fixture(async (input) => ({
    linkedSessionId: `idle-${input.nodeId}`,
    prompt: async (text) => {
      if (input.runId.startsWith("knowledge-")) {
        curatorStarts++;
        const candidateId = /"candidateId":"([^"]+)"/u.exec(text)?.[1];
        return JSON.stringify({ formatVersion: 1, conclusions: [{ text: "Durable user work has priority over restart curation.", citationIds: [candidateId] }] });
      }
      return "user task complete";
    },
    dispose() {},
  }), active, undefined, {
    createRunId: () => `run-${++run}`,
    prepareProject: (projectRoot) => {
      const bundleRoot = join(projectRoot, ".pi/hive/knowledge/shared");
      mkdirSync(bundleRoot, { recursive: true });
      writeFileSync(join(bundleRoot, "existing.md"), "---\ntype: Knowledge\ntitle: Existing\n---\n\nExisting verified knowledge.\n");
    },
  });
  const evidence = appendWorkflowEvent(built.projectRoot, createWorkflowEvent({
    eventId: "restart-idle-evidence", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "artifact.recorded", producer: "harness",
    payload: { formatVersion: 1, nodeId: "root", contentHash: `sha256:${"4".repeat(64)}` },
  }));
  new KnowledgeEnrichmentService({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, createCandidateId: () => "restart-idle-candidate" })
    .propose("root", "restart-idle-attempt", { scope: "shared", conclusion: "Durable user work has priority over restart curation.", evidenceEventIds: [evidence.eventId] });
  assert.equal((await built.service.lifecycle.finish({ status: "completed", summary: "run one complete" }, { callerNodeId: "root", toolBatch: ["workflow_finish"] })).ok, true);
  built.service.lifecycle.recordUserInput({ inputId: "run-two-input", text: "run two", source: "interactive" });
  const delivery = built.service.lifecycle.prepareInputDelivery("run-two-delivery");
  built.service.lifecycle.confirmInputDelivery(delivery.requestId);
  built.service.rootServices().delegate({ targetNodeId: "worker", objective: "durable queued user task", deliverables: [] });
  const restarted = new RunOrchestrationService(built.options);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(curatorStarts, 0);
  await restarted.shutdown();
  await built.service.shutdown();
});

for (const durableBlocker of ["root-model-attempt", "tool-attempt", "active-budget"] as const) {
  test(`restart idle admission inspects durable ${durableBlocker} work before curation`, async () => {
    const active = snapshot() as any;
    active.payload.workflow.team.nodes[0].knowledge = { resolved: ["shared"] };
    active.payload.knowledge = [{ id: "shared", provider: "okf", path: ".pi/hive/knowledge/shared", updates: "reviewed", metadataFingerprint: "a".repeat(64), attachedNodeIds: ["root"] }];
    const authority = active.payload.authority.nodes.find((node: any) => node.nodeId === "root");
    authority.capabilities.effective = { ...authority.capabilities.effective, knowledge: ["propose", "curate"] };
    authority.capabilities.attachments.knowledge = ["shared"];
    authority.tools = [...new Set([...authority.tools, "knowledge_propose"])].sort();
    let run = 0;
    let curatorStarts = 0;
    const built = fixture(async (input) => ({
      linkedSessionId: `durable-idle-${input.nodeId}`,
      prompt: async (text) => {
        if (input.runId.startsWith("knowledge-")) {
          curatorStarts++;
          const candidateId = /"candidateId":"([^"]+)"/u.exec(text)?.[1];
          return JSON.stringify({ formatVersion: 1, conclusions: [{ text: "Durable recovery work blocks restart curation.", citationIds: [candidateId] }] });
        }
        return "user work";
      },
      dispose() {},
    }), active, undefined, {
      createRunId: () => `run-${++run}`,
      prepareProject: (projectRoot) => {
        const bundleRoot = join(projectRoot, ".pi/hive/knowledge/shared");
        mkdirSync(bundleRoot, { recursive: true });
        writeFileSync(join(bundleRoot, "existing.md"), "---\ntype: Knowledge\ntitle: Existing\n---\n\nExisting verified knowledge.\n");
      },
    });
    const evidence = appendWorkflowEvent(built.projectRoot, createWorkflowEvent({
      eventId: `durable-idle-${durableBlocker}`, projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "artifact.recorded", producer: "harness",
      payload: { formatVersion: 1, nodeId: "root", contentHash: `sha256:${"4".repeat(64)}` },
    }));
    new KnowledgeEnrichmentService({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, createCandidateId: () => `candidate-${durableBlocker}` })
      .propose("root", `proposal-${durableBlocker}`, { scope: "shared", conclusion: "Durable recovery work blocks restart curation.", evidenceEventIds: [evidence.eventId] });
    assert.equal((await built.service.lifecycle.finish({ status: "completed", summary: "run one complete" }, { callerNodeId: "root", toolBatch: ["workflow_finish"] })).ok, true);
    built.service.lifecycle.recordUserInput({ inputId: `input-${durableBlocker}`, text: "run two", source: "interactive" });
    const delivery = built.service.lifecycle.prepareInputDelivery(`delivery-${durableBlocker}`);
    built.service.lifecycle.confirmInputDelivery(delivery.requestId);
    if (durableBlocker === "active-budget") {
      assert.equal(built.service.budgetRuntime().beginActive("root", "interrupted-root-active").ok, true);
    } else {
      const attempts = new AttemptRuntime({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-2" });
      attempts.begin({
        attemptId: `unresolved-${durableBlocker}`, correlationId: `correlation-${durableBlocker}`, nodeId: "root",
        operation: durableBlocker === "root-model-attempt" ? "workflow.root.model" : "workflow.tool.knowledge_propose", input: { interrupted: true },
        descriptor: durableBlocker === "root-model-attempt" ? attemptDescriptorForModel() : { effect: "tool", readOnly: false, idempotent: false },
      });
    }
    const restarted = new RunOrchestrationService(built.options);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(curatorStarts, 0, `startup curation must wait for ${durableBlocker} recovery`);
    await restarted.shutdown();
    await built.service.shutdown();
  });
}

test("orchestration shutdown quarantines a non-cooperative curator factory in live-handle accounting", async () => {
  const active = snapshot() as any;
  active.payload.workflow.team.nodes[0].knowledge = { resolved: ["shared"] };
  active.payload.knowledge = [{ id: "shared", provider: "okf", path: ".pi/hive/knowledge/shared", updates: "reviewed", metadataFingerprint: "a".repeat(64), attachedNodeIds: ["root"] }];
  const authority = active.payload.authority.nodes.find((node: any) => node.nodeId === "root");
  authority.capabilities.effective = { ...authority.capabilities.effective, knowledge: ["propose", "curate"] };
  authority.capabilities.attachments.knowledge = ["shared"];
  authority.tools = [...new Set([...authority.tools, "knowledge_propose"])].sort();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const never = new Promise<void>(() => undefined);
  const built = fixture(async () => {
    started();
    return await never as never;
  }, active, undefined, {
    prepareProject: (projectRoot) => {
      const bundleRoot = join(projectRoot, ".pi/hive/knowledge/shared");
      mkdirSync(bundleRoot, { recursive: true });
      writeFileSync(join(bundleRoot, "existing.md"), "---\ntype: Knowledge\ntitle: Existing\n---\n\nExisting verified knowledge.\n");
    },
  });
  const evidence = appendWorkflowEvent(built.projectRoot, createWorkflowEvent({
    eventId: "noncoop-evidence", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "artifact.recorded", producer: "harness",
    payload: { formatVersion: 1, nodeId: "root", contentHash: `sha256:${"6".repeat(64)}` },
  }));
  new KnowledgeEnrichmentService({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, createCandidateId: () => "noncoop-candidate" })
    .propose("root", "noncoop-attempt", { scope: "shared", conclusion: "Non-cooperative curator shutdown remains bounded.", evidenceEventIds: [evidence.eventId] });
  const root = built.service.rootServices();
  await root.runWithToolRuntime(() => call("workflow_finish", { status: "completed", summary: "Start non-cooperative curation.", artifactRefs: [], evidenceRefs: [] }));
  await didStart;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    built.service.shutdown().then(() => "settled" as const),
    new Promise<"timeout">((resolve) => { shutdownTimer = setTimeout(() => resolve("timeout"), 6_000); }),
  ]);
  if (shutdownTimer) clearTimeout(shutdownTimer);
  assert.equal(outcome, "settled");
  assert.equal(built.service.hasLiveHandles(), true, "an unresolved effectful factory remains quarantined and owned");
  const durable = Object.values(restoreKnowledgeEnrichmentState(readWorkflowJournal(built.projectRoot, "session-1")).jobs)[0];
  assert.equal(durable.state, "active");
});

test("shutdown keeps a real non-cooperative curator handle live-accounted until provider disposal settles", async () => {
  const active = snapshot() as any;
  active.payload.workflow.team.nodes[0].knowledge = { resolved: ["shared"] };
  active.payload.knowledge = [{ id: "shared", provider: "okf", path: ".pi/hive/knowledge/shared", updates: "reviewed", metadataFingerprint: "a".repeat(64), attachedNodeIds: ["root"] }];
  const authority = active.payload.authority.nodes.find((node: any) => node.nodeId === "root");
  authority.capabilities.effective = { ...authority.capabilities.effective, knowledge: ["propose", "curate"] };
  authority.capabilities.attachments.knowledge = ["shared"];
  authority.tools = [...new Set([...authority.tools, "knowledge_propose"])].sort();
  let promptStarted!: () => void;
  const didPrompt = new Promise<void>((resolve) => { promptStarted = resolve; });
  let releaseDispose!: () => void;
  const disposeHold = new Promise<void>((resolve) => { releaseDispose = resolve; });
  const never = new Promise<void>(() => undefined);
  const built = fixture(async (input) => ({
    linkedSessionId: `real-noncoop-${input.nodeId}`,
    async prompt() { promptStarted(); await never; return "unreachable"; },
    abort: () => never,
    dispose: () => disposeHold,
  }), active, undefined, {
    prepareProject: (projectRoot) => {
      const bundleRoot = join(projectRoot, ".pi/hive/knowledge/shared");
      mkdirSync(bundleRoot, { recursive: true });
      writeFileSync(join(bundleRoot, "existing.md"), "---\ntype: Knowledge\ntitle: Existing\n---\n\nExisting verified knowledge.\n");
    },
  });
  const evidence = appendWorkflowEvent(built.projectRoot, createWorkflowEvent({
    eventId: "real-noncoop-evidence", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "artifact.recorded", producer: "harness",
    payload: { formatVersion: 1, nodeId: "root", contentHash: `sha256:${"5".repeat(64)}` },
  }));
  new KnowledgeEnrichmentService({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, createCandidateId: () => "real-noncoop-candidate" })
    .propose("root", "real-noncoop-attempt", { scope: "shared", conclusion: "Real model handles remain honestly accounted during shutdown.", evidenceEventIds: [evidence.eventId] });
  const root = built.service.rootServices();
  await root.runWithToolRuntime(() => call("workflow_finish", { status: "completed", summary: "Start real non-cooperative curation.", artifactRefs: [], evidenceRefs: [] }));
  await didPrompt;
  await built.service.shutdown();
  assert.equal(built.service.hasLiveHandles(), true, "timed-out provider disposal must not be hidden");
  const activeJob = Object.values(restoreKnowledgeEnrichmentState(readWorkflowJournal(built.projectRoot, "session-1")).jobs)[0];
  assert.equal(activeJob.state, "active", "durable job ownership must remain quarantined until real provider disposal settles");
  let duplicateStarts = 0;
  const secondOwner = new DurableKnowledgeQueue({
    projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", ownerNonce: "second-process-owner", isIdle: () => true,
    verifyOwnerDead: async () => false, process: async () => { duplicateStarts++; },
  });
  await secondOwner.wake();
  assert.equal(duplicateStarts, 0, "a second process cannot run the same job while the old provider handle is live");
  assert.equal(secondOwner.restore().jobs[activeJob.jobId].state, "active");
  releaseDispose();
  for (let turn = 0; turn < 10 && built.service.hasLiveHandles(); turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(built.service.hasLiveHandles(), false);
  assert.equal(secondOwner.restore().jobs[activeJob.jobId].state, "paused", "only verified handle settlement releases durable ownership");
});

test("explicit cancelled-run preservation survives nonblocking terminal scheduling and enqueues the durable job", async () => {
  const active = snapshot() as any;
  active.payload.workflow.team.nodes[0].knowledge = { resolved: ["shared"] };
  active.payload.knowledge = [{ id: "shared", provider: "okf", path: ".pi/hive/knowledge/shared", updates: "reviewed", metadataFingerprint: "a".repeat(64), attachedNodeIds: ["root"] }];
  const authority = active.payload.authority.nodes.find((node: any) => node.nodeId === "root");
  authority.capabilities.effective = { ...authority.capabilities.effective, knowledge: ["propose", "curate"] };
  authority.capabilities.attachments.knowledge = ["shared"];
  authority.tools = [...new Set([...authority.tools, "knowledge_propose"])].sort();
  const built = fixture(async (input) => ({
    linkedSessionId: `knowledge-${input.nodeId}`,
    async prompt() { return JSON.stringify({ formatVersion: 1, conclusions: [{ text: "Preserved cancellation evidence remains durable.", citationIds: ["preserve-candidate"] }] }); },
    abort() {}, dispose() {},
  }), active, undefined, {
    prepareProject: (projectRoot) => {
      const bundleRoot = join(projectRoot, ".pi/hive/knowledge/shared");
      mkdirSync(bundleRoot, { recursive: true });
      writeFileSync(join(bundleRoot, "existing.md"), "---\ntype: Knowledge\ntitle: Existing\n---\n\nExisting verified knowledge.\n");
    },
  });
  const evidence = appendWorkflowEvent(built.projectRoot, createWorkflowEvent({
    eventId: "preserve-evidence", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "artifact.recorded", producer: "harness",
    payload: { formatVersion: 1, nodeId: "root", contentHash: `sha256:${"7".repeat(64)}` },
  }));
  new KnowledgeEnrichmentService({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, createCandidateId: () => "preserve-candidate" })
    .propose("root", "preserve-attempt", { scope: "shared", conclusion: "Preserved cancellation evidence remains durable.", evidenceEventIds: [evidence.eventId] });
  const cancelled = await built.service.cancel("preserve evidence", { preserveKnowledge: true });
  assert.equal(cancelled.envelope.status, "cancelled");
  await new Promise((resolve) => setImmediate(resolve));
  const events = readWorkflowJournal(built.projectRoot, "session-1");
  const preservation = events.find((event) => (event.payload as any).operation === "cancel-preservation-requested")!;
  const terminal = events.find((event) => event.type === "terminal.recorded")!;
  const enqueue = events.find((event) => (event.payload as any).operation === "jobs-enqueued")!;
  assert.ok(preservation.sequence < terminal.sequence && terminal.sequence < enqueue.sequence, "production preservation policy evidence must precede the exact cancelled terminal and enqueue");
  assert.equal(events.filter((event) => (event.payload as any).operation === "jobs-enqueued").length, 1);
  assert.equal(events.some((event) => (event.payload as any).reason === "cancelled-not-preserved"), false);
  await built.service.shutdown();
});

test("restart reconciles knowledge_propose after candidate publication before attempt result", () => {
  const active = snapshot() as any;
  const authority = active.payload.authority.nodes.find((node: any) => node.nodeId === "root");
  authority.capabilities.effective = { ...authority.capabilities.effective, knowledge: ["propose"] };
  authority.tools = [...new Set([...authority.tools, "knowledge_propose"])].sort();
  const built = fixture(undefined, active);
  const firstEvidence = appendWorkflowEvent(built.projectRoot, createWorkflowEvent({
    eventId: "reconcile-evidence-first", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "artifact.recorded", producer: "harness",
    payload: { formatVersion: 1, nodeId: "root", contentHash: `sha256:${"9".repeat(64)}` },
  }));
  const secondEvidence = appendWorkflowEvent(built.projectRoot, createWorkflowEvent({
    eventId: "reconcile-evidence-second", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "artifact.recorded", producer: "harness",
    payload: { formatVersion: 1, nodeId: "root", contentHash: `sha256:${"8".repeat(64)}` },
  }));
  const input = {
    scope: "shared" as const,
    conclusion: "Published candidate proves its exact tool result on restart.",
    evidenceEventIds: [secondEvidence.eventId, firstEvidence.eventId],
  };
  const attempts = new AttemptRuntime({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1" });
  attempts.begin({ attemptId: "crash-attempt", correlationId: "crash-correlation", nodeId: "root", operation: "workflow.tool.knowledge_propose", input, descriptor: { effect: "tool", readOnly: false, idempotent: false } });
  const candidate = new KnowledgeEnrichmentService({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, createCandidateId: () => "reconciled-candidate" }).propose("root", "crash-attempt", input);
  assert.equal(attempts.restore().attempts["crash-attempt"].result, undefined, "fault boundary leaves only publication proof");

  const restarted = new RunOrchestrationService(built.options);
  restarted.rootServices();
  const recovered = restarted.attemptRuntime().restore().attempts["crash-attempt"];
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.reconciliation, "applied");
  assert.deepEqual(recovered.result?.value, candidate);
});

test("knowledge_propose restart reconciliation cannot use a same-attempt publication from an earlier run", async () => {
  const active = snapshot() as any;
  const authority = active.payload.authority.nodes.find((node: any) => node.nodeId === "root");
  authority.capabilities.effective = { ...authority.capabilities.effective, knowledge: ["propose"] };
  authority.tools = [...new Set([...authority.tools, "knowledge_propose"])].sort();
  let run = 0;
  const built = fixture(undefined, active, undefined, { createRunId: () => `run-${++run}` });
  const evidence = appendWorkflowEvent(built.projectRoot, createWorkflowEvent({
    eventId: "cross-run-evidence", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "artifact.recorded", producer: "harness",
    payload: { formatVersion: 1, nodeId: "root", contentHash: `sha256:${"7".repeat(64)}` },
  }));
  const input = { scope: "shared" as const, conclusion: "Attempt identities are scoped to their exact workflow run.", evidenceEventIds: [evidence.eventId] };
  new KnowledgeEnrichmentService({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, createCandidateId: () => "run-one-candidate" })
    .propose("root", "same-attempt", input);
  const terminal = await built.service.lifecycle.finish({ status: "completed", summary: "complete run one" }, { callerNodeId: "root", toolBatch: ["workflow_finish"] });
  assert.equal(terminal.ok, true);
  built.service.lifecycle.recordUserInput({ inputId: "input-2", text: "second run", source: "interactive" });
  const delivery = built.service.lifecycle.prepareInputDelivery("delivery-2");
  built.service.lifecycle.confirmInputDelivery(delivery.requestId);
  const runTwoAttempts = new AttemptRuntime({ projectRoot: built.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-2" });
  runTwoAttempts.begin({ attemptId: "same-attempt", correlationId: "same-correlation", nodeId: "root", operation: "workflow.tool.knowledge_propose", input, descriptor: { effect: "tool", readOnly: false, idempotent: false } });

  const restarted = new RunOrchestrationService(built.options);
  assert.throws(() => restarted.rootServices(), /recovery|unknown-side-effect|unresolved/i);
  const recovered = runTwoAttempts.restore().attempts["same-attempt"];
  assert.equal(recovered.result, undefined);
  assert.equal(recovered.status, "unknown_side_effect");
});

test("actual knowledge_read delivers escape-heavy pages within bounds and journals only returned pages", async () => {
  const active = snapshot() as any;
  active.payload.workflow.team.nodes[0].knowledge = { resolved: ["shared"] };
  active.payload.knowledge = [{ id: "shared", provider: "okf", path: "custom/knowledge/shared", updates: "reviewed", metadataFingerprint: "a".repeat(64), attachedNodeIds: ["root"] }];
  const rootAuthority = active.payload.authority.nodes.find((node: any) => node.nodeId === "root");
  rootAuthority.capabilities.effective = { ...rootAuthority.capabilities.effective, knowledge: ["read"] };
  rootAuthority.capabilities.attachments.knowledge = ["shared"];
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "knowledge_read", "knowledge_search"])].sort();
  const built = fixture(undefined, active);
  const directory = join(built.projectRoot, "custom/knowledge/shared");
  mkdirSync(directory, { recursive: true });
  const exact = `---\ntype: Reference\ntitle: Escaped delivery\n---\n\n${"\\\"\u0000\u0001\n".repeat(12_000)}`;
  writeFileSync(join(directory, "escaped.md"), exact);
  for (const nodeId of ["root", "worker", "leaf"]) {
    const policy = built.service.toolPolicyForNode(nodeId);
    const blocked = await policy.hook({ toolName: "read", input: { path: "custom/knowledge/shared/escaped.md" } });
    assert.equal(blocked?.block, true, `${nodeId} actual generic file policy must protect the custom knowledge root`);
    assert.match(blocked?.reason ?? "", /protected knowledge path/i);
  }
  const root = built.service.rootServices();
  let cursor: string | undefined;
  let reconstructed = "";
  const returnedHashes: string[] = [];
  do {
    const result = await root.runWithToolRuntime(() => call("knowledge_read", {
      bundleId: "shared", documentId: "escaped", ...(cursor ? { cursor } : {}),
    }));
    assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= TOOL_CONTRACT_LIMITS.outputBytes);
    const page = result.details as any;
    assert.ok(page.returnedBytes > 0);
    reconstructed += page.content;
    returnedHashes.push(page.returnedContentHash);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(reconstructed, exact);
  const events = readWorkflowJournal(built.projectRoot, "session-1").filter((event) => event.type === "knowledge.transition");
  assert.equal(events.length, returnedHashes.length, "only pages returned through the actual tool are journaled");
  assert.deepEqual(events.map((event) => (event.payload as any).returnedContentHash), returnedHashes);
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

test("mixed delegate_agent and human_question sibling batches reject atomically in both orders and concurrently across restart", async () => {
  for (const order of [["delegate_agent", "human_question"], ["human_question", "delegate_agent"]] as const) {
    for (const concurrent of [false, true]) {
      const active = snapshot() as any;
      const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
      rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
      rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
      const built = fixture(undefined, active);
      const results = await built.service.rootServices().runWithToolRuntime(() => callMixedSuspensionBatch(order, concurrent));
      assert.equal(results.every((result) => result.status === "rejected"), true);
      for (const result of results) {
        if (result.status === "rejected") assert.match(String(result.reason), /delegate_agent.*human_question|sibling.*batch/i);
      }
      assert.deepEqual(Object.keys(built.service.delegationState().tasks), []);
      assert.deepEqual(Object.keys(built.service.questionControls().restore().questions), []);
      assert.equal(readWorkflowJournal(built.projectRoot, "session-1").some((event) => event.type === "task.accepted" || event.type === "question.transition"), false);

      const restarted = new RunOrchestrationService(built.options);
      assert.deepEqual(Object.keys(restarted.delegationState().tasks), []);
      assert.deepEqual(Object.keys(restarted.questionControls().restore().questions), []);
    }
  }
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

test("root and linked worker plumbing consume the compiled knowledge policy hook", async () => {
  const active = snapshot() as any;
  active.payload.knowledge = [{ id: "shared", provider: "okf", path: "custom/knowledge/shared", updates: "reviewed", metadataFingerprint: "a".repeat(64), attachedNodeIds: [] }];
  for (const authority of active.payload.authority.nodes) authority.capabilities.effective = {
    ...(authority.capabilities.effective ?? {}),
    filesystem: [{ path: ".", operations: ["read", "create", "update", "delete"], include: [], exclude: [], ceilingClause: 0 }],
    shell: ["inspect"],
  };
  let workerBlocked = false;
  const built = fixture(async (input) => ({
    linkedSessionId: `linked-${input.nodeId}`,
    async prompt() {
      assert.ok(input.toolPolicy, "linked worker factory must receive its exact compiled node policy");
      workerBlocked = Boolean(await input.toolPolicy.hook({ toolName: "bash", input: { command: "find -H custom/knowledge/shared -name '*.md'" } }));
      return "policy consumed";
    },
    dispose() {},
  }), active);
  const directory = join(built.projectRoot, "custom/knowledge/shared");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "secret.md"), "protected");
  const rootPolicy = built.service.toolPolicyForNode("root");
  assert.equal(Boolean(await rootPolicy.hook({ toolName: "bash", input: { command: "cat custom/knowledge/shared/secret.md" } })), true);
  await built.service.rootServices().runWithToolRuntime(() => call("delegate_agent", { targetNodeId: "worker", objective: "consume linked policy", deliverables: [] }));
  await built.service.runWorkers();
  assert.equal(workerBlocked, true, "linked session must consume policy before the simulated tool effect");
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

test("human_question tool suspends headless work, releases the slot, and resumes only on explicit owner execution", async () => {
  const active = snapshot() as any;
  const workerAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "worker");
  workerAuthority.capabilities.effective = { ...(workerAuthority.capabilities.effective ?? {}), "human-input": true };
  workerAuthority.tools = [...new Set([...workerAuthority.tools, "human_question"])].sort();
  let prompts = 0;
  let sessions = 0;
  const { service } = fixture(async (input) => {
    sessions++;
    return {
      linkedSessionId: `linked-${input.nodeId}`,
      async prompt(_text, _signal, current) {
        prompts++;
        if (prompts === 1) {
          const pending = await current!.runWithToolRuntime!(() => call("human_question", { prompt: "Proceed?", kind: "confirm", required: true }));
          assert.equal((pending.details as any).state, "pending");
          return "turn ended for human";
        }
        assert.equal(current!.promptContext.taskContract.acceptedAnswers[0].answer.value, true);
        return "resumed after human";
      },
      dispose() {},
    };
  }, active);
  const root = service.rootServices();
  root.delegate({ targetNodeId: "worker", objective: "ask before proceeding", deliverables: [] });
  await service.runWorkers();
  assert.equal(service.lifecycle.restore().latestRun?.status, "waiting_for_human");
  assert.equal(service.activeWorkerCount(), 0);
  const pending = service.questionControls().status({ state: "pending" });
  assert.equal(pending.items.length, 1);
  service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: pending.items[0].questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "answer-1" });
  assert.equal(prompts, 1, "offline answer append must never execute a model");
  await service.runWorkers();
  assert.equal(prompts, 2);
  assert.equal(sessions, 1, "resume must reuse the same node/run transcript session");
  assert.equal(service.lifecycle.restore().latestRun?.status, "running");
});

test("sequential sibling human_question calls persist one same-attempt batch and resume after both answer orders across restart", async () => {
  for (const answerOrder of [[0, 1], [1, 0]] as const) {
    const active = snapshot() as any;
    const workerAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "worker");
    workerAuthority.capabilities.effective = { ...(workerAuthority.capabilities.effective ?? {}), "human-input": true };
    workerAuthority.tools = [...new Set([...workerAuthority.tools, "human_question"])].sort();
    let prompts = 0;
    let sessions = 0;
    const resumedAnswerPages: boolean[][] = [];
    const factory: WorkerSessionFactory = async (input) => {
      sessions++;
      return {
        linkedSessionId: `multi-question-${input.nodeId}-${sessions}`,
        async prompt(_text, _signal, current) {
          prompts++;
          if (prompts === 1) {
            const created = await current!.runWithToolRuntime!(() => callSequentialQuestionBatch([
              { prompt: "First sibling?", kind: "confirm", required: true },
              { prompt: "Second sibling?", kind: "confirm", required: true },
            ]));
            assert.deepEqual(created.map((entry) => entry.details.state), ["pending", "pending"]);
            return "suspended for sibling questions";
          }
          const values = current!.promptContext.taskContract.acceptedAnswers.map((answer) => answer.answer.value as boolean);
          resumedAnswerPages.push(values);
          return values.includes(false) ? "resumed after sibling answers" : "continue sibling answer delivery";
        },
        dispose() {},
      };
    };
    const built = fixture(factory, active);
    const delegated = built.service.rootServices().delegate({ targetNodeId: "worker", objective: "ask sibling questions", deliverables: [] });
    await built.service.runWorkers();
    const pending = built.service.questionControls().status({ state: "pending" }).items;
    assert.equal(pending.length, 2);
    assert.equal(built.service.activeWorkerCount(), 0, "one worker slot is released for the complete question batch");
    const taskBeforeAnswers = built.service.delegationState().tasks[delegated.taskId];
    assert.equal(taskBeforeAnswers.queueState, "suspended");
    assert.equal(taskBeforeAnswers.suspendedOnQuestionIds?.length, 2);
    assert.equal(new Set(Object.values(built.service.questionControls().restore().questions).map((question) => question.taskAttemptId)).size, 1);

    const answer = (service: RunOrchestrationService, index: number) => service.questionControls().answer({
      projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: pending[index].questionId,
      expectedState: "pending", value: index === 0, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: `sibling-answer-${answerOrder.join("-")}-${index}`,
    });
    answer(built.service, answerOrder[0]);
    assert.equal(prompts, 1);
    assert.equal(built.service.delegationState().tasks[delegated.taskId].queueState, "suspended", "one answer cannot resume a multi-question batch");

    const restarted = new RunOrchestrationService(built.options);
    await assert.rejects(() => restarted.runWorkers(), /running|human|question/i);
    assert.equal(prompts, 1, "restart with one pending sibling cannot execute the provider");
    answer(restarted, answerOrder[1]);
    await restarted.runWorkers();
    assert.equal(restarted.delegationState().tasks[delegated.taskId].result, undefined, "each bounded answer page yields to the owner before another model turn");
    for (let turn = 0; turn < 3 && !restarted.delegationState().tasks[delegated.taskId].result; turn++) await restarted.runWorkers();
    const completed = restarted.delegationState().tasks[delegated.taskId];
    assert.equal(completed.result?.summary, "resumed after sibling answers");
    assert.equal(completed.attempts.length, 1, "the sibling batch resumes the immutable delegation attempt");
    assert.equal(prompts, 3, "bounded answer pages resume only after the complete sibling set is answered");
    assert.deepEqual(resumedAnswerPages, [[true], [false]]);
  }
});

test("a pre-bound offline answer advances a durable continuation turn after known provider rejection and is delivered once across restart", async () => {
  const active = snapshot() as any;
  const workerAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "worker");
  workerAuthority.capabilities.effective = { ...(workerAuthority.capabilities.effective ?? {}), "human-input": true };
  workerAuthority.tools = [...new Set([...workerAuthority.tools, "human_question"])].sort();
  let prompts = 0;
  const seen: string[][] = [];
  const built = fixture(async () => ({ linkedSessionId: "offline-known-failure", async prompt(_text, _signal, current) {
    prompts++;
    seen.push(current!.promptContext.taskContract.acceptedAnswers.map((answer) => answer.questionId));
    if (prompts === 1) {
      await current!.runWithToolRuntime!(() => call("human_question", { prompt: "Continue offline?", kind: "confirm", required: true }));
      return "waiting";
    }
    return "answer consumed after safe continuation";
  }, dispose() {} }), active);
  const delegated = built.service.rootServices().delegate({ targetNodeId: "worker", objective: "offline known failure", deliverables: [] });
  await built.service.runWorkers();
  const pending = built.service.questionControls().status({ state: "pending" }).items[0];
  built.service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: pending.questionId,
    expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "offline-known-answer" });

  const questionService = built.service.questionControls();
  const delivery = questionService.prepareTaskAnswerDeliveries(delegated.taskId)[0];
  const taskBeforeFailure = built.service.delegationState().tasks[delegated.taskId];
  const promptContext = deriveWorkerPromptContext(active, taskBeforeFailure, [], "session-1", delivery.answers);
  const promptHash = createHash("sha256").update(promptContext.assembledPrompt).digest("hex");
  const transcriptRef = `run:run-1/node:worker/task:${delegated.taskId}/transcript`;
  const failedCorrelation = `worker-model-${delegated.taskId}-${promptHash.slice(0, 24)}-turn-0`;
  await assert.rejects(() => executeWithConservativeRetry(built.service.attemptRuntime(), {
    correlationId: failedCorrelation, nodeId: "worker", operation: "worker.provider.prompt",
    input: { requestInput: { taskId: delegated.taskId, promptHash, questionContinuationTurn: 0 }, consumerReceipt: { deliveryIds: [delivery.deliveryId], promptHash, transcriptRef } },
    replayInput: { taskId: delegated.taskId }, descriptor: attemptDescriptorForModel(),
    consumerReceipt: { deliveryIds: [delivery.deliveryId], promptHash, transcriptRef },
    dispatch: async () => { throw Object.assign(new Error("known provider rejection"), {
      effectNotApplied: true, transient: false, assistantOutputObserved: false, toolCallObserved: false,
    }); },
  }), /known provider rejection/i);

  const restarted = new RunOrchestrationService(built.options);
  await restarted.runWorkers();
  assert.equal(prompts, 1, "replaying a durable known failure advances state and yields before a fresh provider turn");
  await restarted.runWorkers();
  const task = restarted.delegationState().tasks[delegated.taskId];
  const question = restarted.questionControls().restore().questions[pending.questionId];
  const attempts = Object.values(restarted.attemptRuntime().restore().attempts).filter((attempt) => attempt.operation === "worker.provider.prompt");
  const failed = attempts.find((attempt) => attempt.correlationId === failedCorrelation);
  const completed = attempts.find((attempt) => attempt.attemptId === question.taskDeliveryReceipt?.attemptId);
  assert.equal(prompts, 2, "restart replays the known failure once, then makes one fresh bounded provider dispatch");
  assert.deepEqual(seen.map((ids) => ids.length), [0, 1]);
  assert.equal(task.result?.summary, "answer consumed after safe continuation");
  assert.equal(task.attempts.length, 1, "continuation preserves the delegation attempt and transcript");
  assert.equal(task.questionContinuationTurn, 1);
  assert.ok(failed?.status === "failed" && completed?.status === "completed");
  assert.notEqual(question.taskDeliveryReceipt?.attemptId, failed.attemptId, "a failed provider attempt cannot acknowledge the answer");
  assert.equal(question.taskDeliveryReceipt?.attemptId, completed.attemptId);
  assert.ok(question.taskDeliveryAcceptedSequence);
});

test("persistent known provider failures and budget denial yield bounded owner turns without false answer acknowledgement", async () => {
  const active = snapshot() as any;
  const workerAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "worker");
  workerAuthority.capabilities.effective = { ...(workerAuthority.capabilities.effective ?? {}), "human-input": true };
  workerAuthority.tools = [...new Set([...workerAuthority.tools, "human_question"])].sort();
  const ampleNode = { maxAgentTurns: 10, maxToolCalls: 100, tokenBudget: 10_000_000, activeWallTimeMs: 60_000 };
  const budgetLimits: EffectiveRuntimeBudgetLimits = {
    run: { maxParallel: 1, maxDelegations: 10, maxToolCalls: 100, tokenBudget: 10_000_000, activeWallTimeMs: 60_000 },
    nodes: { root: ampleNode, worker: { ...ampleNode, maxAgentTurns: 3 }, leaf: ampleNode },
  };
  let prompts = 0;
  const built = fixture(async () => ({ linkedSessionId: "persistent-known-budget", async prompt(_text, _signal, current) {
    prompts++;
    if (prompts === 1) {
      await current!.runWithToolRuntime!(() => call("human_question", { prompt: "Continue until budget?", kind: "confirm", required: true }));
      return "waiting";
    }
    throw Object.assign(new Error("persistent known provider rejection"), {
      effectNotApplied: true, transient: false, assistantOutputObserved: false, toolCallObserved: false,
    });
  }, dispose() {} }), active, undefined, { budgetLimits });
  const delegated = built.service.rootServices().delegate({ targetNodeId: "worker", objective: "persistent known failure", deliverables: [] });
  await built.service.runWorkers();
  const pending = built.service.questionControls().status({ state: "pending", limit: 1 }).items[0];
  built.service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: pending.questionId,
    expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "persistent-known-answer" });

  const boundedRun = (owner: RunOrchestrationService) => Promise.race([
    owner.runWorkers().then(() => "settled" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
  ]);
  assert.equal(await boundedRun(built.service), "settled", "one known failure must return control without an automatic fresh turn");
  assert.equal(await boundedRun(built.service), "settled", "a second explicit owner turn may retry once");
  assert.equal(await boundedRun(built.service), "settled", "budget denial and terminal CAS loss must durably yield");
  const restarted = new RunOrchestrationService(built.options);
  assert.equal(await boundedRun(restarted), "settled", "restart at exhausted budget must remain finite");

  const task = restarted.delegationState().tasks[delegated.taskId];
  const question = restarted.questionControls().restore().questions[pending.questionId];
  const modelAttempts = Object.values(restarted.attemptRuntime().restore().attempts).filter((attempt) => attempt.operation === "worker.provider.prompt");
  const starts = readWorkflowJournal(built.projectRoot, "session-1").filter((event) => event.type === "task.started");
  assert.equal(prompts, 3, "only the two explicitly requested post-answer provider turns run before budget exhaustion");
  assert.equal(starts.length, 5, "each owner call starts the same attempt at most once");
  assert.equal(modelAttempts.length, 5, "provider and denied model attempts remain finite across restart");
  assert.equal(task.attempts.length, 1, "all continuations preserve the immutable delegation attempt");
  assert.equal(task.queueState, "active");
  assert.equal(task.questionContinuationTurn, 4);
  assert.equal(question.taskDeliveryReceipt, undefined);
  assert.equal(question.taskDeliveryAcceptedSequence, undefined);
});

test("a pre-bound offline answer with unknown provider effects pauses recovery across restart without acknowledgement or redispatch", async () => {
  const active = snapshot() as any;
  const workerAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "worker");
  workerAuthority.capabilities.effective = { ...(workerAuthority.capabilities.effective ?? {}), "human-input": true };
  workerAuthority.tools = [...new Set([...workerAuthority.tools, "human_question"])].sort();
  let prompts = 0;
  const built = fixture(async () => ({ linkedSessionId: "offline-unknown-failure", async prompt(_text, _signal, current) {
    prompts++;
    if (prompts === 1) {
      await current!.runWithToolRuntime!(() => call("human_question", { prompt: "Continue offline?", kind: "confirm", required: true }));
      return "waiting";
    }
    throw new Error("provider outcome unknown");
  }, dispose() {} }), active);
  const delegated = built.service.rootServices().delegate({ targetNodeId: "worker", objective: "offline unknown failure", deliverables: [] });
  await built.service.runWorkers();
  const pending = built.service.questionControls().status({ state: "pending" }).items[0];
  built.service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: pending.questionId,
    expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "offline-unknown-answer" });
  await assert.rejects(() => built.service.runWorkers(), /unknown|recovery|paused|side effect/i);
  assert.equal(prompts, 2);

  const restarted = new RunOrchestrationService(built.options);
  await assert.rejects(() => restarted.runWorkers(), /unknown|recovery|paused|side effect/i);
  const task = restarted.delegationState().tasks[delegated.taskId];
  const question = restarted.questionControls().restore().questions[pending.questionId];
  const unresolved = Object.values(restarted.attemptRuntime().restore().attempts).filter((attempt) => attempt.status === "unknown_side_effect");
  assert.equal(prompts, 2, "restart does not redispatch a recovery-required provider attempt");
  assert.equal(unresolved.length, 1);
  assert.equal(task.attempts.length, 1);
  assert.equal(task.queueState, "active");
  assert.equal(question.taskDeliveryReceipt, undefined, "unknown provider effects never acknowledge the answer");
  assert.equal(question.taskDeliveryAcceptedSequence, undefined);
  assert.equal(restarted.lifecycle.restore().latestRun?.status, "paused");
});

test("fast dashboard answers force same-attempt worker continuation before terminalization after provider return or failure", async () => {
  for (const providerFailure of [false, true]) {
    const active = snapshot() as any;
    const workerAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "worker");
    workerAuthority.capabilities.effective = { ...(workerAuthority.capabilities.effective ?? {}), "human-input": true };
    workerAuthority.tools = [...new Set([...workerAuthority.tools, "human_question"])].sort();
    const holder: { service?: RunOrchestrationService } = {};
    const seen: string[][] = [];
    let prompts = 0;
    const built = fixture(async () => ({ linkedSessionId: `fast-answer-${providerFailure}`, async prompt(_text, _signal, current) {
      prompts++;
      seen.push(current!.promptContext.taskContract.acceptedAnswers.map((answer) => answer.questionId));
      if (prompts === 1) {
        const first = await current!.runWithToolRuntime!(() => call("human_question", { prompt: "First?", kind: "confirm", required: true }));
        const second = holder.service!.questionControls().create({ nodeId: "worker", taskId: "task-1", definition: { prompt: "Second?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: `fast-second-${providerFailure}` } });
        for (const [index, questionId] of [first.details.questionId, second.questionId].entries()) {
          holder.service!.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId, expectedState: "pending", value: index === 0, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: `fast-answer-${providerFailure}-${index}` });
        }
        if (providerFailure) throw new Error("provider failed after answered questions");
        return "must not terminalize";
      }
      assert.deepEqual(current!.promptContext.taskContract.acceptedAnswers.map((answer) => answer.answer.value), [true, false]);
      return "continued after both answers";
    }, dispose() {} }), active);
    holder.service = built.service;
    const service = built.service;
    const delegated = service.rootServices().delegate({ targetNodeId: "worker", objective: "fast answer", deliverables: [] });
    try {
      await service.runWorkers();
      for (let turn = 0; turn < 3 && !service.delegationState().tasks[delegated.taskId].result; turn++) await service.runWorkers();
    } catch (error) {
      const unresolved = Object.values(service.attemptRuntime().restore().attempts).filter((attempt) => !attempt.result).map((attempt) => ({ operation: attempt.operation, inputHash: attempt.inputHash, status: attempt.status, diagnostic: attempt.diagnostic }));
      throw new Error(`fast-answer mode providerFailure=${providerFailure} failed: ${String(error instanceof Error ? error.message : error)}; unresolved=${JSON.stringify(unresolved)}`);
    }
    const task = service.delegationState().tasks[delegated.taskId];
    assert.equal(task.result?.status, "completed");
    assert.equal(task.result?.summary, "continued after both answers");
    assert.equal(task.attempts.length, 1, "answer continuation preserves the durable worker attempt");
    assert.deepEqual(seen.map((ids) => ids.length), [0, 2]);
  }
});

test("pending root questions block only root dispatch while queued and active workers keep progressing", async () => {
  const active = snapshot() as any;
  const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
  let releaseWorker!: () => void;
  let workerStarted!: () => void;
  const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
  const started = new Promise<void>((resolve) => { workerStarted = resolve; });
  let workerPrompts = 0;
  const { service } = fixture(async () => ({ linkedSessionId: "root-local-worker", async prompt() {
    workerPrompts++;
    workerStarted();
    await workerGate;
    return "worker progressed";
  }, dispose() {} }), active);
  const root = service.rootServices();
  root.delegate({ targetNodeId: "worker", objective: "continue independently", deliverables: [] });
  const first = service.questionControls().create({ nodeId: "root", definition: { prompt: "First?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "root-pending-1" } });
  const second = service.questionControls().create({ nodeId: "root", definition: { prompt: "Second?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "root-pending-2" } });
  service.lifecycle.recordUserInput({ inputId: "root-pending-steering", text: "ordinary steering remains root-local", source: "interactive" });
  assert.equal(service.lifecycle.restore().latestRun?.status, "running", "queued worker progress keeps the run-wide state running");
  let rootDispatches = 0;
  await assert.rejects(() => service.rootServices().dispatch.model({ correlationId: "root-blocked-queued", operation: "root.prompt", input: {}, dispatch: async () => { rootDispatches++; return "must not run"; } }), /root.*question|pending.*root|human/i);
  const workers = service.runWorkers();
  await started;
  await assert.rejects(() => service.rootServices().dispatch.model({ correlationId: "root-blocked-active", operation: "root.prompt", input: {}, dispatch: async () => { rootDispatches++; return "must not run"; } }), /root.*question|pending.*root|human/i);
  service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: second.questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "root-second-answer" });
  await assert.rejects(() => service.rootServices().dispatch.model({ correlationId: "root-blocked-one-left", operation: "root.prompt", input: {}, dispatch: async () => { rootDispatches++; return "must not run"; } }), /root.*question|pending.*root|human/i);
  releaseWorker();
  await workers;
  assert.equal(workerPrompts, 1);
  assert.equal(rootDispatches, 0);
  service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: first.questionId, expectedState: "pending", value: false, channel: "command", claimedIdentity: "human", credential: "secret", operationId: "root-first-answer" });
  await service.rootServices().dispatch.model({ correlationId: "root-unblocked", operation: "root.prompt", input: {}, dispatch: async () => { rootDispatches++; return "ran"; } });
  assert.equal(rootDispatches, 1);
});

test("ordinary root steering stays non-runnable while the root transcript is question-suspended", () => {
  const active = snapshot() as any;
  const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
  const { service } = fixture(undefined, active);
  service.questionControls().create({ nodeId: "root", definition: { prompt: "Choose?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "root-steering-gate" } });
  service.lifecycle.recordUserInput({ inputId: "root-steering-pending", text: "ordinary steering is not an answer", source: "interactive" });
  service.rootServices();
  assert.equal(service.lifecycle.restore().latestRun?.status, "waiting_for_human");
  assert.equal(service.budgetState().paused, true, "active wall time pauses while no independent execution is runnable");
});

test("reused root correlation after restart never accepts a newer answer with the old successful attempt", async () => {
  const active = snapshot() as any;
  const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
  const built = fixture(undefined, active);
  const q1 = built.service.questionControls().create({ nodeId: "root", definition: { prompt: "First?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "root-reuse-q1" } });
  built.service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: q1.questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "root-reuse-a1" });
  let providerCalls = 0;
  const first = await built.service.rootServices().dispatch.model({
    correlationId: "root-reused-correlation", operation: "root.prompt", input: { stable: true },
    dispatch: async () => { providerCalls++; return "old successful output"; },
  });
  assert.equal(first, "old successful output");

  const q2 = built.service.questionControls().create({ nodeId: "root", definition: { prompt: "Second?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "root-reuse-q2" } });
  built.service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: q2.questionId, expectedState: "pending", value: false, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "root-reuse-a2" });

  const restarted = new RunOrchestrationService(built.options);
  const replayed = await restarted.rootServices().dispatch.model({
    correlationId: "root-reused-correlation", operation: "root.prompt", input: { stable: true },
    dispatch: async () => { providerCalls++; return "must not replace durable replay"; },
  });
  assert.equal(replayed, "old successful output");
  assert.equal(providerCalls, 1);
  let durableQ2 = restarted.questionControls().restore().questions[q2.questionId];
  assert.equal(durableQ2.rootDeliveryReceipt, undefined, "old attempt must not receipt a delivery absent from its final binding");
  assert.equal(durableQ2.rootDeliveryAcceptedSequence, undefined);

  let deliveredQuestionIds: readonly string[] = [];
  await restarted.rootServices().dispatch.model({
    correlationId: "root-subsequent-continuation", operation: "root.prompt", input: { stable: true },
    dispatch: async (invocation) => { providerCalls++; deliveredQuestionIds = (invocation.rootQuestionDeliveries ?? []).flatMap((delivery) => delivery.questionIds); return "new output"; },
  });
  durableQ2 = restarted.questionControls().restore().questions[q2.questionId];
  assert.deepEqual(deliveredQuestionIds, [q2.questionId]);
  assert.equal(providerCalls, 2);
  assert.ok(durableQ2.rootDeliveryAcceptedSequence);
});

test("process kill after mixed pre-bound and live answers replays the exact successful root or worker attempt", async () => {
  for (const scope of ["root", "worker"] as const) {
    const projectRoot = mkdtempSync(join(tmpdir(), `hive-live-${scope}-kill-`));
    const markerPath = join(projectRoot, `${scope}-provider-calls.txt`);
    const active = snapshot() as any;
    const authority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === scope);
    authority.capabilities.effective = { ...(authority.capabilities.effective ?? {}), "human-input": true };
    authority.tools = [...new Set([...authority.tools, "human_question"])].sort();
    const script = `
      import { appendFileSync } from 'node:fs';
      import { RunOrchestrationService } from './src/workflows/orchestration.ts';
      import { acquireRuntimeOwnership } from './src/workflows/ownership.ts';
      import { GENERIC_WORKFLOW_TOOL_CONTRACTS } from './src/workflows/tools.ts';
      const projectRoot=${JSON.stringify(projectRoot)};
      const snapshot=${JSON.stringify(active)};
      const marker=${JSON.stringify(markerPath)};
      const human=GENERIC_WORKFLOW_TOOL_CONTRACTS.find(entry=>entry.name==='human_question');
      let callSequence=0;
      const call=async(input)=>{ const id='kill-call-'+(++callSequence); const ctx={sessionManager:{getBranch:()=>[{type:'message',message:{role:'assistant',content:[{type:'toolCall',id,name:'human_question',arguments:{}}]}}]}}; return human.execute(id,input,undefined,undefined,ctx); };
      acquireRuntimeOwnership(projectRoot,'session-1',{nonce:'owner-killed'});
      let armed=false, armedWrites=0, seededWorker=false;
      let service;
      service=new RunOrchestrationService({
        projectRoot,projectId:'project-1',sessionId:'session-1',snapshot,runtimeOwnerNonce:'owner-killed',maxParallel:1,
        workerFactory:async()=>({linkedSessionId:'kill-worker',async prompt(_text,_signal,invocation){
          if(!seededWorker){ seededWorker=true; service.questionControls().create({nodeId:'worker',taskId:'task-1',definition:{prompt:'Offline worker?',kind:'confirm',required:true},provenance:{source:'human_question',toolCallId:'worker-offline'}}); return 'worker waits offline'; }
          appendFileSync(marker,'provider\\n'); armed=true; await invocation.runWithToolRuntime(()=>call({prompt:'Worker live?',kind:'confirm',required:true})); return 'worker result survived';
        },dispose(){}}),
        createRunId:()=> 'run-1',createTaskId:()=> 'task-1',createAttemptId:()=> 'attempt-task-1',
        pauseAuthority:{captureState:()=>({}),releaseLeases:()=>{},releaseOwnership:()=>{}},resumeAuthority:{acquireOwnership:()=>{},acquireLeases:()=>{},revalidateHashes:()=>true,rollbackAuthority:()=>{}},
        cancellationAuthority:{terminateProcessTrees:()=>{},capturePartialState:()=>({}),releaseLeases:()=>{}},
        questionControl:{authenticateControl:r=>r.claimedIdentity,presentLive:async()=>({value:true,claimedIdentity:'human',operationId:'kill-live-answer'}),journalFault:(_type,stage)=>{if(armed&&stage==='beforeRename'&&++armedWrites>=5)process.exit(86);}},
      });
      service.lifecycle.recordUserInput({inputId:'input-1',text:'deliver',source:'interactive'}); const delivery=service.lifecycle.prepareInputDelivery('delivery-1'); service.lifecycle.confirmInputDelivery(delivery.requestId);
      if(${JSON.stringify(scope)}==='root') {
        const offline=service.questionControls().create({nodeId:'root',definition:{prompt:'Offline root?',kind:'confirm',required:true},provenance:{source:'human_question',toolCallId:'root-offline'}});
        service.questionControls().answer({projectId:'project-1',sessionId:'session-1',runId:'run-1',questionId:offline.questionId,expectedState:'pending',value:false,channel:'dashboard',claimedIdentity:'human',operationId:'root-offline-answer'});
        const root=service.rootServices(); await root.dispatch.model({correlationId:'root-kill',operation:'root.prompt',input:{stable:true},dispatch:async()=>{appendFileSync(marker,'provider\\n'); armed=true; await root.runWithToolRuntime(()=>call({prompt:'Root live?',kind:'confirm',required:true})); return 'root result survived';}});
      } else {
        service.rootServices().delegate({targetNodeId:'worker',objective:'worker kill',deliverables:[]}); await service.runWorkers();
        const offline=service.questionControls().status({state:'pending'}).items[0]; service.questionControls().answer({projectId:'project-1',sessionId:'session-1',runId:'run-1',questionId:offline.questionId,expectedState:'pending',value:false,channel:'dashboard',claimedIdentity:'human',operationId:'worker-offline-answer'});
        await service.runWorkers();
      }
    `;
    const killed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: process.cwd(), env: { ...process.env, NODE_V8_COVERAGE: "" }, encoding: "utf8" });
    assert.equal(killed.status, 86, killed.stderr);
    const journalDir = join(projectRoot, ".pi", "hive", "sessions", "session-1", "journal");
    for (const name of readdirSync(journalDir).filter((name) => name.startsWith("append.lock"))) unlinkSync(join(journalDir, name));

    const attempts = new AttemptRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1" }).restore();
    const containing = Object.values(attempts.attempts).find((attempt) => attempt.operation === (scope === "root" ? "root.prompt" : "worker.provider.prompt") && attempt.consumerReceipt?.deliveryIds.length === 2);
    assert.equal(containing?.status, "completed");
    assert.equal(containing?.intentConsumerReceipt?.deliveryIds.length, 1);
    assert.equal(containing?.consumerReceipt?.deliveryIds.length, 2);
    const questions = new QuestionService({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, authenticateControl: (request) => request.claimedIdentity });
    const before = Object.values(questions.restore().questions);
    assert.equal(before.length, 2);
    assert.equal(before.some((question) => scope === "root" ? question.rootDeliveryReceipt === undefined : question.taskDeliveryReceipt === undefined), true);
    questions.reconcileAnswerDeliveryReceipts();
    const after = Object.values(questions.restore().questions);
    assert.equal(after.every((question) => Boolean(scope === "root" ? question.rootDeliveryAcceptedSequence : question.taskDeliveryAcceptedSequence)), true);
    assert.equal(readFileSync(markerPath, "utf8").trim().split("\n").length, 1);

    if (scope === "worker") {
      const restarted = new RunOrchestrationService({
        projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: active, runtimeOwnerNonce: "owner-killed", maxParallel: 1,
        workerFactory: async () => ({ linkedSessionId: "restart-worker", async prompt() { appendFileSync(markerPath, "provider\n"); return "must not redispatch"; }, dispose() {} }),
        createTaskId: () => "unused-task", createAttemptId: () => "unused-attempt", verifiedTakeover: () => true,
        pauseAuthority: { captureState: () => ({}), releaseLeases: () => {}, releaseOwnership: () => {} },
        resumeAuthority: { acquireOwnership: () => {}, acquireLeases: () => {}, revalidateHashes: () => true, rollbackAuthority: () => {} },
        cancellationAuthority: { terminateProcessTrees: () => {}, capturePartialState: () => ({}), releaseLeases: () => {} },
        questionControl: { authenticateControl: (request) => request.claimedIdentity },
      });
      await restarted.runWorkers();
      assert.equal(restarted.delegationState().tasks["task-1"].result?.summary, "worker result survived");
      assert.equal(restarted.delegationState().tasks["task-1"].attempts.length, 1);
      assert.equal(readFileSync(markerPath, "utf8").trim().split("\n").length, 1, "successful worker provider result must replay from the durable attempt");
    } else {
      const restarted = new RunOrchestrationService({
        projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: active, runtimeOwnerNonce: "owner-killed", maxParallel: 1,
        workerFactory: async () => ({ linkedSessionId: "unused", prompt: async () => "unused", dispose() {} }),
        createTaskId: () => "unused-task", createAttemptId: () => "unused-attempt",
        pauseAuthority: { captureState: () => ({}), releaseLeases: () => {}, releaseOwnership: () => {} },
        resumeAuthority: { acquireOwnership: () => {}, acquireLeases: () => {}, revalidateHashes: () => true, rollbackAuthority: () => {} },
        cancellationAuthority: { terminateProcessTrees: () => {}, capturePartialState: () => ({}), releaseLeases: () => {} },
        questionControl: { authenticateControl: (request) => request.claimedIdentity },
      });
      const replayed = await restarted.rootServices().dispatch.model({ correlationId: "root-kill", operation: "root.prompt", input: { stable: true }, dispatch: async () => { appendFileSync(markerPath, "provider\n"); return "must not redispatch"; } });
      assert.equal(replayed, "root result survived");
      assert.equal(readFileSync(markerPath, "utf8").trim().split("\n").length, 1);
    }
    assert.deepEqual(scope === "root" ? questions.prepareRootAnswerDeliveries("root") : questions.prepareTaskAnswerDeliveries("task-1"), []);
  }
});

test("a successful live root tool answer is atomically bound to its containing model attempt", async () => {
  const active = snapshot() as any;
  const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
  const { service } = fixture(undefined, active, async () => ({ value: true, claimedIdentity: "root-user", credential: "secret", operationId: "root-live-success-answer" }));
  const root = service.rootServices();
  let questionId = "";
  await root.dispatch.model({ correlationId: "root-live-success", operation: "root.prompt", input: {}, dispatch: async () => {
    const result = await root.runWithToolRuntime(() => call("human_question", { prompt: "Proceed?", kind: "confirm", required: true }));
    questionId = result.details.questionId;
    return "successful containing root turn";
  } });
  const attempt = Object.values(service.attemptRuntime().restore().attempts).find((candidate) => candidate.operation === "root.prompt");
  const question = service.questionControls().restore().questions[questionId];
  assert.deepEqual(attempt?.intentConsumerReceipt?.deliveryIds, []);
  assert.deepEqual(attempt?.consumerReceipt?.deliveryIds, [question.rootDeliveryId]);
  assert.equal(question.rootDeliveryReceipt?.attemptId, attempt?.attemptId);
  assert.ok(question.rootDeliveryAcceptedSequence);
});

test("after-publication live-root receipt faults reconcile without duplicate provider or answer delivery", async () => {
  const active = snapshot() as any;
  const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
  let writes = 0;
  const { service, options } = fixture(undefined, active, async () => ({ value: true, claimedIdentity: "root-user", credential: "secret", operationId: "root-after-answer" }), {
    questionJournalFault: (_type, stage) => { if (stage === "afterRename" && ++writes >= 5) throw new Error("root stop after publication"); },
  });
  const root = service.rootServices();
  let providerCalls = 0;
  await root.dispatch.model({ correlationId: "root-after-publication", operation: "root.prompt", input: {}, dispatch: async () => {
    providerCalls++;
    await root.runWithToolRuntime(() => call("human_question", { prompt: "After publication?", kind: "confirm", required: true }));
    return "root after result";
  } });
  assert.equal(providerCalls, 1);
  const question = Object.values(service.questionControls().restore().questions)[0];
  assert.ok(question.rootDeliveryReceipt);
  assert.ok(question.rootDeliveryAcceptedSequence);
  const restarted = new RunOrchestrationService({ ...options, questionControl: { authenticateControl: options.questionControl.authenticateControl } });
  let reinjected: unknown = "not-called";
  await restarted.rootServices().dispatch.model({ correlationId: "root-after-next", operation: "root.prompt", input: {}, dispatch: async (invocation) => {
    reinjected = invocation.rootQuestionDelivery;
    return "next";
  } });
  assert.equal(reinjected, undefined);
});

test("persistent live-root receipt fault reconstructs from the successful result after restart without redispatch or reinjection", async () => {
  const active = snapshot() as any;
  const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
  let transitionWrites = 0;
  const presenter = async () => ({ value: true, claimedIdentity: "root-user", credential: "secret", operationId: "root-live-persistent-answer" });
  const built = fixture(undefined, active, presenter, { questionJournalFault: (_type, stage) => {
    if (stage === "beforeRename" && ++transitionWrites >= 5) throw new Error("persistent root receipt stop");
  } });
  const root = built.service.rootServices();
  let providerCalls = 0;
  await assert.rejects(() => root.dispatch.model({ correlationId: "root-live-persistent", operation: "root.prompt", input: {}, dispatch: async () => {
    providerCalls++;
    await root.runWithToolRuntime(() => call("human_question", { prompt: "Persist?", kind: "confirm", required: true }));
    return "durable provider result";
  } }), /persistent root receipt stop/i);
  const completed = Object.values(built.service.attemptRuntime().restore().attempts).find((attempt) => attempt.operation === "root.prompt");
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.consumerReceipt?.deliveryIds.length, 1);

  const restarted = new RunOrchestrationService({
    ...built.options,
    questionControl: { authenticateControl: built.options.questionControl.authenticateControl, presentLive: presenter },
  });
  restarted.rootServices();
  assert.equal(providerCalls, 1, "restart receipt reconstruction must not invoke the successful provider again");
  const restoredQuestion = Object.values(restarted.questionControls().restore().questions)[0];
  assert.ok(restoredQuestion.rootDeliveryReceipt);
  assert.ok(restoredQuestion.rootDeliveryAcceptedSequence);
  let reinjected: unknown = "not-called";
  await restarted.rootServices().dispatch.model({ correlationId: "root-after-persistent", operation: "root.prompt", input: {}, dispatch: async (invocation) => {
    reinjected = invocation.rootQuestionDelivery;
    return "new turn";
  } });
  assert.equal(reinjected, undefined);
});

test("a live root answer is accepted only after its containing turn and is recovered once after a failed turn", async () => {
  const active = snapshot() as any;
  const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
  const { service, options } = fixture(undefined, active, async () => ({ value: true, claimedIdentity: "root-user", credential: "secret", operationId: "root-live-fault-answer" }));
  const first = service.rootServices();
  await assert.rejects(() => first.dispatch.model({
    correlationId: "root-live-failed-turn", operation: "root.prompt", input: {},
    dispatch: async () => {
      const result = await first.runWithToolRuntime(() => call("human_question", { prompt: "Proceed?", kind: "confirm", required: true }));
      assert.equal(result.details.answer.value, true);
      throw Object.assign(new Error("crash before containing root turn acceptance"), { effectNotApplied: true, assistantOutputObserved: true });
    },
  }), /containing root turn acceptance/i);

  const restarted = new RunOrchestrationService(options);
  let recoveredIds: string[] = [];
  await restarted.rootServices().dispatch.model({ correlationId: "root-live-recovery", operation: "root.prompt", input: {}, dispatch: async (invocation) => {
    recoveredIds = invocation.rootQuestionDelivery?.questionIds as string[] ?? [];
    assert.match(invocation.promptContext.text, /root-user/);
    return "accepted recovery turn";
  } });
  assert.equal(recoveredIds.length, 1);
  let duplicate: unknown = "not-called";
  await restarted.rootServices().dispatch.model({ correlationId: "root-live-no-duplicate", operation: "root.prompt", input: {}, dispatch: async (invocation) => {
    duplicate = invocation.rootQuestionDelivery;
    return "next turn";
  } });
  assert.equal(duplicate, undefined);
});

test("dashboard and command winners settle a losing live worker presenter without failing or hanging the task", async () => {
  for (const channel of ["dashboard", "command"] as const) {
    const active = snapshot() as any;
    const workerAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "worker");
    workerAuthority.capabilities.effective = { ...(workerAuthority.capabilities.effective ?? {}), "human-input": true };
    workerAuthority.tools = [...new Set([...workerAuthority.tools, "human_question"])].sort();
    let presented!: (questionId: string) => void;
    const presentationStarted = new Promise<string>((resolve) => { presented = resolve; });
    const { service, projectRoot } = fixture(async () => ({
      linkedSessionId: `live-race-${channel}`,
      async prompt(_text, _signal, current) {
        const result = await current!.runWithToolRuntime!(() => call("human_question", { prompt: "Proceed?", kind: "confirm", required: true }));
        assert.equal(result.details.state, "answered");
        assert.equal(result.details.answer.channel, channel);
        return `completed after ${channel}`;
      },
      dispose() {},
    }), active, async (question: any) => {
      presented(question.questionId);
      return new Promise(() => {});
    });
    service.rootServices().delegate({ targetNodeId: "worker", objective: "race", deliverables: [] });
    const workers = service.runWorkers();
    const questionId = await presentationStarted;
    const externalControl = new QuestionService({
      projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active,
      authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
    });
    externalControl.answer({
      projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId, expectedState: "pending", value: true,
      channel, claimedIdentity: "human", credential: "secret", operationId: `winner-${channel}`,
    });
    await Promise.race([workers, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("worker live-answer race hung")), 250))]);
    const task = Object.values(service.delegationState().tasks)[0];
    assert.equal(task.result?.status, "completed");
    assert.equal(task.result?.summary, `completed after ${channel}`);
    const containingAttempt = Object.values(service.attemptRuntime().restore().attempts).find((attempt) => attempt.operation === "worker.provider.prompt");
    const durableQuestion = service.questionControls().restore().questions[questionId];
    assert.equal(containingAttempt?.consumerReceipt?.deliveryIds.includes(durableQuestion.taskDeliveryId!), true, "live worker delivery must bind to the successful containing attempt");
    assert.equal(durableQuestion.taskAttemptId, task.attempts[0].attemptId);
    assert.equal((service as any).current.questions.hasLiveHandles(), false);
  }
});

test("offline root answers resume the same root transcript with one replay-safe delivery", async () => {
  const active = snapshot() as any;
  const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
  const { service } = fixture(undefined, active);
  const root = service.rootServices();
  let pending: any;
  await root.dispatch.model({
    correlationId: "root-question-create", operation: "root.prompt", input: {},
    dispatch: async () => {
      pending = await root.runWithToolRuntime(() => call("human_question", { prompt: "Choose release", kind: "single", choices: [{ value: "stable", label: "Stable" }], required: true }));
      return "root turn suspended";
    },
  });
  assert.equal(pending.details.state, "pending");
  assert.equal(service.lifecycle.restore().latestRun?.status, "waiting_for_human");

  service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: pending.details.questionId, expectedState: "pending", value: "stable", channel: "dashboard", claimedIdentity: "root-owner", credential: "secret", operationId: "root-answer-1" });
  let firstPrompt = "";
  let firstDeliveryId = "";
  const resumed = service.rootServices();
  await resumed.dispatch.model({
    correlationId: "root-answer-delivery-1", operation: "root.prompt", input: {},
    dispatch: async (invocation: any) => {
      firstPrompt = invocation.promptContext.text;
      firstDeliveryId = invocation.rootQuestionDelivery.deliveryId;
      return "continued root transcript";
    },
  });
  assert.match(firstPrompt, /human-answer:.*root-owner/);
  assert.match(firstPrompt, /stable/);
  assert.match(firstDeliveryId, /^root-question-delivery-/);

  let secondDelivery: unknown = "not-called";
  await resumed.dispatch.model({
    correlationId: "root-answer-delivery-2", operation: "root.prompt", input: {},
    dispatch: async (invocation: any) => { secondDelivery = invocation.rootQuestionDelivery; return "next root turn"; },
  });
  assert.equal(secondDelivery, undefined, "an accepted root answer is delivered to the transcript exactly once");
});

test("a consumed handoff and maximum escaped root input preserve a near-bound answer exactly once across restart through terminal progress", async () => {
  const active = snapshot() as any;
  const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
  const handoff = createHandoffPacket({
    projectId: "project-1", workflowId: "source-workflow", sessionId: "source-session", createdAt: "2026-01-01T00:00:00.000Z",
    terminal: {
      runId: "source-run", snapshotId: "a".repeat(64), terminalEventHash: "c".repeat(64),
      status: "completed", summary: "valid near-limit handoff", fileChanges: [], changeCoverage: "recorded",
      artifactRefs: [], evidenceRefs: [], data: { body: "\"".repeat(30_000) }, unsatisfiedGates: [], closedQuestionIds: [],
      partialState: {}, finishedByNodeId: "root", finishedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  let inputLow = 1, inputHigh = 131_072;
  while (inputLow < inputHigh) {
    const candidate = Math.ceil((inputLow + inputHigh) / 2);
    try {
      fixture(undefined, active, undefined, { stagedHandoff: handoff, initialInputText: "\"".repeat(candidate) });
      inputLow = candidate;
    } catch (error) {
      if (!/PAYLOAD_LIMIT|too large/i.test(String(error instanceof Error ? error.message : error))) throw error;
      inputHigh = candidate - 1;
    }
  }
  assert.ok(inputLow < 131_072, "the event envelope, not the semantic input limit, is the escaped-input ceiling");
  assert.throws(() => fixture(undefined, active, undefined, { stagedHandoff: handoff, initialInputText: "\"".repeat(inputLow + 1) }), /PAYLOAD_LIMIT|too large/i);
  const built = fixture(undefined, active, undefined, { stagedHandoff: handoff, initialInputText: "\"".repeat(inputLow) });
  const question = built.service.questionControls().create({
    nodeId: "root", definition: { prompt: "Near bound?", kind: "text", required: true },
    provenance: { source: "human_question", toolCallId: "root-bound-call" },
  });
  const measurement = (answerLength: number) => measureLosslessDynamicPromptDelivery(losslessDynamicPromptInputs({
    provenance: `human-answer:${question.questionId}:dashboard:root-owner`,
    content: {
      questionId: question.questionId, definition: question.definition,
      answer: { value: "\"".repeat(answerLength), channel: "dashboard", identity: "root-owner", operationId: "root-bound-answer", inputHash: `sha256:${"0".repeat(64)}`, answeredAt: "2026-01-01T00:00:01.000Z" },
    },
    ref: `run:run-1/node:root/question:${question.questionId}`,
  }));
  let low = 0, high = QUESTION_LIMITS.textAnswerBytes;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    if (measurement(candidate).encodedBytes <= ROOT_LOSSLESS_DYNAMIC_DELIVERY_LIMITS.encodedBytes) low = candidate;
    else high = candidate - 1;
  }
  built.service.questionControls().answer({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: question.questionId, expectedState: "pending",
    value: "\"".repeat(low), channel: "dashboard", claimedIdentity: "root-owner", credential: "secret", operationId: "root-bound-answer",
  });

  const restarted = new RunOrchestrationService(built.options);
  let delivered = 0;
  await restarted.rootServices().dispatch.model({
    correlationId: "root-bound-consume", operation: "root.prompt", input: {}, dispatch: async (invocation) => {
      delivered += invocation.rootQuestionDeliveries?.flatMap((delivery) => delivery.questionIds).filter((id) => id === question.questionId).length ?? 0;
      assert.equal(invocation.rootQuestionDeliveries?.[0]?.answers[0]?.answer.value, "\"".repeat(low));
      return "consumed near-bound answer";
    },
  });
  const afterConsume = new RunOrchestrationService(built.options);
  await afterConsume.rootServices().dispatch.model({
    correlationId: "root-bound-after", operation: "root.prompt", input: {}, dispatch: async (invocation) => {
      delivered += invocation.rootQuestionDeliveries?.flatMap((delivery) => delivery.questionIds).filter((id) => id === question.questionId).length ?? 0;
      return "continued root transcript";
    },
  });
  assert.equal(delivered, 1, "the accepted answer must reach the same durable root transcript exactly once");
  const restored = afterConsume.questionControls().restore().questions[question.questionId];
  assert.match(restored.rootDeliveryReceipt?.transcriptRef ?? "", /run:run-1\/node:root\/transcript/u);
  assert.ok(restored.rootDeliveryAcceptedSequence);
  const terminal = await afterConsume.lifecycle.finish({ status: "completed", summary: "bounded answer consumed" }, { callerNodeId: "root", toolBatch: ["workflow_finish"] });
  assert.equal(terminal.ok, true, terminal.ok ? "" : terminal.issues.join(" "));
});

test("near-bound JSON-escaped root questions and answers are delivered in exact lossless pages across failure and restart", async () => {
  const active = snapshot() as any;
  const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
  const built = fixture(undefined, active);
  const { service, options } = built;
  const maximumPrompt = `${"\n".repeat(QUESTION_LIMITS.promptBytes - 1)}x`;
  const questions = Array.from({ length: 4 }, (_value, index) => service.questionControls().create({
    nodeId: "root", definition: { prompt: maximumPrompt, kind: "text", required: true },
    provenance: { source: "human_question", toolCallId: `root-page-call-${index}` },
  }));
  const answerMeasurement = (answerLength: number) => measureLosslessDynamicPromptDelivery(losslessDynamicPromptInputs({
    provenance: `human-answer:${questions[0].questionId}:dashboard:human`,
    content: {
      questionId: questions[0].questionId, definition: questions[0].definition,
      answer: { value: "\n".repeat(answerLength), channel: "dashboard", identity: "human", operationId: "root-page-answer-0", inputHash: `sha256:${"0".repeat(64)}`, answeredAt: "2026-01-01T00:00:00.000Z" },
    },
    ref: `run:run-1/node:root/question:${questions[0].questionId}`,
  }));
  let answerLow = 0, answerHigh = QUESTION_LIMITS.textAnswerBytes;
  while (answerLow < answerHigh) {
    const candidate = Math.ceil((answerLow + answerHigh) / 2);
    if (answerMeasurement(candidate).encodedBytes <= ROOT_LOSSLESS_DYNAMIC_DELIVERY_LIMITS.encodedBytes) answerLow = candidate;
    else answerHigh = candidate - 1;
  }
  const maximum = "\n".repeat(answerLow);
  const questionIds = questions.map((question) => question.questionId);
  for (const [index, question] of questions.entries()) {
    service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: question.questionId, expectedState: "pending", value: maximum, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: `root-page-answer-${index}` });
    service.questionControls().prepareRootAnswerDeliveries("root", [question.questionId]);
  }
  assert.equal(service.questionControls().preparedRootAnswerDeliveries("root").length, 4);

  const pages: string[][] = [];
  let failFirstPage = true;
  const dispatchPage = (owner: RunOrchestrationService, ordinal: number) => owner.rootServices().dispatch.model({
    correlationId: `root-answer-page-${ordinal}`, operation: "root.prompt", input: { ordinal }, dispatch: async (invocation) => {
      const deliveries = invocation.rootQuestionDeliveries ?? [];
      const ids = deliveries.flatMap((delivery) => delivery.questionIds);
      assert.ok(ids.length > 0);
      assert.equal(deliveries.flatMap((delivery) => delivery.answers).every((answer) => answer.answer.value === maximum), true);
      pages.push(ids);
      if (failFirstPage) {
        failFirstPage = false;
        throw Object.assign(new Error("known root page failure"), { effectNotApplied: true, assistantOutputObserved: false, toolCallObserved: false });
      }
      return "root page consumed";
    },
  });

  await assert.rejects(() => dispatchPage(service, 0), /known root page failure/i);
  assert.equal(questionIds.every((questionId) => service.questionControls().restore().questions[questionId].rootDeliveryReceipt === undefined), true, "a failed root page acknowledges nothing");
  const restarted = new RunOrchestrationService(options);
  await dispatchPage(restarted, 1);
  const firstAcceptedPage = new Set(pages[1]);
  for (const questionId of questionIds) {
    const restored = restarted.questionControls().restore().questions[questionId];
    assert.equal(restored.rootDeliveryReceipt !== undefined, firstAcceptedPage.has(questionId), "only the exact fitting root page receives a consumer receipt");
    assert.equal(restored.rootDeliveryAcceptedSequence !== undefined, firstAcceptedPage.has(questionId), "only the exact fitting root page is accepted");
  }
  for (let page = 2; page <= 10 && restarted.questionControls().preparedRootAnswerDeliveries("root").length; page++) await dispatchPage(restarted, page);

  assert.deepEqual(pages[1], pages[0], "the failed root page is retried unchanged after restart");
  assert.ok(pages[0].length < questionIds.length, "the root aggregate must require more than one prompt page");
  const successfulIds = pages.slice(1).flat();
  assert.deepEqual(successfulIds, questionIds, "successful root pages are ordered, lossless, and non-overlapping");
  assert.equal(new Set(successfulIds).size, questionIds.length);
  assert.equal(restarted.questionControls().preparedRootAnswerDeliveries("root").length, 0);
  for (const questionId of questionIds) {
    const restored = restarted.questionControls().restore().questions[questionId];
    assert.ok(restored.rootDeliveryReceipt);
    assert.ok(restored.rootDeliveryAcceptedSequence);
  }
});

test("approval waits reject queued worker admission across multiple requests and restart without task mutation", async () => {
  let prompts = 0;
  const { projectRoot, service, options } = fixture(async () => ({ linkedSessionId: "approval-queued", async prompt() { prompts++; return "ran"; }, dispose() {} }));
  const appendApproval = (operation: "request" | "decision", requestId: string) => appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "approval.recorded",
    producer: operation === "request" ? "harness" : "dashboard", timestamp: new Date().toISOString(),
    payload: { formatVersion: 1, subsystem: "checkpoint-approval", operation, requestId },
  }));
  const first = service.rootServices().delegate({ targetNodeId: "worker", objective: "first queued", deliverables: [] });
  const second = service.rootServices().delegate({ targetNodeId: "worker", objective: "second queued", deliverables: [] });
  appendApproval("request", "approval-a");
  appendApproval("request", "approval-b");
  await assert.rejects(() => service.runWorkers(), /approval|waiting|running/i);
  assert.equal(prompts, 0);
  assert.deepEqual([service.delegationState().tasks[first.taskId].queueState, service.delegationState().tasks[second.taskId].queueState], ["queued", "queued"]);
  appendApproval("decision", "approval-a");
  const restarted = new RunOrchestrationService(options);
  await assert.rejects(() => restarted.runWorkers(), /approval|waiting|running/i);
  assert.equal(prompts, 0);
  assert.deepEqual([restarted.delegationState().tasks[first.taskId].queueState, restarted.delegationState().tasks[second.taskId].queueState], ["queued", "queued"]);
  appendApproval("decision", "approval-b");
  await restarted.runWorkers();
  assert.equal(prompts, 2);
});

test("approval waits preserve a question-resume-ready task across runWorkers calls and restart", async () => {
  const activeSnapshot = snapshot() as any;
  const workerAuthority = activeSnapshot.payload.authority.nodes.find((entry: any) => entry.nodeId === "worker");
  workerAuthority.capabilities.effective = { ...(workerAuthority.capabilities.effective ?? {}), "human-input": true };
  workerAuthority.tools = [...new Set([...workerAuthority.tools, "human_question"])].sort();
  let prompts = 0;
  const { projectRoot, service, options } = fixture(async () => ({ linkedSessionId: "approval-resume-ready", async prompt(_text, _signal, current) {
    prompts++;
    if (prompts === 1) await current!.runWithToolRuntime!(() => call("human_question", { prompt: "Resume?", kind: "confirm", required: true }));
    return prompts === 1 ? "waiting" : "resumed";
  }, dispose() {} }), activeSnapshot);
  const delegated = service.rootServices().delegate({ targetNodeId: "worker", objective: "resume ready", deliverables: [] });
  await service.runWorkers();
  const pending = service.questionControls().status({ state: "pending", limit: 1 }).items[0];
  service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: pending.questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "approval-resume-answer" });
  appendWorkflowEvent(projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "approval.recorded", producer: "harness", timestamp: new Date().toISOString(), payload: { formatVersion: 1, subsystem: "checkpoint-approval", operation: "request", requestId: "approval-resume" } }));
  const before = service.delegationState().tasks[delegated.taskId];
  assert.equal(before.queueState, "active");
  assert.ok(before.resumedByQuestionSequence);
  await assert.rejects(() => service.runWorkers(), /approval|waiting|running/i);
  const restarted = new RunOrchestrationService(options);
  await assert.rejects(() => restarted.runWorkers(), /approval|waiting|running/i);
  const preserved = restarted.delegationState().tasks[delegated.taskId];
  assert.equal(preserved.queueState, "active");
  assert.equal(preserved.resumedByQuestionSequence, before.resumedByQuestionSequence);
  assert.equal(prompts, 1);
  appendWorkflowEvent(projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "approval.recorded", producer: "dashboard", timestamp: new Date().toISOString(), payload: { formatVersion: 1, subsystem: "checkpoint-approval", operation: "decision", requestId: "approval-resume" } }));
  await restarted.runWorkers();
  const completed = restarted.delegationState().tasks[delegated.taskId];
  assert.equal(completed.result?.status, "completed", completed.result?.summary);
  assert.equal(completed.attempts.length, 1);
  assert.equal(prompts, 2);
});

test("an approval arising during active work lets that work settle but does not launch the queued successor", async () => {
  let started!: () => void;
  let release!: () => void;
  const startedGate = new Promise<void>((resolve) => { started = resolve; });
  const releaseGate = new Promise<void>((resolve) => { release = resolve; });
  let prompts = 0;
  const { projectRoot, service } = fixture(async () => ({ linkedSessionId: "approval-active", async prompt() {
    prompts++;
    if (prompts === 1) { started(); await releaseGate; }
    return `done-${prompts}`;
  }, dispose() {} }));
  const root = service.rootServices();
  const active = root.delegate({ targetNodeId: "worker", objective: "active", deliverables: [] });
  const queued = root.delegate({ targetNodeId: "worker", objective: "queued", deliverables: [] });
  const running = service.runWorkers();
  await startedGate;
  appendWorkflowEvent(projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "approval.recorded", producer: "harness", timestamp: new Date().toISOString(), payload: { formatVersion: 1, subsystem: "checkpoint-approval", operation: "request", requestId: "approval-active" } }));
  release();
  await running;
  assert.equal(service.delegationState().tasks[active.taskId].result?.status, "completed");
  assert.equal(service.delegationState().tasks[queued.taskId].queueState, "queued");
  assert.equal(prompts, 1);
  appendWorkflowEvent(projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "approval.recorded", producer: "dashboard", timestamp: new Date().toISOString(), payload: { formatVersion: 1, subsystem: "checkpoint-approval", operation: "decision", requestId: "approval-active" } }));
  await service.runWorkers();
  assert.equal(service.delegationState().tasks[queued.taskId].result?.status, "completed");
  assert.equal(prompts, 2);
});

test("root consumer receipt reconciles a before-acceptance fault across restart and a newly answered second question", async () => {
  const active = snapshot() as any;
  const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
  let injectFault = false;
  let markerWrites = 0;
  const built = fixture(undefined, active, undefined, { questionJournalFault: (_type, stage) => {
    if (injectFault && stage === "beforeRename" && ++markerWrites === 3) throw new Error("process stopped before root acceptance publication");
  } });
  const { service, options, projectRoot } = built;
  const q1 = service.questionControls().create({ nodeId: "root", definition: { prompt: "First?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "root-receipt-q1" } });
  service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: q1.questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "root-receipt-a1" });
  injectFault = true;
  const seen: string[][] = [];
  await assert.rejects(() => service.rootServices().dispatch.model({ correlationId: "root-receipt-first", operation: "root.prompt", input: {}, dispatch: async (invocation) => {
    seen.push((invocation.rootQuestionDeliveries ?? []).flatMap((delivery) => delivery.questionIds));
    return "consumer succeeded";
  } }), /acceptance publication/i);
  injectFault = false;
  const receipt = readWorkflowJournal(projectRoot, "session-1").find((event) => event.type === "question.transition" && (event.payload as any).operation === "root-delivery-consumed");
  assert.equal(typeof (receipt?.payload as any)?.promptHash, "string");
  assert.match((receipt?.payload as any)?.attemptId ?? "", /^attempt-/);
  assert.match((receipt?.payload as any)?.transcriptRef ?? "", /run:run-1\/node:root\/transcript/);

  const q2 = service.questionControls().create({ nodeId: "root", definition: { prompt: "Second?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "root-receipt-q2" } });
  service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: q2.questionId, expectedState: "pending", value: false, channel: "command", claimedIdentity: "human", credential: "secret", operationId: "root-receipt-a2" });
  const restarted = new RunOrchestrationService(options);
  await restarted.rootServices().dispatch.model({ correlationId: "root-receipt-second", operation: "root.prompt", input: {}, dispatch: async (invocation) => {
    seen.push((invocation.rootQuestionDeliveries ?? []).flatMap((delivery) => delivery.questionIds));
    return "second consumer succeeded";
  } });
  assert.deepEqual(seen, [[q1.questionId], [q2.questionId]]);
});

test("completed model attempt reconciles a before-publication root receipt fault after restart without provider replay", async () => {
  const active = snapshot() as any;
  const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
  let armed = false;
  let failed = false;
  const built = fixture(undefined, active, undefined, { questionJournalFault: (_type, stage) => {
    if (armed && !failed && stage === "beforeRename") { failed = true; throw new Error("receipt before-publication fault"); }
  } });
  const { service, options } = built;
  const question = service.questionControls().create({ nodeId: "root", definition: { prompt: "Receipt?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "root-receipt-before" } });
  service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: question.questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "root-receipt-before-answer" });
  service.questionControls().prepareRootAnswerDeliveries("root");
  let providerCalls = 0;
  armed = true;
  await assert.rejects(() => service.rootServices().dispatch.model({
    correlationId: "root-receipt-before-attempt", operation: "root.prompt", input: {},
    dispatch: async () => { providerCalls++; return "consumer completed"; },
  }), /receipt before-publication/i);
  assert.equal(providerCalls, 1);
  assert.equal(service.questionControls().restore().questions[question.questionId].rootDeliveryReceipt, undefined);

  armed = false;
  const restarted = new RunOrchestrationService(options);
  await restarted.rootServices().dispatch.model({
    correlationId: "root-receipt-after-restart", operation: "root.prompt", input: {},
    dispatch: async (invocation) => {
      providerCalls++;
      assert.equal(invocation.rootQuestionDelivery, undefined);
      return "next turn";
    },
  });
  const restored = restarted.questionControls().restore().questions[question.questionId];
  assert.ok(restored.rootDeliveryReceipt, "completed containing attempt must reconstruct the missing receipt");
  assert.ok(restored.rootDeliveryAcceptedSequence);
  assert.equal(providerCalls, 2, "restart must not present the accepted answer to the provider twice");
});

test("receipt acceptance reconciliation faults before worker admission and never becomes a worker result", async () => {
  const active = snapshot() as any;
  const workerAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "worker");
  workerAuthority.capabilities.effective = { ...(workerAuthority.capabilities.effective ?? {}), "human-input": true };
  workerAuthority.tools = [...new Set([...workerAuthority.tools, "human_question"])].sort();
  let armed = false;
  let failed = false;
  let prompts = 0;
  const built = fixture(async () => ({ linkedSessionId: "settlement-worker", async prompt() { prompts++; return "unexpected"; }, dispose() {} }), active, undefined, {
    questionJournalFault: (_type, stage) => { if (armed && !failed && stage === "beforeRename") { failed = true; throw new Error("acceptance before-publication fault"); } },
  });
  const delegated = built.service.rootServices().delegate({ targetNodeId: "worker", objective: "settle receipt", deliverables: [] });
  const runtime = (built.service as any).current.runtime;
  runtime.start(delegated.taskId, "attempt-settlement");
  const questions = built.service.questionControls();
  const question = questions.create({ nodeId: "worker", taskId: delegated.taskId, definition: { prompt: "Settle?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "settlement-call" } });
  questions.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: question.questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "settlement-answer" });
  const [delivery] = questions.prepareTaskAnswerDeliveries(delegated.taskId);
  questions.recordTaskAnswerDeliveryReceipt(delivery, { promptHash: "c".repeat(64), attemptId: "attempt-settlement", transcriptRef: `run:run-1/node:worker/task:${delegated.taskId}/transcript` });
  armed = true;

  const restarted = new RunOrchestrationService(built.options);
  await assert.rejects(() => restarted.runWorkers(), /acceptance before-publication/i);
  const unchanged = restarted.delegationState().tasks[delegated.taskId];
  assert.equal(unchanged.queueState, "active");
  assert.equal(unchanged.result, undefined);
  assert.equal(prompts, 0);
  armed = false;
  await restarted.runWorkers();
  assert.equal(restarted.questionControls().restore().questions[question.questionId].taskDeliveryAcceptedSequence !== undefined, true);
});

test("root terminal publication rejects an answered answer until it reaches the transcript", async () => {
  const active = snapshot() as any;
  const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
  const { service } = fixture(undefined, active);
  const question = service.questionControls().create({ nodeId: "root", definition: { prompt: "Late answer?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "terminal-root-call" } });
  service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: question.questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: "terminal-root-answer" });
  await assert.rejects(
    () => service.rootServices().runWithToolRuntime(() => call("workflow_finish", { status: "completed", summary: "must wait" })),
    /transcript|answered|question/i,
  );
  assert.equal(service.lifecycle.restore().latestRun?.status, "running");
});

test("root question waits reconcile with approval waits in both event orders", async () => {
  for (const approvalFirst of [true, false]) {
    const active = snapshot() as any;
    const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
    rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
    rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
    const { projectRoot, service } = fixture(undefined, active);
    const appendApproval = (operation: "request" | "decision") => appendWorkflowEvent(projectRoot, createWorkflowEvent({
      projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "approval.recorded",
      producer: operation === "request" ? "harness" : "dashboard", timestamp: new Date().toISOString(),
      payload: { formatVersion: 1, subsystem: "checkpoint-approval", operation, requestId: "approval-root" },
    }));
    let questionId = "";
    if (approvalFirst) {
      appendApproval("request");
      questionId = service.questionControls().create({
        nodeId: "root", definition: { prompt: "Proceed?", kind: "confirm", required: true },
        provenance: { source: "human_question", toolCallId: "approval-first-root" },
      }).questionId;
      service.rootServices();
    } else {
      const root = service.rootServices();
      await root.dispatch.model({
        correlationId: "root-waits-question-first", operation: "root.prompt", input: {},
        dispatch: async () => {
          const pending = await root.runWithToolRuntime(() => call("human_question", { prompt: "Proceed?", kind: "confirm", required: true }));
          questionId = pending.details.questionId;
          appendApproval("request");
          return "waiting";
        },
      });
    }
    assert.deepEqual(service.lifecycle.restore().latestRun?.waitCauses, ["approval", "question"]);
    appendApproval("decision");
    assert.equal(service.lifecycle.restore().latestRun?.status, "waiting_for_human", "approval alone must not resume while the root question remains");
    await assert.rejects(() => service.rootServices().dispatch.model({ correlationId: "must-not-run", operation: "root.prompt", input: {}, dispatch: async () => "ran" }), /admission|running|wait/i);
    service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: `answer-${approvalFirst}` });
    assert.equal(service.rootServices().context.nodeId, "root");
    assert.equal(service.lifecycle.restore().latestRun?.status, "running");
  }
});

test("worker question waits reconcile with approval waits in both event orders", async () => {
  for (const approvalFirst of [true, false]) {
    const active = snapshot() as any;
    const workerAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "worker");
    workerAuthority.capabilities.effective = { ...(workerAuthority.capabilities.effective ?? {}), "human-input": true };
    workerAuthority.tools = [...new Set([...workerAuthority.tools, "human_question"])].sort();
    let started!: () => void;
    let release!: () => void;
    const startedGate = new Promise<void>((resolve) => { started = resolve; });
    const releaseGate = new Promise<void>((resolve) => { release = resolve; });
    let invocations = 0;
    const { projectRoot, service } = fixture(async () => ({
      linkedSessionId: `worker-waits-${approvalFirst}`,
      async prompt(_text, _signal, current) {
        invocations++;
        if (invocations > 1) return "resumed";
        if (approvalFirst) {
          started();
          await releaseGate;
        } else {
          await current!.runWithToolRuntime!(() => call("human_question", { prompt: "Proceed?", kind: "confirm", required: true }));
          appendApproval("request");
        }
        return "waiting";
      },
      dispose() {},
    }), active);
    const appendApproval = (operation: "request" | "decision") => { appendWorkflowEvent(projectRoot, createWorkflowEvent({
      projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "approval.recorded",
      producer: operation === "request" ? "harness" : "dashboard", timestamp: new Date().toISOString(),
      payload: { formatVersion: 1, subsystem: "checkpoint-approval", operation, requestId: "approval-worker" },
    })); };
    service.rootServices().delegate({ targetNodeId: "worker", objective: "wait", deliverables: [] });
    if (approvalFirst) {
      const running = service.runWorkers();
      await startedGate;
      appendApproval("request");
      service.questionControls().create({
        nodeId: "worker", taskId: "task-1", definition: { prompt: "Proceed?", kind: "confirm", required: true },
        provenance: { source: "human_question", toolCallId: "approval-first-worker" },
      });
      release();
      await running;
    } else await service.runWorkers();
    assert.deepEqual(service.lifecycle.restore().latestRun?.waitCauses, ["approval", "question"]);
    appendApproval("decision");
    assert.equal(service.lifecycle.restore().latestRun?.status, "waiting_for_human");
    const pending = service.questionControls().status({ state: "pending", limit: 1 }).items[0];
    service.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: pending.questionId, expectedState: "pending", value: true, channel: "command", claimedIdentity: "human", credential: "secret", operationId: `worker-answer-${approvalFirst}` });
    await service.runWorkers();
    assert.equal(service.lifecycle.restore().latestRun?.status, "running");
    assert.equal(invocations, 2);
  }
});

test("cancellation question closure derives bounded stable values from the frozen request", async () => {
  const active = snapshot() as any;
  const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
  for (const reasonBytes of [2_048, 2_049, 8_192]) {
    const runId = reasonBytes === 2_049 ? "r".repeat(256) : `run-${reasonBytes}`;
    const reason = "x".repeat(reasonBytes);
    const { service, projectRoot } = fixture(undefined, active, undefined, { runId });
    const question = service.questionControls().create({ nodeId: "root", definition: { prompt: "Cancel?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: `cancel-${reasonBytes}` } });
    const cancelled = await service.cancel(reason);
    assert.equal(cancelled.envelope.status, "cancelled");
    const state = new QuestionService({
      projectRoot, projectId: "project-1", sessionId: "session-1", runId, snapshot: active,
      authenticateControl: (request) => request.claimedIdentity,
    }).restore().questions[question.questionId].closure!;
    assert.ok(Buffer.byteLength(state.reason, "utf8") <= 2_048);
    assert.ok(Buffer.byteLength(state.operationId, "utf8") <= 256);
    assert.match(state.operationId, /sha256|[0-9a-f]{64}/i);
  }
});

test("explicit cancellation closes a pending worker question before publishing its cancelled task result", async () => {
  const active = snapshot() as any;
  const workerAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "worker");
  workerAuthority.capabilities.effective = { ...(workerAuthority.capabilities.effective ?? {}), "human-input": true };
  workerAuthority.tools = [...new Set([...workerAuthority.tools, "human_question"])].sort();
  let questionId = "";
  const { service } = fixture(async () => ({ linkedSessionId: "cancel-question-worker", async prompt(_text, _signal, current) {
    const result = await current!.runWithToolRuntime!(() => call("human_question", { prompt: "Cancel this task?", kind: "confirm", required: true }));
    questionId = result.details.questionId;
    return "suspended";
  }, dispose() {} }), active);
  const delegated = service.rootServices().delegate({ targetNodeId: "worker", objective: "cancel pending question", deliverables: [] });
  await service.runWorkers();
  assert.equal(service.delegationState().tasks[delegated.taskId].queueState, "suspended");
  const questionOptions = service.questionControls().options;
  const cancelled = await service.cancel("explicit cancellation");
  assert.equal(cancelled.envelope.status, "cancelled");
  assert.equal(service.delegationState().tasks[delegated.taskId].result?.status, "cancelled");
  const questionControl = new QuestionService({ ...questionOptions });
  const question = questionControl.restore().questions[questionId];
  assert.equal(question.state, "closed");
  assert.throws(() => questionControl.answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId, expectedState: "pending", value: true, channel: "command", claimedIdentity: "human", credential: "secret", operationId: "late-cancel-answer" }), /terminal|closed|pending|late/i);
});

test("answer-first cancellation terminal-settles resume-ready tasks without consuming their answers", async () => {
  for (const race of ["idle-restart", "executing"] as const) {
    const active = snapshot() as any;
    const workerAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "worker");
    workerAuthority.capabilities.effective = { ...(workerAuthority.capabilities.effective ?? {}), "human-input": true };
    workerAuthority.tools = [...new Set([...workerAuthority.tools, "human_question"])].sort();
    let started!: () => void;
    const startedGate = new Promise<void>((resolve) => { started = resolve; });
    const built = fixture(async () => ({ linkedSessionId: `cancel-answer-${race}`, async prompt(_text, signal, current) {
      if (race === "idle-restart") {
        await current!.runWithToolRuntime!(() => call("human_question", { prompt: "Answer before cancel?", kind: "confirm", required: true }));
        return "suspended";
      }
      started();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return "aborted execution";
    }, dispose() {} }), active);
    const delegated = built.service.rootServices().delegate({ targetNodeId: "worker", objective: `answer-first ${race}`, deliverables: [] });
    let owner = built.service;
    let running: Promise<void> | undefined;
    if (race === "idle-restart") {
      await owner.runWorkers();
    } else {
      running = owner.runWorkers();
      await startedGate;
      owner.questionControls().create({ nodeId: "worker", taskId: delegated.taskId, definition: { prompt: "Race cancellation?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "executing-cancel-question" } });
    }
    const pending = owner.questionControls().status({ state: "pending", limit: 1 }).items[0];
    owner.questionControls().answer({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: pending.questionId, expectedState: "pending", value: true, channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: `cancel-answer-${race}` });
    const questionOptions = owner.questionControls().options;
    if (race === "idle-restart") owner = new RunOrchestrationService(built.options);
    const cancelled = await owner.cancel(`cancel after answer ${race}`);
    await running;
    assert.equal(cancelled.envelope.status, "cancelled");
    const task = owner.delegationState().tasks[delegated.taskId];
    assert.equal(task.queueState, "terminal");
    assert.equal(task.result?.status, "cancelled");
    const question = new QuestionService({ ...questionOptions }).restore().questions[pending.questionId];
    assert.equal(question.state, "answered");
    assert.equal(question.taskDeliveryReceipt, undefined);
    assert.equal(question.taskDeliveryAcceptedSequence, undefined);
    assert.deepEqual(cancelled.envelope.closedQuestionIds, []);
    assert.equal(Object.values(owner.delegationState().tasks).some((candidate) => candidate.queueState !== "terminal"), false);
  }
});

test("cancellation retry with changed text reuses the frozen closure provenance after restart", async () => {
  const active = snapshot() as any;
  const rootAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.effective = { ...(rootAuthority.capabilities.effective ?? {}), "human-input": true };
  rootAuthority.tools = [...new Set([...rootAuthority.tools, "human_question"])].sort();
  let failRelease = true;
  const originalReason = `${"a".repeat(2_048)}original-tail`;
  const { service, options, projectRoot } = fixture(undefined, active, undefined, { cancellationReleaseLeases: () => {
    if (failRelease) { failRelease = false; throw new Error("fault after durable question closure"); }
  } });
  const question = service.questionControls().create({ nodeId: "root", definition: { prompt: "Cancel?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "cancel-retry" } });
  await assert.rejects(() => service.cancel(originalReason), /fault after durable question closure|retryable/i);
  const restarted = new RunOrchestrationService(options);
  const cancelled = await restarted.cancel("different retry text");
  assert.equal(cancelled.envelope.status, "cancelled");
  const events = readWorkflowJournal(projectRoot, "session-1");
  assert.equal(events.filter((event) => event.type === "question.transition" && (event.payload as any).operation === "close-pending").length, 1);
  assert.equal(events.filter((event) => event.type === "terminal.recorded").length, 1);
  const restored = new QuestionService({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, authenticateControl: (request) => request.claimedIdentity }).restore();
  assert.equal(restored.questions[question.questionId].closure?.reason, "a".repeat(2_048));
  assert.equal(restarted.lifecycle.restore().latestRun?.cancellationReason, originalReason);
});

test("orchestration shutdown aborts non-cooperative question presentation before worker settlement", async () => {
  const active = snapshot() as any;
  const workerAuthority = active.payload.authority.nodes.find((entry: any) => entry.nodeId === "worker");
  workerAuthority.capabilities.effective = { ...(workerAuthority.capabilities.effective ?? {}), "human-input": true };
  workerAuthority.tools = [...new Set([...workerAuthority.tools, "human_question"])].sort();
  let presentationStarted!: () => void;
  const started = new Promise<void>((resolve) => { presentationStarted = resolve; });
  const { service } = fixture(async (input) => ({
    linkedSessionId: `linked-${input.nodeId}`,
    async prompt(_text, _signal, current) {
      await current!.runWithToolRuntime!(() => call("human_question", { prompt: "Wait?", kind: "confirm", required: true }));
      return "settled after abort";
    },
    dispose() {},
  }), active, async () => { presentationStarted(); return new Promise(() => {}); });
  service.rootServices().delegate({ targetNodeId: "worker", objective: "ask live", deliverables: [] });
  const running = service.runWorkers();
  await started;
  assert.equal(service.hasLiveHandles(), true);
  const began = Date.now();
  await service.shutdown("test shutdown");
  await running;
  assert.ok(Date.now() - began < 1_000, "question abort must happen before the worker settlement wait");
  assert.equal(service.hasLiveHandles(), false);
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
