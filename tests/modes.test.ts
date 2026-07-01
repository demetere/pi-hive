import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalMode } from "../src/core/types.ts";
import { loadConfig, teamForMode, hasPlanningTeam, allConfiguredAgents } from "../src/core/config.ts";
import { auditAgentTypes } from "../src/core/agent-type-audit.ts";
import { nextMode, modeLabel } from "../src/ui/tui/widget.ts";

// ── canonicalMode + cycle ────────────────────────────────────────────────────

test("canonicalMode maps legacy 'team' to 'hive' and unknown to 'normal'", () => {
  assert.equal(canonicalMode("plan"), "plan");
  assert.equal(canonicalMode("hive"), "hive");
  assert.equal(canonicalMode("team"), "hive"); // legacy alias
  assert.equal(canonicalMode("normal"), "normal");
  assert.equal(canonicalMode(undefined), "normal");
  assert.equal(canonicalMode("garbage"), "normal");
});

test("nextMode cycles normal → plan → hive → normal", () => {
  assert.equal(nextMode("normal"), "plan");
  assert.equal(nextMode("plan"), "hive");
  assert.equal(nextMode("hive"), "normal");
});

test("modeLabel renders uppercase labels", () => {
  assert.equal(modeLabel("normal"), "NORMAL");
  assert.equal(modeLabel("plan"), "PLAN");
  assert.equal(modeLabel("hive"), "HIVE");
});

// ── config: planning + hive blocks ──────────────────────────────────────────

function twoBlockProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-modes-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  const md = (type: string) => `---\nmodel: openai/gpt-5\nthinking: off\nagent-type: ${type}\n---\nWork.`;
  writeFileSync(join(cwd, ".pi", "hive", "agents", "plan-main.md"), md("lead"));
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
  assert.equal(hasPlanningTeam(config), true);
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

// ── back-compat: legacy top-level orchestrator/agents ───────────────────────

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

test("legacy orchestrator:/agents: still loads as the hive team; no planning team", () => {
  const config = loadConfig(legacyProject());
  assert.equal(config.orchestrator.name, "Orchestrator");
  assert.equal(hasPlanningTeam(config), false);
  // plan mode falls back to the hive team when no planning: block exists.
  assert.equal(teamForMode(config, "plan").main.name, "Orchestrator");
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
