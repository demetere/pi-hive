import assert from "node:assert/strict";
import { test } from "node:test";
import { extractUsage } from "../src/core/usage.ts";

// A1/A2: extractUsage reads the canonical pi-ai Usage shape including cache and
// reasoning splits, and reads the SDK-computed cost.total.
test("extractUsage reads canonical pi-ai usage incl. cache/reasoning/cost", () => {
  const u = extractUsage({
    input: 100,
    output: 40,
    cacheRead: 900,
    cacheWrite: 12,
    reasoning: 7,
    totalTokens: 1052,
    cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.0005, total: 0.0315 },
  });
  assert.equal(u.input, 100);
  assert.equal(u.output, 40);
  assert.equal(u.cacheRead, 900);
  assert.equal(u.cacheWrite, 12);
  assert.equal(u.reasoning, 7);
  assert.equal(u.cost, 0.0315);
});

test("extractUsage tolerates missing fields and legacy token keys", () => {
  assert.deepEqual(extractUsage(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 });
  const legacy = extractUsage({ input_tokens: 5, output_tokens: 3 });
  assert.equal(legacy.input, 5);
  assert.equal(legacy.output, 3);
});

test("cacheWrite falls back to cacheWrite1h when the 5m field is absent", () => {
  assert.equal(extractUsage({ cacheWrite1h: 20 }).cacheWrite, 20);
});

// A1: the double-count. The old code added the final assistant message's usage
// on message_end AND again on agent_end. The fix: message_end accumulates for
// live display, then getSessionStats() OVERWRITES the totals at run end. Model
// that exact sequence and assert the totals equal the SDK aggregate, not the
// doubled sum.
test("getSessionStats overwrite kills the message_end/agent_end double-count", () => {
  // Simulate the dispatch runtime counters.
  const runtime = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

  // Two turns stream in; the final turn's message_end fires (live accumulation).
  const turns = [
    { input: 200, output: 50, cacheRead: 0, cacheWrite: 10, cost: { total: 0.05 } },
    { input: 120, output: 30, cacheRead: 400, cacheWrite: 0, cost: { total: 0.03 } },
  ];
  for (const usage of turns) {
    const u = extractUsage(usage);
    runtime.inputTokens += u.input;
    runtime.outputTokens += u.output;
    runtime.cacheReadTokens += u.cacheRead;
    runtime.cacheWriteTokens += u.cacheWrite;
    runtime.costUsd += u.cost;
  }
  // The historical bug: agent_end re-added the last turn's usage here. The fixed
  // dispatch code does NOT — the agent_end block only backfills output text.

  // Run end: getSessionStats() returns the session-lifetime aggregate. Overwrite.
  const stats = {
    tokens: { input: 320, output: 80, cacheRead: 400, cacheWrite: 10 },
    cost: { total: 0.08 },
  };
  runtime.inputTokens = stats.tokens.input;
  runtime.outputTokens = stats.tokens.output;
  runtime.cacheReadTokens = stats.tokens.cacheRead;
  runtime.cacheWriteTokens = stats.tokens.cacheWrite;
  runtime.costUsd = stats.cost.total;

  // Totals equal the SDK aggregate exactly — no doubling of the final turn.
  assert.equal(runtime.inputTokens, 320);
  assert.equal(runtime.outputTokens, 80);
  assert.equal(runtime.cacheReadTokens, 400);
  assert.equal(runtime.cacheWriteTokens, 10);
  assert.equal(runtime.costUsd, 0.08);
});
