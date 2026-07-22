import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function throwingExtensionApi() {
  const fail = (name: string) => () => {
    throw new Error(`Unexpected registration in non-hive project: ${name}`);
  };
  return {
    registerTool: fail("registerTool"),
    registerCommand: fail("registerCommand"),
    registerShortcut: fail("registerShortcut"),
    on: fail("on"),
  };
}

test("extension factory performs zero registrations without hive-config.yaml", async () => {
  const previousCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-no-config-"));
  try {
    process.chdir(dir);
    const mod = await import(`../../index.ts?activation=${Date.now()}`);
    await mod.default(throwingExtensionApi());
    assert.ok(true);
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configured normal chat preserves the exact pre-registration tool baseline and stays widget-quiet", async () => {
  const previousCwd = process.cwd();
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-hive-normal-baseline-"));
  cpSync(new URL("../fixtures/workflow-configs/combined-delivery", import.meta.url), projectRoot, { recursive: true });
  const active = ["read", "bash", "custom-normal"];
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  let widgetCalls = 0;
  const pi = {
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) { active.splice(0, active.length, ...names); },
    registerTool(tool: { name: string }) { if (!active.includes(tool.name)) active.push(tool.name); },
    registerCommand() {},
    getThinkingLevel: () => "medium",
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  };
  const context = {
    sessionManager: { getSessionId: () => "normal-baseline", getSessionFile: () => join(projectRoot, "normal-baseline.jsonl") },
    model: { provider: "provider", id: "model" }, mode: "tui", hasUI: true,
    ui: { setWidget() { widgetCalls += 1; } },
  };
  try {
    process.chdir(projectRoot);
    const mod = await import(`../../index.ts?baseline=${Date.now()}`);
    await mod.default(pi as never);
    assert.deepEqual(active, ["read", "bash", "custom-normal"], "workflow registration must not pollute ordinary tools");
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, context);
    assert.deepEqual(active, ["read", "bash", "custom-normal"]);
    assert.equal(widgetCalls, 0, "initial normal chat must not touch workflow widgets");
  } finally {
    process.chdir(previousCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
