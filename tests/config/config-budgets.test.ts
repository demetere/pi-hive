import assert from "node:assert/strict";
import { test } from "node:test";
import { PACKAGE_BUDGET_CAPS, parseDurationV1, resolveBudgetDeclarations, validateBudgetDeclarations } from "../../src/config/budgets.ts";

test("duration v1 parsing is exact and overflow safe", () => {
  assert.equal(parseDurationV1("1ms"), 1);
  assert.equal(parseDurationV1("20s"), 20_000);
  assert.equal(parseDurationV1("3m"), 180_000);
  assert.equal(parseDurationV1("4h"), 14_400_000);
  for (const value of ["0s", "01s", "1.5h", "1d", "999999999999999999999h"]) assert.equal(parseDurationV1(value), undefined);
});

test("budget declarations reject overflow and package-cap widening at exact N/N+1", () => {
  assert.deepEqual(validateBudgetDeclarations({ "max-parallel": PACKAGE_BUDGET_CAPS["max-parallel"], "active-wall-time": "24h" }), []);
  assert.deepEqual(validateBudgetDeclarations({ "max-parallel": PACKAGE_BUDGET_CAPS["max-parallel"] + 1 }), ["max-parallel"]);
  assert.deepEqual(validateBudgetDeclarations({ "active-wall-time": "999999999999999999999h" }), ["active-wall-time"]);
});

test("budget declarations retain ordered provenance and strict minima by scope", () => {
  const result = resolveBudgetDeclarations({
    project: { "max-parallel": 8, "max-agent-turns": 100, "max-tool-calls": 500, "active-wall-time": "2h" },
    workflow: { "max-parallel": 4, "max-agent-turns": 80, "max-tool-calls": 400 },
    agent: { "max-agent-turns": 60, "max-tool-calls": 300 },
    node: { "max-agent-turns": 40, "max-tool-calls": 200, "active-wall-time": "1h" },
  });
  assert.equal(result.run["max-parallel"].effective, 4);
  assert.equal(result.run["max-tool-calls"].effective, 400);
  assert.equal(result.node["max-agent-turns"].effective, 40);
  assert.equal(result.node["max-tool-calls"].effective, 200);
  assert.equal(result.node["active-wall-time"].effective, 3_600_000);
  assert.deepEqual(result.node["max-agent-turns"].candidates.map((x) => x.source), ["package", "project", "workflow", "agent", "node"]);
  assert.deepEqual(result.node["active-wall-time"].candidates.map((x) => [x.source, x.declared]), [["package", undefined], ["project", "2h"], ["node", "1h"]]);
  assert.equal(PACKAGE_BUDGET_CAPS["max-parallel"], 32);
});
