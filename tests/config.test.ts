import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allConfiguredAgents, loadConfig } from "../src/core/config.ts";
import { normalizeDomainScopes } from "../src/core/normalize.ts";
import { auditAgentTypes, inferAgentType } from "../src/core/agent-type-audit.ts";

function fixtureProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-config-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "agents", "orchestrator.md"), "---\nmodel: openai/gpt-5\nthinking: medium\nagent-type: lead\n---\nOrchestrate.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "frontend.md"), "---\nmodel: anthropic/claude-sonnet\nagent-type: coder\n---\nBuild UI.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "qa.md"), "---\nmodel: anthropic/claude-sonnet\nagent-type: tester\n---\nTest UI.");
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
        delete: false
    members:
      - name: QA Engineer
        path: .pi/hive/agents/qa.md
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

test("loadConfig requires explicit domain capabilities", () => {
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
        read: true
        upsert: true
`);

  assert.throws(() => loadConfig(cwd), /domain\[0\]\.delete must be explicitly set/);
});

test("normalizeDomainScopes rejects legacy shorthand entries", () => {
  assert.throws(() => normalizeDomainScopes(["ui"]), /domain\[0\] must be an object/);
});

test("loadConfig validates domain include and exclude globs", () => {
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
        read: true
        upsert: true
        delete: false
        include: "**/*.test.ts"
`);

  assert.throws(() => loadConfig(cwd), /domain\[0\]\.include must be a list of strings/);
});

// ── Agent-type contract (Phase A) ──────────────────────────────────────────

test("loadConfig reads agent-type/stages/commit from frontmatter onto config", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-types-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "agents", "orchestrator.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: lead\ncommit: \"Only commit after review is green.\"\n---\nLead.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "planner.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: planner\nstages: [proposal, requirements]\n---\nPlan.");
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
settings:
  distiller:
    enabled: false
orchestrator:
  name: Orchestrator
  path: .pi/hive/agents/orchestrator.md
agents:
  - name: Requirements Planner
    path: .pi/hive/agents/planner.md
`);

  const config = loadConfig(cwd);
  assert.equal(config.orchestrator.agentType, "lead");
  assert.equal(config.orchestrator.commit, "Only commit after review is green.");
  assert.equal(config.agents[0].agentType, "planner");
  assert.deepEqual(config.agents[0].stages, ["proposal", "requirements"]);
});

function typedFixture(orchestratorFrontmatter: string, agentFrontmatter: string, agentConfigExtra = "") {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-types-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "agents", "orchestrator.md"), `---\nmodel: openai/gpt-5\nthinking: off\n${orchestratorFrontmatter}\n---\nLead.`);
  writeFileSync(join(cwd, ".pi", "hive", "agents", "agent.md"), `---\nmodel: openai/gpt-5\nthinking: off\n${agentFrontmatter}\n---\nWork.`);
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
settings:
  distiller:
    enabled: false
orchestrator:
  name: Orchestrator
  path: .pi/hive/agents/orchestrator.md
agents:
  - name: Worker
    path: .pi/hive/agents/agent.md
${agentConfigExtra}`);
  return cwd;
}

test("loadConfig hard-fails when an agent is missing agent-type", () => {
  const cwd = typedFixture("agent-type: lead", "model: openai/gpt-5"); // agent.md has no agent-type
  assert.throws(() => loadConfig(cwd), /agents\[0\]\.agent-type is required/);
});

test("loadConfig hard-fails when the orchestrator is missing agent-type", () => {
  const cwd = typedFixture("thinking: off", "agent-type: coder"); // orchestrator.md has no agent-type
  assert.throws(() => loadConfig(cwd), /orchestrator\.agent-type is required/);
});

test("loadConfig hard-fails on an invalid agent-type", () => {
  const cwd = typedFixture("agent-type: lead", "agent-type: wizard");
  assert.throws(() => loadConfig(cwd), /agent-type must be one of/);
});

test("loadConfig rejects stages on a non-planner", () => {
  const cwd = typedFixture("agent-type: lead", "agent-type: coder\nstages: [design]");
  assert.throws(() => loadConfig(cwd), /stages is only valid on an agent-type: planner/);
});

test("loadConfig rejects an invalid stage on a planner", () => {
  const cwd = typedFixture("agent-type: lead", "agent-type: planner\nstages: [proposal, ship]");
  assert.throws(() => loadConfig(cwd), /stages\[1\] must be one of/);
});

test("inferAgentType applies name/report heuristics", () => {
  assert.equal(inferAgentType("Security Reviewer", false, false), "reviewer");
  assert.equal(inferAgentType("QA Tester", false, false), "tester");
  assert.equal(inferAgentType("Requirements Planner", false, false), "planner");
  assert.equal(inferAgentType("Engineering Lead", true, false), "lead");
  assert.equal(inferAgentType("Orchestrator", false, true), "lead");
  assert.equal(inferAgentType("Backend Dev", false, false), "coder");
});

test("auditAgentTypes reports offenders with suggestions without loading", () => {
  const cwd = typedFixture("agent-type: lead", "model: openai/gpt-5"); // Worker untyped
  const audit = auditAgentTypes(cwd);
  const worker = audit.rows.find((row) => row.name === "Worker");
  assert.ok(worker);
  assert.equal(worker?.valid, false);
  assert.equal(worker?.suggestion, "coder");
  assert.equal(audit.offenders.length, 1);
  // The orchestrator is correctly typed and is not an offender.
  assert.equal(audit.rows.find((row) => row.name === "Orchestrator")?.valid, true);
});
