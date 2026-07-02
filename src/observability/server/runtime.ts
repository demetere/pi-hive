import * as fs from "node:fs";
import * as path from "node:path";
import { agentRuns, parseAgentLog } from "../agent-log";
import { projectName } from "../../shared/project";
import { loadConfig } from "../../core/config";
import type { AgentConfig, HiveTeam } from "../../core/types";
import type { HiveStateSnapshot, HiveTelemetryEvent, TelemetryRegistryRow, TelemetrySessionSummary, TopologyNode } from "../../shared/telemetry";
import { BOOT_SESSION_ID, CONVERSATION_LOG, PROJECT_CWD, REGISTRY_PATH, SINGLE_LOG_PATH } from "./config";
import {
  db,
  dbEventRow,
  dbSessionRowFromEvent,
  deleteSessionRows,
  ensureSession,
  getIngestOffset,
  insertEvent,
  insertPlanApproval,
  insertPlanComment,
  insertPlanVerdict,
  loadPersistedStates,
  materializeDelegationEnd,
  materializeDelegationStart,
  materializeMessage,
  materializeToolEnd,
  materializeToolStart,
  maxEventCursor,
  querySessionSummaries,
  recentEvents,
  setIngestOffset,
  updateSessionStats,
  upsertSession,
  upsertState,
} from "./db";
import { broadcastEvent, broadcastEventWithId } from "./sse";
import type { Source } from "./types";

const sources = new Map<string, Source>();
// Hot cache: latest snapshot per session, for contextPct/lastWork ephemera and
// per-session lookups (agentLogPath/recentThinking). Nothing the UI renders as
// history lives only here — SQL is the source of truth (Decision 5).
const snapshots = new Map<string, HiveStateSnapshot>();
let started = false;

export function sourcePaths(): string[] {
  return Array.from(sources.keys());
}

// Cursor-ordered event reads, SQL-backed and paginated (B5). No in-memory
// events array remains; callers pass a cursor to page forward.
export { queryEvents, recentEvents, queryDelegations, queryToolCalls, maxEventCursor } from "./db";

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
  // Resume from the persisted byte offset (B4) so boot re-reads only new bytes
  // instead of replaying the whole JSONL. INSERT OR IGNORE heals any overlap.
  sources.set(abs, { logPath: abs, offset: getIngestOffset(abs), meta, statePath, stateMtimeMs: 0 });
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
  // Truncation/rewrite (offset past EOF) resets to 0; INSERT OR IGNORE heals the
  // re-read idempotently.
  if (stat.size < source.offset) source.offset = 0;
  if (stat.size === source.offset) return;
  const fd = fs.openSync(source.logPath, "r");
  let endOffset = source.offset;
  try {
    const len = stat.size - source.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, source.offset);
    endOffset = stat.size;
    const parsed: HiveTelemetryEvent[] = [];
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try { parsed.push(enrichEvent(JSON.parse(line), source)); } catch { /* ignore partial/corrupt lines */ }
    }
    // One transaction per batch: all event writes + projections + the offset
    // advance commit or roll back together (B4). This makes boot O(new bytes)
    // and cuts per-event fsync on bursts. New events are collected for SSE and
    // broadcast after the transaction commits.
    const fresh: Array<{ event: HiveTelemetryEvent; cursor: number }> = [];
    const sessionId = source.meta?.session_id;
    db.transaction(() => {
      for (const event of parsed) {
        const res = ingestEvent(event);
        if (res) fresh.push(res);
      }
      setIngestOffset(source.logPath, endOffset, sessionId, new Date().toISOString());
    })();
    source.offset = endOffset;
    for (const { event, cursor } of fresh) broadcastEventWithId("hive", event, cursor);
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
  // Authoritative token/cost totals: sum across ALL agents (never Math.max —
  // that was the bug at runtime.ts:293). The main session and in-flight agents
  // are included via the snapshot's agents list (A5).
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  const sum = (pick: (a: HiveStateSnapshot["agents"] extends (infer T)[] ? T : never) => number) =>
    agents.reduce((total, agent) => total + (pick(agent as any) || 0), 0);
  db.transaction(() => {
    upsertState.run({
      $session_id: snapshot.session_id,
      $updated_at: snapshot.updated_at,
      $cwd: snapshot.cwd || null,
      $session_dir: snapshot.session_dir || null,
      $telemetry_log: snapshot.telemetry_log || null,
      $state_json: JSON.stringify(snapshot),
    });
    ensureSession.run({
      $session_id: snapshot.session_id,
      $cwd: snapshot.cwd || null,
      $session_dir: snapshot.session_dir || null,
      $telemetry_log: snapshot.telemetry_log || null,
      $ts: snapshot.updated_at,
    });
    updateSessionStats.run({
      $session_id: snapshot.session_id,
      $input_tokens: sum((a) => Number(a.inputTokens)),
      $output_tokens: sum((a) => Number(a.outputTokens)),
      $cache_read_tokens: sum((a) => Number(a.cacheReadTokens)),
      $cache_write_tokens: sum((a) => Number(a.cacheWriteTokens)),
      $cost_usd: sum((a) => Number(a.costUsd)),
      $topology_hash: (snapshot as any).topology_hash || null,
      $updated_at: snapshot.updated_at,
      $cwd: snapshot.cwd || null,
      $session_dir: snapshot.session_dir || null,
      $telemetry_log: snapshot.telemetry_log || null,
    });
  })();
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
      cwd: event.cwd,
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
      cwd: event.cwd,
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
      cwd: event.cwd,
      createdAt: event.ts,
    });
  }
}

// Ingest one event into SQL. Called INSIDE a batch transaction (readSource).
// Returns the event + its global cursor (events.rowid) when it is genuinely new
// (so the caller can broadcast it post-commit), or null when it is a duplicate
// or a filtered type. No in-memory events array remains (Decision 5).
function ingestEvent(event: HiveTelemetryEvent): { event: HiveTelemetryEvent; cursor: number } | null {
  if (!event || !event.event_id) return null;
  // Progress is volatile node state, not durable history. Older logs may contain
  // delegation_progress rows; ignore them so event counts/lists stay meaningful.
  // Filtered uniformly here so the boot-resurface variant dies too (B4).
  if (event.type === "delegation_progress") return null;
  const result = insertEvent.run(dbEventRow(event));
  if (result.changes === 0) return null; // duplicate (INSERT OR IGNORE)
  upsertSession.run(dbSessionRowFromEvent(event));
  materializePlanEvent(event);
  materializeTypedEvent(event);
  return { event, cursor: Number(result.lastInsertRowid) };
}

// Materialize hot entities (delegations / tool_calls / messages) from their
// source events (B3). Idempotent via event_id PK / tool_call_id uniqueness.
function materializeTypedEvent(event: HiveTelemetryEvent) {
  const p = (event.payload || {}) as any;
  const sessionId = event.session_id || "unknown";
  switch (event.type) {
    case "delegation_start":
      materializeDelegationStart({
        eventId: event.event_id, sessionId, cwd: event.cwd, agent: p.to, parent: p.from, startedAt: event.ts, model: p.model,
      });
      break;
    case "delegation_end": {
      const rt = p.runtime || {};
      materializeDelegationEnd({
        eventId: event.event_id, sessionId, cwd: event.cwd, agent: p.from, parent: p.to, endedAt: event.ts,
        durationMs: Number(p.elapsedMs) || undefined,
        inputTokens: Number(rt.inputTokens ?? p.inputTokens ?? 0),
        outputTokens: Number(rt.outputTokens ?? p.outputTokens ?? 0),
        cacheReadTokens: Number(rt.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(rt.cacheWriteTokens ?? 0),
        costUsd: Number(rt.costUsd ?? p.costUsd ?? 0),
        status: p.type, stopReason: p.stopReason,
        model: Array.isArray(p.models) && p.models.length ? p.models[p.models.length - 1] : p.model,
      });
      break;
    }
    case "worker_tool_start":
    case "orchestrator_tool_start":
      materializeToolStart({
        eventId: event.event_id, sessionId, cwd: event.cwd, agent: p.agent, toolName: p.toolName, toolCallId: p.toolCallId, argsPreview: p.args, startedAt: event.ts,
      });
      break;
    case "worker_tool_end":
    case "orchestrator_tool_end":
      materializeToolEnd({
        sessionId, toolCallId: p.toolCallId, resultPreview: p.resultPreview, isError: p.isError === true, endedAt: event.ts, durationMs: Number(p.durationMs) || undefined,
      });
      break;
    case "user_message":
    case "assistant_message":
      materializeMessage({
        eventId: event.event_id, sessionId, cwd: event.cwd, role: event.type === "user_message" ? "user" : "assistant",
        agent: event.actor, text: p.text, truncated: typeof p.text === "string" && p.text.length >= 8000, ts: event.ts,
      });
      break;
  }
}

function resumeIngestSources() {
  // Rehydrate the hot snapshot cache from SQL; events stay in SQL (paginated).
  for (const snapshot of loadPersistedStates()) snapshots.set(snapshot.session_id, enrichSnapshotTopologies(snapshot));
}

export function sessionSummaries(): TelemetrySessionSummary[] {
  // SQL-backed (B2). Live running-agent counts come from the hot snapshot cache.
  const rows = querySessionSummaries();
  return rows.map((row) => {
    const snap = snapshots.get(row.session_id);
    const agents = snap && Array.isArray(snap.agents) ? snap.agents : [];
    const running = agents.filter((agent) => agent.status === "running").length;
    return {
      session_id: row.session_id,
      cwd: row.cwd || undefined,
      session_dir: row.session_dir || undefined,
      telemetry_log: row.telemetry_log || undefined,
      first_ts: row.first_ts || undefined,
      last_ts: row.last_ts || undefined,
      event_count: Number(row.event_count || 0),
      running,
      tokens: Number(row.input_tokens || 0) + Number(row.output_tokens || 0),
      cacheReadTokens: Number(row.cache_read_tokens || 0),
      cacheWriteTokens: Number(row.cache_write_tokens || 0),
      cost: Number(row.cost_usd || 0),
      topologyHash: row.topology_hash || undefined,
    };
  });
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
  resumeIngestSources();
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
