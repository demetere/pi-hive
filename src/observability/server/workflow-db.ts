import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { withCrossProcessFileLock } from "../../core/file-lock";
import {
  WORKFLOW_PROJECTION_PAGE_LIMIT,
  WORKFLOW_PROJECTION_QUERY_BYTES,
  WORKFLOW_PROJECTION_VALUE_BYTES,
  decodeWorkflowHistoryCursor,
  encodeWorkflowCurrentCursor,
  encodeWorkflowHistoryCursor,
  workflowProjectionCurrentCursorOrderKey,
  workflowProjectionCurrentKey,
  workflowProjectionCurrentOrderKey,
  type ProjectionStreamStatus,
  type WorkflowHistoryPage,
  type WorkflowHistoryQuery,
  type WorkflowProjectionCurrent,
  type WorkflowProjectionCurrentRow,
  type WorkflowProjectionUsageTotals,
  type WorkflowCurrentPage,
  type WorkflowCurrentPageQuery,
} from "../projection";
import { restoreWorkflowTelemetryEvent, verifyWorkflowTelemetryEvent, workflowTelemetryStreamId, type WorkflowTelemetryEvent } from "../events";
import { canonicalJson } from "../../config/snapshot-canonical";

export const WORKFLOW_SQLITE_SCHEMA_VERSION = 1 as const;

const SCHEMA = `
CREATE TABLE workflow_projection_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE workflow_streams (
  stream_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_root TEXT,
  state TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  last_hash TEXT,
  diagnostic TEXT,
  state_hash TEXT NOT NULL
);
CREATE TABLE workflow_event_identities (
  event_id TEXT PRIMARY KEY,
  event_hash TEXT NOT NULL
);
CREATE TABLE workflow_events (
  event_id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_root TEXT,
  project_label TEXT,
  pi_session_id TEXT,
  session_id TEXT NOT NULL,
  workflow_id TEXT,
  snapshot_id TEXT,
  workflow_config_hash TEXT,
  workflow_config_version TEXT,
  run_id TEXT,
  agent_id TEXT,
  agent_name TEXT,
  node_id TEXT,
  parent_node_id TEXT,
  task_id TEXT,
  adapter_id TEXT,
  adapter_version TEXT,
  profile_id TEXT,
  profile_version TEXT,
  workspace_id TEXT,
  workspace_hash TEXT,
  lease_state TEXT,
  question_id TEXT,
  checkpoint_id TEXT,
  approval_id TEXT,
  knowledge_job_id TEXT,
  knowledge_update_id TEXT,
  model_id TEXT,
  thinking TEXT,
  tool_name TEXT,
  capability_id TEXT,
  attempt_id TEXT,
  operation_id TEXT,
  precision TEXT,
  elapsed_ms INTEGER,
  active_wall_time_ms INTEGER,
  budget_scope TEXT,
  budget_used REAL,
  budget_limit REAL,
  budget_remaining REAL,
  change_coverage TEXT,
  terminal_refs_json BLOB,
  sequence INTEGER NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  source_event_hash TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_json BLOB NOT NULL
);
CREATE UNIQUE INDEX workflow_events_stream_sequence ON workflow_events(stream_id, sequence);
CREATE INDEX workflow_events_history ON workflow_events(timestamp, stream_id, sequence, event_id);
CREATE INDEX workflow_events_dimensions ON workflow_events(project_id, workflow_id, run_id, node_id, task_id);
CREATE TABLE workflow_current (
  kind TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  current_order_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  workflow_id TEXT,
  snapshot_id TEXT,
  project_label TEXT,
  workflow_config_version TEXT,
  run_id TEXT,
  node_id TEXT,
  task_id TEXT,
  updated_at TEXT NOT NULL,
  current_json BLOB NOT NULL,
  current_hash TEXT NOT NULL,
  PRIMARY KEY(kind, entity_key)
);
CREATE INDEX workflow_current_dimensions ON workflow_current(project_id, workflow_id, run_id, kind);
CREATE UNIQUE INDEX workflow_current_order ON workflow_current(kind, current_order_key);
CREATE TABLE workflow_usage (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  workflow_id TEXT,
  run_id TEXT,
  node_id TEXT,
  precision TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_micro_usd INTEGER NOT NULL,
  timestamp TEXT NOT NULL
);
CREATE INDEX workflow_usage_dimensions ON workflow_usage(project_id, workflow_id, run_id, node_id, precision);
CREATE TABLE workflow_prune_watermarks (
  stream_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_root TEXT,
  through_sequence INTEGER NOT NULL,
  through_hash TEXT NOT NULL,
  cutoff TEXT NOT NULL,
  state_hash TEXT NOT NULL
);
`;

const PRUNE_SCHEMA = `CREATE TABLE IF NOT EXISTS workflow_prune_watermarks (
  stream_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_root TEXT,
  through_sequence INTEGER NOT NULL,
  through_hash TEXT NOT NULL,
  cutoff TEXT NOT NULL,
  state_hash TEXT NOT NULL
);`;

type CurrentKind = keyof WorkflowProjectionCurrent;
const CURRENT_KINDS: readonly CurrentKind[] = ["sessions", "runs", "nodes", "tasks", "workspaces", "questions", "approvals", "knowledge"];

function parseEvent(value: string): WorkflowTelemetryEvent {
  try { return restoreWorkflowTelemetryEvent(JSON.parse(value)); }
  catch { throw new Error("Workflow projection persisted event integrity failure"); }
}
function currentHash(kind: CurrentKind, entityKey: string, value: WorkflowProjectionCurrentRow): string {
  return createHash("sha256").update("pi-hive-workflow-current-v1\0").update(canonicalJson({ kind, entityKey, value })).digest("hex");
}
function parseCurrent(kind: CurrentKind, entityKey: string, value: string, expectedHash: string): WorkflowProjectionCurrentRow {
  try {
    const parsed = JSON.parse(value) as WorkflowProjectionCurrentRow;
    if (!parsed || typeof parsed !== "object" || currentHash(kind, entityKey, parsed) !== expectedHash) throw new Error();
    return parsed;
  } catch { throw new Error("Workflow projection persisted current integrity failure"); }
}
function derivedStatus(event: WorkflowTelemetryEvent): string | undefined {
  return event.terminal?.status ?? event.status ?? (event.eventType === "run.started" || event.eventType === "task.started" ? "running" : undefined);
}
function currentRow(event: WorkflowTelemetryEvent, existing?: WorkflowProjectionCurrentRow, includeStatus = true): WorkflowProjectionCurrentRow {
  const status = includeStatus ? derivedStatus(event) : undefined;
  return { ...(existing ?? {}), ...event.dimensions, eventId: event.eventId, eventType: event.eventType, timestamp: event.timestamp, sequence: event.sequence, ...(status ? { status } : {}), ...(event.operation ? { operation: event.operation } : {}) };
}
function authoritativeFor(kind: CurrentKind, event: WorkflowTelemetryEvent): boolean {
  if (kind === "sessions") return event.eventType.startsWith("session.") || event.eventType === "run.started";
  if (kind === "runs") return event.eventType.startsWith("run.") || event.eventType === "terminal.recorded";
  if (kind === "nodes") return event.eventType === "run.started" || event.eventType.startsWith("task.");
  if (kind === "tasks") return event.eventType.startsWith("task.");
  if (kind === "workspaces") return event.eventType === "artifact.recorded";
  if (kind === "questions") return event.eventType === "question.transition";
  if (kind === "approvals") return event.eventType === "approval.recorded";
  return event.eventType === "knowledge.transition";
}
function validateQuery(query: WorkflowHistoryQuery): void {
  const values = [query.cursor, query.projectId, query.sessionId, query.workflowId, query.runId, query.nodeId, query.taskId, query.eventType].filter((value): value is string => value !== undefined);
  if (values.some((value) => Buffer.byteLength(value) > WORKFLOW_PROJECTION_VALUE_BYTES) || values.reduce((sum, value) => sum + Buffer.byteLength(value), 0) > WORKFLOW_PROJECTION_QUERY_BYTES) throw new Error("Workflow projection query exceeds its byte limit");
}
function canonicalDatabasePath(input: string): string {
  const lexical = resolve(input);
  mkdirSync(dirname(lexical), { recursive: true, mode: 0o700 });
  const canonicalParent = realpathSync.native(dirname(lexical));
  if (canonicalParent !== resolve(dirname(lexical))) throw new Error("Workflow projection database path contains a symlink alias");
  if (existsSync(lexical) && lstatSync(lexical).isSymbolicLink()) throw new Error("Workflow projection database symlink is refused");
  chmodSync(canonicalParent, 0o700);
  return join(canonicalParent, basename(lexical));
}
function comparablePath(input: string): string {
  const lexical = resolve(input);
  if (existsSync(lexical)) return realpathSync.native(lexical);
  const parent = dirname(lexical);
  return existsSync(parent) ? join(realpathSync.native(parent), basename(lexical)) : lexical;
}
function privateSqliteFiles(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
}
function streamHash(value: Omit<ProjectionStreamStatus, "streamId"> & { streamId: string; projectId: string; sessionId: string; projectRoot?: string }): string {
  return createHash("sha256").update("pi-hive-workflow-stream-state-v1\0").update(canonicalJson(value)).digest("hex");
}
interface PruneWatermark {
  readonly streamId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly projectRoot?: string;
  readonly throughSequence: number;
  readonly throughHash: string;
  readonly cutoff: string;
}
function watermarkHash(value: PruneWatermark): string {
  return createHash("sha256").update("pi-hive-workflow-prune-watermark-v1\0").update(canonicalJson(value)).digest("hex");
}

export class WorkflowProjectionIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "WorkflowProjectionIntegrityError"; }
}

/** A database format this version does not own and must never repair or replace. */
export class WorkflowProjectionSchemaError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "WorkflowProjectionSchemaError"; }
}

export interface OpenWorkflowProjectionDatabaseOptions {
  readonly path: string;
  readonly legacyPaths?: readonly string[];
}

export class WorkflowProjectionDatabase {
  readonly database: Database;
  readonly path: string;

  constructor(options: OpenWorkflowProjectionDatabaseOptions) {
    this.path = canonicalDatabasePath(options.path);
    if ((options.legacyPaths ?? []).some((path) => comparablePath(path) === this.path
      || (existsSync(path) && existsSync(this.path) && statSync(path).dev === statSync(this.path).dev && statSync(path).ino === statSync(this.path).ino))) throw new Error("Workflow projection must use a separate database and cannot open a legacy telemetry file or alias");
    let opened: Database | undefined;
    withCrossProcessFileLock(`${this.path}.initialize`, () => {
      const existed = existsSync(this.path) && statSync(this.path).size > 0;
      const database = new Database(this.path);
      try {
        database.run("PRAGMA busy_timeout = 5000");
        const metadata = database.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_projection_metadata'`).get() as { name: string } | null;
        if (existed && !metadata) throw new WorkflowProjectionSchemaError("Existing database is not a workflow projection; legacy/unknown schemas are preserved and refused");
        if (!metadata) database.transaction(() => {
          database.exec(SCHEMA);
          database.query(`INSERT INTO workflow_projection_metadata (key, value) VALUES ('schema_version', ?)`).run(String(WORKFLOW_SQLITE_SCHEMA_VERSION));
        })();
        else {
          const version = database.query(`SELECT value FROM workflow_projection_metadata WHERE key = 'schema_version'`).get() as { value: string } | null;
          if (Number(version?.value ?? 0) !== WORKFLOW_SQLITE_SCHEMA_VERSION) throw new WorkflowProjectionSchemaError(`Unsupported workflow projection schema version ${version?.value ?? "missing"}`);
        }
        database.exec(PRUNE_SCHEMA);
        database.run("PRAGMA journal_mode = WAL");
        privateSqliteFiles(this.path);
        opened = database;
      } catch (error) { database.close(); throw error; }
    }, { timeoutMs: 10_000, staleMs: 30_000 });
    if (!opened) throw new Error("Workflow projection database initialization failed");
    this.database = opened;
    try {
      if (this.schemaVersion() !== WORKFLOW_SQLITE_SCHEMA_VERSION) throw new WorkflowProjectionSchemaError("Unsupported workflow projection schema version");
      this.assertPersistedIntegrity();
    } catch (error) {
      this.database.close();
      if (error instanceof WorkflowProjectionIntegrityError || error instanceof WorkflowProjectionSchemaError) throw error;
      throw new WorkflowProjectionIntegrityError(`Workflow projection persisted integrity failure: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  private assertPersistedIntegrity(): void {
    const watermarkRows = this.database.query(`SELECT * FROM workflow_prune_watermarks ORDER BY stream_id`).all() as any[];
    const watermarks = new Map<string, PruneWatermark>();
    for (const row of watermarkRows) {
      const value: PruneWatermark = { streamId: row.stream_id, projectId: row.project_id, sessionId: row.session_id,
        ...(row.project_root ? { projectRoot: row.project_root } : {}), throughSequence: Number(row.through_sequence), throughHash: row.through_hash, cutoff: row.cutoff };
      if (!/^wfs1-[0-9a-f]{64}$/u.test(value.streamId) || !Number.isSafeInteger(value.throughSequence) || value.throughSequence < 1
        || !/^[0-9a-f]{64}$/u.test(value.throughHash) || !Number.isFinite(Date.parse(value.cutoff)) || row.state_hash !== watermarkHash(value)) throw new Error("Workflow projection persisted prune-watermark integrity failure");
      watermarks.set(value.streamId, value);
    }
    const rows = this.database.query(`SELECT *, json(event_json) AS authenticated_event_json, json(terminal_refs_json) AS authenticated_terminal_refs_json FROM workflow_events ORDER BY stream_id, sequence`).all() as any[];
    const events: WorkflowTelemetryEvent[] = [];
    const eventById = new Map<string, WorkflowTelemetryEvent>();
    const expectedCurrent = new Map<string, { kind: CurrentKind; key: string; event: WorkflowTelemetryEvent }>();
    const dimensionColumns: ReadonlyArray<readonly [string, keyof WorkflowTelemetryEvent["dimensions"]]> = [
      ["project_id", "projectId"], ["project_root", "projectRoot"], ["project_label", "projectLabel"], ["pi_session_id", "piSessionId"], ["session_id", "sessionId"],
      ["workflow_id", "workflowId"], ["snapshot_id", "snapshotId"], ["workflow_config_hash", "workflowConfigHash"], ["workflow_config_version", "workflowConfigVersion"],
      ["run_id", "runId"], ["agent_id", "agentId"], ["agent_name", "agentName"], ["node_id", "nodeId"], ["parent_node_id", "parentNodeId"], ["task_id", "taskId"],
      ["adapter_id", "adapterId"], ["adapter_version", "adapterVersion"], ["profile_id", "profileId"], ["profile_version", "profileVersion"], ["workspace_id", "workspaceId"],
      ["workspace_hash", "workspaceHash"], ["lease_state", "leaseState"], ["question_id", "questionId"], ["checkpoint_id", "checkpointId"], ["approval_id", "approvalId"],
      ["knowledge_job_id", "knowledgeJobId"], ["knowledge_update_id", "knowledgeUpdateId"], ["model_id", "modelId"], ["thinking", "thinking"], ["tool_name", "toolName"],
      ["capability_id", "capabilityId"], ["attempt_id", "attemptId"], ["operation_id", "operationId"],
    ];
    const priorByStream = new Map<string, { sequence: number; hash: string | null }>();
    for (const persisted of rows) {
      const event = parseEvent(persisted.authenticated_event_json);
      const boundary = priorByStream.get(event.streamId) ?? { sequence: watermarks.get(event.streamId)?.throughSequence ?? 0, hash: watermarks.get(event.streamId)?.throughHash ?? null };
      if (event.sequence !== boundary.sequence + 1 || event.previousHash !== boundary.hash) throw new Error(`Workflow projection persisted retained-event chain integrity failure in stream ${event.streamId}`);
      priorByStream.set(event.streamId, { sequence: event.sequence, hash: event.sourceEventHash });
      const expected: ReadonlyArray<readonly [string, unknown]> = [
        ["event_id", event.eventId], ["stream_id", event.streamId], ["sequence", event.sequence], ["previous_hash", event.previousHash], ["event_hash", event.eventHash],
        ["payload_hash", event.payloadHash], ["source_event_hash", event.sourceEventHash], ["timestamp", event.timestamp], ["event_type", event.eventType],
        ["precision", event.usage?.precision ?? null], ["elapsed_ms", event.metrics?.elapsedMs ?? null], ["active_wall_time_ms", event.metrics?.activeWallTimeMs ?? null],
        ["budget_scope", event.metrics?.budgetScope ?? null], ["budget_used", event.metrics?.budgetUsed ?? null], ["budget_limit", event.metrics?.budgetLimit ?? null],
        ["budget_remaining", event.metrics?.budgetRemaining ?? null], ["change_coverage", event.terminal?.changeCoverage ?? null],
      ];
      if (expected.some(([column, value]) => persisted[column] !== value)
        || dimensionColumns.some(([column, key]) => persisted[column] !== (event.dimensions[key] ?? null))
        || canonicalJson(JSON.parse(persisted.authenticated_terminal_refs_json)) !== canonicalJson(event.terminal?.refs ?? [])) {
        throw new Error(`Workflow projection persisted event normalized integrity failure in stream ${event.streamId}`);
      }
      events.push(event); eventById.set(event.eventId, event);
      for (const kind of CURRENT_KINDS) {
        const key = workflowProjectionCurrentKey(kind, event);
        if (!key || !authoritativeFor(kind, event)) continue;
        const mapKey = `${kind}\0${key}`;
        expectedCurrent.set(mapKey, { kind, key, event });
      }
    }
    const identities = this.database.query(`SELECT event_id, event_hash FROM workflow_event_identities ORDER BY event_id`).all() as Array<{ event_id: string; event_hash: string }>;
    const identityById = new Map(identities.map((entry) => [entry.event_id, entry.event_hash]));
    const validIdentity = (entry: { event_id: string; event_hash: string }): boolean => typeof entry.event_id === "string" && !!entry.event_id
      && Buffer.byteLength(entry.event_id, "utf8") <= 256
      && ![...entry.event_id].some((character) => character === "/" || character === "\\" || character.codePointAt(0)! <= 0x1f)
      && /^[0-9a-f]{64}$/u.test(entry.event_hash);
    if (identities.some((entry) => !validIdentity(entry) || (eventById.has(entry.event_id) && eventById.get(entry.event_id)?.eventHash !== entry.event_hash))
      || events.some((event) => identityById.get(event.eventId) !== event.eventHash)) {
      throw new Error("Workflow projection persisted event identity integrity failure");
    }

    const currentRows = this.database.query(`SELECT *, json(current_json) AS authenticated_current_json FROM workflow_current ORDER BY kind, entity_key`).all() as any[];
    for (const persisted of currentRows) {
      if (!CURRENT_KINDS.includes(persisted.kind)) throw new Error("Workflow projection persisted current integrity failure");
      const mapKey = `${persisted.kind}\0${persisted.entity_key}`;
      const expected = expectedCurrent.get(mapKey);
      const parsed = parseCurrent(persisted.kind, persisted.entity_key, persisted.authenticated_current_json, persisted.current_hash);
      const streamId = workflowTelemetryStreamId(parsed.projectId, parsed.sessionId);
      if (!expected && !watermarks.has(streamId)) throw new Error("Workflow projection persisted current integrity failure");
      const projected = expected ? currentRow(expected.event, parsed, expected.kind !== "sessions" || expected.event.eventType.startsWith("session.")) : parsed;
      const d = expected?.event.dimensions;
      if (canonicalJson(parsed) !== canonicalJson(projected) || persisted.current_order_key !== workflowProjectionCurrentOrderKey(parsed, persisted.entity_key)
        || persisted.project_id !== parsed.projectId || persisted.session_id !== parsed.sessionId
        || (d && (persisted.workflow_id !== (d.workflowId ?? null) || persisted.snapshot_id !== (d.snapshotId ?? null) || persisted.project_label !== (d.projectLabel ?? null)
          || persisted.workflow_config_version !== (d.workflowConfigVersion ?? null) || persisted.run_id !== (d.runId ?? null) || persisted.node_id !== (d.nodeId ?? null)
          || persisted.task_id !== (d.taskId ?? null))) || persisted.updated_at !== (expected?.event.timestamp ?? parsed.timestamp)) throw new Error("Workflow projection persisted current normalized integrity failure");
      expectedCurrent.delete(mapKey);
    }
    if (expectedCurrent.size) throw new Error("Workflow projection persisted current coverage integrity failure");

    const usageRows = this.database.query(`SELECT * FROM workflow_usage ORDER BY event_id`).all() as any[];
    const usageEvents = events.filter((event) => event.usage);
    if (usageRows.length !== usageEvents.length) throw new Error("Workflow projection persisted usage integrity failure");
    for (const persisted of usageRows) {
      const event = eventById.get(persisted.event_id); const usage = event?.usage; const d = event?.dimensions;
      if (!event || !usage || !d || persisted.project_id !== d.projectId || persisted.session_id !== d.sessionId || persisted.workflow_id !== (d.workflowId ?? null)
        || persisted.run_id !== (d.runId ?? null) || persisted.node_id !== (d.nodeId ?? null) || persisted.precision !== usage.precision
        || persisted.input_tokens !== usage.inputTokens || persisted.output_tokens !== usage.outputTokens || persisted.cost_micro_usd !== usage.costMicroUsd
        || persisted.timestamp !== event.timestamp) throw new Error(`Workflow projection persisted usage integrity failure in stream ${event?.streamId ?? "unknown"}`);
    }

    const byStream = new Map<string, WorkflowTelemetryEvent[]>();
    for (const event of events) { const stream = byStream.get(event.streamId) ?? []; stream.push(event); byStream.set(event.streamId, stream); }
    const remainingWatermarks = new Map(watermarks);
    const streamRows = this.database.query(`SELECT * FROM workflow_streams ORDER BY stream_id`).all() as any[];
    for (const persisted of streamRows) {
      const streamEvents = byStream.get(persisted.stream_id) ?? [];
      const last = streamEvents.at(-1);
      const watermark = watermarks.get(persisted.stream_id);
      const boundary = last ? { projectId: last.dimensions.projectId, sessionId: last.dimensions.sessionId, projectRoot: last.dimensions.projectRoot, sequence: last.sequence, hash: last.sourceEventHash }
        : watermark ? { projectId: watermark.projectId, sessionId: watermark.sessionId, projectRoot: watermark.projectRoot, sequence: watermark.throughSequence, hash: watermark.throughHash } : undefined;
      const state = persisted.state === "blocked" ? "blocked" : persisted.state === "ready" ? "ready" : undefined;
      const value = { streamId: persisted.stream_id, projectId: persisted.project_id, sessionId: persisted.session_id, ...(persisted.project_root ? { projectRoot: persisted.project_root } : {}), state, lastSequence: Number(persisted.last_sequence), lastHash: persisted.last_hash ?? null, ...(persisted.diagnostic ? { diagnostic: persisted.diagnostic } : {}) } as any;
      const emptyBlocked = !boundary && state === "blocked" && Number(persisted.last_sequence) === 0 && persisted.last_hash === null;
      if (!state || (!boundary && !emptyBlocked) || Buffer.byteLength(persisted.diagnostic ?? "", "utf8") > 2_048 || persisted.state_hash !== streamHash(value)
        || persisted.stream_id !== workflowTelemetryStreamId(persisted.project_id, persisted.session_id)
        || (boundary && (persisted.project_id !== boundary.projectId || persisted.session_id !== boundary.sessionId || persisted.project_root !== (boundary.projectRoot ?? null)
          || Number(persisted.last_sequence) !== boundary.sequence || persisted.last_hash !== boundary.hash))) throw new Error(`Workflow projection persisted stream-state integrity failure in stream ${persisted.stream_id}`);
      byStream.delete(persisted.stream_id); remainingWatermarks.delete(persisted.stream_id);
    }
    if (byStream.size || remainingWatermarks.size) throw new Error("Workflow projection persisted stream-state coverage integrity failure");
  }

  close(): void { privateSqliteFiles(this.path); this.database.close(); privateSqliteFiles(this.path); }
  schemaVersion(): number {
    const row = this.database.query(`SELECT value FROM workflow_projection_metadata WHERE key = 'schema_version'`).get() as { value: string } | null;
    return Number(row?.value ?? 0);
  }
  schemaSql(): string {
    return (this.database.query(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name`).all() as Array<{ sql: string }>).map((row) => row.sql).join("\n");
  }

  streamStatus(streamId: string): ProjectionStreamStatus {
    const row = this.database.query(`SELECT * FROM workflow_streams WHERE stream_id = ?`).get(streamId) as any;
    return { streamId, state: row?.state === "blocked" ? "blocked" : "ready", lastSequence: Number(row?.last_sequence ?? 0), lastHash: row?.last_hash ?? null, ...(row?.diagnostic ? { diagnostic: row.diagnostic } : {}) };
  }

  persistedStreamEvents(streamIds: ReadonlySet<string>): readonly (readonly WorkflowTelemetryEvent[])[] {
    const output = new Map<string, WorkflowTelemetryEvent[]>();
    if (!streamIds.size) return [];
    for (const row of this.database.query(`SELECT stream_id, json(event_json) AS event_json FROM workflow_events ORDER BY stream_id, sequence`).all() as Array<{ stream_id: string; event_json: string }>) {
      if (!streamIds.has(row.stream_id)) continue;
      const stream = output.get(row.stream_id) ?? []; stream.push(parseEvent(row.event_json)); output.set(row.stream_id, stream);
    }
    return [...output.values()];
  }

  assertAuthoritativeEvents(streams: readonly (readonly WorkflowTelemetryEvent[])[], preservedStreamIds: ReadonlySet<string> = new Set()): void {
    const authoritative = new Map(streams.flatMap((stream) => stream[0] ? [[stream[0].streamId, stream] as const] : []));
    const watermarks = this.database.query(`SELECT stream_id, through_sequence, through_hash FROM workflow_prune_watermarks`).all() as Array<{ stream_id: string; through_sequence: number; through_hash: string }>;
    for (const watermark of watermarks) {
      if (preservedStreamIds.has(watermark.stream_id)) continue;
      const expected = authoritative.get(watermark.stream_id)?.[Number(watermark.through_sequence) - 1];
      if (!expected || expected.sourceEventHash !== watermark.through_hash) throw new Error("Workflow projection prune watermark differs from authoritative journal source");
    }
    const rows = this.database.query(`SELECT stream_id, sequence, event_hash, source_event_hash FROM workflow_events ORDER BY stream_id, sequence`).all() as Array<{ stream_id: string; sequence: number; event_hash: string; source_event_hash: string }>;
    for (const row of rows) {
      const expected = authoritative.get(row.stream_id)?.[Number(row.sequence) - 1];
      if (preservedStreamIds.has(row.stream_id)) continue;
      if (!expected || expected.eventHash !== row.event_hash || expected.sourceEventHash !== row.source_event_hash) throw new Error("Workflow projection event differs from authoritative journal source");
    }
  }

  ingest(event: WorkflowTelemetryEvent): "inserted" | "duplicate" {
    verifyWorkflowTelemetryEvent(event);
    const duplicate = this.database.query(`SELECT event_hash FROM workflow_event_identities WHERE event_id = ?`).get(event.eventId) as { event_hash: string } | null;
    if (duplicate) {
      if (duplicate.event_hash === event.eventHash) return "duplicate";
      this.block(event, "reused event ID with a different hash");
    }
    const stream = this.streamStatus(event.streamId);
    if (stream.state === "blocked") throw new Error(`Workflow projection stream is blocked: ${stream.diagnostic ?? "integrity failure"}`);
    if (event.sequence !== stream.lastSequence + 1) this.block(event, `sequence gap: expected ${stream.lastSequence + 1}, received ${event.sequence}`);
    if (event.previousHash !== stream.lastHash) this.block(event, "previous hash mismatch");

    this.database.transaction(() => {
      const d = event.dimensions;
      this.database.query(`INSERT INTO workflow_event_identities (event_id, event_hash) VALUES (?, ?)`).run(event.eventId, event.eventHash);
      this.database.query(`INSERT INTO workflow_events
        (event_id, stream_id, project_id, project_root, project_label, pi_session_id, session_id, workflow_id, snapshot_id, workflow_config_hash, workflow_config_version, run_id,
         agent_id, agent_name, node_id, parent_node_id, task_id, adapter_id, adapter_version, profile_id, profile_version,
         workspace_id, workspace_hash, lease_state, question_id, checkpoint_id, approval_id, knowledge_job_id, knowledge_update_id,
         model_id, thinking, tool_name, capability_id, attempt_id, operation_id, precision, elapsed_ms, active_wall_time_ms,
         budget_scope, budget_used, budget_limit, budget_remaining, change_coverage, terminal_refs_json,
         sequence, previous_hash, event_hash, payload_hash, source_event_hash, timestamp, event_type, event_json)
        VALUES ($event_id, $stream_id, $project_id, $project_root, $project_label, $pi_session_id, $session_id, $workflow_id, $snapshot_id, $workflow_config_hash, $workflow_config_version, $run_id,
         $agent_id, $agent_name, $node_id, $parent_node_id, $task_id, $adapter_id, $adapter_version, $profile_id, $profile_version,
         $workspace_id, $workspace_hash, $lease_state, $question_id, $checkpoint_id, $approval_id, $knowledge_job_id, $knowledge_update_id,
         $model_id, $thinking, $tool_name, $capability_id, $attempt_id, $operation_id, $precision, $elapsed_ms, $active_wall_time_ms,
         $budget_scope, $budget_used, $budget_limit, $budget_remaining, $change_coverage, jsonb($terminal_refs_json),
         $sequence, $previous_hash, $event_hash, $payload_hash, $source_event_hash, $timestamp, $event_type, jsonb($event_json))`).run({
        $event_id: event.eventId, $stream_id: event.streamId, $project_id: d.projectId, $project_root: d.projectRoot ?? null, $project_label: d.projectLabel ?? null,
        $pi_session_id: d.piSessionId ?? null, $session_id: d.sessionId, $workflow_id: d.workflowId ?? null, $snapshot_id: d.snapshotId ?? null,
        $workflow_config_hash: d.workflowConfigHash ?? null, $workflow_config_version: d.workflowConfigVersion ?? null, $run_id: d.runId ?? null, $agent_id: d.agentId ?? null, $agent_name: d.agentName ?? null,
        $node_id: d.nodeId ?? null, $parent_node_id: d.parentNodeId ?? null, $task_id: d.taskId ?? null, $adapter_id: d.adapterId ?? null,
        $adapter_version: d.adapterVersion ?? null, $profile_id: d.profileId ?? null, $profile_version: d.profileVersion ?? null,
        $workspace_id: d.workspaceId ?? null, $workspace_hash: d.workspaceHash ?? null, $lease_state: d.leaseState ?? null,
        $question_id: d.questionId ?? null, $checkpoint_id: d.checkpointId ?? null, $approval_id: d.approvalId ?? null,
        $knowledge_job_id: d.knowledgeJobId ?? null, $knowledge_update_id: d.knowledgeUpdateId ?? null, $model_id: d.modelId ?? null,
        $thinking: d.thinking ?? null, $tool_name: d.toolName ?? null, $capability_id: d.capabilityId ?? null,
        $attempt_id: d.attemptId ?? null, $operation_id: d.operationId ?? null, $precision: event.usage?.precision ?? null,
        $elapsed_ms: event.metrics?.elapsedMs ?? null, $active_wall_time_ms: event.metrics?.activeWallTimeMs ?? null,
        $budget_scope: event.metrics?.budgetScope ?? null, $budget_used: event.metrics?.budgetUsed ?? null,
        $budget_limit: event.metrics?.budgetLimit ?? null, $budget_remaining: event.metrics?.budgetRemaining ?? null,
        $change_coverage: event.terminal?.changeCoverage ?? null, $terminal_refs_json: JSON.stringify(event.terminal?.refs ?? []),
        $sequence: event.sequence, $previous_hash: event.previousHash, $event_hash: event.eventHash, $payload_hash: event.payloadHash, $source_event_hash: event.sourceEventHash,
        $timestamp: event.timestamp, $event_type: event.eventType, $event_json: JSON.stringify(event),
      });
      const streamValue = { streamId: event.streamId, projectId: d.projectId, sessionId: d.sessionId, ...(d.projectRoot ? { projectRoot: d.projectRoot } : {}), state: "ready" as const, lastSequence: event.sequence, lastHash: event.sourceEventHash };
      this.database.query(`INSERT INTO workflow_streams (stream_id, project_id, session_id, project_root, state, last_sequence, last_hash, diagnostic, state_hash)
        VALUES (?, ?, ?, ?, 'ready', ?, ?, NULL, ?) ON CONFLICT(stream_id) DO UPDATE SET project_root = excluded.project_root, state = 'ready', last_sequence = excluded.last_sequence, last_hash = excluded.last_hash, diagnostic = NULL, state_hash = excluded.state_hash`)
        .run(event.streamId, d.projectId, d.sessionId, d.projectRoot ?? null, event.sequence, event.sourceEventHash, streamHash(streamValue));
      for (const kind of CURRENT_KINDS) {
        const key = workflowProjectionCurrentKey(kind, event);
        if (!key || !authoritativeFor(kind, event)) continue;
        const prior = this.database.query(`SELECT current_hash, json(current_json) AS current_json FROM workflow_current WHERE kind = ? AND entity_key = ?`).get(kind, key) as { current_hash: string; current_json: string } | null;
        const existing = prior ? parseCurrent(kind, key, prior.current_json, prior.current_hash) : undefined;
        const projected = currentRow(event, existing, kind !== "sessions" || event.eventType.startsWith("session."));
        this.database.query(`INSERT INTO workflow_current (kind, entity_key, current_order_key, project_id, session_id, workflow_id, snapshot_id, project_label, workflow_config_version, run_id, node_id, task_id, updated_at, current_json, current_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, jsonb(?), ?)
          ON CONFLICT(kind, entity_key) DO UPDATE SET current_order_key = excluded.current_order_key, updated_at = excluded.updated_at, current_json = excluded.current_json, current_hash = excluded.current_hash,
            workflow_id = excluded.workflow_id, snapshot_id = excluded.snapshot_id, project_label = excluded.project_label, workflow_config_version = excluded.workflow_config_version,
            run_id = excluded.run_id, node_id = excluded.node_id, task_id = excluded.task_id`)
          .run(kind, key, workflowProjectionCurrentOrderKey(projected, key), d.projectId, d.sessionId, d.workflowId ?? null, d.snapshotId ?? null, d.projectLabel ?? null, d.workflowConfigVersion ?? null,
            d.runId ?? null, d.nodeId ?? null, d.taskId ?? null, event.timestamp, JSON.stringify(projected), currentHash(kind, key, projected));
      }
      if (event.usage) this.database.query(`INSERT INTO workflow_usage (event_id, project_id, session_id, workflow_id, run_id, node_id, precision, input_tokens, output_tokens, cost_micro_usd, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(event.eventId, d.projectId, d.sessionId, d.workflowId ?? null, d.runId ?? null, d.nodeId ?? null, event.usage.precision, event.usage.inputTokens, event.usage.outputTokens, event.usage.costMicroUsd, event.timestamp);
    })();
    return "inserted";
  }

  markStreamBlocked(streamId: string, projectId: string, sessionId: string, diagnostic: string, projectRoot?: string): void {
    const prior = this.streamStatus(streamId);
    const bounded = diagnostic.slice(0, 2_048);
    const value = { streamId, projectId, sessionId, ...(projectRoot ? { projectRoot } : {}), state: "blocked" as const, lastSequence: prior.lastSequence, lastHash: prior.lastHash, diagnostic: bounded };
    this.database.query(`INSERT INTO workflow_streams (stream_id, project_id, session_id, project_root, state, last_sequence, last_hash, diagnostic, state_hash)
      VALUES (?, ?, ?, ?, 'blocked', ?, ?, ?, ?) ON CONFLICT(stream_id) DO UPDATE SET state = 'blocked', diagnostic = excluded.diagnostic, state_hash = excluded.state_hash`)
      .run(streamId, projectId, sessionId, projectRoot ?? null, prior.lastSequence, prior.lastHash, bounded, streamHash(value));
  }

  existingStream(projectRoot: string, sessionId: string): Readonly<{ streamId: string; projectId: string; status: ProjectionStreamStatus }> | undefined {
    const rows = this.database.query(`SELECT stream_id, project_id FROM workflow_streams WHERE project_root = ? AND session_id = ? LIMIT 2`).all(projectRoot, sessionId) as Array<{ stream_id: string; project_id: string }>;
    if (rows.length !== 1) return undefined;
    return Object.freeze({ streamId: rows[0].stream_id, projectId: rows[0].project_id, status: this.streamStatus(rows[0].stream_id) });
  }

  markExistingStreamBlocked(projectRoot: string, sessionId: string, diagnostic: string): string | undefined {
    const existing = this.existingStream(projectRoot, sessionId);
    if (!existing) return undefined;
    this.markStreamBlocked(existing.streamId, existing.projectId, sessionId, diagnostic, projectRoot);
    return existing.streamId;
  }

  private block(event: WorkflowTelemetryEvent, diagnostic: string): never {
    this.markStreamBlocked(event.streamId, event.dimensions.projectId, event.dimensions.sessionId, diagnostic, event.dimensions.projectRoot);
    throw new Error(`Workflow projection stream ${event.streamId} ${diagnostic}`);
  }

  history(query: WorkflowHistoryQuery): WorkflowHistoryPage {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > WORKFLOW_PROJECTION_PAGE_LIMIT) throw new Error(`Workflow history limit must be 1..${WORKFLOW_PROJECTION_PAGE_LIMIT}`);
    validateQuery(query);
    const where: string[] = [];
    const parameters: Record<string, string | number> = { $limit: query.limit + 1 };
    if (query.cursor) {
      const [timestamp, streamId, sequence, eventId] = decodeWorkflowHistoryCursor(query.cursor);
      where.push(`(timestamp > $timestamp OR (timestamp = $timestamp AND stream_id > $stream) OR (timestamp = $timestamp AND stream_id = $stream AND sequence > $sequence) OR (timestamp = $timestamp AND stream_id = $stream AND sequence = $sequence AND event_id > $event))`);
      Object.assign(parameters, { $timestamp: timestamp, $stream: streamId, $sequence: sequence, $event: eventId });
    }
    const filters = [["project_id", "$project", query.projectId], ["session_id", "$session", query.sessionId], ["workflow_id", "$workflow", query.workflowId], ["run_id", "$run", query.runId], ["node_id", "$node", query.nodeId], ["task_id", "$task", query.taskId], ["event_type", "$type", query.eventType]] as const;
    for (const [column, parameter, value] of filters) if (value) { where.push(`${column} = ${parameter}`); parameters[parameter] = value; }
    const rows = this.database.query(`SELECT json(event_json) AS event_json FROM workflow_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY timestamp, stream_id, sequence, event_id LIMIT $limit`).all(parameters) as Array<{ event_json: string }>;
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map((entry) => parseEvent(entry.event_json));
    return { items, ...(hasMore && items.length ? { nextCursor: encodeWorkflowHistoryCursor(items.at(-1)!) } : {}), hasMore };
  }

  current(): WorkflowProjectionCurrent {
    return Object.fromEntries(CURRENT_KINDS.map((kind) => [kind, this.currentPage({ kind, limit: WORKFLOW_PROJECTION_PAGE_LIMIT }).items])) as unknown as WorkflowProjectionCurrent;
  }

  currentPage(query: WorkflowCurrentPageQuery): WorkflowCurrentPage {
    if (!CURRENT_KINDS.includes(query.kind) || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > WORKFLOW_PROJECTION_PAGE_LIMIT) throw new Error("Workflow current page query is invalid");
    if (query.cursor && Buffer.byteLength(query.cursor) > WORKFLOW_PROJECTION_QUERY_BYTES) throw new Error("Workflow current cursor exceeds its byte limit");
    const where: string[] = ["kind = $kind"];
    const parameters: Record<string, string | number> = { $kind: query.kind, $limit: query.limit + 1 };
    if (query.cursor) {
      where.push(`current_order_key > $current_order_key`);
      parameters.$current_order_key = workflowProjectionCurrentCursorOrderKey(query.cursor);
    }
    const rows = this.database.query(`SELECT entity_key, current_hash, json(current_json) AS current_json FROM workflow_current
      WHERE ${where.join(" AND ")} ORDER BY current_order_key LIMIT $limit`).all(parameters) as Array<{ entity_key: string; current_hash: string; current_json: string }>;
    const hasMore = rows.length > query.limit;
    const selected = rows.slice(0, query.limit).map((entry) => ({ ...entry, value: parseCurrent(query.kind, entry.entity_key, entry.current_json, entry.current_hash) }));
    const last = selected.at(-1);
    return { items: selected.map((entry) => entry.value), ...(hasMore && last ? { nextCursor: encodeWorkflowCurrentCursor(last.value, last.entity_key) } : {}), hasMore };
  }

  usage(): WorkflowProjectionUsageTotals {
    const output: WorkflowProjectionUsageTotals = { estimated: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 }, providerConfirmed: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 } };
    const rows = this.database.query(`SELECT precision, input_tokens, output_tokens, cost_micro_usd FROM workflow_usage ORDER BY event_id`).all() as Array<{ precision: string; input_tokens: number; output_tokens: number; cost_micro_usd: number }>;
    for (const row of rows) {
      const key = row.precision === "provider-confirmed" ? "providerConfirmed" : "estimated";
      const bucket = output[key] as { inputTokens: number; outputTokens: number; costMicroUsd: number };
      for (const [target, value] of [["inputTokens", row.input_tokens], ["outputTokens", row.output_tokens], ["costMicroUsd", row.cost_micro_usd]] as const) {
        const total = bucket[target] + Number(value);
        if (!Number.isSafeInteger(total) || total < 0) throw new Error("Workflow projection usage total exceeds its safe magnitude");
        bucket[target] = total;
      }
    }
    return output;
  }

  reset(): void {
    this.database.transaction(() => {
      this.database.run(`DELETE FROM workflow_usage`); this.database.run(`DELETE FROM workflow_current`); this.database.run(`DELETE FROM workflow_events`); this.database.run(`DELETE FROM workflow_event_identities`); this.database.run(`DELETE FROM workflow_streams`); this.database.run(`DELETE FROM workflow_prune_watermarks`);
    })();
  }
  rebuild(streams: readonly (readonly WorkflowTelemetryEvent[])[]): Readonly<{ diagnostics: readonly Readonly<{ streamId: string; diagnostic: string }>[] }> {
    this.reset();
    const diagnostics: Array<Readonly<{ streamId: string; diagnostic: string }>> = [];
    const ordered = [...streams].map((events) => [...events].sort((a, b) => a.sequence - b.sequence)).sort((a, b) => String(a[0]?.streamId ?? "").localeCompare(String(b[0]?.streamId ?? "")));
    for (const stream of ordered) {
      if (!stream[0]) continue;
      try { this.database.transaction(() => { for (const event of stream) this.ingest(event); })(); }
      catch (error) {
        const diagnostic = String(error instanceof Error ? error.message : error).slice(0, 2_048);
        this.markStreamBlocked(stream[0].streamId, stream[0].dimensions.projectId, stream[0].dimensions.sessionId, diagnostic, stream[0].dimensions.projectRoot);
        diagnostics.push(Object.freeze({ streamId: stream[0].streamId, diagnostic }));
      }
    }
    return Object.freeze({ diagnostics: Object.freeze(diagnostics) });
  }
  pruneProjection(cutoffIso: string): { removed: number; retained: number } {
    if (!Number.isFinite(Date.parse(cutoffIso))) throw new Error("Projection prune cutoff is invalid");
    let removed = 0;
    const candidateSql = `SELECT e.* FROM workflow_events e WHERE julianday(e.timestamp) < julianday($cutoff) AND NOT EXISTS (
      SELECT 1 FROM workflow_events prior WHERE prior.stream_id = e.stream_id AND prior.sequence < e.sequence AND julianday(prior.timestamp) >= julianday($cutoff))`;
    this.database.transaction(() => {
      const candidates = this.database.query(`${candidateSql} ORDER BY e.stream_id, e.sequence`).all({ $cutoff: cutoffIso }) as any[];
      removed = candidates.length;
      const lastByStream = new Map<string, any>();
      for (const candidate of candidates) lastByStream.set(candidate.stream_id, candidate);
      for (const candidate of lastByStream.values()) {
        const value: PruneWatermark = { streamId: candidate.stream_id, projectId: candidate.project_id, sessionId: candidate.session_id,
          ...(candidate.project_root ? { projectRoot: candidate.project_root } : {}), throughSequence: Number(candidate.sequence), throughHash: candidate.source_event_hash, cutoff: cutoffIso };
        this.database.query(`INSERT INTO workflow_prune_watermarks (stream_id, project_id, session_id, project_root, through_sequence, through_hash, cutoff, state_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(stream_id) DO UPDATE SET project_id = excluded.project_id, session_id = excluded.session_id,
          project_root = excluded.project_root, through_sequence = excluded.through_sequence, through_hash = excluded.through_hash, cutoff = excluded.cutoff, state_hash = excluded.state_hash`)
          .run(value.streamId, value.projectId, value.sessionId, value.projectRoot ?? null, value.throughSequence, value.throughHash, value.cutoff, watermarkHash(value));
      }
      this.database.query(`DELETE FROM workflow_usage WHERE event_id IN (SELECT event_id FROM (${candidateSql}))`).run({ $cutoff: cutoffIso });
      // Identity rows intentionally outlive retained history and its watermark.
      this.database.query(`DELETE FROM workflow_events WHERE event_id IN (SELECT event_id FROM (${candidateSql}))`).run({ $cutoff: cutoffIso });
    })();
    this.assertPersistedIntegrity();
    const retainedRow = this.database.query(`SELECT COUNT(*) AS count FROM workflow_events`).get() as { count: number } | null;
    return { removed, retained: Number(retainedRow?.count ?? 0) };
  }
  snapshot(): Record<string, unknown> {
    const countRow = this.database.query(`SELECT COUNT(*) AS count FROM workflow_events`).get() as { count: number } | null;
    const count = Number(countRow?.count ?? 0);
    const streams = (this.database.query(`SELECT stream_id FROM workflow_streams ORDER BY stream_id`).all() as Array<{ stream_id: string }>).map((row) => this.streamStatus(row.stream_id));
    return { schemaVersion: this.schemaVersion(), streams, current: this.current(), history: this.history({ limit: Math.max(1, Math.min(WORKFLOW_PROJECTION_PAGE_LIMIT, count || 1)) }).items, usage: this.usage() };
  }
}

export function openWorkflowProjectionDatabase(options: OpenWorkflowProjectionDatabaseOptions): WorkflowProjectionDatabase {
  return new WorkflowProjectionDatabase(options);
}
