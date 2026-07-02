import type { Subscriber } from "./types";

export const encoder = new TextEncoder();
export const subscribers = new Set<Subscriber>();

export function eventFrame(event: string, data: unknown, id?: number): string {
  const idLine = id != null ? `id: ${id}\n` : "";
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function broadcastFrame(frame: string): void {
  const encoded = encoder.encode(frame);
  for (const sub of Array.from(subscribers)) {
    try { sub.enqueue(encoded); } catch { subscribers.delete(sub); }
  }
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
  for (const sub of Array.from(subscribers)) {
    try { sub.enqueue(ping); } catch { subscribers.delete(sub); }
  }
}
