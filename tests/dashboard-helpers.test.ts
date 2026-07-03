import assert from "node:assert/strict";
import { test } from "node:test";
import { projectName } from "../src/shared/project.ts";
import { buildHistoryBySession, historyTotals } from "../ui/web/src/store/history.ts";
import { buildEventStatus } from "../ui/web/src/store/status.ts";
import { cumulativeSeries, delegationsFromEvents, seriesTotals } from "../ui/web/src/lib/series.ts";
import { tokPerSec } from "../ui/web/src/lib/agents.ts";

test("projectName keeps useful parent context for generic paths", () => {
  assert.equal(projectName("/Users/me/work/app"), "work / app");
  assert.equal(projectName("/Users/me/iMed/iMed"), "iMed / iMed");
  assert.equal(projectName("/Users/me/pi-hive"), "pi-hive");
});

test("buildEventStatus tracks nested delegation waiting and resume states", () => {
  const events: any[] = [
    { session_id: "s1", seq: 1, ts: "1", type: "session_start", payload: {} },
    { session_id: "s1", seq: 2, ts: "2", type: "delegation_start", payload: { from: "Orchestrator", to: "Lead" } },
    { session_id: "s1", seq: 3, ts: "3", type: "delegation_start", payload: { from: "Lead", to: "Worker" } },
    { session_id: "s1", seq: 4, ts: "4", type: "worker_tool_start", payload: { agent: "Lead" } },
    { session_id: "s1", seq: 5, ts: "5", type: "delegation_end", payload: { from: "Worker", type: "done" } },
  ];

  const status = buildEventStatus(events).get("s1")!;
  assert.equal(status.get("Orchestrator"), "waiting");
  assert.equal(status.get("Lead"), "running");
  assert.equal(status.get("Worker"), "done");
});

test("tokPerSec reports generation throughput, not prompt throughput", () => {
  // 100k prompt tokens over 10s is provider context processing, not generation.
  assert.equal(tokPerSec(100_000, 500, 10_000, 0, 0), 50);
  // Re-runs subtract the output baseline so old output does not inflate the rate.
  assert.equal(tokPerSec(150_000, 800, 10_000, 100_000, 500), 30);
  // Legacy snapshots without baselines fall back to lifetime output only.
  assert.equal(tokPerSec(100_000, 500, 10_000), 50);
});

test("buildHistoryBySession keeps peak cumulative usage per agent", () => {
  const events: any[] = [
    { session_id: "s1", type: "delegation_start", payload: { to: "A", runtime: { name: "A", runCount: 1 } } },
    { session_id: "s1", type: "worker_tool_start", payload: { agent: "A" } },
    { session_id: "s1", type: "delegation_end", payload: { from: "A", runtime: { name: "A", inputTokens: 10, outputTokens: 5, costUsd: 0.01, runCount: 1, toolCount: 1 } } },
    { session_id: "s1", type: "delegation_start", payload: { to: "A", runtime: { name: "A", inputTokens: 10, outputTokens: 5, costUsd: 0.01, runCount: 2 } } },
    { session_id: "s1", type: "worker_tool_start", payload: { agent: "A" } },
    { session_id: "s1", type: "delegation_end", payload: { from: "A", runtime: { name: "A", inputTokens: 7, outputTokens: 20, costUsd: 0.03, runCount: 2, toolCount: 1 } } },
  ];

  const history = buildHistoryBySession(events);
  assert.deepEqual(historyTotals(history, "s1"), { tokens: 30, cost: 0.03 });
  assert.deepEqual(history.get("s1")?.get("A"), { input: 10, output: 20, cost: 0.03, runs: 2, tools: 2 });
});

// Phase F guardrail: replaying to the final event yields the same derived state
// as the full (non-replay) view. The replay panel derives over events[0..cursor];
// at the last cursor that slice IS the whole history, so status/totals must match.
test("replay to the final cursor equals the full-history derivation (F3)", () => {
  const events: any[] = [
    { session_id: "s1", seq: 1, ts: "2026-07-02T00:00:01Z", type: "session_start", payload: {} },
    { session_id: "s1", seq: 2, ts: "2026-07-02T00:00:02Z", type: "delegation_start", payload: { from: "Orchestrator", to: "A", runtime: { name: "A" } } },
    { session_id: "s1", seq: 3, ts: "2026-07-02T00:00:03Z", type: "delegation_end", payload: { from: "A", type: "done", runtime: { name: "A", inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 10, costUsd: 0.05 } } },
    { session_id: "s1", seq: 4, ts: "2026-07-02T00:00:04Z", type: "delegation_start", payload: { from: "Orchestrator", to: "B", runtime: { name: "B" } } },
    { session_id: "s1", seq: 5, ts: "2026-07-02T00:00:05Z", type: "delegation_end", payload: { from: "B", type: "done", runtime: { name: "B", inputTokens: 200, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 5, costUsd: 0.03 } } },
  ];
  const fullStatus = buildEventStatus(events).get("s1")!;
  // Phase 3: replay reconstructs per-run delegation deltas from the event slice
  // (delegationsFromEvents), then the same series helpers sum them. These events
  // carry single-run agents with no `delta` block, so the fallback maps their
  // lifetime runtime values to the per-run delta 1:1.
  const fullTotals = seriesTotals(delegationsFromEvents(events));

  // The replay slice at the last cursor is the whole array.
  const replaySlice = events.slice(0, events.length);
  const replayStatus = buildEventStatus(replaySlice).get("s1")!;
  const replayTotals = seriesTotals(delegationsFromEvents(replaySlice));

  assert.deepEqual([...replayStatus.entries()].sort(), [...fullStatus.entries()].sort());
  assert.deepEqual(replayTotals, fullTotals);
  // Totals are the summed per-run deltas (Phase 2/3 honest usage).
  assert.equal(fullTotals.tok, 400); // (100+40) + (200+60)
  assert.equal(fullTotals.cacheRead, 900);
  assert.equal(fullTotals.cacheWrite, 15);
  assert.equal(Number(fullTotals.cost.toFixed(2)), 0.08);

  // A partial cursor is a strict prefix: totals never exceed the full totals.
  const midTotals = seriesTotals(delegationsFromEvents(events.slice(0, 3)));
  assert.equal(midTotals.tok, 140);
  assert.ok(midTotals.tok <= fullTotals.tok);
  // Cumulative series is monotonic non-decreasing.
  const series = cumulativeSeries(delegationsFromEvents(events));
  for (let i = 1; i < series.length; i++) assert.ok(series[i].tok >= series[i - 1].tok);
});
