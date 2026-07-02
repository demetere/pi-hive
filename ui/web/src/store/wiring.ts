import { fetchInitialData, fetchProjectOverrides, fetchThinking, openEventStream, saveProjectOverride } from "../api";
import { store } from "./index";
import { recomputeHeavy, recomputeLive, recomputeScoped } from "./derive";
import { ingestEvents, ingestSnapshot, purgeLocal, setSelectedSession, tick } from "./raw";
import { installRouter } from "./router";

// Fetch agent thinking for the sessions currently in scope and merge into the
// store. Thinking lives in transcripts (not the event stream), so it's polled
// separately. Bounded to the scoped sessions so a big fleet isn't all fetched.
let thinkingInFlight = false;
async function refreshThinking() {
  if (thinkingInFlight) return;
  const st = store.getState();
  const sessions = st.scopedSessions.slice(0, 6); // cap fan-out
  if (!sessions.length) return;
  thinkingInFlight = true;
  try {
    const results = await Promise.all(sessions.map(async (s) => [s.session_id, await fetchThinking(s.session_id)] as const));
    const next = new Map(store.getState().thinkingBySession);
    for (const [id, entries] of results) next.set(id, entries);
    store.setState({ thinkingBySession: next });
  } catch { /* transient */ }
  finally { thinkingInFlight = false; }
}

// Fetch project display-name overrides and recompute so labels apply everywhere.
export async function refreshOverrides() {
  const overrides = await fetchProjectOverrides();
  const map = new Map<string, string>();
  for (const o of overrides) map.set(o.cwd, o.label);
  store.setState({ projectOverrides: map });
  recomputeLive();
  recomputeScoped();
}

// Rename (label set) or reset (label empty) a project by cwd, then refresh.
export async function saveOverride(cwd: string, label: string): Promise<boolean> {
  const ok = await saveProjectOverride(cwd, label.trim());
  if (ok) await refreshOverrides();
  return ok;
}

let wired = false;
let started = false;

// Wire the recompute tiers to their raw inputs, mirroring the Solid memo graph:
//   eventMap/snapshots change → heavy tier (which cascades to live + scoped)
//   scope/selectedSession change → scoped tier only
//   now ticks → live tier only
function wire() {
  if (wired) return;
  wired = true;
  store.subscribe((s) => s.eventMap, recomputeHeavy);
  store.subscribe((s) => s.snapshots, recomputeHeavy);
  store.subscribe((s) => s.scope, recomputeScoped);
  store.subscribe((s) => s.selectedSession, recomputeScoped);
  store.subscribe((s) => s.now, recomputeLive);
  // Re-fetch thinking whenever the scoped session set changes.
  store.subscribe((s) => s.scopedSessions, () => { void refreshThinking(); });
}

// Bootstraps initial fetch + the SSE stream + the 1s tick. Idempotent so React
// 18 StrictMode's double-mount can't open two streams or two intervals.
export function connect(): EventSource | undefined {
  installRouter(); // seed scope/tab from the URL before anything renders
  wire();
  if (started) return;
  started = true;

  tick(); // seed `now`
  setInterval(tick, 1000);
  // Poll thinking on a relaxed cadence (transcripts change slower than events).
  setInterval(() => { void refreshThinking(); }, 5000);
  void refreshOverrides(); // load project display-name overrides once

  fetchInitialData().then(({ events, states }) => {
    ingestEvents(events);
    for (const snap of states) ingestSnapshot(snap);
    // Only auto-select the newest session when the URL didn't already pin one
    // (i.e. we're not on a /session/... deep link).
    if (!store.getState().selectedSession && store.getState().scope.level !== "session") {
      const first = store.getState().sessions[0];
      if (first) setSelectedSession(first.session_id);
    }
  });

  const es = openEventStream();
  // Debounce the "reconnecting" state: EventSource fires `error` on any blip and
  // auto-reconnects within a couple seconds. Only surface "reconnecting" if the
  // connection stays down past the grace window, so a momentary drop (or the
  // server's 15s heartbeat gap) doesn't flicker the badge.
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  es.addEventListener("open", () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    store.setState({ connection: "live" });
  });
  es.addEventListener("error", () => {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (es.readyState !== EventSource.OPEN) store.setState({ connection: "reconnecting" });
    }, 2500);
  });
  es.addEventListener("hive", (e) => { try { ingestEvents([JSON.parse((e as MessageEvent).data)]); } catch { /* */ } });
  es.addEventListener("hive_state", (e) => { try { ingestSnapshot(JSON.parse((e as MessageEvent).data)); } catch { /* */ } });
  es.addEventListener("hive_delete", (e) => {
    try { const { session_ids } = JSON.parse((e as MessageEvent).data); purgeLocal(session_ids || []); reconcileAfterDelete(session_ids || []); } catch { /* */ }
  });
  return es;
}

// After a remote delete broadcast, drop stale scope/selection.
function reconcileAfterDelete(removed: string[]) {
  const gone = new Set(removed);
  const st = store.getState();
  const s = st.scope;
  const sessions = st.sessions;
  if (s.level === "session" && gone.has(s.sessionId)) {
    const rest = sessions.filter((x) => x.project === s.project);
    store.setState({ scope: rest.length ? { level: "project", project: s.project } : { level: "fleet" } });
  } else if (s.level === "project" && !sessions.some((x) => x.project === s.project)) {
    store.setState({ scope: { level: "fleet" } });
  }
  if (gone.has(st.selectedSession)) {
    const next = sessions[0];
    setSelectedSession(next ? next.session_id : "");
  }
}
