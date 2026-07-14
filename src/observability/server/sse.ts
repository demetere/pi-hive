import type { Subscriber } from "./types";

export const encoder = new TextEncoder();
export const subscribers = new Set<Subscriber>();
// Each browser stream may queue at most this many bytes. A slow client is
// disconnected and catches up from SQLite by cursor on reconnect rather than
// growing the daemon heap without bound.
export const SSE_BUFFER_BYTES = 256 * 1024;

export function eventFrame(event: string, data: unknown, id?: number): string {
  const idLine = id != null ? `id: ${id}\n` : "";
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function enqueueBounded(sub: Subscriber, encoded: Uint8Array): void {
  const available = sub.desiredSize;
  if (available != null && available < encoded.byteLength) {
    try { sub.close(); } catch { /* already closed */ }
    subscribers.delete(sub);
    return;
  }
  try { sub.enqueue(encoded); }
  catch { subscribers.delete(sub); }
}

export function broadcastFrame(frame: string): void {
  const encoded = encoder.encode(frame);
  for (const sub of Array.from(subscribers)) enqueueBounded(sub, encoded);
}

export function broadcastEvent(event: string, data: unknown): void {
  broadcastFrame(eventFrame(event, data));
}

// Broadcast an event frame carrying its global cursor as the SSE `id:` — clients
// track it to request an exact, lossless catch-up (?after=<id>) on reconnect (B5).
export function broadcastEventWithId(event: string, data: unknown, id: number): void {
  broadcastFrame(eventFrame(event, data, id));
}

export function broadcastPing(): void {
  if (!subscribers.size) return;
  const ping = encoder.encode(": ping\n\n");
  for (const sub of Array.from(subscribers)) enqueueBounded(sub, ping);
}
