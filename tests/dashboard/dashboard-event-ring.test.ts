import assert from "node:assert/strict";
import { test } from "node:test";
import { EventRing } from "../../ui/web/src/store/event-ring.ts";
import type { HiveEvent } from "../../ui/web/src/types.ts";

function event(cursor: number, sessionId = "s1"): HiveEvent {
  return {
    event_id: `e-${cursor}`,
    session_id: sessionId,
    cursor,
    seq: cursor,
    ts: new Date(cursor * 1000).toISOString(),
    type: "message",
    payload: {},
  } as HiveEvent;
}

test("event ring retains the newest cursor-ordered window without duplicates", () => {
  const ring = new EventRing(3);
  assert.equal(ring.addAll([event(2), event(1), event(3), event(3)]), 3);
  assert.deepEqual(ring.values().map((item) => item.cursor), [1, 2, 3]);

  assert.equal(ring.add(event(4)), true);
  assert.deepEqual(ring.values().map((item) => item.cursor), [2, 3, 4]);
  assert.equal(ring.size, 3);
});

test("an older database page cannot evict newer live telemetry from a full ring", () => {
  const ring = new EventRing(3);
  ring.addAll([event(10), event(11), event(12)]);
  assert.equal(ring.addAll([event(7), event(8), event(9)]), 0);
  assert.deepEqual(ring.values().map((item) => item.cursor), [10, 11, 12]);
});

test("event ring loads older database rows while capacity remains", () => {
  const ring = new EventRing(5);
  ring.addAll([event(10), event(11), event(12)]);
  assert.equal(ring.addAll([event(8), event(9)]), 2);
  assert.deepEqual(ring.values().map((item) => item.cursor), [8, 9, 10, 11, 12]);
});

test("event ring purges sessions without disturbing retained order", () => {
  const ring = new EventRing(5);
  ring.addAll([event(1, "a"), event(2, "b"), event(3, "a"), event(4, "b")]);
  assert.equal(ring.removeSessions(new Set(["a"])), 2);
  assert.deepEqual(ring.values().map((item) => item.cursor), [2, 4]);
});
