import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allConfiguredAgents, loadConfig } from "../src/core/config.ts";

function fixtureProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-config-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "agents", "orchestrator.md"), "---\nmodel: openai/gpt-5\nthinking: medium\n---\nOrchestrate.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "frontend.md"), "---\nmodel: anthropic/claude-sonnet\n---\nBuild UI.");
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
settings:
  default-tools: read, grep
  max-parallel: 2
  distiller:
    enabled: false
orchestrator:
  name: Orchestrator
  path: .pi/hive/agents/orchestrator.md
shared-context:
  - README.md
agents:
  - name: Frontend Dev
    path: .pi/hive/agents/frontend.md
    routing-tags: [frontend, react]
    domain:
      - path: ui
        read: true
        upsert: true
    members:
      - name: QA Engineer
        path: .pi/hive/agents/frontend.md
        routing-tags: [test]
`);
  return cwd;
}

test("loadConfig normalizes settings and enriches model frontmatter", () => {
  const config = loadConfig(fixtureProject());

  assert.equal(config.settings.maxParallel, 2);
  assert.equal(config.settings.defaultTools, "read, grep");
  assert.equal(config.settings.distiller.enabled, false);
  assert.equal(config.orchestrator.model, "openai/gpt-5");
  assert.equal(config.orchestrator.thinking, "medium");
  assert.equal(config.agents[0].model, "anthropic/claude-sonnet");
});

test("allConfiguredAgents derives hierarchy roles and delegation targets", () => {
  const config = loadConfig(fixtureProject());
  const agents = allConfiguredAgents(config);
  const byName = new Map(agents.map((agent) => [agent.name, agent]));

  assert.equal(byName.get("Orchestrator")?.role, "orchestrator");
  assert.deepEqual(byName.get("Orchestrator")?.allowedAgents, ["Frontend Dev"]);
  assert.equal(byName.get("Frontend Dev")?.role, "lead");
  assert.deepEqual(byName.get("Frontend Dev")?.allowedAgents, ["QA Engineer"]);
  assert.equal(byName.get("QA Engineer")?.role, "member");
  assert.equal(byName.get("QA Engineer")?.groupName, "Frontend Dev");
});

test("loadConfig rejects duplicate agent names with a clear schema error", () => {
  const cwd = fixtureProject();
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
settings:
  distiller:
    enabled: false
orchestrator:
  name: Orchestrator
  path: .pi/hive/agents/orchestrator.md
agents:
  - name: Frontend Dev
    path: .pi/hive/agents/frontend.md
  - name: frontend dev
    path: .pi/hive/agents/frontend.md
`);

  assert.throws(() => loadConfig(cwd), /Duplicate agent name/);
});

test("loadConfig validates domain capability types before normalization", () => {
  const cwd = fixtureProject();
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
settings:
  distiller:
    enabled: false
orchestrator:
  name: Orchestrator
  path: .pi/hive/agents/orchestrator.md
agents:
  - name: Frontend Dev
    path: .pi/hive/agents/frontend.md
    domain:
      - path: ui
        read: yes
`);

  assert.throws(() => loadConfig(cwd), /domain\[0\]\.read must be true or false/);
});
