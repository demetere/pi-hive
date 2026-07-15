import { afterEach, expect, test } from "bun:test";
import {
  broadcastEvent,
  broadcastEventWithId,
  broadcastFrame,
  broadcastPing,
  eventFrame,
  subscribers,
} from "../src/observability/server/sse.ts";

function subscriber(options: { desiredSize?: number | null; closeThrows?: boolean; enqueueThrows?: boolean } = {}) {
  const chunks: Uint8Array[] = [];
  let closed = false;
  const controller = {
    get desiredSize() { return options.desiredSize === undefined ? 1024 : options.desiredSize; },
    enqueue(chunk: Uint8Array) {
      if (options.enqueueThrows) throw new Error("closed");
      chunks.push(chunk);
    },
    close() {
      closed = true;
      if (options.closeThrows) throw new Error("already closed");
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return { controller, chunks, isClosed: () => closed };
}

afterEach(() => subscribers.clear());

test("SSE frame helpers encode events with and without cursors", () => {
  expect(eventFrame("hive", { ok: true })).toBe('event: hive\ndata: {"ok":true}\n\n');
  expect(eventFrame("hive", { ok: true }, 7)).toStartWith("id: 7\n");

  const sub = subscriber({ desiredSize: null });
  subscribers.add(sub.controller);
  broadcastEvent("plain", { value: 1 });
  broadcastEventWithId("cursor", { value: 2 }, 9);
  expect(sub.chunks).toHaveLength(2);
  expect(new TextDecoder().decode(sub.chunks[1])).toContain("id: 9");
});

test("SSE broadcaster drops slow and closed subscribers without throwing", () => {
  const slow = subscriber({ desiredSize: 1, closeThrows: true });
  const closed = subscriber({ enqueueThrows: true });
  subscribers.add(slow.controller);
  subscribers.add(closed.controller);
  broadcastFrame('event: hive\ndata: {"large":true}\n\n');
  expect(slow.isClosed()).toBe(true);
  expect(subscribers.has(slow.controller)).toBe(false);
  expect(subscribers.has(closed.controller)).toBe(false);
});

test("SSE ping is a no-op without subscribers and bounded with subscribers", () => {
  broadcastPing();
  const sub = subscriber();
  subscribers.add(sub.controller);
  broadcastPing();
  expect(new TextDecoder().decode(sub.chunks[0])).toBe(": ping\n\n");
});
