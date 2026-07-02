import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dispatchAgent, type CreateAgentSession } from "../src/engine/dispatch.ts";
import type { AgentRuntime, HiveState } from "../src/core/types.ts";

// L1: a REAL double-count regression test. It drives dispatchAgent end-to-end
// with a scripted AgentSession (injected via the createSession seam) that streams
// two message_end turns then agent_end, and returns an authoritative
// getSessionStats() aggregate. The assertion is that the runtime totals equal the
// SDK aggregate EXACTLY — never the live-accumulated sum, which would be higher if
// agent_end re-added usage (the historical bug). No live model is involved.

function runtimeFor(name: string, sessionFile: string): AgentRuntime {
  return {
    config: { name, path: `${name}.md`, role: "member", agentType: "lead", routingTags: [], domain: [], tools: "read", model: "test/model", thinking: "off" },
    systemPrompt: "", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, contextPct: 0, runCount: 0, sessionFile,
  };
}

// A scripted AgentSession: on prompt(), it replays the given turns as message_end
// events (live accumulation), then an agent_end, to the subscriber. getSessionStats
// returns the authoritative lifetime aggregate that dispatch OVERWRITES with.
function scriptedSession(opts: {
  turns: Array<{ input: number; output: number; cacheRead?: number; cacheWrite?: number; cost: number }>;
  stats: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}) {
  let handler: ((e: any) => void) | undefined;
  return {
    subscribe(cb: (e: any) => void) { handler = cb; return () => { handler = undefined; }; },
    getAvailableThinkingLevels() { return ["off", "low", "high"]; },
    getContextUsage() { return { percent: 12 }; },
    getSessionStats() {
      return { tokens: { input: opts.stats.input, output: opts.stats.output, cacheRead: opts.stats.cacheRead, cacheWrite: opts.stats.cacheWrite }, cost: { total: opts.stats.cost } };
    },
    state: { errorMessage: undefined as string | undefined },
    async prompt() {
      for (const t of opts.turns) {
        handler?.({ type: "message_end", message: { role: "assistant", model: "test/model", stopReason: "endTurn", usage: { input: t.input, output: t.output, cacheRead: t.cacheRead || 0, cacheWrite: t.cacheWrite || 0, cost: { total: t.cost } } } });
      }
      // agent_end fires last. The FIXED dispatch only backfills output text here;
      // it must NOT re-add the final turn's usage.
      handler?.({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
    },
    dispose() { /* noop */ },
  };
}

test("dispatchAgent totals equal getSessionStats exactly — no message_end/agent_end double-count (L1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-dispatch-"));
  const worker = runtimeFor("Builder", join(dir, "builder.jsonl"));
  const state: HiveState = {
    pi: {} as any,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md" },
      agents: [worker.config],
      sharedContext: [],
      settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 2, distiller: { enabled: false, model: "", conversationLines: 10 } },
    } as any,
    session: { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "c.jsonl"), observabilityLog: join(dir, "e.jsonl") },
    runtimes: new Map([["builder", worker]]),
    widgetCtx: null, activeRuns: 0, mode: "hive", normalToolNames: [],
    streamStartMs: 0, streamedChars: 0, lastTokPerSec: 0, sddStatus: null, obsSeq: 0,
  } as any;

  // ctx with a model registry that resolves our test model.
  const ctx = { cwd: dir, modelRegistry: { find: () => ({ provider: "test", modelId: "model" }) } } as any;

  const turns = [
    { input: 200, output: 50, cacheWrite: 10, cost: 0.05 },
    { input: 120, output: 30, cacheRead: 400, cost: 0.03 },
  ];
  // The authoritative aggregate is DELIBERATELY DIFFERENT from the turn sum
  // (which is input 320 / output 80 / cacheRead 400 / cacheWrite 10 / cost 0.08).
  // The SDK aggregate below dedupes overlapping turns, so it is smaller. This gap
  // is what makes the test discriminating: it passes ONLY if dispatch overwrites
  // with getSessionStats rather than trusting the accumulated (or doubled) sum.
  const stats = { input: 300, output: 70, cacheRead: 380, cacheWrite: 8, cost: 0.072 };
  const create: CreateAgentSession = (async () => ({ session: scriptedSession({ turns, stats }) })) as any;

  const result = await dispatchAgent(state, "Builder", "build the thing", ctx, false, create);
  assert.equal(result.exitCode, 0);

  // Runtime totals equal the SDK aggregate EXACTLY — not the accumulated turn
  // sum (320/80/400/10/0.08) and not a doubled sum. Proves the getSessionStats
  // overwrite is what lands, killing the message_end/agent_end double-count.
  assert.equal(worker.inputTokens, 300);
  assert.equal(worker.outputTokens, 70);
  assert.equal(worker.cacheReadTokens, 380);
  assert.equal(worker.cacheWriteTokens, 8);
  assert.equal(worker.costUsd, 0.072);
});
