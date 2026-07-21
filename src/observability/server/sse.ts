import type { Subscriber } from "./types";

export const encoder = new TextEncoder();
export const subscribers = new Set<Subscriber>();
export const workflowSubscribers = new Set<Subscriber>();
// Each browser stream may queue at most this many bytes. A slow client is
// disconnected and catches up from SQLite by cursor on reconnect rather than
// growing the daemon heap without bound.
export const SSE_BUFFER_BYTES = 256 * 1024;
export const SSE_MAX_SUBSCRIBERS = 64;
export const SSE_CONNECTION_IDLE_MS = 60_000;
export const SSE_CONNECTION_LIFETIME_MS = 5 * 60_000;

export interface WorkflowStreamTimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}
export interface WorkflowStreamLimits {
  readonly bufferBytes?: number;
  readonly maxSubscribers?: number;
  readonly idleMs?: number;
  readonly lifetimeMs?: number;
  readonly scheduler?: WorkflowStreamTimerScheduler;
}

type SubscriberChannel = "legacy" | "workflow";
interface Subscription {
  readonly channel: SubscriberChannel;
  readonly lifetimeTimer: unknown;
  readonly limits: Required<Pick<WorkflowStreamLimits, "maxSubscribers" | "idleMs" | "lifetimeMs">> & Readonly<{ scheduler: WorkflowStreamTimerScheduler }>;
  idleTimer: unknown;
}
const subscriptions = new Map<Subscriber, Subscription>();
const defaultScheduler: WorkflowStreamTimerScheduler = Object.freeze({
  setTimeout(callback: () => void, delayMs: number) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimeout(timer: unknown) { clearTimeout(timer as ReturnType<typeof setTimeout>); },
});

function effectiveLimits(input: WorkflowStreamLimits | undefined): Subscription["limits"] {
  const maxSubscribers = input?.maxSubscribers ?? SSE_MAX_SUBSCRIBERS;
  const idleMs = input?.idleMs ?? SSE_CONNECTION_IDLE_MS;
  const lifetimeMs = input?.lifetimeMs ?? SSE_CONNECTION_LIFETIME_MS;
  const bufferBytes = input?.bufferBytes ?? SSE_BUFFER_BYTES;
  if (!Number.isSafeInteger(maxSubscribers) || maxSubscribers < 1 || maxSubscribers > SSE_MAX_SUBSCRIBERS
    || !Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > SSE_CONNECTION_IDLE_MS
    || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > SSE_CONNECTION_LIFETIME_MS
    || !Number.isSafeInteger(bufferBytes) || bufferBytes < 1 || bufferBytes > SSE_BUFFER_BYTES) throw new Error("Workflow stream limits are invalid");
  return Object.freeze({ maxSubscribers, idleMs, lifetimeMs, scheduler: input?.scheduler ?? defaultScheduler });
}

export function eventFrame(event: string, data: unknown, id?: number | string): string {
  const idLine = id != null ? `id: ${id}\n` : "";
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function channelSet(channel: SubscriberChannel): Set<Subscriber> {
  return channel === "workflow" ? workflowSubscribers : subscribers;
}

export function removeSubscriber(sub: Subscriber): void {
  subscribers.delete(sub);
  workflowSubscribers.delete(sub);
  const subscription = subscriptions.get(sub);
  if (!subscription) return;
  subscription.limits.scheduler.clearTimeout(subscription.idleTimer);
  subscription.limits.scheduler.clearTimeout(subscription.lifetimeTimer);
  subscriptions.delete(sub);
}

function closeSubscriber(sub: Subscriber): void {
  try { sub.close(); } catch { /* already closed */ }
  removeSubscriber(sub);
}

function idleTimer(sub: Subscriber, limits: Subscription["limits"]): unknown {
  return limits.scheduler.setTimeout(() => closeSubscriber(sub), limits.idleMs);
}

function touchSubscriber(sub: Subscriber): void {
  const subscription = subscriptions.get(sub);
  if (!subscription) return;
  subscription.limits.scheduler.clearTimeout(subscription.idleTimer);
  subscription.idleTimer = idleTimer(sub, subscription.limits);
}

export function registerSubscriber(channel: SubscriberChannel, sub: Subscriber, input?: WorkflowStreamLimits): boolean {
  const limits = effectiveLimits(input);
  if (subscriptions.size >= limits.maxSubscribers || subscriptions.has(sub)) return false;
  const lifetimeTimer = limits.scheduler.setTimeout(() => closeSubscriber(sub), limits.lifetimeMs);
  subscriptions.set(sub, { channel, lifetimeTimer, limits, idleTimer: idleTimer(sub, limits) });
  channelSet(channel).add(sub);
  return true;
}

export function hasLiveSubscribers(): boolean {
  return subscribers.size > 0 || workflowSubscribers.size > 0;
}

export type WorkflowMaintenanceResyncReason = "projection-rebuild" | "projection-prune";

export function invalidateWorkflowSubscribers(reason: WorkflowMaintenanceResyncReason): void {
  const encoded = encoder.encode(eventFrame("resync-required", { apiVersion: 1, reason, history: "/api/v1/history" }));
  for (const sub of [...workflowSubscribers]) {
    enqueueBounded(sub, encoded);
    closeSubscriber(sub);
  }
}

export function closeWorkflowSubscribers(): void {
  for (const sub of [...workflowSubscribers]) closeSubscriber(sub);
}

export function closeAllSubscribers(): void {
  for (const sub of [...subscriptions.keys()]) closeSubscriber(sub);
}

export function enqueueBounded(sub: Subscriber, encoded: Uint8Array): boolean {
  const available = sub.desiredSize;
  if (available != null && available < encoded.byteLength) {
    closeSubscriber(sub);
    return false;
  }
  try {
    sub.enqueue(encoded);
    touchSubscriber(sub);
    return true;
  } catch {
    removeSubscriber(sub);
    return false;
  }
}

export function broadcastFrame(frame: string): void {
  const encoded = encoder.encode(frame);
  for (const sub of Array.from(subscribers)) enqueueBounded(sub, encoded);
}

export function broadcastEvent(event: string, data: unknown): void {
  broadcastFrame(eventFrame(event, data));
}

// Broadcast an event frame carrying its global cursor as the SSE `id:` — clients
// track it to request an exact, lossless catch-up on reconnect.
export function broadcastEventWithId(event: string, data: unknown, id: number): void {
  broadcastFrame(eventFrame(event, data, id));
}

export function broadcastWorkflowEvent(data: unknown, cursor: string): void {
  const encoded = encoder.encode(eventFrame("workflow", data, cursor));
  for (const sub of Array.from(workflowSubscribers)) enqueueBounded(sub, encoded);
}

export function broadcastPing(): void {
  if (!subscribers.size && !workflowSubscribers.size) return;
  const ping = encoder.encode(": ping\n\n");
  for (const sub of [...subscribers, ...workflowSubscribers]) enqueueBounded(sub, ping);
}
