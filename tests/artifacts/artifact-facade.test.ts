import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import {
  ARTIFACT_ACTION_VERSION,
  ARTIFACT_CONTRACT_LIMITS,
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_PROFILE_VERSION,
  ARTIFACT_VIEW_VERSION,
} from "../../src/artifacts/contracts.ts";
import {
  ArtifactFacade,
  ArtifactFacadeError,
  type ArtifactMutationQueue,
} from "../../src/artifacts/facade.ts";
import { createRunOrchestrationArtifactCallerIssuer } from "../../src/artifacts/internal/caller.ts";
import { assertArtifactWorkspaceEscapeRejected } from "../helpers/artifact-adapter-contract.ts";
import type {
  ArtifactAdapter,
  ArtifactActionResultV1,
  ArtifactRuntimeProfile,
  ArtifactStatusContext,
  ArtifactStatusPageRequest,
  ArtifactStatusViewV1,
  ArtifactWorkspaceBinding,
} from "../../src/artifacts/types.ts";

const strict = { additionalProperties: false } as const;
const action = Object.freeze({
  version: ARTIFACT_ACTION_VERSION,
  id: "update-title",
  label: "Update title",
  argumentsSchemaVersion: "1" as const,
  argumentsSchema: Type.Object({ title: Type.String({ minLength: 1, maxLength: 128 }) }, strict),
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
const workspacePath = mkdtempSync(join(tmpdir(), "hive-artifact-facade-"));
const binding: ArtifactWorkspaceBinding = Object.freeze({
  schemaVersion: 1,
  contractVersion: ARTIFACT_CONTRACT_VERSION,
  adapterId: "fixture",
  adapterVersion: "1",
  profileId: "author",
  profileVersion: ARTIFACT_PROFILE_VERSION,
  binding: "existing",
  workspace: Object.freeze({ id: "fixture-workspace", kind: "physical" as const }),
  path: workspacePath,
  workspaceHash: `sha256:${"a".repeat(64)}`,
  writerLease: Object.freeze({ required: true }),
  checkpointIds: Object.freeze([]),
  actionIds: Object.freeze(["update-title"]),
});

function result(operationId: string, changed = true, summary = "updated"): ArtifactActionResultV1 {
  return Object.freeze({
    schemaVersion: ARTIFACT_ACTION_VERSION,
    operationId,
    actionId: "update-title",
    status: "completed",
    summary,
    changed,
    workspaceHash: `sha256:${"b".repeat(64)}`,
    data: Object.freeze({}),
    refs: Object.freeze([]),
  });
}

function adapter(execute: NonNullable<ArtifactAdapter["executeAction"]>): ArtifactAdapter {
  return Object.freeze({
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    id: "fixture",
    version: "1",
    profiles: Object.freeze([profile]),
    bind() { return binding; },
    status(_context: ArtifactStatusContext, page: ArtifactStatusPageRequest) {
      return Object.freeze({
        schemaVersion: ARTIFACT_VIEW_VERSION,
        contractVersion: ARTIFACT_CONTRACT_VERSION,
        adapter: Object.freeze({ id: "fixture", version: "1" }),
        profile: Object.freeze({ id: "author", version: ARTIFACT_PROFILE_VERSION }),
        workspace: Object.freeze({ id: "fixture-workspace", kind: "physical" as const, binding: "existing" as const, path: binding.path, hash: binding.workspaceHash }),
        status: "ready" as const,
        summary: "ready",
        checkpoints: Object.freeze([]),
        actions: Object.freeze([{ id: "update-title", label: "Update title", available: true }]),
        items: Object.freeze([]),
        page: Object.freeze({ limit: page.limit, ...(page.cursor ? { cursor: page.cursor } : {}) }),
        refs: Object.freeze([]),
      });
    },
    executeAction: execute,
    validateCompletion() { return Object.freeze({ state: "satisfied" as const }); },
  });
}

function snapshot(capabilities: readonly string[], tools: readonly string[] = ["artifact_status", "artifact_action"]) {
  return {
    payload: {
      authority: { nodes: [{ nodeId: "worker", capabilities: { effective: { artifact: capabilities } }, tools }] },
    },
  } as any;
}

function caller(capabilities: readonly string[], workspace: ArtifactWorkspaceBinding = binding, tools?: readonly string[]) {
  return createRunOrchestrationArtifactCallerIssuer(snapshot(capabilities, tools)).issue("worker", workspace);
}

function code(error: unknown, expected: string): boolean {
  return error instanceof ArtifactFacadeError && error.code === expected;
}

test("package caller issuer rejects absent or untrusted authority and revokes with its orchestration service", () => {
  const issuer = createRunOrchestrationArtifactCallerIssuer(snapshot(["read"]));
  assert.throws(() => issuer.issue("missing", binding), /absent|authority/i);
  const foreign = snapshot(["read"], ["foreign_tool"]);
  assert.throws(() => createRunOrchestrationArtifactCallerIssuer(foreign).issue("worker", binding), /trusted authority/i);
  const malformed = snapshot(["read"]);
  (malformed.payload.authority.nodes[0] as any).capabilities = null;
  assert.throws(() => createRunOrchestrationArtifactCallerIssuer(malformed).issue("worker", binding), /authority/i);
  issuer.revoke();
  assert.throws(() => issuer.issue("worker", binding), /no longer active/i);
});

test("facade requires minted caller authority, exact profile action, closed bounded arguments, and trusted workspace state", async () => {
  const facade = new ArtifactFacade({ adapter: adapter(async (context) => result(context.operationId)), profile, binding });
  await assert.rejects(() => facade.action({} as any, { actionId: "update-title", arguments: { title: "x" } }, { attemptId: "attempt-1" }), (error) => code(error, "UNTRUSTED_CALLER"));
  await assert.rejects(() => facade.action(caller(["read"]), { actionId: "update-title", arguments: { title: "x" } }, { attemptId: "attempt-1" }), (error) => code(error, "CAPABILITY_DENIED"));
  await assert.rejects(() => facade.action(caller(["write"], binding, ["artifact_status"]), { actionId: "update-title", arguments: { title: "x" } }, { attemptId: "attempt-1" }), (error) => code(error, "UNTRUSTED_CALLER"));
  await assert.rejects(() => facade.action(caller(["write"]), { actionId: "missing", arguments: {} }, { attemptId: "attempt-1" }), (error) => code(error, "ACTION_UNKNOWN"));
  await assert.rejects(() => facade.action(caller(["write"]), { actionId: "update-title", arguments: { title: "x", extra: true } }, { attemptId: "attempt-1" }), (error) => code(error, "ARGUMENTS_INVALID"));
  await assert.rejects(() => facade.action(caller(["write"]), { actionId: "update-title", arguments: { title: "x" }, workspaceId: "spoof" } as any, { attemptId: "attempt-1" }), (error) => code(error, "REQUEST_INVALID"));
  await assert.rejects(() => facade.action(caller(["write"]), { actionId: "update-title", arguments: { title: "x", workspacePath: "/spoof" } } as any, { attemptId: "attempt-1" }), (error) => code(error, "ARGUMENTS_INVALID"));
  await assert.rejects(() => facade.action(caller(["write"], { ...binding, workspace: { id: "spoof", kind: "physical" } }), { actionId: "update-title", arguments: { title: "x" } }, { attemptId: "attempt-1" }), (error) => code(error, "WORKSPACE_MISMATCH"));
  await assert.rejects(() => facade.action(caller(["write"]), { actionId: "update-title", arguments: { title: "x".repeat(ARTIFACT_CONTRACT_LIMITS.argumentsBytes + 1) } }, { attemptId: "attempt-1" }), (error) => code(error, "ARGUMENTS_INVALID"));
});

test("mutating actions receive the W13 attempt as operation ID and can mutate only through the bounded workspace queue", async () => {
  const queued: Array<{ target: string; operationId: string }> = [];
  const queue: ArtifactMutationQueue = async (target, operationId, callback) => {
    queued.push({ target, operationId });
    return callback();
  };
  const facade = new ArtifactFacade({
    adapter: adapter((context) => context.enqueueMutation("state.json", () => result(context.operationId))),
    profile,
    binding,
    mutationQueue: queue,
  });
  const accepted = await facade.action(caller(["write"]), { actionId: "update-title", arguments: { title: "safe" } }, { attemptId: "attempt-action-1" });
  assert.equal(accepted.operationId, "attempt-action-1");
  assert.deepEqual(queued, [{ target: join(workspacePath, "state.json"), operationId: "attempt-action-1" }]);

  const escaping = new ArtifactFacade({
    adapter: adapter((context) => context.enqueueMutation("../outside.json", () => result(context.operationId))),
    profile,
    binding,
    mutationQueue: queue,
  });
  await assertArtifactWorkspaceEscapeRejected(() => escaping.action(caller(["write"]), { actionId: "update-title", arguments: { title: "escape" } }, { attemptId: "attempt-action-2" }));
  assert.equal(queued.length, 1);

  const noQueue = new ArtifactFacade({ adapter: adapter(async (context) => result(context.operationId)), profile, binding });
  await assert.rejects(() => noQueue.action(caller(["write"]), { actionId: "update-title", arguments: { title: "x" } }, { attemptId: "attempt-action-3" }), (error) => code(error, "MUTATION_QUEUE_REQUIRED"));
});

test("facade awaits every queued mutation and propagates failures in enqueue order when the adapter neglects to await", async () => {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const firstFailure = new Error("first queued mutation failed");
  const secondFailure = new Error("second queued mutation failed");
  const started: string[] = [];
  const settled: string[] = [];
  const facade = new ArtifactFacade({
    adapter: adapter((context) => {
      void context.enqueueMutation("first.json", async () => {
        started.push("first");
        await firstGate;
        settled.push("first");
        throw firstFailure;
      }).catch(() => undefined);
      void context.enqueueMutation("second.json", async () => {
        started.push("second");
        await secondGate;
        settled.push("second");
        throw secondFailure;
      }).catch(() => undefined);
      return result(context.operationId);
    }),
    profile,
    binding,
    mutationQueue: async (_target, _operationId, callback) => callback(),
  });

  let actionSettled = false;
  const actionPromise = facade.action(caller(["write"]), { actionId: "update-title", arguments: { title: "queued" } }, { attemptId: "attempt-queued" });
  void actionPromise.then(() => { actionSettled = true; }, () => { actionSettled = true; });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(started, ["first", "second"]);
  assert.equal(actionSettled, false, "the W13 attempt must remain active while queued mutations are pending");

  releaseSecond();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(settled, ["second"]);
  assert.equal(actionSettled, false, "an early rejection must not skip settlement of another queued mutation");

  releaseFirst();
  await assert.rejects(actionPromise, (error) => error === firstFailure);
  assert.deepEqual(settled, ["second", "first"]);
});

test("facade boundary validators fail closed for malformed pages, attempts, mutation targets, and adapter DTOs", async () => {
  assert.throws(() => new ArtifactFacade({ adapter: adapter(async (context) => result(context.operationId)), profile, binding: { ...binding, profileId: "other" } }), (error) => code(error, "WORKSPACE_MISMATCH"));
  const normal = new ArtifactFacade({ adapter: adapter(async (context) => result(context.operationId, false)), profile, binding, mutationQueue: async (_target, _operationId, callback) => callback() });
  await assert.rejects(() => normal.status(caller(["write"]), { limit: 1 }), (error) => code(error, "CAPABILITY_DENIED"));
  await assert.rejects(() => normal.status(caller(["read"], binding, ["artifact_action"]), { limit: 1 }), (error) => code(error, "UNTRUSTED_CALLER"));
  await assert.rejects(() => normal.status(caller(["read"]), { limit: 1, extra: true } as never), (error) => code(error, "REQUEST_INVALID"));
  await assert.rejects(() => normal.status(caller(["read"]), { limit: 0 }), (error) => code(error, "REQUEST_INVALID"));
  await assert.rejects(() => normal.status(caller(["read"]), { cursor: "" }), (error) => code(error, "REQUEST_INVALID"));
  await assert.rejects(() => normal.action(caller(["write"]), null, { attemptId: "attempt" }), (error) => code(error, "REQUEST_INVALID"));
  await assert.rejects(() => normal.action(caller(["write"]), { actionId: "bad/id", arguments: {} }, { attemptId: "attempt" }), (error) => code(error, "REQUEST_INVALID"));
  await assert.rejects(() => normal.action(caller(["write"]), { actionId: "update-title", arguments: [] }, { attemptId: "attempt" }), (error) => code(error, "ARGUMENTS_INVALID"));
  await assert.rejects(() => normal.action(caller(["write"]), { actionId: "update-title", arguments: { title: "x" } }, { attemptId: "bad/id" }), (error) => code(error, "ATTEMPT_INVALID"));

  const badTarget = new ArtifactFacade({
    adapter: adapter((context) => context.enqueueMutation("/absolute", () => result(context.operationId))),
    profile, binding, mutationQueue: async (_target, _operationId, callback) => callback(),
  });
  await assert.rejects(() => badTarget.action(caller(["write"]), { actionId: "update-title", arguments: { title: "x" } }, { attemptId: "attempt" }), (error) => code(error, "WORKSPACE_ESCAPE"));

  const outside = mkdtempSync(join(tmpdir(), "hive-artifact-outside-"));
  symlinkSync(outside, join(workspacePath, "escaped-link"));
  const symlinkTarget = new ArtifactFacade({
    adapter: adapter((context) => context.enqueueMutation("escaped-link/state.json", () => result(context.operationId))),
    profile, binding, mutationQueue: async (_target, _operationId, callback) => callback(),
  });
  await assert.rejects(() => symlinkTarget.action(caller(["write"]), { actionId: "update-title", arguments: { title: "x" } }, { attemptId: "attempt-symlink" }), (error) => code(error, "WORKSPACE_ESCAPE"));

  const wrongResult = new ArtifactFacade({
    adapter: adapter(async (context) => ({ ...result(context.operationId, false), actionId: "other" })),
    profile, binding, mutationQueue: async (_target, _operationId, callback) => callback(),
  });
  await assert.rejects(() => wrongResult.action(caller(["write"]), { actionId: "update-title", arguments: { title: "x" } }, { attemptId: "attempt" }), (error) => code(error, "RESULT_INVALID"));

  const malformedView = Object.freeze({ ...adapter(async (context) => result(context.operationId, false)), status() { return { schemaVersion: ARTIFACT_VIEW_VERSION, summary: "short" } as any; } });
  await assert.rejects(() => new ArtifactFacade({ adapter: malformedView, profile, binding }).status(caller(["read"]), { limit: 1 }), (error) => code(error, "VIEW_INVALID"));
});

test("status pagination is closed, cursor-bound, and never returns more items than requested", async () => {
  const base = adapter(async (context) => result(context.operationId, false));
  const malformed = (mutate: (view: Record<string, any>) => void) => Object.freeze({
    ...base,
    status(context: ArtifactStatusContext, page: ArtifactStatusPageRequest) {
      const view = structuredClone(base.status(context, page) as Record<string, any>);
      mutate(view);
      return view as ArtifactStatusViewV1;
    },
  });
  for (const mutate of [
    (view: Record<string, any>) => { view.items = [{ id: "one", kind: "entry", label: "One", state: "ready" }, { id: "two", kind: "entry", label: "Two", state: "ready" }]; },
    (view: Record<string, any>) => { view.page.cursor = "other"; },
    (view: Record<string, any>) => { view.page.nextCursor = "x".repeat(ARTIFACT_CONTRACT_LIMITS.cursorCharacters + 1); },
    (view: Record<string, any>) => { view.page.extra = true; },
    (view: Record<string, any>) => { view.refs = [{ id: "ref", kind: "file", extra: true }]; },
  ]) {
    const facade = new ArtifactFacade({ adapter: malformed(mutate), profile, binding });
    await assert.rejects(() => facade.status(caller(["read"]), { limit: 1, cursor: "bound" }), (error) => code(error, "VIEW_INVALID"));
  }
});

test("facade validates bounded standard status/action views and explicit pagination refs", async () => {
  const good = new ArtifactFacade({ adapter: adapter(async (context) => result(context.operationId, false)), profile, binding });
  const view = await good.status(caller(["read"]), { limit: 5 });
  assert.equal(view.page.limit, 5);
  assert.equal(view.workspace.id, binding.workspace.id);

  const oversizedAdapter = adapter(async (context) => result(context.operationId, false, "x".repeat(ARTIFACT_CONTRACT_LIMITS.resultBytes + 1)));
  const oversized = new ArtifactFacade({ adapter: oversizedAdapter, profile, binding, mutationQueue: async (_target, _operationId, callback) => callback() });
  await assert.rejects(() => oversized.action(caller(["write"]), { actionId: "update-title", arguments: { title: "x" } }, { attemptId: "attempt-4" }), (error) => code(error, "RESULT_LIMIT_EXCEEDED"));

  const badViewAdapter = Object.freeze({ ...adapter(async (context) => result(context.operationId, false)), status() { return { schemaVersion: 1, summary: "x".repeat(ARTIFACT_CONTRACT_LIMITS.viewBytes + 1) } as any; } });
  const badView = new ArtifactFacade({ adapter: badViewAdapter, profile, binding });
  await assert.rejects(() => badView.status(caller(["read"]), { limit: 1 }), (error) => code(error, "VIEW_LIMIT_EXCEEDED"));
});
