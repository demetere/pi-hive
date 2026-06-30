import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AgentConfig, AgentRuntime, HiveState, JsonRecord } from "../core/types";
import { ensureDir, truncateMiddle } from "../core/utils";
import { currentAgentName } from "./session";

export type HiveObsEventType =
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

export interface HiveObsEvent<P = JsonRecord> {
  event_id: string;
  ts: string;
  type: HiveObsEventType;
  session_id: string;
  cwd?: string;
  session_dir?: string;
  telemetry_log?: string;
  actor: string;
  pid: number;
  seq: number;
  payload: P;
}

export function hiveTelemetryRegistryPath(): string {
  const base = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(base, "hive", "telemetry-sessions.jsonl");
}

export function registerHiveTelemetrySession(state: HiveState, cwd: string) {
  if (!state.session || process.env.PI_HIVE_CHILD === "1") return;
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

function agentSummary(agent: AgentConfig): JsonRecord {
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

export function hiveTopology(state: HiveState): JsonRecord {
  const roots = state.config?.agents || [];
  return {
    orchestrator: state.config?.orchestrator ? agentSummary(state.config.orchestrator) : undefined,
    agents: roots.map(agentSummary),
  };
}

export function runtimeSummary(runtime: AgentRuntime): JsonRecord {
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
    sessionFile: runtime.sessionFile,
    model: runtime.config.model,
    thinking: runtime.config.thinking,
  };
}

export function writeHiveStateSnapshot(state: HiveState) {
  if (!state.session || process.env.PI_HIVE_CHILD === "1") return;
  const path = join(state.session.sessionDir, "hive-state.json");
  ensureDir(dirname(path));
  const snapshot = {
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

