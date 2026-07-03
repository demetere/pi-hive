import { fetchDelegations, fetchEventsAfter, fetchInitialData, fetchModels, fetchProjectOverrides, fetchSessionSummaries, fetchStates, fetchThinking, fetchTopologies, fetchTopologyDetail, openEventStream, pruneTelemetryRemote, saveProjectOverride } from "../api";
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

// Fetch typed delegation rows (deltas-only) into the store, incrementally (E2/
// Phase 3.1). Pages forward from the highest cursor already held so a refresh
// after a delegation_end frame only pulls the new rows, then appends. This is the
// authoritative, untruncated source for the cost/token history + CACHE totals.
//
// R3-2.5: page until DRAINED. A single fixed-size fetch left a DB with more delta
// rows than the page size missing its newest rows at startup (they only trickled in
// later as live frames triggered catch-ups). Keep fetching from the advancing cursor
// until a short page (< limit) proves we've reached the tail.
const DELEGATIONS_PAGE = 5000;
let delegationsInFlight = false;
export async function refreshDelegations(reset = false): Promise<void> {
  if (delegationsInFlight) return;
  delegationsInFlight = true;
  try {
    const prev = reset ? [] : store.getState().delegations;
    const seen = new Set(prev.map((d) => d.cursor));
    const merged = [...prev];
    let maxCursor = store.getState().delegationsCursor;
    let after = reset ? 0 : maxCursor;
    let addedAny = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = await fetchDelegations({ after, limit: DELEGATIONS_PAGE });
      if (!rows.length) break; // reached the tail
      const beforeCursor = after;
      for (const d of rows) {
        if (!seen.has(d.cursor)) { merged.push(d); seen.add(d.cursor); addedAny = true; }
        if (d.cursor > maxCursor) maxCursor = d.cursor;
        if (d.cursor > after) after = d.cursor;
      }
      // R4.3: keep paging as long as the cursor ADVANCES, not while pages are
      // "full". The client page size equals the server clamp (db.ts) exactly, so a
      // "rows.length < PAGE ⇒ tail" rule would silently stop after one short page if
      // the clamp were ever lowered below our request. The no-progress guard is also
      // a hard backstop: if the server ever returns rows whose cursor doesn't
      // advance past what we asked after, stop rather than spin forever.
      if (after <= beforeCursor) break;
    }
    if (!addedAny && !reset) return;
    merged.sort((a, b) => a.cursor - b.cursor);
    store.setState({ delegations: merged, delegationsCursor: maxCursor });
  } catch { /* transient; the live snapshot totals still render */ }
  finally { delegationsInFlight = false; }
}

// Fetch model capabilities once (K3). Build a lookup keyed by both the full
// "provider/modelId" and the bare modelId (lowercased) so a node's effective
// model string resolves whichever form it carries. Feeds the dial's fallback.
export async function refreshModels() {
  const models = await fetchModels();
  const map = new Map<string, string[]>();
  // Phase 6.5: also keep the full capability record (context window / cost) under
  // the same normalized keys so the UI can show model detail on hover.
  const info = new Map<string, typeof models[number]>();
  for (const m of models) {
    const id = String(m.modelId || "").toLowerCase();
    const full = `${String(m.provider || "").toLowerCase()}/${id}`;
    if (id) info.set(id, m);
    if (full !== "/") info.set(full, m);
    const levels = Array.isArray(m.thinkingLevels) ? m.thinkingLevels : [];
    if (!levels.length) continue;
    if (id) map.set(id, levels);
    if (full !== "/") map.set(full, levels);
  }
  store.setState({ modelLevels: map, modelInfo: info });
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
    await refreshDelegations(true); // rebuild deltas cache against the pruned DB
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
  // Server session list unions into the sidebar/session view (Phase 3.4), so a
  // fresh summaries fetch must re-run the heavy tier to surface event-only rows.
  store.subscribe((s) => s.sessionSummaries, recomputeHeavy);
  store.subscribe((s) => s.scope, recomputeScoped);
  store.subscribe((s) => s.selectedSession, recomputeScoped);
  // New typed delegation rows change the scoped cost/token series (Phase 3.1).
  store.subscribe((s) => s.delegations, recomputeScoped);
  store.subscribe((s) => s.now, recomputeLive);
  // W1.2 secondary: the scoped tier (Agents tab) reads the event-status overlay,
  // which demotes stale sessions using `now`. recomputeLive alone doesn't rebuild
  // scopedAgents, so a demotion wouldn't reach the Agents tab until the next
  // heavy/scope change. Re-run the scoped tier on the tick too so a stuck-"running"
  // agent flips to idle promptly. recomputeScoped is cheap relative to heavy.
  store.subscribe((s) => s.now, recomputeScoped);
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
  void refreshDelegations(true); // load typed delegation deltas for cost/token series
  void refreshModels(); // load model capabilities for the thinking dial (K3)

  const initialFetch = fetchInitialData().then(({ events, states, cursor }) => {
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
  // Phase 6.2: the server's `hello` frame carries the stream-tail cursor. On the
  // FIRST connect, events can land between fetchInitialData() and the SSE
  // subscription; if the hello cursor is ahead of our high-water mark, gap-fetch
  // the difference so that fetch-vs-subscribe window is not silently lost. On
  // reconnects the open-handler resync already covers this, so only act when the
  // server is genuinely ahead.
  es.addEventListener("hello", (e) => {
    try {
      const { cursor } = JSON.parse((e as MessageEvent).data) as { cursor?: number };
      if (typeof cursor !== "number") return;
      // W1.3: the hello frame can arrive BEFORE fetchInitialData() resolves. Acting
      // on it then would gap-fetch from lastCursor=0 — the entire unbounded history
      // into the client eventMap. Wait for the initial fetch to seed lastCursor
      // first, then re-read it and only fetch the genuine tail gap. event_id dedup
      // makes the small overlap with the initial page harmless. On reconnect the
      // open-handler resync already covers the gap, so this only fires meaningfully
      // when the server is genuinely ahead of our seeded high-water mark.
      void initialFetch.then(() => {
        const from = store.getState().lastCursor;
        if (cursor <= from) return;
        return fetchEventsAfter(from).then(({ events, cursor: c }) => {
          if (events.length) ingestEvents(events);
          if (c > store.getState().lastCursor) store.setState({ lastCursor: c });
          if (events.some((ev) => ev.type === "delegation_end")) scheduleDelegationsRefresh();
        });
      });
    } catch { /* */ }
  });
  es.addEventListener("hive", (e) => {
    try {
      const ev = JSON.parse((e as MessageEvent).data);
      ingestEvents([ev]);
      // A completed delegation added a new typed row — pull it (debounced so a
      // burst of concurrent finishes triggers one catch-up fetch, not N).
      if (ev?.type === "delegation_end") scheduleDelegationsRefresh();
      // Model capabilities have one dashboard source of truth: /models. A
      // delegation_start may carry SDK-probed thinking levels that supersede the
      // registry catalog, so refresh the lookup when capability-bearing events
      // arrive instead of leaving boot-time metadata stale.
      if (ev?.type === "model_catalog" || (ev?.type === "delegation_start" && Array.isArray(ev?.payload?.thinkingLevels))) {
        void refreshModels();
      }
    } catch { /* */ }
  });
  es.addEventListener("hive_state", (e) => { try { ingestSnapshot(JSON.parse((e as MessageEvent).data)); } catch { /* */ } });
  es.addEventListener("hive_delete", (e) => {
    try { const { session_ids } = JSON.parse((e as MessageEvent).data); purgeLocal(session_ids || []); reconcileAfterDelete(session_ids || []); } catch { /* */ }
  });
  return es;
}

// Debounce delegation refetches: a wave of concurrent worker finishes emits many
// delegation_end frames in quick succession; coalesce them into one catch-up.
let delegationsRefreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleDelegationsRefresh() {
  if (delegationsRefreshTimer) return;
  delegationsRefreshTimer = setTimeout(() => {
    delegationsRefreshTimer = undefined;
    void refreshDelegations();
  }, 800);
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
    void refreshDelegations(); // catch up any delegations completed during the gap
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
