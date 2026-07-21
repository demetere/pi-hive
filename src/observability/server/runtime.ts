import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { agentRuns, parseAgentLog } from "../agent-log";
import { projectName } from "../../shared/project";
import { tryResolveProjectIdentity } from "../../shared/project-identity";
import { loadConfig } from "../../core/config";
import type { AgentConfig, HiveTeam } from "../../core/types";
import { withCrossProcessFileLock } from "../../core/file-lock";
import { readJsonlPage } from "../../core/fs";
import type { HiveStateSnapshot, HiveTelemetryEvent, TelemetryRegistryRow, TelemetrySessionSummary, TopologyNode } from "../../shared/telemetry";
import { BOOT_SESSION_ID, CAPTURE_THINKING, CONVERSATION_LOG, DB_PATH, PROJECT_CWD, REGISTRY_PATH, RETENTION_DAYS, SINGLE_LOG_PATH, WORKFLOW_DB_PATH } from "./config";
import { createConfiguredWorkflowProjectionSynchronizer, workflowProjectionRootCandidates, type ConfiguredWorkflowProjectionSynchronizer } from "./workflow-runtime";
import { encodeWorkflowHistoryCursor } from "../projection";
import { broadcastWorkflowEvent } from "./sse";
import {
  db,
  dbEventRow,
  dbSessionRowFromEvent,
  deleteSessionRows,
  pruneOlderThan,
  storageBreakdown,
  knownCwds,
  type StorageBreakdown,
  ensureSession,
  getIngestSource,
  insertEvent,
  insertPlanVerdict,
  loadPersistedStates,
  materializeDelegationEnd,
  materializeDelegationStart,
  materializeToolEnd,
  materializeToolStart,
  projectUsageEvent,
  querySessionSummaries,
  setIngestIdentity,
  setIngestOffset,
  updateSessionStats,
  upsertSession,
  upsertState,
  upsertTopologyVersion,
  stampSessionTopology,
  fillNodeThinkingLevels,
  upsertModel,
  listModels,
  topologyVersion,
  topologyNodes,
  statesWithEmbeddedTopologies,
  rewriteStateJson,
  type TopologyNodeRow,
} from "./db";
import { canonicalTopologyJson, explodeTopology, topologyHash } from "./topology-hash";
import { broadcastEvent, broadcastEventWithId } from "./sse";
import type { Source } from "./types";
import { scanJsonlFile } from "./jsonl-reader";

const sources = new Map<string, Source>();
// Hot cache: latest snapshot per session, for contextPct/lastWork ephemera and
// per-session lookups (agentLogPath/recentThinking). Nothing the UI renders as
// history lives only here — SQL is the source of truth (Decision 5).
const snapshots = new Map<string, HiveStateSnapshot>();
let started = false;

function fileCheckpoint(file: string, offset: number): string | undefined {
  if (offset <= 0) return undefined;
  const length = Math.min(64, offset);
  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(file, "r");
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, length, offset - length);
    if (bytesRead !== length) return undefined;
    return `${length}:${createHash("sha256").update(buffer).digest("hex")}`;
  } finally {
    fs.closeSync(fd);
  }
}

export function sourcePaths(): string[] {
  return Array.from(sources.keys());
}

export function ingestionHealth() {
  const rows = Array.from(sources.values()).map((source) => ({
    path: source.logPath,
    offset: source.offset,
    corrupt_lines: source.corruptLines,
    pending_tail_bytes: source.pendingTailBytes,
    source_lag_bytes: source.sourceLagBytes,
    last_successful_ingest: source.lastSuccessfulIngest,
    last_error: source.lastError,
  }));
  return {
    corrupt_lines: rows.reduce((sum, row) => sum + row.corrupt_lines, 0),
    pending_tail_bytes: rows.reduce((sum, row) => sum + row.pending_tail_bytes, 0),
    source_lag_bytes: rows.reduce((sum, row) => sum + row.source_lag_bytes, 0),
    last_successful_ingest: rows.map((row) => row.last_successful_ingest).filter(Boolean).sort().at(-1),
    sources: rows,
  };
}

// Cursor-ordered event reads, SQL-backed and paginated (B5). No in-memory
// events array remains; callers pass a cursor to page forward.
export { queryEvents, recentEvents, queryDelegations, queryToolCalls, maxEventCursor, listTopologies, listModels } from "./db";

export function allSnapshots(options: { offset?: number; limit?: number } = {}): HiveStateSnapshot[] {
  const values = Array.from(snapshots.values()).sort((a, b) =>
    String(b.updated_at || "").localeCompare(String(a.updated_at || "")) || String(a.session_id).localeCompare(String(b.session_id)));
  const paged = options.offset != null || options.limit != null;
  if (!paged) return values.map(enrichSnapshotTopologies);
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(options.limit) || 250)));
  return values.slice(offset, offset + limit).map(enrichSnapshotTopologies);
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
  // Resume from the last COMPLETE newline. The persisted device/inode pair lets
  // readSource distinguish append from rotation, including after daemon restart.
  const cursor = getIngestSource(abs);
  sources.set(abs, {
    logPath: abs,
    offset: cursor.offset,
    meta,
    statePath,
    stateMtimeMs: 0,
    device: cursor.device,
    inode: cursor.inode,
    checkpoint: cursor.checkpoint,
    corruptLines: 0,
    pendingTailBytes: 0,
    sourceLagBytes: 0,
    lastSuccessfulIngest: cursor.updatedAt,
  });
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(abs), 0o700);
    fs.closeSync(fs.openSync(abs, "a", 0o600));
    fs.chmodSync(abs, 0o600);
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
  let stat: fs.Stats;
  try { stat = fs.statSync(source.logPath); }
  catch (error: any) { source.lastError = String(error?.message || error); return; }

  const missingIdentity = source.device == null || source.inode == null;
  const rotated = !missingIdentity && (source.device !== stat.dev || source.inode !== stat.ino);
  const truncated = stat.size < source.offset;
  let rewritten = false;
  if (!rotated && source.checkpoint && source.offset > 0 && stat.size >= source.offset) {
    try { rewritten = fileCheckpoint(source.logPath, source.offset) !== source.checkpoint; }
    catch { rewritten = true; }
  }
  if (rotated || rewritten || truncated) {
    source.offset = 0;
    source.checkpoint = undefined;
  }
  source.device = stat.dev;
  source.inode = stat.ino;
  source.sourceLagBytes = Math.max(0, stat.size - source.offset);
  source.pendingTailBytes = source.sourceLagBytes;

  // Persist identity even when there are no unread bytes. This makes a future
  // same-path rotation detectable after a daemon restart without pretending an
  // event offset advanced outside its insertion transaction.
  if (stat.size === source.offset) {
    const needsIdentityPersist = missingIdentity || rotated || rewritten || truncated || (source.offset > 0 && !source.checkpoint);
    if (!needsIdentityPersist) {
      source.lastError = undefined;
      source.pendingTailBytes = 0;
      source.sourceLagBytes = 0;
      return;
    }
    try {
      const updatedAt = source.lastSuccessfulIngest || new Date().toISOString();
      source.checkpoint = fileCheckpoint(source.logPath, source.offset);
      db.transaction(() => setIngestIdentity(source.logPath, source.offset, source.meta?.session_id, updatedAt, { device: stat.dev, inode: stat.ino, checkpoint: source.checkpoint }))();
      source.lastError = undefined;
      source.pendingTailBytes = 0;
      source.sourceLagBytes = 0;
    } catch (error: any) {
      source.lastError = String(error?.message || error);
    }
    return;
  }

  try {
    const result = scanJsonlFile(source.logPath, source.offset, (batch) => {
      const parsed: HiveTelemetryEvent[] = [];
      let corrupt = batch.oversizedLines;
      for (const line of batch.lines) {
        if (!line.trim()) continue;
        try { parsed.push(enrichEvent(JSON.parse(line), source)); }
        catch { corrupt++; }
      }
      // Every batch's event writes, projections, and COMPLETE-newline offset are
      // atomic. A throw leaves that batch replayable from its previous offset.
      const fresh: Array<{ event: HiveTelemetryEvent; cursor: number }> = [];
      const ingestedAt = new Date().toISOString();
      const checkpoint = fileCheckpoint(source.logPath, batch.endOffset);
      db.transaction(() => {
        for (const event of parsed) {
          const inserted = ingestEvent(event);
          if (inserted) fresh.push(inserted);
        }
        setIngestOffset(source.logPath, batch.endOffset, source.meta?.session_id, ingestedAt, { device: stat.dev, inode: stat.ino, checkpoint });
      })();
      source.offset = batch.endOffset;
      source.checkpoint = checkpoint;
      source.corruptLines += corrupt;
      source.lastSuccessfulIngest = ingestedAt;
      source.lastError = undefined;
      for (const { event, cursor } of fresh) broadcastEventWithId("hive", event, cursor);
    });
    source.pendingTailBytes = result.pendingTailBytes;
    source.sourceLagBytes = Math.max(0, result.fileSize - source.offset);
  } catch (error: any) {
    source.lastError = String(error?.message || error);
    source.sourceLagBytes = Math.max(0, stat.size - source.offset);
    source.pendingTailBytes = source.sourceLagBytes;
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
    snapshot.project_id ||= source.meta.project_id;
    snapshot.project_root ||= source.meta.project_root;
    snapshot.project_label ||= source.meta.project_label;
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
    // C2: mirror the extension-side summary (engine/observability.ts) so the
    // config-parse fallback path (configuredTopologies, used when a snapshot
    // lacks topologies) fills domain/commit/responsibilities too — otherwise
    // those columns could never populate on that path.
    domain: (agent.domain || []).map((scope) => scope.path),
    commit: Boolean(agent.commit && agent.commit.trim()),
    responsibilities: (agent.responsibilities || []).join("\n") || undefined,
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

// Derive topology_nodes rows from the enriched topologies (Phase C). The
// preorder walk (explodeTopology) fixes node_id/parent_id; identity/config
// fields come straight off the node.
function topologyNodeRows(hash: string, topologies: HiveStateSnapshot["topologies"]): TopologyNodeRow[] {
  return explodeTopology(topologies).map(({ team, nodeId, parentId, node }) => ({
    topologyHash: hash, team, nodeId, parentId, name: node.name,
    agentType: node.agentType, model: node.model, thinking: node.thinking,
    thinkingLevels: node.thinkingLevels, color: node.color, group: node.group, tools: node.tools,
    domain: node.domain, stages: node.stages, commitAllowed: node.commit === true,
    routingTags: node.routingTags, consultWhen: node.consultWhen, responsibilities: node.responsibilities,
  }));
}

// Content-address the enriched topologies and version them (C3). Idempotent by
// hash; on first sight of a hash the tree is exploded into topology_nodes.
// Returns the hash so the caller can stamp the session and slim the snapshot.
function versionTopology(snapshot: HiveStateSnapshot): string | undefined {
  if (!snapshot.topologies || !snapshot.cwd) return undefined;
  const hash = topologyHash(snapshot.topologies);
  upsertTopologyVersion({
    hash, cwd: snapshot.cwd, topologyJson: canonicalTopologyJson(snapshot.topologies),
    ts: snapshot.updated_at, nodes: topologyNodeRows(hash, snapshot.topologies),
  });
  // Fill the thinking_levels sidecar from any runtime nodes that carry SDK
  // levels (A10) — an UPDATE that doesn't touch the hash.
  for (const agent of snapshot.agents || []) {
    if (agent.name && Array.isArray(agent.thinkingLevels) && agent.thinkingLevels.length) {
      fillNodeThinkingLevels(hash, agent.name, agent.thinkingLevels);
    }
  }
  // C3: backfill any node still lacking thinking_levels from model_versions,
  // soft-joined on the node's `provider/model_id` string. The per-worker fill
  // above is authoritative but empty in sessions that never delegate; the
  // model_catalog (Workstream A) now populates model_versions on mode entry, so
  // this fallback fills the node column from the same soft join the dial uses.
  const nodesNeedingLevels = topologyNodes(hash).filter(
    (n) => n.model && (!n.thinkingLevels || !n.thinkingLevels.length),
  );
  if (nodesNeedingLevels.length) {
    const levelsByModel = new Map<string, string[]>();
    for (const m of listModels()) {
      if (Array.isArray(m.thinkingLevels) && m.thinkingLevels.length) {
        levelsByModel.set(`${m.provider}/${m.modelId}`, m.thinkingLevels);
      }
    }
    for (const node of nodesNeedingLevels) {
      const levels = levelsByModel.get(node.model as string);
      if (levels) fillNodeThinkingLevels(hash, node.name, levels);
    }
  }
  return hash;
}

function addSnapshot(snapshot: HiveStateSnapshot) {
  if (!snapshot || !snapshot.session_id) return;
  snapshot.updated_at ||= new Date().toISOString();
  const identity = snapshot.project_id ? undefined : tryResolveProjectIdentity(snapshot.cwd);
  snapshot.project_id ||= identity?.projectId;
  snapshot.project_root ||= identity?.canonicalRoot;
  snapshot.project_label ||= identity?.displayLabel;
  snapshot = enrichSnapshotTopologies(snapshot);
  snapshots.set(snapshot.session_id, snapshot);
  const topologyHashValue = versionTopology(snapshot);
  if (topologyHashValue) (snapshot as any).topology_hash = topologyHashValue;
  // Runtime counters stay in the snapshot for live agent detail only. Historical
  // session totals are projected from completed worker/message usage events.
  // Slim the persisted state: store runtime counters + topology_hash instead of
  // the embedded topologies (C3). Read-time rehydration joins topology_versions,
  // so rendering always uses the version the session actually ran under (this
  // fixes the drift bug) and current config changes mint a new version rather
  // than mutating history. The hot-cache `snapshots` map keeps the full form.
  const slim: HiveStateSnapshot = { ...snapshot };
  if (topologyHashValue) {
    // Phase 2.4: persist which team was ACTIVE (the session's mode at snapshot
    // time) before dropping the embedded topologies. A topology_hash is shared
    // across sessions and both modes, so rehydration can't recover the active
    // team from the hash alone — it must read this stored flag rather than the
    // old "hive if the hive team is non-empty" guess (which was wrong in plan
    // mode whenever the hive team was also configured).
    const activeTeam = snapshot.topologies?.active;
    delete slim.topologies; delete slim.topology; (slim as any).topology_hash = topologyHashValue;
    if (activeTeam) (slim as any).active_team = activeTeam;
  }
  db.transaction(() => {
    upsertState.run({
      $session_id: snapshot.session_id,
      $updated_at: snapshot.updated_at,
      $project_id: snapshot.project_id || null,
      $canonical_root: snapshot.project_root || null,
      $cwd: snapshot.cwd || null,
      $session_dir: snapshot.session_dir || null,
      $telemetry_log: snapshot.telemetry_log || null,
      $state_json: JSON.stringify(slim),
    });
    ensureSession.run({
      $session_id: snapshot.session_id,
      $project_id: snapshot.project_id || null,
      $canonical_root: snapshot.project_root || null,
      $cwd: snapshot.cwd || null,
      $session_dir: snapshot.session_dir || null,
      $telemetry_log: snapshot.telemetry_log || null,
      $ts: snapshot.updated_at,
    });
    updateSessionStats.run({
      $session_id: snapshot.session_id,
      $topology_hash: topologyHashValue || null,
      $updated_at: snapshot.updated_at,
      $project_id: snapshot.project_id || null,
      $canonical_root: snapshot.project_root || null,
      $cwd: snapshot.cwd || null,
      $session_dir: snapshot.session_dir || null,
      $telemetry_log: snapshot.telemetry_log || null,
    });
    if (topologyHashValue) stampSessionTopology(snapshot.session_id, topologyHashValue);
  })();
  broadcastEvent("hive_state", snapshot);
}

function enrichEvent(event: HiveTelemetryEvent, source: Source): HiveTelemetryEvent {
  event.cwd ||= source.meta.cwd;
  const identity = event.project_id ? undefined : tryResolveProjectIdentity(event.cwd);
  event.project_id ||= source.meta.project_id || identity?.projectId;
  event.project_root ||= source.meta.project_root || identity?.canonicalRoot;
  event.project_label ||= source.meta.project_label || identity?.displayLabel;
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
  // Only reviewer verdicts are materialized from telemetry events now. Plan
  // approvals and comments used to come from the retired chat approval flow and
  // the home-grown annotator; both are gone — approval/annotation now happens in
  // the self-hosted review surface, which writes plan_verdicts + the
  // content-bound global approval authority directly (see review-wiring.ts). The
  // plan_approvals / plan_comments tables are left in place (no DROP migration);
  // they simply stop receiving new rows.
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
  projectUsageEvent({
    eventId: event.event_id,
    sessionId: event.session_id || "unknown",
    ts: event.ts,
    type: event.type,
    payload: event.payload,
  });
  return { event, cursor: Number(result.lastInsertRowid) };
}

function modelKeyParts(model: unknown): { provider: string; modelId: string } | undefined {
  if (model && typeof model === "object") {
    const m = model as any;
    if (typeof m.provider === "string" && typeof m.id === "string" && m.provider && m.id) {
      return { provider: m.provider, modelId: m.id };
    }
  }
  const raw = String(model || "").trim();
  if (!raw || raw === "inherit") return undefined;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return undefined;
  return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

function modelKeyString(model: unknown): string | undefined {
  const key = modelKeyParts(model);
  return key ? `${key.provider}/${key.modelId}` : undefined;
}

function recordAuthoritativeThinkingLevels(model: unknown, levels: unknown, ts: string) {
  if (!Array.isArray(levels) || !levels.length) return;
  const key = modelKeyParts(model);
  if (!key) return;
  const thinkingLevels = levels.map(String);
  // Keep the model_versions table as the single dashboard source of truth. The
  // SDK session probe is more authoritative than registry metadata for thinking
  // levels, but the registry row is richer (pricing/context/name), so carry any
  // existing fields forward instead of replacing it with a sparse row.
  const existing = listModels().find((m) => m.provider === key.provider && m.modelId === key.modelId);
  upsertModel({
    provider: key.provider,
    modelId: key.modelId,
    name: existing?.name,
    api: existing?.api,
    reasoning: existing?.reasoning ?? true,
    thinkingLevels,
    contextWindow: existing?.contextWindow,
    maxTokens: existing?.maxTokens,
    costRates: existing?.costRates ? {
      input: existing.costRates.input ?? undefined,
      output: existing.costRates.output ?? undefined,
      cacheRead: existing.costRates.cacheRead ?? undefined,
      cacheWrite: existing.costRates.cacheWrite ?? undefined,
    } : undefined,
  }, ts);
}

// Materialize hot entities (delegations, tool_calls, and the model catalog) from
// their source events (B3). Idempotent via event_id PK / tool_call_id uniqueness.
function materializeTypedEvent(event: HiveTelemetryEvent) {
  const p = (event.payload || {}) as any;
  const sessionId = event.session_id || "unknown";
  switch (event.type) {
    case "delegation_start":
      materializeDelegationStart({
        eventId: event.event_id, sessionId, cwd: event.cwd, agent: p.to, parent: p.from, startedAt: event.ts, model: modelKeyString(p.model),
      });
      recordAuthoritativeThinkingLevels(p.model, p.thinkingLevels, event.ts);
      break;
    case "delegation_end": {
      const rt = p.runtime || {};
      // Decision 1: a delegation_end carrying delegationsSchema=1 stamps PER-RUN
      // deltas from p.delta; the row records only what this run consumed. Legacy
      // events (no delta block) fall back to the cumulative runtime aggregates and
      // are stored as schema_version 0 so they are never summed with the deltas.
      const d = p.delta;
      const isDelta = Number(p.delegationsSchema) >= 1 && d && typeof d === "object";
      materializeDelegationEnd({
        eventId: event.event_id, sessionId, cwd: event.cwd, agent: p.from, parent: p.to, endedAt: event.ts,
        durationMs: Number(p.elapsedMs) || undefined,
        inputTokens: Number((isDelta ? d.inputTokens : rt.inputTokens ?? p.inputTokens) ?? 0),
        outputTokens: Number((isDelta ? d.outputTokens : rt.outputTokens ?? p.outputTokens) ?? 0),
        cacheReadTokens: Number((isDelta ? d.cacheReadTokens : rt.cacheReadTokens) ?? 0),
        cacheWriteTokens: Number((isDelta ? d.cacheWriteTokens : rt.cacheWriteTokens) ?? 0),
        reasoningTokens: Number((isDelta ? d.reasoningTokens : rt.reasoningTokens) ?? 0),
        costUsd: Number((isDelta ? d.costUsd : rt.costUsd ?? p.costUsd) ?? 0),
        schemaVersion: isDelta ? 1 : 0,
        status: p.type, stopReason: p.stopReason,
        model: modelKeyString(Array.isArray(p.models) && p.models.length ? p.models[p.models.length - 1] : p.model),
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
    // Decision (Phase 2.2): the `messages` typed table was dropped — nothing read
    // it. The raw user_message/assistant_message events remain in `events`, so
    // message history is still queryable/backfillable from there if ever needed.
    case "model_catalog":
      // Upsert the SDK-sourced model capabilities into the models table (A10/C3).
      for (const model of Array.isArray(p.models) ? p.models : []) {
        if (!model?.provider || !model?.modelId) continue;
        upsertModel({
          provider: String(model.provider), modelId: String(model.modelId), name: model.name, api: model.api,
          reasoning: !!model.reasoning, thinkingLevels: Array.isArray(model.thinkingLevels) ? model.thinkingLevels.map(String) : [],
          contextWindow: Number(model.contextWindow) || undefined, maxTokens: Number(model.maxTokens) || undefined, costRates: model.costRates,
        }, event.ts);
      }
      break;
  }
}

// Reassemble a versioned topology's nested tree from topology_nodes (C5). Each
// team is rebuilt from its flat preorder rows via parent_id adjacency.
export function topologyDetail(hash: string): any {
  const version = topologyVersion(hash);
  if (!version) return null;
  const rows = topologyNodes(hash);
  const buildTeam = (team: string) => {
    const teamRows = rows.filter((r) => r.team === team);
    const byId = new Map<number, any>();
    for (const r of teamRows) {
      byId.set(r.nodeId, {
        name: r.name, agentType: r.agentType, model: r.model, thinking: r.thinking,
        thinkingLevels: r.thinkingLevels, color: r.color, group: r.group, tools: r.tools,
        domain: r.domain, stages: r.stages, commit: r.commitAllowed, routingTags: r.routingTags,
        consultWhen: r.consultWhen, responsibilities: r.responsibilities, children: [] as any[],
      });
    }
    let root: any;
    for (const r of teamRows) {
      const node = byId.get(r.nodeId);
      if (r.parentId == null) root = root || node;
      else byId.get(r.parentId)?.children.push(node);
    }
    // If there was no single root (no orchestrator), return the top-level nodes.
    const roots = teamRows.filter((r) => r.parentId == null).map((r) => byId.get(r.nodeId));
    return roots.length === 1 ? { orchestrator: roots[0], agents: roots[0].children } : { agents: roots };
  };
  return {
    hash: version.hash,
    cwd: version.cwd,
    firstSeenAt: version.firstSeenAt,
    lastSeenAt: version.lastSeenAt,
    planning: buildTeam("planning"),
    hive: buildTeam("hive"),
    canonicalJson: version.topologyJson,
  };
}

function resumeIngestSources() {
  // Rehydrate the hot snapshot cache from SQL; events stay in SQL (paginated).
  // Slim rows (topology_hash, no embedded topologies) are re-hydrated by joining
  // topology_versions so the UI still renders the session's true topology (C3).
  for (const snapshot of loadPersistedStates()) {
    snapshots.set(snapshot.session_id, enrichSnapshotTopologies(rehydrateSnapshotTopology(snapshot)));
  }
  // One-time backfill of any pre-Phase-C states that still embed topologies (C4).
  backfillTopologies();
}

// Rehydrate a slim persisted snapshot: if it carries a topology_hash but no
// embedded topologies, reconstruct them from the versioned tree (C3).
function rehydrateSnapshotTopology(snapshot: HiveStateSnapshot): HiveStateSnapshot {
  const hash = (snapshot as any).topology_hash;
  if (!hash || snapshot.topologies) return snapshot;
  const detail = topologyDetail(hash);
  if (!detail) return snapshot;
  // Phase 2.4: read the persisted active team; only fall back to the structural
  // guess for legacy slim rows written before active_team was stored.
  const stored = (snapshot as any).active_team as "hive" | "planning" | undefined;
  const active: "hive" | "planning" = stored
    ?? (detail.hive?.orchestrator || detail.hive?.agents?.length ? "hive" : "planning");
  return { ...snapshot, topologies: { active, hive: detail.hive, planning: detail.planning } };
}

// One-time boot migration: version every pre-Phase-C states row that still
// embeds topologies, then rewrite it slim (C4). Idempotent — a row without
// embedded topologies is skipped; hash-idempotency prevents duplicate versions.
function backfillTopologies() {
  for (const row of statesWithEmbeddedTopologies()) {
    let snap: HiveStateSnapshot;
    try { snap = JSON.parse(row.stateJson) as HiveStateSnapshot; } catch { continue; }
    if (!snap.topologies || !snap.cwd) continue; // already slim or unversionable
    const hash = topologyHash(snap.topologies);
    upsertTopologyVersion({
      hash, cwd: snap.cwd, topologyJson: canonicalTopologyJson(snap.topologies),
      ts: row.updatedAt, nodes: topologyNodeRows(hash, snap.topologies),
    });
    stampSessionTopology(row.sessionId, hash);
    const slim: HiveStateSnapshot = { ...snap };
    delete slim.topologies; delete slim.topology; (slim as any).topology_hash = hash;
    rewriteStateJson(row.sessionId, JSON.stringify(slim));
    // Refresh the hot cache with the rehydrated full form.
    snapshots.set(row.sessionId, enrichSnapshotTopologies(rehydrateSnapshotTopology(slim)));
  }
}

export function sessionSummaries(options: { offset?: number; limit?: number } = {}): TelemetrySessionSummary[] {
  // SQL-backed (B2). Live running-agent counts come from the hot snapshot cache.
  const rows = querySessionSummaries(options);
  return rows.map((row) => {
    const snap = snapshots.get(row.session_id);
    const agents = snap && Array.isArray(snap.agents) ? snap.agents : [];
    const running = agents.filter((agent) => agent.status === "running").length;
    const identity = row.project_id ? undefined : tryResolveProjectIdentity(row.cwd || undefined);
    return {
      session_id: row.session_id,
      project_id: row.project_id || identity?.projectId,
      project_root: row.canonical_root || identity?.canonicalRoot,
      project_label: identity?.displayLabel || projectName(row.canonical_root || row.cwd || undefined),
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
      reasoningTokens: Number(row.reasoning_tokens || 0),
      cost: Number(row.cost_usd || 0),
      usageStatus: row.usage_status === "legacy-unverified" ? "legacy-unverified" : "verified",
      topologyHash: row.topology_hash || undefined,
    };
  });
}

// Rewrite the global registry file, dropping any rows for the given session ids.
function pruneRegistry(removed: Set<string>) {
  if (!fs.existsSync(REGISTRY_PATH)) return;
  withCrossProcessFileLock(REGISTRY_PATH, () => {
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
  });
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

// Age-based prune (J1). Trims events older than the cutoff across all sessions
// and removes any session whose entire history predates it. The DB prune already
// deletes rows + projections; here we additionally evict the hot snapshot cache,
// unwatch source files, prune the registry, and broadcast the removal so live
// dashboards drop the gone sessions — the same runtime cleanup deleteSessions
// does, applied to the whole-stale set.
export function pruneTelemetry(cutoffIso: string): { events: number; sessions: number } {
  const { events, sessionIds } = pruneOlderThan(cutoffIso);
  const idSet = new Set(sessionIds.filter(Boolean));
  if (idSet.size) {
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
  }
  return { events, sessions: idSet.size };
}

export function deleteProject(projectId: string): number {
  const ids = sessionSummaries().filter((session) => session.project_id === projectId).map((session) => session.session_id);
  return deleteSessions(ids);
}

// Storage usage + prune preview for Settings. Project scope is selected only by
// canonical project ID; cwd remains a detail used by the existing SQL byte
// aggregation after the authoritative ID lookup.
export interface TelemetryStorage extends StorageBreakdown {
  database: { logicalBytes: number; fileBytes: number };
  sourceLogs: { bytes: number; files: number };
}

function trackedSourcePaths(projectId?: string): string[] {
  const allowedSessions = projectId
    ? new Set(sessionSummaries().filter((session) => session.project_id === projectId).map((session) => session.session_id))
    : undefined;
  return Array.from(sources.values())
    .filter((source) => !allowedSessions || (source.meta?.session_id && allowedSessions.has(source.meta.session_id)))
    .map((source) => source.logPath);
}

function sourceArtifacts(basePath: string): string[] {
  const dir = path.dirname(basePath);
  const base = path.basename(basePath);
  try {
    return (fs.readdirSync(dir) as string[])
      .filter((name: string) => name === base || (name.startsWith(`${base}.`) && name !== `${base}.lock`))
      .map((name: string) => path.join(dir, name));
  } catch { return []; }
}

export function telemetryStorage(projectId?: string, olderThanDays?: number): TelemetryStorage {
  const cwds = projectId ? knownCwds(projectId) : undefined;
  const cutoff = Number.isFinite(olderThanDays) && (olderThanDays as number) >= 0
    ? new Date(Date.now() - (olderThanDays as number) * 86400_000).toISOString()
    : undefined;
  const logical = storageBreakdown(cwds, cutoff);
  const paths = trackedSourcePaths(projectId).flatMap(sourceArtifacts);
  const sourceBytes = paths.reduce((sum, file) => {
    try { return sum + fs.statSync(file).size; } catch { return sum; }
  }, 0);
  let dbFileBytes = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { dbFileBytes += fs.statSync(`${DB_PATH}${suffix}`).size; } catch { /* absent */ }
  }
  return { ...logical, database: { logicalBytes: logical.bytes, fileBytes: dbFileBytes }, sourceLogs: { bytes: sourceBytes, files: paths.length } };
}

export function sourceLogForSession(sessionId: string): string | undefined {
  const summary = sessionSummaries().find((session) => session.session_id === sessionId);
  if (!summary) return undefined;
  const source = Array.from(sources.values()).find((candidate) => candidate.meta?.session_id === sessionId);
  return source?.logPath;
}

export function deleteProjectSourceLogs(projectId: string): { files: number; bytes: number } {
  if (!projectId) return { files: 0, bytes: 0 };
  const paths = trackedSourcePaths(projectId);
  let files = 0;
  let bytes = 0;
  for (const abs of paths) {
    const source = sources.get(abs);
    if (source) {
      try { fs.unwatchFile(abs); fs.unwatchFile(source.statePath); } catch { /* noop */ }
      sources.delete(abs);
    }
    for (const file of sourceArtifacts(abs)) {
      try { bytes += fs.statSync(file).size; fs.unlinkSync(file); files++; } catch { /* already gone */ }
    }
  }
  return { files, bytes };
}

// Resolve an agent's own conversation-log file from the latest snapshot. The
// snapshot's agents[] carry the sessionFile each pi subprocess writes to.
export function agentLogPath(sessionId: string, agentName: string): { file?: string; status?: string; main?: boolean } {
  const snap = snapshots.get(sessionId);
  if (!snap) return {};
  const activeRoot = snap.topologies?.active ? snap.topologies[snap.topologies.active]?.orchestrator?.name : snap.topology?.orchestrator?.name;
  const isMain = agentName === activeRoot || (agentName === "Orchestrator" && !!activeRoot);
  const agent = Array.isArray(snap.agents) ? snap.agents.find((candidate) => candidate.name === agentName) : undefined;
  if (isMain) return { file: agent?.sessionFile && fs.existsSync(agent.sessionFile) ? agent.sessionFile : snap.conversation_log, status: agent?.status || "running", main: true };
  if (!agent || !agent.sessionFile) return { status: agent?.status };
  return { file: agent.sessionFile, status: agent.status };
}

function parseMainConversationLog(
  file: string,
  options: { after?: number; before?: number; maxBytes?: number } = {},
): { entries: any[]; startOffset: number; offset: number; size: number; hasMoreBefore: boolean; hasMoreAfter: boolean; truncated: boolean } {
  const page = readJsonlPage(file, options);
  const entries: any[] = [];
  for (const line of page.text.split("\n")) {
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
  const { text: _text, ...meta } = page;
  return { entries, ...meta };
}

// Thinking/reasoning entries live only in per-agent transcripts, not the event
// stream. Collect the recent ones across a session's agents so the Activity feed
// can interleave "thinking" as first-class activity. Bounded per agent + overall
// so a huge fleet can't flood the response.
export interface ThinkingEntry { agent: string; ts: string; text: string; tokens: number; }
const thinkingTailCache = new Map<string, { offset: number; size: number; entries: ThinkingEntry[] }>();

function thinkingFromEntries(agent: string, entries: any[]): ThinkingEntry[] {
  const out: ThinkingEntry[] = [];
  for (const e of entries) {
    if (e.kind !== "message" || !Array.isArray(e.parts)) continue;
    const u = (e as any).usage || {};
    const tokens = Number(u.reasoning || 0) || Number(u.output || 0) || 0;
    for (const p of e.parts) {
      if (p.type === "thinking" && p.text && p.text.trim()) {
        out.push({ agent, ts: e.ts || "", text: p.text.trim(), tokens });
      }
    }
  }
  return out;
}

export function recentThinking(sessionId: string, perAgent = 12, overall = 200): ThinkingEntry[] {
  if (!CAPTURE_THINKING) return [];
  const snap = snapshots.get(sessionId);
  if (!snap || !Array.isArray(snap.agents)) return [];
  const out: ThinkingEntry[] = [];
  for (const a of snap.agents) {
    const file = a?.sessionFile;
    if (!file || !fs.existsSync(file)) continue;
    const prior = thinkingTailCache.get(file);
    let parsed;
    try {
      parsed = prior && prior.offset <= fs.statSync(file).size
        ? parseAgentLog(file, { after: prior.offset, maxBytes: 256 * 1024 })
        : parseAgentLog(file, { before: Number.MAX_SAFE_INTEGER, maxBytes: 256 * 1024 });
    } catch { continue; }
    const appended = thinkingFromEntries(a.name, parsed.entries);
    const entries = [...(prior?.entries || []), ...appended].slice(-Math.max(perAgent, 32));
    thinkingTailCache.delete(file);
    thinkingTailCache.set(file, { offset: parsed.offset, size: parsed.size, entries });
    for (const entry of entries.slice(-perAgent)) out.push(entry);
  }
  // Bound files retained across deleted/rotated sessions as well as entries.
  while (thinkingTailCache.size > 512) thinkingTailCache.delete(thinkingTailCache.keys().next().value!);
  out.sort((x, y) => String(y.ts).localeCompare(String(x.ts)));
  return out.slice(0, overall);
}

export function readAgentLog(sessionId: string, agent: string, offset: number, runId: string, before?: number): any {
  const { file: currentFile, status, main } = agentLogPath(sessionId, agent);
  if (!currentFile) return { entries: [], offset: 0, size: 0, status: status || "unknown", exists: false, runs: [] };
  const pageOptions = before != null
    ? { before, maxBytes: 256 * 1024 }
    : offset > 0
      ? { after: offset, maxBytes: 256 * 1024 }
      : { before: Number.MAX_SAFE_INTEGER, maxBytes: 256 * 1024 };
  if (main) {
    const parsed = parseMainConversationLog(currentFile, pageOptions);
    return {
      ...parsed,
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
  const parsed = parseAgentLog(chosen.file, pageOptions);
  if (!CAPTURE_THINKING) {
    parsed.entries = parsed.entries.map((entry: any) => entry.kind === "message" && Array.isArray(entry.parts)
      ? { ...entry, parts: entry.parts.filter((part: any) => part.type !== "thinking") }
      : entry);
  }
  return {
    ...parsed,
    status,
    exists: true,
    running: status === "running" && chosen.id === "current",
    runs: runs.map((r) => ({ id: r.id, label: r.label })),
    run: chosen.id,
  };
}

let workflowProjectionRuntimeDiagnostics: readonly Readonly<{ projectRoot: string; sessionId: string; diagnostic: string }>[] = Object.freeze([]);
let workflowProjectionSynchronizer: ConfiguredWorkflowProjectionSynchronizer | undefined;
let telemetryPruneTimer: ReturnType<typeof setInterval> | undefined;
let telemetryPollTimer: ReturnType<typeof setInterval> | undefined;

export function readWorkflowProjectionRuntimeDiagnostics(): readonly Readonly<{ projectRoot: string; sessionId: string; diagnostic: string }>[] {
  return workflowProjectionRuntimeDiagnostics;
}

function syncWorkflowProjectionRuntime(): void {
  const projectRoots = workflowProjectionRootCandidates(PROJECT_CWD, [...sources.values()].flatMap((source) => source.meta.project_root ? [source.meta.project_root] : source.meta.cwd ? [source.meta.cwd] : []));
  try {
    workflowProjectionSynchronizer ??= createConfiguredWorkflowProjectionSynchronizer({
      databasePath: WORKFLOW_DB_PATH, legacyPaths: [DB_PATH, REGISTRY_PATH], retentionDays: RETENTION_DAYS,
      onEvent: (event) => broadcastWorkflowEvent(event, encodeWorkflowHistoryCursor(event)),
    });
    const result = workflowProjectionSynchronizer.sync(projectRoots);
    workflowProjectionRuntimeDiagnostics = Object.freeze([...(result.diagnostics ?? [])].slice(0, 256));
  } catch (error) {
    workflowProjectionRuntimeDiagnostics = Object.freeze([{ projectRoot: PROJECT_CWD.slice(0, 1_024), sessionId: "", diagnostic: String(error instanceof Error ? error.message : error).slice(0, 2_048) }]);
  }
}

export function startTelemetryRuntime() {
  if (started) return;
  started = true;
  resumeIngestSources();
  readRegistry();
  syncWorkflowProjectionRuntime();
  if (SINGLE_LOG_PATH) addSource(SINGLE_LOG_PATH, { cwd: PROJECT_CWD, conversation_log: CONVERSATION_LOG, session_id: BOOT_SESSION_ID });
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(REGISTRY_PATH), 0o700);
  fs.closeSync(fs.openSync(REGISTRY_PATH, "a", 0o600));
  fs.chmodSync(REGISTRY_PATH, 0o600);
  const automaticPrune = () => pruneTelemetry(new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString());
  automaticPrune();
  telemetryPruneTimer = setInterval(automaticPrune, 60 * 60 * 1000);
  telemetryPruneTimer.unref?.();
  fs.watchFile(REGISTRY_PATH, { interval: 1000 }, readRegistry);
  telemetryPollTimer = setInterval(() => {
    readRegistry();
    syncWorkflowProjectionRuntime();
    for (const source of sources.values()) {
      readSource(source.logPath);
      readState(source.logPath);
    }
  }, 2000);
  telemetryPollTimer.unref?.();
}

export function stopTelemetryRuntime(): void {
  if (!started && !workflowProjectionSynchronizer) return;
  started = false;
  if (telemetryPruneTimer) clearInterval(telemetryPruneTimer);
  if (telemetryPollTimer) clearInterval(telemetryPollTimer);
  telemetryPruneTimer = undefined;
  telemetryPollTimer = undefined;
  fs.unwatchFile(REGISTRY_PATH, readRegistry);
  for (const source of sources.values()) {
    fs.unwatchFile(source.logPath);
    fs.unwatchFile(source.statePath);
  }
  workflowProjectionSynchronizer?.close();
  workflowProjectionSynchronizer = undefined;
}
