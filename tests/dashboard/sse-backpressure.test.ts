import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { broadcastFrame, subscribers } from "../../src/observability/server/sse.ts";

function subscriber(desiredSize: number) {
  const chunks: Uint8Array[] = [];
  let closed = false;
  const controller = {
    get desiredSize() { return desiredSize; },
    enqueue(chunk: Uint8Array) { chunks.push(chunk); },
    close() { closed = true; },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return { controller, chunks, isClosed: () => closed };
}

afterEach(() => subscribers.clear());

test("SSE broadcaster enqueues while byte capacity remains", () => {
  const sub = subscriber(1024);
  subscribers.add(sub.controller);
  broadcastFrame("event: hive\ndata: {}\n\n");
  assert.equal(sub.chunks.length, 1);
  assert.equal(sub.isClosed(), false);
  assert.equal(subscribers.has(sub.controller), true);
});

test("SSE broadcaster disconnects a slow subscriber before queue growth", () => {
  const sub = subscriber(4);
  subscribers.add(sub.controller);
  broadcastFrame("event: hive\ndata: {\"payload\":\"too large\"}\n\n");
  assert.equal(sub.chunks.length, 0);
  assert.equal(sub.isClosed(), true);
  assert.equal(subscribers.has(sub.controller), false);
});
