import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfigCatalogs, loadConfigProject, resolveTeam, sourceRange, WORKFLOW_LIMITS, type RawTeamNodeV1 } from "../../src/config/index.ts";
import { copyWorkflowFixture } from "../helpers/workflow-fixtures.ts";

function context() {
  const fixture = copyWorkflowFixture("artifact-free-debug");
  const project = loadConfigProject(fixture.projectRoot); assert.equal(project.status, "configured");
  return { fixture, project, catalogs: loadConfigCatalogs(project) };
}
function chain(depth: number): RawTeamNodeV1 {
  let node: RawTeamNodeV1 = { id: `n-${depth}`, agent: "debugger" };
  for (let index = depth - 1; index >= 1; index--) node = { id: `n-${index}`, agent: "debugger", members: [node] };
  return node;
}

test("team depth limit accepts N and rejects N+1", () => {
  const { fixture, catalogs } = context();
  try {
    assert.equal(resolveTeam(chain(WORKFLOW_LIMITS.teamDepth), {}, "workflow.yaml", "test", catalogs).diagnostics.length, 0);
    assert.ok(resolveTeam(chain(WORKFLOW_LIMITS.teamDepth + 1), {}, "workflow.yaml", "test", catalogs).diagnostics.some((x) => x.code === "TEAM_DEPTH_EXCEEDED"));
  } finally { fixture.cleanup(); }
});

test("team metadata limits use exact item ranges", () => {
  const { fixture, catalogs } = context();
  const roleRange = sourceRange(10, 2, 3, 20, 2, 13);
  const consultRange = sourceRange(21, 3, 3, 31, 3, 13);
  const responsibilityRange = sourceRange(32, 4, 5, 42, 4, 15);
  try {
    const exact: RawTeamNodeV1 = {
      id: "root", agent: "debugger", role: "x".repeat(WORKFLOW_LIMITS.roleBytes),
      "consult-when": "x".repeat(WORKFLOW_LIMITS.consultWhenBytes),
      responsibilities: Array.from({ length: WORKFLOW_LIMITS.responsibilities }, () => "x".repeat(WORKFLOW_LIMITS.responsibilityBytes)),
    };
    assert.equal(resolveTeam(exact, {}, "workflow.yaml", "test", catalogs).diagnostics.length, 0);
    const raw: RawTeamNodeV1 = {
      id: "root", agent: "debugger", role: "x".repeat(WORKFLOW_LIMITS.roleBytes + 1),
      "consult-when": "x".repeat(WORKFLOW_LIMITS.consultWhenBytes + 1),
      responsibilities: ["x".repeat(WORKFLOW_LIMITS.responsibilityBytes + 1)],
    };
    const result = resolveTeam(raw, {
      "/team/role": { value: roleRange },
      "/team/consult-when": { value: consultRange },
      "/team/responsibilities/0": { value: responsibilityRange },
    }, "workflow.yaml", "test", catalogs);
    assert.deepEqual(result.diagnostics.filter((x) => x.code === "TEAM_METADATA_LIMIT_EXCEEDED").map((x) => x.range), [roleRange, consultRange, responsibilityRange]);
    const tooMany = { id: "root", agent: "debugger", responsibilities: Array.from({ length: WORKFLOW_LIMITS.responsibilities + 1 }, () => "x") } as RawTeamNodeV1;
    assert.ok(resolveTeam(tooMany, { "/team/responsibilities": { value: responsibilityRange } }, "workflow.yaml", "test", catalogs).diagnostics.some((x) => x.code === "TEAM_METADATA_LIMIT_EXCEEDED" && x.range.start.offset === responsibilityRange.start.offset));
  } finally { fixture.cleanup(); }
});

test("active-wall-time widening is compared after duration parsing with narrow range", () => {
  const { fixture, catalogs } = context();
  const budgetRange = sourceRange(50, 5, 7, 53, 5, 10);
  try {
    const available = catalogs.agents.find((x) => x.id === "debugger"); assert.equal(available?.status, "available");
    if (available?.status === "available") available.frontmatter.budgets = { "active-wall-time": "1h" };
    const raw = { id: "root", agent: "debugger", overrides: { budgets: { "active-wall-time": "2h" } } } as RawTeamNodeV1;
    const result = resolveTeam(raw, { "/team/overrides/budgets/active-wall-time": { value: budgetRange } }, "workflow.yaml", "test", catalogs);
    const diagnostic = result.diagnostics.find((x) => x.code === "WORKFLOW_BUDGET_WIDENING");
    assert.deepEqual(diagnostic?.range, budgetRange);
  } finally { fixture.cleanup(); }
});

test("team count limit and repeated object identity fail closed while repeated agents remain valid", () => {
  const { fixture, catalogs } = context();
  try {
    const valid: RawTeamNodeV1 = { id: "root", agent: "debugger", members: Array.from({ length: WORKFLOW_LIMITS.teamNodes - 1 }, (_, i) => ({ id: `node-${i}`, agent: "debugger" })) };
    assert.equal(resolveTeam(valid, {}, "workflow.yaml", "test", catalogs).diagnostics.length, 0);
    valid.members!.push({ id: "overflow", agent: "debugger" });
    assert.ok(resolveTeam(valid, {}, "workflow.yaml", "test", catalogs).diagnostics.some((x) => x.code === "TEAM_NODE_LIMIT_EXCEEDED"));
    const shared: RawTeamNodeV1 = { id: "shared", agent: "debugger" };
    const reused = { id: "root", agent: "debugger", members: [shared, shared] } as RawTeamNodeV1;
    assert.ok(resolveTeam(reused, {}, "workflow.yaml", "test", catalogs).diagnostics.some((x) => x.code === "TEAM_OBJECT_REUSED"));
    const bypass = { id: "root", agent: "debugger", members: Array.from({ length: WORKFLOW_LIMITS.teamNodes }, () => shared) } as RawTeamNodeV1;
    assert.ok(resolveTeam(bypass, {}, "workflow.yaml", "test", catalogs).diagnostics.some((x) => x.code === "TEAM_NODE_LIMIT_EXCEEDED"));
  } finally { fixture.cleanup(); }
});
