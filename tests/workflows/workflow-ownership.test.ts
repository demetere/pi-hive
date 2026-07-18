import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireRuntimeOwnership, heartbeatRuntimeOwnership, markWorkflowOrphaned, releaseRuntimeOwnership } from "../../src/workflows/ownership.ts";
import { appendWorkflowEvent } from "../../src/workflows/journal.ts";
import { createWorkflowEvent } from "../../src/workflows/events.ts";

function root() { return mkdtempSync(join(tmpdir(), "hive-owner-")); }

test("fresh runtime ownership is exclusive and only verified dead stale owner can be recovered", () => {
  const project = root(); const now = Date.parse("2026-01-01T00:00:00Z");
  const first = acquireRuntimeOwnership(project, "s1", { pid: 111, processMarker: "a", now, nonce: "n1", verifyDead: () => false }); assert.equal(first.ok, true);
  assert.equal(acquireRuntimeOwnership(project, "s1", { pid: 222, processMarker: "b", now: now + 1000, nonce: "n2", verifyDead: () => true }).ok, false);
  assert.equal(acquireRuntimeOwnership(project, "s1", { pid: 222, processMarker: "b", now: now + 120_000, nonce: "n2", verifyDead: () => false }).ok, false);
  const takeover = acquireRuntimeOwnership(project, "s1", { pid: 222, processMarker: "b", now: now + 120_000, nonce: "n2", verifyDead: () => true }); assert.equal(takeover.ok, true);
  assert.equal(takeover.previousOwner?.heartbeatAt, new Date(now).toISOString(), "takeover exposes the verified dead owner's heartbeat for active-clock reconciliation");
  assert.equal(heartbeatRuntimeOwnership(project, "s1", "n1", now + 121_000), false); assert.equal(heartbeatRuntimeOwnership(project, "s1", "n2", now + 121_000), true);
  assert.equal(releaseRuntimeOwnership(project, "s1", "n1"), false); assert.equal(releaseRuntimeOwnership(project, "s1", "n2"), true);
});

test("short dashboard append does not acquire runtime ownership and missing Pi session preserves journal as orphan", () => {
  const project = root(); appendWorkflowEvent(project, createWorkflowEvent({ projectId: "p", sessionId: "s", type: "control.requested", payload: {}, producer: "dashboard", eventId: "e" }));
  assert.equal(existsSync(join(project, ".pi/hive/sessions/s/runtime-owner.json")), false);
  markWorkflowOrphaned(project, "s", "p", "missing-pi-session");
  assert.equal(existsSync(join(project, ".pi/hive/sessions/s/journal")), true);
});
