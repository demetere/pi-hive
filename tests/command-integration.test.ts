import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as openspec from "../src/engine/openspec.ts";
import { createState } from "../src/engine/state.ts";
import { registerCommands, type CommandDeps } from "../src/integration/commands.ts";

function harness() {
  const commands = new Map<string, any>();
  const shortcuts: any[] = [];
  const messages: string[] = [];
  let activeTools = ["read", "bash"];
  const pi = {
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerShortcut(key: any, shortcut: any) { shortcuts.push({ key, ...shortcut }); },
    sendUserMessage(message: string) { messages.push(message); },
    getActiveTools() { return activeTools; },
    getAllTools() { return ["read", "bash", "route_agent"].map((name) => ({ name })); },
    setActiveTools(tools: string[]) { activeTools = [...tools]; },
  } as any;
  return { pi, commands, shortcuts, messages, activeTools: () => activeTools };
}

function context(cwd = mkdtempSync(join(tmpdir(), "pi-hive-command-"))) {
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: true,
    ui: {
      notify(message: string, level?: string) { notifications.push({ message, level }); },
      setStatus() {},
      setWidget() {},
      setHeader() {},
      setWorkingVisible() {},
    },
  } as any;
  return { ctx, notifications };
}

function fakeOpenSpec(overrides: Partial<typeof openspec> = {}): typeof openspec {
  return {
    ...openspec,
    listChanges: () => [{ name: "approved-change", status: "in-progress", completedTasks: 0, totalTasks: 1 }],
    changeExists: () => true,
    hasTasks: () => true,
    isReadyToExecute: () => true,
    isApprovedForExecution: () => true,
    readArtifact: () => "# Tasks\n\n- [ ] 1.1 Build it\n",
    ...overrides,
  } as typeof openspec;
}

function commandDeps(overrides: Partial<CommandDeps> = {}): Partial<CommandDeps> {
  return {
    openspec: fakeOpenSpec(),
    ensureDashboard: async () => ({ running: true, url: "http://127.0.0.1:43191", adopted: false, spawned: true }),
    stopDashboard: async () => [],
    dashboardUrl: () => "http://127.0.0.1:43191",
    readDaemonToken: () => "test-token",
    fetch: async () => new Response(JSON.stringify({ events: 0, sessions: 0 }), { status: 200, headers: { "content-type": "application/json" } }),
    ...overrides,
  };
}

test("registered mode commands drive the real mode state machine and drain guard", async () => {
  const h = harness();
  const state = createState(h.pi);
  state.normalToolNames = ["read", "bash"];
  const { ctx, notifications } = context();
  registerCommands(h.pi, state, commandDeps());

  assert.deepEqual(
    ["hive-normal", "hive-plan-mode", "hive", "hive-toggle"].map((name) => h.commands.has(name)),
    [true, true, true, true],
  );
  assert.equal(h.shortcuts.length, 1);

  await h.commands.get("hive-plan-mode").handler("", ctx);
  assert.equal(state.mode, "plan");
  assert.ok(h.activeTools().includes("plan_new"));

  await h.commands.get("hive").handler("", ctx);
  assert.equal(state.mode, "hive");
  assert.ok(h.activeTools().includes("plan_task_complete"));
  assert.ok(!h.activeTools().includes("plan_new"));

  state.activeRuns = 1;
  await h.commands.get("hive-normal").handler("", ctx);
  assert.equal(state.mode, "hive");
  assert.match(notifications.at(-1)?.message || "", /Cannot switch mode while 1 agent is running/);

  state.activeRuns = 0;
  await h.commands.get("hive-normal").handler("", ctx);
  assert.equal(state.mode, "normal");
  assert.deepEqual(h.activeTools(), ["read", "bash"]);
});

test("hive-execute selects an approved change, enters hive mode, and sends the execution turn", async () => {
  const h = harness();
  const state = createState(h.pi);
  state.mode = "plan";
  state.normalToolNames = ["read"];
  const { ctx, notifications } = context();
  registerCommands(h.pi, state, commandDeps());

  await h.commands.get("hive-execute").handler("approved-change", ctx);

  assert.equal(state.activeChangeId, "approved-change");
  assert.equal(state.mode, "hive");
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /Execute the approved plan/);
  assert.match(h.messages[0], /1\.1 Build it/);
  assert.match(notifications.at(-1)?.message || "", /Executing plan "approved-change"/);
});

test("hive-execute does not send work when a running planner blocks the mode switch", async () => {
  const h = harness();
  const state = createState(h.pi);
  state.mode = "plan";
  state.activeRuns = 1;
  const { ctx, notifications } = context();
  registerCommands(h.pi, state, commandDeps());

  await h.commands.get("hive-execute").handler("approved-change", ctx);

  assert.equal(state.mode, "plan");
  assert.equal(h.messages.length, 0);
  assert.match(notifications.at(-1)?.message || "", /Cannot execute.*1 agent is running/);
});

test("dashboard commands cover uninitialized, restart, stop, and authenticated prune flows", async () => {
  const h = harness();
  const state = createState(h.pi);
  const { ctx, notifications } = context();
  let starts = 0;
  let stops = 0;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  registerCommands(h.pi, state, commandDeps({
    ensureDashboard: async (_state, _ctx, _root, options) => {
      starts++;
      assert.deepEqual(options, { open: true, forceRestart: true });
      return { running: true, url: "http://127.0.0.1:43191", adopted: false, spawned: true };
    },
    stopDashboard: async () => { stops++; return [43210]; },
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ events: 7, sessions: 2 }), { headers: { "content-type": "application/json" } });
    },
  }));

  await h.commands.get("hive-observe").handler("", ctx);
  assert.equal(starts, 0);
  assert.match(notifications.at(-1)?.message || "", /not initialized/);

  state.session = { sessionId: "s1", sessionDir: ctx.cwd, conversationLog: join(ctx.cwd, "conversation.jsonl"), observabilityLog: join(ctx.cwd, "events.jsonl") };
  await h.commands.get("hive-observe").handler("", ctx);
  assert.equal(starts, 1);
  assert.match(notifications.at(-1)?.message || "", /telemetry restarted/);

  await h.commands.get("hive-observe-stop").handler("", ctx);
  assert.equal(stops, 1);
  assert.match(notifications.at(-1)?.message || "", /43210/);

  await h.commands.get("hive-observe-prune").handler("not-a-number", ctx);
  assert.equal(requests.length, 0);
  assert.match(notifications.at(-1)?.message || "", /Usage/);

  await h.commands.get("hive-observe-prune").handler("30", ctx);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:43191/prune");
  assert.equal(new Headers(requests[0].init?.headers).get("authorization"), "Bearer test-token");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { olderThanDays: 30 });
  assert.match(notifications.at(-1)?.message || "", /Pruned 7 events and 2 sessions/);
});
