import type { SessionView } from "../types";

// Persistent identity map: SessionView objects are reused across recomputes and
// mutated in place. This keeps each row/node's object reference STABLE so a
// keyed <Row> selector can detect value changes via its version counter without
// the whole list re-rendering. `updatedAt` is tracked separately so the live
// memo can derive freshness without the heavy sessions recompute depending on
// the 1s tick.
export const sessionStore = new Map<string, SessionView>();
export const sessionUpdatedAt = new Map<string, number>();
