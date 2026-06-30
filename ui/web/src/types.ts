// Shapes mirror what src/observability/server.ts serves and what
// src/engine/observability.ts emits. Kept loose where the server is loose.

export type AgentStatus = "idle" | "running" | "waiting" | "done" | "error";

export type HiveEventType =
  | "session_start"
  | "agent_session_start"
  | "user_message"
  | "assistant_message"
  | "delegation_start"
  | "delegation_end"
  | "worker_tool_start"
  | "worker_tool_end"
  | "distill_start"
  | "distill_end"
  | "error";

export interface HiveEvent {
  event_id: string;
  session_id: string;
  seq?: number;
  ts: string;
  type: HiveEventType | string;
  actor?: string;
  pid?: number;
  cwd?: string;
  session_dir?: string;
  telemetry_log?: string;
  payload: Record<string, any>;
}

// A node in the topology tree (orchestrator + nested agents). Matches
// agentSummary() in engine/observability.ts.
export interface TopologyNode {
  name: string;
  role?: "orchestrator" | "lead" | "member";
  group?: string;
  color?: string;
  model?: string;
  thinking?: string;
  consultWhen?: string;
  routingTags?: string[];
  children?: TopologyNode[];
}

export interface Topology {
  orchestrator?: TopologyNode;
  agents?: TopologyNode[];
}

// A runtime agent entry inside a snapshot. Matches runtimeSummary().
export interface AgentRuntime {
  name: string;
  group?: string;
  role?: "orchestrator" | "lead" | "member";
  status: AgentStatus;
  task?: string;
  lastWork?: string;
  runCount?: number;
  toolCount?: number;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  sessionFile?: string;
  model?: string;
  thinking?: string;
}

// A full state snapshot — matches writeHiveStateSnapshot().
export interface Snapshot {
  updated_at: string;
  session_id: string;
  cwd?: string;
  session_dir?: string;
  telemetry_log?: string;
  conversation_log?: string;
  topology?: Topology;
  active_runs?: number;
  agents?: AgentRuntime[];
}

// Derived per-session view model the UI consumes.
export interface SessionView {
  session_id: string;
  cwd?: string;
  project: string;
  first_ts: string;
  last_ts: string;
  event_count: number;
  running: number;
  active?: number; // running + waiting (used for liveness)
  tokens: number;
  cost: number;
  live: boolean;
  topology?: Topology;
  agents: Map<string, AgentRuntime>;
}

export interface ProjectGroup {
  name: string;
  sessions: SessionView[];
  live: boolean;
  totalCost: number;
}
