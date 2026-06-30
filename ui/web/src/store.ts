import { createMemo, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { AgentRuntime, HiveEvent, ProjectGroup, SessionView, Snapshot } from "./types";
import { deleteProjectRemote, deleteSessionRemote, fetchInitialData, openEventStream } from "./api";
import { projectName, sessionSlug } from "./lib/format";
import { buildHistoryBySession, historyTotals as totalsFromHistory } from "./store/history";
import { buildEventStatus } from "./store/status";
import { buildAgents, flattenTopology } from "./store/topology";

// ── raw reactive state ─────────────────────────────────────────────────────
// events keyed by id (dedup); snapshots keyed by session.
const [eventMap, setEventMap] = createStore<Record<string, HiveEvent>>({});
const [snapshots, setSnapshots] = createStore<Record<string, Snapshot>>({});
const [connection, setConnection] = createSignal<"connecting" | "live" | "reconnecting">("connecting");
const [selectedSession, setSelectedSession] = createSignal<string>("");
const [activeTab, setActiveTab] = createSignal<string>("overview");

// ── scope: fleet (all projects) | project (one project, its sessions
// aggregated) | session (one session detail). The tabs render within whatever
// scope is selected.
export type Scope =
  | { level: "fleet" }
  | { level: "project"; project: string }
  | { level: "session"; project: string; sessionId: string };
const [scope, setScopeSig] = createSignal<Scope>({ level: "fleet" });
export { scope };

// Agent log viewer target: which agent's transcript to show in the modal.
export interface AgentRef { sessionId: string; name: string; color?: string; status?: string; model?: string; }
const [openAgent, setOpenAgent] = createSignal<AgentRef | null>(null);
export { openAgent };
export function viewAgent(ref: AgentRef) { setOpenAgent(ref); }
export function closeAgent() { setOpenAgent(null); }

export function selectFleet() { setScopeSig({ level: "fleet" }); }
export function selectProject(project: string) { setScopeSig({ level: "project", project }); }
export function selectSessionScope(sessionId: string) {
  const proj = sessionsById().get(sessionId)?.project || "unknown";
  setSelectedSession(sessionId);
  setScopeSig({ level: "session", project: proj, sessionId });
}
const [theme, setThemeSig] = createSignal<"dark" | "light">(
  (localStorage.getItem("hive-theme") as "dark" | "light") || "dark",
);
// `now` ticks every second so relative times stay fresh.
const [now, setNow] = createSignal(Date.now());
setInterval(() => setNow(Date.now()), 1000);

export { connection, selectedSession, setSelectedSession, activeTab, setActiveTab, theme, now };

export function setTheme(t: "dark" | "light") {
  setThemeSig(t);
  localStorage.setItem("hive-theme", t);
  document.documentElement.dataset.theme = t;
}
document.documentElement.dataset.theme = theme();

// A session is "live" if its snapshot updated within this window.
// A running agent that hasn't updated in this long is treated as stale (its
// process likely died without a final delegation_end), so it stops counting as
// live. Generous because events keep an active session's timestamp fresh.
const STALE_LIVE_MS = 5 * 60_000;

function ingestEvents(list: HiveEvent[]) {
  setEventMap(produce((m) => {
    for (const e of list) {
      if (!e || !e.event_id) continue;
      if (e.type === "delegation_progress") continue;
      if (m[e.event_id]) continue;
      m[e.event_id] = e;
    }
  }));
}

function ingestSnapshot(s: Snapshot) {
  if (!s || !s.session_id) return;
  setSnapshots(s.session_id, s);
}

// Drop a set of sessions from local caches (used after a server-side delete and
// when the server broadcasts a hive_delete to other clients).
function purgeLocal(ids: string[]) {
  const idSet = new Set(ids);
  setEventMap(produce((m) => { for (const k of Object.keys(m)) if (idSet.has(m[k].session_id)) delete m[k]; }));
  setSnapshots(produce((m) => { for (const id of idSet) delete m[id]; }));
}

// ── delete actions ─────────────────────────────────────────────────────────
export async function deleteSession(sessionId: string): Promise<boolean> {
  if (!await deleteSessionRemote(sessionId)) return false;
  purgeLocal([sessionId]);
  reconcileScopeAfterDelete([sessionId]);
  return true;
}

export async function deleteProject(project: string): Promise<boolean> {
  const ids = sessions().filter((s) => s.project === project).map((s) => s.session_id);
  if (!await deleteProjectRemote(project)) return false;
  purgeLocal(ids);
  reconcileScopeAfterDelete(ids);
  return true;
}

// If the current scope pointed at something that no longer exists, fall back.
function reconcileScopeAfterDelete(removed: string[]) {
  const gone = new Set(removed);
  const s = scope();
  if (s.level === "session" && gone.has(s.sessionId)) {
    const rest = sessions().filter((x) => x.project === s.project);
    if (rest.length) setScopeSig({ level: "project", project: s.project });
    else setScopeSig({ level: "fleet" });
  } else if (s.level === "project" && !sessions().some((x) => x.project === s.project)) {
    setScopeSig({ level: "fleet" });
  }
  if (gone.has(selectedSession())) {
    const next = sessions()[0];
    setSelectedSession(next ? next.session_id : "");
  }
}

// ── live wiring ────────────────────────────────────────────────────────────
export function connect() {
  fetchInitialData().then(({ events, states }) => {
    ingestEvents(events);
    for (const snap of states) ingestSnapshot(snap);
    if (!selectedSession()) {
      const first = sessions()[0];
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
    setConnection("live");
  });
  es.addEventListener("error", () => {
    // readyState CONNECTING(0) means it's already retrying; give it a moment.
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (es.readyState !== EventSource.OPEN) setConnection("reconnecting");
    }, 2500);
  });
  es.addEventListener("hive", (e) => { try { ingestEvents([JSON.parse((e as MessageEvent).data)]); } catch { /* */ } });
  es.addEventListener("hive_state", (e) => { try { ingestSnapshot(JSON.parse((e as MessageEvent).data)); } catch { /* */ } });
  es.addEventListener("hive_delete", (e) => {
    try { const { session_ids } = JSON.parse((e as MessageEvent).data); purgeLocal(session_ids || []); reconcileScopeAfterDelete(session_ids || []); } catch { /* */ }
  });
  return es;
}

// ── derived view models ────────────────────────────────────────────────────
const allEvents = createMemo(() => {
  const arr = Object.values(eventMap);
  arr.sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || (a.seq || 0) - (b.seq || 0));
  return arr;
});
export { allEvents };

const historyBySession = createMemo(() => buildHistoryBySession(allEvents()));

export const eventStatus = createMemo(() => buildEventStatus(allEvents()));

function eventStatusFor(sessionId: string): Map<string, string> {
  return eventStatus().get(sessionId) || new Map();
}

// The authoritative live status for an agent: event-driven status wins (instant,
// same channel as the activity feed); falls back to the snapshot status. Read
// this directly wherever a node/row needs its current status so the value is
// never stale relative to the event stream.
export function agentStatus(sessionId: string, name: string, snapshotStatus?: string): string {
  return eventStatusFor(sessionId).get(name) || snapshotStatus || "idle";
}

// Persistent identity map: SessionView objects are reused across recomputes and
// mutated in place. This keeps each row/node's object reference STABLE so Solid's
// <For> never tears down and recreates a row on data updates — which is what was
// restarting hover/pulse/edge animations on every event.
const sessionStore = new Map<string, SessionView>();
// `updatedAt` is tracked separately from the SessionView so the live-status memo
// can derive freshness without the heavy sessions memo depending on the 1s tick.
const sessionUpdatedAt = new Map<string, number>();

// Sessions assembled from events + snapshots. Recomputes ONLY when events or
// snapshots change — NOT on the 1s `now` tick. Newest activity first.
export const sessions = createMemo<SessionView[]>(() => {
  const present = new Set<string>();

  const ensure = (id: string, cwd?: string, ts?: string): SessionView => {
    let v = sessionStore.get(id);
    if (!v) {
      v = { session_id: id, cwd, project: projectName(cwd), first_ts: ts || "", last_ts: ts || "", event_count: 0, running: 0, tokens: 0, cost: 0, live: false, agents: new Map() };
      sessionStore.set(id, v);
    }
    present.add(id);
    return v;
  };

  // reset per-recompute accumulators on the persisted objects
  for (const v of sessionStore.values()) v.event_count = 0;

  for (const e of allEvents()) {
    const id = e.session_id || "unknown";
    const v = ensure(id, e.cwd, e.ts);
    if (!v.cwd && e.cwd) { v.cwd = e.cwd; v.project = projectName(e.cwd); }
    if (!v.first_ts || e.ts < v.first_ts) v.first_ts = e.ts;
    if (e.ts > v.last_ts) v.last_ts = e.ts;
    v.event_count++;
  }

  for (const snap of Object.values(snapshots)) {
    const id = snap.session_id;
    const v = ensure(id, snap.cwd, snap.updated_at);
    if (!v.cwd && snap.cwd) { v.cwd = snap.cwd; v.project = projectName(snap.cwd); }
    if (snap.updated_at > v.last_ts) v.last_ts = snap.updated_at;
    sessionUpdatedAt.set(id, new Date(snap.updated_at).getTime());
    v.topology = snap.topology;
    v.agents = buildAgents(snap);
    const hist = historyBySession().get(id);
    if (hist) {
      for (const [name, p] of hist) {
        const a = v.agents.get(name);
        const histTok = p.input + p.output;
        if (a) {
          if ((a.inputTokens || 0) + (a.outputTokens || 0) < histTok) { a.inputTokens = p.input; a.outputTokens = p.output; }
          if ((a.costUsd || 0) < p.cost) a.costUsd = p.cost;
        }
      }
    }
    const agents = snap.agents || [];
    v.tokens = agents.reduce((s, a) => s + (a.inputTokens || 0) + (a.outputTokens || 0), 0);
    v.cost = agents.reduce((s, a) => s + (a.costUsd || 0), 0);
  }

  // history backstop (never under-report vs the persisted log)
  for (const id of present) {
    const v = sessionStore.get(id)!;
    const h = totalsFromHistory(historyBySession(), id);
    v.tokens = Math.max(v.tokens, h.tokens);
    v.cost = Math.max(v.cost, h.cost);
  }

  // Event-driven status overlay: the topology reflects events instantly. Apply
  // the latest event status onto each agent (creating placeholder entries for
  // agents seen in events but not yet in a snapshot), then derive running count.
  for (const id of present) {
    const v = sessionStore.get(id)!;
    const evStatus = eventStatusFor(id);
    for (const [name, st] of evStatus) {
      const a = v.agents.get(name);
      if (a) a.status = st as AgentRuntime["status"];
      else v.agents.set(name, { name, status: st as AgentRuntime["status"] });
    }
    let running = 0, active = 0;
    for (const a of v.agents.values()) {
      if (a.status === "running") running++;
      if (a.status === "running" || a.status === "waiting") active++;
    }
    v.running = running;     // actually executing
    v.active = active;       // running + waiting (used for liveness)
  }

  // drop sessions that no longer exist (e.g. deleted)
  for (const id of Array.from(sessionStore.keys())) if (!present.has(id)) { sessionStore.delete(id); sessionUpdatedAt.delete(id); }

  return Array.from(sessionStore.values()).sort((a, b) => String(b.last_ts).localeCompare(String(a.last_ts)));
});

// Live = a session has an agent running RIGHT NOW. `v.running` is event-driven
// (set above from the latest delegation/tool events), so this flips the instant
// a delegation starts/ends. A staleness guard prevents a session whose process
// died without a final delegation_end from appearing live forever. Read via the
// 1s `now` tick so only this small set re-derives per second, not the whole list.
export const liveSet = createMemo<Set<string>>(() => {
  const t = now();
  const live = new Set<string>();
  for (const v of sessions()) {
    const at = sessionUpdatedAt.get(v.session_id) || new Date(v.last_ts).getTime() || 0;
    const fresh = at > 0 && t - at < STALE_LIVE_MS;
    const isLive = (v.active ?? v.running) > 0 && fresh;
    v.live = isLive;
    if (isLive) live.add(v.session_id);
  }
  return live;
});
export function isLive(id: string): boolean { return liveSet().has(id); }

export const sessionsById = createMemo(() => {
  const m = new Map<string, SessionView>();
  for (const s of sessions()) m.set(s.session_id, s);
  return m;
});

// The session the Overview widgets (topology, model-mix, chart) focus on. At
// session scope it's that session; at project/fleet scope it's the most
// recently active session within the scope, so the graph always shows
// something coherent rather than an arbitrary mix.
export const currentSession = createMemo<SessionView | undefined>(() => {
  const s = scope();
  if (s.level === "session") return sessionsById().get(s.sessionId) || sessions()[0];
  const inScope = s.level === "project" ? sessions().filter((x) => x.project === s.project) : sessions();
  // prefer a live one, else most recent (sessions() is already last_ts desc)
  return inScope.find((x) => x.live) || inScope[0];
});

// Project groups for the sidebar. Structure (which sessions, totals) is stable
// across the 1s tick; the live flag is derived from liveSet so it stays current.
export const projectGroups = createMemo<ProjectGroup[]>(() => {
  const live = liveSet();
  const groups = new Map<string, ProjectGroup>();
  for (const s of sessions()) {
    let g = groups.get(s.project);
    if (!g) { g = { name: s.project, sessions: [], live: false, totalCost: 0 }; groups.set(s.project, g); }
    g.sessions.push(s);
    g.live = g.live || live.has(s.session_id);
    g.totalCost += s.cost;
  }
  return Array.from(groups.values()).sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name));
});

// Events for the current session (or all when none selected), newest first.
export const currentEvents = createMemo<HiveEvent[]>(() => {
  const id = selectedSession();
  const all = allEvents();
  const scoped = id ? all.filter((e) => e.session_id === id) : all;
  return [...scoped].reverse();
});

// Fleet-wide KPI rollup.
export const fleetStats = createMemo(() => {
  const ss = sessions();
  return {
    sessions: ss.length,
    live: ss.filter((s) => s.live).length,
    running: ss.reduce((a, s) => a + s.running, 0),
    tokens: ss.reduce((a, s) => a + s.tokens, 0),
    cost: ss.reduce((a, s) => a + s.cost, 0),
  };
});

// ── scoped derivations (what the tabs consume) ─────────────────────────────
// Sessions in the current scope: fleet=all, project=that project's, session=the one.
export const scopedSessions = createMemo<SessionView[]>(() => {
  const s = scope();
  if (s.level === "fleet") return sessions();
  if (s.level === "project") return sessions().filter((x) => x.project === s.project);
  return sessions().filter((x) => x.session_id === s.sessionId);
});

// Events in the current scope, newest first.
export const scopedEvents = createMemo<HiveEvent[]>(() => {
  const ids = new Set(scopedSessions().map((x) => x.session_id));
  return [...allEvents()].filter((e) => ids.has(e.session_id)).reverse();
});

// KPI rollup for the current scope.
export const scopedStats = createMemo(() => {
  const ss = scopedSessions();
  return {
    sessions: ss.length,
    live: ss.filter((s) => s.live).length,
    running: ss.reduce((a, s) => a + s.running, 0),
    tokens: ss.reduce((a, s) => a + s.tokens, 0),
    cost: ss.reduce((a, s) => a + s.cost, 0),
  };
});

// Agent rows for the current scope. For a single session it's that session's
// topology; for project/fleet it aggregates every session's agents (keyed by
// session::name so same-named agents across sessions don't collide).
export interface ScopeAgent { key: string; name: string; role?: string; model?: string; color?: string; status: string; tokens: number; cost: number; runs: number; tools: number; task?: string; session_id: string; depth: number; order: number; }
export const scopedAgents = createMemo<ScopeAgent[]>(() => {
  const hist = historyBySession();
  const out: ScopeAgent[] = [];
  let order = 0;
  for (const sess of scopedSessions()) {
    const sessHist = hist.get(sess.session_id);
    // Depth-first walk preserves hierarchy order (orchestrator → leads →
    // members) and records each agent's tree depth.
    const walk = (node: any, depth: number) => {
      if (!node) return;
      const rt = sess.agents.get(node.name);
      const h = sessHist?.get(node.name);
      const snapTok = (rt?.inputTokens || 0) + (rt?.outputTokens || 0);
      const tokens = Math.max(snapTok, h ? h.input + h.output : 0);
      const cost = Math.max(rt?.costUsd || 0, h?.cost || 0);
      out.push({
        key: sess.session_id + "::" + node.name, name: node.name, role: node.role, model: node.model, color: node.color,
        status: agentStatus(sess.session_id, node.name, rt?.status), tokens, cost, runs: rt?.runCount || 0, tools: rt?.toolCount || 0,
        task: rt?.task || rt?.lastWork, session_id: sess.session_id, depth, order: order++,
      });
      for (const c of node.children || []) walk(c, depth + 1);
    };
    const topo = sess.topology;
    if (topo?.orchestrator) walk(topo.orchestrator, 0);
    for (const root of topo?.agents || []) walk(root, topo?.orchestrator ? 1 : 0);
  }
  return out; // hierarchy order by default; the Agents tab re-sorts by status+hierarchy
});

// Human title + breadcrumb for the current scope.
export const scopeTitle = createMemo(() => {
  const s = scope();
  if (s.level === "fleet") return { title: "Overview", crumbs: ["Overview"], live: scopedStats().live };
  if (s.level === "project") return { title: s.project, crumbs: ["Overview", s.project], live: scopedStats().live };
  const sess = sessionsById().get(s.sessionId);
  return { title: s.project, crumbs: ["Overview", s.project, sessionSlug(s.sessionId)], live: scopedStats().live, session: sess };
});

export { flattenTopology };
