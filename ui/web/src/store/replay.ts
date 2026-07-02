import { fetchSessionEvents } from "../api";
import { store, type ReplayState } from "./index";
import type { HiveEvent } from "../types";

// Replay controller (Phase F). A self-contained slice: entering replay pages the
// whole session history into a local buffer; the scrubber moves `cursor` over
// that buffer; play/pause advances it by wall-clock deltas at 1×/10×/60×. No SSE
// frame ever touches this slice, so the live view is unaffected.

function setReplay(patch: Partial<ReplayState>) {
  store.setState({ replay: { ...store.getState().replay, ...patch } });
}

let playTimer: ReturnType<typeof setInterval> | undefined;

function stopTimer() {
  if (playTimer) { clearInterval(playTimer); playTimer = undefined; }
}

export async function enterReplay(sessionId: string) {
  stopTimer();
  setReplay({ active: true, sessionId, events: [], loading: true, loadedCount: 0, cursor: 0, playing: false, speed: 1, truncatedStart: false });
  const events = await fetchSessionEvents(sessionId, (n) => setReplay({ loadedCount: n }));
  // Guard against a session switch mid-load.
  if (store.getState().replay.sessionId !== sessionId) return;
  // F3: compare fetched count against the session's recorded event_count; a
  // shortfall means early history was pruned.
  const recorded = store.getState().sessionsById.get(sessionId)?.event_count ?? events.length;
  const truncatedStart = events.length < recorded;
  setReplay({ events, loading: false, cursor: events.length ? events.length - 1 : 0, truncatedStart });
}

export function exitReplay() {
  stopTimer();
  setReplay({ active: false, playing: false, events: [], loadedCount: 0, cursor: 0 });
}

export function seekReplay(cursor: number) {
  const { events } = store.getState().replay;
  const clamped = Math.max(0, Math.min(events.length - 1, cursor));
  setReplay({ cursor: clamped });
}

export function setReplaySpeed(speed: 1 | 10 | 60) {
  setReplay({ speed });
  if (store.getState().replay.playing) { pauseReplay(); playReplay(); }
}

// Advance by real elapsed time × speed, stepping the cursor to the last event
// whose timestamp is ≤ the virtual playhead. Pauses at the end.
export function playReplay() {
  const r = store.getState().replay;
  if (!r.events.length) return;
  if (r.cursor >= r.events.length - 1) setReplay({ cursor: 0 }); // restart from the top
  stopTimer();
  setReplay({ playing: true });
  const tickMs = 200;
  playTimer = setInterval(() => {
    const s = store.getState().replay;
    if (!s.playing || !s.events.length) { stopTimer(); return; }
    const cur = s.events[s.cursor];
    const virtualAdvance = tickMs * s.speed;
    const targetTs = new Date(cur.ts).getTime() + virtualAdvance;
    let next = s.cursor;
    while (next < s.events.length - 1 && new Date(s.events[next + 1].ts).getTime() <= targetTs) next++;
    // Always progress at least one event so a burst of same-timestamp events
    // doesn't stall the playhead.
    if (next === s.cursor && s.cursor < s.events.length - 1) next = s.cursor + 1;
    if (next >= s.events.length - 1) { setReplay({ cursor: s.events.length - 1, playing: false }); stopTimer(); return; }
    setReplay({ cursor: next });
  }, tickMs);
}

export function pauseReplay() {
  stopTimer();
  setReplay({ playing: false });
}

// The event slice up to (and including) the current cursor — what every replayed
// derivation (status/feed/chart) consumes.
export function replayedEvents(): HiveEvent[] {
  const { events, cursor } = store.getState().replay;
  return events.slice(0, cursor + 1);
}
