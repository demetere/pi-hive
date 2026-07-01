import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../src/engine/file-class.ts";
import { checkPlannerStages, checkTypePolicy } from "../src/engine/policy.ts";
import { enforceDomainForTool, isCommitCommand } from "../src/engine/domain.ts";
import { runAsAgent } from "../src/engine/session.ts";
import { buildOperatingContract } from "../src/engine/prompts.ts";
import type { AgentRuntime, AgentType, HiveState, PlanStage } from "../src/core/types.ts";

function runtime(name: string, extra: Partial<AgentRuntime["config"]> = {}): AgentRuntime {
  return {
    config: { name, path: `${name}.md`, role: "member", routingTags: [], domain: [], ...extra },
    systemPrompt: "", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, costUsd: 0, contextPct: 0, runCount: 0, sessionFile: "",
  };
}

function stateWith(runtimes: AgentRuntime[]): HiveState {
  return {
    pi: {} as any, config: null, session: null,
    runtimes: new Map(runtimes.map((entry) => [entry.config.name.toLowerCase(), entry])),
    widgetCtx: null, activeRuns: 0, mode: "hive", normalToolNames: [],
    streamStartMs: 0, streamedChars: 0, lastTokPerSec: 0, sddStatus: null, obsSeq: 0,
  };
}

// ── File classifier ────────────────────────────────────────────────────────

test("classify resolves language-agnostic classes with tasks before spec/docs", () => {
  assert.equal(classify(".pi/hive/plans/add-auth/tasks.md"), "tasks"); // tasks beats spec
  assert.equal(classify("docs/tasks.md"), "tasks");                    // tasks beats docs
  assert.equal(classify(".pi/hive/plans/add-auth/proposal.md"), "spec");
  assert.equal(classify(".pi/hive/plans/add-auth/design.md"), "spec");
  assert.equal(classify("openspec/changes/x/proposal.md"), "spec");
  assert.equal(classify("docs/architecture.md"), "docs");
  assert.equal(classify("README.md"), "docs");
  assert.equal(classify("src/index.ts"), "code");
  assert.equal(classify("backend/patient/search_test.go"), "code"); // test split is NOT in the classifier
  assert.equal(classify("Cargo.toml"), "code");
  assert.equal(classify("package.json"), "code");
});

// ── Type-policy matrix ─────────────────────────────────────────────────────

test("checkTypePolicy: every type may read any class", () => {
  const types: AgentType[] = ["planner", "coder", "tester", "reviewer", "lead"];
  for (const type of types) {
    assert.equal(checkTypePolicy(type, "code", "read").ok, true);
    assert.equal(checkTypePolicy(type, "spec", "read").ok, true);
  }
});

test("checkTypePolicy: planner may write spec/docs/tasks, not code", () => {
  assert.equal(checkTypePolicy("planner", "spec", "upsert").ok, true);
  assert.equal(checkTypePolicy("planner", "docs", "upsert").ok, true);
  assert.equal(checkTypePolicy("planner", "tasks", "upsert").ok, true);
  assert.equal(checkTypePolicy("planner", "code", "upsert").ok, false);
  assert.equal(checkTypePolicy("planner", "code", "delete").ok, false);
});

test("checkTypePolicy: coder may write code/docs/tasks, not spec", () => {
  assert.equal(checkTypePolicy("coder", "code", "upsert").ok, true);
  assert.equal(checkTypePolicy("coder", "docs", "upsert").ok, true);
  assert.equal(checkTypePolicy("coder", "tasks", "upsert").ok, true);
  assert.equal(checkTypePolicy("coder", "spec", "upsert").ok, false);
});

test("checkTypePolicy: tester is treated like coder for classes (split is via domain)", () => {
  assert.equal(checkTypePolicy("tester", "code", "upsert").ok, true);
  assert.equal(checkTypePolicy("tester", "spec", "upsert").ok, false);
});

test("checkTypePolicy: reviewer and lead may not mutate any class", () => {
  for (const cls of ["code", "spec", "docs", "tasks"] as const) {
    assert.equal(checkTypePolicy("reviewer", cls, "upsert").ok, false);
    assert.equal(checkTypePolicy("lead", cls, "upsert").ok, false);
  }
});

test("checkTypePolicy: only reviewers may submit verdicts", () => {
  assert.equal(checkTypePolicy("reviewer", null, "verdict").ok, true);
  assert.equal(checkTypePolicy("coder", null, "verdict").ok, false);
  assert.equal(checkTypePolicy("lead", null, "verdict").ok, false);
});

test("checkTypePolicy: command (non-mutating bash) allowed for all types", () => {
  for (const type of ["planner", "coder", "tester", "reviewer", "lead"] as AgentType[]) {
    assert.equal(checkTypePolicy(type, null, "command").ok, true);
  }
});

// ── Planner stage scoping ──────────────────────────────────────────────────

test("checkPlannerStages: omitted stages allow all gates", () => {
  assert.equal(checkPlannerStages(undefined, ".pi/hive/plans/x/proposal.md").ok, true);
  assert.equal(checkPlannerStages(undefined, ".pi/hive/plans/x/tasks.md").ok, true);
});

test("checkPlannerStages: a scoped planner writes only its gates", () => {
  const stages: PlanStage[] = ["design"];
  assert.equal(checkPlannerStages(stages, ".pi/hive/plans/x/design.md").ok, true);
  assert.equal(checkPlannerStages(stages, ".pi/hive/plans/x/proposal.md").ok, false);
  assert.equal(checkPlannerStages(stages, ".pi/hive/plans/x/tasks.md").ok, false);
  // Non-gate spec files are allowed for any planner.
  assert.equal(checkPlannerStages(stages, ".pi/hive/plans/x/specs/api.md").ok, true);
});

// ── Commit detection ───────────────────────────────────────────────────────

test("isCommitCommand blocks publish/history creation, allows local ops", () => {
  assert.equal(isCommitCommand("git commit -m 'x'"), true);
  assert.equal(isCommitCommand("git commit --amend"), true);
  assert.equal(isCommitCommand("git push origin main"), true);
  assert.equal(isCommitCommand("git tag v1.0"), true);
  assert.equal(isCommitCommand("gh pr merge 12"), true);
  assert.equal(isCommitCommand("gh release create v1"), true);
  assert.equal(isCommitCommand("npm publish"), true);
  assert.equal(isCommitCommand("pnpm publish"), true);
  assert.equal(isCommitCommand("just release"), true);
  assert.equal(isCommitCommand("cd repo && git commit -am wip"), true);
  assert.equal(isCommitCommand("gc"), true);
  // Local working-tree ops stay allowed.
  assert.equal(isCommitCommand("git merge feature"), false);
  assert.equal(isCommitCommand("git rebase main"), false);
  assert.equal(isCommitCommand("git cherry-pick abc"), false);
  assert.equal(isCommitCommand("git add ."), false);
  assert.equal(isCommitCommand("git status"), false);
  assert.equal(isCommitCommand("git diff"), false);
  // Not commit: word-boundary aware.
  assert.equal(isCommitCommand("git commit-graph write"), false);
  assert.equal(isCommitCommand("cat src/commit-helper.ts"), false);
});

// ── Both layers via enforceDomainForTool ───────────────────────────────────

const ctx = { cwd: "/repo" } as any;
const codeDomain = [{ path: ".", read: true, upsert: true, delete: true }];

function block(state: HiveState, agent: string, event: any): string | undefined {
  return runAsAgent(agent, () => enforceDomainForTool(state, event, ctx)?.reason);
}

test("enforce: reviewer upsert blocked by type even when in-domain", () => {
  const state = stateWith([runtime("Rev", { agentType: "reviewer", domain: codeDomain })]);
  const reason = block(state, "Rev", { toolName: "write", input: { path: "src/x.ts" } });
  assert.match(reason ?? "", /may not upsert files/);
  assert.match(reason ?? "", /read-only/);
});

test("enforce: planner blocked from code, allowed spec", () => {
  const specDomain = [{ path: ".", read: true, upsert: true, delete: false }];
  const state = stateWith([runtime("Plan", { agentType: "planner", domain: specDomain })]);
  assert.match(block(state, "Plan", { toolName: "write", input: { path: "src/x.ts" } }) ?? "", /may not upsert code files/);
  assert.equal(block(state, "Plan", { toolName: "write", input: { path: ".pi/hive/plans/a/proposal.md" } }), undefined);
});

test("enforce: planner stages narrow which gate files", () => {
  const specDomain = [{ path: ".", read: true, upsert: true, delete: false }];
  const state = stateWith([runtime("Plan", { agentType: "planner", stages: ["design"], domain: specDomain })]);
  assert.equal(block(state, "Plan", { toolName: "write", input: { path: ".pi/hive/plans/a/design.md" } }), undefined);
  assert.match(block(state, "Plan", { toolName: "write", input: { path: ".pi/hive/plans/a/proposal.md" } }) ?? "", /may not write the "proposal" gate/);
});

test("enforce: coder code allowed, spec blocked", () => {
  const state = stateWith([runtime("Dev", { agentType: "coder", domain: codeDomain })]);
  assert.equal(block(state, "Dev", { toolName: "edit", input: { path: "src/x.ts" } }), undefined);
  assert.match(block(state, "Dev", { toolName: "write", input: { path: ".pi/hive/plans/a/design.md" } }) ?? "", /may not upsert spec files/);
});

test("enforce: lead upsert blocked", () => {
  const state = stateWith([runtime("Lead", { agentType: "lead", domain: codeDomain })]);
  assert.match(block(state, "Lead", { toolName: "write", input: { path: "src/x.ts" } }) ?? "", /may not upsert/);
});

test("enforce: both layers must pass — in-domain but wrong type still blocked, wrong path but right type still blocked", () => {
  // coder with domain only over ui/: writing ui code passes both; writing src (out of domain) fails domain.
  const state = stateWith([runtime("Dev", { agentType: "coder", domain: [{ path: "ui", read: true, upsert: true, delete: false }] })]);
  assert.equal(block(state, "Dev", { toolName: "write", input: { path: "ui/App.tsx" } }), undefined);
  assert.match(block(state, "Dev", { toolName: "write", input: { path: "server/x.ts" } }) ?? "", /cannot modify/); // domain layer
});

test("enforce: commit gate blocks without commit field, allows with it", () => {
  const noCommit = stateWith([runtime("Lead", { agentType: "lead", domain: [{ path: ".", read: true, upsert: false, delete: false }] })]);
  assert.match(block(noCommit, "Lead", { toolName: "bash", input: { command: "git commit -m wip" } }) ?? "", /cannot run commit\/publish/);

  const withCommit = stateWith([runtime("Lead", { agentType: "lead", commit: "commit when green", domain: [{ path: ".", read: true, upsert: false, delete: false }] })]);
  assert.equal(block(withCommit, "Lead", { toolName: "bash", input: { command: "git commit -m wip" } }), undefined);
});

test("enforce: git merge allowed regardless of commit field", () => {
  const state = stateWith([runtime("Lead", { agentType: "lead", domain: [{ path: ".", read: true, upsert: false, delete: false }] })]);
  // git merge is non-mutating from a commit standpoint and reads only → allowed.
  assert.equal(block(state, "Lead", { toolName: "bash", input: { command: "git merge feature" } }), undefined);
});

test("enforce: reviewer may run non-mutating inspection bash but not mutating bash", () => {
  const state = stateWith([runtime("Rev", { agentType: "reviewer", domain: [{ path: ".", read: true, upsert: false, delete: false }] })]);
  assert.equal(block(state, "Rev", { toolName: "bash", input: { command: "grep -r foo ./src" } }), undefined);
  assert.match(block(state, "Rev", { toolName: "bash", input: { command: "touch src/x.ts" } }) ?? "", /may not upsert/);
});

test("enforce: untyped runtime skips type-policy (only domain applies)", () => {
  const state = stateWith([runtime("Legacy", { domain: codeDomain })]); // no agentType
  assert.equal(block(state, "Legacy", { toolName: "write", input: { path: "src/x.ts" } }), undefined);
});

// ── Operating contract prompt ──────────────────────────────────────────────

test("buildOperatingContract states the type's boundary", () => {
  assert.match(buildOperatingContract(runtime("P", { agentType: "planner" })), /planner/);
  assert.match(buildOperatingContract(runtime("P", { agentType: "planner", stages: ["proposal", "design"] })), /proposal, design/);
  assert.match(buildOperatingContract(runtime("R", { agentType: "reviewer" })), /submit_review_verdict/);
  assert.match(buildOperatingContract(runtime("L", { agentType: "lead", commit: "only when green" })), /Commit guidance: only when green/);
  assert.equal(buildOperatingContract(runtime("U")), ""); // no type → no block
});
