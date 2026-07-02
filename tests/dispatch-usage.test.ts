import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dispatchAgent, type CreateAgentSession } from "../src/engine/dispatch.ts";
import { restoreRuntimeCounters } from "../src/engine/session.ts";
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
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, contextPct: 0, runCount: 0, sessionFile,
  };
}

// A scripted AgentSession: on prompt(), it replays the given turns as message_end
// events (live accumulation), then an agent_end, to the subscriber. getSessionStats
// returns the authoritative lifetime aggregate that dispatch OVERWRITES with.
function scriptedSession(opts: {
  turns: Array<{ input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; cost: number }>;
  stats: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; reasoning?: number };
}) {
  let handler: ((e: any) => void) | undefined;
  return {
    subscribe(cb: (e: any) => void) { handler = cb; return () => { handler = undefined; }; },
    getAvailableThinkingLevels() { return ["off", "low", "high"]; },
    getContextUsage() { return { percent: 12 }; },
    getSessionStats() {
      // reasoning is included only when the test sets it, so the default keeps the
      // field ABSENT (Number(undefined) → NaN, the "SDK didn't report" path). Set
      // stats.reasoning: 0 to exercise the finite-0-must-not-wipe branch (R3-3.1).
      const tokens: any = { input: opts.stats.input, output: opts.stats.output, cacheRead: opts.stats.cacheRead, cacheWrite: opts.stats.cacheWrite };
      if (opts.stats.reasoning !== undefined) tokens.reasoning = opts.stats.reasoning;
      return { tokens, cost: { total: opts.stats.cost } };
    },
    state: { errorMessage: undefined as string | undefined },
    async prompt() {
      for (const t of opts.turns) {
        handler?.({ type: "message_end", message: { role: "assistant", model: "test/model", stopReason: "endTurn", usage: { input: t.input, output: t.output, cacheRead: t.cacheRead || 0, cacheWrite: t.cacheWrite || 0, reasoning: t.reasoning || 0, cost: { total: t.cost } } } });
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
    sddStatus: null, obsSeq: 0,
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

// Decision 1: delegation_end must carry PER-RUN deltas + delegationsSchema=1.
// getSessionStats() returns session-LIFETIME aggregates, so a re-run agent's
// runtime holds cumulative totals; the emitted delta must subtract the run-start
// baseline so SUM() over delegation rows never double-counts.
test("delegation_end emits per-run deltas against the run-start baseline (Decision 1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-delta-"));
  const worker = runtimeFor("Builder", join(dir, "builder.jsonl"));
  const obsLog = join(dir, "e.jsonl");
  const state: HiveState = {
    pi: {} as any,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md" },
      agents: [worker.config],
      sharedContext: [],
      settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 2, distiller: { enabled: false, model: "", conversationLines: 10 } },
    } as any,
    session: { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "c.jsonl"), observabilityLog: obsLog },
    runtimes: new Map([["builder", worker]]),
    widgetCtx: null, activeRuns: 0, mode: "hive", normalToolNames: [],
    sddStatus: null, obsSeq: 0,
  } as any;
  const ctx = { cwd: dir, modelRegistry: { find: () => ({ provider: "test", modelId: "model" }) } } as any;

  // Run 1: lifetime stats after this run = 100/40/... The delegation_end delta
  // for run 1 equals the full lifetime (baseline was 0).
  const create1: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 100, output: 40, cacheRead: 10, cacheWrite: 5, cost: 0.10 } }) })) as any;
  await dispatchAgent(state, "Builder", "run one", ctx, false, create1);
  assert.equal(worker.inputTokens, 100); // runtime now holds lifetime totals

  // Run 2: lifetime stats grow to 260/95/... The delta must be run-2-only:
  // 160/55/15/5/0.15 — NOT the cumulative 260/95.
  const create2: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 260, output: 95, cacheRead: 25, cacheWrite: 10, cost: 0.25 } }) })) as any;
  await dispatchAgent(state, "Builder", "run two", ctx, false, create2);

  const ends = readEmittedEvents(obsLog).filter((e) => e.type === "delegation_end");
  assert.equal(ends.length, 2, "expected a delegation_end per run");
  const run1 = ends[0].payload, run2 = ends[1].payload;
  // Both rows are marked as delta-schema so aggregation excludes legacy rows.
  assert.equal(run1.delegationsSchema, 1);
  assert.equal(run2.delegationsSchema, 1);
  // Run 1 delta = full lifetime (baseline 0).
  assert.deepEqual(run1.delta, { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 5, reasoningTokens: 0, costUsd: 0.10 });
  // Run 2 delta = lifetime growth only (260-100, 95-40, 25-10, 10-5, 0.25-0.10).
  assert.equal(run2.delta.inputTokens, 160);
  assert.equal(run2.delta.outputTokens, 55);
  assert.equal(run2.delta.cacheReadTokens, 15);
  assert.equal(run2.delta.cacheWriteTokens, 5);
  assert.ok(Math.abs(run2.delta.costUsd - 0.15) < 1e-9, `run2 cost delta ${run2.delta.costUsd} ≈ 0.15`);
  // The lifetime runtime summary still rides along for live display / TOK/S.
  assert.equal(run2.runtime.inputTokens, 260);
});

// W1.1: a fresh=true re-run archives the prior session, so end-of-run
// getSessionStats() covers ONLY the new session. Without resetting the runtime
// lifetime counters at archive time, the run-start baselines still hold the prior
// lifetime totals, so `runOnly − priorLifetime` goes negative and the nonneg clamp
// silently zeroes the whole delta (the fresh-archive under-count). This test proves
// the fresh run's delta equals its OWN usage, not ~0.
test("fresh re-run resets lifetime counters so the delta is the fresh session's usage, not clamped ~0 (W1.1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-fresh-"));
  const worker = runtimeFor("Builder", join(dir, "builder.jsonl"));
  const obsLog = join(dir, "e.jsonl");
  const state: HiveState = {
    pi: {} as any,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md" },
      agents: [worker.config],
      sharedContext: [],
      settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 2, distiller: { enabled: false, model: "", conversationLines: 10 } },
    } as any,
    session: { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "c.jsonl"), observabilityLog: obsLog },
    runtimes: new Map([["builder", worker]]),
    widgetCtx: null, activeRuns: 0, mode: "hive", normalToolNames: [],
    sddStatus: null, obsSeq: 0,
  } as any;
  const ctx = { cwd: dir, modelRegistry: { find: () => ({ provider: "test", modelId: "model" }) } } as any;

  // Run 1 (not fresh): lifetime stats after this run = 500/200.
  const create1: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 500, output: 200, cacheRead: 50, cacheWrite: 20, cost: 0.50 } }) })) as any;
  await dispatchAgent(state, "Builder", "run one", ctx, false, create1);
  assert.equal(worker.inputTokens, 500);
  // The scripted session doesn't persist a transcript, so materialize the prior
  // session file to model the real fresh=true precondition (a prior run exists to
  // archive). This is what triggers the archive+counter-reset path on run 2.
  writeFileSync(worker.sessionFile, "{}\n");

  // Run 2 with fresh=true: the prior builder.jsonl is archived, so this run's
  // getSessionStats reports ONLY the fresh session (80/30 — smaller than run 1's
  // lifetime). Pre-fix, delta = 80−500 → clamped to 0. Post-fix, baselines are 0,
  // so delta = 80/30 exactly.
  const create2: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 80, output: 30, cacheRead: 5, cacheWrite: 2, cost: 0.08 } }) })) as any;
  await dispatchAgent(state, "Builder", "run two fresh", ctx, true, create2);

  const ends = readEmittedEvents(obsLog).filter((e) => e.type === "delegation_end");
  assert.equal(ends.length, 2, "expected a delegation_end per run");
  const run2 = ends[1].payload;
  // The fresh run's delta is its OWN usage — not clamped to 0 by a stale baseline.
  assert.equal(run2.delta.inputTokens, 80);
  assert.equal(run2.delta.outputTokens, 30);
  assert.equal(run2.delta.cacheReadTokens, 5);
  assert.equal(run2.delta.cacheWriteTokens, 2);
  assert.ok(Math.abs(run2.delta.costUsd - 0.08) < 1e-9, `run2 cost delta ${run2.delta.costUsd} ≈ 0.08`);
  // Runtime now holds the fresh session's lifetime totals (overwritten by stats).
  assert.equal(worker.inputTokens, 80);
});

// R3-1.1: the fresh-delta fix must survive a runtime-counter restore. A mode
// switch / reloadTeam rebuilds runtimes and calls restoreRuntimeCounters, which
// reseeds lifetime totals from the delegation_end log. The OLD peak/Math.max
// restore would pick the pre-fresh row (500) over the post-fresh row (80),
// resurrecting the stale baseline so the NEXT run's delta clamps to ~0 — the exact
// bug W1.1 fixed. This test drives run → fresh run → restore → run and asserts the
// third delta is run-3-only, proving last-row-wins restoration.
test("fresh-delta survives a mode-switch runtime restore — third run's delta is not resurrected to ~0 (R3-1.1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-restore-"));
  const worker = runtimeFor("Builder", join(dir, "builder.jsonl"));
  const obsLog = join(dir, "e.jsonl");
  const state: HiveState = {
    pi: {} as any,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md" },
      agents: [worker.config],
      sharedContext: [],
      settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 2, distiller: { enabled: false, model: "", conversationLines: 10 } },
    } as any,
    session: { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "c.jsonl"), observabilityLog: obsLog },
    runtimes: new Map([["builder", worker]]),
    widgetCtx: null, activeRuns: 0, mode: "hive", normalToolNames: [],
    sddStatus: null, obsSeq: 0,
  } as any;
  const ctx = { cwd: dir, modelRegistry: { find: () => ({ provider: "test", modelId: "model" }) } } as any;

  // Run 1 (non-fresh): lifetime 500. Writes builder.jsonl so run 2's fresh path fires.
  const create1: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 500, output: 200, cacheRead: 50, cacheWrite: 20, cost: 0.50 } }) })) as any;
  await dispatchAgent(state, "Builder", "run one", ctx, false, create1);
  writeFileSync(worker.sessionFile, "{}\n");

  // Run 2 (fresh): archives, resets counters, lifetime now 80. The delegation_end
  // runtime snapshot for run 2 records 80 — SMALLER than run 1's 500.
  const create2: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 80, output: 30, cacheRead: 5, cacheWrite: 2, cost: 0.08 } }) })) as any;
  await dispatchAgent(state, "Builder", "run two fresh", ctx, true, create2);
  assert.equal(worker.inputTokens, 80);

  // Simulate a mode switch / reloadTeam: rebuild the runtime with zeroed counters
  // (as loadAgentRuntime does), then restore from the log. Last-row-wins must
  // restore 80, NOT the peak 500.
  worker.inputTokens = 0; worker.outputTokens = 0; worker.cacheReadTokens = 0;
  worker.cacheWriteTokens = 0; worker.costUsd = 0; worker.runCount = 0; worker.toolCount = 0;
  restoreRuntimeCounters(state);
  assert.equal(worker.inputTokens, 80, "restore must pick the latest (post-fresh) row, not the peak");
  assert.equal(worker.runCount, 2, "runCount stays monotonic across the restore");

  // Run 3 (non-fresh): the fresh session continues, lifetime grows 80 → 130. With a
  // correct baseline of 80, the delta is run-3-only (50). With the resurrected 500
  // baseline it would clamp to 0.
  const create3: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 130, output: 55, cacheRead: 9, cacheWrite: 4, cost: 0.13 } }) })) as any;
  await dispatchAgent(state, "Builder", "run three", ctx, false, create3);

  const ends = readEmittedEvents(obsLog).filter((e) => e.type === "delegation_end");
  assert.equal(ends.length, 3, "expected a delegation_end per run");
  const run3 = ends[2].payload;
  assert.equal(run3.delta.inputTokens, 50, "run 3 delta is run-3-only, not clamped to 0 by a resurrected baseline");
  assert.equal(run3.delta.outputTokens, 25);
  assert.equal(run3.delta.cacheReadTokens, 4);
  assert.equal(run3.delta.cacheWriteTokens, 2);
  assert.ok(Math.abs(run3.delta.costUsd - 0.05) < 1e-9, `run3 cost delta ${run3.delta.costUsd} ≈ 0.05`);
});

// Phase 4.8: reasoning ("thinking") tokens are extracted from message_end usage,
// accumulated on the runtime, and carried through the per-run delta + runtime
// summary. getSessionStats() lacks reasoning, so the end-of-run overwrite must
// PRESERVE the accumulated value rather than zeroing it.
test("dispatchAgent carries reasoning tokens through the delta + summary (Phase 4.8)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-reasoning-"));
  const worker = runtimeFor("Builder", join(dir, "builder.jsonl"));
  const obsLog = join(dir, "e.jsonl");
  const state: HiveState = {
    pi: {} as any,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md" },
      agents: [worker.config],
      sharedContext: [],
      settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 2, distiller: { enabled: false, model: "", conversationLines: 10 } },
    } as any,
    session: { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "c.jsonl"), observabilityLog: obsLog },
    runtimes: new Map([["builder", worker]]),
    widgetCtx: null, activeRuns: 0, mode: "hive", normalToolNames: [],
    sddStatus: null, obsSeq: 0,
  } as any;
  const ctx = { cwd: dir, modelRegistry: { find: () => ({ provider: "test", modelId: "model" }) } } as any;
  // Two turns each reporting reasoning; getSessionStats (no reasoning field)
  // overwrites the token/cost totals but must not clobber accumulated reasoning.
  const create: CreateAgentSession = (async () => ({ session: scriptedSession({
    turns: [{ input: 10, output: 5, reasoning: 30, cost: 0.01 }, { input: 10, output: 5, reasoning: 20, cost: 0.01 }],
    stats: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
  }) })) as any;
  await dispatchAgent(state, "Builder", "think hard", ctx, false, create);

  // Accumulated on the runtime and preserved past the getSessionStats overwrite.
  assert.equal(worker.reasoningTokens, 50);
  const end = readEmittedEvents(obsLog).filter((e) => e.type === "delegation_end")[0].payload;
  assert.equal(end.delta.reasoningTokens, 50);
  assert.equal(end.runtime.reasoningTokens, 50);
});

// R3-3.1: the reasoning-preservation guard must also survive a stats.reasoning of
// FINITE 0 (SDK reports the field but as zero — e.g. reasoning simply absent for
// this provider). The guard `reasoning > 0 || runtime.reasoningTokens === 0` must
// keep the accumulated value rather than wiping it to 0. The Phase 4.8 test above
// only covers the NaN path (field absent); this covers the finite-0 branch.
test("finite-0 reasoning from SessionStats does not wipe accumulated reasoning (R3-3.1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-reasoning0-"));
  const worker = runtimeFor("Builder", join(dir, "builder.jsonl"));
  const obsLog = join(dir, "e.jsonl");
  const state: HiveState = {
    pi: {} as any,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md" },
      agents: [worker.config],
      sharedContext: [],
      settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 2, distiller: { enabled: false, model: "", conversationLines: 10 } },
    } as any,
    session: { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "c.jsonl"), observabilityLog: obsLog },
    runtimes: new Map([["builder", worker]]),
    widgetCtx: null, activeRuns: 0, mode: "hive", normalToolNames: [],
    sddStatus: null, obsSeq: 0,
  } as any;
  const ctx = { cwd: dir, modelRegistry: { find: () => ({ provider: "test", modelId: "model" }) } } as any;
  // Turns accumulate 40 reasoning; stats reports reasoning: 0 explicitly (finite).
  const create: CreateAgentSession = (async () => ({ session: scriptedSession({
    turns: [{ input: 10, output: 5, reasoning: 25, cost: 0.01 }, { input: 10, output: 5, reasoning: 15, cost: 0.01 }],
    stats: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.02, reasoning: 0 },
  }) })) as any;
  await dispatchAgent(state, "Builder", "think then stats-zero", ctx, false, create);

  // The finite-0 from stats must NOT clobber the 40 accumulated from message_end.
  assert.equal(worker.reasoningTokens, 40);
  const end = readEmittedEvents(obsLog).filter((e) => e.type === "delegation_end")[0].payload;
  assert.equal(end.delta.reasoningTokens, 40);
  assert.equal(end.runtime.reasoningTokens, 40);
});

// R3-3.1 companion: when NOTHING was accumulated, a finite-0 from stats is trusted
// (the guard's `runtime.reasoningTokens === 0` arm) — reasoning stays 0, not left
// stale. Guards against the fix over-correcting into "never trust a 0".
test("finite-0 reasoning is trusted when nothing was accumulated (R3-3.1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-reasoning0b-"));
  const worker = runtimeFor("Builder", join(dir, "builder.jsonl"));
  const obsLog = join(dir, "e.jsonl");
  const state: HiveState = {
    pi: {} as any,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md" },
      agents: [worker.config],
      sharedContext: [],
      settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 2, distiller: { enabled: false, model: "", conversationLines: 10 } },
    } as any,
    session: { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "c.jsonl"), observabilityLog: obsLog },
    runtimes: new Map([["builder", worker]]),
    widgetCtx: null, activeRuns: 0, mode: "hive", normalToolNames: [],
    sddStatus: null, obsSeq: 0,
  } as any;
  const ctx = { cwd: dir, modelRegistry: { find: () => ({ provider: "test", modelId: "model" }) } } as any;
  const create: CreateAgentSession = (async () => ({ session: scriptedSession({
    turns: [{ input: 10, output: 5, cost: 0.01 }],
    stats: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, reasoning: 0 },
  }) })) as any;
  await dispatchAgent(state, "Builder", "no reasoning", ctx, false, create);

  assert.equal(worker.reasoningTokens, 0);
});

// M8a: the FIRST run's delegation_start must already carry thinkingLevels +
// the effective model. This is the J4/Decision-5 reorder — the worker session is
// created (and getAvailableThinkingLevels() probed) BEFORE delegation_start is
// emitted, so a fresh agent no longer emits undefined levels on run 1.
function readEmittedEvents(logPath: string): any[] {
  const raw = readFileSync(logPath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((l: string) => JSON.parse(l));
}

test("first-run delegation_start carries thinkingLevels + effective model (J4/M8a)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-firstrun-"));
  const worker = runtimeFor("Builder", join(dir, "builder.jsonl"));
  const obsLog = join(dir, "e.jsonl");
  const state: HiveState = {
    pi: {} as any,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md" },
      agents: [worker.config],
      sharedContext: [],
      settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 2, distiller: { enabled: false, model: "", conversationLines: 10 } },
    } as any,
    session: { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "c.jsonl"), observabilityLog: obsLog },
    runtimes: new Map([["builder", worker]]),
    widgetCtx: null, activeRuns: 0, mode: "hive", normalToolNames: [],
    sddStatus: null, obsSeq: 0,
  } as any;
  const ctx = { cwd: dir, modelRegistry: { find: () => ({ provider: "test", modelId: "model" }) } } as any;
  const create: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } }) })) as any;

  // runCount starts at 0 → this is the agent's FIRST run.
  assert.equal(worker.runCount, 0);
  await dispatchAgent(state, "Builder", "build the thing", ctx, false, create);

  const events = readEmittedEvents(obsLog);
  const starts = events.filter((e) => e.type === "delegation_start");
  assert.ok(starts.length >= 1, "expected a delegation_start event");
  const first = starts[0];
  // Populated on run 1 — the scripted session's getAvailableThinkingLevels().
  assert.deepEqual(first.payload.thinkingLevels, ["off", "low", "high"]);
  // The effective model is present (not undefined) on the very first run.
  assert.equal(first.payload.model, "test/model");
});
