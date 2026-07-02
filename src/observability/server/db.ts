import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB_PATH } from "./config";
import type { HiveStateSnapshot, HiveTelemetryEvent } from "../../shared/telemetry";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const isNewDb = !fs.existsSync(DB_PATH) || fs.statSync(DB_PATH).size === 0;
export const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 5000");
// Enable incremental auto-vacuum on fresh DBs so the prune action (B6) can
// reclaim space via PRAGMA incremental_vacuum. Legacy DBs keep their existing
// vacuum mode (switching would require a full rewrite) and skip vacuuming.
if (isNewDb) db.run("PRAGMA auto_vacuum = INCREMENTAL");
db.run(`
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  cwd TEXT,
  session_dir TEXT,
  telemetry_log TEXT,
  conversation_log TEXT,
  state_file TEXT,
  first_ts TEXT,
  last_ts TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  topology_hash TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT,
  pid INTEGER,
  cwd TEXT,
  telemetry_log TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hive_events_session_seq ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_hive_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_hive_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_hive_events_session_ts ON events(session_id, ts, seq);
CREATE TABLE IF NOT EXISTS states (
  session_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  cwd TEXT,
  session_dir TEXT,
  telemetry_log TEXT,
  state_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_verdicts (
  id            TEXT PRIMARY KEY,
  change_id     TEXT NOT NULL,
  reviewer      TEXT NOT NULL,
  verdict       TEXT NOT NULL,
  summary       TEXT,
  evidence_json TEXT,
  concerns_json TEXT,
  blockers_json TEXT,
  session_id    TEXT,
  cwd           TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_verdicts_change ON plan_verdicts(change_id, created_at);
CREATE TABLE IF NOT EXISTS plan_approvals (
  id           TEXT PRIMARY KEY,
  change_id    TEXT NOT NULL,
  phase        TEXT NOT NULL,
  approved_by  TEXT NOT NULL,
  actor        TEXT,
  summary      TEXT,
  session_id   TEXT,
  cwd          TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_approvals_change ON plan_approvals(change_id, created_at);
CREATE TABLE IF NOT EXISTS plan_comments (
  id           TEXT PRIMARY KEY,
  change_id    TEXT NOT NULL,
  file         TEXT,
  anchor       TEXT,
  author       TEXT,
  body         TEXT NOT NULL,
  annotation_type TEXT,
  original_text TEXT,
  session_id   TEXT,
  cwd          TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_comments_change ON plan_comments(change_id, created_at);

-- Typed projections of hot entities, materialized idempotently at ingest
-- (event_id as row id). The raw events table stays the append-only audit log.
CREATE TABLE IF NOT EXISTS delegations (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  cwd TEXT,
  agent TEXT,
  parent TEXT,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  status TEXT,
  stop_reason TEXT,
  model TEXT
);
CREATE INDEX IF NOT EXISTS idx_delegations_session ON delegations(session_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_delegations_cwd ON delegations(cwd, ended_at);
CREATE TABLE IF NOT EXISTS tool_calls (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  cwd TEXT,
  agent TEXT,
  tool_name TEXT,
  tool_call_id TEXT,
  args_preview TEXT,
  result_preview TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_calls_unique ON tool_calls(session_id, tool_call_id);
CREATE TABLE IF NOT EXISTS messages (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  cwd TEXT,
  role TEXT,
  agent TEXT,
  text TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts);

-- Incremental-ingest byte offsets so boot resumes each JSONL where it left off
-- instead of replaying from 0 (B4). Persisted in the same transaction as the
-- batch it covers.
CREATE TABLE IF NOT EXISTS ingest_sources (
  path TEXT PRIMARY KEY,
  session_id TEXT,
  offset INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- Versioned topology (Phase C). One immutable row per unique team configuration,
-- keyed by content hash; sessions reference the hash they ran under.
CREATE TABLE IF NOT EXISTS topology_versions (
  hash          TEXT PRIMARY KEY,
  cwd           TEXT NOT NULL,
  topology_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topology_versions_cwd ON topology_versions(cwd, last_seen_at);

-- The same topology exploded into queryable tree rows (Decision 13). Derived 1:1
-- from topology_json at insert time; immutable like its parent version.
CREATE TABLE IF NOT EXISTS topology_nodes (
  topology_hash   TEXT NOT NULL,
  team            TEXT NOT NULL,
  node_id         INTEGER NOT NULL,
  parent_id       INTEGER,
  name            TEXT NOT NULL,
  role            TEXT,
  agent_type      TEXT,
  model           TEXT,
  thinking        TEXT,
  thinking_levels TEXT,
  color           TEXT,
  group_name      TEXT,
  tools_json      TEXT,
  domain_json     TEXT,
  stages_json     TEXT,
  commit_allowed  INTEGER NOT NULL DEFAULT 0,
  routing_tags_json TEXT,
  consult_when    TEXT,
  responsibilities_json TEXT,
  PRIMARY KEY (topology_hash, team, node_id)
);
CREATE INDEX IF NOT EXISTS idx_topology_nodes_name ON topology_nodes(topology_hash, name);

-- SDK-sourced model capabilities, CONTENT-VERSIONED (Decision 13 / A10). Each
-- distinct capability set (reasoning + thinking_levels + pricing + context) for a
-- (provider, model_id) is an immutable row keyed by model_hash, so a provider
-- pricing/capability change mints a NEW row instead of overwriting history. A
-- delegation can reference the exact model_hash it ran under. Note: historical
-- COST never re-derives from here — it is frozen per-delegation (Decision 10);
-- this table is faithful reference/capability history, not the cost source.
CREATE TABLE IF NOT EXISTS model_versions (
  model_hash      TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  name            TEXT,
  api             TEXT,
  reasoning       INTEGER NOT NULL DEFAULT 0,
  thinking_levels TEXT NOT NULL,
  context_window  INTEGER,
  max_tokens      INTEGER,
  cost_input REAL, cost_output REAL, cost_cache_read REAL, cost_cache_write REAL,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_versions_model ON model_versions(provider, model_id, last_seen_at);
`);

// Per-project display-name overrides, keyed by working directory. Lets the user
// rename a project in the dashboard without touching the derived-from-cwd name
// used internally for grouping/scope.
db.run(`
CREATE TABLE IF NOT EXISTS project_overrides (
  cwd TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  updated_at TEXT
)
`);

// Lightweight migrations for existing local dashboard DBs. Each ALTER is a
// no-op (throws, caught) once the column exists, so re-running on every boot is
// idempotent.
try { db.run(`ALTER TABLE plan_comments ADD COLUMN annotation_type TEXT`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE plan_comments ADD COLUMN original_text TEXT`); } catch { /* column already exists */ }
// B1: project-scope the plan tables.
try { db.run(`ALTER TABLE plan_verdicts ADD COLUMN cwd TEXT`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE plan_approvals ADD COLUMN cwd TEXT`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE plan_comments ADD COLUMN cwd TEXT`); } catch { /* column already exists */ }
// B2: authoritative token/cost/topology columns on sessions.
try { db.run(`ALTER TABLE sessions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE sessions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE sessions ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE sessions ADD COLUMN topology_hash TEXT`); } catch { /* column already exists */ }

// The cwd composite indexes are created HERE, after the ALTER TABLE migrations
// above — on a legacy DB the plan_* tables predate the cwd column, so an index
// referencing cwd inside the CREATE-block would fail ("no such column: cwd").
db.run(`
CREATE INDEX IF NOT EXISTS idx_plan_verdicts_cwd ON plan_verdicts(cwd, change_id, created_at);
CREATE INDEX IF NOT EXISTS idx_plan_approvals_cwd ON plan_approvals(cwd, change_id, created_at);
CREATE INDEX IF NOT EXISTS idx_plan_comments_cwd ON plan_comments(cwd, change_id, created_at);
`);

// J2: one-time backfill of plan-table cwd from the owning session. Legacy plan_*
// rows (written before B1's cwd column) have NULL cwd and until now relied on the
// NULL-wildcard read that was only meant to bridge one release. Where a row's
// session_id matches a known session, copy that session's cwd so the row becomes
// project-scoped properly. Idempotent: rows already scoped, or with no matching
// session (plans created outside a session), are untouched and keep the wildcard.
// Exported so the double-boot / synthetic-row test can drive it directly.
export function backfillPlanCwd(): void {
  for (const table of ["plan_verdicts", "plan_approvals", "plan_comments"] as const) {
    db.run(`
      UPDATE ${table}
      SET cwd = (SELECT s.cwd FROM sessions s WHERE s.session_id = ${table}.session_id)
      WHERE cwd IS NULL
        AND session_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = ${table}.session_id AND s.cwd IS NOT NULL)
    `);
  }
}
backfillPlanCwd();

export const insertEvent = db.query(`
  INSERT OR IGNORE INTO events
    (event_id, session_id, seq, ts, type, actor, pid, cwd, telemetry_log, payload_json)
  VALUES
    ($event_id, $session_id, $seq, $ts, $type, $actor, $pid, $cwd, $telemetry_log, $payload_json)
`);

// Per-event session upsert. event_count uses arithmetic (+1) instead of the old
// correlated (SELECT COUNT(*) …) subquery — the latter made boot replay of a
// long JSONL quadratic. Callers MUST run this only for genuinely new events
// (behind the INSERT-OR-IGNORE dup check) so the increment stays accurate.
export const upsertSession = db.query(`
  INSERT INTO sessions
    (session_id, cwd, session_dir, telemetry_log, conversation_log, state_file, first_ts, last_ts, event_count)
  VALUES
    ($session_id, $cwd, $session_dir, $telemetry_log, $conversation_log, $state_file, $ts, $ts, 1)
  ON CONFLICT(session_id) DO UPDATE SET
    cwd = COALESCE(excluded.cwd, sessions.cwd),
    session_dir = COALESCE(excluded.session_dir, sessions.session_dir),
    telemetry_log = COALESCE(excluded.telemetry_log, sessions.telemetry_log),
    conversation_log = COALESCE(excluded.conversation_log, sessions.conversation_log),
    state_file = COALESCE(excluded.state_file, sessions.state_file),
    first_ts = CASE WHEN sessions.first_ts IS NULL OR excluded.first_ts < sessions.first_ts THEN excluded.first_ts ELSE sessions.first_ts END,
    last_ts = CASE WHEN sessions.last_ts IS NULL OR excluded.last_ts > sessions.last_ts THEN excluded.last_ts ELSE sessions.last_ts END,
    event_count = sessions.event_count + 1
`);

// Authoritative token/cost totals for a session, summed across all its agents
// from the latest state snapshot (B2). Kept separate from the per-event upsert
// so counters reflect the snapshot's ground truth, not per-event guesses. Never
// inserts a bare row — a session always exists via the event path first; this
// only updates an existing row (no-op if the session hasn't been seen yet).
export const updateSessionStats = db.query(`
  UPDATE sessions SET
    input_tokens = $input_tokens,
    output_tokens = $output_tokens,
    cache_read_tokens = $cache_read_tokens,
    cache_write_tokens = $cache_write_tokens,
    cost_usd = $cost_usd,
    topology_hash = COALESCE($topology_hash, topology_hash),
    last_ts = CASE WHEN last_ts IS NULL OR $updated_at > last_ts THEN $updated_at ELSE last_ts END,
    cwd = COALESCE(cwd, $cwd),
    session_dir = COALESCE(session_dir, $session_dir),
    telemetry_log = COALESCE(telemetry_log, $telemetry_log)
  WHERE session_id = $session_id
`);

// Ensure a session row exists (used before updateSessionStats when a snapshot
// arrives before any event). Bumps timestamps but not event_count.
export const ensureSession = db.query(`
  INSERT INTO sessions (session_id, cwd, session_dir, telemetry_log, first_ts, last_ts, event_count)
  VALUES ($session_id, $cwd, $session_dir, $telemetry_log, $ts, $ts, 0)
  ON CONFLICT(session_id) DO NOTHING
`);

export const upsertState = db.query(`
  INSERT INTO states (session_id, updated_at, cwd, session_dir, telemetry_log, state_json)
  VALUES ($session_id, $updated_at, $cwd, $session_dir, $telemetry_log, $state_json)
  ON CONFLICT(session_id) DO UPDATE SET
    updated_at = excluded.updated_at,
    cwd = COALESCE(excluded.cwd, states.cwd),
    session_dir = COALESCE(excluded.session_dir, states.session_dir),
    telemetry_log = COALESCE(excluded.telemetry_log, states.telemetry_log),
    state_json = excluded.state_json
`);

const deleteEventsStmt = db.query(`DELETE FROM events WHERE session_id = $id`);
const deleteStateStmt = db.query(`DELETE FROM states WHERE session_id = $id`);
const deleteSessionStmt = db.query(`DELETE FROM sessions WHERE session_id = $id`);
const deleteDelegationsStmt = db.query(`DELETE FROM delegations WHERE session_id = $id`);
const deleteToolCallsStmt = db.query(`DELETE FROM tool_calls WHERE session_id = $id`);
const deleteMessagesStmt = db.query(`DELETE FROM messages WHERE session_id = $id`);
const deleteIngestSourcesStmt = db.query(`DELETE FROM ingest_sources WHERE session_id = $id`);

export function dbEventRow(event: HiveTelemetryEvent) {
  return {
    $event_id: event.event_id,
    $session_id: event.session_id || "unknown",
    $seq: Number(event.seq || 0),
    $ts: event.ts || new Date().toISOString(),
    $type: event.type || "unknown",
    $actor: event.actor || null,
    $pid: Number(event.pid || 0),
    $cwd: event.cwd || null,
    $telemetry_log: event.telemetry_log || null,
    $payload_json: JSON.stringify(event.payload || {}),
  };
}

export function dbSessionRowFromEvent(event: HiveTelemetryEvent) {
  return {
    $session_id: event.session_id || "unknown",
    $cwd: event.cwd || null,
    $session_dir: event.session_dir || null,
    $telemetry_log: event.telemetry_log || null,
    $conversation_log: event.conversation_log || null,
    $state_file: event.state_file || (event.telemetry_log ? path.join(path.dirname(event.telemetry_log), "hive-state.json") : null),
    $ts: event.ts || new Date().toISOString(),
  };
}

export function rowToEvent(row: any): HiveTelemetryEvent {
  let payload = {};
  try { payload = JSON.parse(row.payload_json || "{}"); } catch { /* ignore */ }
  return {
    event_id: row.event_id,
    session_id: row.session_id,
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    actor: row.actor,
    pid: row.pid,
    cwd: row.cwd,
    telemetry_log: row.telemetry_log,
    payload,
  };
}

// The events table's rowid is a global monotonic cursor: it doubles as the SSE
// resume token, so reconnect catch-up is exact (B5). rowToEvent enriches with
// it when present.
function rowToEventWithCursor(row: any): HiveTelemetryEvent & { cursor: number } {
  return { ...rowToEvent(row), cursor: Number(row.rowid) };
}

const EVENT_COLS = `rowid, event_id, session_id, seq, ts, type, actor, pid, cwd, telemetry_log, payload_json`;

// Paginated, cursor-ordered event reads (B5). Replaces the boot-time
// load-everything-into-memory path. `after` is an events.rowid; results are
// ordered by rowid so the cursor is stable across restarts.
export interface EventQuery { session?: string; cwd?: string; type?: string; after?: number; before?: number; limit?: number; }

export function queryEvents(q: EventQuery): Array<HiveTelemetryEvent & { cursor: number }> {
  const where: string[] = [];
  const params: any = {};
  if (q.after != null) { where.push(`rowid > $after`); params.$after = q.after; }
  // `before` pages BACKWARD (older events, K7): take the highest rowids below the
  // anchor by ordering DESC + LIMIT, then re-sort ascending so the returned page
  // is chronological like every other read. Bounded by the same limit clamp.
  if (q.before != null) { where.push(`rowid < $before`); params.$before = q.before; }
  if (q.session) { where.push(`session_id = $session`); params.$session = q.session; }
  if (q.cwd) { where.push(`cwd = $cwd`); params.$cwd = q.cwd; }
  if (q.type) { where.push(`type = $type`); params.$type = q.type; }
  const limit = Math.min(Math.max(1, q.limit || 1000), 5000);
  params.$limit = limit;
  const order = q.before != null ? "DESC" : "ASC";
  const rows = db.query(
    `SELECT ${EVENT_COLS} FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid ${order} LIMIT $limit`,
  ).all(params) as any[];
  if (q.before != null) rows.reverse(); // return chronological regardless of paging direction
  return rows.map(rowToEventWithCursor);
}

// The most recent N events by cursor (initial page load, newest first re-sorted
// ascending for the client's append model).
export function recentEvents(limit: number, filter: { session?: string; cwd?: string } = {}): Array<HiveTelemetryEvent & { cursor: number }> {
  const where: string[] = [];
  const params: any = { $limit: Math.min(Math.max(1, limit), 5000) };
  if (filter.session) { where.push(`session_id = $session`); params.$session = filter.session; }
  if (filter.cwd) { where.push(`cwd = $cwd`); params.$cwd = filter.cwd; }
  const rows = db.query(
    `SELECT ${EVENT_COLS} FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid DESC LIMIT $limit`,
  ).all(params) as any[];
  return rows.map(rowToEventWithCursor).reverse();
}

export function maxEventCursor(): number {
  const row = db.query(`SELECT MAX(rowid) AS m FROM events`).get() as any;
  return Number(row?.m || 0);
}

export function loadPersistedStates(): HiveStateSnapshot[] {
  const stateRows = db.query(`SELECT state_json FROM states`).all() as any[];
  const states: HiveStateSnapshot[] = [];
  for (const row of stateRows) {
    try {
      const snapshot = JSON.parse(row.state_json || "{}") as HiveStateSnapshot;
      if (snapshot.session_id) states.push(snapshot);
    } catch { /* ignore */ }
  }
  return states;
}

export function deleteSessionRows(ids: string[]): void {
  const tx = db.transaction((list: string[]) => {
    for (const id of list) {
      deleteEventsStmt.run({ $id: id });
      deleteStateStmt.run({ $id: id });
      deleteDelegationsStmt.run({ $id: id });
      deleteToolCallsStmt.run({ $id: id });
      deleteMessagesStmt.run({ $id: id });
      deleteIngestSourcesStmt.run({ $id: id });
      deleteSessionStmt.run({ $id: id });
    }
  });
  tx(ids);
}

// ── Incremental-ingest offsets (B4) ──────────────────────────────────────────

const upsertIngestSourceStmt = db.query(`
  INSERT INTO ingest_sources (path, session_id, offset, updated_at)
  VALUES ($path, $session_id, $offset, $updated_at)
  ON CONFLICT(path) DO UPDATE SET
    session_id = COALESCE(excluded.session_id, ingest_sources.session_id),
    offset = excluded.offset,
    updated_at = excluded.updated_at
`);

export function getIngestOffset(sourcePath: string): number {
  const row = db.query(`SELECT offset FROM ingest_sources WHERE path = $path`).get({ $path: sourcePath }) as any;
  return Number(row?.offset || 0);
}

export function setIngestOffset(sourcePath: string, offset: number, sessionId: string | undefined, updatedAt: string): void {
  upsertIngestSourceStmt.run({ $path: sourcePath, $session_id: sessionId ?? null, $offset: offset, $updated_at: updatedAt });
}

// ── Typed projections: delegations / tool_calls / messages (B3) ───────────────

const insertDelegationStartStmt = db.query(`
  INSERT INTO delegations (event_id, session_id, cwd, agent, parent, started_at, model)
  VALUES ($event_id, $session_id, $cwd, $agent, $parent, $started_at, $model)
  ON CONFLICT(event_id) DO NOTHING
`);

// A delegation_end is a distinct event_id from its start, so end completes the
// row keyed by (session_id, agent, latest open start). We match on the most
// recent start row for the agent that has no ended_at yet.
const completeDelegationStmt = db.query(`
  UPDATE delegations SET
    ended_at = $ended_at,
    duration_ms = $duration_ms,
    input_tokens = $input_tokens,
    output_tokens = $output_tokens,
    cache_read_tokens = $cache_read_tokens,
    cache_write_tokens = $cache_write_tokens,
    cost_usd = $cost_usd,
    status = $status,
    stop_reason = $stop_reason,
    parent = COALESCE($parent, parent),
    model = COALESCE($model, model)
  WHERE event_id = (
    SELECT event_id FROM delegations
    WHERE session_id = $session_id AND agent = $agent AND ended_at IS NULL
    ORDER BY started_at DESC LIMIT 1
  )
`);

// Fallback: a delegation_end with no matching open start (start lost/pruned)
// inserts a standalone completed row keyed by its own event_id.
const insertDelegationEndStmt = db.query(`
  INSERT INTO delegations
    (event_id, session_id, cwd, agent, parent, ended_at, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, status, stop_reason, model)
  VALUES
    ($event_id, $session_id, $cwd, $agent, $parent, $ended_at, $duration_ms, $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens, $cost_usd, $status, $stop_reason, $model)
  ON CONFLICT(event_id) DO NOTHING
`);

const insertToolStartStmt = db.query(`
  INSERT INTO tool_calls (event_id, session_id, cwd, agent, tool_name, tool_call_id, args_preview, started_at)
  VALUES ($event_id, $session_id, $cwd, $agent, $tool_name, $tool_call_id, $args_preview, $started_at)
  ON CONFLICT(event_id) DO NOTHING
`);

const completeToolStmt = db.query(`
  UPDATE tool_calls SET
    result_preview = $result_preview,
    is_error = $is_error,
    ended_at = $ended_at,
    duration_ms = COALESCE($duration_ms, duration_ms)
  WHERE session_id = $session_id AND tool_call_id = $tool_call_id
`);

const insertMessageStmt = db.query(`
  INSERT INTO messages (event_id, session_id, cwd, role, agent, text, truncated, ts)
  VALUES ($event_id, $session_id, $cwd, $role, $agent, $text, $truncated, $ts)
  ON CONFLICT(event_id) DO NOTHING
`);

export function materializeDelegationStart(input: { eventId: string; sessionId: string; cwd?: string; agent?: string; parent?: string; startedAt: string; model?: string }): void {
  insertDelegationStartStmt.run({
    $event_id: input.eventId, $session_id: input.sessionId, $cwd: input.cwd ?? null,
    $agent: input.agent ?? null, $parent: input.parent ?? null, $started_at: input.startedAt, $model: input.model ?? null,
  });
}

export function materializeDelegationEnd(input: {
  eventId: string; sessionId: string; cwd?: string; agent?: string; parent?: string; endedAt: string; durationMs?: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; status?: string; stopReason?: string; model?: string;
}): void {
  const params = {
    $event_id: input.eventId, $session_id: input.sessionId, $cwd: input.cwd ?? null, $agent: input.agent ?? null,
    $parent: input.parent ?? null, $ended_at: input.endedAt, $duration_ms: input.durationMs ?? null,
    $input_tokens: input.inputTokens, $output_tokens: input.outputTokens,
    $cache_read_tokens: input.cacheReadTokens, $cache_write_tokens: input.cacheWriteTokens,
    $cost_usd: input.costUsd, $status: input.status ?? null, $stop_reason: input.stopReason ?? null, $model: input.model ?? null,
  };
  const res = completeDelegationStmt.run(params);
  if (res.changes === 0) insertDelegationEndStmt.run(params);
}

export function materializeToolStart(input: { eventId: string; sessionId: string; cwd?: string; agent?: string; toolName?: string; toolCallId?: string; argsPreview?: string; startedAt: string }): void {
  insertToolStartStmt.run({
    $event_id: input.eventId, $session_id: input.sessionId, $cwd: input.cwd ?? null, $agent: input.agent ?? null,
    $tool_name: input.toolName ?? null, $tool_call_id: input.toolCallId ?? null, $args_preview: input.argsPreview ?? null, $started_at: input.startedAt,
  });
}

export function materializeToolEnd(input: { sessionId: string; toolCallId?: string; resultPreview?: string; isError: boolean; endedAt: string; durationMs?: number }): void {
  if (!input.toolCallId) return;
  completeToolStmt.run({
    $session_id: input.sessionId, $tool_call_id: input.toolCallId, $result_preview: input.resultPreview ?? null,
    $is_error: input.isError ? 1 : 0, $ended_at: input.endedAt, $duration_ms: input.durationMs ?? null,
  });
}

export function materializeMessage(input: { eventId: string; sessionId: string; cwd?: string; role?: string; agent?: string; text?: string; truncated: boolean; ts: string }): void {
  insertMessageStmt.run({
    $event_id: input.eventId, $session_id: input.sessionId, $cwd: input.cwd ?? null, $role: input.role ?? null,
    $agent: input.agent ?? null, $text: input.text ?? null, $truncated: input.truncated ? 1 : 0, $ts: input.ts,
  });
}

export function queryDelegations(q: { session?: string; cwd?: string; after?: number; limit?: number }): any[] {
  const where: string[] = ["ended_at IS NOT NULL"];
  const params: any = { $limit: Math.min(Math.max(1, q.limit || 1000), 5000) };
  if (q.session) { where.push(`session_id = $session`); params.$session = q.session; }
  if (q.cwd) { where.push(`cwd = $cwd`); params.$cwd = q.cwd; }
  if (q.after != null) { where.push(`rowid > $after`); params.$after = q.after; }
  const rows = db.query(`SELECT rowid, * FROM delegations WHERE ${where.join(" AND ")} ORDER BY rowid ASC LIMIT $limit`).all(params) as any[];
  return rows.map((r) => ({
    cursor: Number(r.rowid), sessionId: r.session_id, cwd: r.cwd, agent: r.agent, parent: r.parent,
    startedAt: r.started_at, endedAt: r.ended_at, durationMs: r.duration_ms,
    inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens,
    costUsd: r.cost_usd, status: r.status, stopReason: r.stop_reason, model: r.model,
  }));
}

export function queryToolCalls(q: { session?: string; after?: number; limit?: number }): any[] {
  const where: string[] = [];
  const params: any = { $limit: Math.min(Math.max(1, q.limit || 1000), 5000) };
  if (q.session) { where.push(`session_id = $session`); params.$session = q.session; }
  if (q.after != null) { where.push(`rowid > $after`); params.$after = q.after; }
  const rows = db.query(`SELECT rowid, * FROM tool_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid ASC LIMIT $limit`).all(params) as any[];
  return rows.map((r) => ({
    cursor: Number(r.rowid), sessionId: r.session_id, cwd: r.cwd, agent: r.agent, toolName: r.tool_name, toolCallId: r.tool_call_id,
    argsPreview: r.args_preview, resultPreview: r.result_preview, isError: !!r.is_error, startedAt: r.started_at, endedAt: r.ended_at, durationMs: r.duration_ms,
  }));
}

// ── SQL-backed session summaries (B2) ─────────────────────────────────────────

export function querySessionSummaries(): any[] {
  const rows = db.query(`
    SELECT session_id, cwd, session_dir, telemetry_log, first_ts, last_ts, event_count,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, topology_hash
    FROM sessions
    ORDER BY last_ts DESC
  `).all() as any[];
  return rows;
}

export function knownCwds(): string[] {
  const rows = db.query(`SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL`).all() as any[];
  return rows.map((r) => r.cwd);
}

// ── Storage breakdown (prune preview) ─────────────────────────────────────────

export interface StorageBreakdown {
  // Logical content bytes (sum of stored text: event payloads + projection text).
  // This is what the telemetry itself occupies; the physical .db file is larger
  // (indexes + SQLite free pages) and shrinks only after prune + vacuum.
  bytes: number;
  events: number;
  sessions: number;
  // What a prune at `cutoffIso` would remove and leave, in the same units. Null
  // when no cutoff was supplied.
  prune?: { removeBytes: number; removeEvents: number; removeSessions: number; keepBytes: number; keepEvents: number };
}

// Per-scope storage usage + prune preview. `cwds` scopes to a project (which can
// span several working dirs); omit/empty for the whole DB. Read-only — it never
// mutates; the prune numbers are computed by counting, not deleting.
export function storageBreakdown(cwds: string[] | undefined, cutoffIso?: string): StorageBreakdown {
  // Build a reusable WHERE fragment + params for an optional cwd-set filter.
  const scoped = cwds && cwds.length > 0;
  const placeholders = scoped ? cwds!.map((_, i) => `$c${i}`).join(",") : "";
  const cwdParams: Record<string, string> = {};
  if (scoped) cwds!.forEach((c, i) => { cwdParams[`$c${i}`] = c; });
  const cwdWhere = scoped ? `cwd IN (${placeholders})` : "1=1";

  const one = (sql: string, params: Record<string, any> = {}) => (db.query(sql).get({ ...cwdParams, ...params }) as any) || {};

  // Content bytes = event payloads + the text-heavy projection columns.
  const eventsAgg = one(`SELECT COUNT(*) AS n, COALESCE(SUM(length(payload_json)),0) AS b FROM events WHERE ${cwdWhere}`);
  const msgBytes = Number(one(`SELECT COALESCE(SUM(length(COALESCE(text,''))),0) AS b FROM messages WHERE ${cwdWhere}`).b || 0);
  const toolBytes = Number(one(`SELECT COALESCE(SUM(length(COALESCE(args_preview,'')) + length(COALESCE(result_preview,''))),0) AS b FROM tool_calls WHERE ${cwdWhere}`).b || 0);
  const bytes = Number(eventsAgg.b || 0) + msgBytes + toolBytes;
  const events = Number(eventsAgg.n || 0);
  const sessions = Number(one(`SELECT COUNT(*) AS n FROM sessions WHERE ${cwdWhere}`).n || 0);

  const out: StorageBreakdown = { bytes, events, sessions };

  if (cutoffIso) {
    // Events (and their payload bytes) older than the cutoff are trimmed.
    const rem = one(`SELECT COUNT(*) AS n, COALESCE(SUM(length(payload_json)),0) AS b FROM events WHERE ${cwdWhere} AND ts < $cutoff`, { $cutoff: cutoffIso });
    const remMsg = Number(one(`SELECT COALESCE(SUM(length(COALESCE(text,''))),0) AS b FROM messages WHERE ${cwdWhere} AND ts IS NOT NULL AND ts < $cutoff`, { $cutoff: cutoffIso }).b || 0);
    const remTool = Number(one(`SELECT COALESCE(SUM(length(COALESCE(args_preview,'')) + length(COALESCE(result_preview,''))),0) AS b FROM tool_calls WHERE ${cwdWhere} AND started_at IS NOT NULL AND started_at < $cutoff`, { $cutoff: cutoffIso }).b || 0);
    const removeBytes = Number(rem.b || 0) + remMsg + remTool;
    const removeEvents = Number(rem.n || 0);
    const removeSessions = Number(one(`SELECT COUNT(*) AS n FROM sessions WHERE ${cwdWhere} AND last_ts IS NOT NULL AND last_ts < $cutoff`, { $cutoff: cutoffIso }).n || 0);
    out.prune = {
      removeBytes, removeEvents, removeSessions,
      keepBytes: Math.max(0, bytes - removeBytes),
      keepEvents: Math.max(0, events - removeEvents),
    };
  }
  return out;
}

// ── Prune (B6): explicit, age-based cleanup on demand ─────────────────────────

export function pruneOlderThan(cutoffIso: string): { events: number; sessions: number; sessionIds: string[] } {
  let events = 0;
  const sessionsToDelete: string[] = [];
  const tx = db.transaction(() => {
    // Sessions whose entire history predates the cutoff are removed outright.
    const staleSessions = db.query(`SELECT session_id FROM sessions WHERE last_ts IS NOT NULL AND last_ts < $cutoff`).all({ $cutoff: cutoffIso }) as any[];
    for (const s of staleSessions) sessionsToDelete.push(s.session_id);
    // Older events in still-active sessions are trimmed with their projections.
    const before = db.query(`SELECT COUNT(*) AS n FROM events WHERE ts < $cutoff`).get({ $cutoff: cutoffIso }) as any;
    events = Number(before?.n || 0);
    db.run(`DELETE FROM delegations WHERE ended_at IS NOT NULL AND ended_at < $cutoff`, { $cutoff: cutoffIso } as any);
    db.run(`DELETE FROM tool_calls WHERE started_at IS NOT NULL AND started_at < $cutoff`, { $cutoff: cutoffIso } as any);
    db.run(`DELETE FROM messages WHERE ts IS NOT NULL AND ts < $cutoff`, { $cutoff: cutoffIso } as any);
    db.run(`DELETE FROM events WHERE ts < $cutoff`, { $cutoff: cutoffIso } as any);
  });
  tx();
  if (sessionsToDelete.length) deleteSessionRows(sessionsToDelete);
  // Reclaim space where auto_vacuum=INCREMENTAL is enabled (new DBs); a no-op on
  // legacy DBs created without it.
  try { db.run(`PRAGMA incremental_vacuum`); } catch { /* legacy DB: skip vacuum */ }
  return { events, sessions: sessionsToDelete.length, sessionIds: sessionsToDelete };
}

// ── Versioned topology + models (Phase C) ─────────────────────────────────────

const upsertTopologyVersionStmt = db.query(`
  INSERT INTO topology_versions (hash, cwd, topology_json, first_seen_at, last_seen_at)
  VALUES ($hash, $cwd, $topology_json, $ts, $ts)
  ON CONFLICT(hash) DO UPDATE SET
    last_seen_at = CASE WHEN excluded.last_seen_at > topology_versions.last_seen_at THEN excluded.last_seen_at ELSE topology_versions.last_seen_at END
`);

const insertTopologyNodeStmt = db.query(`
  INSERT OR IGNORE INTO topology_nodes
    (topology_hash, team, node_id, parent_id, name, role, agent_type, model, thinking, thinking_levels,
     color, group_name, tools_json, domain_json, stages_json, commit_allowed, routing_tags_json, consult_when, responsibilities_json)
  VALUES
    ($topology_hash, $team, $node_id, $parent_id, $name, $role, $agent_type, $model, $thinking, $thinking_levels,
     $color, $group_name, $tools_json, $domain_json, $stages_json, $commit_allowed, $routing_tags_json, $consult_when, $responsibilities_json)
`);

const updateNodeThinkingLevelsStmt = db.query(`
  UPDATE topology_nodes SET thinking_levels = $thinking_levels
  WHERE topology_hash = $topology_hash AND name = $name AND (thinking_levels IS NULL OR thinking_levels = '')
`);

export function topologyVersionExists(hash: string): boolean {
  return !!(db.query(`SELECT 1 FROM topology_versions WHERE hash = $hash`).get({ $hash: hash }) as any);
}

export interface TopologyNodeRow {
  topologyHash: string; team: string; nodeId: number; parentId: number | null; name: string;
  role?: string; agentType?: string; model?: string; thinking?: string; thinkingLevels?: string[];
  color?: string; group?: string; tools?: string; domain?: string[]; stages?: string[];
  commitAllowed?: boolean; routingTags?: string[]; consultWhen?: string; responsibilities?: string;
}

const countTopologyNodesStmt = db.query(`SELECT COUNT(*) AS n FROM topology_nodes WHERE topology_hash = $hash`);

// Insert a version (idempotent by hash) and explode its nodes. The whole thing
// runs in one transaction so a crash cannot leave a partial node tree behind.
// Self-healing: if the version row already exists but its node count doesn't
// match the canonical node count (e.g. a pre-fix crash left it partial), we
// re-explode with INSERT OR IGNORE to complete the tree. Callers pass the node
// rows already derived from the canonical JSON.
export function upsertTopologyVersion(input: { hash: string; cwd: string; topologyJson: string; ts: string; nodes: TopologyNodeRow[] }): void {
  const tx = db.transaction(() => {
    upsertTopologyVersionStmt.run({ $hash: input.hash, $cwd: input.cwd, $topology_json: input.topologyJson, $ts: input.ts });
    const existing = countTopologyNodesStmt.get({ $hash: input.hash }) as any;
    // Fast path: node tree already complete for this hash — nothing to explode.
    if (Number(existing?.n || 0) === input.nodes.length) return;
    for (const n of input.nodes) {
      insertTopologyNodeStmt.run({
        $topology_hash: n.topologyHash, $team: n.team, $node_id: n.nodeId, $parent_id: n.parentId,
        $name: n.name, $role: n.role ?? null, $agent_type: n.agentType ?? null, $model: n.model ?? null,
        $thinking: n.thinking ?? null, $thinking_levels: n.thinkingLevels ? JSON.stringify(n.thinkingLevels) : null,
        $color: n.color ?? null, $group_name: n.group ?? null, $tools_json: n.tools ?? null,
        $domain_json: n.domain ? JSON.stringify(n.domain) : null, $stages_json: n.stages ? JSON.stringify(n.stages) : null,
        $commit_allowed: n.commitAllowed ? 1 : 0, $routing_tags_json: n.routingTags ? JSON.stringify(n.routingTags) : null,
        $consult_when: n.consultWhen ?? null, $responsibilities_json: n.responsibilities ? JSON.stringify(n.responsibilities) : null,
      });
    }
  });
  tx();
}

// Fill in the thinking_levels sidecar for a node once authoritative levels
// arrive (delegation_start / model_catalog). Does not touch the hash (Decision 13).
export function fillNodeThinkingLevels(hash: string, name: string, levels: string[]): void {
  if (!levels?.length) return;
  updateNodeThinkingLevelsStmt.run({ $topology_hash: hash, $name: name, $thinking_levels: JSON.stringify(levels) });
}

function parseJsonMaybe(value: unknown): any {
  if (typeof value !== "string" || !value) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

function topologyNodeRow(r: any): TopologyNodeRow {
  return {
    topologyHash: r.topology_hash, team: r.team, nodeId: r.node_id, parentId: r.parent_id,
    name: r.name, role: r.role || undefined, agentType: r.agent_type || undefined, model: r.model || undefined,
    thinking: r.thinking || undefined, thinkingLevels: parseJsonMaybe(r.thinking_levels),
    color: r.color || undefined, group: r.group_name || undefined, tools: r.tools_json || undefined,
    domain: parseJsonMaybe(r.domain_json), stages: parseJsonMaybe(r.stages_json),
    commitAllowed: !!r.commit_allowed, routingTags: parseJsonMaybe(r.routing_tags_json),
    consultWhen: r.consult_when || undefined, responsibilities: parseJsonMaybe(r.responsibilities_json),
  };
}

export function topologyNodes(hash: string): TopologyNodeRow[] {
  const rows = db.query(`SELECT * FROM topology_nodes WHERE topology_hash = $hash ORDER BY team, node_id`).all({ $hash: hash }) as any[];
  return rows.map(topologyNodeRow);
}

export function listTopologies(cwd?: string): Array<{ hash: string; firstSeenAt: string; lastSeenAt: string; sessionCount: number }> {
  const params: any = {};
  const where = cwd ? `WHERE v.cwd = $cwd` : "";
  if (cwd) params.$cwd = cwd;
  const rows = db.query(`
    SELECT v.hash, v.first_seen_at, v.last_seen_at,
      (SELECT COUNT(*) FROM sessions s WHERE s.topology_hash = v.hash) AS session_count
    FROM topology_versions v ${where}
    ORDER BY v.first_seen_at ASC
  `).all(params) as any[];
  return rows.map((r) => ({ hash: r.hash, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, sessionCount: Number(r.session_count || 0) }));
}

export function topologyVersion(hash: string): { hash: string; cwd: string; topologyJson: string; firstSeenAt: string; lastSeenAt: string } | null {
  const r = db.query(`SELECT * FROM topology_versions WHERE hash = $hash`).get({ $hash: hash }) as any;
  return r ? { hash: r.hash, cwd: r.cwd, topologyJson: r.topology_json, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at } : null;
}

// States that still carry embedded topologies (pre-slim). Used by the C4 backfill.
export function statesWithEmbeddedTopologies(): Array<{ sessionId: string; cwd?: string; updatedAt: string; stateJson: string }> {
  const rows = db.query(`SELECT session_id, cwd, updated_at, state_json FROM states`).all() as any[];
  return rows.map((r) => ({ sessionId: r.session_id, cwd: r.cwd || undefined, updatedAt: r.updated_at, stateJson: r.state_json }));
}

export function rewriteStateJson(sessionId: string, stateJson: string): void {
  db.run(`UPDATE states SET state_json = $json WHERE session_id = $id`, { $json: stateJson, $id: sessionId } as any);
}

export function stampSessionTopology(sessionId: string, hash: string): void {
  db.run(`UPDATE sessions SET topology_hash = $hash WHERE session_id = $id AND (topology_hash IS NULL OR topology_hash != $hash)`, { $hash: hash, $id: sessionId } as any);
}

const insertModelVersionStmt = db.query(`
  INSERT INTO model_versions (model_hash, provider, model_id, name, api, reasoning, thinking_levels,
    context_window, max_tokens, cost_input, cost_output, cost_cache_read, cost_cache_write, first_seen_at, last_seen_at)
  VALUES ($model_hash, $provider, $model_id, $name, $api, $reasoning, $thinking_levels,
    $context_window, $max_tokens, $cost_input, $cost_output, $cost_cache_read, $cost_cache_write, $ts, $ts)
  ON CONFLICT(model_hash) DO UPDATE SET
    last_seen_at = CASE WHEN excluded.last_seen_at > model_versions.last_seen_at THEN excluded.last_seen_at ELSE model_versions.last_seen_at END
`);

export interface ModelInput {
  provider: string; modelId: string; name?: string; api?: string; reasoning: boolean; thinkingLevels: string[];
  contextWindow?: number; maxTokens?: number; costRates?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

// Content-address a model's capability set so a distinct (levels+pricing+context)
// is its own immutable version. Cost rates are part of the identity — a price
// change mints a new row rather than overwriting history.
export function modelHash(input: ModelInput): string {
  const canonical = JSON.stringify({
    provider: input.provider, modelId: input.modelId, api: input.api ?? null, reasoning: !!input.reasoning,
    thinkingLevels: input.thinkingLevels || [],
    contextWindow: input.contextWindow ?? null, maxTokens: input.maxTokens ?? null,
    cost: {
      input: input.costRates?.input ?? null, output: input.costRates?.output ?? null,
      cacheRead: input.costRates?.cacheRead ?? null, cacheWrite: input.costRates?.cacheWrite ?? null,
    },
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// Record a model capability version (idempotent by content hash). Returns the
// hash so callers (e.g. a delegation) can reference the exact version seen.
export function upsertModel(input: ModelInput, ts: string): string {
  const hash = modelHash(input);
  insertModelVersionStmt.run({
    $model_hash: hash, $provider: input.provider, $model_id: input.modelId, $name: input.name ?? null, $api: input.api ?? null,
    $reasoning: input.reasoning ? 1 : 0, $thinking_levels: JSON.stringify(input.thinkingLevels || []),
    $context_window: input.contextWindow ?? null, $max_tokens: input.maxTokens ?? null,
    $cost_input: input.costRates?.input ?? null, $cost_output: input.costRates?.output ?? null,
    $cost_cache_read: input.costRates?.cacheRead ?? null, $cost_cache_write: input.costRates?.cacheWrite ?? null, $ts: ts,
  });
  return hash;
}

function modelRow(r: any) {
  return {
    modelHash: r.model_hash, provider: r.provider, modelId: r.model_id, name: r.name || undefined, api: r.api || undefined,
    reasoning: !!r.reasoning, thinkingLevels: parseJsonMaybe(r.thinking_levels) || [],
    contextWindow: r.context_window || undefined, maxTokens: r.max_tokens || undefined,
    costRates: { input: r.cost_input, output: r.cost_output, cacheRead: r.cost_cache_read, cacheWrite: r.cost_cache_write },
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
  };
}

// Latest capability version per (provider, model_id) — the current answer for
// the UI's capability lookup (thinking dial). Pass allVersions=true for history.
export function listModels(allVersions = false): any[] {
  if (allVersions) {
    const rows = db.query(`SELECT * FROM model_versions ORDER BY provider, model_id, last_seen_at DESC`).all() as any[];
    return rows.map(modelRow);
  }
  const rows = db.query(`
    SELECT mv.* FROM model_versions mv
    JOIN (SELECT provider, model_id, MAX(last_seen_at) AS mx FROM model_versions GROUP BY provider, model_id) latest
      ON mv.provider = latest.provider AND mv.model_id = latest.model_id AND mv.last_seen_at = latest.mx
    ORDER BY mv.provider, mv.model_id
  `).all() as any[];
  return rows.map(modelRow);
}

// ── Plan-store typed tables (verdicts / approvals / comments) ────────────────

const insertPlanVerdictStmt = db.query(`
  INSERT OR IGNORE INTO plan_verdicts
    (id, change_id, reviewer, verdict, summary, evidence_json, concerns_json, blockers_json, session_id, cwd, created_at)
  VALUES
    ($id, $change_id, $reviewer, $verdict, $summary, $evidence_json, $concerns_json, $blockers_json, $session_id, $cwd, $created_at)
`);

const insertPlanApprovalStmt = db.query(`
  INSERT OR IGNORE INTO plan_approvals
    (id, change_id, phase, approved_by, actor, summary, session_id, cwd, created_at)
  VALUES
    ($id, $change_id, $phase, $approved_by, $actor, $summary, $session_id, $cwd, $created_at)
`);

const insertPlanCommentStmt = db.query(`
  INSERT OR IGNORE INTO plan_comments
    (id, change_id, file, anchor, author, body, annotation_type, original_text, session_id, cwd, created_at)
  VALUES
    ($id, $change_id, $file, $anchor, $author, $body, $annotation_type, $original_text, $session_id, $cwd, $created_at)
`);

function jsonArray(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
}

export interface PlanVerdictInput {
  id: string;
  changeId: string;
  reviewer: string;
  verdict: string;
  summary?: string;
  evidence?: unknown;
  concerns?: unknown;
  blockers?: unknown;
  sessionId?: string;
  cwd?: string;
  createdAt: string;
}

export function insertPlanVerdict(input: PlanVerdictInput): void {
  insertPlanVerdictStmt.run({
    $id: input.id,
    $change_id: input.changeId,
    $reviewer: input.reviewer,
    $verdict: input.verdict,
    $summary: input.summary ?? null,
    $evidence_json: jsonArray(input.evidence),
    $concerns_json: jsonArray(input.concerns),
    $blockers_json: jsonArray(input.blockers),
    $session_id: input.sessionId ?? null,
    $cwd: input.cwd ?? null,
    $created_at: input.createdAt,
  });
}

export interface PlanApprovalInput {
  id: string;
  changeId: string;
  phase: string;
  approvedBy: string;
  actor?: string;
  summary?: string;
  sessionId?: string;
  cwd?: string;
  createdAt: string;
}

export function insertPlanApproval(input: PlanApprovalInput): void {
  insertPlanApprovalStmt.run({
    $id: input.id,
    $change_id: input.changeId,
    $phase: input.phase,
    $approved_by: input.approvedBy,
    $actor: input.actor ?? null,
    $summary: input.summary ?? null,
    $session_id: input.sessionId ?? null,
    $cwd: input.cwd ?? null,
    $created_at: input.createdAt,
  });
}

export interface PlanCommentInput {
  id: string;
  changeId: string;
  file?: string;
  anchor?: string;
  author?: string;
  body: string;
  annotationType?: string;
  originalText?: string;
  sessionId?: string;
  cwd?: string;
  createdAt: string;
}

export function insertPlanComment(input: PlanCommentInput): void {
  insertPlanCommentStmt.run({
    $id: input.id,
    $change_id: input.changeId,
    $file: input.file ?? null,
    $anchor: input.anchor ?? null,
    $author: input.author ?? null,
    $body: input.body,
    $annotation_type: input.annotationType ?? null,
    $original_text: input.originalText ?? null,
    $session_id: input.sessionId ?? null,
    $cwd: input.cwd ?? null,
    $created_at: input.createdAt,
  });
}

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(typeof value === "string" ? value : "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function verdictRow(row: any) {
  return {
    id: row.id,
    changeId: row.change_id,
    reviewer: row.reviewer,
    verdict: row.verdict,
    summary: row.summary || "",
    evidence: parseJsonArray(row.evidence_json),
    concerns: parseJsonArray(row.concerns_json),
    blockers: parseJsonArray(row.blockers_json),
    sessionId: row.session_id || undefined,
    createdAt: row.created_at,
  };
}

// Plan reads are project-scoped by cwd (B1). NULL cwd is treated as a wildcard
// for one release so pre-migration rows (which have no cwd) stay visible. Pass
// cwd = undefined to read across all projects (legacy behavior).
function cwdFilter(cwd: string | undefined, params: any): string {
  if (!cwd) return "";
  params.$cwd = cwd;
  return ` AND (cwd = $cwd OR cwd IS NULL)`;
}

export function listVerdicts(changeId: string, cwd?: string) {
  const params: any = { $id: changeId };
  const rows = db.query(`SELECT * FROM plan_verdicts WHERE change_id = $id${cwdFilter(cwd, params)} ORDER BY created_at ASC`).all(params) as any[];
  return rows.map(verdictRow);
}

export function latestVerdict(changeId: string, cwd?: string) {
  const params: any = { $id: changeId };
  const row = db.query(`SELECT * FROM plan_verdicts WHERE change_id = $id${cwdFilter(cwd, params)} ORDER BY created_at DESC LIMIT 1`).get(params) as any;
  return row ? verdictRow(row) : null;
}

export function listApprovals(changeId: string, cwd?: string) {
  const params: any = { $id: changeId };
  const rows = db.query(`SELECT * FROM plan_approvals WHERE change_id = $id${cwdFilter(cwd, params)} ORDER BY created_at ASC`).all(params) as any[];
  return rows.map((row) => ({
    id: row.id,
    changeId: row.change_id,
    phase: row.phase,
    approvedBy: row.approved_by,
    actor: row.actor || undefined,
    summary: row.summary || "",
    sessionId: row.session_id || undefined,
    createdAt: row.created_at,
  }));
}

export function listComments(changeId: string, cwd?: string) {
  const params: any = { $id: changeId };
  const rows = db.query(`SELECT * FROM plan_comments WHERE change_id = $id${cwdFilter(cwd, params)} ORDER BY created_at ASC`).all(params) as any[];
  return rows.map((row) => ({
    id: row.id,
    changeId: row.change_id,
    file: row.file || undefined,
    anchor: row.anchor || undefined,
    author: row.author || undefined,
    body: row.body,
    annotationType: row.annotation_type || undefined,
    originalText: row.original_text || undefined,
    sessionId: row.session_id || undefined,
    createdAt: row.created_at,
  }));
}

// ── project display-name overrides ───────────────────────────────────────────

const upsertProjectOverrideStmt = db.query(`
  INSERT INTO project_overrides (cwd, label, updated_at)
  VALUES ($cwd, $label, $updated_at)
  ON CONFLICT(cwd) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at
`);
const deleteProjectOverrideStmt = db.query(`DELETE FROM project_overrides WHERE cwd = $cwd`);

export function listProjectOverrides(): Array<{ cwd: string; label: string; updatedAt?: string }> {
  const rows = db.query(`SELECT cwd, label, updated_at FROM project_overrides`).all() as any[];
  return rows.map((r) => ({ cwd: r.cwd, label: r.label, updatedAt: r.updated_at || undefined }));
}

export function setProjectOverride(cwd: string, label: string, updatedAt: string) {
  upsertProjectOverrideStmt.run({ $cwd: cwd, $label: label, $updated_at: updatedAt });
}

export function clearProjectOverride(cwd: string) {
  deleteProjectOverrideStmt.run({ $cwd: cwd });
}
