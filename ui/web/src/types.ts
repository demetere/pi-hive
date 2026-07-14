// Browser-side aliases for the telemetry contract emitted by
// src/engine/observability.ts and served by src/observability/server.ts.

import type {
  HiveStateSnapshot,
  HiveTelemetryEvent,
  HiveTelemetryEventType,
  HiveTopology,
  HiveTeamTopologies,
  TelemetryAgentRuntime,
  TelemetryAgentStatus,
  TopologyNode,
} from "../../../src/shared/telemetry";

export type AgentStatus = TelemetryAgentStatus;
export type HiveEventType = HiveTelemetryEventType;
// `cursor` is the daemon's global events.rowid, present on SQL-served events and
// SSE frames (Phase B5). The store tracks the max seen cursor for lossless SSE
// reconnect catch-up (E1).
export type HiveEvent = HiveTelemetryEvent<Record<string, any>> & { type: HiveEventType | string; cursor?: number };
export type Topology = HiveTopology;
export type TeamTopologies = HiveTeamTopologies;
export type { TopologyNode };
export type AgentRuntime = TelemetryAgentRuntime;
export type Snapshot = HiveStateSnapshot;

// Derived per-session view model the UI consumes.
export interface SessionView {
  session_id: string;
  project_id: string;
  project_root?: string;
  project_label: string;
  cwd?: string;
  project: string; // canonical project ID (scope/group key)
  first_ts: string;
  last_ts: string;
  event_count: number;
  running: number;
  active?: number; // running + waiting (used for liveness)
  tokens: number;
  cost: number;
  live: boolean;
  topology?: Topology;
  topologies?: TeamTopologies;
  agents: Map<string, AgentRuntime>;
}

export interface ProjectGroup {
  name: string;   // canonical project ID (internal scope/group key)
  derivedLabel: string;
  label: string;  // display override, or derivedLabel
  sessions: SessionView[];
  live: boolean;
  totalCost: number;
  cwds: string[]; // distinct working dirs in this group (for settings)
}
