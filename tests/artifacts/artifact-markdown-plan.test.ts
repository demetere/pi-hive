import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  MARKDOWN_PLAN_ACTION_IDS,
  MARKDOWN_PLAN_ARTIFACT_ADAPTER,
  MARKDOWN_PLAN_CHECKPOINT_IDS,
  MARKDOWN_PLAN_DEFAULT_ROOT,
  MARKDOWN_PLAN_LIMITS,
  MARKDOWN_PLAN_PROFILES,
  createMarkdownPlanAdapter,
  markdownPlanProtectedRoots,
} from "../../src/artifacts/adapters/markdown-plan.ts";
import { resolveCheckpointDigest } from "../../src/artifacts/checkpoints.ts";
import { ARTIFACT_CONTRACT_VERSION } from "../../src/artifacts/contracts.ts";
import { ARTIFACT_HASH_LIMITS, hashArtifactWorkspace } from "../../src/artifacts/hashes.ts";
import { BUILTIN_ARTIFACT_REGISTRY } from "../../src/artifacts/registry.ts";
import { bindPhysicalArtifactWorkspace, listPhysicalArtifactWorkspaces } from "../../src/artifacts/workspaces.ts";
import type { ArtifactActionContext, ArtifactEvidenceReferenceV1, ArtifactWorkspaceBinding, VerifiedArtifactEvidenceV1 } from "../../src/artifacts/types.ts";
import { compileFilesystemPolicy, authorizeFilesystemOperation } from "../../src/capabilities/filesystem.ts";
import { normalizeCapabilities } from "../../src/capabilities/policy.ts";
import type { EffectiveNodePolicy } from "../../src/capabilities/types.ts";
import { boundedJson } from "../../src/workflows/values.ts";
import { assertArtifactActionFilesystemContained, assertArtifactAdapterContract } from "../helpers/artifact-adapter-contract.ts";

function project(label: string): string { return mkdtempSync(join(tmpdir(), `hive-markdown-plan-${label}-`)); }
function profile(id: keyof typeof MARKDOWN_PLAN_PROFILES) { return MARKDOWN_PLAN_PROFILES[id]; }
function binding(root: string, profileId: keyof typeof MARKDOWN_PLAN_PROFILES, id = "add-auth", planRoot = MARKDOWN_PLAN_DEFAULT_ROOT): ArtifactWorkspaceBinding {
  const selected = profile(profileId);
  const path = join(root, ...planRoot.split("/"), id);
  return Object.freeze({
    schemaVersion: 1 as const, contractVersion: ARTIFACT_CONTRACT_VERSION, adapterId: "markdown-plan", adapterVersion: "1",
    profileId, profileVersion: "1" as const, binding: profileId === "execute" || profileId === "review" ? "existing" as const : "either" as const,
    selection: "existing" as const, workspace: Object.freeze({ id, kind: "physical" as const }), path,
    workspaceHash: hashArtifactWorkspace(path).workspaceHash, writerLease: Object.freeze({ required: true }), checkpointIds: selected.checkpointIds,
    actionIds: selected.actions.map((action) => action.id),
  });
}
function context(value: ArtifactWorkspaceBinding, operationId: string): ArtifactActionContext {
  return Object.freeze({
    binding: Object.freeze({ ...value, workspaceHash: hashArtifactWorkspace(value.path!).workspaceHash }),
    capabilities: Object.freeze(["read", "write", "review"] as const), hashes: hashArtifactWorkspace(value.path!), operationId,
    expectedWorkspaceHash: hashArtifactWorkspace(value.path!).workspaceHash,
    enqueueMutation: async <T>(_path: string, callback: () => T | Promise<T>): Promise<T> => callback(),
    verifyEvidence: (references: readonly ArtifactEvidenceReferenceV1[]): readonly VerifiedArtifactEvidenceV1[] => references.map((reference) => {
      if (reference.kind === "tool") return { kind: "tool" as const, attemptId: reference.attemptId, operation: "tool.test", inputHash: "a".repeat(64), resultHash: "b".repeat(64) };
      if (reference.kind === "command") return { kind: "command" as const, attemptId: reference.attemptId, effect: "shell", operation: "command.test", inputHash: "a".repeat(64), resultHash: "b".repeat(64) };
      const workspace = value.path!;
      const metadata = JSON.parse(readFileSync(join(workspace, ".pi-hive", "workspace-v1.json"), "utf8")) as { planRoot: string };
      let projectRoot = workspace;
      for (let count = 0; count <= metadata.planRoot.split("/").length; count++) projectRoot = join(projectRoot, "..");
      const content = readFileSync(join(projectRoot, reference.path));
      const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
      if (digest !== reference.digest) throw new Error("Repository evidence hash is stale");
      return { kind: "repository" as const, path: reference.path, digest, bytes: content.byteLength };
    }),
  });
}
async function invoke(adapter: ReturnType<typeof createMarkdownPlanAdapter>, value: ArtifactWorkspaceBinding, actionId: string, args: Record<string, unknown>, operationId: string) {
  const selected = adapter.profiles.find((entry) => entry.id === value.profileId)!;
  const action = selected.actions.find((entry) => entry.id === actionId)!;
  assert.ok(action, `${actionId} is published by ${selected.id}`);
  return adapter.executeAction!(context(value, operationId), action, args as never);
}
const planInput = {
  title: "Add authentication",
  summary: "Add bounded session authentication without changing unrelated APIs.",
  tasks: [{ id: "session-store", text: "Implement the session store" }, { id: "auth-tests", text: "Add authentication tests" }],
};

test("Markdown plan finalizes the exact options/profile/checkpoint/action contract", () => {
  assertArtifactAdapterContract(MARKDOWN_PLAN_ARTIFACT_ADAPTER);
  assert.equal(MARKDOWN_PLAN_DEFAULT_ROOT, "plans");
  assert.deepEqual(MARKDOWN_PLAN_CHECKPOINT_IDS, ["plan", "execution", "review"]);
  assert.deepEqual(MARKDOWN_PLAN_ACTION_IDS, [
    "markdown-plan.plan.read", "markdown-plan.plan.author", "markdown-plan.plan.update", "markdown-plan.validate",
    "markdown-plan.tasks.list", "markdown-plan.tasks.complete", "markdown-plan.review.inspect",
  ]);
  const rows = {
    author: { bindings: ["new", "existing", "either"], checkpoints: ["plan"], actions: MARKDOWN_PLAN_ACTION_IDS.slice(0, 4), mandatory: ["markdown-plan.plan.author", "markdown-plan.plan.update"] },
    execute: { bindings: ["existing"], checkpoints: ["plan", "execution"], actions: [MARKDOWN_PLAN_ACTION_IDS[0], MARKDOWN_PLAN_ACTION_IDS[3], MARKDOWN_PLAN_ACTION_IDS[4], MARKDOWN_PLAN_ACTION_IDS[5]], mandatory: ["markdown-plan.tasks.complete"] },
    review: { bindings: ["existing"], checkpoints: ["execution", "review"], actions: [MARKDOWN_PLAN_ACTION_IDS[0], MARKDOWN_PLAN_ACTION_IDS[3], MARKDOWN_PLAN_ACTION_IDS[4], MARKDOWN_PLAN_ACTION_IDS[6]], mandatory: [] },
    lifecycle: { bindings: ["new", "existing", "either"], checkpoints: MARKDOWN_PLAN_CHECKPOINT_IDS, actions: MARKDOWN_PLAN_ACTION_IDS, mandatory: ["markdown-plan.plan.author", "markdown-plan.plan.update", "markdown-plan.tasks.complete"] },
  } as const;
  for (const [id, expected] of Object.entries(rows)) {
    const actual = MARKDOWN_PLAN_PROFILES[id as keyof typeof MARKDOWN_PLAN_PROFILES];
    assert.deepEqual(actual.bindings, expected.bindings);
    assert.deepEqual(actual.checkpointIds, expected.checkpoints);
    assert.deepEqual(actual.actions.map((action) => action.id), expected.actions);
    assert.deepEqual(actual.actions.filter((action) => action.completion === "mandatory").map((action) => action.id), expected.mandatory);
    assert.equal(Value.Check(actual.optionsSchema, {}), true);
    assert.equal(Value.Check(actual.optionsSchema, { root: "docs/plans" }), true);
    for (const invalid of [{ root: "../plans" }, { root: "/plans" }, { root: "plans\\bad" }, { extra: true }]) assert.equal(Value.Check(actual.optionsSchema, invalid), false);
    const resolved = BUILTIN_ARTIFACT_REGISTRY.resolveProfile({ contractVersion: ARTIFACT_CONTRACT_VERSION, adapterId: "markdown-plan", adapterVersion: "1", profileId: id, profileVersion: "1" });
    assert.equal(resolved.adapter.id, "markdown-plan");
    assert.deepEqual(BUILTIN_ARTIFACT_REGISTRY.validateOptions(resolved.profile, { root: "docs/plans" }), { root: "docs/plans" });
  }
});

test("workspace IDs map exactly to a default or configured contained plan root and list without latest selection", () => {
  const root = project("workspace");
  const adapter = createMarkdownPlanAdapter();
  assert.throws(() => bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: profile("author"), runId: "run", configuredBinding: "either", options: {} }), /explicit|latest/i);
  assert.throws(() => bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: profile("author"), runId: "run", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "../escape" } }), /workspace ID/i);
  const first = bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: profile("author"), runId: "run-1", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "add-auth" } });
  assert.equal(first.path, join(root, "plans", "add-auth"));
  const configured = bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: profile("author"), runId: "run-2", configuredBinding: "new", options: { root: "docs/plans" }, selection: { mode: "new", workspaceId: "other-plan" } });
  assert.equal(configured.path, join(root, "docs", "plans", "other-plan"));
  assert.throws(() => bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: profile("author"), runId: "run-3", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "add-auth" } }), /collision|exists/i);
  const listed = listPhysicalArtifactWorkspaces({ projectRoot: root, adapter, profile: profile("author"), options: {}, limit: 1 });
  assert.deepEqual(listed.items.map((item) => item.id), ["add-auth"]);
  assert.equal(listed.nextCursor, undefined);
  assert.deepEqual(markdownPlanProtectedRoots({ root: "docs/plans" }), [{ path: "docs/plans", kind: "artifact" }]);
  assert.deepEqual((adapter as any).protectedWorkspaceRoots?.({ projectRoot: root, profile: profile("author"), options: { root: "docs/plans" } }), [{ path: "docs/plans", kind: "artifact" }]);
});

test("canonical frontmatter, section structure, stable tasks, validation bounds, and revisions are enforced", async () => {
  const root = project("format");
  const adapter = createMarkdownPlanAdapter({ now: () => "2026-01-01T00:00:00.000Z" });
  const value = bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: profile("lifecycle"), runId: "run", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "add-auth" } });
  await assertArtifactActionFilesystemContained({ filesystemRoot: root, workspacePath: value.path!, invoke: () => invoke(adapter, value, "markdown-plan.plan.author", planInput, "author-plan") });
  const source = readFileSync(join(value.path!, "plan.md"), "utf8");
  assert.match(source, /^---\nschema-version: 1\nplan-id: add-auth\ntitle: "Add authentication"\nrevision: 1\nlast-operation-id: author-plan\n---\n\n# Summary\n/u);
  assert.match(source, /# Tasks\n\n- \[ \] session-store: Implement the session store\n- \[ \] auth-tests: Add authentication tests\n$/u);
  const validation = await invoke(adapter, binding(root, "lifecycle"), "markdown-plan.validate", {}, "validate");
  assert.deepEqual(validation.data, { valid: true, revision: 1, taskCount: 2, issues: [] });
  await assert.rejects(() => invoke(adapter, binding(root, "lifecycle"), "markdown-plan.plan.author", planInput, "author-twice"), /already authored/i);
  await assert.rejects(() => invoke(adapter, binding(root, "lifecycle"), "markdown-plan.plan.update", { ...planInput, tasks: [{ id: "same", text: "One" }, { id: "same", text: "Two" }] }, "duplicate"), /duplicate|task/i);
  await invoke(adapter, binding(root, "lifecycle"), "markdown-plan.plan.update", { ...planInput, summary: "Revised summary." }, "revise-plan");
  assert.match(readFileSync(join(value.path!, "plan.md"), "utf8"), /revision: 2\nlast-operation-id: revise-plan/u);
  writeFileSync(join(value.path!, "plan.md"), readFileSync(join(value.path!, "plan.md"), "utf8").replace("# Summary", "# Unexpected"));
  const invalid = await invoke(adapter, binding(root, "lifecycle"), "markdown-plan.validate", {}, "invalid");
  assert.equal(invalid.data.valid, false);
  assert.equal((await adapter.validateCompletion(binding(root, "lifecycle"))).state, "unsatisfied");
});

test("execution evidence is adapter-sidecar state bound to exact plan bytes and current repository evidence", async () => {
  const root = project("evidence"); mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "auth.ts"), "export const auth = true;\n");
  const digest = `sha256:${createHash("sha256").update(readFileSync(join(root, "src", "auth.ts"))).digest("hex")}`;
  const adapter = createMarkdownPlanAdapter({ now: () => "2026-01-01T00:00:00.000Z" });
  const created = bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: profile("lifecycle"), runId: "run", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "add-auth" } });
  await invoke(adapter, created, "markdown-plan.plan.author", planInput, "author");
  let value = binding(root, "lifecycle");
  const before = hashArtifactWorkspace(value.path!);
  const planDigest = resolveCheckpointDigest(adapter.checkpointDescriptor!({ binding: value, checkpointId: "plan", hashes: before }), before).digest;
  const executionBefore = resolveCheckpointDigest(adapter.checkpointDescriptor!({ binding: value, checkpointId: "execution", hashes: before }), before).digest;
  const planBytes = readFileSync(join(value.path!, "plan.md"));
  await invoke(adapter, value, "markdown-plan.tasks.complete", { taskId: "session-store", evidenceRefs: [{ kind: "command", attemptId: "command-1" }, { kind: "repository", path: "src/auth.ts", digest }] }, "complete-session");
  assert.deepEqual(readFileSync(join(value.path!, "plan.md")), planBytes);
  const sidecar = JSON.parse(readFileSync(join(value.path!, ".pi-hive", "evidence-v1.json"), "utf8"));
  assert.equal(sidecar.tasks["session-store"].operationId, "complete-session");
  const after = hashArtifactWorkspace(value.path!);
  assert.equal(resolveCheckpointDigest(adapter.checkpointDescriptor!({ binding: value, checkpointId: "plan", hashes: after }), after).digest, planDigest);
  assert.notEqual(resolveCheckpointDigest(adapter.checkpointDescriptor!({ binding: value, checkpointId: "execution", hashes: after }), after).digest, executionBefore);
  assert.equal((await adapter.validateCompletion(value)).state, "unsatisfied");
  await invoke(adapter, value, "markdown-plan.tasks.complete", { taskId: "auth-tests", evidenceRefs: [{ kind: "tool", attemptId: "tool-2" }, { kind: "repository", path: "src/auth.ts", digest }] }, "complete-tests");
  assert.equal((await adapter.validateCompletion(value)).state, "satisfied");
  writeFileSync(join(root, "src", "auth.ts"), "export const auth = false;\n");
  assert.match((await adapter.validateCompletion(value)).issues?.join(" ") ?? "", /repository|stale|hash/i);
  writeFileSync(join(root, "src", "auth.ts"), "export const auth = true;\n");
  await invoke(adapter, value, "markdown-plan.plan.update", { ...planInput, summary: "Denied digest revision." }, "revision");
  value = binding(root, "lifecycle");
  assert.match((await adapter.validateCompletion(value)).issues?.join(" ") ?? "", /plan|revision|evidence|stale/i);
});

test("every published profile/binding completion combination enforces its exact authored and executed state", async () => {
  const root = project("completion-matrix"); mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "proof.ts"), "proof\n");
  const adapter = createMarkdownPlanAdapter();
  const created = bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: profile("lifecycle"), runId: "run", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "matrix" } });
  const forProfile = (profileId: keyof typeof MARKDOWN_PLAN_PROFILES, configuredBinding: "new" | "existing" | "either") => Object.freeze({ ...binding(root, profileId, "matrix"), binding: configuredBinding });
  const combinations = (profileId: keyof typeof MARKDOWN_PLAN_PROFILES) => profile(profileId).bindings.filter((entry): entry is "new" | "existing" | "either" => entry !== "none").map((entry) => forProfile(profileId, entry));
  for (const profileId of ["author", "execute", "review", "lifecycle"] as const) {
    for (const candidate of combinations(profileId)) assert.equal((await adapter.validateCompletion(candidate)).state, "unsatisfied", `${profileId}/${candidate.binding} before authoring`);
  }
  await invoke(adapter, created, "markdown-plan.plan.author", { ...planInput, tasks: [{ id: "proof", text: "Prove completion" }] }, "matrix-author");
  for (const candidate of combinations("author")) assert.equal((await adapter.validateCompletion(candidate)).state, "satisfied", `author/${candidate.binding} after authoring`);
  for (const profileId of ["execute", "review", "lifecycle"] as const) for (const candidate of combinations(profileId)) assert.equal((await adapter.validateCompletion(candidate)).state, "unsatisfied", `${profileId}/${candidate.binding} before evidence`);
  const digest = `sha256:${createHash("sha256").update(readFileSync(join(root, "src", "proof.ts"))).digest("hex")}`;
  const lifecycleBinding = forProfile("lifecycle", "either");
  await invoke(adapter, lifecycleBinding, "markdown-plan.tasks.complete", { taskId: "proof", evidenceRefs: [{ kind: "tool", attemptId: "tool-proof" }, { kind: "repository", path: "src/proof.ts", digest }] }, "matrix-complete");
  for (const profileId of ["execute", "review", "lifecycle"] as const) for (const candidate of combinations(profileId)) assert.equal((await adapter.validateCompletion(candidate)).state, "satisfied", `${profileId}/${candidate.binding} after evidence`);
  const listed = await invoke(adapter, forProfile("execute", "existing"), "markdown-plan.tasks.list", {}, "matrix-list");
  assert.deepEqual(listed.data.tasks, [{ taskId: "proof", text: "Prove completion", completed: true, evidenceRefCount: 2 }]);
  const completeAction = profile("lifecycle").actions.find((entry) => entry.id === "markdown-plan.tasks.complete")!;
  const recovery = adapter.reconcileAction({ binding: lifecycleBinding, hashes: hashArtifactWorkspace(lifecycleBinding.path!), operation: { operationId: "matrix-complete", actionId: completeAction.id, inputHash: "a", expectedWorkspaceHash: lifecycleBinding.workspaceHash!, intentAt: "2026-01-01T00:00:00.000Z" } }, completeAction);
  assert.equal(recovery.state, "applied");
});

test("generic file tools reserve default and configured Markdown roots while facade mutations remain the owner", () => {
  const root = project("reserved");
  mkdirSync(join(root, "plans", "a"), { recursive: true }); writeFileSync(join(root, "plans", "a", "plan.md"), "x");
  mkdirSync(join(root, "docs", "plans", "b"), { recursive: true }); writeFileSync(join(root, "docs", "plans", "b", "plan.md"), "x");
  const capabilities = normalizeCapabilities({ filesystem: [{ path: ".", operations: ["read", "create", "update", "delete"] }] });
  const effective = { workflowId: "delivery", nodeId: "root", agentId: "root", capabilities, provenance: {}, tools: [], budgets: {}, skills: [], knowledge: [], directMemberIds: [] } as unknown as EffectiveNodePolicy;
  const resolved = BUILTIN_ARTIFACT_REGISTRY.resolveProfile({ contractVersion: ARTIFACT_CONTRACT_VERSION, adapterId: "markdown-plan", adapterVersion: "1", profileId: "author", profileVersion: "1" });
  const policy = compileFilesystemPolicy({ projectRoot: root, effectivePolicy: effective, artifact: { resolved, options: { root: "docs/plans" } } } as any);
  for (const path of ["plans/a/plan.md", "docs/plans/b/plan.md"]) {
    const result = authorizeFilesystemOperation(policy, { operation: "update", path });
    assert.equal(result.ok, false); assert.equal(result.code, "FILESYSTEM_PROTECTED");
  }
});

test("Markdown plan bounded failure, pagination, handoff, and recovery branches fail closed", async () => {
  const root = project("edges");
  const adapter = createMarkdownPlanAdapter({ now: () => "2026-01-01T00:00:00.000Z" });
  for (const options of [{ root: ".pi/plans" }, { root: "openspec/plans" }, { root: "../plans" }, { unknown: true }]) {
    assert.throws(() => markdownPlanProtectedRoots(options as never), /option|root|invalid/i);
  }
  const absent = project("absent-list");
  assert.deepEqual(listPhysicalArtifactWorkspaces({ projectRoot: absent, adapter, profile: profile("author"), limit: 2 }), { items: [] });
  assert.equal(adapter.workspaceLifecycle!.resolve({ projectRoot: absent, profileId: "author", workspaceId: "missing", options: {} }), undefined);
  assert.throws(() => (adapter as any).protectedWorkspaceRoots({ projectRoot: root, profile: {}, options: {} }), /profile/i);
  for (const id of ["alpha", "beta", "gamma"]) {
    bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: profile("author"), runId: `run-${id}`, configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: id } });
  }
  const first = listPhysicalArtifactWorkspaces({ projectRoot: root, adapter, profile: profile("author"), limit: 1 });
  assert.deepEqual(first.items.map((entry) => entry.id), ["alpha"]); assert.ok(first.nextCursor);
  const second = listPhysicalArtifactWorkspaces({ projectRoot: root, adapter, profile: profile("author"), limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((entry) => entry.id), ["beta"]); assert.ok(second.nextCursor);
  assert.throws(() => listPhysicalArtifactWorkspaces({ projectRoot: root, adapter, profile: profile("author"), limit: 1, cursor: "bad" }), /cursor/i);
  assert.throws(() => listPhysicalArtifactWorkspaces({ projectRoot: root, adapter, profile: profile("author"), limit: 1, cursor: "markdown-plan-v1:99" }), /stale/i);

  let value = binding(root, "author", "alpha");
  const empty = await adapter.status({ binding: value, capabilities: ["read"], hashes: hashArtifactWorkspace(value.path!) }, { limit: 1 });
  assert.equal(empty.status, "blocked"); assert.equal(empty.actions.some((entry) => !entry.available), true);
  const unread = await invoke(adapter, value, "markdown-plan.plan.read", {}, "read-empty");
  assert.ok(Array.isArray(unread.data.issues));
  await invoke(adapter, value, "markdown-plan.plan.author", planInput, "recover-author");
  value = binding(root, "author", "alpha");
  const read = await invoke(adapter, value, "markdown-plan.plan.read", {}, "read-current");
  assert.equal(read.data.revision, 1);
  await assert.rejects(() => invoke(adapter, value, "markdown-plan.plan.read", { cursor: "bad" }, "read-bad-cursor"), /cursor/i);
  await assert.rejects(() => invoke(adapter, value, "markdown-plan.plan.read", { cursor: "markdown-plan-read-v1:999999" }, "read-stale-cursor"), /stale/i);
  assert.throws(() => adapter.status({ binding: value, capabilities: ["read"], hashes: hashArtifactWorkspace(value.path!) }, { limit: 1, cursor: "bad" }), /cursor/i);
  assert.throws(() => adapter.status({ binding: value, capabilities: ["read"], hashes: hashArtifactWorkspace(value.path!) }, { limit: 1, cursor: "markdown-plan-status-v1:999999" }), /stale/i);
  const authorAction = profile("author").actions.find((entry) => entry.id === "markdown-plan.plan.author")!;
  const authorRecovery = adapter.reconcileAction({ binding: value, hashes: hashArtifactWorkspace(value.path!), operation: { operationId: "recover-author", actionId: authorAction.id, inputHash: "a", expectedWorkspaceHash: value.workspaceHash!, intentAt: "2026-01-01T00:00:00.000Z" } }, authorAction);
  assert.equal(authorRecovery.state, "applied");
  const unknownRecovery = adapter.reconcileAction({ binding: value, hashes: hashArtifactWorkspace(value.path!), operation: { operationId: "other", actionId: authorAction.id, inputHash: "a", expectedWorkspaceHash: value.workspaceHash!, intentAt: "2026-01-01T00:00:00.000Z" } }, authorAction);
  assert.equal(unknownRecovery.state, "unknown");
  assert.throws(() => adapter.checkpointDescriptor!({ binding: value, checkpointId: "unknown", hashes: hashArtifactWorkspace(value.path!) }), /checkpoint/i);
  const lifecycle = adapter.workspaceLifecycle!;
  assert.equal(lifecycle.validateHandoffReference!({ projectRoot: root, profileId: "author", reference: { workspaceId: "wrong", checkpoint: "plan", digest: `sha256:${"a".repeat(64)}` }, workspace: { id: "alpha", path: value.path! }, hashes: hashArtifactWorkspace(value.path!) }).state, "incompatible");

  const execute = binding(root, "execute", "alpha");
  const firstTasks = await invoke(adapter, execute, "markdown-plan.tasks.list", { limit: 1 }, "tasks-first");
  assert.equal((firstTasks.data.tasks as unknown[]).length, 1); assert.ok(firstTasks.data.nextCursor);
  const secondTasks = await invoke(adapter, execute, "markdown-plan.tasks.list", { limit: 1, cursor: firstTasks.data.nextCursor }, "tasks-second");
  assert.equal((secondTasks.data.tasks as unknown[]).length, 1);
  await assert.rejects(() => invoke(adapter, execute, "markdown-plan.tasks.list", { cursor: "bad" }, "tasks-invalid"), /cursor|schema/i);
  await assert.rejects(() => invoke(adapter, execute, "markdown-plan.tasks.list", { cursor: "markdown-plan-tasks-v1:999999" }, "tasks-stale"), /stale/i);
  const completeAction = profile("execute").actions.find((entry) => entry.id === "markdown-plan.tasks.complete")!;
  await assert.rejects(() => Promise.resolve(adapter.executeAction!({ ...context(execute, "missing-verifier"), verifyEvidence: undefined }, completeAction, { taskId: "session-store", evidenceRefs: [{ kind: "tool", attemptId: "tool" }] })), /verification|evidence/i);
  assert.equal((await adapter.validateCompletion(execute)).state, "unsatisfied");
  writeFileSync(join(execute.path!, ".pi-hive", "evidence-v1.json"), "not-json\n");
  assert.equal((await adapter.validateCompletion(execute)).state, "unsatisfied");
});

test("bounded status/review views expose plain data without raw HTML or human approval authority", async () => {
  const root = project("view");
  const adapter = createMarkdownPlanAdapter();
  const created = bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: profile("lifecycle"), runId: "run", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "safe-view" } });
  await invoke(adapter, created, "markdown-plan.plan.author", { ...planInput, tasks: [{ id: "safe", text: "Inspect <img src=x onerror=alert(1)> safely" }] }, "author");
  const value = binding(root, "lifecycle", "safe-view");
  const view = await adapter.status({ binding: value, capabilities: ["read", "write", "review"], hashes: hashArtifactWorkspace(value.path!) }, { limit: 20 });
  assert.doesNotMatch(JSON.stringify(view), /<\/?(?:script|img)|react|dangerouslySetInnerHTML/iu);
  assert.ok(Buffer.byteLength(JSON.stringify(view), "utf8") <= 65_536);
  const review = await invoke(adapter, value, "markdown-plan.review.inspect", {}, "review");
  assert.equal("decision" in review.data || "approved" in review.data, false);
});

test("status and plan reads paginate by JSON-escaped output bytes without making any legal plan unreadable", async () => {
  const root = project("escaped-pages");
  const adapter = createMarkdownPlanAdapter();
  const created = bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: profile("lifecycle"), runId: "run", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "escaped-pages" } });
  const tasks = Array.from({ length: 20 }, (_, index) => ({ id: `task-${index}`, text: `${String.fromCharCode(1)}${"x".repeat(1_800)}` }));
  await invoke(adapter, created, "markdown-plan.plan.author", { title: "Escaped output", summary: `${String.fromCharCode(2)} escaped summary`, tasks }, "author-escaped");
  const value = binding(root, "lifecycle", "escaped-pages");

  const viewed = new Set<string>();
  let statusCursor: string | undefined;
  do {
    const view = await adapter.status({ binding: value, capabilities: ["read", "write", "review"], hashes: hashArtifactWorkspace(value.path!) }, { limit: 40, ...(statusCursor ? { cursor: statusCursor } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(view), "utf8") <= 65_536);
    for (const item of view.items) { viewed.add(item.id); assert.ok(item.ref); }
    statusCursor = view.page.nextCursor;
  } while (statusCursor);
  assert.equal(viewed.size, tasks.length);

  let source = "";
  let readCursor: string | undefined;
  do {
    const result = await invoke(adapter, value, "markdown-plan.plan.read", readCursor ? { cursor: readCursor } : {}, `read-${source.length}`);
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 65_536);
    source += String(result.data.source);
    const page = result.data.page as { nextCursor?: string };
    readCursor = page.nextCursor;
  } while (readCursor);
  assert.equal(source, readFileSync(join(value.path!, "plan.md"), "utf8"));
});

test("evidence sidecars fail closed instead of silently resetting invalid durable state", async () => {
  const root = project("corrupt-evidence"); mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "proof.ts"), "proof\n");
  const adapter = createMarkdownPlanAdapter();
  const created = bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: profile("lifecycle"), runId: "run", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "corrupt-evidence" } });
  await invoke(adapter, created, "markdown-plan.plan.author", { ...planInput, tasks: [{ id: "proof", text: "Keep durable proof" }] }, "author");
  const value = binding(root, "lifecycle", "corrupt-evidence");
  const evidencePath = join(value.path!, ".pi-hive", "evidence-v1.json");
  const corrupt = "{\"schemaVersion\":1,\"tasks\":BROKEN}\n";
  writeFileSync(evidencePath, corrupt);
  const digest = `sha256:${createHash("sha256").update(readFileSync(join(root, "src", "proof.ts"))).digest("hex")}`;
  await assert.rejects(() => invoke(adapter, value, "markdown-plan.tasks.complete", { taskId: "proof", evidenceRefs: [{ kind: "tool", attemptId: "tool" }, { kind: "repository", path: "src/proof.ts", digest }] }, "must-not-reset"), /evidence|invalid|JSON/i);
  assert.equal(readFileSync(evidencePath, "utf8"), corrupt);
});

test("sidecar structural and physical bounds cover the full 256 by 32 contract with strict node semantics", () => {
  const worstCaseNodes = 7 + MARKDOWN_PLAN_LIMITS.tasks * (6 + MARKDOWN_PLAN_LIMITS.evidenceRefsPerTask * 7);
  assert.ok(worstCaseNodes <= MARKDOWN_PLAN_LIMITS.sidecarNodes);
  assert.ok(MARKDOWN_PLAN_LIMITS.sidecarBytes <= ARTIFACT_HASH_LIMITS.fileBytes);
  const exactly2_048 = Array.from({ length: 2_047 }, () => null);
  assert.equal((boundedJson(exactly2_048, "exact nodes", { bytes: 16_384, depth: 2, nodes: 2_048 }) as unknown[]).length, 2_047);
  assert.throws(() => boundedJson([...exactly2_048, null], "extra node", { bytes: 16_384, depth: 2, nodes: 2_048 }), /structural limit/i);
});

test("task and evidence bounds accept N and reject N+1 while all 256 tasks can retain completion", async () => {
  const root = project("maximum"); mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "proof.ts"), "proof\n");
  const adapter = createMarkdownPlanAdapter({ now: () => "2026-01-01T00:00:00.000Z" });
  const created = bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: profile("lifecycle"), runId: "run", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "maximum" } });
  const tasks = Array.from({ length: MARKDOWN_PLAN_LIMITS.tasks }, (_, index) => ({ id: `task-${index}`, text: `Task ${index}` }));
  await invoke(adapter, created, "markdown-plan.plan.author", { title: "Maximum", summary: "Complete every bounded task.", tasks }, "author-maximum");
  const value = binding(root, "lifecycle", "maximum");
  const digest = `sha256:${createHash("sha256").update(readFileSync(join(root, "src", "proof.ts"))).digest("hex")}`;
  for (const task of tasks) await invoke(adapter, value, "markdown-plan.tasks.complete", { taskId: task.id, evidenceRefs: [{ kind: "tool", attemptId: `tool-${task.id}` }, { kind: "repository", path: "src/proof.ts", digest }] }, `complete-${task.id}`);
  assert.equal((await adapter.validateCompletion(value)).state, "satisfied");
  const sidecar = readFileSync(join(value.path!, ".pi-hive", "evidence-v1.json"), "utf8");
  assert.equal(Object.keys(JSON.parse(sidecar).tasks).length, MARKDOWN_PLAN_LIMITS.tasks);
  assert.ok(Buffer.byteLength(sidecar, "utf8") <= MARKDOWN_PLAN_LIMITS.sidecarBytes);

  const extraRoot = project("n-plus-one");
  const extra = bindPhysicalArtifactWorkspace({ projectRoot: extraRoot, adapter, profile: profile("author"), runId: "run-extra", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "too-many" } });
  await assert.rejects(() => invoke(adapter, extra, "markdown-plan.plan.author", { title: "Too many", summary: "Rejected.", tasks: [...tasks, { id: "one-extra", text: "Extra" }] }, "author-too-many"), /invalid|task|limit/i);

  const bytesRoot = project("text-bytes");
  const bytesWorkspace = bindPhysicalArtifactWorkspace({ projectRoot: bytesRoot, adapter, profile: profile("author"), runId: "run-bytes", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "text-bytes" } });
  await invoke(adapter, bytesWorkspace, "markdown-plan.plan.author", { title: "Bytes", summary: "Boundary.", tasks: [{ id: "exact", text: "x".repeat(MARKDOWN_PLAN_LIMITS.taskTextBytes) }] }, "author-exact");
  await assert.rejects(() => invoke(adapter, bytesWorkspace, "markdown-plan.plan.update", { title: "Bytes", summary: "Boundary.", tasks: [{ id: "extra", text: "x".repeat(MARKDOWN_PLAN_LIMITS.taskTextBytes + 1) }] }, "update-extra"), /invalid|limit|task/i);
});
