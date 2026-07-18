import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildHiveTools, registerTools } from "../../src/agents/tools.ts";

function runtime(dir: string, name: string, overrides: Record<string, any> = {}): any {
  return {
    config: {
      name, slug: name.toLowerCase(), path: `${name}.md`, role: "member", agentType: "coder",
      groupName: "Engineering", routingTags: [], domain: [], allowedAgents: [], ...overrides.config,
    },
    systemPrompt: "", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    costUsd: 0, contextPct: 0, runCount: 0, sessionFile: join(dir, `${name}.jsonl`),
    ...overrides,
  };
}

function toolState(dir: string): any {
  const rows = [
    runtime(dir, "Tiny", { contextPct: Number.NaN, contextWindow: Number.NaN, inputTokens: 20, outputTokens: 5 }),
    runtime(dir, "Warm", { contextPct: 76, contextWindow: 8_000, inputTokens: 1_000, outputTokens: 1_000 }),
    runtime(dir, "Full", { contextPct: 86, contextTokens: 5_000_000, contextWindow: 20_000_000, inputTokens: 20_000, outputTokens: 40_000, task: "working" }),
  ];
  return {
    pi: {}, mode: "hive", activeRuns: 2, workerQueue: [{}, {}], activeChangeId: undefined,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md", role: "orchestrator", allowedAgents: rows.map((r) => r.config.slug) },
      agents: rows.map((r) => r.config), sharedContext: [],
      settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 3, distiller: { enabled: false, model: "", conversationLines: 10 } },
    },
    session: { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "conversation.jsonl"), observabilityLog: join(dir, "events.jsonl") },
    runtimes: new Map(rows.map((row) => [row.config.slug, row])),
    latestVerdicts: new Map([
      ["red", { changeId: "red", reviewer: "R", verdict: "red", blockers: ["b"], concerns: [], summary: "blocked" }],
      ["yellow", { changeId: "yellow", reviewer: "R", verdict: "yellow", blockers: [], concerns: ["c"], summary: "concern" }],
      ["green", { changeId: "green", reviewer: "R", verdict: "green", blockers: [], concerns: [], summary: "clean" }],
    ]),
  };
}

const theme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
};

test("team status formats sparse context, budgets, queues, and verdict variants", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-tools-status-"));
  const state = toolState(dir);
  const tools = buildHiveTools(state, "Orchestrator") as any[];
  const status = tools.find((tool) => tool.name === "team_status");
  const result = await status.execute("id", {});
  const text = result.content[0].text;
  assert.match(text, /active_runs: 2/);
  assert.match(text, /queued_runs: 2/);
  assert.match(text, /resume-ok/);
  assert.match(text, /consider-fresh/);
  assert.match(text, /fresh-recommended/);
  assert.match(text, /1 blocker/);
  assert.match(text, /1 concern/);
  assert.equal(result.details.agents.length, 3);

  state.session = undefined;
  state.workerQueue = undefined;
  state.latestVerdicts = new Map();
  const empty = await status.execute("id", {});
  assert.match(empty.content[0].text, /session: not initialized/);
  assert.match(empty.content[0].text, /queued_runs: 0/);
});

test("team conversation rejects unsafe scopes and bounds known transcripts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-tools-conversation-"));
  const state = toolState(dir);
  const tool = (buildHiveTools(state, "Orchestrator") as any[]).find((entry) => entry.name === "team_conversation");

  const session = state.session;
  state.session = undefined;
  assert.match((await tool.execute("id", { agent: "Tiny" })).content[0].text, /not initialized/);
  state.session = session;
  assert.equal((await tool.execute("id", { lines: Number.NaN })).details.ok, false);
  assert.match((await tool.execute("id", { agent: "missing", lines: -1 })).content[0].text, /Unknown agent/);
  assert.match((await tool.execute("id", { agent: "Tiny", lines: 5 })).content[0].text, /no session transcript/);

  const tiny = state.runtimes.get("tiny");
  writeFileSync(tiny.sessionFile, Array.from({ length: 20 }, (_, i) => JSON.stringify({ i })).join("\n"));
  const result = await tool.execute("id", { agent: "tiny", lines: 50_000 });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.lines, 1_000);
  assert.ok(result.content[0].text.length <= 100);
});

test("tool renderers remain bounded for partial, expanded, success, and error states", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-tools-render-"));
  const state = toolState(dir);
  const delegate = (buildHiveTools(state, "Orchestrator") as any[]).find((tool) => tool.name === "delegate_agent");

  assert.deepEqual(delegate.renderCall({}, theme).render(1), []);
  assert.equal(delegate.renderCall({ agent: "Tiny", task: "inspect" }, theme).render(80).length, 1);
  assert.deepEqual(delegate.renderResult({ details: { status: "running" } }, { isPartial: true }, theme).render(80), []);
  assert.equal(delegate.renderResult({ details: { agent: "Tiny", status: "done", elapsed: 1_500, outputPreview: "ok" } }, { expanded: true }, theme).render(80).length, 2);
  assert.equal(delegate.renderResult({ details: { agent: "missing", status: "error" } }, {}, theme).render(80).length, 1);
});

test("routing handles empty matches and registerTools exposes every base tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-tools-route-"));
  const state = toolState(dir);
  const route = (buildHiveTools(state, "Orchestrator") as any[]).find((tool) => tool.name === "route_agent");
  const noMatch = await route.execute("id", { task: "zz", limit: Number.POSITIVE_INFINITY });
  assert.match(noMatch.content[0].text, /No strong route found/);
  const match = await route.execute("id", { task: "implement engineering code", limit: 2.9 });
  assert.ok(match.details.recommendations.length > 0);
  assert.ok(match.details.recommendations.length <= 2);

  const registered: string[] = [];
  registerTools({ registerTool(tool: any) { registered.push(tool.name); } } as any, state);
  assert.ok(registered.includes("delegate_agent"));
  assert.ok(registered.includes("plan_new"));
});
