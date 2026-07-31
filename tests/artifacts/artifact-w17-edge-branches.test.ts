import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { ARTIFACT_ACTION_VERSION, ARTIFACT_CONTRACT_VERSION, ARTIFACT_PROFILE_VERSION, ARTIFACT_VIEW_VERSION, validateArtifactWorkspaceBinding } from "../../src/artifacts/contracts.ts";
import { ARTIFACT_HASH_LIMITS, hashArtifactWorkspace, isArtifactHash, requireExpectedArtifactHash } from "../../src/artifacts/hashes.ts";
import { WorkspaceLeaseRuntime, inspectWorkspaceLease, WORKSPACE_LEASE_TIMING } from "../../src/artifacts/leases.ts";
import {
  ArtifactOperationRuntime,
  createEmptyArtifactOperationState,
  recoverArtifactOperation,
  reduceArtifactOperationState,
} from "../../src/artifacts/operations.ts";
import { listPhysicalArtifactWorkspaces } from "../../src/artifacts/workspaces.ts";
import type { ArtifactActionResultV1, ArtifactAdapter, ArtifactRuntimeProfile, ArtifactWorkspaceLifecycle } from "../../src/artifacts/types.ts";
import { createWorkflowEvent, sealWorkflowEvent } from "../../src/workflows/events.ts";

const operationResult = (operationId: string, actionId = "update", hash = `sha256:${"b".repeat(64)}`): ArtifactActionResultV1 => ({
  schemaVersion: ARTIFACT_ACTION_VERSION, operationId, actionId, status: "completed", summary: "done", changed: true,
  workspaceHash: hash, data: {}, refs: [],
});
const operationEvent = (payload: Record<string, unknown>, producer: "harness" | "recovery" | "dashboard" = "harness") => sealWorkflowEvent(createWorkflowEvent({
  projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "artifact.recorded", payload: payload as never,
  producer, eventId: `event-${Math.random()}`, timestamp: "2026-01-01T00:00:00.000Z",
}), 1, null);

test("physical binding replay accepts both explicit either selections without weakening none", () => {
  const base = {
    schemaVersion: 1, contractVersion: ARTIFACT_CONTRACT_VERSION, adapterId: "fixture", adapterVersion: "1", profileId: "author", profileVersion: ARTIFACT_PROFILE_VERSION,
    binding: "either", workspace: { id: "workspace", kind: "physical" }, path: "/contained/workspace", workspaceHash: `sha256:${"a".repeat(64)}`,
    writerLease: { required: true }, checkpointIds: [], actionIds: [],
  };
  assert.equal(validateArtifactWorkspaceBinding({ ...base, selection: "new" }).selection, "new");
  assert.equal(validateArtifactWorkspaceBinding({ ...base, selection: "existing" }).selection, "existing");
});

test("artifact hash readers fail closed on roots and symlinks and enforce expected hash grammar", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-hash-edges-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "state"), "ok");
  const hashes = hashArtifactWorkspace(workspace);
  assert.equal(requireExpectedArtifactHash(hashes.workspaceHash, hashes), hashes.workspaceHash);
  assert.throws(() => requireExpectedArtifactHash("bad", hashes), /required/i);
  assert.throws(() => requireExpectedArtifactHash(`sha256:${"f".repeat(64)}`, hashes), /conflict/i);
  assert.throws(() => hashArtifactWorkspace(join(root, "missing")), /ENOENT|does not exist/i);
  assert.throws(() => hashArtifactWorkspace(join(workspace, "state")), /directory/i);
  symlinkSync(root, join(workspace, "escape"));
  assert.throws(() => hashArtifactWorkspace(workspace), /symlink/i);
  unlinkSync(join(workspace, "escape"));
  symlinkSync(workspace, join(root, "workspace-link"));
  assert.throws(() => hashArtifactWorkspace(join(root, "workspace-link")), /root symlink/i);
  assert.equal(isArtifactHash(hashes.workspaceHash), true);
  assert.equal(isArtifactHash(null), false);
  assert.equal(isArtifactHash(`sha256:${"A".repeat(64)}`), false);

  const oversized = join(root, "oversized");
  mkdirSync(oversized);
  writeFileSync(join(oversized, "too-large"), "");
  truncateSync(join(oversized, "too-large"), ARTIFACT_HASH_LIMITS.fileBytes + 1);
  assert.throws(() => hashArtifactWorkspace(oversized), /file exceeds hash limit/i);

  const deep = join(root, "deep");
  let nested = deep;
  for (let depth = 0; depth <= ARTIFACT_HASH_LIMITS.depth; depth++) nested = join(nested, "d");
  mkdirSync(nested, { recursive: true });
  assert.throws(() => hashArtifactWorkspace(deep), /depth limit/i);
});

test("lease records reject malformed authority and cover idempotent ownership and expired assertions", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-lease-edges-"));
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const lease = new WorkspaceLeaseRuntime({ projectRoot: root, adapterId: "fixture", workspaceId: "shared", sessionId: "session", runId: "run", ownerNonce: "nonce", now: () => now });
  assert.equal(lease.acquire().ok, true);
  assert.equal(lease.acquire().ok, true, "same nonce acquisition is idempotent");
  assert.equal(lease.assertOwned().runId, "run");
  now += WORKSPACE_LEASE_TIMING.staleMs;
  assert.throws(() => lease.assertOwned(), /fresh|own/i);
  assert.equal(lease.heartbeat(now), true);
  assert.equal(lease.release(), true);
  assert.equal(lease.release(), false);
  assert.throws(() => new WorkspaceLeaseRuntime({ projectRoot: root, adapterId: "bad/id", workspaceId: "w", sessionId: "s", runId: "r" }), /adapter ID/i);

  const corruptRoot = mkdtempSync(join(tmpdir(), "hive-lease-corrupt-"));
  const corrupt = new WorkspaceLeaseRuntime({ projectRoot: corruptRoot, adapterId: "fixture", workspaceId: "shared", sessionId: "session", runId: "run" });
  assert.equal(corrupt.acquire().ok, true);
  const directory = join(corruptRoot, ".pi", "hive", "sessions", "workspace-leases");
  const path = join(directory, readdirSync(directory).find((name) => name.endsWith(".json"))!);
  const valid = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify({ ...valid, adapterId: 7 })}\n`);
  assert.throws(() => inspectWorkspaceLease(corruptRoot, "fixture", "shared"), /invalid/i, "lease string fields must never be coerced");
  writeFileSync(path, `${JSON.stringify({ ...valid, pid: "1" })}\n`);
  assert.throws(() => inspectWorkspaceLease(corruptRoot, "fixture", "shared"), /invalid/i, "lease numeric fields require exact number types");
  writeFileSync(path, `${JSON.stringify({ ...valid, extra: true })}\n`);
  assert.throws(() => inspectWorkspaceLease(corruptRoot, "fixture", "shared"), /invalid/i, "lease shape is closed");
  writeFileSync(path, "[]\n");
  assert.throws(() => inspectWorkspaceLease(corruptRoot, "fixture", "shared"), /invalid/i, "lease records cannot be arrays");
  writeFileSync(path, `${JSON.stringify({ ...valid, acquiredAt: "not-a-date" })}\n`);
  assert.throws(() => inspectWorkspaceLease(corruptRoot, "fixture", "shared"), /invalid/i, "lease timestamps must be valid dates");
  writeFileSync(path, `${JSON.stringify({ ...valid, ownerNonce: 7 })}\n`);
  assert.throws(() => inspectWorkspaceLease(corruptRoot, "fixture", "shared"), /invalid/i, "lease identity fields require strings");
  writeFileSync(path, `${JSON.stringify({ ...valid, expiresAt: valid.heartbeatAt })}\n`);
  assert.throws(() => inspectWorkspaceLease(corruptRoot, "fixture", "shared"), /expiry/i, "lease expiry must match the heartbeat window");
  writeFileSync(path, "{}\n");
  assert.throws(() => inspectWorkspaceLease(corruptRoot, "fixture", "shared"), /invalid/i);
  writeFileSync(path, "");
  assert.throws(() => inspectWorkspaceLease(corruptRoot, "fixture", "shared"), /file is invalid/i, "empty lease files fail closed");
});

test("expired lease takeover requires an explicit dead-owner proof and reports recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-lease-takeover-"));
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const original = new WorkspaceLeaseRuntime({
    projectRoot: root, adapterId: "fixture", workspaceId: "shared", sessionId: "session-1", runId: "run-1",
    ownerNonce: "nonce-1", now: () => now,
  });
  assert.equal(original.acquire().ok, true);
  original.stopHeartbeat();
  now += WORKSPACE_LEASE_TIMING.staleMs;

  const denied = new WorkspaceLeaseRuntime({
    projectRoot: root, adapterId: "fixture", workspaceId: "shared", sessionId: "session-2", runId: "run-2",
    ownerNonce: "nonce-2", now: () => now, verifyDead: () => false,
  });
  const denial = denied.acquire();
  assert.equal(denial.ok, false);
  assert.match(denial.reason, /not verified dead/i);

  const successor = new WorkspaceLeaseRuntime({
    projectRoot: root, adapterId: "fixture", workspaceId: "shared", sessionId: "session-2", runId: "run-2",
    ownerNonce: "nonce-2", now: () => now, verifyDead: () => true,
  });
  const recovered = successor.acquire();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.previousRunId, "run-1");
  const view = successor.inspect();
  assert.equal(view.state, "owned");
  if (view.state === "owned") assert.equal(view.runId, "run-2");
  assert.equal(successor.release(), true);
});

test("fresh competing leases cannot heartbeat, release, or take writer ownership", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-lease-conflict-"));
  const owner = new WorkspaceLeaseRuntime({
    projectRoot: root, adapterId: "fixture", workspaceId: "shared", sessionId: "session-1", runId: "run-1", ownerNonce: "owner",
  });
  const contender = new WorkspaceLeaseRuntime({
    projectRoot: root, adapterId: "fixture", workspaceId: "shared", sessionId: "session-2", runId: "run-2", ownerNonce: "contender",
  });
  assert.equal(owner.acquire().ok, true);
  const conflict = contender.acquire();
  assert.equal(conflict.ok, false);
  assert.match(conflict.reason, /fresh|cannot be stolen/i);
  assert.equal(contender.heartbeat(), false);
  assert.equal(contender.release(), false);
  assert.throws(() => contender.assertOwned(), /does not own/i);
  assert.equal(owner.releaseForLifecycle("pause", `sha256:${"a".repeat(64)}`).released, true);
  assert.throws(() => owner.releaseForLifecycle("finish", "invalid"), /hash is invalid/i);
});

test("artifact operation reducer and recovery fail closed across malformed, unknown, applied, and replay branches", () => {
  const irrelevant = sealWorkflowEvent(createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "control.requested", payload: {}, producer: "dashboard" }), 1, null);
  assert.deepEqual(reduceArtifactOperationState(createEmptyArtifactOperationState(), irrelevant), { operations: {} });
  assert.throws(() => reduceArtifactOperationState(createEmptyArtifactOperationState(), operationEvent({ formatVersion: 2, subsystem: "operation", operation: "intent" })), /format/i);
  assert.throws(() => reduceArtifactOperationState(createEmptyArtifactOperationState(), operationEvent({ formatVersion: 1, subsystem: "operation", operation: "intent", operationId: "op", actionId: "update", inputHash: "a".repeat(64), expectedWorkspaceHash: `sha256:${"a".repeat(64)}` }, "dashboard")), /authority/i);
  assert.throws(() => reduceArtifactOperationState(createEmptyArtifactOperationState(), operationEvent({ formatVersion: 1, subsystem: "operation", operation: "result", operationId: "missing", result: {} })), /matching intent/i);

  const intentPayload = { formatVersion: 1, subsystem: "operation", operation: "intent", operationId: "reducer-op", actionId: "update", inputHash: "a".repeat(64), expectedWorkspaceHash: `sha256:${"a".repeat(64)}` };
  const intentEvent = operationEvent(intentPayload);
  const pendingState = reduceArtifactOperationState(createEmptyArtifactOperationState(), intentEvent);
  assert.throws(() => reduceArtifactOperationState(pendingState, intentEvent), /duplicated|bound/i);
  assert.throws(() => reduceArtifactOperationState(pendingState, operationEvent({ ...intentPayload, operation: "mystery" })), /unsupported/i);
  assert.throws(() => reduceArtifactOperationState(pendingState, operationEvent({ ...intentPayload, operation: "unknown", diagnostic: "x" })), /unknown-side-effect transition/i);
  assert.throws(() => reduceArtifactOperationState(pendingState, operationEvent({ ...intentPayload, operation: "result", result: operationResult("reducer-op"), reconciliation: "invalid" }, "recovery")), /reconciliation state/i);
  assert.throws(() => reduceArtifactOperationState(createEmptyArtifactOperationState(), operationEvent({ ...intentPayload, attemptInputHash: 7 })), /hashes are invalid/i);
  assert.throws(() => reduceArtifactOperationState(createEmptyArtifactOperationState(), operationEvent({ ...intentPayload, expectedWorkspaceHash: "invalid" })), /hashes are invalid/i);
  const unknownEvent = operationEvent({ ...intentPayload, operation: "unknown", diagnostic: "uncertain" }, "recovery");
  const unknownState = reduceArtifactOperationState(pendingState, unknownEvent);
  assert.equal(reduceArtifactOperationState(unknownState, unknownEvent), unknownState, "identical unknown diagnostics are idempotent");
  const completedState = reduceArtifactOperationState(pendingState, operationEvent({ ...intentPayload, operation: "result", result: operationResult("reducer-op") }));
  assert.throws(() => reduceArtifactOperationState(completedState, operationEvent({ ...intentPayload, operation: "result", result: operationResult("reducer-op") })), /duplicated/i);
  assert.throws(() => reduceArtifactOperationState(completedState, operationEvent({ ...intentPayload, operation: "unknown", diagnostic: "late" }, "recovery")), /unknown-side-effect transition/i);
  assert.throws(() => reduceArtifactOperationState(pendingState, operationEvent({ ...intentPayload, operation: "result", result: { ...operationResult("reducer-op"), changed: "yes" } })), /shape is invalid/i);
  assert.throws(() => reduceArtifactOperationState(pendingState, operationEvent({ ...intentPayload, operation: "result", result: { ...operationResult("reducer-op"), refs: {} } })), /shape is invalid/i);

  const projectRoot = mkdtempSync(join(tmpdir(), "hive-operation-edges-"));
  const workspace = join(projectRoot, "workspace"); mkdirSync(workspace); writeFileSync(join(workspace, "state"), "before");
  const before = hashArtifactWorkspace(workspace);
  const runtime = new ArtifactOperationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1" });
  runtime.begin({ operationId: "applied", actionId: "update", arguments: { value: 1 }, expectedWorkspaceHash: before.workspaceHash });
  writeFileSync(join(workspace, "state"), "after");
  const after = hashArtifactWorkspace(workspace);
  const recovered = recoverArtifactOperation(runtime, "applied", after, (operation, hashes) => operationResult(operation.operationId, operation.actionId, hashes.workspaceHash));
  assert.equal(recovered.state, "completed");
  assert.equal(runtime.complete("applied", operationResult("applied", "update", after.workspaceHash)).workspaceHash, after.workspaceHash);
  assert.throws(() => runtime.complete("applied", { ...operationResult("applied", "update", after.workspaceHash), summary: "different" }), /conflict/i);
  assert.equal(recoverArtifactOperation(runtime, "applied", after, () => undefined).state, "completed");
  assert.throws(() => recoverArtifactOperation(runtime, "missing", after, () => undefined), /missing/i);
  assert.throws(() => runtime.markUnknown("missing", "unknown"), /unresolved intent/i);
  assert.throws(() => runtime.begin({ operationId: "invalid-hash", actionId: "update", arguments: {}, expectedWorkspaceHash: "invalid" }), /expected workspace hash/i);
  assert.throws(() => runtime.complete("missing", operationResult("missing")), /has no intent/i);

  const unknownRuntime = new ArtifactOperationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-2" });
  unknownRuntime.begin({ operationId: "unknown", actionId: "update", arguments: {}, expectedWorkspaceHash: after.workspaceHash });
  writeFileSync(join(workspace, "other"), "changed");
  recoverArtifactOperation(unknownRuntime, "unknown", hashArtifactWorkspace(workspace), () => undefined);
  unknownRuntime.markUnknown("unknown", "replacement bounded diagnostic");
  assert.equal(unknownRuntime.restore().operations.unknown.diagnostic, "replacement bounded diagnostic");
});

test("workspace listing rejects duplicate IDs, unknown DTO fields, malformed pages, and absent lifecycle authority", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-list-edges-"));
  const profile: ArtifactRuntimeProfile = {
    contractVersion: ARTIFACT_CONTRACT_VERSION, version: ARTIFACT_PROFILE_VERSION, adapterId: "fixture", adapterVersion: "1", id: "author",
    optionsSchemaVersion: "1", optionsSchema: Type.Object({}, { additionalProperties: false }), bindings: ["existing"], checkpointIds: [], actions: [], viewVersion: ARTIFACT_VIEW_VERSION,
  };
  let mode: "duplicates" | "extra" | "summary" = "duplicates";
  const lifecycle: ArtifactWorkspaceLifecycle = {
    create() { throw new Error("unused"); }, resolve() { return undefined; },
    list() {
      if (mode === "duplicates") return { items: [{ id: "same", label: "one" }, { id: "same", label: "two" }] };
      if (mode === "summary") return { items: [{ id: "one", label: "one", summary: "bounded" }], nextCursor: "next" };
      return { items: [{ id: "one", label: "one", path: "/secret" } as never] };
    },
  };
  const adapter: ArtifactAdapter = { contractVersion: ARTIFACT_CONTRACT_VERSION, id: "fixture", version: "1", profiles: [profile], workspaceLifecycle: lifecycle, bind() { throw new Error("unused"); }, status() { throw new Error("unused"); }, reconcileAction() { return { state: "unknown", diagnostic: "unused" }; }, validateCompletion() { return { state: "satisfied" }; } };
  assert.throws(() => listPhysicalArtifactWorkspaces({ projectRoot, adapter, profile, limit: 2 }), /duplicate/i);
  mode = "extra";
  assert.throws(() => listPhysicalArtifactWorkspaces({ projectRoot, adapter, profile, limit: 2 }), /invalid/i);
  assert.throws(() => listPhysicalArtifactWorkspaces({ projectRoot, adapter, profile, limit: 2, cursor: "" }), /cursor/i);
  assert.throws(() => listPhysicalArtifactWorkspaces({ projectRoot, adapter: { ...adapter, workspaceLifecycle: undefined }, profile, limit: 2 }), /no physical workspace lifecycle/i);
  assert.throws(() => listPhysicalArtifactWorkspaces({ projectRoot, adapter, profile: { ...profile, adapterVersion: "other" }, limit: 2 }), /identity is inconsistent/i);
  mode = "summary";
  assert.deepEqual(listPhysicalArtifactWorkspaces({ projectRoot, adapter, profile, limit: 2, cursor: "bound" }), { items: [{ id: "one", label: "one", summary: "bounded" }], nextCursor: "next" });
});
