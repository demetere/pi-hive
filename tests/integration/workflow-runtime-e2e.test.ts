import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildActivationSnapshot, loadConfigCatalogs, loadConfigProject, resolveConfigWorkflows, writeActivationSnapshot } from "../../src/config/index.ts";
import { OwnedProcessRegistry } from "../../src/capabilities/process.ts";
import { hashArtifactWorkspace } from "../../src/artifacts/hashes.ts";
import { killProcessTree, spawnManaged } from "../../src/core/process.ts";
import { registerWorkflowRunHooks } from "../../src/integration/run-lifecycle.ts";
import { WorkflowProductionRuntimeRegistry } from "../../src/integration/workflow-production-runtime.ts";
import { workflowToolDefinitionsWithRuntime } from "../../src/integration/workflow-tools.ts";
import { readHandoffState } from "../../src/workflows/handoff.ts";
import { resolveHandoffSource, selectWorkflowSession } from "../../src/workflows/navigation.ts";
import { initializeNormalParent, upsertWorkflowLink, type WorkflowSessionLink } from "../../src/workflows/sessions.ts";

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

function fixture(withWorker = false) {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-production-runtime-e2e-"));
  cpSync(join(process.cwd(), "examples/artifact-free-debug/.pi"), join(projectRoot, ".pi"), { recursive: true });
  if (withWorker) {
    const workflowPath = join(projectRoot, ".pi/hive/workflows/debug-chat.yaml");
    writeFileSync(workflowPath, readFileSync(workflowPath, "utf8").replace("  agent: debugger\n\ninstructions:", "  agent: debugger\n  members:\n    - id: worker\n      agent: debugger\n\ninstructions:"));
  }
  const project = loadConfigProject(projectRoot);
  assert.equal(project.status, "configured");
  if (project.status !== "configured") throw new Error("example fixture did not configure");
  const catalogs = loadConfigCatalogs(project);
  const resolution = resolveConfigWorkflows(project, catalogs);
  const workflow = resolution.workflows.find((entry) => entry.id === "debug-chat");
  assert.equal(workflow?.status, "valid");
  if (!workflow || workflow.status !== "valid") throw new Error("example workflow did not resolve");
  const models = {
    defaultModel: "test/model", defaultThinking: "medium",
    find: (id: string) => id === "test/model" ? { id, contextWindow: 1_000_000, maxTokens: 8_192, thinking: ["off", "medium"] } : undefined,
    canActivate: (id: string) => id === "test/model", estimateTokens: (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 4),
  };
  const snapshot = buildActivationSnapshot({ project, catalogs, workflow, authority: workflow.authority, models, packageVersion: "1.0.0" });
  writeActivationSnapshot(projectRoot, snapshot);
  const rootId = String((snapshot.payload.workflow.team as { rootId?: unknown }).rootId ?? "");
  const rootTools = snapshot.payload.authority.nodes.find((node) => node.nodeId === rootId)?.tools;
  const link: WorkflowSessionLink = {
    kind: "workflow", formatVersion: 1, workflowSessionId: "workflow-e2e", workflowId: workflow.id, activationHash: snapshot.snapshotHash,
    piSessionId: "pi-e2e", piSessionFile: join(projectRoot, "pi-e2e.jsonl"), normalParentId: "normal", normalParentFile: join(projectRoot, "normal.jsonl"),
    status: "current", stale: false, model: "test/model", thinking: "medium", tools: Array.isArray(rootTools) ? rootTools.filter((tool): tool is string => typeof tool === "string") : [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", name: "hive:debug-chat:e2e",
  };
  upsertWorkflowLink(projectRoot, link);
  return { projectRoot, snapshot, link };
}

function context(sessionId: string, modelRegistry: unknown = {}) {
  return {
    mode: "print", hasUI: false, model: { provider: "test", id: "model" }, modelRegistry,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => "/tmp/pi-e2e.jsonl" },
  } as never;
}

test("production registry records ordinary input and executes a generic root tool", async () => {
  const f = fixture(true);
  const registry = new WorkflowProductionRuntimeRegistry(f.projectRoot, "project-e2e");
  const runtime = registry.select(f.link, context(f.link.piSessionId))!;
  const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
  const pi = { on(name: string, handler: (event: never, ctx: never) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } } as never;
  registerWorkflowRunHooks(pi, {
    resolveLifecycle: () => runtime.lifecycle, resolveRuntime: () => runtime,
    pauseCoordinator: {}, resumeCoordinator: { acquireOwnership() {}, acquireLeases() {}, revalidateHashes: () => true, rollbackAuthority() {} }, nextInputId: () => "ordinary-e2e",
  });
  for (const handler of handlers.get("input") ?? []) await handler({ text: "diagnose the failure", source: "interactive" } as never, {} as never);
  assert.equal(runtime.lifecycle.restore().latestRun?.inputs[0]?.kind, "initial");
  const route = workflowToolDefinitionsWithRuntime(() => runtime.rootServices()).find((tool) => tool.name === "route_agent")!;
  const result = await route.execute("route-e2e", { objective: "diagnose the failure" }, new AbortController().signal, () => {}, { sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "route-e2e", name: "route_agent", arguments: { objective: "diagnose the failure" } }] } }] } } as never);
  assert.deepEqual(result.details, []);
  const delivery = runtime.lifecycle.prepareInputDelivery("ordinary-provider-request");
  runtime.lifecycle.confirmInputDelivery(delivery.requestId);
  const finish = workflowToolDefinitionsWithRuntime(() => runtime.rootServices()).find((tool) => tool.name === "workflow_finish")!;
  const finishArgs = { status: "completed", summary: "Representative ordinary workflow completed through production services." };
  await finish.execute("finish-ordinary-e2e", finishArgs, new AbortController().signal, () => {}, { sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "finish-ordinary-e2e", name: "workflow_finish", arguments: finishArgs }] } }] } } as never);
  assert.equal(runtime.lifecycle.restore().latestRun?.status, "completed");
  await registry.shutdown();
});

test("production registry creates a real Pi worker session with its inline policy extension", async () => {
  const f = fixture(true);
  let providerRequests = 0;
  let observedPolicyDenial = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    providerRequests += 1;
    observedPolicyDenial ||= /denied|outside|escape/i.test(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (providerRequests === 1) {
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "read-outside-e2e", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "../outside.txt" }) } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: { role: "assistant", content: "worker completed" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test provider did not listen");
  const model = { id: "model", name: "Model", provider: "test", api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 8_192 };
  const modelRegistry = { find: () => model, hasConfiguredAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) };
  const registry = new WorkflowProductionRuntimeRegistry(f.projectRoot, "project-e2e");
  try {
    const runtime = registry.select(f.link, context(f.link.piSessionId, modelRegistry))!;
    runtime.lifecycle.recordUserInput({ inputId: "worker-run", text: "delegate diagnosis", source: "interactive" });
    runtime.rootServices().delegate({ targetNodeId: "worker", objective: "diagnose through a real Pi session", deliverables: [] });
    await runtime.service.runWorkers();
    const page = runtime.rootServices().status();
    assert.equal(page.items[0]?.queueState, "terminal");
    assert.ok(providerRequests >= 2, "the worker must execute through createAgentSession and a tool-result turn");
    assert.equal(observedPolicyDenial, true, "the inline worker policy extension must block the out-of-scope read");
    await runtime.service.cancel("worker E2E complete");
  } finally {
    await registry.shutdown();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("checked-in split example completes planning and build through a production handoff", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-example-handoff-e2e-"));
  cpSync(join(process.cwd(), "examples/split-openspec-handoff/.pi"), join(projectRoot, ".pi"), { recursive: true });
  mkdirSync(join(projectRoot, "openspec", "changes"), { recursive: true });
  mkdirSync(join(projectRoot, "src"));
  writeFileSync(join(projectRoot, "openspec", "config.yaml"), "schema: spec-driven\n");
  const project = loadConfigProject(projectRoot);
  assert.equal(project.status, "configured");
  if (project.status !== "configured") throw new Error("split example did not configure");
  const catalogs = loadConfigCatalogs(project);
  const resolved = resolveConfigWorkflows(project, catalogs);
  assert.equal(resolved.diagnostics.length, 0);
  const models = {
    defaultModel: "test/model", defaultThinking: "medium",
    find: (id: string) => id === "test/model" ? { id, contextWindow: 1_000_000, maxTokens: 8_192, thinking: ["off", "medium"] } : undefined,
    canActivate: (id: string) => id === "test/model", estimateTokens: (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 4),
  };
  const snapshots = new Map(resolved.workflows.map((workflow) => {
    if (workflow.status !== "valid") throw new Error(`split workflow ${workflow.id} did not resolve`);
    const snapshot = buildActivationSnapshot({ project, catalogs, workflow, authority: workflow.authority, models, packageVersion: "1.0.0" });
    writeActivationSnapshot(projectRoot, snapshot);
    return [workflow.id, snapshot] as const;
  }));
  const projectId = snapshots.get("feature-plan")!.payload.project.projectId;
  const normalFile = join(projectRoot, "normal.jsonl");
  writeFileSync(normalFile, "normal\n");
  initializeNormalParent({ configured: true, projectRoot, projectId, piSessionId: "normal", piSessionFile: normalFile, model: "test/model", thinking: "medium", activeTools: ["read"] });
  const adapter = {
    async create(input: { workflowId: string }) { const piSessionId = `pi-${input.workflowId}-${randomUUID()}`; const piSessionFile = join(projectRoot, `${piSessionId}.jsonl`); writeFileSync(piSessionFile, "workflow\n"); return { piSessionId, piSessionFile }; },
    async switch() { return { cancelled: false }; },
  };
  const nonce = randomUUID();
  const selectable = (workflowId: string) => {
    const snapshot = snapshots.get(workflowId)!;
    const rootId = String((snapshot.payload.workflow.team as { rootId?: unknown }).rootId ?? "");
    const root = snapshot.payload.authority.nodes.find((node) => node.nodeId === rootId)!;
    const model = snapshot.payload.models.find((entry) => entry.nodeId === rootId)!;
    const tools = Array.isArray(root.tools) ? root.tools.filter((tool): tool is string => typeof tool === "string") : [];
    return { workflowId, activationHash: snapshot.snapshotHash, source: "current" as const, resumable: true, freshEnabled: true, model: model.modelId, thinking: model.thinking, tools };
  };
  const provider = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-split", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: { role: "assistant", content: "configured worker completed its assigned step" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-split", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("split E2E provider did not listen");
  const model = { id: "model", name: "Model", provider: "test", api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 8_192 };
  const modelRegistry = { find: () => model, hasConfiguredAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) };
  const registry = new WorkflowProductionRuntimeRegistry(projectRoot, projectId, undefined, nonce, {
    artifactMutationQueue: async (_target, _operationId, callback) => callback(),
    checkpointApproval: { authenticateControl: ({ credential }) => credential === "trusted-split-e2e" ? { approverId: "reviewer-e2e", authenticationId: "test-authority-e2e", mechanism: "trusted-test-authority" } : undefined },
  });
  const executeTool = async (runtime: NonNullable<ReturnType<typeof registry.select>>, name: string, args: Record<string, unknown>, callId: string) => {
    const tool = workflowToolDefinitionsWithRuntime(() => runtime.rootServices()).find((candidate) => candidate.name === name)!;
    return tool.execute(callId, args, new AbortController().signal, () => {}, { sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }] } }] } } as never);
  };
  const currentHash = (runtime: NonNullable<ReturnType<typeof registry.select>>) => hashArtifactWorkspace(runtime.lifecycle.restore().latestRun!.artifactWorkspace!.path!).workspaceHash;
  const acceptWorkerResults = (runtime: NonNullable<ReturnType<typeof registry.select>>, deliveryId: string) => {
    const root = runtime.rootServices();
    root.prepareResultDelivery(deliveryId);
    root.acceptResultDelivery(deliveryId);
  };
  const approveEnabled = async (runtime: NonNullable<ReturnType<typeof registry.select>>, prefix: string) => {
    const approvals = runtime.service.checkpointApprovals!;
    const decisions = new Map<string, Awaited<ReturnType<typeof approvals.requestApproval>>>();
    for (const checkpointId of runtime.lifecycle.restore().latestRun!.checkpointSnapshot!.enabledCheckpointIds) {
      const workspaceHash = currentHash(runtime);
      const request = await approvals.requestApproval({ operationId: `${prefix}-request-${checkpointId}`, checkpointId, expectedWorkspaceHash: workspaceHash });
      await approvals.decide({ operationId: `${prefix}-decide-${checkpointId}`, requestId: request.requestId, expectedRequestSequence: request.requestSequence, digest: request.digest, expectedWorkspaceHash: workspaceHash, decision: "approved" }, { channel: "dashboard", mode: "headless", dashboardAvailable: true, credential: "trusted-split-e2e" });
      decisions.set(checkpointId, request);
    }
    return decisions;
  };
  try {
    const planSelection = await selectWorkflowSession({ projectRoot, projectId, currentPiSessionId: "normal", workflow: selectable("feature-plan"), adapter, owner: { nonce, pid: process.pid, processMarker: `e2e-${process.pid}`, verifyDead: () => false } });
    const planRuntime = registry.select(planSelection.link, context(planSelection.link.piSessionId, modelRegistry))!;
    planRuntime.lifecycle.recordUserInput({ inputId: "plan-chat-input", text: "plan the checked-in split example", source: "interactive" });
    planRuntime.service.bindArtifactWorkspace({ mode: "new", workspaceId: "reviewed-feature" });
    planRuntime.rootServices().delegate({ targetNodeId: "planner", objective: "produce the implementation-ready feature plan", deliverables: ["OpenSpec plan"] });
    await planRuntime.service.runWorkers();
    assert.equal(Object.values(planRuntime.service.delegationState().tasks).every((task) => task.queueState === "terminal"), true);
    acceptWorkerResults(planRuntime, "plan-worker-results");
    for (const [artifactId, argumentsValue] of [
      ["proposal", { artifactId: "proposal", content: "# Reviewed feature\n\n## Why\nProve the checked-in split workflow end to end.\n\n## What Changes\n- Add a verified delivery marker.\n\n## Impact\n- Tests only.\n" }],
      ["design", { artifactId: "design", content: "# Design\n\n## Context\nThe split example must hand off exact task evidence.\n\n## Goals / Non-Goals\n- Complete one bounded task.\n\n## Decisions\nUse a repository marker and trusted test evidence.\n" }],
      ["specs", { artifactId: "specs", capabilityId: "split-delivery", content: "# Split delivery\n\n## ADDED Requirements\n\n### Requirement: Complete a split delivery\nThe system SHALL consume an approved planning handoff before build completion.\n\n#### Scenario: Approved plan is built\n- **WHEN** planning finishes with exact approvals\n- **THEN** build records current implementation evidence\n" }],
      ["tasks", { artifactId: "tasks", content: "# Tasks\n\n## 1. Delivery\n- [ ] 1.1 Add and verify the split delivery marker\n" }],
    ] as const) await executeTool(planRuntime, "artifact_action", { actionId: "openspec.artifact.write", arguments: argumentsValue, expectedWorkspaceHash: currentHash(planRuntime) }, `plan-write-${artifactId}`);
    const planValidation = await executeTool(planRuntime, "artifact_action", { actionId: "openspec.validate", arguments: {}, expectedWorkspaceHash: currentHash(planRuntime) }, "plan-validate");
    assert.equal((planValidation.details as { data: { passed: boolean } }).data.passed, true);
    const planApprovals = await approveEnabled(planRuntime, "plan");
    const planDelivery = planRuntime.lifecycle.prepareInputDelivery("plan-provider-request");
    planRuntime.lifecycle.confirmInputDelivery(planDelivery.requestId);
    const tasksApproval = planApprovals.get("tasks")!;
    await executeTool(planRuntime, "workflow_finish", { status: "completed", summary: "Implementation-ready split plan completed and approved.", artifactRefs: [{ workspaceId: "reviewed-feature", checkpoint: "tasks", digest: tasksApproval.digest }] }, "finish-plan");
    const planTerminal = planRuntime.lifecycle.restore().latestRun!;
    assert.equal(planTerminal.status, "completed");

    const packet = resolveHandoffSource({ projectRoot, projectId, runId: planTerminal.runId, currentPiSessionId: planSelection.link.piSessionId });
    const buildSelection = await selectWorkflowSession({ projectRoot, projectId, currentPiSessionId: planSelection.link.piSessionId, workflow: selectable("feature-build"), stagedHandoff: packet, adapter, owner: { nonce, pid: process.pid, processMarker: `e2e-${process.pid}`, verifyDead: () => false } });
    assert.equal(readHandoffState(projectRoot, buildSelection.link.workflowSessionId).staged?.packetHash, packet.packetHash);
    const buildRuntime = registry.select(buildSelection.link, context(buildSelection.link.piSessionId, modelRegistry))!;
    buildRuntime.lifecycle.recordUserInput({ inputId: "build-chat-input", text: "implement the approved plan handoff", source: "interactive" });
    assert.equal(buildRuntime.lifecycle.restore().latestRun?.handoffPacketHash, packet.packetHash);
    assert.equal(readHandoffState(projectRoot, buildSelection.link.workflowSessionId).staged, undefined);
    buildRuntime.service.bindArtifactWorkspace({ mode: "existing", workspaceId: "reviewed-feature" }, "reviewed-feature");
    for (const targetNodeId of ["builder", "tester"]) buildRuntime.rootServices().delegate({ targetNodeId, objective: targetNodeId === "builder" ? "implement the approved task" : "verify the implementation", deliverables: ["bounded evidence"] });
    await buildRuntime.service.runWorkers();
    assert.equal(Object.values(buildRuntime.service.delegationState().tasks).every((task) => task.queueState === "terminal"), true);
    acceptWorkerResults(buildRuntime, "build-worker-results");
    writeFileSync(join(projectRoot, "src", "reviewed-feature.ts"), "export const reviewedFeature = true;\n");
    let evidenceAttemptId = "";
    await buildRuntime.rootServices().dispatch.tool({ correlationId: "build-evidence", toolName: "artifact_status", operation: "test.verify-configured-worker-output", input: {}, policyOutcome: "allowed", dispatch: ({ attemptId }) => { evidenceAttemptId = attemptId; return { verified: true }; } });
    const marker = readFileSync(join(projectRoot, "src", "reviewed-feature.ts"));
    const markerDigest = `sha256:${createHash("sha256").update(marker).digest("hex")}`;
    await executeTool(buildRuntime, "artifact_action", { actionId: "openspec.tasks.complete", arguments: { taskId: "1.1", evidenceRefs: [{ kind: "tool", attemptId: evidenceAttemptId }, { kind: "repository", path: "src/reviewed-feature.ts", digest: markerDigest }] }, expectedWorkspaceHash: currentHash(buildRuntime) }, "build-complete-task");
    const buildValidation = await executeTool(buildRuntime, "artifact_action", { actionId: "openspec.validate", arguments: {}, expectedWorkspaceHash: currentHash(buildRuntime) }, "build-validate");
    assert.equal((buildValidation.details as { data: { passed: boolean } }).data.passed, true);
    const buildApprovals = await approveEnabled(buildRuntime, "build");
    const buildDelivery = buildRuntime.lifecycle.prepareInputDelivery("build-provider-request");
    buildRuntime.lifecycle.confirmInputDelivery(buildDelivery.requestId);
    const implementationApproval = buildApprovals.get("implementation")!;
    await executeTool(buildRuntime, "workflow_finish", { status: "completed", summary: "Approved split build completed with current task evidence.", artifactRefs: [{ workspaceId: "reviewed-feature", checkpoint: "implementation", digest: implementationApproval.digest }] }, "finish-build");
    assert.equal(buildRuntime.lifecycle.restore().latestRun?.status, "completed");
  } finally {
    await registry.shutdown();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
});

test("production cancellation kills its real owned process group and never a foreign process", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  const ownedProcesses = new OwnedProcessRegistry();
  const registry = new WorkflowProductionRuntimeRegistry(f.projectRoot, "project-e2e", () => ownedProcesses);
  const runtime = registry.select(f.link, context(f.link.piSessionId))!;
  runtime.lifecycle.recordUserInput({ inputId: "cancel-run", text: "start process", source: "interactive" });
  const owned = ownedProcesses.spawn(process.execPath, ["-e", "const{spawn}=require('node:child_process');spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'});setTimeout(()=>{},30000)"], { stdio: "ignore" });
  const foreign = spawnManaged(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "ignore" });
  try {
    const cancelled = await runtime.service.cancel("terminate production process group");
    assert.equal(cancelled.envelope.status, "cancelled");
    assert.equal(await waitFor(() => ownedProcesses.isSettled()), true);
    assert.equal(await waitFor(() => !isRunning(owned.pid)), true);
    assert.equal(isRunning(foreign.pid!), true, "foreign detached process must survive workflow cancellation");
  } finally {
    killProcessTree(foreign, "SIGKILL");
    try { process.kill(-owned.pid, "SIGKILL"); } catch { /* already settled */ }
    await registry.shutdown();
  }
});
