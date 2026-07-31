import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  OPEN_SPEC_ACTION_IDS,
  OPEN_SPEC_ARTIFACT_ADAPTER,
  OPEN_SPEC_CHECKPOINT_IDS,
  OPEN_SPEC_PROFILES,
  OpenSpecAdapterError,
  createOpenSpecAdapter,
  createOpenSpecCli,
  type OpenSpecCli,
} from "../../src/artifacts/adapters/openspec.ts";
import { resolveCheckpointDigest } from "../../src/artifacts/checkpoints.ts";
import { ARTIFACT_CONTRACT_VERSION } from "../../src/artifacts/contracts.ts";
import { hashArtifactWorkspace } from "../../src/artifacts/hashes.ts";
import { BUILTIN_ARTIFACT_REGISTRY } from "../../src/artifacts/registry.ts";
import { bindPhysicalArtifactWorkspace, listPhysicalArtifactWorkspaces } from "../../src/artifacts/workspaces.ts";
import type { ArtifactActionContext, ArtifactEvidenceReferenceV1, ArtifactWorkspaceBinding, VerifiedArtifactEvidenceV1 } from "../../src/artifacts/types.ts";
import { assertArtifactActionFilesystemContained, assertArtifactAdapterContract } from "../helpers/artifact-adapter-contract.ts";

function project(label: string, configFilename = "config.yaml"): string {
  const root = mkdtempSync(join(tmpdir(), `hive-openspec-${label}-`));
  mkdirSync(join(root, "openspec", "changes"), { recursive: true });
  writeFileSync(join(root, "openspec", configFilename), "schema: spec-driven\n");
  return root;
}

function fakeCli(overrides: Partial<OpenSpecCli> = {}): OpenSpecCli {
  return {
    available: () => true,
    runSync(projectRoot, args) {
      if (args[0] === "new" && args[1] === "change") mkdirSync(join(projectRoot, "openspec", "changes", args[2]), { recursive: false });
    },
    async runJson(_projectRoot, args) {
      if (args[0] === "validate") return { items: [], summary: { totals: { passed: 1, failed: 0 } } };
      return { artifacts: [] };
    },
    ...overrides,
  };
}

function profile(id: keyof typeof OPEN_SPEC_PROFILES) { return OPEN_SPEC_PROFILES[id]; }

function binding(root: string, profileId: keyof typeof OPEN_SPEC_PROFILES, changeId = "add-auth"): ArtifactWorkspaceBinding {
  const selected = profile(profileId);
  const path = join(root, "openspec", "changes", changeId);
  return Object.freeze({
    schemaVersion: 1 as const,
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    adapterId: "openspec",
    adapterVersion: "1",
    profileId,
    profileVersion: "1" as const,
    binding: profileId === "execute" || profileId === "review" ? "existing" as const : "either" as const,
    selection: "existing" as const,
    workspace: Object.freeze({ id: changeId, kind: "physical" as const }),
    path,
    workspaceHash: hashArtifactWorkspace(path).workspaceHash,
    writerLease: Object.freeze({ required: true }),
    checkpointIds: selected.checkpointIds,
    actionIds: selected.actions.map((action) => action.id),
  });
}

function context(value: ArtifactWorkspaceBinding, operationId = "attempt-1"): ArtifactActionContext {
  const enqueueMutation = async <T>(_relativePath: string, callback: () => T | Promise<T>): Promise<T> => callback();
  const verifyEvidence = (references: readonly ArtifactEvidenceReferenceV1[]): readonly VerifiedArtifactEvidenceV1[] => references.map((reference) => {
    if (reference.kind === "tool") return Object.freeze({ kind: "tool", attemptId: reference.attemptId, operation: "tool.test", inputHash: "a".repeat(64), resultHash: "b".repeat(64) });
    if (reference.kind !== "repository") throw new Error("Unit adapter context does not issue command proofs");
    const root = join(value.path!, "..", "..", "..");
    const content = readFileSync(join(root, reference.path));
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (digest !== reference.digest) throw new Error("Repository evidence hash is stale");
    return Object.freeze({ kind: "repository" as const, path: reference.path, digest, bytes: content.byteLength });
  });
  return Object.freeze({
    binding: value,
    capabilities: Object.freeze(["read", "write", "review"] as const),
    hashes: hashArtifactWorkspace(value.path!),
    operationId,
    expectedWorkspaceHash: hashArtifactWorkspace(value.path!).workspaceHash,
    enqueueMutation,
    verifyEvidence,
  });
}

async function invoke(adapter: ReturnType<typeof createOpenSpecAdapter>, value: ArtifactWorkspaceBinding, actionId: string, args: Record<string, unknown>, operationId?: string) {
  const selected = adapter.profiles.find((entry) => entry.id === value.profileId)!;
  const action = selected.actions.find((entry) => entry.id === actionId)!;
  assert.ok(action, `${actionId} is published by ${selected.id}`);
  return adapter.executeAction!(context({ ...value, workspaceHash: hashArtifactWorkspace(value.path!).workspaceHash }, operationId), action, args as never);
}

async function authorAll(adapter: ReturnType<typeof createOpenSpecAdapter>, value: ArtifactWorkspaceBinding): Promise<void> {
  await invoke(adapter, value, "openspec.artifact.write", { artifactId: "proposal", content: "# Proposal\n\nAdd authentication.\n" }, "write-proposal");
  await invoke(adapter, value, "openspec.artifact.write", { artifactId: "design", content: "# Design\n\nUse sessions.\n" }, "write-design");
  await invoke(adapter, value, "openspec.artifact.write", { artifactId: "specs", capabilityId: "authentication", content: "# Authentication\n\n## ADDED Requirements\n" }, "write-specs");
  await invoke(adapter, value, "openspec.artifact.write", { artifactId: "tasks", content: "# Tasks\n\n- [ ] 1.1 Implement authentication\n" }, "write-tasks");
}

test("OpenSpec publishes the exact profile/checkpoint/action/binding matrix and strict empty options", () => {
  assertArtifactAdapterContract(OPEN_SPEC_ARTIFACT_ADAPTER);
  assert.deepEqual(OPEN_SPEC_CHECKPOINT_IDS, ["proposal", "design", "specs", "tasks", "implementation", "review"]);
  assert.deepEqual(OPEN_SPEC_ACTION_IDS, [
    "openspec.artifact.read", "openspec.artifact.write", "openspec.validate", "openspec.tasks.list", "openspec.tasks.complete", "openspec.review.inspect",
  ]);
  const rows = {
    author: { bindings: ["new", "existing", "either"], checkpoints: ["proposal", "design", "specs", "tasks"], actions: OPEN_SPEC_ACTION_IDS.slice(0, 3), mandatory: ["openspec.artifact.write"] },
    execute: { bindings: ["existing"], checkpoints: ["tasks", "implementation"], actions: [OPEN_SPEC_ACTION_IDS[0], OPEN_SPEC_ACTION_IDS[2], OPEN_SPEC_ACTION_IDS[3], OPEN_SPEC_ACTION_IDS[4]], mandatory: ["openspec.tasks.complete"] },
    review: { bindings: ["existing"], checkpoints: ["implementation", "review"], actions: [OPEN_SPEC_ACTION_IDS[0], OPEN_SPEC_ACTION_IDS[2], OPEN_SPEC_ACTION_IDS[3], OPEN_SPEC_ACTION_IDS[5]], mandatory: [] },
    lifecycle: { bindings: ["new", "existing", "either"], checkpoints: OPEN_SPEC_CHECKPOINT_IDS, actions: OPEN_SPEC_ACTION_IDS, mandatory: ["openspec.artifact.write", "openspec.tasks.complete"] },
  } as const;
  for (const [id, expected] of Object.entries(rows)) {
    const actual = OPEN_SPEC_PROFILES[id as keyof typeof OPEN_SPEC_PROFILES];
    assert.deepEqual(actual.bindings, expected.bindings);
    assert.deepEqual(actual.checkpointIds, expected.checkpoints);
    assert.deepEqual(actual.actions.map((action) => action.id), expected.actions);
    assert.deepEqual(actual.actions.filter((action) => action.completion === "mandatory").map((action) => action.id), expected.mandatory);
    assert.equal(actual.actions.every((action) => action.completion === "mandatory" || action.completion === "optional"), true);
    assert.equal(Value.Check(actual.optionsSchema, {}), true);
    assert.equal(Value.Check(actual.optionsSchema, { root: "openspec" }), false);
    const resolved = BUILTIN_ARTIFACT_REGISTRY.resolveProfile({ contractVersion: ARTIFACT_CONTRACT_VERSION, adapterId: "openspec", adapterVersion: "1", profileId: id, profileVersion: "1" });
    assert.equal(resolved.adapter.id, "openspec");
    assert.deepEqual(resolved.profile.actions.map((action) => action.id), expected.actions);
  }
});

test("workspace lifecycle recognizes either exact OpenSpec config filename", () => {
  const adapter = createOpenSpecAdapter({ cli: fakeCli() });
  for (const configFilename of ["config.yaml", "config.yml"]) {
    const root = project(`config-${configFilename}`, configFilename);
    mkdirSync(join(root, "openspec", "changes", "configured-change"));
    const listed = listPhysicalArtifactWorkspaces({ projectRoot: root, adapter, profile: profile("author"), limit: 2 });
    assert.deepEqual(listed.items.map((item) => item.id), ["configured-change"]);
  }

  const lookalikeRoot = project("config-lookalike", "config.yml.backup");
  assert.throws(
    () => listPhysicalArtifactWorkspaces({ projectRoot: lookalikeRoot, adapter, profile: profile("author"), limit: 2 }),
    /not initialized/i,
  );
});

test("workspace lifecycle requires CLI plus initialization, accepts exact contained IDs, paginates, and never selects latest", () => {
  const root = project("workspace");
  const adapter = createOpenSpecAdapter({ cli: fakeCli() });
  const author = profile("author");
  assert.throws(() => bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: author, runId: "run-1", configuredBinding: "either", options: {} }), /explicit|latest/i);
  assert.throws(() => bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: author, runId: "run-1", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "../escape" } }), /workspace ID/i);
  const created = bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: author, runId: "run-1", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "add-auth" } });
  assert.equal(created.path, realpathSync.native(join(root, "openspec", "changes", "add-auth")));
  assert.throws(() => bindPhysicalArtifactWorkspace({ projectRoot: root, adapter, profile: author, runId: "run-2", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "add-auth" } }), /collision|exists/i);
  for (const id of ["beta", "charlie"]) mkdirSync(join(root, "openspec", "changes", id));
  const first = listPhysicalArtifactWorkspaces({ projectRoot: root, adapter, profile: author, limit: 2 });
  assert.deepEqual(first.items.map((item) => item.id), ["add-auth", "beta"]);
  assert.ok(first.nextCursor);
  const second = listPhysicalArtifactWorkspaces({ projectRoot: root, adapter, profile: author, limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item) => item.id), ["charlie"]);

  const partial = createOpenSpecAdapter({ cli: fakeCli({ runSync(projectRoot, args) { mkdirSync(join(projectRoot, "openspec", "changes", args[2])); throw new OpenSpecAdapterError("failed", "scaffold interrupted"); } }) });
  assert.throws(() => bindPhysicalArtifactWorkspace({ projectRoot: root, adapter: partial, profile: partial.profiles[0], runId: "partial-run", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "partial-change" } }), /interrupted/i);
  const recoveredPartial = bindPhysicalArtifactWorkspace({ projectRoot: root, adapter: partial, profile: partial.profiles[0], runId: "partial-recovery", configuredBinding: "existing", options: {}, selection: { mode: "existing", workspaceId: "partial-change" } });
  assert.equal(recoveredPartial.workspace.id, "partial-change", "partial scaffolds require an explicit existing-workspace recovery rather than blind replay");

  const absent = createOpenSpecAdapter({ cli: fakeCli({ available: () => false }) });
  assert.throws(() => listPhysicalArtifactWorkspaces({ projectRoot: root, adapter: absent, profile: absent.profiles[0], limit: 2 }), (error: unknown) => error instanceof OpenSpecAdapterError && error.code === "unavailable");
  const uninitialized = mkdtempSync(join(tmpdir(), "hive-openspec-uninitialized-"));
  assert.throws(() => listPhysicalArtifactWorkspaces({ projectRoot: uninitialized, adapter, profile: author, limit: 2 }), /not initialized/i);
});

test("validation explicitly selects a change when a spec has the same ID", async () => {
  const root = project("validation-type");
  const path = join(root, "openspec", "changes", "shared-id");
  mkdirSync(path);
  let observedArgs: readonly string[] | undefined;
  const adapter = createOpenSpecAdapter({ cli: fakeCli({
    async runJson(_projectRoot, args) {
      observedArgs = args;
      return { items: [], summary: { totals: { passed: 1, failed: 0 } } };
    },
  }) });

  const result = await invoke(adapter, binding(root, "author", "shared-id"), "openspec.validate", {});
  assert.equal(result.data.passed, true);
  assert.deepEqual(observedArgs, ["validate", "shared-id", "--type", "change", "--json"]);
});

test("artifact graph, validation, bounded generic view, and checkpoint contributors stay adapter-internal", async () => {
  const root = project("status");
  const path = join(root, "openspec", "changes", "change-one");
  mkdirSync(path);
  const adapter = createOpenSpecAdapter({ cli: fakeCli() });
  let value = binding(root, "author", "change-one");
  const initial = await adapter.status({ binding: value, capabilities: ["read", "write"], hashes: hashArtifactWorkspace(path) }, { limit: 2 });
  assert.equal(initial.status, "blocked");
  assert.equal(initial.items[0]?.id, "proposal");
  assert.equal(initial.items[0]?.state, "ready");
  assert.equal(initial.items[1]?.state, "blocked");
  assert.ok(initial.page.nextCursor);

  await authorAll(adapter, value);
  value = binding(root, "author", "change-one");
  const currentHashes = hashArtifactWorkspace(path);
  for (const checkpointId of ["proposal", "design", "specs", "tasks"] as const) {
    const descriptor = adapter.checkpointDescriptor!({ binding: value, checkpointId, hashes: currentHashes });
    const resolved = resolveCheckpointDigest(descriptor, currentHashes);
    assert.equal(resolved.checkpointId, checkpointId);
    assert.ok(resolved.contributors.length >= 1);
  }
  const validation = await invoke(adapter, value, "openspec.validate", {});
  assert.deepEqual(validation.data, { passed: true, failed: 0, issues: [] });
  const read = await invoke(adapter, value, "openspec.artifact.read", { artifactId: "specs" });
  assert.match(String(read.data.content), /ADDED Requirements/);
  const review = await invoke(adapter, binding(root, "review", "change-one"), "openspec.review.inspect", {});
  assert.equal(review.data.validation && (review.data.validation as { passed?: unknown }).passed, true);
  assert.equal("decision" in review.data || "approved" in review.data, false, "adapter review cannot impersonate a human checkpoint decision");
  assert.equal((await adapter.validateCompletion(value)).state, "satisfied");
});

test("execution evidence is sidecar-bound to the exact tasks checkpoint digest and never edits tasks.md", async () => {
  const root = project("evidence");
  const path = join(root, "openspec", "changes", "add-auth");
  mkdirSync(path);
  const adapter = createOpenSpecAdapter({ cli: fakeCli(), now: () => "2026-01-01T00:00:00.000Z" });
  const author = binding(root, "lifecycle");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "authentication.ts"), "export const authentication = true;\n");
  const repositoryDigest = `sha256:${createHash("sha256").update(readFileSync(join(root, "src", "authentication.ts"))).digest("hex")}`;
  await authorAll(adapter, author);
  const tasksBefore = readFileSync(join(path, "tasks.md"), "utf8");
  const beforeHashes = hashArtifactWorkspace(path);
  const tasksDigest = resolveCheckpointDigest(adapter.checkpointDescriptor!({ binding: author, checkpointId: "tasks", hashes: beforeHashes }), beforeHashes).digest;
  const implementationDigestBefore = resolveCheckpointDigest(adapter.checkpointDescriptor!({ binding: author, checkpointId: "implementation", hashes: beforeHashes }), beforeHashes).digest;

  await assertArtifactActionFilesystemContained({
    filesystemRoot: root,
    workspacePath: path,
    invoke: () => invoke(adapter, author, "openspec.tasks.complete", { taskId: "1.1", evidenceRefs: [{ kind: "tool", attemptId: "tool-test" }, { kind: "repository", path: "src/authentication.ts", digest: repositoryDigest }] }, "complete-1-1"),
  });
  assert.equal(readFileSync(join(path, "tasks.md"), "utf8"), tasksBefore);
  const sidecar = JSON.parse(readFileSync(join(path, ".pi-hive", "evidence-v1.json"), "utf8"));
  assert.equal(sidecar.tasksContentIdentity.startsWith("sha256:"), true);
  assert.equal(sidecar.tasks["1.1"].operationId, "complete-1-1");
  assert.deepEqual(sidecar.tasks["1.1"].evidenceRefs, [
    { kind: "tool", attemptId: "tool-test", operation: "tool.test", inputHash: "a".repeat(64), resultHash: "b".repeat(64) },
    { kind: "repository", path: "src/authentication.ts", digest: repositoryDigest, bytes: 36 },
  ]);
  const afterHashes = hashArtifactWorkspace(path);
  assert.equal(resolveCheckpointDigest(adapter.checkpointDescriptor!({ binding: author, checkpointId: "tasks", hashes: afterHashes }), afterHashes).digest, tasksDigest);
  assert.notEqual(
    implementationDigestBefore,
    resolveCheckpointDigest(adapter.checkpointDescriptor!({ binding: author, checkpointId: "implementation", hashes: afterHashes }), afterHashes).digest,
  );
  assert.equal((await adapter.validateCompletion(author)).state, "satisfied");
  await assert.rejects(() => invoke(adapter, author, "openspec.tasks.complete", { taskId: "1.1", evidence: "arbitrary prose" }, "prose-evidence"), /arguments|schema|evidence/i);

  writeFileSync(join(root, "src", "authentication.ts"), "export const authentication = false;\n");
  const staleRepository = await adapter.validateCompletion(author);
  assert.equal(staleRepository.state, "unsatisfied");
  assert.match(staleRepository.issues?.join(" ") ?? "", /repository|hash|stale/i);
  writeFileSync(join(root, "src", "authentication.ts"), "export const authentication = true;\n");

  writeFileSync(join(path, "tasks.md"), "# Tasks\n\n- [ ] 1.1 Changed task text\n");
  const stale = await adapter.validateCompletion(binding(root, "execute"));
  assert.equal(stale.state, "unsatisfied");
  assert.match(stale.issues?.join(" ") ?? "", /digest|changed|evidence/i);
});

test("adapter validation propagates the active generic tool cancellation signal into the CLI boundary", async () => {
  const root = project("signal");
  const path = join(root, "openspec", "changes", "signal-change");
  mkdirSync(path);
  writeFileSync(join(path, "tasks.md"), "# Tasks\n\n- [ ] 1.1 Work\n");
  const controller = new AbortController();
  let observed: AbortSignal | undefined;
  const adapter = createOpenSpecAdapter({ cli: fakeCli({
    async runJson(_projectRoot, _args, options) {
      observed = options?.signal;
      throw new OpenSpecAdapterError("cancelled", "OpenSpec request was cancelled");
    },
  }) });
  const value = binding(root, "execute", "signal-change");
  const action = OPEN_SPEC_PROFILES.execute.actions.find((entry) => entry.id === "openspec.validate")!;
  await assert.rejects(() => Promise.resolve(adapter.executeAction!({ ...context(value), signal: controller.signal }, action, {})), (error: unknown) => error instanceof OpenSpecAdapterError && error.code === "cancelled");
  assert.equal(observed, controller.signal);
});

test("bounded CLI classifies unavailable, timeout, cancellation, output overflow, non-zero, and invalid JSON", async () => {
  const root = project("cli");
  const script = join(root, "fake-openspec.mjs");
  writeFileSync(script, `#!/usr/bin/env node\nconst mode=process.argv[2];if(mode==='hang')setTimeout(()=>{},10000);else if(mode==='big')process.stdout.write('x'.repeat(10000));else if(mode==='bad')process.stdout.write('{');else if(mode==='fail'){process.stdout.write('{}');process.exitCode=2}else process.stdout.write(JSON.stringify({ok:true}));\n`, { mode: 0o755 });
  const cli = createOpenSpecCli({ binary: script, timeoutMs: 1_000, maxOutputBytes: 1_024 });
  const timeoutCli = createOpenSpecCli({ binary: script, timeoutMs: 80, maxOutputBytes: 1_024 });
  assert.deepEqual(await cli.runJson(root, ["ok"]), { ok: true });
  await assert.rejects(() => cli.runJson(root, ["bad"]), (error: unknown) => error instanceof OpenSpecAdapterError && error.code === "invalid-json");
  await assert.rejects(() => cli.runJson(root, ["big"]), (error: unknown) => error instanceof OpenSpecAdapterError && error.code === "output-limit");
  await assert.rejects(() => cli.runJson(root, ["fail"]), (error: unknown) => error instanceof OpenSpecAdapterError && error.code === "failed");
  await assert.rejects(() => timeoutCli.runJson(root, ["hang"]), (error: unknown) => error instanceof OpenSpecAdapterError && error.code === "timeout");
  const controller = new AbortController();
  const cancelled = cli.runJson(root, ["hang"], { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => cancelled, (error: unknown) => error instanceof OpenSpecAdapterError && error.code === "cancelled");
  const unavailable = createOpenSpecCli({ binary: join(root, "missing") });
  await assert.rejects(() => unavailable.runJson(root, ["ok"]), (error: unknown) => error instanceof OpenSpecAdapterError && error.code === "unavailable");
});
