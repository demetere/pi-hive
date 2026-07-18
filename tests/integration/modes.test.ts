import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalMode } from "../../src/core/types.ts";
import { loadConfig, teamForMode, allConfiguredAgents } from "../../src/core/config.ts";
import { auditAgentTypes } from "../../src/core/agent-type-audit.ts";
import { applyMode, nextMode, modeLabel, modeStatusText } from "../../src/ui/tui/widget.ts";

// ── canonicalMode + cycle ────────────────────────────────────────────────────

test("canonicalMode maps known modes and coerces unknown to 'normal'", () => {
  assert.equal(canonicalMode("plan"), "plan");
  assert.equal(canonicalMode("hive"), "hive");
  assert.equal(canonicalMode("normal"), "normal");
  assert.equal(canonicalMode(undefined), "normal");
  assert.equal(canonicalMode("garbage"), "normal");
});

test("nextMode cycles normal → plan → hive → normal", () => {
  assert.equal(nextMode("normal"), "plan");
  assert.equal(nextMode("plan"), "hive");
  assert.equal(nextMode("hive"), "normal");
});

test("mode labels and statuses use the hive namespace", () => {
  assert.equal(modeLabel("normal"), "NORMAL");
  assert.equal(modeLabel("plan"), "PLAN");
  assert.equal(modeLabel("hive"), "HIVE");
  const state = { mode: "normal", runtimes: new Map([["one", {}]]) } as any;
  assert.equal(modeStatusText(state, "normal"), "hive: NORMAL");
  assert.equal(modeStatusText(state, "plan"), "hive: PLAN (1)");
  assert.equal(modeStatusText(state, "hive"), "hive: HIVE (1)");
});

test("applyMode blocks switching to normal while a worker run is reserved", () => {
  const notifications: string[] = [];
  const state = { mode: "hive", activeRuns: 1, config: {}, runtimes: new Map() } as any;
  const ctx = { hasUI: true, ui: { notify: (message: string) => notifications.push(message) } } as any;

  assert.equal(applyMode(state, ctx, "normal"), false);
  assert.equal(state.mode, "hive");
  assert.match(notifications[0], /Cannot switch mode while 1 agent is running/);
});

// ── config: planning + hive blocks ──────────────────────────────────────────

function twoBlockProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-modes-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  const md = (type: string) => `---\nmodel: openai/gpt-5\nthinking: off\nagent-type: ${type}\n---\nWork.`;
  writeFileSync(join(cwd, ".pi", "hive", "agents", "plan-main.md"), md("planner"));
  writeFileSync(join(cwd, ".pi", "hive", "agents", "reqs.md"), md("planner"));
  writeFileSync(join(cwd, ".pi", "hive", "agents", "hive-main.md"), md("lead"));
  writeFileSync(join(cwd, ".pi", "hive", "agents", "coder.md"), md("coder"));
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
settings:
  distiller:
    enabled: false
planning:
  main:
    name: Plan Main
    path: .pi/hive/agents/plan-main.md
  agents:
    - name: Requirements Planner
      path: .pi/hive/agents/reqs.md
hive:
  main:
    name: Hive Main
    path: .pi/hive/agents/hive-main.md
  agents:
    - name: Coder
      path: .pi/hive/agents/coder.md
`);
  return cwd;
}

test("loadConfig parses planning + hive blocks; active team defaults to hive", () => {
  const config = loadConfig(twoBlockProject());
  assert.ok(config.planning, "planning team is populated");
  // Active mirror defaults to the hive team.
  assert.equal(config.orchestrator.name, "Hive Main");
  assert.deepEqual(config.agents.map((a) => a.name), ["Coder"]);
  // Raw blocks are populated.
  assert.equal(config.hive?.main.name, "Hive Main");
  assert.equal(config.planning?.main.name, "Plan Main");
});

test("teamForMode selects planning in plan mode and hive otherwise", () => {
  const config = loadConfig(twoBlockProject());
  assert.equal(teamForMode(config, "plan").main.name, "Plan Main");
  assert.equal(teamForMode(config, "hive").main.name, "Hive Main");
  assert.equal(teamForMode(config, "normal").main.name, "Hive Main");
});

test("plan team flattens to main + planner reports", () => {
  const config = loadConfig(twoBlockProject());
  const planAgents = allConfiguredAgents(teamForMode(config, "plan"));
  const names = planAgents.map((a) => a.name);
  assert.deepEqual(names, ["Plan Main", "Requirements Planner"]);
  assert.equal(planAgents.find((a) => a.name === "Requirements Planner")?.agentType, "planner");
  // The Coder (hive team) is NOT in the planning team.
  assert.ok(!names.includes("Coder"));
});

// ── required split: planning + hive blocks ─────────────────────────────────

function legacyProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-legacy-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "agents", "orch.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: lead\n---\nLead.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "dev.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: coder\n---\nCode.");
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
settings:
  distiller:
    enabled: false
orchestrator:
  name: Orchestrator
  path: .pi/hive/agents/orch.md
agents:
  - name: Dev
    path: .pi/hive/agents/dev.md
`);
  return cwd;
}

test("legacy top-level orchestrator:/agents: is rejected; split teams are required", () => {
  assert.throws(() => loadConfig(legacyProject()), /planning.*team block/i);
});

test("auditAgentTypes walks both planning and hive blocks", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-audit2-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  // Hive Main typed; a planner in the planning block is UNTYPED (offender).
  writeFileSync(join(cwd, ".pi", "hive", "agents", "hive-main.md"), "---\nagent-type: lead\n---\nLead.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "reqs.md"), "---\nmodel: openai/gpt-5\n---\nPlan."); // no agent-type
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
planning:
  main:
    name: Plan Main
    path: .pi/hive/agents/hive-main.md
  agents:
    - name: Requirements Planner
      path: .pi/hive/agents/reqs.md
hive:
  main:
    name: Hive Main
    path: .pi/hive/agents/hive-main.md
  agents: []
`);
  const audit = auditAgentTypes(cwd);
  const reqs = audit.rows.find((r) => r.name === "Requirements Planner");
  assert.ok(reqs, "planning-block agent should be audited");
  assert.equal(reqs?.valid, false);
  assert.equal(reqs?.suggestion, "planner");
  assert.equal(audit.offenders.length, 1);
});
