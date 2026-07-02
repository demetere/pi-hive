import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(cwd, ".pi", "hive", "agents", "plan-main.md"), "---\nmodel: openai/gpt-5\nthinking: medium\nagent-type: lead\n---\nPlan.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "frontend.md"), "---\nmodel: anthropic/claude-sonnet\nagent-type: coder\n---\nBuild UI.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "qa.md"), "---\nmodel: anthropic/claude-sonnet\nagent-type: tester\n---\nTest UI.");
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
settings:
  default-tools: read, grep
  max-parallel: 2
  distiller:
    enabled: false
shared-context:
  - README.md
planning:
  main:
    name: Plan Main
    path: .pi/hive/agents/plan-main.md
  agents: []
hive:
  main:
    name: Orchestrator
    path: .pi/hive/agents/orchestrator.md
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

test("loadConfig reads shared_context from YAML (both snake_case and camelCase)", () => {
  // The kebab-case `shared-context:` is camelized by the parser; the documented
  // snake_case `shared_context:` is NOT, so it must be accepted verbatim at the
  // config-load site. Exercise the full YAML→config parse path (the object-based
  // tests skip it).
  for (const key of ["shared_context", "shared-context"]) {
    const cwd = fixtureProject();
    const cfgPath = join(cwd, ".pi", "hive", "hive-config.yaml");
    const yaml = readFileSync(cfgPath, "utf8").replace(
      "shared-context:\n  - README.md",
      `${key}:\n  - README.md\n  - docs/ARCH.md`,
    );
    writeFileSync(cfgPath, yaml);
    const config = loadConfig(cwd);
    assert.deepEqual(config.sharedContext, ["README.md", "docs/ARCH.md"], `key ${key} should populate sharedContext`);
  }
});

test("planning block with a coder/tester warns but still loads (Phase 5.1)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-planexec-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "agents", "orchestrator.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: lead\n---\nLead.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "plan-main.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: lead\n---\nPlan.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "coder.md"), "---\nmodel: anthropic/claude-sonnet\nthinking: off\nagent-type: coder\n---\nCode.");
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
settings:
  distiller:
    enabled: false
planning:
  main:
    name: Plan Main
    path: .pi/hive/agents/plan-main.md
  agents:
    - name: Stray Coder
      path: .pi/hive/agents/coder.md
hive:
  main:
    name: Orchestrator
    path: .pi/hive/agents/orchestrator.md
  agents: []
`);
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (msg?: any) => { warnings.push(String(msg)); };
  try {
    const config = loadConfig(cwd); // must NOT throw
    assert.equal(config.planning?.agents[0].agentType, "coder");
  } finally {
    console.warn = orig;
  }
  assert.ok(warnings.some((w) => /planning block contains execution agents/.test(w) && /Stray Coder/.test(w)),
    "expected a planning-execution-agent warning naming the offender");
});

test("allowedAgents in config warns but still loads (H1)", () => {
  const cwd = fixtureProject();
  // Inject a user-set allowedAgents on a node — it must be ignored (derivation
  // wins), not crash the load. Capture the warning.
  const cfgPath = join(cwd, ".pi", "hive", "hive-config.yaml");
  const yaml = readFileSync(cfgPath, "utf8").replace(
    "      routing-tags: [frontend, react]",
    "      routing-tags: [frontend, react]\n      allowedAgents: [Nonexistent]",
  );
  writeFileSync(cfgPath, yaml);

  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (msg?: any) => { warnings.push(String(msg)); };
  try {
    const config = loadConfig(cwd);
    // Derivation wins: Frontend Dev's reports are its actual members, not the
    // discarded user value.
    const agents = allConfiguredAgents(config);
    const fe = agents.find((a) => a.name === "Frontend Dev");
    assert.deepEqual(fe?.allowedAgents, ["QA Engineer"]);
  } finally {
    console.warn = orig;
  }
  assert.ok(warnings.some((w) => /allowedAgents/.test(w)), "expected an allowedAgents warning");
});

test("main-node model/thinking are optional; workers still require them (H2)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-mainopt-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  // Main nodes with NO model/thinking frontmatter — must not throw at runtime load.
  writeFileSync(join(cwd, ".pi", "hive", "agents", "main.md"), "---\nagent-type: lead\n---\nOrchestrate.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "plan.md"), "---\nagent-type: lead\n---\nPlan.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "coder.md"), "---\nmodel: anthropic/claude-sonnet\nthinking: medium\nagent-type: coder\n---\nCode.");
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
settings:
  distiller:
    enabled: false
planning:
  main:
    name: Plan Main
    path: .pi/hive/agents/plan.md
  agents: []
hive:
  main:
    name: Main
    path: .pi/hive/agents/main.md
  agents:
    - name: Coder
      path: .pi/hive/agents/coder.md
`);
  // loadConfig validates shape; it must not require main-node model/thinking.
  const config = loadConfig(cwd);
  assert.equal(config.orchestrator.name, "Main");
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
planning:
  main:
    name: Plan Main
    path: .pi/hive/agents/plan-main.md
hive:
  main:
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
planning:
  main:
    name: Plan Main
    path: .pi/hive/agents/plan-main.md
hive:
  main:
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
planning:
  main:
    name: Plan Main
    path: .pi/hive/agents/plan-main.md
hive:
  main:
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
  writeFileSync(join(cwd, ".pi", "hive", "agents", "plan-main.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: lead\n---\nPlan.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "planner.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: planner\nstages: [proposal, requirements]\n---\nPlan.");
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
settings:
  distiller:
    enabled: false
planning:
  main:
    name: Plan Main
    path: .pi/hive/agents/plan-main.md
hive:
  main:
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
  writeFileSync(join(cwd, ".pi", "hive", "agents", "plan-main.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: lead\n---\nPlan.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "agent.md"), `---\nmodel: openai/gpt-5\nthinking: off\n${agentFrontmatter}\n---\nWork.`);
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
settings:
  distiller:
    enabled: false
planning:
  main:
    name: Plan Main
    path: .pi/hive/agents/plan-main.md
hive:
  main:
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
