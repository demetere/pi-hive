import assert from "node:assert/strict";
import test from "node:test";
import { clearWorkflowStatusUi, renderWorkflowStatusLines, updateWorkflowStatusUi } from "../../src/ui/tui/workflow-widget";

test("normal chat has no workflow widget or status", () => {
  const calls: unknown[] = [];
  const ctx = { mode: "tui", hasUI: true, ui: { setWidget: (...args: unknown[]) => calls.push(["widget", ...args]), setStatus: (...args: unknown[]) => calls.push(["status", ...args]) } } as any;
  updateWorkflowStatusUi(ctx, undefined);
  assert.deepEqual(calls, [["widget", "hive-workflow", undefined], ["status", "hive-workflow", undefined]]);
});

test("selected workflow widget is concise, bounded, and generic", () => {
  const lines = renderWorkflowStatusLines({ workflowId: "custom-delivery", workflowName: "Custom Delivery", runId: "run-1", runStatus: "waiting_for_human", workspaceId: "workspace-1", tasks: { done: 12, total: 20, active: 2 }, pendingQuestions: 3, pendingApprovals: 1, budget: { tokensUsed: 900, tokensLimit: 1000, costMicroUsd: 12345 } });
  assert.ok(lines.length <= 3);
  assert.match(lines.join("\n"), /Custom Delivery/);
  assert.match(lines.join("\n"), /questions 3/);
  assert.doesNotMatch(lines.join("\n"), /plan|hive team/i);
  assert.ok(lines.every((line) => line.length <= 240));
});

test("archived restored summaries expose durable lifecycle and active budget state", () => {
  const lines = renderWorkflowStatusLines({ workflowId: "delivery", workflowName: "Delivery", sessionState: "archived", runId: "run-old", runStatus: "paused", tasks: { done: 4, total: 5, active: 0 }, pendingQuestions: 1, pendingApprovals: 2, budget: { tokensUsed: 700, tokensLimit: 1_000, activeMs: 12_345 } });
  assert.match(lines.join("\n"), /archived \/ paused/);
  assert.match(lines.join("\n"), /tasks 4\/5/);
  assert.match(lines.join("\n"), /active 12,345ms/);
});

test("widget restoration and cleanup contain UI failures while attempting both clears", () => {
  const calls: string[] = [];
  const ctx = { mode: "tui", hasUI: true, ui: {
    setWidget(_id: string, value: unknown) { calls.push(value === undefined ? "clear-widget" : "set-widget"); throw new Error("widget unavailable"); },
    setStatus(_id: string, value: unknown) { calls.push(value === undefined ? "clear-status" : "set-status"); },
  } } as any;
  assert.doesNotThrow(() => updateWorkflowStatusUi(ctx, { workflowId: "delivery", workflowName: "Delivery" }));
  assert.deepEqual(calls, ["set-status", "set-widget", "clear-widget", "clear-status"]);
  calls.length = 0;
  assert.doesNotThrow(() => clearWorkflowStatusUi(ctx));
  assert.deepEqual(calls, ["clear-widget", "clear-status"]);
});

test("TUI and hasUI guards prevent terminal UI calls", () => {
  const calls: unknown[] = [];
  updateWorkflowStatusUi({ mode: "rpc", hasUI: true, ui: { setWidget: (...x: unknown[]) => calls.push(x), setStatus: (...x: unknown[]) => calls.push(x) } } as any, { workflowId: "x", workflowName: "X" });
  assert.deepEqual(calls, []);
  clearWorkflowStatusUi({ mode: "print", hasUI: false, ui: {} } as any);
});
