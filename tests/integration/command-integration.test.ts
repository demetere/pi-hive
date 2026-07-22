import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as openspec from "../../src/engine/openspec.ts";
import { createState } from "../../src/engine/state.ts";
import { registerCommands, type CommandDeps, type RegisterCommandOptions } from "../../src/integration/commands.ts";

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

function commandDeps(overrides: Partial<CommandDeps> = {}): RegisterCommandOptions {
  return {
    workflowConfigured: false,
    dependencies: {
      openspec: fakeOpenSpec(),
      ensureDashboard: async () => ({ running: true, url: "http://127.0.0.1:43191", adopted: false, spawned: true }),
      stopDashboard: async () => [],
      dashboardUrl: () => "http://127.0.0.1:43191",
      readDaemonToken: () => "test-token",
      fetch: async () => new Response(JSON.stringify({ events: 0, sessions: 0 }), { status: 200, headers: { "content-type": "application/json" } }),
      ...overrides,
    },
  };
}

test("registered legacy mode commands and mode-cycle shortcut remain operational through W27", async () => {
  const h = harness();
  const state = createState(h.pi);
  state.normalToolNames = ["read", "bash"];
  const { ctx, notifications } = context();
  registerCommands(h.pi, state, commandDeps());

  assert.deepEqual(
    ["hive:normal", "hive:plan-mode", "hive", "hive:toggle"].map((name) => h.commands.has(name)),
    [true, true, true, true],
  );
  assert.equal(h.shortcuts.length, 1);

  await h.commands.get("hive:plan-mode").handler("", ctx);
  assert.equal(state.mode, "plan");
  assert.ok(h.activeTools().includes("plan_new"));

  await h.commands.get("hive").handler("", ctx);
  assert.equal(state.mode, "hive");
  assert.ok(h.activeTools().includes("plan_task_complete"));
  assert.ok(!h.activeTools().includes("plan_new"));

  state.activeRuns = 1;
  await h.commands.get("hive:normal").handler("", ctx);
  assert.equal(state.mode, "hive");
  assert.match(notifications.at(-1)?.message || "", /Cannot switch mode while 1 agent is running/);

  state.activeRuns = 0;
  await h.commands.get("hive:normal").handler("", ctx);
  assert.equal(state.mode, "normal");
  assert.deepEqual(h.activeTools(), ["read", "bash"]);
});

test("hive:execute selects an approved change, enters hive mode, and sends the execution turn", async () => {
  const h = harness();
  const state = createState(h.pi);
  state.mode = "plan";
  state.normalToolNames = ["read"];
  const { ctx, notifications } = context();
  registerCommands(h.pi, state, commandDeps());

  await h.commands.get("hive:execute").handler("approved-change", ctx);

  assert.equal(state.activeChangeId, "approved-change");
  assert.equal(state.mode, "hive");
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /Execute the approved plan/);
  assert.match(h.messages[0], /1\.1 Build it/);
  assert.match(notifications.at(-1)?.message || "", /Executing plan "approved-change"/);
});

test("hive:execute does not send work when a running planner blocks the mode switch", async () => {
  const h = harness();
  const state = createState(h.pi);
  state.mode = "plan";
  state.activeRuns = 1;
  const { ctx, notifications } = context();
  registerCommands(h.pi, state, commandDeps());

  await h.commands.get("hive:execute").handler("approved-change", ctx);

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

  await h.commands.get("hive:observe").handler("", ctx);
  assert.equal(starts, 0);
  assert.match(notifications.at(-1)?.message || "", /not initialized/);

  state.session = { sessionId: "s1", sessionDir: ctx.cwd, conversationLog: join(ctx.cwd, "conversation.jsonl"), observabilityLog: join(ctx.cwd, "events.jsonl") };
  await h.commands.get("hive:observe").handler("", ctx);
  assert.equal(starts, 1);
  assert.match(notifications.at(-1)?.message || "", /telemetry restarted/);

  await h.commands.get("hive:observe-stop").handler("", ctx);
  assert.equal(stops, 1);
  assert.match(notifications.at(-1)?.message || "", /43210/);

  await h.commands.get("hive:observe-prune").handler("not-a-number", ctx);
  assert.equal(requests.length, 0);
  assert.match(notifications.at(-1)?.message || "", /Usage/);

  await h.commands.get("hive:observe-prune").handler("30", ctx);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:43191/prune");
  assert.equal(new Headers(requests[0].init?.headers).get("authorization"), "Bearer test-token");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { olderThanDays: 30 });
  assert.match(notifications.at(-1)?.message || "", /Pruned 7 events and 2 sessions/);
});

test("plan and execute commands report every fail-closed artifact state", async () => {
  const cases: Array<{ overrides: Partial<typeof openspec>; expected: RegExp }> = [
    { overrides: {}, expected: /Usage: \/hive:execute/ },
    { overrides: { changeExists: () => false }, expected: /No OpenSpec change/ },
    { overrides: { hasTasks: () => false }, expected: /has no tasks\.md/ },
    { overrides: { isReadyToExecute: () => false }, expected: /is not ready/ },
    { overrides: { isApprovedForExecution: () => false }, expected: /is not approved/ },
  ];

  for (const [index, entry] of cases.entries()) {
    const h = harness();
    const state = createState(h.pi);
    const { ctx, notifications } = context();
    registerCommands(h.pi, state, commandDeps({ openspec: fakeOpenSpec(entry.overrides) }));
    await h.commands.get("hive:execute").handler(index === 0 ? "" : "candidate", ctx);
    assert.match(notifications.at(-1)?.message || "", entry.expected);
    assert.equal(h.messages.length, 0);
  }
});

test("plan command selects, lists, and rejects changes", async () => {
  const h = harness();
  const state = createState(h.pi);
  const { ctx, notifications } = context();
  registerCommands(h.pi, state, commandDeps({
    openspec: fakeOpenSpec({
      listChanges: () => [
        { name: "ready", status: "in-progress", completedTasks: 0, totalTasks: 1 },
        { name: "draft", status: "in-progress", completedTasks: 0, totalTasks: 0 },
      ],
      changeExists: (_cwd, id) => id === "ready",
      hasTasks: (_cwd, id) => id === "ready",
    }),
  }));

  const execute = h.commands.get("hive:execute");
  state.widgetCtx = { cwd: ctx.cwd } as any;
  assert.deepEqual(execute.getArgumentCompletions("re"), [{ value: "ready", label: "ready" }]);

  await h.commands.get("hive:plan").handler("missing", ctx);
  assert.match(notifications.at(-1)?.message || "", /No OpenSpec change/);

  await h.commands.get("hive:plan").handler("ready", ctx);
  assert.equal(state.activeChangeId, "ready");
  assert.match(notifications.at(-1)?.message || "", /Active plan change/);

  await h.commands.get("hive:plan").handler("", ctx);
  assert.match(notifications.at(-1)?.message || "", /ready \(active\).*tasks ready/s);
  assert.match(notifications.at(-1)?.message || "", /draft/);
});

test("headless command handlers fail safely without attempting UI notifications", async () => {
  const h = harness();
  const state = createState(h.pi);
  const { ctx } = context();
  ctx.hasUI = false;
  let fetchMode: "status" | "throw" = "status";
  registerCommands(h.pi, state, commandDeps({
    openspec: fakeOpenSpec({ changeExists: () => false }),
    fetch: async () => {
      if (fetchMode === "throw") throw new Error("offline");
      return new Response("no", { status: 503 });
    },
  }));

  await h.commands.get("hive:doctor").handler("", ctx);
  await h.commands.get("hive:execute").handler("", ctx);
  await h.commands.get("hive:execute").handler("missing", ctx);
  await h.commands.get("hive:plan").handler("missing", ctx);
  await h.commands.get("hive:plan").handler("", ctx);
  await h.commands.get("hive:observe").handler("", ctx);

  state.session = { sessionId: "s1", sessionDir: ctx.cwd, conversationLog: "", observabilityLog: "" };
  await h.commands.get("hive:observe").handler("", ctx);
  await h.commands.get("hive:observe-stop").handler("", ctx);
  await h.commands.get("hive:observe-prune").handler("bad", ctx);
  await h.commands.get("hive:observe-prune").handler("1", ctx);
  fetchMode = "throw";
  await h.commands.get("hive:observe-prune").handler("1", ctx);

  const blocked = harness();
  const blockedState = createState(blocked.pi);
  blockedState.mode = "plan";
  blockedState.activeRuns = 2;
  const warning = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: any[]) => warnings.push(args.join(" "));
  try {
    registerCommands(blocked.pi, blockedState, commandDeps());
    await blocked.commands.get("hive:execute").handler("approved-change", ctx);
  } finally {
    console.warn = warning;
  }
  assert.match(warnings.join("\n"), /Cannot execute/);
});

test("dashboard command error paths stay visible and bounded", async () => {
  const h = harness();
  const state = createState(h.pi);
  const { ctx, notifications } = context();
  state.session = { sessionId: "s1", sessionDir: ctx.cwd, conversationLog: "", observabilityLog: "" };
  let observeResult: any = { running: false, url: "", adopted: false, spawned: false, bunMissing: true };
  let pruneMode: "status" | "throw" = "status";
  registerCommands(h.pi, state, commandDeps({
    ensureDashboard: async () => observeResult,
    stopDashboard: async () => [],
    fetch: async () => {
      if (pruneMode === "throw") throw new Error("connection refused");
      return new Response("no", { status: 503 });
    },
  }));

  await h.commands.get("hive:observe").handler("", ctx);
  assert.match(notifications.at(-1)?.message || "", /Bun is not installed/);
  observeResult = { running: false, url: "", adopted: false, spawned: false, error: "bind failed" };
  await h.commands.get("hive:observe").handler("", ctx);
  assert.match(notifications.at(-1)?.message || "", /bind failed/);

  await h.commands.get("hive:observe-stop").handler("", ctx);
  assert.match(notifications.at(-1)?.message || "", /No pi-hive telemetry dashboard/);

  await h.commands.get("hive:observe-prune").handler("1", ctx);
  assert.match(notifications.at(-1)?.message || "", /Prune failed \(503\)/);
  pruneMode = "throw";
  await h.commands.get("hive:observe-prune").handler("1", ctx);
  assert.match(notifications.at(-1)?.message || "", /connection refused/);
});
