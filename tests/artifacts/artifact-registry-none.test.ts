import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_PROFILE_VERSION,
  validateArtifactWorkspaceBinding,
} from "../../src/artifacts/contracts.ts";
import {
  BUILTIN_ARTIFACT_REGISTRY,
  ArtifactRegistryError,
} from "../../src/artifacts/registry.ts";
import { NONE_ADAPTER_VERSION } from "../../src/artifacts/adapters/none.ts";

test("the artifact registry is immutable, built-in-only, and version exact", () => {
  assert.deepEqual(BUILTIN_ARTIFACT_REGISTRY.adapterIds(), ["markdown-plan", "none", "openspec"]);
  assert.equal((BUILTIN_ARTIFACT_REGISTRY as unknown as { register?: unknown }).register, undefined);

  const resolved = BUILTIN_ARTIFACT_REGISTRY.resolveProfile({
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    adapterId: "none",
    adapterVersion: NONE_ADAPTER_VERSION,
    profileId: "default",
    profileVersion: ARTIFACT_PROFILE_VERSION,
  });
  assert.equal(resolved.adapter.id, "none");
  assert.equal(resolved.profile.id, "default");
  assert.equal(resolved.profile.optionsSchemaVersion, "1");

  assert.throws(() => BUILTIN_ARTIFACT_REGISTRY.resolveProfile({
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    adapterId: "openspec",
    adapterVersion: ARTIFACT_PROFILE_VERSION,
    profileId: "author",
    profileVersion: ARTIFACT_PROFILE_VERSION,
  }), (error: unknown) => error instanceof ArtifactRegistryError && error.code === "ADAPTER_UNAVAILABLE");

  for (const selection of [
    { adapterId: "external", adapterVersion: "1", profileId: "default", profileVersion: ARTIFACT_PROFILE_VERSION, contractVersion: ARTIFACT_CONTRACT_VERSION },
    { adapterId: "none", adapterVersion: "2", profileId: "default", profileVersion: ARTIFACT_PROFILE_VERSION, contractVersion: ARTIFACT_CONTRACT_VERSION },
    { adapterId: "none", adapterVersion: NONE_ADAPTER_VERSION, profileId: "other", profileVersion: ARTIFACT_PROFILE_VERSION, contractVersion: ARTIFACT_CONTRACT_VERSION },
    { adapterId: "none", adapterVersion: NONE_ADAPTER_VERSION, profileId: "default", profileVersion: "2", contractVersion: ARTIFACT_CONTRACT_VERSION },
    { adapterId: "none", adapterVersion: NONE_ADAPTER_VERSION, profileId: "default", profileVersion: ARTIFACT_PROFILE_VERSION, contractVersion: "future" },
  ]) {
    assert.throws(
      () => BUILTIN_ARTIFACT_REGISTRY.resolveProfile(selection),
      (error: unknown) => error instanceof ArtifactRegistryError && /unknown|version|contract/i.test(error.message),
    );
  }
});

test("persisted workspace bindings validate every physical-authority field and fail closed", () => {
  const physical = {
    schemaVersion: 1,
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    adapterId: "fixture",
    adapterVersion: "1",
    profileId: "author",
    profileVersion: ARTIFACT_PROFILE_VERSION,
    binding: "existing",
    selection: "existing",
    workspace: { id: "workspace-1", kind: "physical" },
    path: "/trusted/workspace",
    workspaceHash: `sha256:${"a".repeat(64)}`,
    writerLease: { required: true },
    checkpointIds: ["plan"],
    actionIds: ["update"],
  };
  assert.deepEqual(validateArtifactWorkspaceBinding(physical), physical);
  for (const malformed of [
    { ...physical, extra: true },
    { ...physical, adapterId: "bad/id" },
    { ...physical, binding: "latest" },
    { ...physical, selection: undefined },
    { ...physical, workspace: null },
    { ...physical, workspace: { id: "workspace-1", kind: "virtual" } },
    { ...physical, path: "relative" },
    { ...physical, workspaceHash: "sha256:bad" },
    { ...physical, writerLease: { required: false } },
    { ...physical, checkpointIds: ["plan", "plan"] },
    { ...physical, workspace: { id: "none", kind: "logical-empty" }, binding: "none" },
  ]) assert.throws(() => validateArtifactWorkspaceBinding(malformed), /artifact|workspace|binding|checkpoint|hash|lease|path/i);
});

test("none validates closed options and binds one stable logical empty workspace", () => {
  const resolved = BUILTIN_ARTIFACT_REGISTRY.resolveProfile({
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    adapterId: "none",
    adapterVersion: NONE_ADAPTER_VERSION,
    profileId: "default",
    profileVersion: ARTIFACT_PROFILE_VERSION,
  });
  assert.ok(resolved.adapter);
  assert.throws(() => BUILTIN_ARTIFACT_REGISTRY.validateOptions(resolved.profile, { extra: true }), /options|unknown/i);
  assert.throws(() => BUILTIN_ARTIFACT_REGISTRY.bind(resolved, { runId: "run-1", binding: "new", options: {} }), /binding/i);

  const first = BUILTIN_ARTIFACT_REGISTRY.bind(resolved, { runId: "run-1", binding: "none", options: {} });
  const repeated = BUILTIN_ARTIFACT_REGISTRY.bind(resolved, { runId: "run-1", binding: "none", options: {} });
  assert.deepEqual(first, repeated);
  assert.deepEqual(first.workspace, { id: "none", kind: "logical-empty" });
  assert.equal(first.path, undefined);
  assert.equal(first.workspaceHash, undefined);
  assert.equal(first.writerLease, undefined);
  assert.deepEqual(first.checkpointIds, []);
  assert.deepEqual(first.actionIds, []);
});
