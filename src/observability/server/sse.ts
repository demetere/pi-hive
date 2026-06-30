import type { Subscriber } from "./types";

export const encoder = new TextEncoder();
export const subscribers = new Set<Subscriber>();

export function eventFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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

export function broadcastPing(): void {
  if (!subscribers.size) return;
  const ping = encoder.encode(": ping\n\n");
  for (const sub of Array.from(subscribers)) {
    try { sub.enqueue(ping); } catch { subscribers.delete(sub); }
  }
}
