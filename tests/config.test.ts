import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allConfiguredAgents, loadConfig } from "../src/core/config.ts";
import { normalizeDomainScopes } from "../src/core/normalize.ts";
import { auditAgentTypes, inferAgentType } from "../src/core/agent-type-audit.ts";
import { buildSharedContext, renderKnowledgeRefs } from "../src/core/prompting.ts";

function fixtureProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-config-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "agents", "orchestrator.md"), "---\nmodel: openai/gpt-5\nthinking: medium\nagent-type: lead\n---\nOrchestrate.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "plan-main.md"), "---\nmodel: openai/gpt-5\nthinking: medium\nagent-type: planner\n---\nPlan.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "frontend.md"), "---\nmodel: anthropic/claude-sonnet\nagent-type: coder\n---\nBuild UI.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "qa.md"), "---\nmodel: anthropic/claude-sonnet\nagent-type: tester\n---\nTest UI.");
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
settings:
  default-tools: read, grep
  max-parallel: 2
  secret-paths:
    - config/secrets.json
    - .credentials/
  telemetry:
    enabled: true
    dashboard-auto-start: false
    retention-days: 45
    max-log-bytes: 1048576
    capture-thinking: true
    redact-sensitive-data: true
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

test("loadConfig normalizes deprecated requirements stage to specs", () => {
  const cwd = fixtureProject();
  const prompt = join(cwd, ".pi", "hive", "agents", "plan-main.md");
  writeFileSync(prompt, "---\nmodel: openai/gpt-5\nthinking: medium\nagent-type: planner\nstages:\n  - requirements\n---\nPlan.");
  const config = loadConfig(cwd);
  assert.deepEqual(config.planning?.main.stages, ["specs"]);
});

test("loadConfig normalizes settings and enriches model frontmatter", () => {
  const config = loadConfig(fixtureProject());

  assert.equal(config.settings.maxParallel, 2);
  assert.equal(config.settings.defaultTools, "read, grep");
  assert.deepEqual(config.settings.secretPaths, ["config/secrets.json", ".credentials/"]);
  assert.deepEqual(config.settings.telemetry, {
    enabled: true,
    dashboardAutoStart: false,
    retentionDays: 45,
    maxLogBytes: 1048576,
    captureThinking: true,
    redactSensitiveData: true,
  });
  assert.equal(config.settings.distiller.enabled, false);
  assert.equal(config.orchestrator.model, "openai/gpt-5");
  assert.equal(config.orchestrator.thinking, "medium");
  assert.equal(config.agents[0].model, "anthropic/claude-sonnet");
});

test("worker governance is opt-in with settings defaults and per-agent overrides", () => {
  const unconstrainedCwd = fixtureProject();
  const unconstrainedPath = join(unconstrainedCwd, ".pi", "hive", "hive-config.yaml");
  writeFileSync(unconstrainedPath, readFileSync(unconstrainedPath, "utf8").replace("  max-parallel: 2\n", ""));
  assert.equal(loadConfig(unconstrainedCwd).settings.maxParallel, undefined);

  const cwd = fixtureProject();
  const cfgPath = join(cwd, ".pi", "hive", "hive-config.yaml");
  let yaml = readFileSync(cfgPath, "utf8").replace(
    "  max-parallel: 2",
    "  max-parallel: 2\n  queue-size: 4\n  worker:\n    timeout-ms: 5000\n    max-runs: 3\n  team-budgets:\n    token-budget: 100000\n    cost-budget-usd: 12.5",
  );
  yaml = yaml.replace(
    "    - name: Frontend Dev\n      path: .pi/hive/agents/frontend.md",
    "    - name: Frontend Dev\n      path: .pi/hive/agents/frontend.md\n      governance:\n        max-runs: 1\n        max-delegation-depth: 2",
  );
  writeFileSync(cfgPath, yaml);
  const config = loadConfig(cwd);
  assert.equal(config.settings.queueSize, 4);
  assert.deepEqual(config.settings.worker, { timeoutMs: 5000, maxRuns: 3 });
  assert.deepEqual(config.settings.teamBudgets, { tokenBudget: 100000, costBudgetUsd: 12.5 });
  assert.deepEqual(config.hive?.agents[0].governance, { maxRuns: 1, maxDelegationDepth: 2 });
});

test("loadConfig rejects unsafe telemetry limits and unknown telemetry keys", () => {
  for (const replacement of ["max-log-bytes: 0", "retention-days: 999999", "send-to-cloud: true"]) {
    const cwd = fixtureProject();
    const cfgPath = join(cwd, ".pi", "hive", "hive-config.yaml");
    const yaml = readFileSync(cfgPath, "utf8").replace("max-log-bytes: 1048576", replacement);
    writeFileSync(cfgPath, yaml);
    assert.throws(() => loadConfig(cwd), /settings\.telemetry/);
  }
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

test("loadConfig recovers quoted inline shared_context containing a colon", () => {
  const cwd = fixtureProject();
  const cfgPath = join(cwd, ".pi", "hive", "hive-config.yaml");
  const yaml = readFileSync(cfgPath, "utf8").replace(
    "shared-context:\n  - README.md",
    'shared_context:\n  - "iMed is HIPAA-regulated: no TODOs, no placeholders"',
  );
  writeFileSync(cfgPath, yaml);

  const config = loadConfig(cwd);
  assert.deepEqual(config.sharedContext, ["iMed is HIPAA-regulated: no TODOs, no placeholders"]);

  const rendered = buildSharedContext({ config } as any, { cwd } as any);
  assert.match(rendered, /Inline shared context/);
  assert.match(rendered, /HIPAA-regulated: no TODOs/);
});

test("shared context and knowledge refs reject symlink escapes", () => {
  const cwd = fixtureProject();
  const outside = mkdtempSync(join(tmpdir(), "pi-hive-context-outside-"));
  writeFileSync(join(outside, "secret.md"), "DO NOT LEAK");
  symlinkSync(join(outside, "secret.md"), join(cwd, "linked-secret.md"));
  const config = loadConfig(cwd);
  config.sharedContext = ["linked-secret.md"];

  const shared = buildSharedContext({ config } as any, { cwd } as any);
  assert.doesNotMatch(shared, /DO NOT LEAK/);
  assert.match(shared, /not readable/);
  const knowledge = renderKnowledgeRefs({ cwd } as any, "Context", [{ path: "linked-secret.md" }]);
  assert.doesNotMatch(knowledge, /DO NOT LEAK/);
  assert.match(knowledge, /not readable/);
});

test("loadConfig rejects non-string shared_context entries before delegation", () => {
  const cwd = fixtureProject();
  const cfgPath = join(cwd, ".pi", "hive", "hive-config.yaml");
  const yaml = readFileSync(cfgPath, "utf8").replace(
    "shared-context:\n  - README.md",
    "shared_context:\n  - path: README.md",
  );
  writeFileSync(cfgPath, yaml);

  assert.throws(() => loadConfig(cwd), /shared_context\[0\] must be a string/);
});

test("planning block with a coder/tester warns but still loads (Phase 5.1)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-planexec-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "agents", "orchestrator.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: lead\n---\nLead.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "plan-main.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: planner\n---\nPlan.");
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

test("main-session agent-type mismatches warn but still load", () => {
  const cwd = fixtureProject();
  const cfgPath = join(cwd, ".pi", "hive", "hive-config.yaml");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "plan-main.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: lead\n---\nPlan.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "orchestrator.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: reviewer\n---\nReview.");
  const yaml = readFileSync(cfgPath, "utf8");
  writeFileSync(cfgPath, yaml);

  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (msg?: any) => { warnings.push(String(msg)); };
  try {
    const config = loadConfig(cwd);
    assert.equal(config.planning?.main.agentType, "lead");
    assert.equal(config.hive?.main.agentType, "reviewer");
  } finally {
    console.warn = orig;
  }
  assert.ok(warnings.some((w) => /main agent type mismatch/.test(w) && /planning\.main/.test(w) && /hive\.main/.test(w)),
    "expected a warning for both main-session type mismatches");
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
    assert.deepEqual(fe?.allowedAgents, ["qa-engineer"]);
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
  writeFileSync(join(cwd, ".pi", "hive", "agents", "plan.md"), "---\nagent-type: planner\n---\nPlan.");
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
  assert.deepEqual(byName.get("Orchestrator")?.allowedAgents, ["frontend-dev"]);
  assert.equal(byName.get("Frontend Dev")?.role, "lead");
  assert.deepEqual(byName.get("Frontend Dev")?.allowedAgents, ["qa-engineer"]);
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

  assert.throws(() => loadConfig(cwd), /Duplicate agent slug/);
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

test("loadConfig reads agent-type/stages/network/commit from frontmatter onto config", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-types-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "agents", "orchestrator.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: lead\nnetwork: true\ncommit: \"Only commit after review is green.\"\n---\nLead.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "plan-main.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: planner\n---\nPlan.");
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
  assert.equal(config.orchestrator.network, true);
  assert.equal(config.orchestrator.commit, "Only commit after review is green.");
  assert.equal(config.agents[0].agentType, "planner");
  assert.deepEqual(config.agents[0].stages, ["proposal", "specs"]);
});

function typedFixture(orchestratorFrontmatter: string, agentFrontmatter: string, agentConfigExtra = "") {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-types-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "agents", "orchestrator.md"), `---\nmodel: openai/gpt-5\nthinking: off\n${orchestratorFrontmatter}\n---\nLead.`);
  writeFileSync(join(cwd, ".pi", "hive", "agents", "plan-main.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: planner\n---\nPlan.");
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

test("loadConfig rejects a non-boolean network capability", () => {
  const cwd = typedFixture("agent-type: lead", "agent-type: reviewer\nnetwork: yes");
  assert.throws(() => loadConfig(cwd), /network must be true or false/);
});

test("loadConfig rejects unknown settings and nested keys with path-aware errors", () => {
  const cwd = fixtureProject();
  const file = join(cwd, ".pi", "hive", "hive-config.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace("  max-parallel: 2", "  max-parallel: 2\n  max-paralell: 3"));
  assert.throws(() => loadConfig(cwd), /settings\.maxParalell is not a recognized configuration key/);

  const cwd2 = fixtureProject();
  const file2 = join(cwd2, ".pi", "hive", "hive-config.yaml");
  writeFileSync(file2, readFileSync(file2, "utf8").replace("    enabled: false", "    enabled: false\n    conversation-linez: 12"));
  assert.throws(() => loadConfig(cwd2), /settings\.distiller\.conversationLinez is not a recognized configuration key/);

  const cwd3 = fixtureProject();
  const file3 = join(cwd3, ".pi", "hive", "hive-config.yaml");
  writeFileSync(file3, readFileSync(file3, "utf8").replace("      routing-tags: [frontend, react]", "      routing-tags: [frontend, react]\n      mystery-capability: true"));
  assert.throws(() => loadConfig(cwd3), /hive\.agents\[0\]\.mysteryCapability is not a recognized configuration key/);
});

test("loadConfig validates raw bounded positive integers before defaults", () => {
  for (const value of ["0", "-1", "1.5", "\"2\"", "NaN", "65"]) {
    const cwd = fixtureProject();
    const file = join(cwd, ".pi", "hive", "hive-config.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("max-parallel: 2", `max-parallel: ${value}`));
    assert.throws(() => loadConfig(cwd), /settings\.maxParallel must be a positive integer between 1 and 64/, `value ${value}`);
  }

  const cwd = fixtureProject();
  const file = join(cwd, ".pi", "hive", "hive-config.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace("  default-tools:", "  subagent-output-limit: -5\n  default-tools:"));
  assert.throws(() => loadConfig(cwd), /settings\.subagentOutputLimit must be a positive integer/);
});

test("loadConfig requires regular Markdown prompt files", () => {
  const missing = fixtureProject();
  const missingFile = join(missing, ".pi", "hive", "hive-config.yaml");
  writeFileSync(missingFile, readFileSync(missingFile, "utf8").replace(".pi/hive/agents/frontend.md", ".pi/hive/agents/missing.md"));
  assert.throws(() => loadConfig(missing), /hive\.agents\[0\]\.path.*missing|hive\.agents\[0\]\.path must exist/);

  const directory = fixtureProject();
  const directoryFile = join(directory, ".pi", "hive", "hive-config.yaml");
  writeFileSync(directoryFile, readFileSync(directoryFile, "utf8").replace(".pi/hive/agents/frontend.md", ".pi/hive/agents"));
  assert.throws(() => loadConfig(directory), /hive\.agents\[0\]\.path must reference a Markdown/);
});

test("configured paths are project-relative unless explicitly opted outside", () => {
  const cwd = fixtureProject();
  const file = join(cwd, ".pi", "hive", "hive-config.yaml");
  const absoluteInside = join(cwd, ".pi", "hive", "agents", "frontend.md");
  writeFileSync(file, readFileSync(file, "utf8").replace(".pi/hive/agents/frontend.md", absoluteInside));
  assert.throws(() => loadConfig(cwd), /hive\.agents\[0\]\.path must be project-relative/);

  const outsideDir = mkdtempSync(join(tmpdir(), "pi-hive-outside-agent-"));
  const outsidePrompt = join(outsideDir, "external.md");
  writeFileSync(outsidePrompt, "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: coder\n---\nExternal.");
  const opted = fixtureProject();
  const optedFile = join(opted, ".pi", "hive", "hive-config.yaml");
  writeFileSync(optedFile, readFileSync(optedFile, "utf8").replace(
    "      path: .pi/hive/agents/frontend.md",
    `      path: ${outsidePrompt}\n      allow-outside-project: true`,
  ));
  assert.equal(loadConfig(opted).agents[0].path, outsidePrompt);
});

test("context, skill, and domain paths require explicit outside-project opt-in", () => {
  for (const block of [
    "      context:\n        - path: ../outside-context.md",
    "      skills:\n        - path: ../outside-skill.md",
  ]) {
    const cwd = fixtureProject();
    const file = join(cwd, ".pi", "hive", "hive-config.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("      routing-tags: [frontend, react]", `      routing-tags: [frontend, react]\n${block}`));
    assert.throws(() => loadConfig(cwd), /must stay inside the project; outside paths require allow-outside-project: true/, block);
  }
  const domain = fixtureProject();
  const domainFile = join(domain, ".pi", "hive", "hive-config.yaml");
  writeFileSync(domainFile, readFileSync(domainFile, "utf8").replace("        - path: ui", "        - path: ../outside-domain"));
  assert.throws(() => loadConfig(domain), /hive\.agents\[0\]\.domain\[0\]\.path must stay inside the project/);
});

test("loadConfig enforces global duplicate slugs, tree depth, config size, refs, and injected bytes", () => {
  const duplicate = fixtureProject();
  const duplicateFile = join(duplicate, ".pi", "hive", "hive-config.yaml");
  writeFileSync(duplicateFile, readFileSync(duplicateFile, "utf8").replace(
    "  agents: []",
    "  agents:\n    - name: Frontend Dev\n      path: .pi/hive/agents/frontend.md",
  ));
  assert.throws(() => loadConfig(duplicate), /Duplicate agent slug "frontend-dev".*hive\.agents\[0\].*planning\.agents\[0\]/);

  const deep = fixtureProject();
  const deepFile = join(deep, ".pi", "hive", "hive-config.yaml");
  const deepMember = (level: number, indent: number): string => {
    const pad = " ".repeat(indent);
    const fields = `${pad}- name: Deep ${level}\n${pad}  path: .pi/hive/agents/frontend.md`;
    return level >= 8 ? fields : `${fields}\n${pad}  members:\n${deepMember(level + 1, indent + 4)}`;
  };
  writeFileSync(deepFile, readFileSync(deepFile, "utf8").replace("      members:\n        - name: QA Engineer\n          path: .pi/hive/agents/qa.md\n          routing-tags: [test]", `      members:\n${deepMember(0, 8)}`));
  assert.throws(() => loadConfig(deep), /maximum agent tree depth/);

  const huge = fixtureProject();
  const hugeFile = join(huge, ".pi", "hive", "hive-config.yaml");
  writeFileSync(hugeFile, `${readFileSync(hugeFile, "utf8")}\n# ${"x".repeat(512 * 1024)}\n`);
  assert.throws(() => loadConfig(huge), /exceeds the 524288-byte size limit/);

  const tooManyRefs = fixtureProject();
  const refsFile = join(tooManyRefs, ".pi", "hive", "hive-config.yaml");
  const refs = Array.from({ length: 257 }, (_, index) => `        - path: missing-${index}.md`).join("\n");
  writeFileSync(refsFile, readFileSync(refsFile, "utf8").replace("      routing-tags: [frontend, react]", `      routing-tags: [frontend, react]\n      context:\n${refs}`));
  assert.throws(() => loadConfig(tooManyRefs), /context\/skill refs exceed the limit of 256/);

  const tooManyAgents = fixtureProject();
  const agentsFile = join(tooManyAgents, ".pi", "hive", "hive-config.yaml");
  const agents = Array.from({ length: 129 }, (_, index) => `    - name: Agent ${index}\n      path: .pi/hive/agents/frontend.md`).join("\n");
  writeFileSync(agentsFile, readFileSync(agentsFile, "utf8").replace("  agents: []", `  agents:\n${agents}`));
  assert.throws(() => loadConfig(tooManyAgents), /Configured agents exceed the limit of 128/);

  const context = fixtureProject();
  const largeContext = join(context, "large-context.md");
  writeFileSync(largeContext, "x".repeat(2 * 1024 * 1024 + 1));
  const contextFile = join(context, ".pi", "hive", "hive-config.yaml");
  writeFileSync(contextFile, readFileSync(contextFile, "utf8").replace("      routing-tags: [frontend, react]", "      routing-tags: [frontend, react]\n      context:\n        - path: large-context.md"));
  assert.throws(() => loadConfig(context), /Configured prompt\/context content .* limit is 2097152 bytes/);
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
