import type { HiveEvent, Snapshot } from "../types";
import { deleteProjectRemote, deleteSessionRemote, fetchEventsBefore } from "../api";
import { store, type AgentRef, type ConfirmState, type Scope } from "./index";

// ── ingest ───────────────────────────────────────────────────────────────────
export function ingestEvents(list: HiveEvent[]) {
  const m = { ...store.getState().eventMap };
  let changed = false;
  let maxCursor = store.getState().lastCursor;
  for (const e of list) {
    if (!e || !e.event_id) continue;
    if (e.type === "delegation_progress") continue;
    // Track the global cursor for lossless reconnect catch-up (E1), even for
    // events already seen (a duplicate still advances our high-water mark).
    if (typeof e.cursor === "number" && e.cursor > maxCursor) maxCursor = e.cursor;
    if (m[e.event_id]) continue;
    m[e.event_id] = e;
    changed = true;
  }
  const patch: Partial<{ eventMap: typeof m; lastCursor: number }> = {};
  if (changed) patch.eventMap = m;
  if (maxCursor !== store.getState().lastCursor) patch.lastCursor = maxCursor;
  if (Object.keys(patch).length) store.setState(patch);
}

export function ingestSnapshot(s: Snapshot) {
  if (!s || !s.session_id) return;
  // E3: trust the server's `topologies.active`. Phase C3 slims/normalizes
  // snapshots and rehydrates the versioned topology the session actually ran
  // under, so the old client-side active-team guess (name-matching runtime
  // agents against each team) is obsolete and removed.
  store.setState({ snapshots: { ...store.getState().snapshots, [s.session_id]: s } });
}

// Load one older page of events (K7). Anchors on the lowest cursor currently in
// the scoped set (or all events at fleet scope) and fetches the page before it.
// Returns the number of NEW events ingested (0 = reached the beginning). Bounded
// to a single page per call — no unbounded backfill.
let loadingOlder = false;
export async function loadOlderEvents(): Promise<number> {
  if (loadingOlder) return 0;
  const st = store.getState();
  const scope = st.scope;
  const pool = scope.level === "fleet" ? st.allEvents
    : scope.level === "project" ? st.allEvents.filter((e) => st.sessionsById.get(e.session_id)?.project === scope.project)
    : st.allEvents.filter((e) => e.session_id === scope.sessionId);
  // Lowest cursor in scope is the anchor. Events without a cursor (unlikely for
  // SQL-served rows) are ignored for the anchor.
  let anchor = Infinity;
  for (const e of pool) if (typeof e.cursor === "number" && e.cursor < anchor) anchor = e.cursor;
  if (!Number.isFinite(anchor)) return 0;
  loadingOlder = true;
  try {
    // Scope the backfill so we don't page in out-of-scope events (which count as
    // n>0 and advance the anchor while visibly loading nothing). Session scope →
    // that session. Project scope → the project's cwd(s): a project can span more
    // than one working dir sharing a basename, and the server's /events filter
    // takes a single cwd — so pass the one cwd when unambiguous, otherwise fetch
    // wider and filter to the project's cwd set client-side before ingesting.
    // Fleet scope → unfiltered.
    const projectCwds = scope.level === "project"
      ? Array.from(new Set(st.sessions.filter((s) => s.project === scope.project && s.cwd).map((s) => s.cwd as string)))
      : [];
    let opts: { session?: string; cwd?: string } = {};
    if (scope.level === "session") opts = { session: scope.sessionId };
    else if (scope.level === "project" && projectCwds.length === 1) opts = { cwd: projectCwds[0] };
    let older = await fetchEventsBefore(anchor, opts);
    // Multi-cwd (or cwd-less) project: the server couldn't scope by a single cwd,
    // so drop anything outside the project's cwd set here — never ingest fleet-
    // wide events under a project scope.
    if (scope.level === "project" && projectCwds.length !== 1) {
      const inScope = new Set(projectCwds);
      older = older.filter((e) => e.cwd != null && inScope.has(e.cwd));
    }
    const before = Object.keys(store.getState().eventMap).length;
    if (older.length) ingestEvents(older);
    return Object.keys(store.getState().eventMap).length - before;
  } finally {
    loadingOlder = false;
  }
}

// Drop a set of sessions from local caches (after a server-side delete or when
// the server broadcasts a hive_delete to other clients).
export function purgeLocal(ids: string[]) {
  const idSet = new Set(ids);
  const st = store.getState();
  const eventMap: Record<string, HiveEvent> = {};
  for (const [k, v] of Object.entries(st.eventMap)) if (!idSet.has(v.session_id)) eventMap[k] = v;
  const snapshots = { ...st.snapshots };
  for (const id of idSet) delete snapshots[id];
  // Drop the deleted sessions' typed delegation rows too, so the cost/token
  // series (Phase 3.1) doesn't keep counting a session that no longer exists.
  const delegations = st.delegations.filter((d) => !idSet.has(d.sessionId));
  store.setState({ eventMap, snapshots, delegations });
}

// ── delete actions ───────────────────────────────────────────────────────────
export async function deleteSession(sessionId: string): Promise<boolean> {
  const res = await deleteSessionRemote(sessionId);
  if (!res.ok) { pushToast("error", res.error || "Failed to delete session — is the dashboard still running?"); return false; }
  purgeLocal([sessionId]);
  reconcileScopeAfterDelete([sessionId]);
  pushToast("success", "Session telemetry deleted.");
  return true;
}

export async function deleteProject(project: string): Promise<boolean> {
  const ids = store.getState().sessions.filter((s) => s.project === project).map((s) => s.session_id);
  const res = await deleteProjectRemote(project);
  if (!res.ok) { pushToast("error", res.error || "Failed to delete project — is the dashboard still running?"); return false; }
  purgeLocal(ids);
  reconcileScopeAfterDelete(ids);
  pushToast("success", `Deleted ${ids.length} session${ids.length === 1 ? "" : "s"} from ${project}.`);
  return true;
}

// If the current scope pointed at something that no longer exists, fall back.
function reconcileScopeAfterDelete(removed: string[]) {
  const gone = new Set(removed);
  const st = store.getState();
  const s = st.scope;
  const sessions = st.sessions;
  if (s.level === "session" && gone.has(s.sessionId)) {
    const rest = sessions.filter((x) => x.project === s.project);
    if (rest.length) store.setState({ scope: { level: "project", project: s.project } });
    else store.setState({ scope: { level: "fleet" } });
  } else if (s.level === "project" && !sessions.some((x) => x.project === s.project)) {
    store.setState({ scope: { level: "fleet" } });
  }
  if (gone.has(st.selectedSession)) {
    const next = sessions[0];
    store.setState({ selectedSession: next ? next.session_id : "" });
  }
}

// ── scope navigation ─────────────────────────────────────────────────────────
export function selectFleet() { store.setState({ scope: { level: "fleet" } }); }
export function selectProject(project: string) { store.setState({ scope: { level: "project", project } }); }
export function selectSessionScope(sessionId: string) {
  const proj = store.getState().sessionsById.get(sessionId)?.project || "unknown";
  store.setState({ selectedSession: sessionId, scope: { level: "session", project: proj, sessionId } });
}
export function setScope(scope: Scope) { store.setState({ scope }); }
export function setSelectedSession(id: string) { store.setState({ selectedSession: id }); }

// ── misc setters ─────────────────────────────────────────────────────────────
export function setActiveTab(tab: string) { store.setState({ activeTab: tab }); }
export function setTheme(t: "dark" | "light") {
  store.setState({ theme: t });
  localStorage.setItem("hive-theme", t);
  document.documentElement.dataset.theme = t;
}
export function viewAgent(ref: AgentRef) { store.setState({ openAgent: ref }); }
export function closeAgent() { store.setState({ openAgent: null }); }

export function confirmAction(opts: NonNullable<ConfirmState>) { store.setState({ confirm: opts }); }
export function clearConfirm() { store.setState({ confirm: null }); }

// ── toasts (K1) ───────────────────────────────────────────────────────────────
let toastSeq = 0;
export function pushToast(kind: "success" | "error" | "info", message: string) {
  const id = ++toastSeq;
  store.setState({ toasts: [...store.getState().toasts, { id, kind, message }] });
  // Errors linger longer so a failure isn't missed; success/info are brief.
  setTimeout(() => dismissToast(id), kind === "error" ? 6000 : 3500);
}
export function dismissToast(id: number) {
  store.setState({ toasts: store.getState().toasts.filter((t) => t.id !== id) });
}

export function tick() { store.setState({ now: Date.now() }); }
