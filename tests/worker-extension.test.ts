import assert from "node:assert/strict";
import { test } from "node:test";
import { workerResourceLoader } from "../src/engine/worker-extension.ts";
import { enforceDomainForTool } from "../src/engine/domain.ts";
import { runAsAgent } from "../src/engine/session.ts";
import type { AgentRuntime, HiveState } from "../src/core/types.ts";

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
