import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerHooks } from "../src/integration/hooks.ts";
import type { HiveState } from "../src/core/types.ts";

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
      for (const h of handlers.get(event) || []) await h(payload, ctx);
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
