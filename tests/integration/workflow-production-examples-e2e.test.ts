import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashArtifactWorkspace } from "../../src/artifacts/hashes.ts";
import { buildActivationSnapshot, loadConfigCatalogs, loadConfigProject, resolveConfigWorkflows, writeActivationSnapshot } from "../../src/config/index.ts";
import { WorkflowProductionRuntimeRegistry, type SelectedProductionWorkflowRuntime } from "../../src/integration/workflow-production-runtime.ts";
import { createSelectedWorkflowToolPolicyHook } from "../../src/integration/workflow-tool-policy.ts";
import { workflowToolDefinitionsWithRuntime } from "../../src/integration/workflow-tools.ts";
import { upsertWorkflowLink, type WorkflowSessionLink } from "../../src/workflows/sessions.ts";

const models = {
  defaultModel: "test/model", defaultThinking: "medium",
  find: (id: string) => id === "test/model" ? { id, contextWindow: 1_000_000, maxTokens: 8_192, thinking: ["off", "medium"] } : undefined,
  canActivate: (id: string) => id === "test/model", estimateTokens: (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 4),
};
const context = (sessionId: string) => ({
  mode: "print", hasUI: false, model: { provider: "test", id: "model" }, modelRegistry: {},
  sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/tmp/${sessionId}.jsonl` },
}) as never;

function productionExample(example: string, workflowId: string) {
  const projectRoot = mkdtempSync(join(tmpdir(), `hive-production-example-${example}-`));
  cpSync(join(process.cwd(), "examples", example), projectRoot, { recursive: true });
  const project = loadConfigProject(projectRoot);
  assert.equal(project.status, "configured");
  if (project.status !== "configured") throw new Error(`${example} is not configured`);
  const catalogs = loadConfigCatalogs(project);
  const resolution = resolveConfigWorkflows(project, catalogs);
  assert.equal(resolution.diagnostics.length, 0);
  const workflow = resolution.workflows.find((entry) => entry.id === workflowId);
  assert.equal(workflow?.status, "valid");
  if (!workflow || workflow.status !== "valid") throw new Error(`${workflowId} is invalid`);
  const snapshot = buildActivationSnapshot({ project, catalogs, workflow, authority: workflow.authority, models, packageVersion: "1.0.0" });
  writeActivationSnapshot(projectRoot, snapshot);
  const rootId = String((snapshot.payload.workflow.team as { rootId?: unknown }).rootId ?? "");
  const authority = snapshot.payload.authority.nodes.find((node) => node.nodeId === rootId)!;
  const model = snapshot.payload.models.find((entry) => entry.nodeId === rootId)!;
  const sessionId = `${workflowId}-${randomUUID()}`;
  const link: WorkflowSessionLink = {
    kind: "workflow", formatVersion: 1, workflowSessionId: sessionId, workflowId, activationHash: snapshot.snapshotHash,
    piSessionId: `pi-${sessionId}`, piSessionFile: join(projectRoot, `pi-${sessionId}.jsonl`), normalParentId: "normal", normalParentFile: join(projectRoot, "normal.jsonl"),
    status: "current", stale: false, model: model.modelId, thinking: model.thinking,
    tools: Array.isArray(authority.tools) ? authority.tools.filter((tool): tool is string => typeof tool === "string") : [],
    createdAt: "2026-07-22T00:00:00.000Z", updatedAt: "2026-07-22T00:00:00.000Z", name: `hive:${workflowId}:production-e2e`,
  };
  writeFileSync(link.piSessionFile, "workflow\n");
  upsertWorkflowLink(projectRoot, link);
  const credential = Object.freeze({ trusted: "w28-human" });
  const trustedEvidence = new Set<string>();
  const registry = new WorkflowProductionRuntimeRegistry(projectRoot, snapshot.payload.project.projectId, undefined, randomUUID(), {
    checkpointApproval: { authenticateControl: ({ credential: supplied }) => supplied === credential ? { approverId: "w28-reviewer", authenticationId: "w28-test-authority", mechanism: "trusted-production-e2e-seam" } : undefined },
    completion: { evidence: (references) => references.length > 0 && references.every((reference) => reference.toolCallId && trustedEvidence.has(reference.toolCallId))
      ? Object.freeze({ state: "satisfied" as const })
      : Object.freeze({ state: "unsatisfied" as const, issues: Object.freeze(["trusted production E2E evidence was not registered"]) }) },
  });
  const runtime = registry.select(link, context(link.piSessionId))!;
  return { projectRoot, snapshot, link, credential, registry, runtime, trustEvidence: (toolCallId: string) => trustedEvidence.add(toolCallId) };
}

async function executeTool(runtime: SelectedProductionWorkflowRuntime, name: string, args: Record<string, unknown>, callId: string) {
  const tool = workflowToolDefinitionsWithRuntime(() => runtime.rootServices()).find((candidate) => candidate.name === name);
  assert.ok(tool, `missing production tool ${name}`);
  return tool.execute(callId, args, new AbortController().signal, () => {}, {
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }] } }] },
  } as never);
}

function currentHash(runtime: SelectedProductionWorkflowRuntime): string {
  return hashArtifactWorkspace(runtime.lifecycle.restore().latestRun!.artifactWorkspace!.path!).workspaceHash;
}

async function approveEnabled(runtime: SelectedProductionWorkflowRuntime, credential: object, prefix: string) {
  const approvals = runtime.service.checkpointApprovals!;
  const requests = [];
  for (const checkpointId of runtime.lifecycle.restore().latestRun!.checkpointSnapshot!.enabledCheckpointIds) {
    const workspaceHash = currentHash(runtime);
    const status = await executeTool(runtime, "artifact_status", { limit: 20 }, `${prefix}-request-status-${checkpointId}`);
    const checkpointAction = (status.details as { harnessActions?: Array<Record<string, any>> }).harnessActions?.find((action) => action.id === "checkpoint-request");
    assert.ok(checkpointAction, `status must publish checkpoint-request for ${checkpointId}`);
    assert.equal(checkpointAction.argumentsSchema.additionalProperties, false);
    assert.deepEqual(checkpointAction.required, ["checkpointId"]);
    assert.ok(checkpointAction.argumentsSchema.properties.checkpointId.enum.includes(checkpointId));
    const result = await executeTool(runtime, "artifact_action", { actionId: checkpointAction.id, arguments: { checkpointId } }, `${prefix}-request-${checkpointId}`);
    const requestId = (result.details as { data: { requestId: string } }).data.requestId;
    const request = approvals.restore().requests[requestId];
    assert.ok(request);
    await approvals.decide({ operationId: `${prefix}-decision-${checkpointId}`, requestId: request.requestId, expectedRequestSequence: request.requestSequence, digest: request.digest, expectedWorkspaceHash: workspaceHash, decision: "approved" }, { channel: "dashboard", mode: "headless", dashboardAvailable: true, credential });
    requests.push(request);
  }
  return requests;
}

function repositoryDigest(projectRoot: string, relativePath: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(join(projectRoot, relativePath))).digest("hex")}`;
}

async function verifiedAttempt(runtime: SelectedProductionWorkflowRuntime, correlationId: string): Promise<string> {
  let attemptId = "";
  await runtime.rootServices().dispatch.tool({ correlationId, toolName: "artifact_status", operation: "test.production-evidence", input: {}, policyOutcome: "allowed", dispatch: ({ attemptId: id }) => { attemptId = id; return { verified: true }; } });
  return attemptId;
}

async function finishWithApprovals(runtime: SelectedProductionWorkflowRuntime, requests: readonly { checkpointId: string; digest: string }[], status: "completed" | "blocked", summary: string, callId: string) {
  const delivery = runtime.lifecycle.prepareInputDelivery(`${callId}-provider-request`);
  runtime.lifecycle.confirmInputDelivery(delivery.requestId);
  const workspaceId = runtime.lifecycle.restore().latestRun?.artifactWorkspace?.workspace.id;
  const artifactRefs = workspaceId ? requests.map((request) => ({ workspaceId, checkpoint: request.checkpointId, digest: request.digest })) : [];
  await executeTool(runtime, "workflow_finish", { status, summary, ...(artifactRefs.length ? { artifactRefs } : {}) }, callId);
}

test("checked-in combined OpenSpec lifecycle completes through the production registry and trusted gates", async () => {
  const fixture = productionExample("combined-openspec-delivery", "feature-delivery");
  mkdirSync(join(fixture.projectRoot, "src"), { recursive: true });
  writeFileSync(join(fixture.projectRoot, "src", "combined-e2e.ts"), "export const combinedE2e = true;\n");
  try {
    const runtime = fixture.runtime;
    runtime.lifecycle.recordUserInput({ inputId: "combined-input", text: "deliver the checked-in combined feature", source: "interactive" });
    const discovery = await executeTool(runtime, "artifact_status", { limit: 20 }, "combined-workspace-status");
    assert.equal((discovery.details as { workspace: { state: string } }).workspace.state, "unbound");
    await executeTool(runtime, "artifact_action", { actionId: "workspace-bind", arguments: { mode: "new", workspaceId: "combined-production" } }, "combined-workspace-bind");
    const authorStatus = await executeTool(runtime, "artifact_status", { limit: 20 }, "combined-author-contract-status");
    const writeAction = (authorStatus.details as { actions: Array<Record<string, any>> }).actions.find((action) => action.id === "openspec.artifact.write");
    assert.ok(writeAction, "production model status must expose the OpenSpec write action");
    assert.equal(writeAction.argumentsSchemaVersion, "1");
    assert.equal(writeAction.argumentsSchema.anyOf.length, 2);
    assert.deepEqual(writeAction.variants, [
      { required: ["artifactId", "content"], optional: [] },
      { required: ["artifactId", "capabilityId", "content"], optional: [] },
    ]);
    assert.equal(writeAction.argumentsSchema.anyOf[1].properties.capabilityId.pattern, "^[a-z0-9]+(?:-[a-z0-9]+)*$");
    assert.equal(Buffer.byteLength(JSON.stringify(authorStatus.details), "utf8") <= 65_536, true);
    const writes = [
      { artifactId: "proposal", content: "# Combined production delivery\n\n## Why\nProve production registry delivery.\n\n## What Changes\n- Add verified evidence.\n\n## Impact\n- Tests only.\n" },
      { artifactId: "design", content: "# Design\n\n## Context\nOne configured workflow owns the lifecycle.\n\n## Goals / Non-Goals\n- Exercise production services.\n\n## Decisions\nUse exact approvals and evidence.\n" },
      { artifactId: "specs", capabilityId: "combined-delivery", content: "# Combined delivery\n\n## ADDED Requirements\n\n### Requirement: Complete combined delivery\nThe system SHALL finish through one configured production workflow.\n\n#### Scenario: Verified lifecycle\n- **WHEN** artifacts and evidence are current\n- **THEN** exact gates permit completion\n" },
      { artifactId: "tasks", content: "# Tasks\n\n## 1. Delivery\n- [ ] 1.1 Complete combined production delivery\n" },
    ];
    for (const args of writes) await executeTool(runtime, "artifact_action", { actionId: writeAction.id, arguments: args, expectedWorkspaceHash: currentHash(runtime) }, `combined-write-${args.artifactId}`);
    const attemptId = await verifiedAttempt(runtime, "combined-evidence");
    await executeTool(runtime, "artifact_action", { actionId: "openspec.tasks.complete", arguments: { taskId: "1.1", evidenceRefs: [{ kind: "tool", attemptId }, { kind: "repository", path: "src/combined-e2e.ts", digest: repositoryDigest(fixture.projectRoot, "src/combined-e2e.ts") }] }, expectedWorkspaceHash: currentHash(runtime) }, "combined-complete-task");
    const validation = await executeTool(runtime, "artifact_action", { actionId: "openspec.validate", arguments: {}, expectedWorkspaceHash: currentHash(runtime) }, "combined-validate");
    assert.equal((validation.details as { data: { passed: boolean } }).data.passed, true);
    const approvals = await approveEnabled(runtime, fixture.credential, "combined");
    await finishWithApprovals(runtime, approvals, "completed", "Checked-in combined OpenSpec workflow completed through production services.", "combined-finish");
    assert.equal(runtime.lifecycle.restore().latestRun?.status, "completed");
  } finally {
    await fixture.registry.shutdown();
    rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("checked-in Markdown lifecycle authors then executes a plan through the production registry", async () => {
  const fixture = productionExample("markdown-plan-lifecycle", "plan-delivery");
  mkdirSync(join(fixture.projectRoot, "src"), { recursive: true });
  writeFileSync(join(fixture.projectRoot, "src", "markdown-e2e.ts"), "export const markdownE2e = true;\n");
  try {
    const runtime = fixture.runtime;
    runtime.lifecycle.recordUserInput({ inputId: "markdown-input", text: "author and execute the checked-in Markdown plan", source: "interactive" });
    const discovery = await executeTool(runtime, "artifact_status", { limit: 20 }, "markdown-workspace-status");
    assert.equal((discovery.details as { workspace: { state: string } }).workspace.state, "unbound");
    await executeTool(runtime, "artifact_action", { actionId: "workspace-bind", arguments: { mode: "new", workspaceId: "markdown-production" } }, "markdown-workspace-bind");
    await executeTool(runtime, "artifact_action", { actionId: "markdown-plan.plan.author", arguments: { title: "Production Markdown delivery", summary: "Author and execute through configured production services.", tasks: [{ id: "deliver", text: "Deliver verified Markdown lifecycle evidence" }] }, expectedWorkspaceHash: currentHash(runtime) }, "markdown-author");
    const authored = await executeTool(runtime, "artifact_status", { limit: 20 }, "markdown-authored-status");
    assert.equal((authored.details as { status: string }).status, "ready");
    const attemptId = await verifiedAttempt(runtime, "markdown-evidence");
    await executeTool(runtime, "artifact_action", { actionId: "markdown-plan.tasks.complete", arguments: { taskId: "deliver", evidenceRefs: [{ kind: "tool", attemptId }, { kind: "repository", path: "src/markdown-e2e.ts", digest: repositoryDigest(fixture.projectRoot, "src/markdown-e2e.ts") }] }, expectedWorkspaceHash: currentHash(runtime) }, "markdown-execute");
    const executed = await executeTool(runtime, "artifact_status", { limit: 20 }, "markdown-executed-status");
    assert.equal((executed.details as { status: string }).status, "complete");
    const approvals = await approveEnabled(runtime, fixture.credential, "markdown");
    await finishWithApprovals(runtime, approvals, "completed", "Checked-in Markdown author-to-execute lifecycle completed through production services.", "markdown-finish");
    assert.equal(runtime.lifecycle.restore().latestRun?.status, "completed");
  } finally {
    await fixture.registry.shutdown();
    rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("checked-in artifact-free out-of-scope request is policy-denied and ends blocked in production", async () => {
  const fixture = productionExample("artifact-free-debug", "debug-chat");
  try {
    const runtime = fixture.runtime;
    runtime.lifecycle.recordUserInput({ inputId: "blocked-input", text: "Read and delete ../outside-secret.txt", source: "interactive" });
    const hook = createSelectedWorkflowToolPolicyHook(fixture.projectRoot, () => runtime);
    const denied = await hook({ type: "tool_call", toolCallId: "out-of-scope-read", toolName: "read", input: { path: "../outside-secret.txt" } } as never);
    assert.equal(denied?.block, true);
    assert.match(denied?.reason ?? "", /denied|outside|escape|scope/i);
    fixture.trustEvidence("out-of-scope-read");
    const delivery = runtime.lifecycle.prepareInputDelivery("blocked-provider-request");
    runtime.lifecycle.confirmInputDelivery(delivery.requestId);
    await executeTool(runtime, "workflow_finish", { status: "blocked", summary: "The request is outside configured project and filesystem authority.", evidenceRefs: [{ kind: "tool-result", toolCallId: "out-of-scope-read", claim: "Production policy denied the project-escape read." }] }, "blocked-finish");
    assert.equal(runtime.lifecycle.restore().latestRun?.status, "blocked");
  } finally {
    await fixture.registry.shutdown();
    rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});
