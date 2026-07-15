import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function projectFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const readme = projectFile("README.md");
const setup = projectFile("SETUP.md");
const commandsSource = projectFile("src/integration/commands.ts");
const toolsSource = projectFile("src/agents/tools.ts");
const justfile = projectFile("Justfile");
const gitignore = projectFile(".gitignore");
const packageJson = projectFile("package.json");
const publicDocs = `${readme}\n${setup}\n${packageJson}`;

const expectedCommands = [
  "hive",
  "hive:doctor",
  "hive:execute",
  "hive:normal",
  "hive:observe",
  "hive:observe-prune",
  "hive:observe-stop",
  "hive:plan",
  "hive:plan-mode",
  "hive:toggle",
];

const expectedTools = [
  "ask_user",
  "delegate_agent",
  "hive_sdd_status",
  "plan_new",
  "plan_select",
  "plan_task_complete",
  "route_agent",
  "submit_review_verdict",
  "team_conversation",
  "team_status",
];

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("documented slash commands exactly match registered pi-hive commands", () => {
  const registered = [...commandsSource.matchAll(/registerCommand\("([^"]+)"/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(registered, expectedCommands);

  for (const command of registered) {
    assert.match(readme, new RegExp(`/${escaped(command)}(?:[\\s\x60]|$)`), `README should document /${command}`);
  }
});

test("documentation names every public hive tool", () => {
  const implemented = expectedTools.filter((name) => toolsSource.includes(`name: "${name}"`));
  assert.deepEqual(implemented, expectedTools);
  for (const tool of implemented) {
    assert.match(publicDocs, new RegExp(`\\b${escaped(tool)}\\b`), `documentation should name ${tool}`);
  }
});

test("documentation rejects retired architecture and command terminology", () => {
  for (const retired of [
    /\bSolid(?:JS)?\b/i,
    /separate `pi` subprocess/i,
    /\.pi\/hive\/plans/i,
    /\/hive-status\b/i,
    /\bapprove_plan\b/i,
    /\/hive-(?:normal|plan-mode|toggle|doctor|execute|plan|observe)\b/i,
  ]) {
    assert.doesNotMatch(publicDocs, retired);
  }
  assert.match(publicDocs, /React \+ Vite/);
  assert.match(publicDocs, /in-process Pi `AgentSession`/);
  assert.match(publicDocs, /proposal → \{ design, specs \} → tasks/);
});

test("documented just commands resolve to recipes or aliases", () => {
  const recipes = new Set([...justfile.matchAll(/^([a-z][a-z0-9-]*)(?:\s+[^:\n]+)?:/gm)].map((match) => match[1]));
  const aliases = new Set([...justfile.matchAll(/^alias\s+([a-z][a-z0-9-]*)\s*:=/gm)].map((match) => match[1]));
  const cited = new Set([...`${readme}\n${setup}\n${gitignore}`.matchAll(/(?:^|\x60)\s*just\s+([a-z][a-z0-9-]*)/gm)].map((match) => match[1]));

  for (const command of cited) {
    assert.ok(recipes.has(command) || aliases.has(command), `documented just command does not exist: ${command}`);
  }
});
