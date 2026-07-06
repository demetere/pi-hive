import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildHiveTools } from "../src/agents/tools.ts";
import { runWithChange } from "../src/engine/session.ts";
import type { AgentRuntime, HiveState } from "../src/core/types.ts";

function runtime(name: string, extra: Partial<AgentRuntime["config"]> = {}): AgentRuntime {
  return {
    config: { name, path: `${name}.md`, role: "member", routingTags: [], domain: [], ...extra },
    systemPrompt: "", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, contextPct: 0, runCount: 0, sessionFile: "",
  };
}

function stateWith(runtimes: AgentRuntime[]): HiveState {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-verdict-"));
  return {
    pi: {} as any, config: { orchestrator: { name: "Orchestrator", path: "o.md" }, agents: [], sharedContext: [], settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 1, distiller: { enabled: false, model: "", conversationLines: 10 } } },
    session: { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "c.jsonl"), observabilityLog: join(dir, "e.jsonl") },
    runtimes: new Map(runtimes.map((entry) => [entry.config.name.toLowerCase(), entry])),
    widgetCtx: null, activeRuns: 0, mode: "hive", normalToolNames: [],
    sddStatus: null, obsSeq: 0,
    latestVerdicts: new Map(),
  };
}

function toolNames(state: HiveState, caller: string): string[] {
  return buildHiveTools(state, caller).map((tool) => tool.name);
}

test("submit_review_verdict is present only for reviewers", () => {
  const state = stateWith([
    runtime("Rev", { agentType: "reviewer" }),
    runtime("Dev", { agentType: "coder" }),
    runtime("Lead", { agentType: "lead" }),
  ]);
  assert.ok(toolNames(state, "Rev").includes("submit_review_verdict"));
  assert.ok(!toolNames(state, "Dev").includes("submit_review_verdict"));
  assert.ok(!toolNames(state, "Lead").includes("submit_review_verdict"));
});

test("plan lifecycle tools are present only for leads", () => {
  const state = stateWith([
    runtime("Lead", { agentType: "lead" }),
    runtime("Rev", { agentType: "reviewer" }),
  ]);
  // plan_new/plan_select are lead-scoped. Approval is no longer a tool — it
  // happens in the dashboard's plan-review UI — so approve_plan must NOT exist.
  assert.ok(toolNames(state, "Lead").includes("plan_new"));
  assert.ok(toolNames(state, "Lead").includes("plan_select"));
  assert.ok(!toolNames(state, "Lead").includes("approve_plan"));
  assert.ok(!toolNames(state, "Rev").includes("plan_new"));
});

function verdictTool(state: HiveState, caller: string) {
  const tool = buildHiveTools(state, caller).find((t) => t.name === "submit_review_verdict");
  assert.ok(tool, "verdict tool should exist for a reviewer");
  return tool!;
}

test("submit_review_verdict caches the latest verdict per change and degrades without a change-id", async () => {
  const state = stateWith([runtime("Rev", { agentType: "reviewer" })]);
  const tool = verdictTool(state, "Rev");

  // With an active change-id (via AsyncLocalStorage), it caches under that id.
  await runWithChange("add-auth", () => (tool.execute as any)("id1", { verdict: "yellow", summary: "ok with notes", concerns: ["tighten error handling"] }));
  const cached = state.latestVerdicts?.get("add-auth");
  assert.equal(cached?.verdict, "yellow");
  assert.equal(cached?.reviewer, "Rev");
  assert.deepEqual(cached?.concerns, ["tighten error handling"]);

  // A later red verdict overwrites the latest for that change.
  await runWithChange("add-auth", () => (tool.execute as any)("id2", { verdict: "red", summary: "blocked", blockers: ["missing authz"] }));
  assert.equal(state.latestVerdicts?.get("add-auth")?.verdict, "red");

  // Without any change-id it does not throw and records nothing plan-scoped.
  const res = await (tool.execute as any)("id3", { verdict: "green", summary: "clean" });
  assert.match(res.content[0].text, /no active change-id/i);
  assert.equal(state.latestVerdicts?.size, 1); // still just add-auth
});

// Note: gate approval is no longer a chat tool. Approving an artifact happens in
// the dashboard's plan-review UI (POST /api/approve -> review-wiring), which
// records a verdict and writes pi-hive's execution-approval sidecar. That path
// is exercised through src/engine/review.ts + openspec.setExecutionApproval.

test("team_status surfaces the latest verdict", async () => {
  const state = stateWith([runtime("Rev", { agentType: "reviewer" })]);
  const verdict = verdictTool(state, "Rev");
  await runWithChange("add-auth", () => (verdict.execute as any)("id1", { verdict: "green", summary: "clean approval" }));

  const status = buildHiveTools(state, "Orchestrator").find((t) => t.name === "team_status")!;
  const res = await (status.execute as any)("id", {});
  assert.match(res.content[0].text, /latest verdicts:/);
  assert.match(res.content[0].text, /add-auth: GREEN by Rev/);
});

test("team_status surfaces context fill and fresh/resume advice", async () => {
  const builder = runtime("Builder", { agentType: "coder" });
  builder.contextPct = 86.25;
  builder.contextTokens = 172_500;
  builder.contextWindow = 200_000;
  const state = stateWith([builder]);

  const status = buildHiveTools(state, "Orchestrator").find((t) => t.name === "team_status")!;
  const res = await (status.execute as any)("id", {});

  assert.match(res.content[0].text, /ctx=86\.3% \(173k\/200k\) fresh-recommended/);
  assert.equal(res.details.agents[0].contextPct, 86.25);
  assert.equal(res.details.agents[0].contextTokens, 172_500);
  assert.equal(res.details.agents[0].contextWindow, 200_000);
  assert.equal(res.details.agents[0].contextAdvice, "fresh-recommended");
});
