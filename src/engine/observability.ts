import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AgentConfig, AgentRuntime, HiveState } from "../core/types";
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
    group: agent.groupName,
    color: agent.color,
    model: agent.model,
    tools: agent.tools,
    thinking: agent.thinking,
    consultWhen: agent.consultWhen,
    routingTags: agent.routingTags || [],
    children: [...(agent.members || []), ...(agent.children || [])].map(agentSummary),
  };
}

export function hiveTopology(state: HiveState): HiveStateSnapshot["topology"] {
  const roots = state.config?.agents || [];
  return {
    orchestrator: state.config?.orchestrator ? agentSummary(state.config.orchestrator) : undefined,
    agents: roots.map(agentSummary),
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
    costUsd: runtime.costUsd,
    contextPct: runtime.contextPct,
    sessionFile: runtime.sessionFile,
    model: runtime.config.model,
    thinking: runtime.config.thinking,
  };
}

export function writeHiveStateSnapshot(state: HiveState) {
  if (!state.session) return;
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
    active_runs: state.activeRuns,
    agents: Array.from(state.runtimes.values()).map(runtimeSummary),
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot));
  renameSync(tmp, path);
}

export function emitHiveEvent(state: HiveState, type: HiveObsEventType, payload: JsonRecord = {}, actor = currentAgentName()) {
  if (!state.session) return;
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

