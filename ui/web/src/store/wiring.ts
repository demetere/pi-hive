import { fetchEventsAfter, fetchInitialData, fetchModels, fetchProjectOverrides, fetchSessionSummaries, fetchStates, fetchThinking, fetchTopologies, fetchTopologyDetail, openEventStream, pruneTelemetryRemote, saveProjectOverride } from "../api";
import { store } from "./index";
import { recomputeHeavy, recomputeLive, recomputeScoped } from "./derive";
import { ingestEvents, ingestSnapshot, purgeLocal, pushToast, setSelectedSession, tick } from "./raw";
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

// Fetch server-authoritative session summaries (true event_count + topologyHash)
// into the store. Refreshed at boot and after each reconnect so the pruned-
// history marker (I4) and topology-version chips (K2) reflect the DB, not the
// locally-loaded event window.
export async function refreshSessionSummaries() {
  const summaries = await fetchSessionSummaries();
  const map = new Map(summaries.map((s) => [s.session_id, s]));
  store.setState({ sessionSummaries: map });
}

// Fetch model capabilities once (K3). Build a lookup keyed by both the full
// "provider/modelId" and the bare modelId (lowercased) so a node's effective
// model string resolves whichever form it carries. Feeds the dial's fallback.
export async function refreshModels() {
  const models = await fetchModels();
  const map = new Map<string, string[]>();
  for (const m of models) {
    const levels = Array.isArray(m.thinkingLevels) ? m.thinkingLevels : [];
    if (!levels.length) continue;
    const id = String(m.modelId || "").toLowerCase();
    const full = `${String(m.provider || "").toLowerCase()}/${id}`;
    if (id) map.set(id, levels);
    if (full !== "/") map.set(full, levels);
  }
  store.setState({ modelLevels: map });
}

// Fetch the versioned topology list for a cwd into the store cache (K2). Skips
// the fetch if already cached (versions are immutable; new ones arrive via a new
// hash on the session summary, which triggers a refresh).
export async function refreshTopologies(cwd: string) {
  if (!cwd || store.getState().topologiesByCwd.has(cwd)) return;
  const list = await fetchTopologies(cwd);
  const next = new Map(store.getState().topologiesByCwd);
  next.set(cwd, list);
  store.setState({ topologiesByCwd: next });
}

// Fetch and cache one reassembled topology tree by hash (K2/K5). Idempotent.
export async function ensureTopologyDetail(hash: string) {
  if (!hash || store.getState().topologyByHash.has(hash)) return;
  const detail = await fetchTopologyDetail(hash);
  if (!detail) return;
  const next = new Map(store.getState().topologyByHash);
  next.set(hash, detail);
  store.setState({ topologyByHash: next });
}

// Prune telemetry older than N days via the daemon (K1 Settings action).
export async function pruneTelemetry(olderThanDays: number): Promise<boolean> {
  const res = await pruneTelemetryRemote(olderThanDays);
  if (res.ok) {
    pushToast("success", `Pruned ${res.events ?? 0} events and ${res.sessions ?? 0} session${res.sessions === 1 ? "" : "s"}.`);
    // Refresh authoritative counts + summaries so the UI reflects the smaller DB.
    await refreshSessionSummaries();
    return true;
  }
  pushToast("error", res.error || "Prune failed — is the dashboard still running?");
  return false;
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
  const res = await saveProjectOverride(cwd, label.trim());
  if (res.ok) { await refreshOverrides(); pushToast("success", label.trim() ? "Project renamed." : "Project name reset."); }
  else pushToast("error", res.error || "Failed to save project name — is the dashboard still running?");
  return res.ok;
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
  // Prime the versioned-topology cache for the cwds in scope (K2), so version
  // chips render without a per-chip fetch. Cached per cwd, so this is cheap.
  store.subscribe((s) => s.scopedSessions, (sessions) => {
    const cwds = new Set(sessions.map((x) => x.cwd).filter((c): c is string => !!c));
    for (const cwd of cwds) void refreshTopologies(cwd);
  });
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
  void refreshSessionSummaries(); // load server-authoritative event counts
  void refreshModels(); // load model capabilities for the thinking dial (K3)

  fetchInitialData().then(({ events, states, cursor }) => {
    ingestEvents(events);
    for (const snap of states) ingestSnapshot(snap);
    // Seed the cursor high-water mark even if the recent-events page didn't
    // include the very latest rowid, so reconnect catch-up starts correctly.
    if (cursor > store.getState().lastCursor) store.setState({ lastCursor: cursor });
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
  let hadConnection = false;
  es.addEventListener("open", () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    // Each connection attempt gets a generation stamp. Only the resync launched
    // for the CURRENT generation may flip to "live" — so a drop mid-resync (which
    // bumps the generation and sets "reconnecting") or a second reconnect whose
    // resync short-circuits on the in-flight guard cannot overwrite a legitimate
    // "reconnecting"/"syncing" state (M6).
    const gen = ++connectionGen;
    // On a RE-connect (not the first open), catch up on the exact gap using the
    // global cursor (E1): fetch every event after our high-water mark plus fresh
    // snapshots, THEN flip to live. This heals stuck "running/waiting" agents and
    // never loses events during a disconnect — no refetch-the-world. Hold
    // "syncing" until the gap-fetch resolves (K7) so the badge doesn't claim
    // "live" over stale data during the async catch-up window.
    if (hadConnection) {
      store.setState({ connection: "syncing" });
      void resyncAfterReconnect().then((ran) => {
        // Only the resync that actually performed the catch-up may declare "live",
        // and only if no newer connection attempt superseded it (M6). A resync
        // that short-circuited because an earlier one is still in flight returns
        // false and does nothing — that earlier resync owns the live flip.
        if (ran && gen === connectionGen) store.setState({ connection: "live" });
      });
    } else {
      store.setState({ connection: "live" });
    }
    hadConnection = true;
  });
  es.addEventListener("error", () => {
    // EventSource fires `error` on transient blips even while the socket stays up
    // (and on the heartbeat gap). Only a genuine drop (readyState CLOSED, or
    // CONNECTING while it auto-reconnects) invalidates an in-flight resync's claim
    // to "live" (M6) — a spurious error over a still-OPEN stream must not cancel a
    // healthy resync's live flip (there'd be no follow-up `open` to recover it).
    if (es.readyState !== EventSource.OPEN) connectionGen++;
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

// Lossless SSE catch-up after a reconnect (E1). Fetch the exact gap since our
// last-seen cursor plus the current snapshots, then ingest. Best-effort: any
// failure leaves the live stream to carry on.
let resyncInFlight = false;
// Monotonic connection-attempt stamp; guards which resync may declare "live" (M6).
let connectionGen = 0;
// Returns true when it actually ran the catch-up, false when it short-circuited
// because an earlier resync is still in flight (so the caller must NOT flip to
// "live" — the in-flight resync will when it finishes).
async function resyncAfterReconnect(): Promise<boolean> {
  if (resyncInFlight) return false;
  resyncInFlight = true;
  try {
    const cursor = store.getState().lastCursor;
    const [{ events }, states] = await Promise.all([fetchEventsAfter(cursor), fetchStates()]);
    if (events.length) ingestEvents(events);
    for (const snap of states) ingestSnapshot(snap);
    void refreshSessionSummaries(); // event counts may have advanced during the gap
  } catch { /* transient; the live stream continues */ }
  finally { resyncInFlight = false; }
  return true;
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
