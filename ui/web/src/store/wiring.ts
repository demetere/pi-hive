import { fetchInitialData, openEventStream } from "../api";
import { store } from "./index";
import { recomputeHeavy, recomputeLive, recomputeScoped } from "./derive";
import { ingestEvents, ingestSnapshot, purgeLocal, setSelectedSession, tick } from "./raw";
import { installRouter } from "./router";

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
