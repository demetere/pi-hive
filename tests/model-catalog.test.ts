import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emitModelCatalog } from "../src/engine/observability.ts";
import type { HiveState } from "../src/core/types.ts";

// M1/M8d: emitModelCatalog must describe the session's current EFFECTIVE model,
// not just config-declared ones. Workers on "inherit" resolve to the main model;
// after a mid-session switch to a model absent from config, the re-emitted
// catalog must still cover it — otherwise those workers stay on an undescribed
// model. configuredModels() deliberately skips "inherit", so without the M1 fix
// the newly-selected model is dropped from the catalog.

function stateWithInheritWorkers(obsLog: string): HiveState {
  const agent = (name: string, model: string): any => ({ name, path: `${name}.md`, role: "member", agentType: "lead", routingTags: [], domain: [], tools: "read", model, thinking: "off", children: [] });
  return {
    mode: "hive",
    session: { sessionId: "s1", sessionDir: "/tmp", observabilityLog: obsLog },
    widgetCtx: { cwd: "/tmp" },
    obsSeq: 0,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md", model: "inherit" },
      // Every worker inherits; NOTHING in config names the new model.
      agents: [agent("Coder", "inherit"), agent("Tester", "inherit")],
    },
  } as any;
}

// True when no event was emitted at all (the log file is never created).
const noEmit = (obsLog: string) => !existsSync(obsLog) || readFileSync(obsLog, "utf8").trim() === "";

// A fake ModelRegistry.getAll() exposing two providers' models.
const REGISTRY: any = {
  getAll: () => [
    { provider: "anthropic", id: "claude-opus-4-8", name: "Opus 4.8", reasoning: true, thinkingLevelMap: { low: {}, high: {}, off: null } as any },
    { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", minimal: "low" } as any },
    { provider: "google", id: "gemini-3.5-flash", name: "Gemini Flash", reasoning: false },
  ],
};

function catalogPayloadModels(obsLog: string): any[] {
  const raw = readFileSync(obsLog, "utf8").trim();
  if (!raw) return [];
  const events = raw.split("\n").map((l: string) => JSON.parse(l)).filter((e: any) => e.type === "model_catalog");
  assert.ok(events.length >= 1, "expected a model_catalog event");
  const last = events[events.length - 1];
  return last.payload.models || [];
}

function catalogModels(obsLog: string): string[] {
  return catalogPayloadModels(obsLog).map((m: any) => `${m.provider}/${m.modelId}`);
}

test("no catalog is emitted when config declares no models and none is passed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-catalog-"));
  const obsLog = join(dir, "e.jsonl");
  const state = stateWithInheritWorkers(obsLog);
  // No config-declared models and no effective model → nothing to emit.
  emitModelCatalog(state, REGISTRY);
  assert.ok(noEmit(obsLog), "no catalog should be emitted when the wanted set is empty");
});

test("model switch to a non-config model includes the inherit-resolved model (M1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-catalog2-"));
  const obsLog = join(dir, "e.jsonl");
  const state = stateWithInheritWorkers(obsLog);
  // Simulate a mid-session switch: the new effective model is openai-codex/gpt-5.5,
  // which appears NOWHERE in config (all workers inherit).
  emitModelCatalog(state, REGISTRY, "openai-codex/gpt-5.5");
  const models = catalogModels(obsLog);
  assert.ok(models.includes("openai-codex/gpt-5.5"), `catalog should describe the newly selected model; got ${JSON.stringify(models)}`);
});

test("an explicit 'inherit' effective model is ignored (not a real model id)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-catalog3-"));
  const obsLog = join(dir, "e.jsonl");
  const state = stateWithInheritWorkers(obsLog);
  emitModelCatalog(state, REGISTRY, "inherit");
  // "inherit" is not a resolvable model → the wanted set stays empty → no emit.
  assert.ok(noEmit(obsLog));
});

test("model catalog mirrors pi-ai thinking level semantics", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-catalog4-"));
  const obsLog = join(dir, "e.jsonl");
  const state = stateWithInheritWorkers(obsLog);
  emitModelCatalog(state, REGISTRY, "openai-codex/gpt-5.5");
  const model = catalogPayloadModels(obsLog).find((m: any) => m.provider === "openai-codex" && m.modelId === "gpt-5.5");
  assert.deepEqual(model.thinkingLevels, ["off", "minimal", "low", "medium", "high", "xhigh"]);

  const anthropic = catalogPayloadModels(obsLog).find((m: any) => m.provider === "anthropic" && m.modelId === "claude-opus-4-8");
  assert.equal(anthropic, undefined, "only wanted models should be emitted");
});
