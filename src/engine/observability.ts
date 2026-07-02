import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AgentConfig, AgentRuntime, HiveState, HiveTeam } from "../core/types";
import type { HiveStateSnapshot, HiveTelemetryEvent, HiveTelemetryEventType, JsonRecord, TopologyNode } from "../shared/telemetry";
import { ensureDir, truncateMiddle } from "../core/utils";
import { currentAgentName } from "./session";

export type HiveObsEventType = HiveTelemetryEventType;
export type HiveObsEvent<P = JsonRecord> = HiveTelemetryEvent<P>;
export function hiveTelemetryRegistryPath(): string {
  const base = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(base, "hive", "telemetry-sessions.jsonl");
}

export function hiveTelemetryServerPidPath(): string {
  return join(dirname(hiveTelemetryRegistryPath()), "telemetry-server.json");
}

export function registerHiveTelemetrySession(state: HiveState, cwd: string) {
  if (!state.session) return;
  const registryPath = hiveTelemetryRegistryPath();
  ensureDir(dirname(registryPath));
  appendFileSync(registryPath, `${JSON.stringify({
    registered_at: new Date().toISOString(),
    session_id: state.session.sessionId,
    cwd,
    session_dir: state.session.sessionDir,
    conversation_log: state.session.conversationLog,
    telemetry_log: state.session.observabilityLog,
    state_file: join(state.session.sessionDir, "hive-state.json"),
    pid: process.pid,
  })}\n`);
}

function agentSummary(agent: AgentConfig): TopologyNode {
  return {
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

export function runtimeSummary(runtime: AgentRuntime): NonNullable<HiveStateSnapshot["agents"]>[number] {
  return {
    name: runtime.config.name,
    group: runtime.config.groupName || "Orchestration",
    role: runtime.config.role,
    status: runtime.status,
    task: runtime.task,
    lastWork: truncateMiddle(runtime.lastWork || "", 400),
    runCount: runtime.runCount,
    toolCount: runtime.toolCount,
    elapsedMs: runtime.elapsedMs,
    inputTokens: runtime.inputTokens,
    outputTokens: runtime.outputTokens,
    cacheReadTokens: runtime.cacheReadTokens,
    cacheWriteTokens: runtime.cacheWriteTokens,
    costUsd: runtime.costUsd,
    contextPct: runtime.contextPct,
    sessionFile: runtime.sessionFile,
    model: runtime.config.model,
    thinking: runtime.config.thinking,
    thinkingLevels: runtime.thinkingLevels,
    // Per-run token baselines for TOK/S (J8): the UI reads (live − baseline)
    // over elapsedMs so the rate reflects the current run, not lifetime.
    runStartInputTokens: runtime.runStartInputTokens,
    runStartOutputTokens: runtime.runStartOutputTokens,
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
    toolCount: (summary.toolCount || 0) + orch.toolCount,
    inputTokens: (summary.inputTokens || 0) + orch.inputTokens,
    outputTokens: (summary.outputTokens || 0) + orch.outputTokens,
    cacheReadTokens: (summary.cacheReadTokens || 0) + orch.cacheReadTokens,
    cacheWriteTokens: (summary.cacheWriteTokens || 0) + orch.cacheWriteTokens,
    costUsd: (summary.costUsd || 0) + orch.costUsd,
  };
}

export function writeHiveStateSnapshot(state: HiveState) {
  if (!state.session || state.mode === "normal") return;
  const path = join(state.session.sessionDir, "hive-state.json");
  ensureDir(dirname(path));
  const snapshot: HiveStateSnapshot = {
    updated_at: new Date().toISOString(),
    session_id: state.session.sessionId,
    cwd: state.widgetCtx?.cwd,
    session_dir: state.session.sessionDir,
    telemetry_log: state.session.observabilityLog,
    conversation_log: state.session.conversationLog,
    topology: hiveTopology(state),
    topologies: hiveTeamTopologies(state),
    active_runs: state.activeRuns,
    agents: Array.from(state.runtimes.values()).map((runtime) => withOrchestratorUsage(state, runtimeSummary(runtime))),
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot));
  renameSync(tmp, path);
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

// Emit one model_catalog event describing every model the active config
// references, sourced from the SDK ModelRegistry (A10). Best-effort: if the
// registry is unavailable the per-worker getAvailableThinkingLevels() path
// (dispatch.ts) still supplies authoritative levels incrementally.
export function emitModelCatalog(state: HiveState, registry: any) {
  if (!state.session || state.mode === "normal" || !registry?.getAll) return;
  const wanted = new Set(configuredModels(state));
  if (!wanted.size) return;
  let all: any[] = [];
  try { all = registry.getAll() || []; } catch { return; }
  const VOCAB = ["off", "minimal", "low", "medium", "high", "xhigh"];
  const thinkingLevelsOf = (model: any): string[] => {
    const map = model?.thinkingLevelMap;
    // No map: reasoning models expose the full thinking ladder (no explicit
    // "off"); non-reasoning models expose only "off".
    if (!map || typeof map !== "object") {
      return model?.reasoning ? VOCAB.filter((l) => l !== "off") : ["off"];
    }
    // With a map: a level is supported when its key is present and non-null
    // (explicit null marks it unsupported; pi-ai types.d.ts:576-577). The
    // authoritative per-worker answer comes from getAvailableThinkingLevels().
    const levels = VOCAB.filter((level) => level in map && map[level] !== null);
    return levels.length ? levels : (model?.reasoning ? VOCAB.filter((l) => l !== "off") : ["off"]);
  };
  const models = all
    .filter((model) => wanted.has(`${model.provider}/${model.id}`))
    .map((model) => ({
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
    }));
  if (models.length) emitHiveEvent(state, "model_catalog", { models }, "System");
}

export function startHiveTelemetrySession(state: HiveState, cwd: string) {
  if (!state.session || state.mode === "normal" || state.telemetryRegistered) return;
  state.telemetryRegistered = true;
  registerHiveTelemetrySession(state, cwd);
  emitHiveEvent(state, "session_start", {
    cwd,
    sessionDir: state.session.sessionDir,
    conversationLog: state.session.conversationLog,
    observabilityLog: state.session.observabilityLog,
    topology: hiveTopology(state),
  }, "System");
  writeHiveStateSnapshot(state);
}

export function emitHiveEvent(state: HiveState, type: HiveObsEventType, payload: JsonRecord = {}, actor = currentAgentName()) {
  if (!state.session || state.mode === "normal") return;
  const logPath = state.session.observabilityLog;
  if (!logPath) return;
  ensureDir(dirname(logPath));
  const event: HiveObsEvent = {
    event_id: randomUUID(),
    ts: new Date().toISOString(),
    type,
    session_id: state.session.sessionId,
    cwd: state.widgetCtx?.cwd,
    session_dir: state.session.sessionDir,
    telemetry_log: state.session.observabilityLog,
    actor,
    pid: process.pid,
    seq: state.obsSeq++,
    payload,
  };
  appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

