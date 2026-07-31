import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashArtifactWorkspace } from "../../src/artifacts/hashes.ts";
import {
  resolveCheckpointDigest,
  validateRunCheckpointSnapshot,
  type CheckpointDescriptorV1,
} from "../../src/artifacts/checkpoints.ts";

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "hive-checkpoint-digest-"));
  mkdirSync(join(workspace, "nested"));
  writeFileSync(join(workspace, "plan.md"), "# Plan\n\nVersion one.\n");
  writeFileSync(join(workspace, "nested", "evidence.json"), "{\"passed\":true}\n");
  writeFileSync(join(workspace, "unrelated.txt"), "unrelated one\n");
  const descriptor = (overrides: Partial<CheckpointDescriptorV1> = {}): CheckpointDescriptorV1 => ({
    formatVersion: 1,
    adapterId: "fixture",
    adapterVersion: "1",
    profileId: "author",
    profileVersion: "1",
    profileSchemaVersion: "1",
    checkpointId: "plan",
    checkpointVersion: "1",
    contributors: [
      { kind: "file", path: "plan.md" },
      { kind: "data", id: "validation", value: { passed: true, count: 2 } },
      { kind: "hash", id: "external", digest: `sha256:${"a".repeat(64)}` },
    ],
    ...overrides,
  });
  return { workspace, descriptor };
}

test("checkpoint digests bind every declared contributor and profile/schema version but ignore unrelated content", () => {
  const f = fixture();
  const initialHashes = hashArtifactWorkspace(f.workspace);
  const initial = resolveCheckpointDigest(f.descriptor(), initialHashes);
  assert.match(initial.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(initial.contributors.length, 3);
  assert.ok(Object.isFrozen(initial));
  assert.ok(Object.isFrozen(initial.contributors));

  writeFileSync(join(f.workspace, "unrelated.txt"), "unrelated changed\n");
  const unrelated = resolveCheckpointDigest(f.descriptor(), hashArtifactWorkspace(f.workspace));
  assert.equal(unrelated.digest, initial.digest, "whole-workspace changes do not contribute implicitly");

  writeFileSync(join(f.workspace, "plan.md"), "# Plan\n\nVersion two.\n");
  const fileChanged = resolveCheckpointDigest(f.descriptor(), hashArtifactWorkspace(f.workspace));
  assert.notEqual(fileChanged.digest, initial.digest);

  const dataChanged = resolveCheckpointDigest(f.descriptor({ contributors: [
    { kind: "file", path: "plan.md" },
    { kind: "data", id: "validation", value: { passed: false, count: 2 } },
    { kind: "hash", id: "external", digest: `sha256:${"a".repeat(64)}` },
  ] }), hashArtifactWorkspace(f.workspace));
  assert.notEqual(dataChanged.digest, fileChanged.digest);

  const hashChanged = resolveCheckpointDigest(f.descriptor({ contributors: [
    { kind: "file", path: "plan.md" },
    { kind: "data", id: "validation", value: { passed: true, count: 2 } },
    { kind: "hash", id: "external", digest: `sha256:${"b".repeat(64)}` },
  ] }), hashArtifactWorkspace(f.workspace));
  assert.notEqual(hashChanged.digest, fileChanged.digest);

  for (const overrides of [
    { adapterVersion: "2" },
    { profileVersion: "2" },
    { profileSchemaVersion: "2" },
    { checkpointVersion: "2" },
  ] satisfies Array<Partial<CheckpointDescriptorV1>>) {
    assert.notEqual(resolveCheckpointDigest(f.descriptor(overrides), hashArtifactWorkspace(f.workspace)).digest, fileChanged.digest);
  }
});

test("checkpoint contributor ordering is canonical while duplicate, missing, escaping, and oversized declarations fail closed", () => {
  const f = fixture();
  const hashes = hashArtifactWorkspace(f.workspace);
  const descriptor = f.descriptor();
  const reversed = { ...descriptor, contributors: [...descriptor.contributors].reverse() };
  assert.equal(resolveCheckpointDigest(descriptor, hashes).digest, resolveCheckpointDigest(reversed, hashes).digest);

  assert.throws(() => resolveCheckpointDigest(f.descriptor({ contributors: [
    { kind: "file", path: "plan.md" },
    { kind: "file", path: "plan.md" },
  ] }), hashes), /duplicate/i);
  assert.throws(() => resolveCheckpointDigest(f.descriptor({ contributors: [{ kind: "file", path: "missing.md" }] }), hashes), /missing|contributor/i);
  assert.throws(() => resolveCheckpointDigest(f.descriptor({ contributors: [{ kind: "file", path: "../escape" }] }), hashes), /path|normalized|escape/i);
  assert.throws(() => resolveCheckpointDigest(f.descriptor({ contributors: [{ kind: "hash", id: "external", digest: "forged" }] }), hashes), /digest|hash/i);
  assert.throws(() => resolveCheckpointDigest(f.descriptor({ contributors: [{ kind: "data", id: "huge", value: "x".repeat(70_000) }] }), hashes), /limit|large|bytes/i);
});

test("aggregate raw data contributor budgets reject N+1 bytes and nodes before digest resolution", () => {
  const f = fixture();
  const hashes = hashArtifactWorkspace(f.workspace);
  const atNodeLimit = Array.from({ length: 4_095 }, () => null);
  assert.doesNotThrow(() => resolveCheckpointDigest(f.descriptor({ contributors: [
    { kind: "data", id: "nodes-at-limit", value: atNodeLimit },
  ] }), hashes));
  assert.throws(() => resolveCheckpointDigest(f.descriptor({ contributors: [
    { kind: "data", id: "nodes-at-limit", value: atNodeLimit },
    { kind: "data", id: "nodes-n-plus-one", value: null },
  ] }), hashes), /aggregate|structural|nodes|limit/i);

  const atByteLimit = "x".repeat(65_534);
  assert.doesNotThrow(() => resolveCheckpointDigest(f.descriptor({ contributors: [
    { kind: "data", id: "bytes-at-limit", value: atByteLimit },
  ] }), hashes));
  assert.throws(() => resolveCheckpointDigest(f.descriptor({ contributors: [
    { kind: "data", id: "bytes-at-limit", value: atByteLimit },
    { kind: "data", id: "bytes-n-plus-one", value: null },
  ] }), hashes), /aggregate|bytes|limit|large/i);
});

test("checkpoint canonical ordering uses stable code-unit order for legal mixed-case IDs", () => {
  const f = fixture();
  const resolved = resolveCheckpointDigest(f.descriptor({ contributors: [
    { kind: "hash", id: "a", digest: `sha256:${"a".repeat(64)}` },
    { kind: "hash", id: "B", digest: `sha256:${"b".repeat(64)}` },
  ] }), hashArtifactWorkspace(f.workspace));
  assert.deepEqual(resolved.contributors.map((entry) => entry.kind === "file" ? entry.path : entry.id), ["B", "a"]);

  const snapshot = validateRunCheckpointSnapshot({
    formatVersion: 1,
    runId: "run-1",
    adapterId: "fixture",
    adapterVersion: "1",
    profileId: "author",
    profileVersion: "1",
    profileSchemaVersion: "1",
    defaultsRevision: 0,
    checkpoints: [
      { checkpointId: "B", policy: "required", enabled: true },
      { checkpointId: "a", policy: "optional", enabled: true },
    ],
    enabledCheckpointIds: ["B", "a"],
  });
  assert.deepEqual(snapshot.enabledCheckpointIds, ["B", "a"]);
});
