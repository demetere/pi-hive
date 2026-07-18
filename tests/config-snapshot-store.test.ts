import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readActivationSnapshot, snapshotFilePath, writeActivationSnapshot } from "../src/config/snapshot-store.ts";
import type { ActivationSnapshotFileV1 } from "../src/config/snapshot.ts";
import { hashActivationPayload } from "../src/config/snapshot-canonical.ts";

function snapshot(): ActivationSnapshotFileV1 {
  const payload = { versions: { snapshot: 1, packageContract: "pi-hive-package-contract-v1", schema: 1, capability: 1, catalogHash: "pi-hive-catalog-hash-v1", artifact: "pi-hive-artifact-contract-v1", contextPolicy: "pi-hive-context-policy-v1", package: "0.1.0" }, project: { projectId: "id", rootRef: "." }, workflow: { id: "w", artifact: { adapter: "none", profile: "default", binding: "none", options: {}, contractVersion: "pi-hive-artifact-contract-v1", checkpoints: [], approvals: {} }, team: { nodes: [] } }, agents: [], skills: [], knowledge: [{ id: "k", provider: "okf", path: ".pi/hive/knowledge/k", updates: "reviewed", metadataFingerprint: "f".repeat(64), attachedNodeIds: [] }], authority: { capabilityContractVersion: 1, nodes: [] }, models: [], sources: [] } as any;
  const identity = {
    ...payload,
    knowledge: payload.knowledge.map((item: { metadataFingerprint: string } & Record<string, unknown>) => {
      const { metadataFingerprint: _metadataFingerprint, ...entry } = item;
      return entry;
    }),
  };
  return { snapshotHash: hashActivationPayload(identity), createdAt: "2026-01-01T00:00:00.000Z", payload };
}

test("snapshot store atomically publishes private immutable files and reuses verified content", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-snapshot-"));
  const value = snapshot();
  const path = writeActivationSnapshot(root, value);
  assert.equal(path, snapshotFilePath(root, value.snapshotHash));
  assert.deepEqual(readActivationSnapshot(root, value.snapshotHash), value);
  const equivalent = structuredClone(value);
  equivalent.createdAt = "2027-01-01T00:00:00.000Z";
  equivalent.payload.knowledge[0].metadataFingerprint = "9".repeat(64);
  assert.equal(writeActivationSnapshot(root, equivalent), path);
  assert.deepEqual(readActivationSnapshot(root, value.snapshotHash), value);
  assert.equal(readFileSync(path, "utf8").includes(value.snapshotHash), true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, ".pi/hive/sessions/activations")).mode & 0o777, 0o700);
  chmodSync(path, 0o644);
  assert.throws(() => readActivationSnapshot(root, value.snapshotHash), /private|mode|permission/i);
  assert.throws(() => writeActivationSnapshot(root, value), /private|mode|permission/i);
});

test("snapshot store fails closed on corruption, hash mismatch, symlinks, and cleans failed temp writes", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-snapshot-"));
  const value = snapshot();
  const path = writeActivationSnapshot(root, value);
  writeFileSync(path, "{", { mode: 0o600 });
  assert.throws(() => readActivationSnapshot(root, value.snapshotHash), /snapshot/i);
  writeFileSync(path, JSON.stringify({ ...value, snapshotHash: "0".repeat(64) }));
  assert.throws(() => readActivationSnapshot(root, value.snapshotHash), /hash|filename/i);
  const extraPayload = { ...value.payload, unexpected: true };
  const extraHash = hashActivationPayload(extraPayload);
  writeFileSync(snapshotFilePath(root, extraHash), JSON.stringify({ snapshotHash: extraHash, createdAt: value.createdAt, payload: extraPayload }), { mode: 0o600 });
  assert.throws(() => readActivationSnapshot(root, extraHash), /unknown|shape|field/i);
  const otherRoot = mkdtempSync(join(tmpdir(), "hive-snapshot-"));
  const target = join(otherRoot, "target.json");
  writeFileSync(target, JSON.stringify(value));
  const symlinkPath = snapshotFilePath(otherRoot, value.snapshotHash);
  mkdirSync(join(otherRoot, ".pi/hive/sessions/activations"), { recursive: true });
  symlinkSync(target, symlinkPath);
  assert.throws(() => readActivationSnapshot(otherRoot, value.snapshotHash), /regular|symlink/i);

  const escapedRoot = mkdtempSync(join(tmpdir(), "hive-snapshot-"));
  const escapedTarget = mkdtempSync(join(tmpdir(), "hive-snapshot-outside-"));
  mkdirSync(join(escapedRoot, ".pi/hive"), { recursive: true });
  symlinkSync(escapedTarget, join(escapedRoot, ".pi/hive/sessions"));
  assert.throws(() => writeActivationSnapshot(escapedRoot, value), /contain|escape|directory/i);
  assert.equal(existsSync(join(escapedTarget, "activations")), false, "containment must be checked before mkdir side effects");

  const failedRoot = mkdtempSync(join(tmpdir(), "hive-snapshot-"));
  assert.throws(() => writeActivationSnapshot(failedRoot, value, { rename() { throw new Error("fault"); } }), /fault/);
  assert.equal(existsSync(snapshotFilePath(failedRoot, value.snapshotHash)), false);
});

test("snapshot publication never clobbers a concurrent equivalent winner", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-snapshot-race-"));
  const value = snapshot();
  const winner = structuredClone(value);
  winner.createdAt = "2028-01-01T00:00:00.000Z";
  winner.payload.knowledge[0].metadataFingerprint = "8".repeat(64);
  assert.equal(writeActivationSnapshot(root, value, {
    publish(_temporary, destination) {
      writeFileSync(destination, JSON.stringify(winner), { mode: 0o600, flag: "wx" });
      const error = new Error("already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    },
  }), snapshotFilePath(root, value.snapshotHash));
  assert.deepEqual(readActivationSnapshot(root, value.snapshotHash), winner);
});

test("persisted snapshots enforce semantic identity coverage and contract invariants", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-snapshot-semantics-"));
  mkdirSync(join(root, ".pi/hive/sessions/activations"), { recursive: true, mode: 0o700 });
  const base = snapshot();
  const assertRejected = (mutate: (payload: any) => void, pattern: RegExp) => {
    const payload = structuredClone(base.payload) as any;
    mutate(payload);
    const identity = { ...payload, knowledge: payload.knowledge.map(({ metadataFingerprint: _metadataFingerprint, ...entry }: any) => entry) };
    const hash = hashActivationPayload(identity);
    writeFileSync(snapshotFilePath(root, hash), JSON.stringify({ snapshotHash: hash, createdAt: base.createdAt, payload }), { mode: 0o600 });
    assert.throws(() => readActivationSnapshot(root, hash), pattern);
  };
  const agent = { id: "a", name: "A", tags: [], frontmatter: {}, prompt: "p", sourceHash: "a".repeat(64), canonicalSourceHash: "b".repeat(64), promptHash: "c".repeat(64) };
  const node = { id: "root", agentId: "a", memberIds: [], responsibilities: [], skills: { resolved: [] }, knowledge: { resolved: [] }, budgets: {} };
  const authority = { nodeId: "root", capabilities: {}, tools: [] };
  const model = { nodeId: "root", modelId: "provider/model", thinking: "off", staticTokens: 8192, dynamicReserve: 20000, contextWindow: 100000 };
  assertRejected((payload) => { payload.workflow.team.nodes = [node, node]; payload.agents = [agent]; payload.authority.nodes = [authority]; payload.models = [model]; }, /duplicate.*node|node.*duplicate/i);
  assertRejected((payload) => { payload.workflow.team.nodes = [node]; payload.agents = [agent, agent]; payload.authority.nodes = [authority]; payload.models = [model]; }, /duplicate.*agent|agent.*duplicate/i);
  assertRejected((payload) => { payload.workflow.team.nodes = [node]; payload.agents = []; payload.authority.nodes = [authority]; payload.models = [model]; }, /agent.*coverage|coverage.*agent/i);
  assertRejected((payload) => { payload.workflow.team.nodes = [node]; payload.agents = [agent]; payload.authority.nodes = []; payload.models = [model]; }, /authority.*coverage|coverage.*authority/i);
  assertRejected((payload) => { payload.workflow.team.nodes = [node]; payload.agents = [agent]; payload.authority.nodes = [authority]; payload.models = []; }, /model.*coverage|coverage.*model/i);
  assertRejected((payload) => { payload.authority.capabilityContractVersion = 2; }, /capability.*contract/i);
  assertRejected((payload) => { delete payload.versions.contextPolicy; }, /context.*policy|missing/i);
  assertRejected((payload) => { payload.workflow.artifact.contractVersion = "other"; }, /artifact.*contract/i);
  assertRejected((payload) => { payload.workflow.team.nodes = [node]; payload.agents = [agent]; payload.authority.nodes = [authority]; payload.models = [{ ...model, dynamicReserve: 1 }]; }, /context.*policy|reserve/i);
});

test("snapshot reads strictly validate nested v1 records and deeply freeze results", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-snapshot-shape-"));
  const value = snapshot();
  writeActivationSnapshot(root, value);
  const read = readActivationSnapshot(root, value.snapshotHash);
  assert.equal(Object.isFrozen(read), true);
  assert.equal(Object.isFrozen(read.payload.knowledge[0]), true);
  assert.throws(() => { (read.payload.knowledge[0] as any).path = "changed"; }, /read only|frozen|assign/i);

  const invalidPayload = structuredClone(value.payload) as any;
  invalidPayload.models.push({ nodeId: "root", modelId: "m", thinking: "off", staticTokens: null, dynamicReserve: 8192, contextWindow: 100000 });
  const invalidIdentity = { ...invalidPayload, knowledge: invalidPayload.knowledge.map(({ metadataFingerprint: _metadataFingerprint, ...entry }: any) => entry) };
  const invalidHash = hashActivationPayload(invalidIdentity);
  writeFileSync(snapshotFilePath(root, invalidHash), JSON.stringify({ snapshotHash: invalidHash, createdAt: value.createdAt, payload: invalidPayload }), { mode: 0o600 });
  assert.throws(() => readActivationSnapshot(root, invalidHash), /model|shape|field/i);

  const unknownNested = structuredClone(value.payload) as any;
  unknownNested.knowledge[0].secret = "must-not-pass";
  const unknownIdentity = { ...unknownNested, knowledge: unknownNested.knowledge.map(({ metadataFingerprint: _metadataFingerprint, ...entry }: any) => entry) };
  const unknownHash = hashActivationPayload(unknownIdentity);
  writeFileSync(snapshotFilePath(root, unknownHash), JSON.stringify({ snapshotHash: unknownHash, createdAt: value.createdAt, payload: unknownNested }), { mode: 0o600 });
  assert.throws(() => readActivationSnapshot(root, unknownHash), /unknown|shape|field/i);

  for (const mutate of [
    (payload: any) => { payload.knowledge[0].path = "/absolute/knowledge"; },
    (payload: any) => { payload.knowledge[0].metadataFingerprint = "not-a-sha256"; },
    (payload: any) => { payload.sources = [{ path: "../escape", kind: "manifest", id: "root", hash: "a".repeat(64), canonicalHash: "b".repeat(64) }]; },
    (payload: any) => { payload.sources = [{ path: ".pi/hive/hive-config.yaml", kind: "manifest", id: "root", hash: "UPPER".repeat(13), canonicalHash: "b".repeat(64) }]; },
  ]) {
    const malformed = structuredClone(value.payload) as any;
    mutate(malformed);
    const identity = { ...malformed, knowledge: malformed.knowledge.map(({ metadataFingerprint: _metadataFingerprint, ...entry }: any) => entry) };
    const hash = hashActivationPayload(identity);
    writeFileSync(snapshotFilePath(root, hash), JSON.stringify({ snapshotHash: hash, createdAt: value.createdAt, payload: malformed }), { mode: 0o600 });
    assert.throws(() => readActivationSnapshot(root, hash), /path|hash|fingerprint|source|knowledge/i);
  }
});
