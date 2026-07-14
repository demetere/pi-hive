import type { ReactNode } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import type { HiveEvent, ProjectGroup, SessionView, Snapshot } from "../types";
import type { Delegation, ModelInfo, SessionSummary, TopologyDetail, TopologyVersionSummary } from "../api";
import { EventRing } from "./event-ring";

// ── scope: fleet (all projects) | project (one project, its sessions
// aggregated) | session (one session detail). The tabs render within whatever
// scope is selected.
export type Scope =
  | { level: "fleet" }
  | { level: "project"; project: string }
  | { level: "session"; project: string; sessionId: string };

// Agent log viewer target: which agent's transcript to show in the modal.
export interface AgentRef { sessionId: string; name: string; color?: string; status?: string; model?: string; }

// Agent rows for the current scope (session::name keyed so same-named agents
// across sessions don't collide).
export interface ScopeAgent {
  key: string; name: string; role?: string; agentType?: string; model?: string; color?: string; status: string;
  tokens: number; cost: number; runs: number; tools: number; elapsedMs?: number; contextPct?: number;
  // Raw context-window fill behind contextPct (Phase 4.7), for the Agents-tab
  // hover detail (absolute tokens / window).
  contextTokens?: number; contextWindow?: number;
  task?: string; session_id: string; depth: number; order: number;
  // Enforcement contract from the topology node (Phase 6.1): what the agent may
  // touch / commit / which gates it owns. Undefined for runtime-only agents that
  // have no topology row yet.
  domain?: string[]; commit?: boolean; stages?: string[]; consultWhen?: string; responsibilities?: string;
}

export interface ScopeStats { sessions: number; live: number; running: number; tokens: number; cost: number; }
export interface ScopeTitle { title: string; crumbs: string[]; live: number; session?: SessionView; }
export type ConfirmState = {
  title: string; message: ReactNode; confirmLabel?: string; danger?: boolean;
  onConfirm: () => unknown | Promise<unknown>;
} | null;

export interface HiveState {
  // ── raw slice ───────────────────────────────────────────────────────────
  // Mutable bounded ring + revision avoids cloning the complete event map for
  // every SSE frame. Consumers subscribe to eventRevision, never object identity.
  eventRing: EventRing;
  eventRevision: number;
  snapshots: Record<string, Snapshot>;
  // Highest events.rowid seen, for lossless SSE reconnect catch-up (E1).
  lastCursor: number;
  connection: "connecting" | "live" | "reconnecting" | "syncing";
  selectedSession: string;
  activeTab: string;
  scope: Scope;
  theme: "dark" | "light";
  openAgent: AgentRef | null;
  confirm: ConfirmState;
  toasts: Toast[];
  now: number;

  // ── derived slice (rebuilt by the recompute orchestrators) ───────────────
  allEvents: HiveEvent[];
  sessions: SessionView[];
  sessionsById: Map<string, SessionView>;
  // Server-authoritative session summaries (GET /sessions), keyed by session_id.
  // Holds the DB's true event_count + topologyHash — the baseline for pruned-
  // history detection (I4) and versioned-topology lookups (K2). Distinct from
  // sessionsById, whose event_count only counts locally-loaded events.
  sessionSummaries: Map<string, SessionSummary>;
  // Typed, completed delegation rows (deltas-only) served by /delegations, in
  // cursor order. This is the AUTHORITATIVE source for the cost/token history
  // series and CACHE totals (Phase 3.1) — unlike the ~1000-row raw event window,
  // it is not truncated, and its per-run deltas sum without double-counting.
  // delegationsCursor is the highest cursor fetched, for incremental catch-up.
  delegations: Delegation[];
  delegationsCursor: number;
  liveSet: Set<string>;
  projectGroups: ProjectGroup[];
  currentSession: SessionView | undefined;
  fleetStats: ScopeStats;
  scopedSessions: SessionView[];
  scopedEvents: HiveEvent[];
  // Typed delegation deltas for the sessions in scope (Phase 3.1) — the source
  // for the cost/token history chart, KPI sparklines, and CACHE totals.
  scopedDelegations: Delegation[];
  scopedStats: ScopeStats;
  scopedAgents: ScopeAgent[];
  // Distinct-by-name counts over scopedAgents. scopedAgents holds one row per
  // (session, agent) so the Agents table can show per-session rows; but a team
  // is the same roster regardless of how many sessions ran it, so any "N agents /
  // M teams" figure must collapse by name — otherwise a project with the same
  // topology across K sessions reports K× the real count.
  scopedAgentCount: number;
  scopedTeamCount: number;
  scopeTitle: ScopeTitle;
  eventStatus: Map<string, Map<string, string>>;
  // Agent thinking/reasoning by session (fetched from transcripts, not events).
  thinkingBySession: Map<string, ThinkingEntry[]>;
  // Per-project display-name overrides, keyed by canonical project ID.
  projectOverrides: Map<string, string>;
  // SDK-reported thinking levels per model (GET /models), keyed by a normalized
  // model string — the dial's fallback when a node lacks its own sidecar (K3).
  modelLevels: Map<string, string[]>;
  // Full model capabilities (GET /models), same normalized keying as modelLevels
  // (Phase 6.5): context window, max output, and cost rates for hover detail.
  modelInfo: Map<string, ModelInfo>;
  // Versioned-topology surface (K2): per-cwd version list (ordered v1..vN by
  // first_seen_at) and a hash→reassembled-tree cache filled on demand.
  topologiesByCwd: Map<string, TopologyVersionSummary[]>;
  topologyByHash: Map<string, TopologyDetail>;

  // ── replay slice (Phase F) — a SEPARATE store slice; no SSE frame mutates it,
  // so live mode is untouched. Populated only when the user enters Replay on a
  // session detail; the panel re-derives status/feed/chart over events[0..cursor].
  replay: ReplayState;
}

export interface ReplayState {
  active: boolean;
  sessionId: string;
  events: HiveEvent[];   // full session history, chronological
  loading: boolean;
  loadedCount: number;   // for the progress indicator while paging
  cursor: number;        // index into events (0..events.length-1) currently shown
  playing: boolean;
  speed: 1 | 10 | 60;
  // True when the fetched count is below the session's recorded event_count
  // (early history pruned, F3) — the panel shows a "history starts at …" marker.
  truncatedStart: boolean;
  // Timestamp of the earliest fetched event, shown in the pruned-history marker
  // ("history starts at …"). Empty when nothing was fetched.
  historyStartsAt: string;
}

export interface ThinkingEntry { agent: string; ts: string; text: string; tokens?: number; }

// Transient toast notifications (K1/Decision 7). Every mutating flow pushes one
// on success/failure; a single <Toast> renders the stack. Auto-dismissed.
export interface Toast { id: number; kind: "success" | "error" | "info"; message: string; }

const initialStats: ScopeStats = { sessions: 0, live: 0, running: 0, tokens: 0, cost: 0 };

const initialState: HiveState = {
    eventRing: new EventRing(),
    eventRevision: 0,
    snapshots: {},
    lastCursor: 0,
    connection: "connecting",
    selectedSession: "",
    activeTab: "overview",
    scope: { level: "fleet" },
    theme: ((typeof localStorage !== "undefined" && localStorage.getItem("hive-theme")) as "dark" | "light") || "dark",
    openAgent: null,
    confirm: null,
    toasts: [],
    now: 0,

    allEvents: [],
    sessions: [],
    sessionsById: new Map(),
    sessionSummaries: new Map(),
    delegations: [],
    delegationsCursor: 0,
    liveSet: new Set(),
    projectGroups: [],
    currentSession: undefined,
    fleetStats: initialStats,
    scopedSessions: [],
    scopedEvents: [],
    scopedDelegations: [],
    scopedStats: initialStats,
    scopedAgents: [],
    scopedAgentCount: 0,
    scopedTeamCount: 0,
    scopeTitle: { title: "Overview", crumbs: ["Overview"], live: 0 },
    eventStatus: new Map(),
    thinkingBySession: new Map(),
    projectOverrides: new Map(),
    modelLevels: new Map(),
    modelInfo: new Map(),
    topologiesByCwd: new Map(),
    topologyByHash: new Map(),
    replay: { active: false, sessionId: "", events: [], loading: false, loadedCount: 0, cursor: 0, playing: false, speed: 1, truncatedStart: false, historyStartsAt: "" },
};

export const store = createStore<HiveState>()(subscribeWithSelector(() => initialState));

// Apply the persisted theme to the document immediately.
if (typeof document !== "undefined") {
  document.documentElement.dataset.theme = store.getState().theme;
}

// Typed selector hook.
export function useHive<T>(selector: (s: HiveState) => T): T {
  return useStore(store, selector);
}

// The authoritative live status for an agent: event-driven status wins (instant,
// same channel as the activity feed); falls back to the snapshot status.
export function agentStatus(sessionId: string, name: string, snapshotStatus?: string): string {
  return store.getState().eventStatus.get(sessionId)?.get(name) || snapshotStatus || "idle";
}
