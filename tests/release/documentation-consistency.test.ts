import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const file = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const docs = ["README.md", "SETUP.md", "SECURITY.md"].map(file).join("\n");
const commandsSource = file("src/integration/workflow-commands.ts");
const toolsSource = file("src/workflows/tools.ts");
const justfile = file("Justfile");
const expectedCommands = ["hive:answer", "hive:cancel", "hive:checkpoints", "hive:doctor", "hive:exit", "hive:handoff-clear", "hive:observe", "hive:observe-prune", "hive:observe-stop", "hive:recover", "hive:reload", "hive:select", "hive:status"];
const expectedTools = ["artifact_action", "artifact_status", "delegate_agent", "human_question", "knowledge_propose", "knowledge_read", "knowledge_search", "route_agent", "team_status", "workflow_finish", "workflow_status"];

test("documented commands exactly match workflow registration", () => {
  const registered = [...commandsSource.matchAll(/bind\("([^"]+)"/gu)].map((match) => match[1]).sort();
  assert.deepEqual(registered, expectedCommands);
  for (const command of registered) assert.match(docs, new RegExp(`/${command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`));
});

test("documentation names every generic workflow tool and no retired public command", () => {
  for (const tool of expectedTools) { assert.match(toolsSource, new RegExp(`contract\\("${tool}"`)); assert.match(docs, new RegExp(`\\b${tool}\\b`)); }
  assert.doesNotMatch(docs, /\/hive:(?:normal|plan-mode|toggle|execute|plan)\b|Ctrl\+Alt\+T|agent-type/i);
});

test("documented just commands exist", () => {
  const recipes = new Set([...justfile.matchAll(/^([a-z][a-z0-9-]*)(?:\s+[^:\n]+)?:/gmu)].map((match) => match[1]));
  const aliases = new Set([...justfile.matchAll(/^alias\s+([a-z][a-z0-9-]*)\s*:=/gmu)].map((match) => match[1]));
  for (const match of docs.matchAll(/(?:^|`)\s*just\s+([a-z][a-z0-9-]*)/gmu)) assert.ok(recipes.has(match[1]) || aliases.has(match[1]), `unknown just recipe ${match[1]}`);
});

test("public docs state clean telemetry, supported platforms, and non-sandbox boundaries", () => {
  assert.match(docs, /Historical pre-1\.0 telemetry files are preserved|Historical telemetry stays archived/i);
  assert.match(docs, /supports Linux and macOS/i);
  assert.match(docs, /Darwin N-API helpers/i);
  assert.match(docs, /not an OS sandbox/i);
  assert.match(docs, /not a general information-flow or DLP boundary/i);
});
