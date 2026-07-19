import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSnapshotSources, validateSnapshotResumeCompatibility } from "../../src/config/snapshot-compat.ts";
import { hashActivationPayload, canonicalJson } from "../../src/config/snapshot-canonical.ts";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";

function snapshot(): ActivationSnapshotFileV1 {
  const payload = { versions: { snapshot: 1, packageContract: "pi-hive-package-contract-v1", schema: 1, capability: 1, catalogHash: "pi-hive-catalog-hash-v1", artifact: "pi-hive-artifact-contract-v1", contextPolicy: "pi-hive-context-policy-v1", package: "0.1.0" }, project: { projectId: "id", rootRef: "." }, workflow: { id: "w", artifact: { adapter: "none", adapterVersion: "1", profile: "default", profileVersion: "1", binding: "none", options: {}, optionsSchemaVersion: "1", contractVersion: "pi-hive-artifact-contract-v1", checkpoints: [], actionIds: [], viewVersion: 1, approvals: {} }, team: { nodes: [{ id: "root" }] } }, agents: [], skills: [], knowledge: [{ id: "k", provider: "okf", path: ".pi/hive/knowledge/k", updates: "reviewed", metadataFingerprint: "f".repeat(64), attachedNodeIds: ["root"] }], authority: { capabilityContractVersion: 1, nodes: [{ nodeId: "root", capabilities: {}, tools: [] }] }, models: [{ nodeId: "root", modelId: "provider/model", thinking: "off", staticTokens: 8192, dynamicReserve: 20000, contextWindow: 100000 }], sources: [{ path: ".pi/hive/hive-config.yaml", kind: "manifest", id: "root", hash: "1".repeat(64), canonicalHash: "2".repeat(64) }] } as any;
  const knowledgeIdentity = payload.knowledge.map((entry: Record<string, unknown>) => {
    const copy = { ...entry };
    delete copy.metadataFingerprint;
    return copy;
  });
  return { snapshotHash: hashActivationPayload({ ...payload, knowledge: knowledgeIdentity }), createdAt: "2026-01-01T00:00:00.000Z", payload };
}
const runtime = { model: { defaultModel: "provider/model", defaultThinking: "off", find: (id: string) => id === "provider/model" ? { id, contextWindow: 100000, thinking: ["off"] } : undefined, canActivate: () => true, estimateTokens: () => 0 }, knowledgeAvailable: () => true, workspaceAvailable: () => true, artifactProfileAvailable: () => true };

test("source comparison is read-only and distinguishes current, stale, missing, invalid", () => {
  const value = snapshot();
  const before = canonicalJson(value);
  assert.equal(compareSnapshotSources(value, () => ({ status: "current", hash: "1".repeat(64), canonicalHash: "2".repeat(64) })).state, "current");
  assert.equal(compareSnapshotSources(value, () => ({ status: "current", hash: "3".repeat(64), canonicalHash: "2".repeat(64) })).state, "stale");
  assert.equal(compareSnapshotSources(value, () => ({ status: "missing" })).state, "missing");
  assert.equal(compareSnapshotSources(value, () => ({ status: "invalid" })).state, "invalid");
  assert.equal(compareSnapshotSources(value, () => { throw new Error("race"); }).state, "invalid");
  let observed: unknown;
  compareSnapshotSources(value, (source) => { observed = source; return { status: "missing" }; });
  assert.deepEqual(observed, value.payload.sources[0], "probe receives kind/id/hash domain context, not only a path");
  assert.equal(canonicalJson(value), before);
});

test("stale sources may resume compatible snapshots but fresh activation requires current valid sources", () => {
  const value = snapshot();
  const stale = validateSnapshotResumeCompatibility(value, { ...runtime, sourceState: "stale" });
  assert.equal(stale.resumable, true);
  assert.equal(stale.freshEnabled, false);
  const current = validateSnapshotResumeCompatibility(value, { ...runtime, sourceState: "current" });
  assert.deepEqual({ resumable: current.resumable, freshEnabled: current.freshEnabled }, { resumable: true, freshEnabled: true });
});

test("fresh activation follows current source validity independently of old snapshot compatibility", () => {
  const value = snapshot();
  const incompatible = structuredClone(value);
  incompatible.payload.versions.packageContract = "other" as any;
  const result = validateSnapshotResumeCompatibility(incompatible, { ...runtime, sourceState: "current" });
  assert.equal(result.resumable, false);
  assert.equal(result.freshEnabled, true);
});

test("runtime probe exceptions fail closed with stable compatibility codes", () => {
  const value = snapshot();
  for (const [override, code] of [
    [{ model: { ...runtime.model, find: () => { throw new Error("boom"); } } }, "SNAPSHOT_MODEL_PROBE_FAILED"],
    [{ model: { ...runtime.model, canActivate: () => { throw new Error("boom"); } } }, "SNAPSHOT_MODEL_PROBE_FAILED"],
    [{ knowledgeAvailable: () => { throw new Error("boom"); } }, "SNAPSHOT_KNOWLEDGE_PROBE_FAILED"],
    [{ artifactProfileAvailable: () => { throw new Error("boom"); } }, "SNAPSHOT_ARTIFACT_PROBE_FAILED"],
    [{ workspaceAvailable: () => { throw new Error("boom"); } }, "SNAPSHOT_WORKSPACE_PROBE_FAILED"],
  ] as const) {
    assert.doesNotThrow(() => validateSnapshotResumeCompatibility(value, { ...runtime, ...override, sourceState: "current" } as any));
    assert.equal(validateSnapshotResumeCompatibility(value, { ...runtime, ...override, sourceState: "current" } as any).codes.includes(code), true);
  }
});

test("integrity, contract, model, knowledge, and artifact incompatibilities fail explicitly", () => {
  const value = snapshot();
  assert.equal(validateSnapshotResumeCompatibility({ ...value, snapshotHash: "0".repeat(64) }, { ...runtime, sourceState: "current" }).codes.includes("SNAPSHOT_INTEGRITY_INVALID"), true);
  const wrongContract = structuredClone(value);
  wrongContract.payload.versions.packageContract = "other" as any;
  assert.equal(validateSnapshotResumeCompatibility(wrongContract, { ...runtime, sourceState: "current" }).codes.includes("SNAPSHOT_PACKAGE_CONTRACT_UNSUPPORTED"), true);
  const wrongFormat = structuredClone(value);
  wrongFormat.payload.versions.snapshot = 2 as any;
  assert.equal(validateSnapshotResumeCompatibility(wrongFormat, { ...runtime, sourceState: "current" }).codes.includes("SNAPSHOT_FORMAT_UNSUPPORTED"), true);
  const wrongArtifact = structuredClone(value);
  wrongArtifact.payload.versions.artifact = "other" as any;
  assert.equal(validateSnapshotResumeCompatibility(wrongArtifact, { ...runtime, sourceState: "current" }).codes.includes("SNAPSHOT_ARTIFACT_CONTRACT_UNSUPPORTED"), true);
  const wrongContextPolicy = structuredClone(value);
  wrongContextPolicy.payload.versions.contextPolicy = "other" as any;
  assert.equal(validateSnapshotResumeCompatibility(wrongContextPolicy, { ...runtime, sourceState: "current" }).codes.includes("SNAPSHOT_CONTEXT_POLICY_UNSUPPORTED"), true);
  assert.equal(validateSnapshotResumeCompatibility(value, { ...runtime, sourceState: "current", model: { ...runtime.model, find: () => undefined } }).codes.includes("SNAPSHOT_MODEL_UNAVAILABLE"), true);
  assert.equal(validateSnapshotResumeCompatibility(value, { ...runtime, sourceState: "current", knowledgeAvailable: () => false }).codes.includes("SNAPSHOT_KNOWLEDGE_UNAVAILABLE"), true);
  assert.equal(validateSnapshotResumeCompatibility(value, { ...runtime, sourceState: "current", artifactProfileAvailable: () => false }).codes.includes("SNAPSHOT_ARTIFACT_CONTRACT_UNSUPPORTED"), true);
  for (const mutate of [
    (artifact: any) => { delete artifact.optionsSchemaVersion; },
    (artifact: any) => { artifact.viewVersion = 2; },
    (artifact: any) => { artifact.checkpoints = ["foreign"]; },
    (artifact: any) => { artifact.actionIds = ["foreign"]; },
    (artifact: any) => { artifact.extra = true; },
  ]) {
    const malformed = structuredClone(value);
    mutate(malformed.payload.workflow.artifact);
    assert.ok(validateSnapshotResumeCompatibility(malformed, { ...runtime, sourceState: "current" }).codes.includes("SNAPSHOT_ARTIFACT_CONTRACT_UNSUPPORTED"));
  }

  const invalidStoredModel = structuredClone(value);
  invalidStoredModel.payload.models[0].staticTokens = Number.NaN;
  assert.equal(validateSnapshotResumeCompatibility(invalidStoredModel, { ...runtime, sourceState: "current" }).codes.includes("SNAPSHOT_CONTEXT_INVALID"), true);
  const invalidRuntimeModel = { ...runtime.model, find: () => ({ id: "provider/model", contextWindow: Number.NaN, thinking: ["off"] }) };
  assert.equal(validateSnapshotResumeCompatibility(value, { ...runtime, sourceState: "current", model: invalidRuntimeModel }).codes.includes("SNAPSHOT_CONTEXT_INVALID"), true);
});
