import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dispatchAgent, type CreateAgentSession } from "../../src/engine/dispatch.ts";
import { createState } from "../../src/engine/state.ts";
import { registerHooks } from "../../src/integration/hooks.ts";
import { applyMode } from "../../src/ui/tui/widget.ts";

function hiveProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-session-lifecycle-"));
  const agents = join(cwd, ".pi", "hive", "agents");
  mkdirSync(agents, { recursive: true });
  const prompt = (type: string, text: string) => `---\nmodel: test/model\nthinking: off\nagent-type: ${type}\n---\n${text}\n`;
  writeFileSync(join(agents, "planner.md"), prompt("planner", "Plan changes."));
  writeFileSync(join(agents, "lead.md"), prompt("lead", "Coordinate execution."));
  writeFileSync(join(agents, "builder.md"), prompt("lead", "Build delegated work."));
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
settings:
  telemetry:
    enabled: false
    dashboard-auto-start: false
  distiller:
    enabled: false
planning:
  main:
    name: Planning Lead
    path: .pi/hive/agents/planner.md
  agents: []
hive:
  main:
    name: Execution Lead
    path: .pi/hive/agents/lead.md
  agents:
    - name: Builder
      path: .pi/hive/agents/builder.md
`);
  return cwd;
}

function extensionHarness() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const sent: string[] = [];
  const entries: any[] = [];
  let activeTools = ["read", "bash"];
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => any) {
      const current = handlers.get(event) || [];
      current.push(handler);
      handlers.set(event, current);
    },
    async fire(event: string, payload: any, ctx: any) {
      for (const handler of handlers.get(event) || []) await handler(payload, ctx);
    },
    getActiveTools: () => activeTools,
    getAllTools: () => ["read", "bash", "route_agent"].map((name) => ({ name })),
    setActiveTools(tools: string[]) { activeTools = [...tools]; },
    sendUserMessage(message: string) { sent.push(message); },
    appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
  } as any;
  return { pi, handlers, sent, entries, activeTools: () => activeTools };
}

function lifecycleContext(cwd: string, entries: any[]) {
  const notifications: any[] = [];
  const statuses: any[] = [];
  const widgets: any[] = [];
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: true,
    modelRegistry: { find: () => ({ provider: "test", id: "model", modelId: "model" }), getAll: (): any[] => [] },
    sessionManager: { getEntries: () => entries },
    ui: {
      notify(...args: any[]) { notifications.push(args); },
      setStatus(...args: any[]) { statuses.push(args); },
      setWidget(...args: any[]) { widgets.push(args); },
      setHeader() {},
      setWorkingVisible() {},
    },
  } as any;
  return { ctx, notifications, statuses, widgets };
}

test("session start loads an opted-in team and shutdown aborts an active worker through final cleanup", async () => {
  const cwd = hiveProject();
  const h = extensionHarness();
  const state = createState(h.pi);
  const { ctx, notifications, statuses } = lifecycleContext(cwd, h.entries);
  registerHooks(h.pi, state);

  await h.pi.fire("session_start", {}, ctx);

  assert.equal(state.mode, "normal");
  assert.equal(state.widgetCtx, ctx);
  assert.equal(state.shuttingDown, false);
  assert.equal(state.config?.orchestrator.name, "Execution Lead");
  assert.ok(
    Array.from(state.runtimes.values()).some((runtime) => runtime.config.name === "Builder"),
    `loaded runtimes: ${Array.from(state.runtimes.values()).map((runtime) => runtime.config.name).join(", ")}; notifications: ${JSON.stringify(notifications)}`,
  );
  assert.deepEqual(h.activeTools(), ["read", "bash"]);
  assert.equal(typeof state.onRuntimeUpdate, "function");
  assert.equal(typeof state.onRuntimeFinish, "function");

  assert.equal(applyMode(state, ctx, "hive", { notify: false }), true);
  const worker = Array.from(state.runtimes.values()).find((runtime) => runtime.config.name === "Builder")!;
  let aborts = 0;
  let disposals = 0;
  let releasePrompt: (() => void) | undefined;
  const createSession: CreateAgentSession = (async () => ({ session: {
    subscribe(): () => void { return () => undefined; },
    getAvailableThinkingLevels(): string[] { return ["off"]; },
    getContextUsage(): { percent: number } { return { percent: 0 }; },
    getSessionStats(): any { return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: { total: 0 } }; },
    state: { errorMessage: undefined },
    async prompt(): Promise<void> { await new Promise<void>((resolve) => { releasePrompt = resolve; }); },
    async abort(): Promise<void> { aborts++; releasePrompt?.(); },
    dispose(): void { disposals++; },
  } } as any)) as any;

  const running = dispatchAgent(state, "Builder", "hold until shutdown", ctx, false, createSession);
  while (state.activeRuns === 0 || !worker.session) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.activeRuns, 1);

  await h.pi.fire("session_shutdown", {}, ctx);
  const result = await running;

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /aborted|shutting down/i);
  assert.equal(state.shuttingDown, true);
  assert.equal(state.activeRuns, 0);
  assert.equal(worker.session, undefined);
  assert.equal(worker.timer, undefined);
  assert.ok(aborts >= 1);
  assert.ok(disposals >= 1);
  assert.equal(state.onRuntimeUpdate, undefined);
  assert.equal(state.onRuntimeFinish, undefined);
  assert.equal(state.dashboardActionTimer, undefined);
  assert.equal(state.obsServer, undefined);
  assert.ok(statuses.some(([name, value]) => name === "hive" && value === undefined));
});

test("session start fails back to normal mode for malformed opted-in configuration", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-session-invalid-"));
  mkdirSync(join(cwd, ".pi", "hive"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), "settings:\n  unknown-setting: true\n");
  const h = extensionHarness();
  const state = createState(h.pi);
  const { ctx, notifications } = lifecycleContext(cwd, h.entries);
  registerHooks(h.pi, state);

  await h.pi.fire("session_start", {}, ctx);

  assert.equal(state.mode, "normal");
  assert.match(notifications.at(-1)?.[0] || "", /Hive failed to load/);
});

test("shutdown cleanup is best-effort across failing worker and distiller sessions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-session-cleanup-"));
  const h = extensionHarness();
  const state = createState(h.pi);
  const workerTimer = setInterval(() => undefined, 10_000);
  const dashboardTimer = setInterval(() => undefined, 10_000);
  state.runtimes.set("worker", {
    timer: workerTimer,
    session: {
      abort() { throw new Error("abort failed"); },
      dispose() { throw new Error("dispose failed"); },
    },
  } as any);
  state.backgroundDistillerSessions = new Set([{
    abort() { throw new Error("distiller abort failed"); },
    dispose() { throw new Error("distiller dispose failed"); },
  } as any]);
  state.backgroundTasks = new Set([Promise.resolve()]);
  state.distillQueues = new Map([["target", Promise.resolve()]]);
  state.dashboardActionTimer = dashboardTimer;
  const { ctx, statuses, widgets } = lifecycleContext(cwd, h.entries);
  ctx.mode = "tui";
  registerHooks(h.pi, state);

  await h.pi.fire("session_shutdown", {}, ctx);

  assert.equal(state.runtimes.get("worker")?.session, undefined);
  assert.equal(state.backgroundDistillerSessions.size, 0);
  assert.equal(state.backgroundTasks.size, 0);
  assert.equal(state.distillQueues.size, 0);
  assert.ok(widgets.some(([name, value]) => name === "hive-tree" && value === undefined));
  assert.ok(statuses.some(([name, value]) => name === "hive" && value === undefined));
});
