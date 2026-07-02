import * as fs from "node:fs";
import * as path from "node:path";
import { agentRuns, parseAgentLog } from "../agent-log";
import { projectName } from "../../shared/project";
import { loadConfig } from "../../core/config";
import type { AgentConfig, HiveTeam } from "../../core/types";
import type { HiveStateSnapshot, HiveTelemetryEvent, TelemetryRegistryRow, TelemetrySessionSummary, TopologyNode } from "../../shared/telemetry";
import { BOOT_SESSION_ID, CONVERSATION_LOG, MAX_EVENTS, PROJECT_CWD, REGISTRY_PATH, SINGLE_LOG_PATH } from "./config";
import {
  dbEventRow,
  dbSessionRowFromEvent,
  deleteSessionRows,
  insertEvent,
  insertPlanApproval,
  insertPlanComment,
  insertPlanVerdict,
  loadPersistedEvents,
  loadPersistedStates,
  upsertSession,
  upsertState,
} from "./db";
import { broadcastEvent } from "./sse";
import type { Source } from "./types";

const sources = new Map<string, Source>();
const snapshots = new Map<string, HiveStateSnapshot>();
let events: HiveTelemetryEvent[] = [];
let started = false;

export function sourcePaths(): string[] {
  return Array.from(sources.keys());
}

export function allEvents(): HiveTelemetryEvent[] {
  return events;
}

export function allSnapshots(): HiveStateSnapshot[] {
  return Array.from(snapshots.values()).map(enrichSnapshotTopologies);
}

export function addSource(logPath: string, meta: TelemetryRegistryRow = {}) {
  if (!logPath) return;
  const abs = path.resolve(logPath);
  const existing = sources.get(abs);
  if (existing) {
    existing.meta = { ...existing.meta, ...meta };
    return;
  }
  const statePath = path.resolve(meta.state_file || path.join(path.dirname(abs), "hive-state.json"));
  sources.set(abs, { logPath: abs, offset: 0, meta, statePath, stateMtimeMs: 0 });
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.closeSync(fs.openSync(abs, "a"));
    fs.watchFile(abs, { interval: 500 }, () => readSource(abs));
    fs.watchFile(statePath, { interval: 500 }, () => readState(abs));
  } catch {
    // Ignore unreadable stale sources. They remain in the registry and can
    // become readable later if the project volume comes back.
  }
  readSource(abs);
  readState(abs);
}

export function readRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) return;
  const latest = new Map<string, TelemetryRegistryRow>();
  const lines = fs.readFileSync(REGISTRY_PATH, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as TelemetryRegistryRow;
      if (row.telemetry_log) latest.set(path.resolve(row.telemetry_log), row);
    } catch { /* ignore corrupt registry rows */ }
  }
  for (const row of latest.values()) if (row.telemetry_log) addSource(row.telemetry_log, row);
}

export function readSource(logPath: string) {
  const source = sources.get(path.resolve(logPath));
  if (!source || !fs.existsSync(source.logPath)) return;
  const stat = fs.statSync(source.logPath);
  if (stat.size < source.offset) source.offset = 0;
  if (stat.size === source.offset) return;
  const fd = fs.openSync(source.logPath, "r");
  try {
    const len = stat.size - source.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, source.offset);
    source.offset = stat.size;
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try { addEvent(enrichEvent(JSON.parse(line), source)); } catch { /* ignore partial/corrupt lines */ }
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function readState(logPath: string) {
  const source = sources.get(path.resolve(logPath));
  if (!source || !fs.existsSync(source.statePath)) return;
  let stat: fs.Stats;
  try { stat = fs.statSync(source.statePath); } catch { return; }
  if (stat.mtimeMs <= source.stateMtimeMs) return;
  source.stateMtimeMs = stat.mtimeMs;
  try {
    const snapshot = JSON.parse(fs.readFileSync(source.statePath, "utf8")) as HiveStateSnapshot;
    snapshot.telemetry_log ||= source.logPath;
    snapshot.cwd ||= source.meta.cwd;
    addSnapshot(snapshot);
  } catch { /* ignore partial snapshot writes */ }
}

const topologyCache = new Map<string, { mtimeMs: number; topologies?: HiveStateSnapshot["topologies"] }>();

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
    children: [...(agent.members || []), ...(agent.children || [])].map(agentSummary),
  };
}

function teamTopology(team?: HiveTeam): HiveStateSnapshot["topology"] | undefined {
  if (!team) return undefined;
  return { orchestrator: team.main ? agentSummary(team.main) : undefined, agents: (team.agents || []).map(agentSummary) };
}

function configuredTopologies(cwd: string | undefined, legacy?: HiveStateSnapshot["topology"]): HiveStateSnapshot["topologies"] | undefined {
  if (!cwd) return undefined;
  const configPath = path.join(cwd, ".pi", "hive", "hive-config.yaml");
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(configPath).mtimeMs; } catch { return undefined; }
  const cached = topologyCache.get(cwd);
  if (cached && cached.mtimeMs === mtimeMs) return cached.topologies;
  try {
    const config = loadConfig(cwd);
    const hive = teamTopology(config.hive ?? { main: config.orchestrator, agents: config.agents });
    const planning = teamTopology(config.planning);
    const legacyRoot = legacy?.orchestrator?.name;
    const active = legacyRoot && planning?.orchestrator?.name === legacyRoot && hive?.orchestrator?.name !== legacyRoot ? "planning" : "hive";
    const topologies: HiveStateSnapshot["topologies"] = { active, hive, planning };
    topologyCache.set(cwd, { mtimeMs, topologies });
    return topologies;
  } catch {
    topologyCache.set(cwd, { mtimeMs, topologies: undefined });
    return undefined;
  }
}

function enrichSnapshotTopologies(snapshot: HiveStateSnapshot): HiveStateSnapshot {
  if (!snapshot || snapshot.topologies || !snapshot.cwd) return snapshot;
  const topologies = configuredTopologies(snapshot.cwd, snapshot.topology);
  return topologies ? { ...snapshot, topologies } : snapshot;
}

function addSnapshot(snapshot: HiveStateSnapshot) {
  if (!snapshot || !snapshot.session_id) return;
  snapshot.updated_at ||= new Date().toISOString();
  snapshot = enrichSnapshotTopologies(snapshot);
  snapshots.set(snapshot.session_id, snapshot);
  upsertState.run({
    $session_id: snapshot.session_id,
    $updated_at: snapshot.updated_at,
    $cwd: snapshot.cwd || null,
    $session_dir: snapshot.session_dir || null,
    $telemetry_log: snapshot.telemetry_log || null,
    $state_json: JSON.stringify(snapshot),
  });
  upsertSession.run({
    $session_id: snapshot.session_id,
    $cwd: snapshot.cwd || null,
    $session_dir: snapshot.session_dir || null,
    $telemetry_log: snapshot.telemetry_log || null,
    $conversation_log: snapshot.conversation_log || null,
    $state_file: snapshot.session_dir ? path.join(snapshot.session_dir, "hive-state.json") : null,
    $ts: snapshot.updated_at,
  });
  broadcastEvent("hive_state", snapshot);
}

function enrichEvent(event: HiveTelemetryEvent, source: Source): HiveTelemetryEvent {
  event.cwd ||= source.meta.cwd;
  event.session_dir ||= source.meta.session_dir;
  event.telemetry_log ||= source.logPath;
  event.conversation_log ||= source.meta.conversation_log;
  return event;
}

// Materialize plan-store events into their typed tables. The core extension
// emits these as ordinary telemetry events (it cannot reach bun:sqlite); the
// dashboard turns them into queryable rows here. The event_id is reused as the
// row id so INSERT OR IGNORE makes materialization idempotent on replay.
function materializePlanEvent(event: HiveTelemetryEvent) {
  const payload = (event.payload || {}) as any;
  const changeId = typeof payload.changeId === "string" ? payload.changeId.trim() : "";
  if (!changeId) return; // no active change ⇒ nothing plan-scoped to record
  if (event.type === "review_verdict") {
    insertPlanVerdict({
      id: event.event_id,
      changeId,
      reviewer: String(payload.reviewer || event.actor || "reviewer"),
      verdict: String(payload.verdict || "yellow"),
      summary: payload.summary ? String(payload.summary) : undefined,
      evidence: payload.evidence,
      concerns: payload.concerns,
      blockers: payload.blockers,
      sessionId: event.session_id,
      createdAt: event.ts,
    });
  } else if (event.type === "plan_approval") {
    insertPlanApproval({
      id: event.event_id,
      changeId,
      phase: String(payload.phase || "proposal"),
      approvedBy: String(payload.approvedBy || "chat"),
      actor: payload.actor ? String(payload.actor) : (event.actor || undefined),
      summary: payload.summary ? String(payload.summary) : undefined,
      sessionId: event.session_id,
      createdAt: event.ts,
    });
  } else if (event.type === "plan_comment") {
    insertPlanComment({
      id: event.event_id,
      changeId,
      file: payload.file ? String(payload.file) : undefined,
      anchor: payload.anchor ? String(payload.anchor) : undefined,
      author: payload.author ? String(payload.author) : (event.actor || undefined),
      body: String(payload.body || ""),
      annotationType: payload.annotationType ? String(payload.annotationType) : undefined,
      originalText: payload.originalText ? String(payload.originalText) : undefined,
      sessionId: event.session_id,
      createdAt: event.ts,
    });
  }
}

function addEvent(event: HiveTelemetryEvent) {
  if (!event || !event.event_id) return;
  // Progress is volatile node state, not durable history. Older logs may contain
  // delegation_progress rows; ignore them so event counts/lists stay meaningful.
  if (event.type === "delegation_progress") return;
  if (events.some((existing) => existing.event_id === event.event_id)) return;
  const result = insertEvent.run(dbEventRow(event));
  upsertSession.run(dbSessionRowFromEvent(event));
  if (result.changes === 0) return;
  materializePlanEvent(event);
  events.push(event);
  events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.session_id).localeCompare(String(b.session_id)) || Number(a.seq || 0) - Number(b.seq || 0));
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  broadcastEvent("hive", event);
}

function loadDbIntoMemory() {
  events = loadPersistedEvents(MAX_EVENTS);
  for (const snapshot of loadPersistedStates()) snapshots.set(snapshot.session_id, enrichSnapshotTopologies(snapshot));
}

export function sessionSummaries(): TelemetrySessionSummary[] {
  const byId = new Map<string, TelemetrySessionSummary>();
  for (const event of events) {
    const id = event.session_id || "unknown";
    const current = byId.get(id) || {
      session_id: id,
      cwd: event.cwd,
      session_dir: event.session_dir,
      telemetry_log: event.telemetry_log,
      first_ts: event.ts,
      last_ts: event.ts,
      event_count: 0,
      running: 0,
      tokens: 0,
      cost: 0,
    };
    current.cwd ||= event.cwd;
    current.session_dir ||= event.session_dir;
    current.telemetry_log ||= event.telemetry_log;
    current.first_ts = current.first_ts && current.first_ts < event.ts ? current.first_ts : event.ts;
    current.last_ts = current.last_ts && current.last_ts > event.ts ? current.last_ts : event.ts;
    current.event_count++;
    const rt = (event.payload as any)?.runtime;
    if (rt) {
      current.tokens = Math.max(current.tokens, Number(rt.inputTokens || 0) + Number(rt.outputTokens || 0));
      current.cost = Math.max(current.cost, Number(rt.costUsd || 0));
    }
    byId.set(id, current);
  }
  for (const snapshot of snapshots.values()) {
    const id = snapshot.session_id;
    const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
    const tokens = agents.reduce((sum, agent) => sum + Number(agent.inputTokens || 0) + Number(agent.outputTokens || 0), 0);
    const cost = agents.reduce((sum, agent) => sum + Number(agent.costUsd || 0), 0);
    const running = agents.filter((agent) => agent.status === "running").length;
    const current = byId.get(id) || {
      session_id: id,
      cwd: snapshot.cwd,
      session_dir: snapshot.session_dir,
      telemetry_log: snapshot.telemetry_log,
      first_ts: snapshot.updated_at,
      last_ts: snapshot.updated_at,
      event_count: 0,
      running: 0,
      tokens: 0,
      cost: 0,
    };
    current.cwd ||= snapshot.cwd;
    current.session_dir ||= snapshot.session_dir;
    current.telemetry_log ||= snapshot.telemetry_log;
    current.last_ts = !current.last_ts || current.last_ts < snapshot.updated_at ? snapshot.updated_at : current.last_ts;
    current.running = Math.max(current.running || 0, running);
    current.tokens = Math.max(current.tokens || 0, tokens);
    current.cost = Math.max(current.cost || 0, cost);
    byId.set(id, current);
  }
  return Array.from(byId.values()).sort((a, b) => String(b.last_ts).localeCompare(String(a.last_ts)));
}

// Rewrite the global registry file, dropping any rows for the given session ids.
function pruneRegistry(removed: Set<string>) {
  if (!fs.existsSync(REGISTRY_PATH)) return;
  const kept: string[] = [];
  for (const line of fs.readFileSync(REGISTRY_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as TelemetryRegistryRow;
      if (!row.session_id || !removed.has(row.session_id)) kept.push(line);
    } catch { kept.push(line); }
  }
  fs.writeFileSync(REGISTRY_PATH, kept.length ? kept.join("\n") + "\n" : "");
}

// Delete sessions everywhere they live: SQLite (events/states/sessions),
// in-memory caches, the live source watchers, and the registry. This only
// purges telemetry — it never touches the project's own conversation logs or
// hive-state files on disk. Returns the count actually removed.
export function deleteSessions(ids: string[]): number {
  const idSet = new Set(ids.filter(Boolean));
  if (!idSet.size) return 0;
  deleteSessionRows(Array.from(idSet));

  events = events.filter((e) => !idSet.has(e.session_id));
  for (const id of idSet) snapshots.delete(id);

  for (const [abs, source] of Array.from(sources.entries())) {
    const sid = source.meta?.session_id;
    if (sid && idSet.has(sid)) {
      try { fs.unwatchFile(abs); fs.unwatchFile(source.statePath); } catch { /* noop */ }
      sources.delete(abs);
    }
  }
  pruneRegistry(idSet);

  broadcastEvent("hive_delete", { session_ids: Array.from(idSet) });
  return idSet.size;
}

export function deleteProject(name: string): number {
  const ids = sessionSummaries().filter((s) => projectName(s.cwd)).filter((s) => projectName(s.cwd) === name).map((s) => s.session_id);
  return deleteSessions(ids);
}

// Resolve an agent's own conversation-log file from the latest snapshot. The
// snapshot's agents[] carry the sessionFile each pi subprocess writes to.
export function agentLogPath(sessionId: string, agentName: string): { file?: string; status?: string; main?: boolean } {
  const snap = snapshots.get(sessionId);
  if (!snap) return {};
  const activeRoot = snap.topologies?.active ? snap.topologies[snap.topologies.active]?.orchestrator?.name : snap.topology?.orchestrator?.name;
  const isMain = agentName === activeRoot || (agentName === "Orchestrator" && !!activeRoot) || (agentName === "Planning Lead" && activeRoot === "Planning Lead");
  const agent = Array.isArray(snap.agents) ? snap.agents.find((candidate) => candidate.name === agentName) : undefined;
  if (isMain) return { file: agent?.sessionFile && fs.existsSync(agent.sessionFile) ? agent.sessionFile : snap.conversation_log, status: agent?.status || "running", main: true };
  if (!agent || !agent.sessionFile) return { status: agent?.status };
  return { file: agent.sessionFile, status: agent.status };
}

function parseMainConversationLog(file: string, fromOffset = 0): { entries: any[]; offset: number; size: number } {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return { entries: [], offset: 0, size: 0 }; }
  const start = fromOffset > stat.size ? 0 : fromOffset;
  const text = fs.readFileSync(file, "utf8").slice(start);
  const entries: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    const from = String(row.from || "assistant");
    const type = String(row.type || "message");
    const role = from === "User" ? "user" : from === "System" ? "system" : "assistant";
    const heading = row.to ? `${from} → ${row.to} · ${type}` : `${from} · ${type}`;
    const body = row.message ? `${heading}\n\n${row.message}` : heading;
    entries.push({ kind: "message", role, parts: [{ type: "text", text: body }], ts: row.timestamp });
  }
  return { entries, offset: stat.size, size: stat.size };
}

// Thinking/reasoning entries live only in per-agent transcripts, not the event
// stream. Collect the recent ones across a session's agents so the Activity feed
// can interleave "thinking" as first-class activity. Bounded per agent + overall
// so a huge fleet can't flood the response.
export interface ThinkingEntry { agent: string; ts: string; text: string; tokens: number; }
export function recentThinking(sessionId: string, perAgent = 12, overall = 200): ThinkingEntry[] {
  const snap = snapshots.get(sessionId);
  if (!snap || !Array.isArray(snap.agents)) return [];
  const out: ThinkingEntry[] = [];
  for (const a of snap.agents) {
    const file = a?.sessionFile;
    if (!file || !fs.existsSync(file)) continue;
    let parsed;
    try { parsed = parseAgentLog(file, 0); } catch { continue; }
    const think: ThinkingEntry[] = [];
    for (const e of parsed.entries) {
      if (e.kind !== "message" || !Array.isArray(e.parts)) continue;
      // Tokens this generation added — prefer the reasoning count, else output.
      const u = (e as any).usage || {};
      const tokens = Number(u.reasoning || 0) || Number(u.output || 0) || 0;
      for (const p of e.parts) {
        if (p.type === "thinking" && p.text && p.text.trim()) {
          think.push({ agent: a.name, ts: e.ts || "", text: p.text.trim(), tokens });
        }
      }
    }
    // keep only the most recent few per agent
    for (const t of think.slice(-perAgent)) out.push(t);
  }
  out.sort((x, y) => String(y.ts).localeCompare(String(x.ts)));
  return out.slice(0, overall);
}

export function readAgentLog(sessionId: string, agent: string, offset: number, runId: string): any {
  const { file: currentFile, status, main } = agentLogPath(sessionId, agent);
  if (!currentFile) return { entries: [], offset: 0, size: 0, status: status || "unknown", exists: false, runs: [] };
  if (main) {
    const parsed = parseMainConversationLog(currentFile, offset);
    return {
      entries: parsed.entries,
      offset: parsed.offset,
      size: parsed.size,
      status: status || "running",
      exists: true,
      running: true,
      runs: [{ id: "current", label: "Main session" }],
      run: "current",
    };
  }
  const runs = agentRuns(currentFile);
  if (!runs.length) return { entries: [], offset: 0, size: 0, status, exists: false, runs: [] };
  const chosen = runs.find((r) => r.id === runId) || runs[0];
  const parsed = parseAgentLog(chosen.file, offset);
  return {
    entries: parsed.entries,
    offset: parsed.offset,
    size: parsed.size,
    status,
    exists: true,
    running: status === "running" && chosen.id === "current",
    runs: runs.map((r) => ({ id: r.id, label: r.label })),
    run: chosen.id,
  };
}

export function startTelemetryRuntime() {
  if (started) return;
  started = true;
  loadDbIntoMemory();
  readRegistry();
  if (SINGLE_LOG_PATH) addSource(SINGLE_LOG_PATH, { cwd: PROJECT_CWD, conversation_log: CONVERSATION_LOG, session_id: BOOT_SESSION_ID });
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.closeSync(fs.openSync(REGISTRY_PATH, "a"));
  fs.watchFile(REGISTRY_PATH, { interval: 1000 }, readRegistry);
  setInterval(() => {
    readRegistry();
    for (const source of sources.values()) {
      readSource(source.logPath);
      readState(source.logPath);
    }
  }, 2000).unref?.();
}
