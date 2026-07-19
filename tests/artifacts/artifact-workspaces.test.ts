import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import {
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_PROFILE_VERSION,
  ARTIFACT_VIEW_VERSION,
  type ArtifactBinding,
} from "../../src/artifacts/contracts.ts";
import { hashArtifactWorkspace } from "../../src/artifacts/hashes.ts";
import {
  bindPhysicalArtifactWorkspace,
  listPhysicalArtifactWorkspaces,
  workspaceLifecycleDto,
} from "../../src/artifacts/workspaces.ts";
import { WorkflowRunLifecycle } from "../../src/workflows/runs.ts";
import type {
  ArtifactAdapter,
  ArtifactRuntimeProfile,
  ArtifactWorkspaceLifecycle,
} from "../../src/artifacts/types.ts";

const strict = { additionalProperties: false } as const;

function fixture(bindings: readonly ArtifactBinding[] = ["new", "existing", "either"]) {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-workspaces-"));
  const root = join(projectRoot, "artifacts");
  mkdirSync(root);
  const known = new Map<string, string>();
  const lifecycle: ArtifactWorkspaceLifecycle = {
    create(input) {
      if (known.has(input.workspaceId)) throw new Error("workspace collision");
      const path = join(root, input.workspaceId);
      mkdirSync(path);
      known.set(input.workspaceId, path);
      return { id: input.workspaceId, path };
    },
    resolve(input) {
      const path = known.get(input.workspaceId);
      return path ? { id: input.workspaceId, path } : undefined;
    },
    list(input) {
      const ids = [...known.keys()].sort();
      const offset = input.cursor ? Number(input.cursor) : 0;
      const page = ids.slice(offset, offset + input.limit);
      return {
        items: page.map((id) => ({ id, label: id })),
        ...(offset + page.length < ids.length ? { nextCursor: String(offset + page.length) } : {}),
      };
    },
    validateHandoffReference(input) {
      if (input.reference.checkpoint !== "tasks") return { state: "incompatible", reason: "checkpoint is incompatible" };
      if (input.reference.digest !== input.hashes.workspaceHash) return { state: "stale", reason: "workspace digest changed" };
      return { state: "valid" };
    },
  };
  const profile: ArtifactRuntimeProfile = Object.freeze({
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    version: ARTIFACT_PROFILE_VERSION,
    adapterId: "fixture",
    adapterVersion: "1",
    id: "author",
    optionsSchemaVersion: "1",
    optionsSchema: Type.Object({}, strict),
    bindings,
    checkpointIds: Object.freeze(["tasks"]),
    actions: Object.freeze([]),
    viewVersion: ARTIFACT_VIEW_VERSION,
  });
  const adapter: ArtifactAdapter = Object.freeze({
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    id: "fixture",
    version: "1",
    profiles: Object.freeze([profile]),
    workspaceLifecycle: lifecycle,
    bind() { throw new Error("physical binding uses the common workspace lifecycle"); },
    status() { throw new Error("unused"); },
    reconcileAction() { return { state: "unknown" as const, diagnostic: "unused" }; },
    validateCompletion() { return { state: "satisfied" as const }; },
  });
  return { projectRoot, root, known, lifecycle, profile, adapter };
}

const bind = (f: ReturnType<typeof fixture>, configuredBinding: ArtifactBinding, selection?: { mode: "new" | "existing"; workspaceId: string }, handoffReference?: { workspaceId: string; checkpoint: string; digest: string }) => bindPhysicalArtifactWorkspace({
  projectRoot: f.projectRoot,
  adapter: f.adapter,
  profile: f.profile,
  runId: "run-1",
  configuredBinding,
  options: {},
  ...(selection ? { selection } : {}),
  ...(handoffReference ? { handoffReference } : {}),
});

test("physical binding requires one explicit new/existing choice and never selects latest", () => {
  for (const configured of ["new", "existing", "either"] as const) {
    const f = fixture();
    assert.throws(() => bind(f, configured), /explicit|selection/i, configured);
    if (configured !== "existing") {
      const created = bind(f, configured, { mode: "new", workspaceId: `created-${configured}` });
      assert.equal(created.selection, "new");
      assert.equal(created.workspace.id, `created-${configured}`);
      assert.equal(created.workspace.kind, "physical");
      assert.match(created.workspaceHash!, /^sha256:[0-9a-f]{64}$/u);
    } else {
      assert.throws(() => bind(f, configured, { mode: "new", workspaceId: "forbidden" }), /existing.*cannot|binding.*new/i);
    }
  }

  const f = fixture();
  bind(f, "new", { mode: "new", workspaceId: "older" });
  bind(f, "new", { mode: "new", workspaceId: "newer" });
  assert.throws(() => bind(f, "existing"), /explicit|selection/i, "latest must never be implicit");
  const exact = bind(f, "existing", { mode: "existing", workspaceId: "older" });
  assert.equal(exact.workspace.id, "older");
  assert.equal(exact.selection, "existing");
});

test("binding rejects collisions, missing IDs, mismatched modes, escapes, and rebinding candidates", () => {
  const f = fixture();
  bind(f, "new", { mode: "new", workspaceId: "known" });
  assert.throws(() => bind(f, "new", { mode: "new", workspaceId: "known" }), /collision|already exists/i);
  assert.throws(() => bind(f, "existing", { mode: "existing", workspaceId: "missing" }), /not found|missing/i);
  assert.throws(() => bind(f, "new", { mode: "existing", workspaceId: "known" }), /new.*cannot|binding.*existing/i);
  assert.throws(() => bind(f, "either", { mode: "existing", workspaceId: "../escape" }), /workspace ID/i);

  const escaping = fixture();
  escaping.lifecycle.resolve = () => ({ id: "escaped", path: tmpdir() });
  assert.throws(() => bind(escaping, "existing", { mode: "existing", workspaceId: "escaped" }), /contained|project/i);

  assert.throws(() => bindPhysicalArtifactWorkspace({
    projectRoot: f.projectRoot, adapter: f.adapter, profile: f.profile, runId: "run-1", configuredBinding: "none", options: {},
  }), /none.*logical|physical/i);
});

test("workspace listing is bounded, path-free, cursor explicit, and concurrent readers report current hashes", async () => {
  const f = fixture();
  for (const id of ["charlie", "alpha", "bravo"]) bind(f, "new", { mode: "new", workspaceId: id });
  const first = listPhysicalArtifactWorkspaces({ projectRoot: f.projectRoot, adapter: f.adapter, profile: f.profile, limit: 2 });
  assert.deepEqual(first.items.map((item) => item.id), ["alpha", "bravo"]);
  assert.equal(first.nextCursor, "2");
  assert.equal(JSON.stringify(first).includes(f.projectRoot), false);
  const second = listPhysicalArtifactWorkspaces({ projectRoot: f.projectRoot, adapter: f.adapter, profile: f.profile, limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item) => item.id), ["charlie"]);
  assert.throws(() => listPhysicalArtifactWorkspaces({ projectRoot: f.projectRoot, adapter: f.adapter, profile: f.profile, limit: 101 }), /limit/i);

  const path = f.known.get("alpha")!;
  const hashes = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve(hashArtifactWorkspace(path))));
  assert.equal(new Set(hashes.map((item) => item.workspaceHash)).size, 1);
  assert.ok(hashes.every((item) => item.entries.length >= 1));
});

test("handoff artifact refs remain candidates until adapter identity, profile, and current hash validate", () => {
  const f = fixture();
  const created = bind(f, "new", { mode: "new", workspaceId: "handoff-target" });
  const reference = { workspaceId: "handoff-target", checkpoint: "tasks", digest: created.workspaceHash! };
  const accepted = bind(f, "existing", { mode: "existing", workspaceId: "handoff-target" }, reference);
  assert.equal(accepted.workspace.id, "handoff-target");

  assert.throws(() => bind(f, "existing", { mode: "existing", workspaceId: "handoff-target" }, { ...reference, workspaceId: "other" }), /identity|workspace/i);
  assert.throws(() => bind(f, "existing", { mode: "existing", workspaceId: "handoff-target" }, { ...reference, checkpoint: "proposal" }), /incompatible/i);
  assert.throws(() => bind(f, "existing", { mode: "existing", workspaceId: "handoff-target" }, { ...reference, digest: `sha256:${"f".repeat(64)}` }), /stale|changed/i);
});

test("a physical workspace binding is journaled once and rebinding is denied after restart", () => {
  const f = fixture();
  const lifecycle = new WorkflowRunLifecycle({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshotId: "snapshot-1", rootNodeId: "root", createRunId: () => "run-1",
  });
  lifecycle.recordUserInput({ inputId: "input-1", text: "choose workspace explicitly", source: "interactive" });
  assert.equal(lifecycle.restore().latestRun?.artifactWorkspace, undefined);
  const physical = bind(f, "new", { mode: "new", workspaceId: "bound-once" });
  assert.equal(lifecycle.bindArtifactWorkspace(physical).workspace.id, "bound-once");
  const restarted = new WorkflowRunLifecycle(lifecycle.options);
  assert.equal(restarted.restore().latestRun?.artifactWorkspace?.workspace.id, "bound-once");
  assert.throws(() => restarted.bindArtifactWorkspace(physical), /already bound|rebinding/i);
});

test("workspace lifecycle DTO is bounded and never leaks canonical paths or process authority", () => {
  const f = fixture();
  const binding = bind(f, "new", { mode: "new", workspaceId: "dto" });
  const dto = workspaceLifecycleDto({ binding, lease: { state: "available" }, hashes: hashArtifactWorkspace(binding.path!) });
  const encoded = JSON.stringify(dto);
  assert.equal(encoded.includes(f.projectRoot), false);
  assert.equal(encoded.includes("pid"), false);
  assert.ok(Buffer.byteLength(encoded, "utf8") <= 16_384);
  assert.deepEqual(dto.workspace, { id: "dto", kind: "physical", selection: "new" });
});
