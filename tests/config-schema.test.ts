import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Check } from "typebox/value";
import {
  AgentFrontmatterV1Schema,
  DurationV1Schema,
  ManifestV1Schema,
  PositiveSafeIntegerSchema,
  PublicIdSchema,
  RawCapabilitiesSchema,
  WorkflowV1Schema,
  validateManifestV1,
  validateSchemaValue,
} from "../src/config/schema.ts";
import { parseConfigYaml } from "../src/config/yaml.ts";

const fixtureRoot = join(import.meta.dirname, "fixtures/workflow-configs");

function yaml(path: string) {
  const source = readFileSync(join(fixtureRoot, path), "utf8");
  const parsed = parseConfigYaml(source, path);
  assert.deepEqual(parsed.diagnostics, []);
  assert.ok(parsed.value);
  return { source, ...parsed.value };
}

function agentFrontmatter(path: string) {
  const file = readFileSync(join(fixtureRoot, path), "utf8");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(file);
  assert.ok(match);
  return parseConfigYaml(match[1], path);
}

test("shared schema primitives enforce IDs, durations, counters, and capabilities", () => {
  for (const value of ["root", "adapter-profile", "a1-b2"]) assert.equal(Check(PublicIdSchema, value), true);
  for (const value of ["Root", "two--parts", "-bad", "bad_thing", ""]) assert.equal(Check(PublicIdSchema, value), false, value);
  for (const value of ["1ms", "20s", "3m", "4h"]) assert.equal(Check(DurationV1Schema, value), true);
  for (const value of ["0s", "01s", "1.5h", "1d", 1]) assert.equal(Check(DurationV1Schema, value), false, String(value));
  for (const value of [1, Number.MAX_SAFE_INTEGER]) assert.equal(Check(PositiveSafeIntegerSchema, value), true);
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", Infinity]) assert.equal(Check(PositiveSafeIntegerSchema, value), false, String(value));

  assert.equal(Check(RawCapabilitiesSchema, {}), true);
  assert.equal(Check(RawCapabilitiesSchema, { filesystem: [{ path: ".", operations: ["read"] }], shell: [], git: false }), true);
  assert.equal(Check(RawCapabilitiesSchema, { filesystem: [{ path: ".", operations: [] }] }), false);
  assert.equal(Check(RawCapabilitiesSchema, { shell: ["inspect", "inspect"] }), false);
  assert.equal(Check(RawCapabilitiesSchema, { tools: ["read"] }), false);
  assert.equal(Check(RawCapabilitiesSchema, { filesystem: [{ path: ".", operations: ["read"], mystery: true }] }), false);
});

test("manifest schema validates W00 manifests and specializes schema-version failures", () => {
  for (const path of [
    "artifact-free-debug/.pi/hive/hive-config.yaml",
    "combined-delivery/.pi/hive/hive-config.yaml",
    "split-plan-build/.pi/hive/hive-config.yaml",
    "nested-project/.pi/hive/hive-config.yaml",
    "nested-project/packages/child/.pi/hive/hive-config.yaml",
  ]) {
    const parsed = yaml(path);
    assert.equal(validateManifestV1(parsed.data, path, parsed.sourceMap).diagnostics.length, 0, path);
  }

  assert.equal(Check(ManifestV1Schema, { "schema-version": 1, agents: {}, workflows: {}, mystery: true }), false);
  assert.equal(Check(ManifestV1Schema, { "schema-version": 1, agents: { Bad_ID: "missing.md" }, workflows: {} }), false);

  const missing = parseConfigYaml("agents: {}\nworkflows: {}\n", "manifest.yaml").value!;
  assert.equal(validateManifestV1(missing.data, "manifest.yaml", missing.sourceMap).diagnostics[0].code, "SCHEMA_VERSION_MISSING");
  const unsupported = parseConfigYaml("schema-version: 2\nagents: {}\nworkflows: {}\n", "manifest.yaml").value!;
  assert.equal(validateManifestV1(unsupported.data, "manifest.yaml", unsupported.sourceMap).diagnostics[0].code, "SCHEMA_VERSION_UNSUPPORTED");
});

test("agent frontmatter mappings are closed and validate W00 examples", () => {
  for (const path of [
    "artifact-free-debug/.pi/hive/agents/debugger.md",
    "combined-delivery/.pi/hive/agents/orchestrator.md",
    "combined-delivery/.pi/hive/agents/coder.md",
  ]) {
    const parsed = agentFrontmatter(path);
    assert.deepEqual(parsed.diagnostics, [], path);
    assert.equal(Check(AgentFrontmatterV1Schema, parsed.value?.data), true, path);
  }
  assert.equal(Check(AgentFrontmatterV1Schema, { name: "Agent", capabilities: {}, budgets: { "max-parallel": 2 } }), false);
  assert.equal(Check(AgentFrontmatterV1Schema, { name: "   ", capabilities: {} }), false);
  assert.equal(Check(AgentFrontmatterV1Schema, { name: "Agent", capabilities: {}, tags: ["same", "same"] }), false);
  assert.equal(Check(AgentFrontmatterV1Schema, { name: "Agent", capabilities: {}, "agent-type": "coder" }), false);
});

test("workflow schema validates recursive W00 examples and closes authority objects", () => {
  for (const path of [
    "artifact-free-debug/.pi/hive/workflows/debug-chat.yaml",
    "combined-delivery/.pi/hive/workflows/feature-delivery.yaml",
    "split-plan-build/.pi/hive/workflows/feature-plan.yaml",
    "split-plan-build/.pi/hive/workflows/feature-build.yaml",
  ]) {
    const parsed = yaml(path);
    assert.equal(Check(WorkflowV1Schema, parsed.data), true, path);
  }

  const base = yaml("artifact-free-debug/.pi/hive/workflows/debug-chat.yaml").data as any;
  assert.equal(Check(WorkflowV1Schema, { ...base, instructions: "scalar" }), false);
  assert.equal(Check(WorkflowV1Schema, { ...base, artifact: { ...base.artifact, adapter: "Bad Adapter" } }), false);
  assert.equal(Check(WorkflowV1Schema, { ...base, artifact: { ...base.artifact, options: { nested: [null, true, 1, "x", { ok: false }] } } }), true);
  assert.equal(Check(WorkflowV1Schema, { ...base, artifact: { ...base.artifact, options: { bad: undefined } } }), false);
  assert.equal(Check(WorkflowV1Schema, { ...base, team: { ...base.team, children: [] } }), false);
  assert.equal(Check(WorkflowV1Schema, { ...base, budgets: { "max-parallel": 2 }, team: { ...base.team, overrides: { budgets: { "max-parallel": 2 } } } }), false);
});

test("schema diagnostics point unknown keys at exact key ranges and values at exact value ranges", () => {
  const parsed = parseConfigYaml("schema-version: 1\nagents: {}\nworkflows: {}\nmystery: true\n", "manifest.yaml").value!;
  const invalid = validateSchemaValue(ManifestV1Schema, parsed.data, "manifest.yaml", parsed.sourceMap);
  assert.equal(invalid.diagnostics[0].code, "SCHEMA_INVALID");
  assert.deepEqual(invalid.diagnostics[0].range, parsed.sourceMap["/mystery"].key);

  const badVersion = parseConfigYaml("schema-version: one\nagents: {}\nworkflows: {}\n", "manifest.yaml").value!;
  const invalidVersion = validateSchemaValue(ManifestV1Schema, badVersion.data, "manifest.yaml", badVersion.sourceMap);
  assert.deepEqual(invalidVersion.diagnostics[0].range, badVersion.sourceMap["/schema-version"].value);
});

test("later-owned semantic errors remain syntactically accepted", () => {
  for (const name of [
    "missing-agent-resource",
    "missing-workflow-resource",
    "unknown-agent-id",
    "unknown-suggested-next-id",
    "duplicate-team-node-id",
    "missing-checkpoint",
    "unknown-checkpoint",
    "widening-filesystem-override",
  ]) {
    const manifestPath = `invalid/${name}/.pi/hive/hive-config.yaml`;
    const manifest = yaml(manifestPath);
    assert.equal(Check(ManifestV1Schema, manifest.data), true, manifestPath);
    const workflowPath = join(fixtureRoot, `invalid/${name}/.pi/hive/workflows/debug-chat.yaml`);
    try {
      const workflow = yaml(`invalid/${name}/.pi/hive/workflows/debug-chat.yaml`);
      assert.equal(Check(WorkflowV1Schema, workflow.data), true, name);
    } catch (error) {
      if (!String(error).includes("ENOENT")) throw error;
      assert.equal(readFileSync(join(fixtureRoot, manifestPath), "utf8").length > 0, true);
    }
    void workflowPath;
  }
});
