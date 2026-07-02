import type { ReactNode } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import type { HiveEvent, ProjectGroup, SessionView, Snapshot } from "../types";

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
  key: string; name: string; role?: string; model?: string; color?: string; status: string;
  tokens: number; cost: number; runs: number; tools: number; elapsedMs?: number; contextPct?: number;
  task?: string; session_id: string; depth: number; order: number;
}

export interface ScopeStats { sessions: number; live: number; running: number; tokens: number; cost: number; }
export interface ScopeTitle { title: string; crumbs: string[]; live: number; session?: SessionView; }
export type ConfirmState = {
  title: string; message: ReactNode; confirmLabel?: string; danger?: boolean;
  onConfirm: () => unknown | Promise<unknown>;
} | null;

export interface HiveState {
  // ── raw slice ───────────────────────────────────────────────────────────
  eventMap: Record<string, HiveEvent>;
  snapshots: Record<string, Snapshot>;
  // Highest events.rowid seen, for lossless SSE reconnect catch-up (E1).
  lastCursor: number;
  connection: "connecting" | "live" | "reconnecting";
  selectedSession: string;
  activeTab: string;
  scope: Scope;
  theme: "dark" | "light";
  openAgent: AgentRef | null;
  confirm: ConfirmState;
  now: number;

  // ── derived slice (rebuilt by the recompute orchestrators) ───────────────
  allEvents: HiveEvent[];
  sessions: SessionView[];
  sessionsById: Map<string, SessionView>;
  liveSet: Set<string>;
  projectGroups: ProjectGroup[];
  currentSession: SessionView | undefined;
  fleetStats: ScopeStats;
  scopedSessions: SessionView[];
  scopedEvents: HiveEvent[];
  scopedStats: ScopeStats;
  scopedAgents: ScopeAgent[];
  scopeTitle: ScopeTitle;
  eventStatus: Map<string, Map<string, string>>;
  // Agent thinking/reasoning by session (fetched from transcripts, not events).
  thinkingBySession: Map<string, ThinkingEntry[]>;
  // Per-project display-name overrides, keyed by cwd (from settings, DB-backed).
  projectOverrides: Map<string, string>;
}

export interface ThinkingEntry { agent: string; ts: string; text: string; tokens?: number; }

const initialStats: ScopeStats = { sessions: 0, live: 0, running: 0, tokens: 0, cost: 0 };

const initialState: HiveState = {
    eventMap: {},
    snapshots: {},
    lastCursor: 0,
    connection: "connecting",
    selectedSession: "",
    activeTab: "overview",
    scope: { level: "fleet" },
    theme: ((typeof localStorage !== "undefined" && localStorage.getItem("hive-theme")) as "dark" | "light") || "dark",
    openAgent: null,
    confirm: null,
    now: 0,

    allEvents: [],
    sessions: [],
    sessionsById: new Map(),
    liveSet: new Set(),
    projectGroups: [],
    currentSession: undefined,
    fleetStats: initialStats,
    scopedSessions: [],
    scopedEvents: [],
    scopedStats: initialStats,
    scopedAgents: [],
    scopeTitle: { title: "Overview", crumbs: ["Overview"], live: 0 },
    eventStatus: new Map(),
    thinkingBySession: new Map(),
    projectOverrides: new Map(),
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
