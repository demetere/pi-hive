export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, unknown>;

export type HiveTelemetryEventType =
  | "session_start"
  | "user_message"
  | "assistant_message"
  | "delegation_start"
  | "delegation_end"
  | "worker_tool_start"
  | "worker_tool_end"
  | "worker_retry"
  | "worker_compaction"
  | "orchestrator_tool_start"
  | "orchestrator_tool_end"
  // Orchestrator (main-session) parity events (Phase 4): the main session's own
  // compactions, model/thinking switches, and per-turn latency were previously
  // invisible next to its workers'.
  | "orchestrator_compaction"
  | "orchestrator_message"
  | "model_select"
  | "thinking_level_select"
  | "turn"
  | "provider_response"
  // Remaining SDK event classes (Phase 4, Item): user bash commands, input
  // source, session fork/tree navigation, and session-name changes. Bounded
  // payloads; surfaced generically in the Activity feed.
  | "user_bash"
  | "input"
  | "session_fork"
  | "session_tree"
  | "session_info_changed"
  | "queue_update"
  | "model_catalog"
  | "distill_start"
  | "distill_end"
  // Plan-store events. Emitted by the core (which cannot reach bun:sqlite) and
  // materialized into typed plan_* tables by the dashboard on ingest (§7.4).
  | "review_verdict"
  | "plan_approval"
  | "plan_comment"
  // Emitted on delegation failure with { agent, message, stopReason }.
  | "error";

export type TelemetryAgentStatus = "idle" | "running" | "waiting" | "done" | "error";
export type TelemetryAgentRole = "orchestrator" | "lead" | "member";

export interface HiveTelemetryEvent<P = JsonRecord> {
  event_id: string;
  ts: string;
  type: HiveTelemetryEventType | string;
  session_id: string;
  cwd?: string;
  session_dir?: string;
  telemetry_log?: string;
  conversation_log?: string;
  state_file?: string;
  actor: string;
  pid: number;
  seq: number;
  payload: P;
}

export interface TelemetryRegistryRow {
  registered_at?: string;
  session_id?: string;
  cwd?: string;
  session_dir?: string;
  conversation_log?: string;
  telemetry_log?: string;
  state_file?: string;
  pid?: number;
}

export interface TopologyNode {
  name: string;
  role?: TelemetryAgentRole;
  agentType?: string;
  stages?: string[];
  group?: string;
  color?: string;
  model?: string;
  tools?: string;
  thinking?: string;
  consultWhen?: string;
  routingTags?: string[];
  // The enforcement boundary (Phase A8): domain globs the agent may write,
  // whether it may commit, and its declared responsibilities.
  domain?: string[];
  commit?: boolean;
  responsibilities?: string;
  // SDK-reported thinking levels supported by this node's model (A10). Sidecar
  // data — excluded from the topology content hash (Decision 13).
  thinkingLevels?: string[];
  children?: TopologyNode[];
}

export interface HiveTopology {
  orchestrator?: TopologyNode;
  agents?: TopologyNode[];
}

export interface HiveTeamTopologies {
  active: "hive" | "planning";
  hive?: HiveTopology;
  planning?: HiveTopology;
}

export interface TelemetryAgentRuntime {
  name: string;
  group?: string;
  role?: TelemetryAgentRole;
  agentType?: string;
  status: TelemetryAgentStatus;
  task?: string;
  lastWork?: string;
  runCount?: number;
  toolCount?: number;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  contextPct?: number;
  // Raw context-window fill behind contextPct (Phase 4.7): the tokens currently
  // in context and the model's window. Threaded from the worker poll / main
  // session's turn-end capture so the UI can show the absolute numbers.
  contextTokens?: number;
  contextWindow?: number;
  sessionFile?: string;
  model?: string;
  thinking?: string;
  thinkingLevels?: string[];
  // Lifetime token counts at the start of the current run — the baseline the UI
  // subtracts to compute per-run TOK/S (J8).
  runStartInputTokens?: number;
  runStartOutputTokens?: number;
}

export interface HiveStateSnapshot {
  updated_at: string;
  session_id: string;
  cwd?: string;
  session_dir?: string;
  telemetry_log?: string;
  conversation_log?: string;
  // Back-compat/current active team topology.
  topology?: HiveTopology;
  // Both configured team topologies, when available: execution hive + planning.
  topologies?: HiveTeamTopologies;
  active_runs?: number;
  agents?: TelemetryAgentRuntime[];
}

export interface TelemetrySessionSummary {
  session_id: string;
  cwd?: string;
  session_dir?: string;
  telemetry_log?: string;
  first_ts?: string;
  last_ts?: string;
  event_count: number;
  running: number;
  tokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost: number;
  topologyHash?: string;
}
