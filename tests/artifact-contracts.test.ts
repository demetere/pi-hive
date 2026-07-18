import assert from "node:assert/strict";
import { test } from "node:test";
import { ARTIFACT_CONTRACT_VERSION, BUILTIN_ARTIFACT_PROFILES, artifactProfileContract, validateArtifactDeclaration } from "../src/artifacts/contracts.ts";

const rows = [
  ["none", "default", ["none"], []],
  ["markdown-plan", "author", ["new", "existing", "either"], ["plan"]],
  ["markdown-plan", "execute", ["existing"], ["plan", "execution"]],
  ["markdown-plan", "review", ["existing"], ["execution", "review"]],
  ["markdown-plan", "lifecycle", ["new", "existing", "either"], ["plan", "execution", "review"]],
  ["openspec", "author", ["new", "existing", "either"], ["proposal", "design", "specs", "tasks"]],
  ["openspec", "execute", ["existing"], ["tasks", "implementation"]],
  ["openspec", "review", ["existing"], ["implementation", "review"]],
  ["openspec", "lifecycle", ["new", "existing", "either"], ["proposal", "design", "specs", "tasks", "implementation", "review"]],
] as const;

test("built-in artifact contracts publish versioned binding and checkpoint metadata", () => {
  assert.equal(ARTIFACT_CONTRACT_VERSION, "pi-hive-artifact-contract-v1");
  for (const [adapter, profile, bindings, checkpoints] of rows) {
    const contract = artifactProfileContract(adapter, profile);
    assert.deepEqual(contract?.bindings, bindings);
    assert.deepEqual(contract?.checkpoints, checkpoints);
  }
});

test("artifact contract graph is exactly nine rows and deeply immutable", () => {
  assert.equal(BUILTIN_ARTIFACT_PROFILES.length, 9);
  assert.equal(Object.isFrozen(BUILTIN_ARTIFACT_PROFILES), true);
  for (const row of BUILTIN_ARTIFACT_PROFILES) {
    assert.equal(Object.isFrozen(row), true);
    assert.equal(Object.isFrozen(row.bindings), true);
    assert.equal(Object.isFrozen(row.checkpoints), true);
  }
  const contract = artifactProfileContract("openspec", "author")!;
  assert.throws(() => (contract.checkpoints as string[]).push("evil"), TypeError);
  assert.deepEqual(artifactProfileContract("openspec", "author")?.checkpoints, ["proposal", "design", "specs", "tasks"]);
});

test("artifact declarations require valid bindings, empty options, and exact checkpoint sets", () => {
  for (const [adapter, profile, bindings, checkpoints] of rows) {
    for (const binding of bindings) {
      const approvals = Object.fromEntries(checkpoints.map((id) => [id, "required"]));
      assert.deepEqual(validateArtifactDeclaration({ adapter, profile, binding, options: {} }, approvals).codes, []);
    }
    if (checkpoints.length) {
      const missing = Object.fromEntries(checkpoints.slice(1).map((id) => [id, "required"]));
      assert.ok(validateArtifactDeclaration({ adapter, profile, binding: bindings[0], options: {} }, missing).codes.includes("WORKFLOW_CHECKPOINT_MISSING"));
    }
  }
  assert.ok(validateArtifactDeclaration({ adapter: "none", profile: "default", binding: "new", options: {} }, undefined).codes.includes("ARTIFACT_BINDING_INVALID"));
  assert.ok(validateArtifactDeclaration({ adapter: "none", profile: "default", binding: "none", options: { x: true } }, undefined).codes.includes("ARTIFACT_OPTIONS_UNKNOWN"));
  assert.ok(validateArtifactDeclaration({ adapter: "unknown", profile: "default", binding: "none", options: {} }, undefined).codes.includes("ARTIFACT_PROFILE_UNKNOWN"));
});
