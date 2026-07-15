import type {
  HiveStateSnapshot,
  HiveTelemetryEvent,
  HiveTopology,
  TelemetrySessionSummary,
} from "./telemetry";

export interface DashboardBootstrap {
  token: string | null;
  bootCwd: string | null;
}

export type DashboardEvent = HiveTelemetryEvent & { cursor: number };

export interface DashboardEventPage {
  events: DashboardEvent[];
  cursor?: number;
  nextCursor: number;
  highWaterCursor: number;
  hasMore: boolean;
}

export interface DashboardFleetPage<T> {
  offset: number;
  nextOffset: number;
  hasMore: boolean;
  items: T[];
}

export type DashboardStatesPage = Omit<DashboardFleetPage<HiveStateSnapshot>, "items"> & {
  states: HiveStateSnapshot[];
};

export type DashboardSessionsPage = Omit<DashboardFleetPage<TelemetrySessionSummary>, "items"> & {
  sessions: TelemetrySessionSummary[];
};

export interface DashboardDelegation {
  cursor: number;
  sessionId: string;
  cwd?: string;
  agent?: string;
  parent?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  costUsd?: number;
  schemaVersion: number;
  status?: string;
  stopReason?: string;
  model?: string;
}

export interface DashboardDelegationsResponse {
  delegations: DashboardDelegation[];
}

export interface DashboardStorageBreakdown {
  bytes: number;
  events: number;
  sessions: number;
  database: { logicalBytes: number; fileBytes: number };
  sourceLogs: { bytes: number; files: number };
  prune?: {
    removeBytes: number;
    removeEvents: number;
    removeSessions: number;
    keepBytes: number;
    keepEvents: number;
  };
}

export interface DashboardModelInfo {
  provider: string;
  modelId: string;
  name?: string;
  reasoning: boolean;
  thinkingLevels: string[];
  contextWindow?: number;
  maxTokens?: number;
  costRates?: {
    input?: number | null;
    output?: number | null;
    cacheRead?: number | null;
    cacheWrite?: number | null;
  };
}

export interface DashboardModelsResponse {
  models: DashboardModelInfo[];
}

export interface DashboardTopologyVersion {
  hash: string;
  firstSeenAt: string;
  lastSeenAt: string;
  sessionCount: number;
}

export interface DashboardTopologiesResponse {
  topologies: DashboardTopologyVersion[];
}

export interface DashboardTopologyDetail {
  hash: string;
  cwd: string;
  firstSeenAt: string;
  lastSeenAt: string;
  planning?: HiveTopology;
  hive?: HiveTopology;
  canonicalJson?: string;
}
