import type { HiveEvent, Snapshot } from "../types";
import { deleteProjectRemote, deleteSessionRemote } from "../api";
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

// Drop a set of sessions from local caches (after a server-side delete or when
// the server broadcasts a hive_delete to other clients).
export function purgeLocal(ids: string[]) {
  const idSet = new Set(ids);
  const st = store.getState();
  const eventMap: Record<string, HiveEvent> = {};
  for (const [k, v] of Object.entries(st.eventMap)) if (!idSet.has(v.session_id)) eventMap[k] = v;
  const snapshots = { ...st.snapshots };
  for (const id of idSet) delete snapshots[id];
  store.setState({ eventMap, snapshots });
}

// ── delete actions ───────────────────────────────────────────────────────────
export async function deleteSession(sessionId: string): Promise<boolean> {
  if (!await deleteSessionRemote(sessionId)) return false;
  purgeLocal([sessionId]);
  reconcileScopeAfterDelete([sessionId]);
  return true;
}

export async function deleteProject(project: string): Promise<boolean> {
  const ids = store.getState().sessions.filter((s) => s.project === project).map((s) => s.session_id);
  if (!await deleteProjectRemote(project)) return false;
  purgeLocal(ids);
  reconcileScopeAfterDelete(ids);
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

export function tick() { store.setState({ now: Date.now() }); }
