import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildHiveTools } from "../src/agents/tools.ts";
import { enqueueQuestion, recordQuestion } from "../src/engine/questions.ts";
import { runWithChange } from "../src/engine/session.ts";
import type { AgentRuntime, HiveState } from "../src/core/types.ts";

function runtime(name: string, extra: Partial<AgentRuntime["config"]> = {}): AgentRuntime {
  return {
    config: { name, path: `${name}.md`, role: "member", routingTags: [], domain: [], ...extra },
    systemPrompt: "", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, contextPct: 0, runCount: 0, sessionFile: "",
  };
}

function stateWith(dir: string, runtimes: AgentRuntime[]): HiveState {
  return {
    pi: {} as any, config: { orchestrator: { name: "Orchestrator", path: "o.md" }, agents: [], sharedContext: [], settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 1, distiller: { enabled: false, model: "", conversationLines: 10 } } },
    session: { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "c.jsonl"), observabilityLog: join(dir, "e.jsonl") },
    runtimes: new Map(runtimes.map((r) => [r.config.name.toLowerCase(), r])),
    widgetCtx: null, activeRuns: 0, mode: "plan", normalToolNames: [],
    sddStatus: null, obsSeq: 0, latestVerdicts: new Map(),
  };
}

test("ask_user is a base tool available to planners/leads", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-q-"));
  const state = stateWith(dir, [runtime("Planner", { agentType: "planner" })]);
  assert.ok(buildHiveTools(state, "Planner").some((t) => t.name === "ask_user"));
});

test("recordQuestion writes a file-backed trail under the change", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-q-cwd-"));
  recordQuestion(cwd, "add-auth", "Which auth provider?", "OIDC via Auth0");
  const file = join(cwd, "openspec", "changes", "add-auth", "questions.md");
  assert.ok(existsSync(file));
  const body = readFileSync(file, "utf8");
  assert.match(body, /Which auth provider\?/);
  assert.match(body, /OIDC via Auth0/);
  // Unsafe change ids are ignored (no traversal).
  recordQuestion(cwd, "../evil", "x");
  assert.ok(!existsSync(join(cwd, "..", "evil", "questions.md")));
});

test("enqueueQuestion appends a question action to dashboard-actions.jsonl", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-q-enq-"));
  assert.ok(enqueueQuestion(dir, { question: "Scope?", change: "add-auth", askedBy: "Planner" }));
  const body = readFileSync(join(dir, "dashboard-actions.jsonl"), "utf8");
  const action = JSON.parse(body.trim().split("\n")[0]);
  assert.equal(action.type, "question");
  assert.equal(action.question, "Scope?");
  assert.equal(action.change, "add-auth");
});

test("ask_user (headless) promotes the question and records the trail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-q-headless-"));
  const state = stateWith(dir, [runtime("Planner", { agentType: "planner" })]);
  const tool = buildHiveTools(state, "Planner").find((t) => t.name === "ask_user")!;
  // ctx without hasUI => headless path: enqueue to the main session dir + record.
  const ctx = { cwd: dir, hasUI: false } as any;
  const res = await runWithChange("add-auth", () => (tool.execute as any)("id", { question: "Which DB?" }, undefined, undefined, ctx));
  assert.equal(res.details.ok, true);
  assert.equal(res.details.promoted, true);
  // Question landed in the session action queue and the file trail.
  assert.match(readFileSync(join(dir, "dashboard-actions.jsonl"), "utf8"), /"type":"question"/);
  assert.match(readFileSync(join(dir, "openspec", "changes", "add-auth", "questions.md"), "utf8"), /Which DB\?/);
});
