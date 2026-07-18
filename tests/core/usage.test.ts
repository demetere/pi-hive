import assert from "node:assert/strict";
import { test } from "node:test";
import { extractUsage } from "../../src/core/usage.ts";

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

// A1: the message_end/agent_end double-count regression is now covered by a REAL
// end-to-end test that drives dispatchAgent with a scripted AgentSession — see
// tests/orchestration/dispatch-usage.test.ts (L1). The old plain-object re-implementation that
// lived here could not catch a real regression and was removed.
