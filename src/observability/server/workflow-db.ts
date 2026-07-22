import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
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
  type WorkflowUsageQuery,
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
  knowledge_proposal_id TEXT,
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
CREATE TABLE workflow_operation_receipts (
  scope TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('in_progress', 'completed', 'unknown')),
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_token TEXT,
  lease_expires_at TEXT,
  response_json BLOB,
  response_hash TEXT,
  PRIMARY KEY(scope, operation_id)
);
CREATE INDEX workflow_operation_receipts_updated ON workflow_operation_receipts(updated_at, scope, operation_id);
`;

const ADDITIVE_SCHEMA = `CREATE TABLE IF NOT EXISTS workflow_prune_watermarks (
  stream_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_root TEXT,
  through_sequence INTEGER NOT NULL,
  through_hash TEXT NOT NULL,
  cutoff TEXT NOT NULL,
  state_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_operation_receipts (
  scope TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('in_progress', 'completed', 'unknown')),
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_token TEXT,
  lease_expires_at TEXT,
  response_json BLOB,
  response_hash TEXT,
  PRIMARY KEY(scope, operation_id)
);
CREATE INDEX IF NOT EXISTS workflow_operation_receipts_updated ON workflow_operation_receipts(updated_at, scope, operation_id);`;

export const WORKFLOW_OPERATION_RECEIPT_LIMITS = Object.freeze({
  count: 4_096,
  responseBytes: 1_024 * 1_024,
  totalResponseBytes: 64 * 1_024 * 1_024,
  retentionMs: 30 * 86_400_000,
  leaseMs: 120_000,
  heartbeatMs: 10_000,
  concurrentWaitMs: 1_000,
  pollMs: 10,
});

export interface WorkflowOperationReceiptLimits {
  readonly count?: number;
  readonly responseBytes?: number;
  readonly totalResponseBytes?: number;
  readonly retentionMs?: number;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly concurrentWaitMs?: number;
  readonly pollMs?: number;
}
export interface WorkflowOperationRuntime {
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, delayMs: number) => unknown;
  readonly clearInterval?: (timer: unknown) => void;
}
type EffectiveWorkflowOperationReceiptLimits = Required<WorkflowOperationReceiptLimits>;

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
function operationResponseHash(value: unknown): string {
  return createHash("sha256").update("pi-hive-workflow-operation-response-v1\0").update(canonicalJson(value)).digest("hex");
}
function operationError(message: string, code: string): Error {
  return Object.assign(new Error(message), { status: 409, code });
}

export type WorkflowOperationClaim = Readonly<
  | { state: "claimed"; ownerToken: string }
  | { state: "completed"; result: unknown }
  | { state: "in_progress" }
  | { state: "unknown" }
>;
export type WorkflowStreamCatchUp = Readonly<
  | { state: "ready"; events: readonly WorkflowTelemetryEvent[] }
  | { state: "resync-required"; reason: "cursor-invalid" | "cursor-expired" | "catch-up-limit-exceeded" }
>;

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
  readonly operationLimits?: WorkflowOperationReceiptLimits;
  readonly operationRuntime?: WorkflowOperationRuntime;
}

function effectiveOperationLimits(input: WorkflowOperationReceiptLimits | undefined): EffectiveWorkflowOperationReceiptLimits {
  const limits = { ...WORKFLOW_OPERATION_RECEIPT_LIMITS, ...(input ?? {}) };
  const positive = ["count", "responseBytes", "totalResponseBytes", "retentionMs", "leaseMs", "heartbeatMs", "concurrentWaitMs", "pollMs"] as const;
  if (positive.some((key) => !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > WORKFLOW_OPERATION_RECEIPT_LIMITS[key])) throw new Error("Workflow operation receipt limits are invalid");
  if (limits.responseBytes > limits.totalResponseBytes || limits.heartbeatMs >= limits.leaseMs) throw new Error("Workflow operation receipt lease or response limits are invalid");
  return Object.freeze(limits);
}

export class WorkflowProjectionDatabase {
  readonly database: Database;
  readonly path: string;
  private readonly operationLimits: EffectiveWorkflowOperationReceiptLimits;
  private readonly operationNow: () => number;
  private readonly operationSetInterval: (callback: () => void, delayMs: number) => unknown;
  private readonly operationClearInterval: (timer: unknown) => void;
  private readonly activeOperations = new Map<string, Readonly<{ requestHash: string; promise: Promise<unknown> }>>();

  constructor(options: OpenWorkflowProjectionDatabaseOptions) {
    this.operationLimits = effectiveOperationLimits(options.operationLimits);
    this.operationNow = options.operationRuntime?.now ?? Date.now;
    this.operationSetInterval = options.operationRuntime?.setInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
    this.operationClearInterval = options.operationRuntime?.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
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
        database.exec(ADDITIVE_SCHEMA);
        // API/schema v1 permits additive optional projection dimensions. Keep
        // existing v1 databases readable while materializing proposal identity
        // for discovery without a destructive schema-version transition.
        const eventColumns = new Set((database.query(`PRAGMA table_info(workflow_events)`).all() as Array<{ name: string }>).map((column) => column.name));
        if (!eventColumns.has("knowledge_proposal_id")) database.run(`ALTER TABLE workflow_events ADD COLUMN knowledge_proposal_id TEXT`);
        const receiptColumns = new Set((database.query(`PRAGMA table_info(workflow_operation_receipts)`).all() as Array<{ name: string }>).map((column) => column.name));
        if (!receiptColumns.has("owner_token")) database.run(`ALTER TABLE workflow_operation_receipts ADD COLUMN owner_token TEXT`);
        if (!receiptColumns.has("lease_expires_at")) database.run(`ALTER TABLE workflow_operation_receipts ADD COLUMN lease_expires_at TEXT`);
        database.run("PRAGMA journal_mode = WAL");
        privateSqliteFiles(this.path);
        opened = database;
      } catch (error) { database.close(); throw error; }
    }, { timeoutMs: 10_000, staleMs: 30_000 });
    if (!opened) throw new Error("Workflow projection database initialization failed");
    this.database = opened;
    try {
      if (this.schemaVersion() !== WORKFLOW_SQLITE_SCHEMA_VERSION) throw new WorkflowProjectionSchemaError("Unsupported workflow projection schema version");
      const operationNow = this.operationNow();
      if (!Number.isFinite(operationNow)) throw new Error("Workflow operation receipt clock is invalid");
      this.pruneExpiredCompletedReceipts(new Date(operationNow));
      this.assertPersistedIntegrity();
    } catch (error) {
      this.database.close();
      if (error instanceof WorkflowProjectionIntegrityError || error instanceof WorkflowProjectionSchemaError) throw error;
      throw new WorkflowProjectionIntegrityError(`Workflow projection persisted integrity failure: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  private assertPersistedIntegrity(): void {
    const receiptRows = this.database.query(`SELECT *, json(response_json) AS authenticated_response_json FROM workflow_operation_receipts ORDER BY scope, operation_id`).all() as any[];
    let receiptResponseBytes = 0;
    for (const row of receiptRows) {
      const validIdentity = typeof row.scope === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(row.scope)
        && typeof row.operation_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(row.operation_id)
        && /^[0-9a-f]{64}$/u.test(row.request_hash)
        && Number.isFinite(Date.parse(row.claimed_at)) && Number.isFinite(Date.parse(row.updated_at));
      const completed = row.state === "completed";
      const leased = row.state === "in_progress" && typeof row.owner_token === "string" && /^[0-9a-f-]{36}$/u.test(row.owner_token)
        && typeof row.lease_expires_at === "string" && Number.isFinite(Date.parse(row.lease_expires_at));
      const legacyUnowned = row.state === "in_progress" && row.owner_token === null && row.lease_expires_at === null;
      const inactiveOwnership = row.state !== "in_progress" && row.owner_token === null && row.lease_expires_at === null;
      let validResponse = !completed && row.response_json === null && row.response_hash === null;
      if (completed && typeof row.authenticated_response_json === "string" && /^[0-9a-f]{64}$/u.test(row.response_hash ?? "")) {
        try {
          const bytes = Buffer.byteLength(row.authenticated_response_json, "utf8");
          receiptResponseBytes += bytes;
          validResponse = bytes <= this.operationLimits.responseBytes && operationResponseHash(JSON.parse(row.authenticated_response_json)) === row.response_hash;
        } catch { validResponse = false; }
      }
      if (!validIdentity || !["in_progress", "completed", "unknown"].includes(row.state) || (!leased && !legacyUnowned && !inactiveOwnership) || !validResponse) throw new Error("Workflow projection persisted operation-receipt integrity failure");
    }
    if (receiptRows.length > this.operationLimits.count || receiptResponseBytes > this.operationLimits.totalResponseBytes) throw new Error("Workflow projection persisted operation-receipt capacity exceeded");
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
      ["knowledge_job_id", "knowledgeJobId"], ["knowledge_proposal_id", "knowledgeProposalId"], ["knowledge_update_id", "knowledgeUpdateId"], ["model_id", "modelId"], ["thinking", "thinking"], ["tool_name", "toolName"],
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

  private operationDate(): Date {
    const value = this.operationNow();
    if (!Number.isFinite(value)) throw new Error("Workflow operation receipt clock is invalid");
    return new Date(value);
  }

  private pruneExpiredCompletedReceipts(now: Date): number {
    const cutoff = new Date(now.getTime() - this.operationLimits.retentionMs).toISOString();
    return this.database.query(`DELETE FROM workflow_operation_receipts WHERE state = 'completed' AND updated_at < ?`).run(cutoff).changes;
  }

  private receiptCapacityError(message: string): Error {
    return Object.assign(new Error(message), { status: 503, code: "OPERATION_RECEIPT_CAPACITY" });
  }

  private claimOperation(scope: string, operationId: string, requestHash: string, now: Date): WorkflowOperationClaim {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(scope) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(operationId) || !/^[0-9a-f]{64}$/u.test(requestHash)) {
      throw new Error("Workflow operation receipt identity is invalid");
    }
    const nowIso = now.toISOString();
    return this.database.transaction(() => {
      const row = this.database.query(`SELECT request_hash, state, owner_token, lease_expires_at, json(response_json) AS response_json, response_hash
        FROM workflow_operation_receipts WHERE scope = ? AND operation_id = ?`).get(scope, operationId) as any;
      if (!row) {
        this.pruneExpiredCompletedReceipts(now);
        const count = Number((this.database.query(`SELECT COUNT(*) AS count FROM workflow_operation_receipts`).get() as { count: number }).count);
        if (count >= this.operationLimits.count) throw this.receiptCapacityError("workflow operation receipt count capacity is exhausted");
        const ownerToken = randomUUID();
        const leaseExpiresAt = new Date(now.getTime() + this.operationLimits.leaseMs).toISOString();
        this.database.query(`INSERT INTO workflow_operation_receipts
          (scope, operation_id, request_hash, state, claimed_at, updated_at, owner_token, lease_expires_at, response_json, response_hash)
          VALUES (?, ?, ?, 'in_progress', ?, ?, ?, ?, NULL, NULL)`).run(scope, operationId, requestHash, nowIso, nowIso, ownerToken, leaseExpiresAt);
        return Object.freeze({ state: "claimed" as const, ownerToken });
      }
      if (row.request_hash !== requestHash) throw operationError("operation ID reuse conflicts with prior input", "OPERATION_CONFLICT");
      if (row.state === "completed") {
        let result: unknown;
        try { result = JSON.parse(row.response_json); }
        catch { throw new WorkflowProjectionIntegrityError("Workflow operation receipt response is corrupt"); }
        if (operationResponseHash(result) !== row.response_hash) throw new WorkflowProjectionIntegrityError("Workflow operation receipt response integrity failure");
        return Object.freeze({ state: "completed" as const, result });
      }
      if (row.state === "unknown") return Object.freeze({ state: "unknown" as const });
      const leaseExpiresAt = Date.parse(row.lease_expires_at ?? "");
      if (!row.owner_token || !Number.isFinite(leaseExpiresAt) || now.getTime() >= leaseExpiresAt) {
        this.database.query(`UPDATE workflow_operation_receipts SET state = 'unknown', updated_at = ?, owner_token = NULL, lease_expires_at = NULL
          WHERE scope = ? AND operation_id = ? AND request_hash = ? AND state = 'in_progress' AND owner_token IS ?`)
          .run(nowIso, scope, operationId, requestHash, row.owner_token ?? null);
        return Object.freeze({ state: "unknown" as const });
      }
      return Object.freeze({ state: "in_progress" as const });
    }).immediate();
  }

  private renewOperation(scope: string, operationId: string, requestHash: string, ownerToken: string, now: Date): boolean {
    const leaseExpiresAt = new Date(now.getTime() + this.operationLimits.leaseMs).toISOString();
    return this.database.query(`UPDATE workflow_operation_receipts SET updated_at = ?, lease_expires_at = ?
      WHERE scope = ? AND operation_id = ? AND request_hash = ? AND state = 'in_progress' AND owner_token = ?`)
      .run(now.toISOString(), leaseExpiresAt, scope, operationId, requestHash, ownerToken).changes === 1;
  }

  private finalizeOperation(scope: string, operationId: string, requestHash: string, ownerToken: string, result: unknown, now: Date): unknown {
    let serialized: string;
    let stored: unknown;
    try {
      serialized = JSON.stringify(result);
      if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > this.operationLimits.responseBytes) throw new Error();
      stored = JSON.parse(serialized);
    } catch { throw new Error("Workflow operation response is not bounded JSON"); }
    const responseHash = operationResponseHash(stored);
    this.database.transaction(() => {
      this.pruneExpiredCompletedReceipts(now);
      const receipt = this.database.query(`SELECT request_hash, state, owner_token FROM workflow_operation_receipts WHERE scope = ? AND operation_id = ?`).get(scope, operationId) as { request_hash: string; state: string; owner_token: string | null } | null;
      if (!receipt || receipt.request_hash !== requestHash || receipt.state !== "in_progress" || receipt.owner_token !== ownerToken) throw operationError("operation receipt cannot be finalized from its current ownership state", "OPERATION_OUTCOME_UNKNOWN");
      const persistedBytes = Number((this.database.query(`SELECT COALESCE(SUM(length(CAST(json(response_json) AS BLOB))), 0) AS bytes FROM workflow_operation_receipts WHERE state = 'completed'`).get() as { bytes: number }).bytes);
      if (!Number.isSafeInteger(persistedBytes) || persistedBytes + Buffer.byteLength(serialized, "utf8") > this.operationLimits.totalResponseBytes) throw this.receiptCapacityError("workflow operation receipt response-byte capacity is exhausted");
      this.database.query(`UPDATE workflow_operation_receipts SET state = 'completed', updated_at = ?, owner_token = NULL, lease_expires_at = NULL, response_json = jsonb(?), response_hash = ?
        WHERE scope = ? AND operation_id = ? AND request_hash = ? AND state = 'in_progress' AND owner_token = ?`)
        .run(now.toISOString(), serialized, responseHash, scope, operationId, requestHash, ownerToken);
    }).immediate();
    return stored;
  }

  private markOperationUnknown(scope: string, operationId: string, requestHash: string, ownerToken: string, now: Date): void {
    this.database.query(`UPDATE workflow_operation_receipts SET state = 'unknown', updated_at = ?, owner_token = NULL, lease_expires_at = NULL
      WHERE scope = ? AND operation_id = ? AND request_hash = ? AND state = 'in_progress' AND owner_token = ?`).run(now.toISOString(), scope, operationId, requestHash, ownerToken);
  }

  private async executeOperation<T>(scope: string, operationId: string, requestHash: string, invoke: () => T | Promise<T>): Promise<T> {
    const waitUntil = this.operationNow() + this.operationLimits.concurrentWaitMs;
    while (true) {
      const claim = this.claimOperation(scope, operationId, requestHash, this.operationDate());
      if (claim.state === "completed") return structuredClone(claim.result) as T;
      if (claim.state === "unknown") throw operationError("operation outcome is unknown and cannot be retried safely", "OPERATION_OUTCOME_UNKNOWN");
      if (claim.state === "claimed") {
        let heartbeatError: unknown;
        const timer = this.operationSetInterval(() => {
          try {
            if (!this.renewOperation(scope, operationId, requestHash, claim.ownerToken, this.operationDate())) heartbeatError = operationError("operation lease ownership was lost", "OPERATION_OUTCOME_UNKNOWN");
          } catch (error) { heartbeatError = error; }
        }, this.operationLimits.heartbeatMs);
        try {
          const result = await invoke();
          if (heartbeatError) throw heartbeatError;
          if (!this.renewOperation(scope, operationId, requestHash, claim.ownerToken, this.operationDate())) throw operationError("operation lease ownership was lost", "OPERATION_OUTCOME_UNKNOWN");
          return this.finalizeOperation(scope, operationId, requestHash, claim.ownerToken, result, this.operationDate()) as T;
        } catch (error) {
          this.markOperationUnknown(scope, operationId, requestHash, claim.ownerToken, this.operationDate());
          throw error;
        } finally { this.operationClearInterval(timer); }
      }
      if (this.operationNow() >= waitUntil) throw operationError("identical operation is still in progress", "OPERATION_IN_PROGRESS");
      await new Promise((resolve) => setTimeout(resolve, this.operationLimits.pollMs));
    }
  }

  runOperation<T>(scope: string, operationId: string, requestHash: string, invoke: () => T | Promise<T>): Promise<T> {
    const key = `${scope}\0${operationId}`;
    const active = this.activeOperations.get(key);
    if (active) {
      if (active.requestHash !== requestHash) return Promise.reject(operationError("operation ID reuse conflicts with active input", "OPERATION_CONFLICT"));
      return active.promise.then((result) => structuredClone(result) as T);
    }
    const executing = this.executeOperation(scope, operationId, requestHash, invoke);
    const coordinated = executing.finally(() => { if (this.activeOperations.get(key)?.promise === coordinated) this.activeOperations.delete(key); });
    this.activeOperations.set(key, Object.freeze({ requestHash, promise: coordinated }));
    return coordinated.then((result) => structuredClone(result) as T);
  }

  streamCatchUp(cursor: string, limit: number): WorkflowStreamCatchUp {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKFLOW_PROJECTION_PAGE_LIMIT) throw new Error("Workflow stream catch-up limit is invalid");
    let decoded: readonly [string, string, number, string];
    try { decoded = decodeWorkflowHistoryCursor(cursor); }
    catch { return Object.freeze({ state: "resync-required", reason: "cursor-invalid" }); }
    const retained = this.database.query(`SELECT event_id FROM workflow_events WHERE timestamp = ? AND stream_id = ? AND sequence = ? AND event_id = ?`)
      .get(decoded[0], decoded[1], decoded[2], decoded[3]);
    if (!retained) return Object.freeze({ state: "resync-required", reason: "cursor-expired" });
    const page = this.history({ cursor, limit });
    if (page.hasMore) return Object.freeze({ state: "resync-required", reason: "catch-up-limit-exceeded" });
    return Object.freeze({ state: "ready", events: Object.freeze([...page.items]) });
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
         workspace_id, workspace_hash, lease_state, question_id, checkpoint_id, approval_id, knowledge_job_id, knowledge_proposal_id, knowledge_update_id,
         model_id, thinking, tool_name, capability_id, attempt_id, operation_id, precision, elapsed_ms, active_wall_time_ms,
         budget_scope, budget_used, budget_limit, budget_remaining, change_coverage, terminal_refs_json,
         sequence, previous_hash, event_hash, payload_hash, source_event_hash, timestamp, event_type, event_json)
        VALUES ($event_id, $stream_id, $project_id, $project_root, $project_label, $pi_session_id, $session_id, $workflow_id, $snapshot_id, $workflow_config_hash, $workflow_config_version, $run_id,
         $agent_id, $agent_name, $node_id, $parent_node_id, $task_id, $adapter_id, $adapter_version, $profile_id, $profile_version,
         $workspace_id, $workspace_hash, $lease_state, $question_id, $checkpoint_id, $approval_id, $knowledge_job_id, $knowledge_proposal_id, $knowledge_update_id,
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
        $knowledge_job_id: d.knowledgeJobId ?? null, $knowledge_proposal_id: d.knowledgeProposalId ?? null, $knowledge_update_id: d.knowledgeUpdateId ?? null, $model_id: d.modelId ?? null,
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

  aggregateCurrentPage(resource: "projects" | "workflows", query: Omit<WorkflowCurrentPageQuery, "kind">): WorkflowCurrentPage {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > WORKFLOW_PROJECTION_PAGE_LIMIT) throw new Error("Workflow aggregate page query is invalid");
    const values = [query.cursor, query.projectId, query.sessionId, query.workflowId, query.status].filter((value): value is string => value !== undefined);
    if (values.some((value) => Buffer.byteLength(value) > WORKFLOW_PROJECTION_VALUE_BYTES) || values.reduce((sum, value) => sum + Buffer.byteLength(value), 0) > WORKFLOW_PROJECTION_QUERY_BYTES) throw new Error("Workflow aggregate query exceeds its byte limit");
    let cursorProject = "", cursorWorkflow = "";
    if (query.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as unknown;
        if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== resource || typeof parsed[1] !== "string" || typeof parsed[2] !== "string"
          || Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url") !== query.cursor) throw new Error();
        cursorProject = parsed[1]; cursorWorkflow = parsed[2];
      } catch { throw new Error("Workflow aggregate cursor is invalid"); }
    }
    const where = ["kind = 'sessions'"];
    const parameters: Record<string, string | number> = { $limit: query.limit + 1 };
    const filters = [["project_id", "$project", query.projectId], ["session_id", "$session", query.sessionId], ["workflow_id", "$workflow", query.workflowId]] as const;
    for (const [column, parameter, value] of filters) if (value) { where.push(`${column} = ${parameter}`); parameters[parameter] = value; }
    if (resource === "workflows") where.push("workflow_id IS NOT NULL");
    if (query.status) parameters.$status = query.status;
    const workflowExpression = resource === "workflows" ? "workflow_id" : "''";
    if (query.cursor) {
      where.push(`(project_id > $cursor_project OR (project_id = $cursor_project AND ${workflowExpression} > $cursor_workflow))`);
      parameters.$cursor_project = cursorProject; parameters.$cursor_workflow = cursorWorkflow;
    }
    const rows = this.database.query(`WITH ranked AS (
      SELECT entity_key, current_hash, json(current_json) AS current_json, project_id, ${workflowExpression} AS aggregate_workflow,
        ROW_NUMBER() OVER (PARTITION BY project_id, ${workflowExpression}
          ORDER BY julianday(updated_at) DESC, updated_at DESC, current_order_key DESC) AS rank
      FROM workflow_current WHERE ${where.join(" AND ")}
    ) SELECT entity_key, current_hash, current_json, project_id, aggregate_workflow FROM ranked WHERE rank = 1
      ${query.status ? "AND json_extract(current_json, '$.status') = $status" : ""}
      ORDER BY project_id, aggregate_workflow LIMIT $limit`).all(parameters) as Array<{ entity_key: string; current_hash: string; current_json: string; project_id: string; aggregate_workflow: string }>;
    const hasMore = rows.length > query.limit;
    const selected = rows.slice(0, query.limit);
    const items = selected.map((entry) => parseCurrent("sessions", entry.entity_key, entry.current_json, entry.current_hash));
    const last = selected.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify([resource, last.project_id, last.aggregate_workflow]), "utf8").toString("base64url") : undefined;
    return { items, ...(nextCursor ? { nextCursor } : {}), hasMore };
  }

  currentPage(query: WorkflowCurrentPageQuery): WorkflowCurrentPage {
    if (!CURRENT_KINDS.includes(query.kind) || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > WORKFLOW_PROJECTION_PAGE_LIMIT) throw new Error("Workflow current page query is invalid");
    const values = [query.cursor, query.projectId, query.sessionId, query.workflowId, query.runId, query.nodeId, query.taskId, query.status].filter((value): value is string => value !== undefined);
    if (values.some((value) => Buffer.byteLength(value) > WORKFLOW_PROJECTION_VALUE_BYTES) || values.reduce((sum, value) => sum + Buffer.byteLength(value), 0) > WORKFLOW_PROJECTION_QUERY_BYTES) throw new Error("Workflow current query exceeds its byte limit");
    const where: string[] = ["kind = $kind"];
    const parameters: Record<string, string | number> = { $kind: query.kind, $limit: query.limit + 1 };
    if (query.cursor) {
      where.push(`current_order_key > $current_order_key`);
      parameters.$current_order_key = workflowProjectionCurrentCursorOrderKey(query.cursor);
    }
    const filters = [["project_id", "$project", query.projectId], ["session_id", "$session", query.sessionId], ["workflow_id", "$workflow", query.workflowId],
      ["run_id", "$run", query.runId], ["node_id", "$node", query.nodeId], ["task_id", "$task", query.taskId]] as const;
    for (const [column, parameter, value] of filters) if (value) { where.push(`${column} = ${parameter}`); parameters[parameter] = value; }
    if (query.status) { where.push(`json_extract(current_json, '$.status') = $status`); parameters.$status = query.status; }
    const rows = this.database.query(`SELECT entity_key, current_hash, json(current_json) AS current_json FROM workflow_current
      WHERE ${where.join(" AND ")} ORDER BY current_order_key LIMIT $limit`).all(parameters) as Array<{ entity_key: string; current_hash: string; current_json: string }>;
    const hasMore = rows.length > query.limit;
    const selected = rows.slice(0, query.limit).map((entry) => ({ ...entry, value: parseCurrent(query.kind, entry.entity_key, entry.current_json, entry.current_hash) }));
    const last = selected.at(-1);
    return { items: selected.map((entry) => entry.value), ...(hasMore && last ? { nextCursor: encodeWorkflowCurrentCursor(last.value, last.entity_key) } : {}), hasMore };
  }

  usage(query: WorkflowUsageQuery = {}): WorkflowProjectionUsageTotals {
    const values = Object.values(query).filter((value): value is string => value !== undefined);
    if (values.some((value) => Buffer.byteLength(value) > WORKFLOW_PROJECTION_VALUE_BYTES) || values.reduce((sum, value) => sum + Buffer.byteLength(value), 0) > WORKFLOW_PROJECTION_QUERY_BYTES) throw new Error("Workflow usage query exceeds its byte limit");
    const output: WorkflowProjectionUsageTotals = { estimated: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 }, providerConfirmed: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 } };
    const where: string[] = [];
    const parameters: Record<string, string> = {};
    const filters = [["project_id", "$project", query.projectId], ["session_id", "$session", query.sessionId], ["workflow_id", "$workflow", query.workflowId], ["run_id", "$run", query.runId], ["node_id", "$node", query.nodeId]] as const;
    for (const [column, parameter, value] of filters) if (value) { where.push(`${column} = ${parameter}`); parameters[parameter] = value; }
    const rows = this.database.query(`SELECT precision, input_tokens, output_tokens, cost_micro_usd FROM workflow_usage ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY event_id`).all(parameters) as Array<{ precision: string; input_tokens: number; output_tokens: number; cost_micro_usd: number }>;
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
  /** Publishes a complete replacement in one SQLite write transaction. Any failure restores the prior valid projection. */
  replaceProjectionAtomically<T>(build: () => T): T {
    return this.database.transaction(() => {
      this.reset();
      const result = build();
      this.assertPersistedIntegrity();
      return result;
    }).immediate();
  }
  /** Rebuild one authoritative stream without retaining any other stream in memory. */
  rebuildStream(stream: readonly WorkflowTelemetryEvent[]): Readonly<{ streamId: string; diagnostic: string }> | undefined {
    if (!stream[0]) return undefined;
    try { this.database.transaction(() => { for (const event of stream) this.ingest(event); })(); }
    catch (error) {
      const diagnostic = String(error instanceof Error ? error.message : error).slice(0, 2_048);
      this.markStreamBlocked(stream[0].streamId, stream[0].dimensions.projectId, stream[0].dimensions.sessionId, diagnostic, stream[0].dimensions.projectRoot);
      return Object.freeze({ streamId: stream[0].streamId, diagnostic });
    }
    return undefined;
  }
  rebuild(streams: readonly (readonly WorkflowTelemetryEvent[])[]): Readonly<{ diagnostics: readonly Readonly<{ streamId: string; diagnostic: string }>[] }> {
    this.reset();
    const diagnostics: Array<Readonly<{ streamId: string; diagnostic: string }>> = [];
    const ordered = [...streams].map((events) => [...events].sort((a, b) => a.sequence - b.sequence)).sort((a, b) => String(a[0]?.streamId ?? "").localeCompare(String(b[0]?.streamId ?? "")));
    for (const stream of ordered) {
      const diagnostic = this.rebuildStream(stream);
      if (diagnostic) diagnostics.push(diagnostic);
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
