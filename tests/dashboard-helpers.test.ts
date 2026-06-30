import assert from "node:assert/strict";
import { test } from "node:test";
import { projectName } from "../src/shared/project.ts";
import { buildHistoryBySession, historyTotals } from "../ui/web/src/store/history.ts";
import { buildEventStatus } from "../ui/web/src/store/status.ts";

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

test("buildHistoryBySession keeps peak cumulative usage per agent", () => {
  const events: any[] = [
    { session_id: "s1", type: "delegation_end", payload: { from: "A", runtime: { name: "A", inputTokens: 10, outputTokens: 5, costUsd: 0.01 } } },
    { session_id: "s1", type: "delegation_end", payload: { from: "A", runtime: { name: "A", inputTokens: 7, outputTokens: 20, costUsd: 0.03 } } },
  ];

  const history = buildHistoryBySession(events);
  assert.deepEqual(historyTotals(history, "s1"), { tokens: 30, cost: 0.03 });
});
