import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AgentConfig, AgentRuntime, HiveState, HiveTeam } from "../core/types";
import type { HiveStateSnapshot, HiveTelemetryEvent, HiveTelemetryEventType, JsonRecord, TopologyNode } from "../shared/telemetry";
import { tryResolveProjectIdentity } from "../shared/project-identity";
import { agentSlug, truncateMiddle } from "../core/utils";
import { currentAgentName } from "./session";
import { withCrossProcessFileLock } from "../core/file-lock";
import { redactSensitive } from "../shared/privacy";
import { budgetRemaining } from "./governance";

export type HiveObsEventType = HiveTelemetryEventType;
export type HiveObsEvent<P = JsonRecord> = HiveTelemetryEvent<P>;

function telemetryEnabled(state: HiveState): boolean {
  return state.config?.settings?.telemetry?.enabled !== false;
}

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function appendPrivateJsonl(path: string, line: string, maxBytes?: number): void {
  privateDir(dirname(path));
  withCrossProcessFileLock(path, () => {
    if (maxBytes && existsSync(path)) {
      const size = statSync(path).size;
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const archive = `${path}.${stamp}`;
        renameSync(path, archive);
        chmodSync(archive, 0o600);
      }
    }
    appendFileSync(path, line, { mode: 0o600 });
    chmodSync(path, 0o600);
  });
}
export function hiveTelemetryRegistryPath(): string {
  const base = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(base, "hive", "telemetry-sessions.jsonl");
}

export function hiveTelemetryServerPidPath(): string {
  return join(dirname(hiveTelemetryRegistryPath()), "telemetry-server.json");
}

export function registerHiveTelemetrySession(state: HiveState, cwd: string) {
  if (!state.session || !telemetryEnabled(state)) return;
  const registryPath = hiveTelemetryRegistryPath();
  const identity = tryResolveProjectIdentity(cwd);
  privateDir(dirname(registryPath));
  withCrossProcessFileLock(registryPath, () => {
    appendFileSync(registryPath, `${JSON.stringify({
      registered_at: new Date().toISOString(),
      session_id: state.session!.sessionId,
      project_id: identity?.projectId,
      project_root: identity?.canonicalRoot,
      project_label: identity?.displayLabel,
      cwd,
      session_dir: state.session!.sessionDir,
      conversation_log: state.session!.conversationLog,
      telemetry_log: state.session!.observabilityLog,
      state_file: join(state.session!.sessionDir, "hive-state.json"),
      pid: process.pid,
      telemetry_settings: state.config?.settings?.telemetry,
    })}\n`, { mode: 0o600 });
    chmodSync(registryPath, 0o600);
  });
}

function agentSummary(agent: AgentConfig): TopologyNode {
  return {
    slug: agentSlug(agent),
    name: agent.name,
    role: agent.role,
    agentType: agent.agentType,
    stages: agent.stages,
    group: agent.groupName,
    color: agent.color,
    model: agent.model,
    tools: agent.tools,
    thinking: agent.thinking,
    consultWhen: agent.consultWhen,
    routingTags: agent.routingTags || [],
    // The enforcement boundary (A8): the glob list the agent may write, whether
    // it may commit (presence of commit guidance unlocks the gate), and its
    // declared responsibilities. These are what Phase E renders and what the
    // versioned topology (Phase C) hashes.
    domain: (agent.domain || []).map((scope) => scope.path),
    commit: Boolean(agent.commit && agent.commit.trim()),
    responsibilities: (agent.responsibilities || []).join("\n") || undefined,
    children: [...(agent.members || []), ...(agent.children || [])].map(agentSummary),
  };
}

function teamTopology(team?: HiveTeam): HiveStateSnapshot["topology"] | undefined {
  if (!team) return undefined;
  return {
    orchestrator: team.main ? agentSummary(team.main) : undefined,
    agents: (team.agents || []).map(agentSummary),
  };
}

export function hiveTopology(state: HiveState): HiveStateSnapshot["topology"] {
  const roots = state.config?.agents || [];
  return {
    orchestrator: state.config?.orchestrator ? agentSummary(state.config.orchestrator) : undefined,
    agents: roots.map(agentSummary),
  };
}

export function hiveTeamTopologies(state: HiveState): HiveStateSnapshot["topologies"] | undefined {
  if (!state.config) return undefined;
  return {
    active: state.mode === "plan" ? "planning" : "hive",
    hive: teamTopology(state.config.hive ?? { main: state.config.orchestrator, agents: state.config.agents }),
    planning: teamTopology(state.config.planning),
  };
}

export function runtimeSummary(state: HiveState, runtime: AgentRuntime): NonNullable<HiveStateSnapshot["agents"]>[number] {
  return {
    slug: agentSlug(runtime.config),
    name: runtime.config.name,
    group: runtime.config.groupName || "Orchestration",
    role: runtime.config.role,
    agentType: runtime.config.agentType,
    status: runtime.status,
    task: runtime.task,
    lastWork: truncateMiddle(runtime.lastWork || "", 400),
    runCount: runtime.runCount,
    distillerRunCount: runtime.distillerRunCount,
    toolCount: runtime.toolCount,
    elapsedMs: runtime.elapsedMs,
    inputTokens: runtime.inputTokens,
    outputTokens: runtime.outputTokens,
    cacheReadTokens: runtime.cacheReadTokens,
    cacheWriteTokens: runtime.cacheWriteTokens,
    reasoningTokens: runtime.reasoningTokens,
    costUsd: runtime.costUsd,
    governanceTokens: runtime.governanceTokens,
    governanceCostUsd: runtime.governanceCostUsd,
    contextPct: runtime.contextPct,
    // Raw context-window fill behind contextPct (Phase 4.7) — carried through so
    // the dashboard can show tokens/window, not just the percentage.
    contextTokens: runtime.contextTokens,
    contextWindow: runtime.contextWindow,
    sessionFile: runtime.sessionFile,
    model: runtime.config.model,
    thinking: runtime.config.thinking,
    thinkingLevels: runtime.thinkingLevels,
    // Per-run token baselines for TOK/S (J8): the UI reads output live − output
    // baseline over elapsedMs so the generation rate reflects the current run,
    // not lifetime prompt volume.
    runStartInputTokens: runtime.runStartInputTokens,
    runStartOutputTokens: runtime.runStartOutputTokens,
    budgetRemaining: budgetRemaining(state, runtime),
  };
}

// Overlay the accumulated orchestrator (main-session) usage onto the main
// node's runtime summary so its tokens/cost/tool-calls are observable (A5). The
// main node lives in state.runtimes as role "orchestrator" but its dispatch
// counters stay zero (it is never delegated to); its real activity is tracked
// on state.orchestratorRuntime by the hooks.
function withOrchestratorUsage(
  state: HiveState,
  summary: NonNullable<HiveStateSnapshot["agents"]>[number],
): NonNullable<HiveStateSnapshot["agents"]>[number] {
  const orch = state.orchestratorRuntime;
  if (!orch || summary.role !== "orchestrator") return summary;
  return {
    ...summary,
    status: orch.status || summary.status,
    elapsedMs: orch.elapsedMs ?? summary.elapsedMs,
    runStartInputTokens: orch.runStartInputTokens ?? summary.runStartInputTokens,
    runStartOutputTokens: orch.runStartOutputTokens ?? summary.runStartOutputTokens,
    toolCount: (summary.toolCount || 0) + orch.toolCount,
    inputTokens: (summary.inputTokens || 0) + orch.inputTokens,
    outputTokens: (summary.outputTokens || 0) + orch.outputTokens,
    cacheReadTokens: (summary.cacheReadTokens || 0) + orch.cacheReadTokens,
    cacheWriteTokens: (summary.cacheWriteTokens || 0) + orch.cacheWriteTokens,
    reasoningTokens: (summary.reasoningTokens || 0) + orch.reasoningTokens,
    costUsd: (summary.costUsd || 0) + orch.costUsd,
    // Phase 4.3: the main session's live context fill, captured at each turn end.
    contextPct: orch.contextPct ?? summary.contextPct,
    // Phase 4.7: the raw tokens/window behind that percent, threaded through the
    // same overlay so the main node carries them like a worker does.
    contextTokens: orch.tokens ?? summary.contextTokens,
    contextWindow: orch.contextWindow ?? summary.contextWindow,
  };
}

export function writeHiveStateSnapshot(state: HiveState) {
  if (!state.session || state.mode === "normal" || !telemetryEnabled(state)) return;
  const path = join(state.session.sessionDir, "hive-state.json");
  privateDir(dirname(path));
  const identity = tryResolveProjectIdentity(state.widgetCtx?.cwd);
  const snapshot: HiveStateSnapshot = {
    updated_at: new Date().toISOString(),
    session_id: state.session.sessionId,
    project_id: identity?.projectId,
    project_root: identity?.canonicalRoot,
    project_label: identity?.displayLabel,
    cwd: state.widgetCtx?.cwd,
    session_dir: state.session.sessionDir,
    telemetry_log: state.session.observabilityLog,
    conversation_log: state.session.conversationLog,
    topology: hiveTopology(state),
    topologies: hiveTeamTopologies(state),
    active_runs: state.activeRuns,
    agents: Array.from(state.runtimes.values()).map((runtime) => withOrchestratorUsage(state, runtimeSummary(state, runtime))),
  };
  const tmp = `${path}.${process.pid}.tmp`;
  const persisted = redactSensitive(snapshot, state.config?.settings?.telemetry?.redactSensitiveData !== false);
  writeFileSync(tmp, JSON.stringify(persisted), { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

// Distinct config-declared models across both teams (excluding "inherit"). Used
// to scope the model_catalog to what this project actually references (A10).
function configuredModels(state: HiveState): string[] {
  const models = new Set<string>();
  const visit = (node?: TopologyNode) => {
    if (!node) return;
    if (node.model && node.model !== "inherit") models.add(node.model);
    (node.children || []).forEach(visit);
  };
  const teams = hiveTeamTopologies(state);
  for (const team of [teams?.hive, teams?.planning]) {
    if (!team) continue;
    visit(team.orchestrator);
    (team.agents || []).forEach(visit);
  }
  return [...models];
}

interface CatalogModel {
  provider: string;
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, unknown>;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

function catalogModels(registry: unknown): CatalogModel[] | undefined {
  if (!registry || typeof registry !== "object") return undefined;
  const getAll = (registry as { getAll?: unknown }).getAll;
  if (typeof getAll !== "function") return undefined;
  let rows: unknown;
  try { rows = getAll.call(registry); } catch { return undefined; }
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is CatalogModel => {
    if (!row || typeof row !== "object") return false;
    const candidate = row as { provider?: unknown; id?: unknown };
    return typeof candidate.provider === "string" && typeof candidate.id === "string";
  });
}

// Emit one model_catalog event describing every model the active config
// references, sourced from the SDK ModelRegistry (A10). Best-effort: if the
// registry is unavailable the per-worker getAvailableThinkingLevels() path
// (dispatch.ts) still supplies authoritative levels incrementally.
export function emitModelCatalog(state: HiveState, registry: unknown, effectiveModel?: string) {
  if (!state.session || state.mode === "normal") return;
  const all = catalogModels(registry);
  if (!all) return;
  const wanted = new Set(configuredModels(state));
  // Include the session's current effective model (M1): `inherit` workers resolve
  // to it, so after a mid-session model switch the catalog must describe it even
  // when it isn't config-declared — otherwise those workers stay on an
  // undescribed model. `configuredModels` deliberately skips "inherit".
  if (effectiveModel && effectiveModel !== "inherit") wanted.add(effectiveModel);
  if (!wanted.size) return;
  const VOCAB = ["off", "minimal", "low", "medium", "high", "xhigh"];
  const thinkingLevelsOf = (model: CatalogModel): string[] => {
    if (!model?.reasoning) return ["off"];
    const map = model?.thinkingLevelMap;
    // Mirror pi-ai's getSupportedThinkingLevels() semantics exactly. The model
    // registry is the source of truth; this function is only the telemetry
    // projection used by the dashboard cache. In pi-ai, an explicit null marks a
    // level unsupported, most missing entries remain supported, and xhigh is the
    // one level that must be explicitly mapped.
    return VOCAB.filter((level) => {
      const mapped = map && typeof map === "object" ? map[level] : undefined;
      if (mapped === null) return false;
      if (level === "xhigh") return mapped !== undefined;
      return true;
    });
  };
  // Never-drop: iterate the config's wanted models (source of truth) rather than
  // filtering the registry down to them. A registry hit enriches the row; a miss
  // still persists a best-effort row so the dashboard has a record for every
  // config model — an empty ladder degrades to plain text, not a missing dial.
  const byKey = new Map<string, CatalogModel>();
  for (const model of all) byKey.set(`${model.provider}/${model.id}`, model);
  const models = [...wanted].map((key) => {
    const model = byKey.get(key);
    if (model) {
      return {
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        api: model.api,
        reasoning: Boolean(model.reasoning),
        thinkingLevels: thinkingLevelsOf(model),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        costRates: model.cost ? {
          input: model.cost.input,
          output: model.cost.output,
          cacheRead: model.cost.cacheRead,
          cacheWrite: model.cost.cacheWrite,
        } : undefined,
      };
    }
    // Miss: the registry doesn't know this model. Split provider/id from the
    // config string and emit a minimal row. The per-worker
    // getAvailableThinkingLevels() path can enrich thinking_levels later.
    const slash = key.indexOf("/");
    const provider = slash >= 0 ? key.slice(0, slash) : key;
    const modelId = slash >= 0 ? key.slice(slash + 1) : key;
    return {
      provider,
      modelId,
      name: undefined,
      api: undefined,
      reasoning: false,
      thinkingLevels: [] as string[],
      contextWindow: undefined,
      maxTokens: undefined,
      costRates: undefined,
    };
  });
  if (models.length) emitHiveEvent(state, "model_catalog", { models }, "System");
}

export function startHiveTelemetrySession(state: HiveState, cwd: string) {
  if (!state.session || state.mode === "normal" || state.telemetryRegistered || !telemetryEnabled(state)) return;
  state.telemetryRegistered = true;
  registerHiveTelemetrySession(state, cwd);
  // Phase 2.3: do NOT embed the full topology tree here. It was redundant with
  // topology_versions — the snapshot written immediately below is hashed,
  // versioned, and stamped onto the session by the daemon (runtime.ts), and no
  // consumer reads session_start.payload.topology. Keeping it duplicated the
  // whole tree on every session and drifted from the canonical hashed copy.
  emitHiveEvent(state, "session_start", {
    cwd,
    sessionDir: state.session.sessionDir,
    conversationLog: state.session.conversationLog,
    observabilityLog: state.session.observabilityLog,
  }, "System");
  writeHiveStateSnapshot(state);
  // Emit the model catalog at the first stable point where telemetry is live
  // (session set, mode no longer normal, log open). Uses the registry handle
  // captured from the full session_start ctx, so the pillar dial always has
  // level data. Idempotent by content hash, so re-running per session is cheap.
  emitModelCatalog(state, state.modelRegistry);
}

export function emitHiveEvent(state: HiveState, type: HiveObsEventType, payload: JsonRecord = {}, actor = currentAgentName()) {
  if (!state.session || state.mode === "normal" || !telemetryEnabled(state)) return;
  const logPath = state.session.observabilityLog;
  if (!logPath) return;
  const identity = tryResolveProjectIdentity(state.widgetCtx?.cwd);
  const event: HiveObsEvent = {
    event_id: randomUUID(),
    ts: new Date().toISOString(),
    type,
    session_id: state.session.sessionId,
    project_id: identity?.projectId,
    project_root: identity?.canonicalRoot,
    project_label: identity?.displayLabel,
    cwd: state.widgetCtx?.cwd,
    session_dir: state.session.sessionDir,
    telemetry_log: state.session.observabilityLog,
    actor,
    pid: process.pid,
    seq: state.obsSeq++,
    payload: redactSensitive(payload, state.config?.settings?.telemetry?.redactSensitiveData !== false),
  };
  const line = `${JSON.stringify(event)}\n`;
  appendPrivateJsonl(logPath, line, state.config?.settings?.telemetry?.maxLogBytes);
}

