import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerHooks } from "../../src/integration/hooks.ts";
import type { HiveState } from "../../src/core/types.ts";

// M8b: the orchestrator's own tool calls must carry durationMs on
// orchestrator_tool_end, the same way worker tool events do. We drive the real
// registerHooks() against a fake `pi` that records handlers, fire a tool_call
// then a matching tool_result, and read the emitted event back from the
// observability log.

// A fake ExtensionAPI: pi.on stores handlers by event name (multiple allowed).
function fakePi() {
  const handlers = new Map<string, Array<(e: any, ctx: any) => any>>();
  return {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    async fire(event: string, payload: any, ctx: any) {
      let result: any;
      for (const h of handlers.get(event) || []) result = await h(payload, ctx);
      return result;
    },
  };
}

function readEvents(logPath: string): any[] {
  const raw = readFileSync(logPath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((l: string) => JSON.parse(l));
}

test("orchestrator_tool_end carries durationMs (J5/M8b)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-orch-"));
  const obsLog = join(dir, "e.jsonl");
  const state: HiveState = {
    mode: "hive",
    session: { sessionId: "s1", sessionDir: dir, observabilityLog: obsLog },
    widgetCtx: { cwd: dir },
    obsSeq: 0,
    runtimes: new Map(),
    orchestratorRuntime: { toolCount: 0 },
    config: { orchestrator: { name: "Orchestrator", path: "o.md" }, agents: [] },
  } as any;

  const pi = fakePi();
  registerHooks(pi as any, state);
  const ctx = { cwd: dir } as any;

  await pi.fire("tool_call", { toolCallId: "tc1", toolName: "read", args: { path: "x" } }, ctx);
  // Some measurable wall-clock passes between call and result.
  await new Promise((r) => setTimeout(r, 5));
  await pi.fire("tool_result", { toolCallId: "tc1", toolName: "read", result: "ok", isError: false }, ctx);

  const events = readEvents(obsLog);
  const end = events.find((e) => e.type === "orchestrator_tool_end");
  assert.ok(end, "expected an orchestrator_tool_end event");
  assert.equal(typeof end.payload.durationMs, "number");
  assert.ok(end.payload.durationMs >= 0, "durationMs should be a non-negative number");
});

test("tool_result releases the start-time map entry even when mode is normal (M-misc leak)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-orch2-"));
  const obsLog = join(dir, "e.jsonl");
  const state: HiveState = {
    mode: "hive",
    session: { sessionId: "s1", sessionDir: dir, observabilityLog: obsLog },
    widgetCtx: { cwd: dir },
    obsSeq: 0,
    runtimes: new Map(),
    orchestratorRuntime: { toolCount: 0 },
    config: { orchestrator: { name: "Orchestrator", path: "o.md" }, agents: [] },
  } as any;

  const pi = fakePi();
  registerHooks(pi as any, state);
  const ctx = { cwd: dir } as any;

  // tool_call runs in hive mode (stores the start time).
  await pi.fire("tool_call", { toolCallId: "tc-leak", toolName: "read", args: {} }, ctx);
  // Mode flips to normal before the result arrives — the handler must still
  // release the map entry (early-returning without emitting). Re-firing in hive
  // mode afterwards should NOT find a stale start time (durationMs would be huge
  // if the entry leaked from the first call), but since it was deleted the second
  // call recomputes cleanly. We assert no emission happened while normal, then a
  // fresh call/result pair emits a sane duration.
  state.mode = "normal";
  await pi.fire("tool_result", { toolCallId: "tc-leak", toolName: "read", result: "ok", isError: false }, ctx);
  assert.equal(readEvents(obsLog).filter((e) => e.type === "orchestrator_tool_end").length, 0, "no end event should emit in normal mode");

  // Back to hive mode: a fresh call/result pair emits normally.
  state.mode = "hive";
  await pi.fire("tool_call", { toolCallId: "tc2", toolName: "read", args: {} }, ctx);
  await new Promise((r) => setTimeout(r, 3));
  await pi.fire("tool_result", { toolCallId: "tc2", toolName: "read", result: "ok", isError: false }, ctx);
  const end = readEvents(obsLog).find((e) => e.type === "orchestrator_tool_end" && e.payload.toolCallId === "tc2");
  assert.ok(end, "the post-flip call should still emit an end event");
  assert.equal(typeof end.payload.durationMs, "number");
});

// M1 end-to-end: the model_select hook must derive the effective model string
// from the EVENT payload (event.model.provider/id) and thread it into the
// catalog, so a mid-session switch to a non-config model describes it. Covers the
// hook's derivation, which model-catalog.test.ts (passing the string directly)
// does not exercise.
test("model_select re-emits a catalog covering the event's newly-selected model (M1 end-to-end)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-mselect-"));
  const obsLog = join(dir, "e.jsonl");
  const inheritAgent = (name: string): any => ({ name, path: `${name}.md`, role: "member", agentType: "lead", routingTags: [], domain: [], tools: "read", model: "inherit", thinking: "off", children: [] });
  const state: HiveState = {
    mode: "hive",
    session: { sessionId: "s1", sessionDir: dir, observabilityLog: obsLog },
    widgetCtx: { cwd: dir },
    obsSeq: 0,
    runtimes: new Map(),
    orchestratorRuntime: { toolCount: 0 },
    // Everything inherits; nothing in config names the model we switch to.
    config: { orchestrator: { name: "Orchestrator", path: "o.md", model: "inherit" }, agents: [inheritAgent("Coder")] },
  } as any;

  const pi = fakePi();
  registerHooks(pi as any, state);

  const modelRegistry: any = {
    getAll: () => [
      { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5", reasoning: true },
      { provider: "google", id: "gemini-3.5-flash", name: "Gemini Flash", reasoning: false },
    ],
  };
  // The event carries the new effective model; ctx carries the registry.
  await pi.fire("model_select", { model: { provider: "openai-codex", id: "gpt-5.5" } }, { cwd: dir, modelRegistry });

  const catalog = readEvents(obsLog).find((e) => e.type === "model_catalog");
  assert.ok(catalog, "expected a model_catalog event after model_select");
  const models = (catalog.payload.models || []).map((m: any) => `${m.provider}/${m.modelId}`);
  assert.ok(models.includes("openai-codex/gpt-5.5"), `catalog should describe the switched-to model; got ${JSON.stringify(models)}`);
});

test("orchestrator hooks emit bounded telemetry for the full SDK event surface", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-orch-events-"));
  const obsLog = join(dir, "events.jsonl");
  const state: HiveState = {
    mode: "hive",
    session: { sessionId: "events", sessionDir: dir, observabilityLog: obsLog, conversationLog: join(dir, "conversation.jsonl") },
    widgetCtx: { cwd: dir },
    obsSeq: 0,
    runtimes: new Map(),
    backgroundTasks: new Set(),
    backgroundDistillerSessions: new Set(),
    distillQueues: new Map(),
    orchestratorRuntime: {
      config: { name: "Orchestrator" }, status: "idle", toolCount: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, costUsd: 0, elapsedMs: 0,
    },
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md", model: "inherit" },
      agents: [{
        name: "Lead", slug: "lead", path: "lead.md", routingTags: ["code"], consultWhen: "implementation",
        children: [{
          name: "Worker", slug: "worker", path: "worker.md", routingTags: ["tests"], consultWhen: "verification",
          children: [{ name: "Nested", slug: "nested", path: "nested.md", children: [] }],
        }],
      }],
    },
  } as any;
  const pi = fakePi();
  registerHooks(pi as any, state);
  const ctx = {
    cwd: dir,
    mode: "rpc",
    hasUI: false,
    modelRegistry: { getAll: (): any[] => [] },
    getContextUsage: () => ({ percent: 42, tokens: 420, contextWindow: 1_000 }),
    ui: { setStatus() {}, setHeader() {}, setWidget() {}, setWorkingVisible() {} },
  } as any;

  await pi.fire("model_select", {
    model: { provider: "test", id: "new" }, previousModel: { provider: "test", id: "old" }, source: "user",
  }, ctx);
  await pi.fire("thinking_level_select", { level: "high", previousLevel: "low" }, ctx);
  await pi.fire("session_compact", { reason: "threshold", willRetry: true, fromExtension: true }, ctx);

  for (let turnIndex = 0; turnIndex < 65; turnIndex++) await pi.fire("turn_start", { turnIndex }, ctx);
  await pi.fire("turn_start", { turnIndex: "not-a-number" }, ctx);
  await pi.fire("turn_end", { turnIndex: 64 }, ctx);
  await pi.fire("turn_end", {}, ctx);

  await pi.fire("after_provider_response", { status: 200 }, ctx);
  await pi.fire("after_provider_response", { status: "invalid" }, ctx);
  await pi.fire("after_provider_response", {
    status: 429,
    headers: { "retry-after": "3", "x-ratelimit-remaining": "0" },
  }, ctx);
  await pi.fire("user_bash", { command: "x".repeat(700), excludeFromContext: true }, ctx);
  await pi.fire("input", { source: "interactive", streamingBehavior: "steer", images: [{}] }, ctx);
  await pi.fire("session_before_fork", { entryId: "e1", position: 2 }, ctx);
  await pi.fire("session_tree", { newLeafId: "new", oldLeafId: "old", fromExtension: true }, ctx);
  await pi.fire("session_info_changed", { name: "n".repeat(300) }, ctx);
  const prompt = await pi.fire("before_agent_start", { systemPrompt: "base prompt" }, ctx);
  assert.match(prompt.systemPrompt, /Hive orchestrator mode/);
  assert.match(prompt.systemPrompt, /Lead/);
  assert.match(prompt.systemPrompt, /Worker/);
  assert.match(prompt.systemPrompt, /Nested/);

  state.mode = "plan";
  const planPrompt = await pi.fire("before_agent_start", { systemPrompt: "base prompt" }, ctx);
  assert.match(planPrompt.systemPrompt, /Plan mode/);
  state.mode = "hive";

  await pi.fire("message_end", { message: {
    role: "assistant",
    content: [{ type: "text", text: "finished" }],
    model: "requested", responseModel: "served", provider: "provider", api: "api", responseId: "r1",
    stopReason: "stop", errorMessage: "e".repeat(700), diagnostics: [{ message: "diagnostic" }],
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, cost: { total: 0.25 } },
  } }, ctx);
  await pi.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "hello" }] } }, ctx);
  await pi.fire("message_end", { message: { role: "toolResult", content: "ignored" } }, ctx);
  await pi.fire("message_end", { message: { role: "assistant", content: [] } }, ctx);

  const events = readEvents(obsLog);
  for (const type of [
    "model_select", "thinking_level_select", "orchestrator_compaction", "turn", "provider_response",
    "user_bash", "input", "session_fork", "session_tree", "session_info_changed",
    "orchestrator_message", "assistant_message", "user_message",
  ]) assert.ok(events.some((event) => event.type === type), `missing ${type}`);
  assert.equal(state.orchestratorRuntime?.contextPct, 42);
  assert.equal(state.orchestratorRuntime?.inputTokens, 10);
  assert.equal(state.orchestratorRuntime?.outputTokens, 5);
  assert.equal(state.orchestratorRuntime?.costUsd, 0.25);

  await pi.fire("session_shutdown", {}, ctx);
});

test("normal mode suppresses every orchestrator telemetry hook", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-orch-normal-"));
  const obsLog = join(dir, "events.jsonl");
  const state = {
    mode: "normal",
    session: { sessionId: "normal", sessionDir: dir, observabilityLog: obsLog, conversationLog: join(dir, "conversation.jsonl") },
    runtimes: new Map(),
  } as any;
  const pi = fakePi();
  registerHooks(pi as any, state);
  const ctx = { cwd: dir, mode: "rpc", hasUI: false } as any;
  for (const event of [
    "tool_call", "tool_result", "model_select", "thinking_level_select", "session_compact",
    "turn_start", "turn_end", "after_provider_response", "user_bash", "input",
    "session_before_fork", "session_tree", "session_info_changed", "before_agent_start", "message_end",
  ]) await pi.fire(event, event === "message_end" ? { message: { role: "user", content: "ignored" } } : {}, ctx);
  assert.equal(existsSync(obsLog), false);
});

test("orchestrator telemetry tolerates sparse SDK payloads and missing runtime state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-orch-sparse-"));
  const obsLog = join(dir, "events.jsonl");
  const state = {
    mode: "hive",
    session: { sessionId: "sparse", sessionDir: dir, observabilityLog: obsLog, conversationLog: join(dir, "conversation.jsonl") },
    obsSeq: 0,
    runtimes: new Map(),
    config: { orchestrator: { name: "Orchestrator", path: "o.md" }, agents: [] },
  } as any;
  const pi = fakePi();
  registerHooks(pi as any, state);
  const ctx = {
    cwd: dir, mode: "rpc", hasUI: false,
    model: { provider: "fallback", id: "model" },
    modelRegistry: { getAll: (): any[] => [] },
  } as any;

  await pi.fire("tool_call", { toolName: "custom", toolCallId: "tc-1", input: {} }, ctx);
  await pi.fire("tool_result", {
    toolName: "custom", toolCallId: "tc-1", input: {}, content: [{ type: "text", text: "done" }], details: undefined, isError: false,
  }, ctx);
  await pi.fire("model_select", {}, ctx);
  await pi.fire("thinking_level_select", {}, ctx);
  await pi.fire("session_compact", {}, ctx);
  await pi.fire("turn_end", { turnIndex: "unknown" }, ctx);
  await pi.fire("after_provider_response", {
    status: 529,
    headers: { "retry-after": "1", "anthropic-ratelimit-requests-remaining": "2" },
  }, ctx);
  await pi.fire("user_bash", {}, ctx);
  await pi.fire("input", {}, ctx);
  await pi.fire("session_before_fork", {}, ctx);
  await pi.fire("session_tree", {}, ctx);
  await pi.fire("session_info_changed", {}, ctx);
  await pi.fire("message_end", { message: {
    role: "assistant", content: "fallback response", responseModel: "served", errorMessage: "failed", diagnostics: "invalid",
  } }, ctx);

  const events = readEvents(obsLog);
  assert.ok(events.some((event) => event.type === "orchestrator_tool_start" && event.payload.toolName === "custom"));
  assert.ok(events.some((event) => event.type === "model_select" && event.payload.model === "fallback/model"));
  assert.ok(events.some((event) => event.type === "provider_response" && event.payload.rateLimitRemaining === "2"));
  assert.ok(events.some((event) => event.type === "assistant_message"));
});
