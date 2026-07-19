import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import {
  ARTIFACT_ACTION_VERSION,
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_PROFILE_VERSION,
  ARTIFACT_VIEW_VERSION,
} from "../../src/artifacts/contracts.ts";
import { NONE_ARTIFACT_ADAPTER, NONE_PROFILE } from "../../src/artifacts/adapters/none.ts";
import { ArtifactFacade, ArtifactFacadeError } from "../../src/artifacts/facade.ts";
import { hashArtifactWorkspace } from "../../src/artifacts/hashes.ts";
import { createRunOrchestrationArtifactCallerIssuer } from "../../src/artifacts/internal/caller.ts";
import { WorkspaceLeaseRuntime } from "../../src/artifacts/leases.ts";
import {
  ArtifactOperationRuntime,
  recoverArtifactOperation,
} from "../../src/artifacts/operations.ts";
import type {
  ArtifactActionContext,
  ArtifactActionContract,
  ArtifactActionResultV1,
  ArtifactAdapter,
  ArtifactOperationRecoveryContext,
  ArtifactRuntimeProfile,
  ArtifactStatusContext,
  ArtifactStatusPageRequest,
  ArtifactWorkspaceBinding,
} from "../../src/artifacts/types.ts";
import { readWorkflowJournal } from "../../src/workflows/journal.ts";

const strict = { additionalProperties: false } as const;
const action = Object.freeze({
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
  actions: Object.freeze([action]),
  viewVersion: ARTIFACT_VIEW_VERSION,
});

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-operation-"));
  const workspacePath = join(projectRoot, "workspace");
  mkdirSync(workspacePath);
  writeFileSync(join(workspacePath, "state.txt"), "before");
  const initial = hashArtifactWorkspace(workspacePath);
  const binding: ArtifactWorkspaceBinding = Object.freeze({
    schemaVersion: 1,
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    adapterId: "fixture",
    adapterVersion: "1",
    profileId: "author",
    profileVersion: ARTIFACT_PROFILE_VERSION,
    binding: "existing",
    selection: "existing",
    workspace: Object.freeze({ id: "shared", kind: "physical" as const }),
    path: workspacePath,
    workspaceHash: initial.workspaceHash,
    writerLease: Object.freeze({ required: true }),
    checkpointIds: Object.freeze([]),
    actionIds: Object.freeze(["set-title"]),
  });
  const operations = new ArtifactOperationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1" });
  const lease = new WorkspaceLeaseRuntime({ projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId: "session-1", runId: "run-1" });
  const caller = createRunOrchestrationArtifactCallerIssuer({ payload: { authority: { nodes: [{ nodeId: "root", capabilities: { effective: { artifact: ["read", "write"] } }, tools: ["artifact_status", "artifact_action"] }] } } } as never).issue("root", binding);
  return { projectRoot, workspacePath, binding, operations, lease, caller, initial };
}

function result(operationId: string, workspaceHash: string, changed = true): ArtifactActionResultV1 {
  return Object.freeze({
    schemaVersion: ARTIFACT_ACTION_VERSION,
    operationId,
    actionId: "set-title",
    status: "completed",
    summary: changed ? "updated" : "unchanged",
    changed,
    workspaceHash,
    data: Object.freeze({}),
    refs: Object.freeze([]),
  });
}

function adapter(
  workspacePath: string,
  onExecute?: () => void,
  reconcile: ArtifactAdapter["reconcileAction"] = () => ({ state: "unknown", diagnostic: "adapter cannot prove the interrupted mutation" }),
): ArtifactAdapter {
  return Object.freeze({
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    id: "fixture",
    version: "1",
    profiles: Object.freeze([profile]),
    bind() { throw new Error("unused"); },
    status(context: ArtifactStatusContext, page: ArtifactStatusPageRequest) {
      return {
        schemaVersion: ARTIFACT_VIEW_VERSION,
        contractVersion: ARTIFACT_CONTRACT_VERSION,
        adapter: { id: "fixture", version: "1" },
        profile: { id: "author", version: "1" },
        workspace: { id: "shared", kind: "physical", binding: "existing", path: workspacePath, hash: context.hashes?.workspaceHash ?? context.binding.workspaceHash },
        status: "ready",
        summary: "ready",
        checkpoints: [],
        actions: [{ id: "set-title", label: "Set title", available: true }],
        items: [],
        page: { limit: page.limit },
        refs: [],
      } as never;
    },
    async executeAction(context: ArtifactActionContext, _action: ArtifactActionContract, argumentsValue: Readonly<Record<string, unknown>>) {
      onExecute?.();
      await context.enqueueMutation("state.txt", () => {
        writeFileSync(join(workspacePath, "state.txt"), String(argumentsValue.title));
      });
      return result(context.operationId, hashArtifactWorkspace(workspacePath).workspaceHash);
    },
    reconcileAction: reconcile,
    validateCompletion() { return { state: "satisfied" as const }; },
  });
}

function facade(f: ReturnType<typeof fixture>, artifactAdapter = adapter(f.workspacePath, undefined)) {
  return new ArtifactFacade({
    adapter: artifactAdapter,
    profile,
    binding: f.binding,
    mutationQueue: async (_target, _operationId, callback) => callback(),
    workspaceAuthority: {
      readHashes: () => hashArtifactWorkspace(f.workspacePath),
      lease: f.lease,
      operations: f.operations,
    },
  });
}

test("concurrent status readers receive fresh current hashes without taking the writer lease", async () => {
  const f = fixture();
  const subject = facade(f);
  const initialViews = await Promise.all(Array.from({ length: 6 }, () => subject.status(f.caller, { limit: 1 })));
  assert.equal(new Set(initialViews.map((view) => view.workspace.hash)).size, 1);
  assert.equal(f.lease.inspect().state, "available");
  writeFileSync(join(f.workspacePath, "reader-change.txt"), "external");
  const changed = await subject.status(f.caller, { limit: 1 });
  assert.notEqual(changed.workspace.hash, f.initial.workspaceHash);
  assert.equal(changed.workspace.hash, hashArtifactWorkspace(f.workspacePath).workspaceHash);
  assert.equal(f.lease.inspect().state, "available");
});

test("every physical read and mutation requires workspace authority with no binding-hash or queue-only bypass", async () => {
  const f = fixture();
  const unauthorized = new ArtifactFacade({
    adapter: adapter(f.workspacePath), profile, binding: f.binding,
    mutationQueue: async (_target, _operationId, callback) => callback(),
  });
  await assert.rejects(
    () => unauthorized.status(f.caller),
    (error) => error instanceof ArtifactFacadeError && error.code === "WORKSPACE_AUTHORITY_REQUIRED",
  );
  await assert.rejects(
    () => unauthorized.action(f.caller, { actionId: "set-title", arguments: { title: "denied" }, expectedWorkspaceHash: f.initial.workspaceHash }, { attemptId: "authority-required" }),
    (error) => error instanceof ArtifactFacadeError && error.code === "WORKSPACE_AUTHORITY_REQUIRED",
  );
  assert.throws(() => unauthorized.recoverUnresolvedOperations(), (error) => error instanceof ArtifactFacadeError && error.code === "WORKSPACE_AUTHORITY_REQUIRED");
  assert.equal(f.lease.acquire().ok, true);
  assert.deepEqual(facade(f).recoverUnresolvedOperations(), { recovered: [], unknown: [], diagnostics: [] });
  assert.equal(f.lease.release(), true);
  assert.equal(hashArtifactWorkspace(f.workspacePath).workspaceHash, f.initial.workspaceHash);
});

test("logical-empty recovery is an authority-free no-op", () => {
  const binding = NONE_ARTIFACT_ADAPTER.bind(NONE_PROFILE, { runId: "logical-run", binding: "none", options: {} });
  const subject = new ArtifactFacade({ adapter: NONE_ARTIFACT_ADAPTER, profile: NONE_PROFILE, binding });
  assert.deepEqual(subject.recoverUnresolvedOperations(), { recovered: [], unknown: [], diagnostics: [] });
});

test("mutations require optimistic reader hash and a writer lease even when arguments are valid", async () => {
  const f = fixture();
  const subject = facade(f);
  await assert.rejects(() => subject.action(f.caller, { actionId: "set-title", arguments: { title: "one" } }, { attemptId: "operation-1" }), (error) => error instanceof ArtifactFacadeError && error.code === "EXPECTED_HASH_REQUIRED");
  await assert.rejects(() => subject.action(f.caller, { actionId: "set-title", arguments: { title: "one" }, expectedWorkspaceHash: `sha256:${"f".repeat(64)}` }, { attemptId: "operation-1" }), (error) => error instanceof ArtifactFacadeError && error.code === "WORKSPACE_HASH_CONFLICT");
  assert.equal(f.operations.restore().operations["operation-1"], undefined, "stale requests must not record mutation intent");

  const accepted = await subject.action(f.caller, { actionId: "set-title", arguments: { title: "one" }, expectedWorkspaceHash: f.initial.workspaceHash }, { attemptId: "operation-1" });
  assert.equal(accepted.workspaceHash, hashArtifactWorkspace(f.workspacePath).workspaceHash);
  assert.equal(f.lease.inspect().state, "owned");
});

test("writer acquisition precedes the optimistic hash re-read with no lost-update window", async () => {
  const f = fixture();
  let reads = 0;
  let dispatches = 0;
  const subject = new ArtifactFacade({
    adapter: adapter(f.workspacePath, () => { dispatches++; }), profile, binding: f.binding,
    mutationQueue: async (_target, _operationId, callback) => callback(),
    workspaceAuthority: {
      readHashes: () => {
        reads++;
        assert.equal(f.lease.inspect().state, "owned", "fresh hash must be read only after writer acquisition");
        if (reads === 1) writeFileSync(join(f.workspacePath, "concurrent.txt"), "won before lease");
        return hashArtifactWorkspace(f.workspacePath);
      },
      lease: f.lease,
      operations: f.operations,
    },
  });
  await assert.rejects(
    () => subject.action(f.caller, { actionId: "set-title", arguments: { title: "must-not-write" }, expectedWorkspaceHash: f.initial.workspaceHash }, { attemptId: "lost-update" }),
    (error) => error instanceof ArtifactFacadeError && error.code === "WORKSPACE_HASH_CONFLICT",
  );
  assert.equal(dispatches, 0);
  assert.equal(f.operations.restore().operations["lost-update"], undefined);
});

test("concurrent same-run mutations atomically revalidate inside the workspace commit lock", async () => {
  const f = fixture();
  const subject = facade(f);
  const settled = await Promise.allSettled([
    subject.action(f.caller, { actionId: "set-title", arguments: { title: "first" }, expectedWorkspaceHash: f.initial.workspaceHash }, { attemptId: "concurrent-first" }),
    subject.action(f.caller, { actionId: "set-title", arguments: { title: "second" }, expectedWorkspaceHash: f.initial.workspaceHash }, { attemptId: "concurrent-second" }),
  ]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
  const rejected = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
  assert.ok(rejected?.reason instanceof ArtifactFacadeError);
  assert.equal(rejected.reason.code, "WORKSPACE_HASH_CONFLICT");
  assert.ok(["first", "second"].includes(readFileSync(join(f.workspacePath, "state.txt"), "utf8")));
});

test("queued writes and durable result commit reassert exact live lease ownership", async () => {
  const beforeWrite = fixture();
  const competingWriter = new WorkspaceLeaseRuntime({ projectRoot: beforeWrite.projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId: "competitor", runId: "competing-run" });
  const guardedQueue = new ArtifactFacade({
    adapter: adapter(beforeWrite.workspacePath), profile, binding: beforeWrite.binding,
    mutationQueue: async (_target, _operationId, callback) => {
      assert.equal(beforeWrite.lease.release(), true);
      assert.equal(competingWriter.acquire().ok, true);
      return callback();
    },
    workspaceAuthority: { readHashes: () => hashArtifactWorkspace(beforeWrite.workspacePath), lease: beforeWrite.lease, operations: beforeWrite.operations },
  });
  await assert.rejects(
    () => guardedQueue.action(beforeWrite.caller, { actionId: "set-title", arguments: { title: "unauthorized" }, expectedWorkspaceHash: beforeWrite.initial.workspaceHash }, { attemptId: "lease-lost-before-write" }),
    (error) => error instanceof ArtifactFacadeError && error.code === "WRITER_LEASE_CONFLICT",
  );
  assert.equal(readFileSync(join(beforeWrite.workspacePath, "state.txt"), "utf8"), "before");
  assert.equal(competingWriter.release(), true);

  const beforeCommit = fixture();
  const replacement = new WorkspaceLeaseRuntime({ projectRoot: beforeCommit.projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId: "replacement", runId: "replacement-run" });
  const commitLossAdapter: ArtifactAdapter = Object.freeze({
    ...adapter(beforeCommit.workspacePath),
    async executeAction(context: ArtifactActionContext, _action: ArtifactActionContract, argumentsValue: Readonly<Record<string, unknown>>) {
      await context.enqueueMutation("state.txt", () => writeFileSync(join(beforeCommit.workspacePath, "state.txt"), String(argumentsValue.title)));
      const committed = result(context.operationId, hashArtifactWorkspace(beforeCommit.workspacePath).workspaceHash);
      assert.equal(beforeCommit.lease.release(), true);
      assert.equal(replacement.acquire().ok, true);
      return committed;
    },
  });
  await assert.rejects(
    () => facade(beforeCommit, commitLossAdapter).action(beforeCommit.caller, { actionId: "set-title", arguments: { title: "written-while-owned" }, expectedWorkspaceHash: beforeCommit.initial.workspaceHash }, { attemptId: "lease-lost-before-commit" }),
    (error) => error instanceof ArtifactFacadeError && error.code === "WRITER_LEASE_CONFLICT",
  );
  assert.equal(beforeCommit.operations.restore().operations["lease-lost-before-commit"].status, "unknown_side_effect");
  assert.equal(replacement.release(), true);
});

test("operation intent precedes W13 mutation queue, result follows commit, and exact completed replay is idempotent", async () => {
  const f = fixture();
  let dispatches = 0;
  const subject = facade(f, adapter(f.workspacePath, () => { dispatches++; }));
  const request = { actionId: "set-title", arguments: { title: "after" }, expectedWorkspaceHash: f.initial.workspaceHash };
  const first = await subject.action(f.caller, request, { attemptId: "operation-replay" });
  assert.equal(dispatches, 1);
  const artifactEvents = readWorkflowJournal(f.projectRoot, "session-1").filter((event) => event.type === "artifact.recorded");
  assert.deepEqual(artifactEvents.map((event) => (event.payload as any).operation), ["intent", "result"]);

  const replay = await subject.action(f.caller, request, { attemptId: "operation-replay" });
  assert.deepEqual(replay, first);
  assert.equal(dispatches, 1);
  await assert.rejects(() => subject.action(f.caller, { ...request, arguments: { title: "different" }, expectedWorkspaceHash: first.workspaceHash }, { attemptId: "operation-replay" }), /different arguments|reuse/i);
});

test("crash before queue reconciles not-applied; during/after mutation never blindly repeats and pauses unknown", async () => {
  const beforeQueue = fixture();
  beforeQueue.operations.begin({ operationId: "before-queue", actionId: "set-title", arguments: { title: "x" }, expectedWorkspaceHash: beforeQueue.initial.workspaceHash });
  const notApplied = recoverArtifactOperation(beforeQueue.operations, "before-queue", hashArtifactWorkspace(beforeQueue.workspacePath), () => undefined);
  assert.equal(notApplied.state, "not-applied");
  assert.equal(beforeQueue.operations.restore().operations["before-queue"].status, "completed");

  const during = fixture();
  during.operations.begin({ operationId: "during", actionId: "set-title", arguments: { title: "partial" }, expectedWorkspaceHash: during.initial.workspaceHash });
  writeFileSync(join(during.workspacePath, "state.txt"), "partial");
  let redispatched = 0;
  const unknown = recoverArtifactOperation(during.operations, "during", hashArtifactWorkspace(during.workspacePath), () => undefined, { redispatch: () => { redispatched++; } });
  assert.equal(unknown.state, "unknown");
  assert.equal(redispatched, 0);
  assert.equal(during.operations.restore().operations.during.status, "unknown_side_effect");

  const restarted = facade(during, adapter(during.workspacePath, () => { redispatched++; }));
  await assert.rejects(() => restarted.action(during.caller, { actionId: "set-title", arguments: { title: "partial" }, expectedWorkspaceHash: during.initial.workspaceHash }, { attemptId: "during" }), /reconciliation|required|unknown/i);
  assert.equal(redispatched, 0);
});

test("restart admission automatically proves an applied interrupted operation from adapter state without redispatch", async () => {
  const f = fixture();
  const request = { actionId: "set-title", arguments: { title: "committed" }, expectedWorkspaceHash: f.initial.workspaceHash };
  f.operations.begin({ operationId: "applied-restart", actionId: "set-title", arguments: request.arguments, expectedWorkspaceHash: f.initial.workspaceHash });
  writeFileSync(join(f.workspacePath, "state.txt"), "committed");
  let dispatches = 0;
  let reconciliations = 0;
  const restarted = facade(f, adapter(f.workspacePath, () => { dispatches++; }, (context) => {
    reconciliations++;
    return { state: "applied", result: result(context.operation.operationId, context.hashes.workspaceHash) };
  }));
  assert.equal(f.lease.acquire().ok, true, "recovery requires exclusive writer authority");
  const report = restarted.recoverUnresolvedOperations();
  assert.deepEqual(report, { recovered: ["applied-restart"], unknown: [], diagnostics: [] });
  const replay = await restarted.action(f.caller, request, { attemptId: "applied-restart" });
  assert.equal(replay.workspaceHash, hashArtifactWorkspace(f.workspacePath).workspaceHash);
  assert.equal(reconciliations, 1);
  assert.equal(dispatches, 0);
});

test("adapter recovery proofs fail closed across thrown, malformed, unknown, and mismatched applied evidence", () => {
  const cases: Array<Readonly<{ reconcile: ArtifactAdapter["reconcileAction"]; diagnostic: RegExp }>> = [
    { reconcile: (() => { throw new Error("proof reader failed"); }), diagnostic: /reconciliation failed.*proof reader failed/i },
    { reconcile: (() => null) as never, diagnostic: /invalid proof/i },
    { reconcile: (() => ({ state: "unknown", diagnostic: "adapter remains uncertain" })), diagnostic: /adapter remains uncertain/i },
    { reconcile: (() => ({ state: "unknown", diagnostic: "uncertain", extra: true })) as never, diagnostic: /invalid unknown proof/i },
    { reconcile: (() => ({ state: "unsupported" })) as never, diagnostic: /unsupported proof state/i },
    { reconcile: ((context: ArtifactOperationRecoveryContext) => ({ state: "applied", result: result(context.operation.operationId, `sha256:${"f".repeat(64)}`) })), diagnostic: /proof hash does not match/i },
    { reconcile: ((context: ArtifactOperationRecoveryContext) => ({ state: "applied", result: { ...result(context.operation.operationId, context.hashes.workspaceHash), actionId: "wrong" } })) as never, diagnostic: /applied proof is invalid/i },
  ];
  for (const [index, candidate] of cases.entries()) {
    const f = fixture();
    const operationId = `proof-${index}`;
    f.operations.begin({ operationId, actionId: "set-title", arguments: { title: "changed" }, expectedWorkspaceHash: f.initial.workspaceHash });
    writeFileSync(join(f.workspacePath, "state.txt"), `changed-${index}`);
    assert.equal(f.lease.acquire().ok, true);
    const report = facade(f, adapter(f.workspacePath, undefined, candidate.reconcile)).recoverUnresolvedOperations();
    assert.deepEqual(report.unknown, [operationId]);
    assert.match(report.diagnostics[0], candidate.diagnostic);
    assert.equal(f.lease.release(), true);
  }
});

test("operation recovery requires an action reconciler and converts authority read faults to durable unknown state", () => {
  for (const mode of ["missing-action", "missing-reconciler"] as const) {
    const f = fixture();
    const actionId = mode === "missing-action" ? "removed-action" : "set-title";
    f.operations.begin({ operationId: mode, actionId, arguments: {}, expectedWorkspaceHash: f.initial.workspaceHash });
    writeFileSync(join(f.workspacePath, "state.txt"), mode);
    assert.equal(f.lease.acquire().ok, true);
    const base = adapter(f.workspacePath);
    const candidate = mode === "missing-reconciler" ? ({ ...base, reconcileAction: undefined } as unknown as ArtifactAdapter) : base;
    const report = facade(f, candidate).recoverUnresolvedOperations();
    assert.deepEqual(report.unknown, [mode]);
    assert.match(report.diagnostics[0], /cannot reconcile/i);
    f.lease.release();
  }

  const failedRead = fixture();
  failedRead.operations.begin({ operationId: "hash-read-fault", actionId: "set-title", arguments: {}, expectedWorkspaceHash: failedRead.initial.workspaceHash });
  assert.equal(failedRead.lease.acquire().ok, true);
  const subject = new ArtifactFacade({
    adapter: adapter(failedRead.workspacePath), profile, binding: failedRead.binding,
    mutationQueue: async (_target, _operationId, callback) => callback(),
    workspaceAuthority: { readHashes: () => { throw "injected hash reader fault"; }, lease: failedRead.lease, operations: failedRead.operations },
  });
  const report = subject.recoverUnresolvedOperations();
  assert.deepEqual(report.unknown, ["hash-read-fault"]);
  assert.match(report.diagnostics[0], /hash reader fault/i);
  assert.equal(subject.recoverUnresolvedOperations().unknown.length, 1, "already-unknown operations remain fail-closed");
  failedRead.lease.release();
});

test("writer heartbeat starts before a long action settles and remains active after action failure", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const longAdapter = Object.freeze({
    ...adapter(f.workspacePath),
    async executeAction(_context: ArtifactActionContext) {
      await gate;
      throw new Error("long action failed");
    },
  });
  const pending = facade(f, longAdapter).action(f.caller, {
    actionId: "set-title", arguments: { title: "long" }, expectedWorkspaceHash: f.initial.workspaceHash,
  }, { attemptId: "long-failed" });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(f.lease.hasLiveHeartbeat(), true, "heartbeat must start immediately after lease acquisition");
  release();
  await assert.rejects(pending, /long action failed/i);
  assert.equal(f.lease.hasLiveHeartbeat(), true, "failed action retains heartbeat until lifecycle release");
  assert.equal(f.lease.release(), true);
  assert.equal(f.lease.hasLiveHeartbeat(), false);
});

test("a crash after durable operation result replays the recorded result without repeating mutation", async () => {
  const f = fixture();
  const crashAfterResult = new ArtifactOperationRuntime({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1",
    fault: (stage) => { if (stage === "afterResult") throw new Error("simulated process death after result"); },
  });
  let dispatches = 0;
  const crashing = facade({ ...f, operations: crashAfterResult }, adapter(f.workspacePath, () => { dispatches++; }));
  const request = { actionId: "set-title", arguments: { title: "committed" }, expectedWorkspaceHash: f.initial.workspaceHash };
  await assert.rejects(() => crashing.action(f.caller, request, { attemptId: "after-result" }), /simulated process death/i);
  assert.equal(dispatches, 1);

  const restarted = facade({
    ...f,
    operations: new ArtifactOperationRuntime({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1" }),
  }, adapter(f.workspacePath, () => { dispatches++; }));
  const replay = await restarted.action(f.caller, request, { attemptId: "after-result" });
  assert.equal(replay.workspaceHash, hashArtifactWorkspace(f.workspacePath).workspaceHash);
  assert.equal(dispatches, 1);
});

test("queue faults retain recoverable intent and unrelated workspace changes invalidate optimistic hash", async () => {
  const f = fixture();
  const failing = new ArtifactFacade({
    adapter: adapter(f.workspacePath), profile, binding: f.binding,
    mutationQueue: async (_target, _operationId, callback) => { await callback(); throw new Error("crash after queued write"); },
    workspaceAuthority: { readHashes: () => hashArtifactWorkspace(f.workspacePath), lease: f.lease, operations: f.operations },
  });
  await assert.rejects(() => failing.action(f.caller, { actionId: "set-title", arguments: { title: "partial" }, expectedWorkspaceHash: f.initial.workspaceHash }, { attemptId: "faulted" }), /crash after queued write/);
  assert.equal(f.operations.restore().operations.faulted.status, "unknown_side_effect");

  const snapshot = hashArtifactWorkspace(f.workspacePath);
  writeFileSync(join(f.workspacePath, "unrelated.txt"), "external");
  await assert.rejects(() => facade(f).action(f.caller, { actionId: "set-title", arguments: { title: "next" }, expectedWorkspaceHash: snapshot.workspaceHash }, { attemptId: "stale-unrelated" }), (error) => error instanceof ArtifactFacadeError && error.code === "WORKSPACE_HASH_CONFLICT");
});
