import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { analyzeCommand } from "../../src/capabilities/command.ts";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import {
  ARTIFACT_ACTION_VERSION,
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_PROFILE_VERSION,
  ARTIFACT_VIEW_VERSION,
} from "../../src/artifacts/contracts.ts";
import { hashArtifactWorkspace } from "../../src/artifacts/hashes.ts";
import { WorkspaceLeaseRuntime, type WorkspaceLeaseRuntimeOptions } from "../../src/artifacts/leases.ts";
import { ArtifactOperationRuntime } from "../../src/artifacts/operations.ts";
import type {
  ArtifactActionContext,
  ArtifactActionContract,
  ArtifactCheckpointDescriptorInput,
  ArtifactActionResultV1,
  ArtifactAdapter,
  ArtifactRuntimeProfile,
} from "../../src/artifacts/types.ts";
import { readWorkflowJournal } from "../../src/workflows/journal.ts";
import { RunOrchestrationService, type RunOrchestrationServiceOptions } from "../../src/workflows/orchestration.ts";
import { acquireRuntimeOwnership, releaseRuntimeOwnership } from "../../src/workflows/ownership.ts";
import { GENERIC_WORKFLOW_TOOL_CONTRACTS } from "../../src/workflows/tools.ts";

const strict = { additionalProperties: false } as const;
const setTitle = Object.freeze({
  version: ARTIFACT_ACTION_VERSION,
  id: "set-title",
  label: "Set title",
  argumentsSchemaVersion: "1" as const,
  argumentsSchema: Type.Object({ title: Type.String({ minLength: 1 }) }, strict),
  requiredCapabilities: Object.freeze(["write"] as const),
  completion: "mandatory" as const,
  mutability: "mutating" as const,
  idempotency: "operation-bound" as const,
});
const profile: ArtifactRuntimeProfile = Object.freeze({
  contractVersion: ARTIFACT_CONTRACT_VERSION,
  version: ARTIFACT_PROFILE_VERSION,
  adapterId: "fixture",
  adapterVersion: "1",
  id: "author",
  optionsSchemaVersion: "1",
  optionsSchema: Type.Object({}, strict),
  bindings: Object.freeze(["existing"] as const),
  checkpointIds: Object.freeze([]),
  actions: Object.freeze([setTitle]),
  viewVersion: ARTIFACT_VIEW_VERSION,
});

function snapshot(): ActivationSnapshotFileV1 {
  return {
    snapshotHash: "a".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      project: { projectId: "project-1", rootRef: "." },
      workflow: {
        id: "physical-artifact",
        artifact: {
          adapter: "fixture", adapterVersion: "1", profile: "author", profileVersion: "1", binding: "existing", options: {},
          optionsSchemaVersion: "1", contractVersion: ARTIFACT_CONTRACT_VERSION, checkpoints: [], actionIds: ["set-title"], viewVersion: 1, approvals: {},
        },
        team: { rootId: "root", nodes: [{ id: "root", agentId: "lead", memberIds: [], depth: 1, responsibilities: [] }] },
      },
      authority: {
        capabilityContractVersion: 1,
        nodes: [{
          nodeId: "root",
          capabilities: { effective: { artifact: ["read", "write"] }, budgets: {}, attachments: { skills: [], knowledge: [] }, directMemberIds: [] },
          tools: ["artifact_status", "artifact_action", "workflow_finish"], model: "model", thinking: "low",
        }],
      },
      agents: [{ id: "lead", name: "Lead", tags: [], prompt: "lead" }],
      skills: [], knowledge: [],
      models: [{ nodeId: "root", modelId: "model", thinking: "low", staticTokens: 1, dynamicReserve: 1, contextWindow: 100_000 }],
      sources: [], versions: {},
    },
  } as unknown as ActivationSnapshotFileV1;
}

function actionResult(operationId: string, workspaceHash: string): ArtifactActionResultV1 {
  return Object.freeze({
    schemaVersion: ARTIFACT_ACTION_VERSION,
    operationId,
    actionId: "set-title",
    status: "completed",
    summary: "updated",
    changed: true,
    workspaceHash,
    data: Object.freeze({}),
    refs: Object.freeze([]),
  });
}

function physicalAdapter(workspacePath: string, onRecovery?: () => void, onExecute?: (context: ArtifactActionContext) => void): ArtifactAdapter {
  const adapter: ArtifactAdapter = {
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    id: "fixture",
    version: "1",
    profiles: Object.freeze([profile]),
    workspaceLifecycle: {
      create() { throw new Error("fixture supports existing workspaces only"); },
      resolve(input) { return input.workspaceId === "shared" ? { id: "shared", path: workspacePath } : undefined; },
      list() { return { items: [{ id: "shared", label: "Shared fixture" }] }; },
    },
    bind() { throw new Error("physical binding uses the common lifecycle binder"); },
    status(context, page) {
      assert.ok(context.hashes, "physical status must receive fresh authority hashes");
      return {
        schemaVersion: ARTIFACT_VIEW_VERSION,
        contractVersion: ARTIFACT_CONTRACT_VERSION,
        adapter: { id: "fixture", version: "1" },
        profile: { id: "author", version: "1" },
        workspace: { id: "shared", kind: "physical", binding: "existing", path: workspacePath, hash: context.hashes.workspaceHash },
        status: "ready", summary: "ready", checkpoints: [], actions: [{ id: "set-title", label: "Set title", available: true }],
        items: [], page: { limit: page.limit }, refs: [],
      };
    },
    async executeAction(context: ArtifactActionContext, _action: ArtifactActionContract, argumentsValue: Readonly<Record<string, unknown>>) {
      onExecute?.(context);
      await context.enqueueMutation("state.txt", () => writeFileSync(join(workspacePath, "state.txt"), String(argumentsValue.title)));
      return actionResult(context.operationId, hashArtifactWorkspace(workspacePath).workspaceHash);
    },
    reconcileAction(context) {
      onRecovery?.();
      return { state: "applied", result: actionResult(context.operation.operationId, context.hashes.workspaceHash) };
    },
    validateCompletion() { return { state: "satisfied" }; },
  };
  return Object.freeze(adapter);
}

let callSequence = 0;
function callToolWithId(name: string, input: unknown, toolCallId: string): Promise<any> {
  const contract = GENERIC_WORKFLOW_TOOL_CONTRACTS.find((candidate) => candidate.name === name);
  assert.ok(contract);
  const ctx = { sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name, arguments: {} }] } }] } };
  return contract.execute(toolCallId, input as never, undefined, undefined, ctx as never);
}
function callTool(name: string, input: unknown): Promise<any> {
  return callToolWithId(name, input, `artifact-call-${++callSequence}`);
}

interface FixtureOptions {
  readonly onRecovery?: () => void;
  readonly onExecute?: (context: ArtifactActionContext) => void;
  readonly artifactOperationFault?: RunOrchestrationServiceOptions["artifactOperationFault"];
  readonly leaseFactory?: (options: WorkspaceLeaseRuntimeOptions) => WorkspaceLeaseRuntime;
  readonly pauseReleaseOwnership?: boolean;
  readonly resumeOrder?: string[];
}
function fixture(label: string, input: FixtureOptions = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), `hive-artifact-service-${label}-`));
  const workspacePath = join(projectRoot, "workspace");
  mkdirSync(workspacePath);
  writeFileSync(join(workspacePath, "state.txt"), "before");
  const sessionId = `session-${label}`;
  const ownerNonce = `owner-${label}`;
  assert.equal(acquireRuntimeOwnership(projectRoot, sessionId, { nonce: ownerNonce }).ok, true);
  let attempt = 0;
  const order = input.resumeOrder ?? [];
  const options: RunOrchestrationServiceOptions = {
    projectRoot, projectId: "project-1", sessionId, snapshot: snapshot(), runtimeOwnerNonce: ownerNonce, maxParallel: 1,
    workerFactory: async () => ({ linkedSessionId: "unused", prompt: async () => "unused", dispose() {} }),
    createRunId: () => `run-${label}`, createAttemptId: () => `artifact-attempt-${++attempt}`,
    artifactRuntime: { adapter: physicalAdapter(workspacePath, input.onRecovery, input.onExecute), profile },
    artifactMutationQueue: async (_target, _operationId, callback) => callback(),
    ...(input.artifactOperationFault ? { artifactOperationFault: input.artifactOperationFault } : {}),
    ...(input.leaseFactory ? { artifactLeaseFactory: input.leaseFactory } : {}),
    pauseAuthority: {
      captureState: () => ({}), releaseLeases: () => {},
      releaseOwnership: () => { if (input.pauseReleaseOwnership) assert.equal(releaseRuntimeOwnership(projectRoot, sessionId, ownerNonce), true); },
    },
    resumeAuthority: {
      acquireOwnership: () => {
        order.push("runtime-owner");
        if (input.pauseReleaseOwnership) {
          const acquired = acquireRuntimeOwnership(projectRoot, sessionId, { nonce: ownerNonce });
          if (!acquired.ok) throw new Error(acquired.reason);
        }
      },
      acquireLeases: () => { order.push("external-leases"); },
      revalidateHashes: () => { order.push("hash-check"); return true; },
      rollbackAuthority: () => { if (input.pauseReleaseOwnership) releaseRuntimeOwnership(projectRoot, sessionId, ownerNonce); },
    },
    cancellationAuthority: { terminateProcessTrees: () => {}, capturePartialState: () => ({}), releaseLeases: () => {} },
  };
  const service = new RunOrchestrationService(options);
  service.lifecycle.recordUserInput({ inputId: `input-${label}`, text: "work", source: "interactive" });
  service.bindArtifactWorkspace({ mode: "existing", workspaceId: "shared" });
  const delivery = service.lifecycle.prepareInputDelivery(`delivery-${label}`);
  service.lifecycle.confirmInputDelivery(delivery.requestId);
  return { projectRoot, workspacePath, sessionId, ownerNonce, service, options, order };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not observed");
}

test("RunOrchestrationService freezes adapter checkpoint defaults and enforces its sole approval authority at completion", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-artifact-service-approvals-"));
  const workspacePath = join(projectRoot, "workspace");
  mkdirSync(workspacePath);
  writeFileSync(join(workspacePath, "state.txt"), "approved content");
  const approvalProfile: ArtifactRuntimeProfile = Object.freeze({ ...profile, checkpointIds: Object.freeze(["completion", "review"]) });
  const base = physicalAdapter(workspacePath);
  const adapter: ArtifactAdapter = Object.freeze({
    ...base,
    profiles: Object.freeze([approvalProfile]),
    checkpointDescriptor: ({ binding, checkpointId }: ArtifactCheckpointDescriptorInput) => ({
      formatVersion: 1 as const, adapterId: binding.adapterId, adapterVersion: binding.adapterVersion,
      profileId: binding.profileId, profileVersion: binding.profileVersion, profileSchemaVersion: approvalProfile.optionsSchemaVersion,
      checkpointId, checkpointVersion: "1", contributors: [{ kind: "file" as const, path: "state.txt" }],
    }),
  });
  const activeSnapshot = snapshot() as unknown as { payload: { workflow: { artifact: Record<string, unknown> } } } & ActivationSnapshotFileV1;
  activeSnapshot.payload.workflow.artifact.checkpoints = ["completion", "review"];
  activeSnapshot.payload.workflow.artifact.approvals = { completion: "required", review: "optional" };
  const sessionId = "session-approval-integration";
  const ownerNonce = "owner-approval-integration";
  assert.equal(acquireRuntimeOwnership(projectRoot, sessionId, { nonce: ownerNonce }).ok, true);
  const service = new RunOrchestrationService({
    projectRoot, projectId: "project-1", sessionId, snapshot: activeSnapshot, runtimeOwnerNonce: ownerNonce, maxParallel: 1,
    workerFactory: async () => ({ linkedSessionId: "unused", prompt: async () => "unused", dispose() {} }),
    createRunId: () => "run-approval-integration",
    artifactRuntime: { adapter, profile: approvalProfile },
    artifactMutationQueue: async (_target, _operationId, callback) => callback(),
    checkpointApproval: {
      authenticateControl: ({ credential }) => credential === "human-secret" ? { approverId: "human-1", authenticationId: "auth-1", mechanism: "test-control" } : undefined,
      createRequestId: () => "request-integration",
      createDecisionId: () => "decision-integration",
    },
    completion: { approvals: () => ({ state: "satisfied" }) },
    pauseAuthority: { captureState: () => ({}), releaseLeases: () => {}, releaseOwnership: () => {} },
    resumeAuthority: { acquireOwnership: () => {}, acquireLeases: () => {}, revalidateHashes: () => true, rollbackAuthority: () => {} },
    cancellationAuthority: { terminateProcessTrees: () => {}, capturePartialState: () => ({}), releaseLeases: () => {} },
  });
  assert.ok(service.checkpointApprovals);
  service.checkpointApprovals.setOptionalDefault({ operationId: "disable-review", checkpointId: "review", enabled: false, expectedDefaultsRevision: 0 });
  service.lifecycle.recordUserInput({ inputId: "approval-input", text: "approve", source: "interactive" });
  service.bindArtifactWorkspace({ mode: "existing", workspaceId: "shared" });
  const run = service.lifecycle.restore().latestRun!;
  assert.deepEqual(run.checkpointSnapshot?.enabledCheckpointIds, ["completion"]);
  assert.equal(run.checkpointSnapshot?.defaultsRevision, service.checkpointApprovals.restore().defaultsRevision);
  const delivery = service.lifecycle.prepareInputDelivery("approval-delivery");
  service.lifecycle.confirmInputDelivery(delivery.requestId);
  const bypass = await service.lifecycle.finish({ status: "completed", summary: "upstream hook cannot bypass checkpoint authority" }, { callerNodeId: "root", toolBatch: ["workflow_finish"] });
  assert.equal(bypass.ok, false);
  if (!bypass.ok) assert.match(bypass.issues.join(" "), /checkpoint|approval|missing/i);

  const lease = new WorkspaceLeaseRuntime({ projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId, runId: run.runId });
  assert.equal(lease.acquire().ok, true);
  const currentHash = hashArtifactWorkspace(workspacePath).workspaceHash;
  const request = await service.checkpointApprovals.requestApproval({ operationId: "request-completion", checkpointId: "completion", expectedWorkspaceHash: currentHash });
  assert.equal(service.lifecycle.restore().latestRun?.status, "waiting_for_human");
  await service.checkpointApprovals.decide({
    operationId: "decide-completion", requestId: request.requestId, expectedRequestSequence: request.requestSequence,
    digest: request.digest, expectedWorkspaceHash: currentHash, decision: "approved",
  }, { channel: "dashboard", mode: "headless", dashboardAvailable: true, credential: "human-secret" });
  assert.equal(service.lifecycle.restore().latestRun?.status, "running");
  assert.equal(lease.release(), true);
  const completed = await service.lifecycle.finish({ status: "completed", summary: "approved" }, { callerNodeId: "root", toolBatch: ["workflow_finish"] });
  assert.equal(completed.ok, true, completed.ok ? "" : completed.issues.join(" "));
});

test("RunOrchestrationService binds an injected physical adapter and carries fresh status hash through queued action commit", async () => {
  const f = fixture("binding");
  const listed = f.service.listArtifactWorkspaces({ limit: 5 });
  assert.deepEqual(listed.items, [{ id: "shared", label: "Shared fixture" }]);
  const root = f.service.rootServices();
  const status = await root.runWithToolRuntime(() => callTool("artifact_status", { limit: 1 }));
  const readerHash = status.details.workspace.hash as string;
  assert.equal(readerHash, hashArtifactWorkspace(f.workspacePath).workspaceHash);
  const action = await root.runWithToolRuntime(() => callTool("artifact_action", { actionId: "set-title", arguments: { title: "after" }, expectedWorkspaceHash: readerHash }));
  assert.equal(action.details.workspaceHash, hashArtifactWorkspace(f.workspacePath).workspaceHash);
  assert.equal(f.service.lifecycle.restore().latestRun?.artifactWorkspace?.workspace.id, "shared");
});

test("artifact task evidence resolver binds successful W13 tool/command attempts and current repository hashes", async () => {
  let references: Array<{ kind: "tool" | "command"; attemptId: string } | { kind: "repository"; path: string; digest: string }> = [];
  let toolAttemptId = "";
  let commandAttemptId = "";
  let verified: unknown;
  const f = fixture("evidence-authority", { onExecute: (context) => {
    const verify = context.verifyEvidence!;
    assert.throws(() => verify([]), /invalid|bound/i);
    assert.throws(() => verify([{ kind: "tool", attemptId: "missing-attempt" }]), /completed|successful/i);
    assert.throws(() => verify([{ kind: "command", attemptId: toolAttemptId }]), /shell|Git/i);
    assert.throws(() => verify([{ kind: "tool", attemptId: commandAttemptId }]), /non-command|trusted/i);
    assert.throws(() => verify([{ kind: "repository", path: "../escape", digest: `sha256:${"0".repeat(64)}` }]), /path|invalid/i);
    assert.throws(() => verify([{ kind: "repository", path: "implementation.ts", digest: `sha256:${"0".repeat(64)}` }]), /stale/i);
    verified = verify(references);
  } });
  const sourcePath = join(f.projectRoot, "implementation.ts");
  writeFileSync(sourcePath, "export const implemented = true;\n");
  const rootAuthority = (f.options.snapshot.payload.authority.nodes.find((node) => node.nodeId === "root") as { tools: string[] }).tools;
  rootAuthority.push("bash");
  const root = f.service.rootServices();
  await root.dispatch.tool({
    correlationId: "evidence-tool", toolName: "artifact_status", operation: "tool.artifact-status", input: {}, policyOutcome: "allowed",
    dispatch: ({ attemptId }) => { toolAttemptId = attemptId; return { inspected: true }; },
  });
  await root.dispatch.tool({
    correlationId: "evidence-command", toolName: "bash", operation: "command.git-status", input: { command: "git status" }, policyOutcome: "allowed",
    commandMetadata: analyzeCommand("git status"),
    dispatch: ({ attemptId }) => { commandAttemptId = attemptId; return { exitCode: 0 }; },
  });
  const repositoryDigest = `sha256:${createHash("sha256").update(readFileSync(sourcePath)).digest("hex")}`;
  references = [
    { kind: "tool", attemptId: toolAttemptId },
    { kind: "command", attemptId: commandAttemptId },
    { kind: "repository", path: "implementation.ts", digest: repositoryDigest },
  ];
  const status = await root.runWithToolRuntime(() => callTool("artifact_status", {}));
  await root.runWithToolRuntime(() => callTool("artifact_action", { actionId: "set-title", arguments: { title: "evidence-bound" }, expectedWorkspaceHash: status.details.workspace.hash }));
  assert.deepEqual((verified as Array<Record<string, unknown>>).map((entry) => entry.kind), ["tool", "command", "repository"]);
  assert.equal((verified as Array<Record<string, unknown>>)[0].attemptId, toolAttemptId);
  assert.equal((verified as Array<Record<string, unknown>>)[1].attemptId, commandAttemptId);
  assert.equal((verified as Array<Record<string, unknown>>)[2].digest, repositoryDigest);
});

test("restart reconciles a durable artifact result into its matching enclosing W13 attempt and rejects differing replay input", async () => {
  let executions = 0;
  let crashOnce = true;
  const f = fixture("attempt-restart", {
    onExecute: () => { executions += 1; },
    artifactOperationFault: (stage) => {
      if (stage === "afterResult" && crashOnce) {
        crashOnce = false;
        throw new Error("simulated process death after artifact result");
      }
    },
  });
  const root = f.service.rootServices();
  const status = await root.runWithToolRuntime(() => callTool("artifact_status", {}));
  const request = { actionId: "set-title", arguments: { title: "committed" }, expectedWorkspaceHash: status.details.workspace.hash as string };
  const toolCallId = "artifact-restart-same-call";
  await assert.rejects(() => root.runWithToolRuntime(() => callToolWithId("artifact_action", request, toolCallId)), /simulated process death after artifact result/i);
  assert.equal(executions, 1);
  assert.equal(f.service.lifecycle.restore().latestRun?.status, "paused", "the in-process fault harness models restart from the normal unknown-side-effect pause");
  const interruptedAttempt = Object.values(f.service.attemptRuntime().restore().attempts).find((attempt) => attempt.operation === "workflow.tool.artifact_action");
  assert.ok(interruptedAttempt);
  assert.equal(interruptedAttempt.result, undefined);
  const operation = new ArtifactOperationRuntime({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: f.sessionId, runId: "run-attempt-restart" })
    .restore().operations[interruptedAttempt.attemptId];
  assert.ok(operation.result, "artifact result must be durable before the enclosing W13 result");
  assert.equal(operation.attemptInputHash, interruptedAttempt.inputHash);

  const restarted = new RunOrchestrationService(f.options);
  assert.equal(await restarted.resume(), true);
  const reconciled = restarted.attemptRuntime().restore().attempts[interruptedAttempt.attemptId];
  assert.equal(reconciled.status, "completed");
  assert.equal(reconciled.reconciliation, "applied");
  assert.deepEqual(reconciled.result?.value, operation.result);
  const restartedRoot = restarted.rootServices();
  const replay = await restartedRoot.runWithToolRuntime(() => callToolWithId("artifact_action", request, toolCallId));
  assert.deepEqual(replay.details, operation.result);
  assert.equal(executions, 1, "restart replay must not repeat the adapter mutation");
  await assert.rejects(() => restartedRoot.runWithToolRuntime(() => callToolWithId("artifact_action", {
    ...request, arguments: { title: "different" },
  }, toolCallId)), /reuse with different input|different input/i);
  assert.equal(executions, 1);
});

test("resume obtains runtime and artifact authority before recovery and a competing writer cannot be recorded not-applied", async () => {
  const order: string[] = [];
  class OrderedLease extends WorkspaceLeaseRuntime {
    override acquire() { order.push("artifact-lease"); return super.acquire(); }
  }
  const f = fixture("resume", {
    pauseReleaseOwnership: true,
    resumeOrder: order,
    onRecovery: () => { order.push("recovery"); },
    leaseFactory: (options) => new OrderedLease(options),
  });
  const initial = hashArtifactWorkspace(f.workspacePath).workspaceHash;
  writeFileSync(join(f.workspacePath, "state.txt"), "applied");
  assert.equal(await f.service.pause("restart"), true);
  const operations = new ArtifactOperationRuntime({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: f.sessionId, runId: "run-resume" });
  operations.begin({ operationId: "interrupted", actionId: "set-title", arguments: { title: "applied" }, expectedWorkspaceHash: initial });

  const competitor = new WorkspaceLeaseRuntime({ projectRoot: f.projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId: "competitor", runId: "competitor-run" });
  assert.equal(competitor.acquire().ok, true);
  await assert.rejects(() => f.service.resume(), /writer lease conflict|heartbeat is fresh/i);
  assert.equal(operations.restore().operations.interrupted.result, undefined, "recovery must not classify an operation while another writer owns the workspace");
  assert.equal(competitor.release(), true);

  order.length = 0;
  assert.equal(await f.service.resume(), true);
  assert.deepEqual(order, ["runtime-owner", "artifact-lease", "external-leases", "hash-check", "recovery"]);
  assert.equal(operations.restore().operations.interrupted.reconciliation, "applied");
});

test("writer heartbeat loss pauses the service and records a fresh final hash before lease release", async () => {
  let controlled: ControllableLease | undefined;
  class ControllableLease extends WorkspaceLeaseRuntime {
    private onLost?: (error: Error) => void;
    override startHeartbeat(onLost = this.options.onHeartbeatLost) {
      this.onLost = onLost;
      return super.startHeartbeat(onLost);
    }
    lose(): void {
      this.stopHeartbeat();
      this.onLost?.(new Error("injected heartbeat ownership loss"));
    }
  }
  const f = fixture("heartbeat", { leaseFactory: (options) => (controlled = new ControllableLease(options)) });
  const root = f.service.rootServices();
  const status = await root.runWithToolRuntime(() => callTool("artifact_status", {}));
  await root.runWithToolRuntime(() => callTool("artifact_action", {
    actionId: "set-title", arguments: { title: "committed" }, expectedWorkspaceHash: status.details.workspace.hash,
  }));
  assert.ok(controlled);
  controlled.lose();
  await waitFor(() => f.service.lifecycle.restore().latestRun?.status === "paused");
  assert.equal(controlled.inspect().state, "available");
  const finalHashEvents = readWorkflowJournal(f.projectRoot, f.sessionId).filter((event) => event.type === "artifact.recorded"
    && (event.payload as Record<string, unknown>).subsystem === "workspace"
    && (event.payload as Record<string, unknown>).operation === "final-hash");
  const payload = finalHashEvents.at(-1)?.payload as Record<string, unknown>;
  assert.equal(payload.reason, "pause");
  assert.equal(payload.finalWorkspaceHash, hashArtifactWorkspace(f.workspacePath).workspaceHash);
});
