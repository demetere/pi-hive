export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, unknown>;

export type HiveTelemetryEventType =
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
  group?: string;
  color?: string;
  model?: string;
  tools?: string;
  thinking?: string;
  consultWhen?: string;
  routingTags?: string[];
  children?: TopologyNode[];
}

export interface HiveTopology {
  orchestrator?: TopologyNode;
  agents?: TopologyNode[];
}

export interface TelemetryAgentRuntime {
  name: string;
  group?: string;
  role?: TelemetryAgentRole;
  status: TelemetryAgentStatus;
  task?: string;
  lastWork?: string;
  runCount?: number;
  toolCount?: number;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  contextPct?: number;
  sessionFile?: string;
  model?: string;
  thinking?: string;
}

export interface HiveStateSnapshot {
  updated_at: string;
  session_id: string;
  cwd?: string;
  session_dir?: string;
  telemetry_log?: string;
  conversation_log?: string;
  topology?: HiveTopology;
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
  cost: number;
}
