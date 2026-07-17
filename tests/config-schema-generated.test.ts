import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import {
  AgentFrontmatterV1Schema,
  ManifestV1Schema,
  WorkflowV1Schema,
} from "../src/config/schema.ts";

const root = join(import.meta.dirname, "..");

type EditorSchema = TSchema & { $schema?: unknown; $id?: unknown };

function artifact(name: string): EditorSchema {
  return JSON.parse(readFileSync(join(root, "schemas", name), "utf8")) as EditorSchema;
}

test("committed config schemas are deterministic and drift-free", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/generate-config-schemas.mjs", "--check"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("generated schemas preserve runtime and independent JSON Schema acceptance parity", () => {
  const ajv = new Ajv2020({ strict: false });
  const workflow = {
    name: "Workflow",
    description: "Description",
    "use-when": "Use it",
    artifact: {
      adapter: "none",
      profile: "default",
      binding: "none",
      options: { nested: [null, { ok: true }] },
    },
    team: {
      id: "root",
      agent: "agent",
      members: [{ id: "child", agent: "agent" }],
    },
    instructions: { root: "Run it" },
    budgets: { "max-agent-turns": Number.MAX_SAFE_INTEGER },
  };
  const cases: Array<[TSchema, EditorSchema, unknown[]]> = [
    [ManifestV1Schema, artifact("hive-manifest-v1.schema.json"), [
      { "schema-version": 1, agents: {}, workflows: {} },
      { "schema-version": 1, agents: {}, workflows: {}, nested: true },
      { "schema-version": 1, agents: { bad_id: "a.md" }, workflows: {} },
    ]],
    [AgentFrontmatterV1Schema, artifact("hive-agent-frontmatter-v1.schema.json"), [
      { name: "Agent", capabilities: {} },
      { name: "Agent", capabilities: { shell: ["inspect", "inspect"] } },
      { name: "Agent", capabilities: {}, budgets: { "active-wall-time": "0s" } },
    ]],
    [WorkflowV1Schema, artifact("hive-workflow-v1.schema.json"), [
      workflow,
      {
        ...workflow,
        team: {
          id: "root",
          agent: "agent",
          members: [{ id: "child", agent: "agent", extra: true }],
        },
      },
      { ...workflow, tags: ["same", "same"] },
    ]],
  ];

  for (const [runtime, generated, values] of cases) {
    assert.equal(generated.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(String(generated.$id), /^urn:pi-hive:schema:/);
    const editorCheck = ajv.compile(generated as AnySchema);
    for (const value of values) {
      const runtimeAccepted = Check(runtime, value);
      assert.equal(Check(generated, value), runtimeAccepted);
      assert.equal(editorCheck(value), runtimeAccepted, JSON.stringify(editorCheck.errors));
    }
  }
});
