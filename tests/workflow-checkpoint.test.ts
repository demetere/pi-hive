import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendWorkflowEvent } from "../src/workflows/journal.ts";
import { createWorkflowEvent } from "../src/workflows/events.ts";
import { writeCheckpoint, loadLatestCheckpoint } from "../src/workflows/checkpoints.ts";
import { restoreWorkflowState } from "../src/workflows/replay.ts";

function setup() { const root = mkdtempSync(join(tmpdir(), "hive-checkpoint-")); const sessionId = "s1"; const projectId = "p1"; const e1 = appendWorkflowEvent(root, createWorkflowEvent({ projectId, sessionId, type: "session.created", payload: {}, producer: "runtime", eventId: "e1" })); const e2 = appendWorkflowEvent(root, createWorkflowEvent({ projectId, sessionId, type: "control.requested", payload: {}, producer: "dashboard", eventId: "e2" })); return { root, sessionId, e1, e2 }; }

test("checkpoint plus tail restores deterministically and falls back after incomplete write", () => {
  const f = setup(); writeCheckpoint(f.root, f.sessionId, { lastSequence: 1, lastHash: f.e1.eventHash, state: { count: 1 } });
  assert.equal(loadLatestCheckpoint(f.root, f.sessionId)?.lastSequence, 1);
  const restored = restoreWorkflowState(f.root, f.sessionId, { count: 0 }, (state) => ({ count: state.count + 1 }));
  assert.deepEqual(restored.state, { count: 2 }); assert.equal(restored.lastSequence, 2);
  assert.throws(() => writeCheckpoint(f.root, f.sessionId, { lastSequence: 2, lastHash: f.e2.eventHash, state: { count: 2 } }, { fault(stage) { if (stage === "beforeRename") throw new Error("crash"); } }));
  assert.equal(loadLatestCheckpoint(f.root, f.sessionId)?.lastSequence, 1);
});

test("checkpoint hash mismatch fails closed", () => {
  const f = setup();
  assert.throws(() => writeCheckpoint(f.root, f.sessionId, { lastSequence: 2, lastHash: "0".repeat(64), state: {} }), /journal|hash/i);
});
