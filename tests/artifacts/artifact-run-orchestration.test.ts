import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
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

function physicalAdapter(workspacePath: string, onRecovery?: () => void, onExecute?: () => void): ArtifactAdapter {
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
      onExecute?.();
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
  readonly onExecute?: () => void;
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
