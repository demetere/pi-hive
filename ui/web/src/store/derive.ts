import type { AgentRuntime, HiveEvent, ProjectGroup, SessionView } from "../types";
import { projectName, sessionSlug } from "../lib/format";
import { applyHistoryToRuntime, buildHistoryBySession, historyTotals as totalsFromHistory, type HistPeak } from "./history";
import { buildEventStatus } from "./status";
import { buildAgents, flattenTopology } from "./topology";
import { sessionStore, sessionUpdatedAt } from "./identity";
import { store, type HiveState, type ScopeAgent, type ScopeStats, type ScopeTitle } from "./index";

// A session is "live" if its snapshot updated within this window. A running
// agent that hasn't updated in this long is treated as stale (its process
// likely died without a final delegation_end), so it stops counting as live.
const STALE_LIVE_MS = 5 * 60_000;

// A session's snapshot is stale when its last update is older than STALE_LIVE_MS.
// Used to suppress the event-status overlay's running/waiting for dead sessions:
// buildEventStatus only clears "running" on delegation_end, the one event a killed
// process never emits, so a stale session's overlay would pin an agent "running"
// forever. `now` defaults to the store tick so callers on the live tier stay in
// sync with the same clock recomputeLive uses.
export function sessionIsStale(sessionId: string, now: number): boolean {
  const at = sessionUpdatedAt.get(sessionId) || 0;
  return at > 0 && now - at >= STALE_LIVE_MS;
}

// Demote an overlay status for a stale session: running/waiting become idle (the
// process is presumed dead); terminal/idle states pass through unchanged.
export function demoteIfStale(status: string, sessionId: string, now: number): string {
  if ((status === "running" || status === "waiting") && sessionIsStale(sessionId, now)) return "idle";
  return status;
}

// Module-level cache of the last heavy-tier products so the scoped/live tiers
// can rebuild off them without recomputing the heavy work.
let historyBySession = new Map<string, Map<string, HistPeak>>();

function computeAllEvents(eventMap: Record<string, HiveEvent>): HiveEvent[] {
  const arr = Object.values(eventMap);
  arr.sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || (a.seq || 0) - (b.seq || 0));
  return arr;
}

function computeSessions(allEvents: HiveEvent[], snapshots: Record<string, any>, eventStatus: Map<string, Map<string, string>>, summaries: Map<string, { cwd?: string; first_ts?: string; last_ts?: string; event_count?: number; tokens?: number; cost?: number }>): SessionView[] {
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

  for (const e of allEvents) {
    const id = e.session_id || "unknown";
    const v = ensure(id, e.cwd, e.ts);
    if (!v.cwd && e.cwd) { v.cwd = e.cwd; v.project = projectName(e.cwd); }
    if (!v.first_ts || e.ts < v.first_ts) v.first_ts = e.ts;
    if (e.ts > v.last_ts) v.last_ts = e.ts;
    v.event_count++;
  }

  for (const snap of Object.values(snapshots) as any[]) {
    const id = snap.session_id;
    const v = ensure(id, snap.cwd, snap.updated_at);
    if (!v.cwd && snap.cwd) { v.cwd = snap.cwd; v.project = projectName(snap.cwd); }
    if (snap.updated_at > v.last_ts) v.last_ts = snap.updated_at;
    sessionUpdatedAt.set(id, new Date(snap.updated_at).getTime());
    v.topology = snap.topology;
    v.topologies = snap.topologies;
    v.agents = buildAgents(snap);
    const hist = historyBySession.get(id);
    if (hist) {
      for (const [name, p] of hist) {
        const a = v.agents.get(name);
        if (a) applyHistoryToRuntime(a, p);
      }
    }
    const agents = snap.agents || [];
    v.tokens = agents.reduce((s: number, a: any) => s + (a.inputTokens || 0) + (a.outputTokens || 0), 0);
    v.cost = agents.reduce((s: number, a: any) => s + (a.costUsd || 0), 0);
  }

  // Union with the server-authoritative session list (Phase 3.4): a session whose
  // events fell outside the ~1000-row loaded window (and which has no live
  // snapshot) would otherwise be invisible in the sidebar/session list. Seed a
  // minimal row from its summary so it still appears; its authoritative
  // tokens/cost/event_count come straight from the DB. Skipped once real
  // events/snapshots arrive for it (ensure() already created the richer row).
  for (const [id, sum] of summaries) {
    if (sessionStore.has(id) && present.has(id)) continue;
    const v = ensure(id, sum.cwd, sum.last_ts || sum.first_ts);
    if (!v.cwd && sum.cwd) { v.cwd = sum.cwd; v.project = projectName(sum.cwd); }
    if (sum.first_ts && (!v.first_ts || sum.first_ts < v.first_ts)) v.first_ts = sum.first_ts;
    if (sum.last_ts && sum.last_ts > v.last_ts) v.last_ts = sum.last_ts;
    if (!v.event_count && sum.event_count) v.event_count = sum.event_count;
    if (!v.tokens && sum.tokens) v.tokens = sum.tokens;
    if (!v.cost && sum.cost) v.cost = sum.cost;
  }

  // history backstop (never under-report vs the persisted log)
  for (const id of present) {
    const v = sessionStore.get(id)!;
    const h = totalsFromHistory(historyBySession, id);
    v.tokens = Math.max(v.tokens, h.tokens);
    v.cost = Math.max(v.cost, h.cost);
  }

  // Event-driven status overlay: the topology reflects events instantly. Apply
  // the latest event status onto each agent (creating placeholder entries for
  // agents seen in events but not yet in a snapshot), then derive running count.
  for (const id of present) {
    const v = sessionStore.get(id)!;
    const evStatus = eventStatus.get(id) || new Map<string, string>();
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
}

function computeFleetStats(ss: SessionView[]): ScopeStats {
  return {
    sessions: ss.length,
    live: ss.filter((s) => s.live).length,
    running: ss.reduce((a, s) => a + s.running, 0),
    tokens: ss.reduce((a, s) => a + s.tokens, 0),
    cost: ss.reduce((a, s) => a + s.cost, 0),
  };
}

// ── heavy tier: events/snapshots changed ─────────────────────────────────────
export function recomputeHeavy() {
  const s = store.getState();
  const allEvents = computeAllEvents(s.eventMap);
  historyBySession = buildHistoryBySession(allEvents);
  const eventStatus = buildEventStatus(allEvents);
  const sessions = computeSessions(allEvents, s.snapshots, eventStatus, s.sessionSummaries);
  const sessionsById = new Map<string, SessionView>();
  for (const sess of sessions) sessionsById.set(sess.session_id, sess);
  store.setState({ allEvents, eventStatus, sessions, sessionsById });
  // heavy inputs feed the scoped + live tiers
  recomputeLive();
  recomputeScoped();
}

// ── live tier: 1s tick (freshness) ───────────────────────────────────────────
export function recomputeLive() {
  const s = store.getState();
  const t = s.now || Date.now();
  const live = new Set<string>();
  // R3-1.2: demote the shared event-status overlay AT THE SOURCE for stale
  // sessions. buildEventStatus (heavy tier) rebuilds this map raw, marking
  // running/waiting and clearing only on delegation_end — the one event a killed
  // process never emits — so a dead session's overlay would pin an agent active
  // forever. Every consumer reads this same map (TopologyGraph.useStatus, the
  // computeSessions overlay-apply loop, computeScopedAgents.statusOf), so demoting
  // here heals ALL of them at once instead of per-render-path.
  //
  // R4.3: cheap pre-scan first — only a stale session with a still-running/waiting
  // entry needs demoting. If none, skip the whole map allocation (this runs every
  // 1s tick, so an unchanging overlay must not churn GC). The copy + setState are
  // built only when there's actually something to demote.
  let overlayChanged = false;
  for (const [sid, agents] of s.eventStatus) {
    if (!sessionIsStale(sid, t)) continue;
    for (const st of agents.values()) {
      if (st === "running" || st === "waiting") { overlayChanged = true; break; }
    }
    if (overlayChanged) break;
  }
  let nextStatus: typeof s.eventStatus | undefined;
  if (overlayChanged) {
    nextStatus = new Map();
    for (const [sid, agents] of s.eventStatus) {
      const stale = sessionIsStale(sid, t);
      const copy = new Map<string, string>();
      for (const [name, st] of agents) copy.set(name, stale ? demoteIfStale(st, sid, t) : st);
      nextStatus.set(sid, copy);
    }
  }
  for (const v of s.sessions) {
    const at = sessionUpdatedAt.get(v.session_id) || new Date(v.last_ts).getTime() || 0;
    const fresh = at > 0 && t - at < STALE_LIVE_MS;
    const isLive = (v.active ?? v.running) > 0 && fresh;
    v.live = isLive;
    if (isLive) live.add(v.session_id);
    // Phase 6.4: per-agent stuck-"running" staleness. An agent whose process died
    // without a final delegation_end stays "running" forever in the status
    // overlay/topology. Once its session is stale (same window as session
    // liveness), demote any running/waiting agent to idle and zero the running
    // count so a dead worker stops rendering as active.
    if (!fresh) {
      let anyDemoted = false;
      for (const a of v.agents.values()) {
        if (a.status === "running" || a.status === "waiting") { a.status = "idle"; anyDemoted = true; }
      }
      if (anyDemoted) { v.running = 0; v.active = 0; }
    }
  }
  if (nextStatus) store.setState({ eventStatus: nextStatus });
  // Project groups for the sidebar; live flag derived from the live set.
  const overrides = s.projectOverrides;
  const groups = new Map<string, ProjectGroup>();
  for (const sess of s.sessions) {
    let g = groups.get(sess.project);
    if (!g) { g = { name: sess.project, label: sess.project, sessions: [], live: false, totalCost: 0, cwds: [] }; groups.set(sess.project, g); }
    g.sessions.push(sess);
    g.live = g.live || live.has(sess.session_id);
    g.totalCost += sess.cost;
    if (sess.cwd && !g.cwds.includes(sess.cwd)) g.cwds.push(sess.cwd);
  }
  // Apply display-name overrides: first matching cwd in the group wins.
  for (const g of groups.values()) {
    for (const cwd of g.cwds) { const l = overrides.get(cwd); if (l) { g.label = l; break; } }
  }
  const projectGroups = Array.from(groups.values()).sort((a, b) => Number(b.live) - Number(a.live) || a.label.localeCompare(b.label));
  store.setState({ liveSet: live, projectGroups, fleetStats: computeFleetStats(s.sessions) });
}

// ── scoped tier: scope/selectedSession changed (also after heavy/live) ───────
export function recomputeScoped() {
  const s = store.getState();
  const scope = s.scope;
  const sessions = s.sessions;

  const scopedSessions = scope.level === "fleet" ? sessions
    : scope.level === "project" ? sessions.filter((x) => x.project === scope.project)
    : sessions.filter((x) => x.session_id === scope.sessionId);

  const ids = new Set(scopedSessions.map((x) => x.session_id));
  const scopedEvents = [...s.allEvents].filter((e) => ids.has(e.session_id)).reverse();
  // Typed delegation deltas for the scoped sessions (Phase 3.1) — feeds the
  // cost/token history + CACHE, untruncated by the raw event window.
  const scopedDelegations = s.delegations.filter((d) => ids.has(d.sessionId));

  const scopedStats: ScopeStats = {
    sessions: scopedSessions.length,
    live: scopedSessions.filter((x) => x.live).length,
    running: scopedSessions.reduce((a, x) => a + x.running, 0),
    tokens: scopedSessions.reduce((a, x) => a + x.tokens, 0),
    cost: scopedSessions.reduce((a, x) => a + x.cost, 0),
  };

  // currentSession: at session scope it's that session; at project/fleet scope
  // it's the most recently active session within the scope (prefer live).
  let currentSession: SessionView | undefined;
  if (scope.level === "session") currentSession = s.sessionsById.get(scope.sessionId) || sessions[0];
  else {
    const inScope = scope.level === "project" ? sessions.filter((x) => x.project === scope.project) : sessions;
    currentSession = inScope.find((x) => x.live) || inScope[0];
  }

  const scopedAgents = computeScopedAgents(scopedSessions);
  // Collapse per-(session,agent) rows to distinct names for any headline count
  // (donut "N AGENTS", "M teams · N agents", Agents tab badge). Without this a
  // project shows K× its real roster, one copy per session that ran it.
  const distinctNames = new Set<string>();
  const teamNames = new Set<string>();
  for (const a of scopedAgents) {
    const n = a.name.trim().toLowerCase();
    if (!n) continue;
    distinctNames.add(n);
    if (a.role === "lead") teamNames.add(n);
  }
  const scopedAgentCount = distinctNames.size;
  const scopedTeamCount = teamNames.size;

  // Display label for the scoped project (override its derived name if set).
  const labelFor = (project: string) => {
    for (const sess of s.sessions) {
      if (sess.project === project && sess.cwd) { const l = s.projectOverrides.get(sess.cwd); if (l) return l; }
    }
    return project;
  };

  // scope title + breadcrumb
  let scopeTitle: ScopeTitle;
  if (scope.level === "fleet") scopeTitle = { title: "Overview", crumbs: ["Overview"], live: scopedStats.live };
  else if (scope.level === "project") { const pl = labelFor(scope.project); scopeTitle = { title: pl, crumbs: ["Overview", pl], live: scopedStats.live }; }
  else {
    const sess = s.sessionsById.get(scope.sessionId);
    const pl = labelFor(scope.project);
    scopeTitle = { title: pl, crumbs: ["Overview", pl, sessionSlug(scope.sessionId)], live: scopedStats.live, session: sess };
  }

  store.setState({ scopedSessions, scopedEvents, scopedDelegations, scopedStats, currentSession, scopedAgents, scopedAgentCount, scopedTeamCount, scopeTitle });
}

function computeScopedAgents(scopedSessions: SessionView[]): ScopeAgent[] {
  const hist = historyBySession;
  const out: ScopeAgent[] = [];
  let order = 0;
  const gs = store.getState();
  const st = gs.eventStatus;
  const now = gs.now || Date.now();
  // W1.2: the overlay marks running/waiting but only clears on delegation_end, so a
  // dead session's overlay pins an agent active forever. Demote overlay entries for
  // stale sessions before they win over the snapshot status.
  const statusOf = (sessionId: string, name: string, snapStatus?: string) =>
    demoteIfStale(st.get(sessionId)?.get(name) || snapStatus || "idle", sessionId, now);
  for (const sess of scopedSessions) {
    const sessHist = hist.get(sess.session_id);
    const seen = new Set<string>();
    const topo = sess.topologies?.active ? (sess.topologies as any)[sess.topologies.active] : sess.topology;
    const rootName = topo?.orchestrator?.name;
    const norm = (name: string | undefined) => (name || "").trim().toLowerCase();
    const inferredRole = (node: any, depth: number, rt?: AgentRuntime) => {
      if (node.role || rt?.role) return node.role || rt?.role;
      if (rootName && norm(node.name) === norm(rootName) && depth === 0) return "orchestrator";
      return depth <= (rootName ? 1 : 0) || (node.children || []).length ? "lead" : "member";
    };
    const walk = (node: any, depth: number) => {
      const key = norm(node?.name);
      if (!node || !key || seen.has(key)) return;
      seen.add(key);
      const rt = sess.agents.get(node.name);
      const h = sessHist?.get(node.name);
      const snapTok = (rt?.inputTokens || 0) + (rt?.outputTokens || 0);
      const tokens = Math.max(snapTok, h ? h.input + h.output : 0);
      const cost = Math.max(rt?.costUsd || 0, h?.cost || 0);
      out.push({
        key: sess.session_id + "::" + key, name: node.name, role: inferredRole(node, depth, rt), agentType: node.agentType || (rt as any)?.agentType, model: node.model || rt?.model, color: node.color,
        status: statusOf(sess.session_id, node.name, rt?.status), tokens, cost, runs: Math.max(rt?.runCount || 0, h?.runs || 0), tools: Math.max(rt?.toolCount || 0, h?.tools || 0),
        elapsedMs: rt?.elapsedMs, contextPct: rt?.contextPct, contextTokens: rt?.contextTokens, contextWindow: rt?.contextWindow, task: rt?.task || rt?.lastWork, session_id: sess.session_id, depth, order: order++,
        // Enforcement contract carried from the topology node (Phase 6.1).
        domain: node.domain, commit: node.commit, stages: node.stages, consultWhen: node.consultWhen, responsibilities: node.responsibilities,
      });
      for (const c of node.children || []) walk(c, depth + 1);
    };
    if (topo?.orchestrator) walk(topo.orchestrator, 0);
    for (const root of topo?.agents || []) walk(root, topo?.orchestrator ? 1 : 0);

    // Runtime/event-only agents may exist before (or without) a topology row.
    for (const rt of sess.agents.values()) {
      const key = norm(rt.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const h = sessHist?.get(rt.name);
      const snapTok = (rt.inputTokens || 0) + (rt.outputTokens || 0);
      const tokens = Math.max(snapTok, h ? h.input + h.output : 0);
      const cost = Math.max(rt.costUsd || 0, h?.cost || 0);
      out.push({
        key: sess.session_id + "::" + key, name: rt.name, role: rt.role || "member", agentType: (rt as any).agentType, model: rt.model, color: undefined,
        status: statusOf(sess.session_id, rt.name, rt.status), tokens, cost, runs: Math.max(rt.runCount || 0, h?.runs || 0), tools: Math.max(rt.toolCount || 0, h?.tools || 0),
        elapsedMs: rt.elapsedMs, contextPct: rt.contextPct, contextTokens: rt.contextTokens, contextWindow: rt.contextWindow, task: rt.task || rt.lastWork, session_id: sess.session_id, depth: 0, order: order++,
      });
    }
  }
  return out;
}

export { flattenTopology };
export type { HiveState };
