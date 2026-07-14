import assert from "node:assert/strict";
import { test } from "node:test";
import { drainEventsAfter } from "../ui/web/src/api.ts";
import type { HiveEvent } from "../ui/web/src/types.ts";

function event(cursor: number): HiveEvent {
  return {
    event_id: `event-${cursor}`,
    session_id: "gap-session",
    cursor,
    seq: cursor,
    ts: new Date(cursor).toISOString(),
    type: "message",
    payload: {},
  } as HiveEvent;
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("catch-up drains gaps larger than 100,000 events without a page cutoff", async () => {
  const highWaterCursor = 100_001;
  let requests = 0;
  let ingested = 0;
  let expectedAfter = 0;
  const fetchImpl = async (input: RequestInfo | URL) => {
    requests++;
    const url = new URL(String(input), "http://dashboard.test");
    const after = Number(url.searchParams.get("after"));
    const limit = Number(url.searchParams.get("limit"));
    assert.equal(after, expectedAfter);
    if (requests > 1) assert.equal(Number(url.searchParams.get("highWater")), highWaterCursor);
    const end = Math.min(highWaterCursor, after + limit);
    const events = Array.from({ length: end - after }, (_, index) => event(after + index + 1));
    expectedAfter = end;
    return response({ events, nextCursor: end, highWaterCursor, hasMore: end < highWaterCursor });
  };

  const result = await drainEventsAfter(0, (events) => { ingested += events.length; }, { fetchImpl: fetchImpl as typeof fetch });
  assert.equal(result.cursor, highWaterCursor);
  assert.equal(result.eventCount, highWaterCursor);
  assert.equal(result.pages, 101);
  assert.equal(requests, 101);
  assert.equal(ingested, highWaterCursor);
});

test("catch-up retries the same page with exponential backoff", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const fetchImpl = async () => {
    attempts++;
    if (attempts < 3) throw new Error("temporary network failure");
    return response({ events: [event(1)], nextCursor: 1, highWaterCursor: 1, hasMore: false });
  };

  const pages: number[][] = [];
  const result = await drainEventsAfter(0, (events) => { pages.push(events.map((item) => item.cursor!)); }, {
    fetchImpl: fetchImpl as typeof fetch,
    retryBaseMs: 10,
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });
  assert.equal(result.cursor, 1);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.deepEqual(pages, [[1]]);
});

test("catch-up rejects a cursor that advances beyond the events delivered", async () => {
  let ingested = false;
  const fetchImpl = async () => response({
    events: [event(1)],
    nextCursor: 2,
    highWaterCursor: 2,
    hasMore: false,
  });

  await assert.rejects(
    drainEventsAfter(0, () => { ingested = true; }, { fetchImpl: fetchImpl as typeof fetch }),
    /last ingested cursor/,
  );
  assert.equal(ingested, false);
});
