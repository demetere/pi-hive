// ── Types ────────────────────────────────────────────────────────────────────

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type AgentStatus = "idle" | "running" | "done" | "error";
export type JsonRecord = Record<string, any>;
export type TeamMode = "team" | "normal";

export interface KnowledgeRef {
  path: string;
  useWhen?: string;
  updatable?: boolean;
}

export interface SkillRegistryEntry {
  name: string;
  path: string;
  description: string;
  scope: "project" | "user";
  useWhen?: string;
}

export interface SddChangeStatus {
  name: string;
  path: string;
  files: string[];
  nextPhase: string;
  summary: string;
}

export interface SddStatus {
  configured: boolean;
  configPath?: string;
  activeChanges: SddChangeStatus[];
  suggestedRouting: string[];
}

// A filesystem scope. Each capability is tri-state:
//   true      → this scope explicitly ALLOWS the capability under `path`.
//   false     → this scope explicitly DENIES the capability under `path`.
//   undefined → this scope has no opinion on the capability (defer to others).
// Capabilities resolve per-path by most-specific-wins: among all scopes whose
// `path` is a prefix of the target, the longest path with an explicit opinion
// (true/false) decides. This lets a broad allow be carved out by a deeper
// `upsert: false` (a deny), and resolves each capability independently.
export interface DomainScope {
  path: string;
  read?: boolean;
  upsert?: boolean;
  delete?: boolean;
  description?: string;
}

export interface AgentConfig {
  name: string;
  path: string;
  color?: string;
  model?: string;
  tools?: string;
  thinking?: string;
  consultWhen?: string;
  routingTags?: string[];
  responsibilities?: string[];
  allowedAgents?: string[];
  context?: KnowledgeRef[];
  skills?: KnowledgeRef[];
  domain?: DomainScope[];
  members?: AgentConfig[];
  children?: AgentConfig[];
  role?: "orchestrator" | "lead" | "member";
  // Derived grouping label: the name of the top-level agent (the orchestrator's
  // direct report) whose subtree this agent belongs to. Not configured.
  groupName?: string;
}

export interface HiveConfig {
  orchestrator: AgentConfig;
  sharedContext: string[];
  settings: {
    subagentOutputLimit: number;
    defaultTools: string;
    maxParallel: number;
    distiller: {
      enabled: boolean;
      model: string;
      conversationLines: number;
    };
  };
  // The orchestrator's direct reports — each a normal agent node, nested as
  // deeply as needed. No special "team" shape.
  agents: AgentConfig[];
}

export interface AgentRuntime {
  config: AgentConfig;
  systemPrompt: string;
  status: AgentStatus;
  task: string;
  lastWork: string;
  toolCount: number;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  contextPct: number;
  runCount: number;
  sessionFile: string;
  startedAt?: number;
  timer?: ReturnType<typeof setInterval>;
}

export interface SessionState {
  sessionId: string;
  sessionDir: string;
  conversationLog: string;
  observabilityLog: string;
  activeTeam: string;
}

export interface YamlLine {
  indent: number;
  text: string;
}

// Shared mutable state for the extension. Replaces the closure-captured `let`
// bindings so the extension's logic can be split across modules. Functions that
// read or write any of these fields take this object as a parameter.
export interface HiveState {
  pi: ExtensionAPI;
  config: HiveConfig | null;
  session: SessionState | null;
  runtimes: Map<string, AgentRuntime>;
  widgetCtx: ExtensionContext | null;
  activeRuns: number;
  teamMode: TeamMode;
  normalToolNames: string[];
  streamStartMs: number;
  streamedChars: number;
  lastTokPerSec: number;
  skillRegistry: SkillRegistryEntry[];
  sddStatus: SddStatus | null;
  obsSeq: number;
  obsServer?: {
    proc: any;
    url: string;
    port: number;
  };
}
