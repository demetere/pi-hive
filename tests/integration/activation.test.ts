import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import hiveExtension, { createWorkflowDashboardStartLifecycle } from "../../index.ts";
import { NORMAL_SESSION_MARKER_TYPE } from "../../src/integration/session-links.ts";
import { listSessionLinks, type WorkflowSessionLink } from "../../src/workflows/sessions.ts";
import { FakePiSessionManager } from "../helpers/fake-pi-session-manager.ts";

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

test("dashboard-start lifecycle is quiet until its exact session or first workflow-selection boundary", async () => {
  const calls: Array<{ context: unknown; open: boolean }> = [];
  const start = async (context: unknown, open: boolean) => { calls.push({ context, open }); return "http://127.0.0.1:43191"; };
  const context = { boundary: "test" };

  const workflow = createWorkflowDashboardStartLifecycle(undefined, start);
  assert.equal(calls.length, 0, "default construction must not start a daemon from the extension factory");
  await workflow.sessionStarted(context, false);
  assert.equal(calls.length, 0, "default workflow mode keeps normal session startup quiet");
  await Promise.all([workflow.workflowSelected(context), workflow.workflowSelected(context)]);
  assert.deepEqual(calls, [{ context, open: false }], "the first actual workflow selection starts one background daemon without opening a browser");
  await workflow.sessionStarted(context, true);
  assert.equal(calls.length, 1, "resume and later selection events reuse the one lifecycle start");

  calls.length = 0;
  const session = createWorkflowDashboardStartLifecycle("session", start);
  assert.equal(calls.length, 0, "session mode still cannot start at factory construction");
  await session.sessionStarted(context, false);
  await session.workflowSelected(context);
  assert.deepEqual(calls, [{ context, open: false }], "session mode starts only from the first session hook");

  calls.length = 0;
  const manual = createWorkflowDashboardStartLifecycle("manual", start);
  await manual.sessionStarted(context, true);
  await manual.workflowSelected(context);
  assert.deepEqual(calls, [], "manual mode remains observe-only");
});

test("configured factory defers Pi actions until session_start and restores the exact normal tool baseline", async () => {
  const previousCwd = process.cwd();
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-hive-normal-baseline-"));
  cpSync(new URL("../fixtures/workflow-configs/combined-delivery", import.meta.url), projectRoot, { recursive: true });
  const normalTools = ["read", "bash", "workflow_custom_plugin", "custom-normal"];
  const active = [...normalTools];
  const workflowToolNames: string[] = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  let sessionStarted = false;
  let widgetCalls = 0;
  let dashboardStarts = 0;
  const action = <Args extends unknown[], Result>(name: string, run: (...args: Args) => Result) => (...args: Args): Result => {
    if (!sessionStarted) throw new Error(`Extension runtime not initialized: ${name}`);
    return run(...args);
  };
  const pi = {
    getActiveTools: action("getActiveTools", () => [...active]),
    setActiveTools: action("setActiveTools", (names: string[]) => { active.splice(0, active.length, ...names); }),
    getThinkingLevel: action("getThinkingLevel", () => "medium"),
    getAllTools: action("getAllTools", () => active.map((name) => ({ name }))),
    registerTool(tool: { name: string }) { workflowToolNames.push(tool.name); if (!active.includes(tool.name)) active.push(tool.name); },
    registerCommand() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  };
  const normalSessionFile = join(projectRoot, "normal-baseline.jsonl");
  writeFileSync(normalSessionFile, "persisted normal session\n");
  const context = {
    sessionManager: { getSessionId: () => "normal-baseline", getSessionFile: () => normalSessionFile },
    model: { provider: "provider", id: "model" }, mode: "tui", hasUI: true,
    ui: { setWidget() { widgetCalls += 1; } },
  };
  try {
    process.chdir(projectRoot);
    const mod = await import(`../../index.ts?baseline=${Date.now()}`);
    await mod.default(pi as never, { startDashboard: async () => { dashboardStarts += 1; } });
    assert.ok(workflowToolNames.length > 0, "factory registers workflow tool declarations");
    assert.deepEqual(active, [...normalTools, ...workflowToolNames], "factory performs declarations only and leaves Pi's registration-time tool state untouched");

    sessionStarted = true;
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, context);
    assert.deepEqual(active, normalTools, "session startup excludes exactly package workflow tools while preserving built-in and custom tools");
    assert.equal(widgetCalls, 0, "initial normal chat must not touch workflow widgets");
    assert.equal(dashboardStarts, 0, "default workflow mode must not start for normal session startup");
  } finally {
    process.chdir(previousCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("real-shaped activation materializes a slash-only canonical normal session before select and exit", async () => {
  const previousCwd = process.cwd();
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-hive-slash-only-normal-"));
  cpSync(new URL("../fixtures/workflow-configs/artifact-free-debug", import.meta.url), projectRoot, { recursive: true });
  const sessionRoot = join(projectRoot, "pi-sessions");
  mkdirSync(sessionRoot);
  const canonicalNormalId = "normal-slash-only";
  const canonicalNormalFile = join(sessionRoot, `${canonicalNormalId}.jsonl`);
  const baseline = ["read", "bash", "custom-normal"];
  const model = { provider: "provider", id: "model", contextWindow: 2_000_000, maxTokens: 16_384, reasoning: true };
  const notices: string[] = [];
  let currentManager = FakePiSessionManager.create(projectRoot, sessionRoot);
  currentManager.newSession({ id: canonicalNormalId });
  let sessionId = currentManager.getSessionId();
  let sessionFile = currentManager.getSessionFile()!;
  let activeTools = [...baseline];
  let created = 0;
  let currentContext: any;
  let commands = new Map<string, any>();
  let hooks = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();

  const persistedEntries = (path: string): any[] => existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const activate = async (reason: "startup" | "new" | "resume", ctx: any): Promise<void> => {
    commands = new Map();
    hooks = new Map();
    const declared = new Set<string>();
    const pi: any = {
      registerTool(tool: { name: string }) { declared.add(tool.name); if (!activeTools.includes(tool.name)) activeTools.push(tool.name); },
      registerCommand(name: string, value: unknown) { commands.set(name, value); },
      on(name: string, handler: (event: unknown, context: any) => unknown) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
      getActiveTools: () => [...activeTools],
      setActiveTools(names: string[]) { activeTools = [...names]; },
      getThinkingLevel: () => "medium",
      getAllTools: () => [...new Set([...baseline, ...declared])].map((name) => ({ name })),
    };
    await hiveExtension(pi, { startDashboard: async () => {}, runtimePlatform: "linux" });
    for (const handler of hooks.get("session_start") ?? []) await handler({ reason }, ctx);
  };
  const createContext = (): any => {
    let stale = false;
    const target: any = {
      cwd: projectRoot, mode: "tui", hasUI: true, model,
      sessionManager: currentManager,
      modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
      isProjectTrusted: () => true, isIdle: () => true, abort() {}, waitForIdle: async () => {},
      ui: { notify: (text: string) => notices.push(text), setWidget() {}, setStatus() {} },
      async newSession(input: any) {
        const nextId = `workflow-pi-${++created}`;
        currentManager = FakePiSessionManager.create(projectRoot, sessionRoot);
        currentManager.newSession({ id: nextId });
        sessionId = currentManager.getSessionId();
        sessionFile = currentManager.getSessionFile()!;
        const fresh = createContext();
        stale = true;
        currentContext = fresh;
        await activate("new", fresh);
        await input.setup?.(fresh.sessionManager);
        await input.withSession?.(fresh);
        return { cancelled: false };
      },
      async switchSession(path: string, input: any) {
        currentManager = FakePiSessionManager.open(path);
        sessionId = currentManager.getSessionId();
        sessionFile = currentManager.getSessionFile()!;
        const fresh = createContext();
        stale = true;
        currentContext = fresh;
        await activate("resume", fresh);
        await input.withSession?.(fresh);
        return { cancelled: false };
      },
      async reload() {
        currentManager = FakePiSessionManager.open(sessionFile);
        const reloaded = createContext();
        stale = true;
        currentContext = reloaded;
        await activate("resume", reloaded);
      },
    };
    return new Proxy(target, {
      get(value, property, receiver) {
        if (stale) throw new Error(`old context accessed after Pi replacement: ${String(property)}`);
        return Reflect.get(value, property, receiver);
      },
    });
  };

  try {
    process.chdir(projectRoot);
    currentContext = createContext();
    assert.equal(existsSync(canonicalNormalFile), false, "slash-only Pi session starts with an allocated but unmaterialized path");
    await activate("startup", currentContext);
    assert.equal(existsSync(canonicalNormalFile), true, "normal session_start materializes the canonical Pi path through its manager");
    await activate("resume", currentContext);
    const normalMarkers = persistedEntries(canonicalNormalFile).filter((entry) => entry.customType === NORMAL_SESSION_MARKER_TYPE);
    assert.equal(normalMarkers.length, 1, "resume does not grow duplicate normal markers");
    assert.deepEqual(normalMarkers[0].data, { formatVersion: 1 }, "normal marker is immutable identity-free metadata");
    assert.ok(Buffer.byteLength(JSON.stringify(normalMarkers[0].data), "utf8") <= 64, "normal marker data is strictly bounded");

    await commands.get("hive:select").handler("debug-chat", currentContext);
    const selected = listSessionLinks(projectRoot).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.piSessionId === sessionId);
    assert.ok(selected);
    assert.equal(selected.normalParentId, canonicalNormalId);
    assert.equal(selected.normalParentFile, canonicalNormalFile);
    await commands.get("hive:status").handler("", currentContext);
    await commands.get("hive:checkpoints").handler("", currentContext);
    await commands.get("hive:exit").handler("", currentContext);
    assert.equal(sessionId, canonicalNormalId, "exit returns to the exact canonical normal Pi ID");
    assert.equal(sessionFile, canonicalNormalFile, "exit returns to the exact canonical normal Pi file");
    assert.deepEqual(activeTools, [...baseline].sort(), "replacement session_start restores the original normal tool baseline");
    await commands.get("hive:status").handler("", currentContext);
    assert.match(notices.at(-1) ?? "", /^Normal chat normal-slash-only · Linked workflows: debug-chat /u);
    assert.equal(notices.some((notice) => /error|stale context|old context accessed/i.test(notice)), false);
  } finally {
    process.chdir(previousCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("dashboard-start session mode is injected at the real session hook and never leaks a daemon from factory construction", async () => {
  const previousCwd = process.cwd();
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-hive-dashboard-session-hook-"));
  cpSync(new URL("../fixtures/workflow-configs/combined-delivery", import.meta.url), projectRoot, { recursive: true });
  const manifestPath = join(projectRoot, ".pi/hive/hive-config.yaml");
  writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace("schema-version: 1\n", "schema-version: 1\nsettings:\n  telemetry:\n    dashboard-start: session\n"));
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const active = ["read"];
  let starts = 0;
  const pi = {
    getActiveTools: () => [...active], setActiveTools() {}, registerTool() {}, registerCommand() {}, getThinkingLevel: () => "medium",
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  };
  const normalSessionFile = join(projectRoot, "normal.jsonl");
  writeFileSync(normalSessionFile, "persisted normal session\n");
  const context = {
    sessionManager: { getSessionId: () => "normal-session-hook", getSessionFile: () => normalSessionFile },
    model: { provider: "provider", id: "model" }, mode: "print", hasUI: false,
  };
  try {
    process.chdir(projectRoot);
    const mod = await import(`../../index.ts?dashboard-session=${Date.now()}`);
    await mod.default(pi as never, { startDashboard: async (_ctx: unknown, open: boolean) => { assert.equal(open, false); starts += 1; } });
    assert.equal(starts, 0, "extension factory remains side-effect free");
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, context);
    assert.equal(starts, 1, "the session hook owns session-mode startup");
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "resume" }, context);
    assert.equal(starts, 1, "repeated hooks reuse the one lifecycle start");
  } finally {
    process.chdir(previousCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
