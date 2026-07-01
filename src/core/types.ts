// ── Types ────────────────────────────────────────────────────────────────────

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type AgentStatus = "idle" | "running" | "done" | "error";
export type JsonRecord = Record<string, any>;
// The three session modes:
//   normal — plain Pi chat: no hive tools, no domain/type enforcement.
//   plan   — hive active but scoped to the PLANNING team (planners + the leads
//            that route to them). The orchestrator drives planners to produce
//            full specs (proposal→requirements→design→tasks); no code execution.
//   hive   — full hive: delegates to coders/testers/reviewers, executes tasks.
// "team" is a back-compat alias for "hive" (older persisted state / configs).
export type HiveMode = "normal" | "plan" | "hive";
export type TeamMode = HiveMode | "team";

// Normalize any stored/legacy mode value to a canonical HiveMode.
export function canonicalMode(mode: TeamMode | string | undefined): HiveMode {
  if (mode === "plan") return "plan";
  if (mode === "hive" || mode === "team") return "hive";
  return "normal";
}

// An agent's capability type. Enforced (on top of the filesystem-domain
// boundary) by the type-policy layer: it decides which ACTIONS an agent may
// perform on which KIND of file. Distinct from the derived tree role
// (orchestrator/lead/member) which only governs delegation.
export type AgentType = "planner" | "coder" | "tester" | "reviewer" | "lead";

// The four planning gates a planner may own. Derived (never enforced) as a
// workflow phase from which files exist on disk; used here only to scope which
// gate artifacts a given planner may write (see AgentConfig.stages).
export type PlanStage = "proposal" | "requirements" | "design" | "tasks";

export interface KnowledgeRef {
  path: string;
  useWhen?: string;
  updatable?: boolean;
}

// A reviewer's structured verdict on a change. green = clean approval; yellow =
// approve with non-blocking concerns (proceed, surface concerns); red = blocked
// (populate blockers). Submitted via the reviewer-only submit_review_verdict
// tool, recorded as a telemetry event, and materialized into the plan_verdicts
// SQLite table by the dashboard on ingest.
export type ReviewVerdictLevel = "red" | "yellow" | "green";

export interface ReviewVerdict {
  changeId: string;
  reviewer: string;
  verdict: ReviewVerdictLevel;
  summary: string;
  evidence: string[];
  concerns: string[];
  blockers: string[];
  createdAt: string;
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

// A filesystem scope. Every capability must be explicit so the config is easy
// to audit: true ALLOWS, false DENIES. Optional include/exclude globs narrow a
// rule to matching files under `path` (matched relative to that path). Access is
// resolved by most-specific-wins: deeper paths beat broader paths, and matching
// include globs beat catch-all rules at the same path. Exact ties deny.
export interface DomainScope {
  path: string;
  read: boolean;
  upsert: boolean;
  delete: boolean;
  include?: string[];
  exclude?: string[];
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
  // The agent's capability type. REQUIRED for every agent (validation
  // hard-fails if missing). Enforced by the type-policy layer.
  agentType?: AgentType;
  // Planner-only: which planning gate artifacts this planner may write.
  // Omitted = all four gates. Ignored for non-planners.
  stages?: PlanStage[];
  // Optional commit guidance. Its PRESENCE (non-empty) unlocks the commit gate
  // for this agent (only leads carry it in practice); the text is injected into
  // the agent's prompt as guidance.
  commit?: string;
  // Derived grouping label: the name of the top-level agent (the orchestrator's
  // direct report) whose subtree this agent belongs to. Not configured.
  groupName?: string;
}

// One team = a `main` (root) node plus its direct reports (each nested as deeply
// as needed). The hive team runs in hive mode; the optional planning team runs
// in plan mode. Both are ordinary agent trees; `main` IS the visible main
// session for that mode and carries its own agent-type/domain/tools.
export interface HiveTeam {
  main: AgentConfig;
  agents: AgentConfig[];
}

export interface HiveSettings {
  subagentOutputLimit: number;
  defaultTools: string;
  maxParallel: number;
  distiller: {
    enabled: boolean;
    model: string;
    conversationLines: number;
  };
}

export interface HiveConfig {
  // The ACTIVE team's root + reports. These mirror whichever team is active for
  // the current mode (hive team by default) so all existing code that reads
  // config.orchestrator / config.agents keeps working unchanged.
  orchestrator: AgentConfig;
  agents: AgentConfig[];
  sharedContext: string[];
  settings: HiveSettings;
  // The raw team blocks, populated by loadConfig. `hive` mirrors the legacy
  // top-level orchestrator:/agents:. `planning` is present only when a
  // planning: block is configured. Both optional so hand-built HiveConfig
  // objects (tests, ad-hoc) need not supply them — teamForMode falls back to
  // orchestrator/agents when `hive` is absent.
  hive?: HiveTeam;
  planning?: HiveTeam;
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
  session?: any;
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
  // The current session mode. Normal = plain Pi; plan = planning team; hive =
  // execution team. (Was `teamMode`; renamed for the three-mode model.)
  mode: HiveMode;
  normalToolNames: string[];
  streamStartMs: number;
  streamedChars: number;
  lastTokPerSec: number;
  sddStatus: SddStatus | null;
  obsSeq: number;
  // The currently-selected plan change-id (set by plan_new/plan_select and
  // /hive-execute). Persists across turns; delegations are wrapped in
  // runWithChange(activeChangeId) so workers' tools see it via currentChangeId().
  activeChangeId?: string;
  // Latest verdict per change-id, tracked in-memory as reviewers submit them.
  // The core cannot read the plan_verdicts SQLite table (Bun-only), so this is
  // how team_status surfaces the most recent verdict without a DB round-trip.
  latestVerdicts?: Map<string, ReviewVerdict>;
  onRuntimeUpdate?: (state: HiveState) => void;
  onRuntimeFinish?: (runtime: AgentRuntime, ctx: ExtensionContext) => void;
  // The shared, global telemetry dashboard. It is a machine-wide daemon (reads
  // the global registry/DB under ~/.pi/agent/hive/), so it is started once and
  // reused across sessions, and it SURVIVES an individual session shutdown.
  // `proc` is set only for the session that spawned it; a session that merely
  // adopted an already-running daemon has `proc` undefined but still records the
  // url/port for the header indicator.
  obsServer?: {
    proc?: any;
    url: string;
    port: number;
    host: string;
    adopted?: boolean;
  };
}
