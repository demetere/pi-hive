// Browser-side aliases for the telemetry contract emitted by
// src/engine/observability.ts and served by src/observability/server.ts.

import type {
  HiveStateSnapshot,
  HiveTelemetryEvent,
  HiveTelemetryEventType,
  HiveTopology,
  TelemetryAgentRuntime,
  TelemetryAgentStatus,
  TopologyNode,
} from "../../../src/shared/telemetry";

export type AgentStatus = TelemetryAgentStatus;
export type HiveEventType = HiveTelemetryEventType;
export type HiveEvent = HiveTelemetryEvent<Record<string, any>> & { type: HiveEventType | string };
export type Topology = HiveTopology;
export type { TopologyNode };
export type AgentRuntime = TelemetryAgentRuntime;
export type Snapshot = HiveStateSnapshot;

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
