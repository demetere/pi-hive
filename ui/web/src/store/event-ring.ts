import type { HiveEvent } from "../types";

// The live dashboard only needs a bounded recent event window. Full history stays
// authoritative in SQLite and is fetched explicitly for replay or older pages.
export const LIVE_EVENT_CAPACITY = 10_000;

function eventOrder(event: HiveEvent): number {
  if (typeof event.cursor === "number" && Number.isFinite(event.cursor)) return event.cursor;
  const timestamp = Date.parse(String(event.ts || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/** A cursor-ordered, id-deduplicated ring retaining the newest events. */
export class EventRing {
  readonly capacity: number;
  private readonly byId = new Map<string, HiveEvent>();
  private ordered: HiveEvent[] = [];
  private start = 0;

  constructor(capacity = LIVE_EVENT_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  get size(): number { return this.byId.size; }
  get full(): boolean { return this.size >= this.capacity; }

  has(eventId: string): boolean { return this.byId.has(eventId); }

  // Fast path for the normal live case is O(1): cursors arrive in ascending
  // order, append at the tail, and evict one item from the logical head.
  add(event: HiveEvent): boolean {
    if (!event?.event_id || this.byId.has(event.event_id)) return false;
    const first = this.ordered[this.start];
    const last = this.ordered[this.ordered.length - 1];
    const order = eventOrder(event);

    // An older-history page cannot displace newer live telemetry once the ring
    // is full. The caller may still retrieve complete history through replay.
    if (first && this.full && order <= eventOrder(first)) return false;

    if (!last || order >= eventOrder(last)) {
      this.ordered.push(event);
    } else if (first && order <= eventOrder(first)) {
      if (this.start > 0) this.ordered[--this.start] = event;
      else this.ordered.unshift(event);
    } else {
      let low = this.start;
      let high = this.ordered.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (eventOrder(this.ordered[middle]) <= order) low = middle + 1;
        else high = middle;
      }
      this.ordered.splice(low, 0, event);
    }
    this.byId.set(event.event_id, event);
    this.trim();
    return this.byId.has(event.event_id);
  }

  addAll(events: HiveEvent[]): number {
    let added = 0;
    for (const event of events) if (this.add(event)) added++;
    return added;
  }

  values(): HiveEvent[] {
    return this.ordered.slice(this.start);
  }

  removeSessions(sessionIds: Set<string>): number {
    if (!sessionIds.size) return 0;
    const kept = this.values().filter((event) => !sessionIds.has(event.session_id));
    const removed = this.size - kept.length;
    if (!removed) return 0;
    this.ordered = kept;
    this.start = 0;
    this.byId.clear();
    for (const event of kept) this.byId.set(event.event_id, event);
    return removed;
  }

  private trim(): void {
    while (this.byId.size > this.capacity) {
      const oldest = this.ordered[this.start++];
      if (oldest) this.byId.delete(oldest.event_id);
    }
    // Keep the backing array bounded too; Array.shift() on every live event would
    // be O(n), so compact only after enough logical-head advancement.
    if (this.start >= this.capacity) {
      this.ordered = this.ordered.slice(this.start);
      this.start = 0;
    }
  }
}
