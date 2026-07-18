import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeWorkerSkillPaths, workerResourceLoader } from "../../src/engine/worker-extension.ts";
import { enforceDomainForTool } from "../../src/engine/domain.ts";
import { runAsAgent } from "../../src/engine/session.ts";
import type { AgentRuntime, HiveState } from "../../src/core/types.ts";

function runtime(name: string, extra: Partial<AgentRuntime["config"]> = {}): AgentRuntime {
  return {
    config: {
      name,
      path: `${name}.md`,
      role: "member",
      routingTags: [],
      domain: [],
      ...extra,
    },
    systemPrompt: "",
    status: "idle",
    task: "",
    lastWork: "",
    toolCount: 0,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    contextPct: 0,
    runCount: 0,
    sessionFile: "",
  };
}

function stateWith(runtimes: AgentRuntime[]): HiveState {
  return {
    pi: {} as any,
    config: null,
    session: null,
    runtimes: new Map(runtimes.map((entry) => [entry.config.name.toLowerCase(), entry])),
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
  };
}

// Captures whatever handlers a DefaultResourceLoader's extensionFactories
// register, so the test can invoke the captured tool_call handler the same
// way Pi's real runtime would for a worker session.
function capturingPi() {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  return {
    handlers,
    pi: { on: (event: string, handler: (event: any, ctx: any) => any) => handlers.set(event, handler) },
  };
}

test("normalizeWorkerSkillPaths accepts strings, refs, and double-wrapped refs before Pi ResourceLoader sees them", () => {
  assert.deepEqual(
    normalizeWorkerSkillPaths([
      ".pi/hive/skills/a/SKILL.md",
      { path: ".pi/hive/skills/b/SKILL.md", useWhen: "planning" },
      { path: { path: ".pi/hive/skills/c/SKILL.md" } },
    ]),
    [
      ".pi/hive/skills/a/SKILL.md",
      ".pi/hive/skills/b/SKILL.md",
      ".pi/hive/skills/c/SKILL.md",
    ],
  );
});

test("normalizeWorkerSkillPaths rejects invalid entries with a clear indexed error", () => {
  assert.throws(
    () => normalizeWorkerSkillPaths(["ok", { nope: true }]),
    /skillPaths\[1\] must be a string or \{path:string\}/,
  );
});

test("workerResourceLoader normalizes skill refs before constructing Pi ResourceLoader", () => {
  const loader = workerResourceLoader({} as HiveState, "/repo", "Planner", [
    { path: ".pi/hive/skills/imed-repo-map/SKILL.md" },
    { path: { path: ".pi/hive/skills/imed-frontend-map/SKILL.md" } },
  ] as any);
  assert.equal((loader as any).noExtensions, true, "worker loaders must not load global/package extensions");
  assert.equal((loader as any).noSkills, true, "worker loaders must not merge global/package skill paths");
  assert.deepEqual((loader as any).additionalSkillPaths, [
    ".pi/hive/skills/imed-repo-map/SKILL.md",
    ".pi/hive/skills/imed-frontend-map/SKILL.md",
  ]);
});

test("workerResourceLoader re-attaches tool_call with identical behavior to enforceDomainForTool", async () => {
  const ctx = { cwd: "/repo" } as any;
  const state = stateWith([runtime("Frontend Dev", { domain: [{ path: "ui", read: true, upsert: true, delete: false }] })]);

  const loader = workerResourceLoader(state, "/repo", "Frontend Dev");
  const { handlers, pi } = capturingPi();
  const factories = (loader as any).extensionFactories;
  assert.ok(Array.isArray(factories) && factories.length === 1, "expected exactly one extensionFactory");
  factories[0](pi);
  const toolCall = handlers.get("tool_call");
  assert.ok(toolCall, "expected a tool_call handler to be registered");

  const blockingEvent = { toolName: "bash", input: { command: "rm ui/App.tsx" } };
  const allowedEvent = { toolName: "bash", input: { command: "touch ui/App.tsx" } };

  await runAsAgent("Frontend Dev", async () => {
    const viaLoader = await toolCall!(blockingEvent, ctx);
    const direct = enforceDomainForTool(state, blockingEvent, ctx);
    assert.deepEqual(viaLoader, direct);
    assert.match(viaLoader?.reason ?? "", /cannot delete/);

    assert.equal(await toolCall!(allowedEvent, ctx), undefined);
    assert.equal(enforceDomainForTool(state, allowedEvent, ctx), undefined);
  });
});

// R3-3.2: the worker extension seam must surface provider back-pressure. Only the
// seam's ExtensionAPI sees pi.on("after_provider_response"); dispatch.ts's
// session.subscribe() cannot. Drive the captured handler and assert a non-2xx
// response emits a `provider_response` event tagged with the worker's own name,
// carrying status + retry-after, while a 2xx is skipped (no per-success flood).
test("workerResourceLoader emits provider_response on 429/529 back-pressure, skips 2xx (R3-3.2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-worker-pr-"));
  const obsLog = join(dir, "hive-events.jsonl");
  const state = stateWith([runtime("Frontend Dev")]);
  (state as any).session = { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "c.jsonl"), observabilityLog: obsLog };

  const loader = workerResourceLoader(state, dir, "Frontend Dev");
  const { handlers, pi } = capturingPi();
  (loader as any).extensionFactories[0](pi);
  const onResponse = handlers.get("after_provider_response");
  assert.ok(onResponse, "expected an after_provider_response handler to be registered");

  const readEvents = (): any[] => (existsSync(obsLog) ? readFileSync(obsLog, "utf8").trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l)) : []);

  // A 200 must NOT emit — successes would flood one row per call. The seam's
  // after_provider_response handler ignores the 2nd (ctx) arg; pass {} for the type.
  await onResponse!({ status: 200, headers: {} }, {} as any);
  assert.equal(readEvents().filter((e: any) => e.type === "provider_response").length, 0, "2xx must not emit");

  // A 429 emits a provider_response with status + retry-after, tagged to the worker.
  await onResponse!({ status: 429, headers: { "retry-after": "12", "anthropic-ratelimit-requests-remaining": "0" } }, {} as any);
  const emitted = readEvents().filter((e: any) => e.type === "provider_response");
  assert.equal(emitted.length, 1, "429 must emit exactly one provider_response");
  assert.equal(emitted[0].payload.agent, "Frontend Dev");
  assert.equal(emitted[0].payload.status, 429);
  assert.equal(emitted[0].payload.retryAfter, "12");
  assert.equal(emitted[0].payload.rateLimitRemaining, "0");
});
