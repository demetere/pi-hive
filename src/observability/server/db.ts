import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB_PATH } from "./config";
import type { HiveStateSnapshot, HiveTelemetryEvent, JsonRecord } from "../../shared/telemetry";
import { tryResolveProjectIdentity } from "../../shared/project-identity";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
fs.chmodSync(path.dirname(DB_PATH), 0o700);
const isNewDb = !fs.existsSync(DB_PATH) || fs.statSync(DB_PATH).size === 0;
export const db = new Database(DB_PATH);
try { fs.chmodSync(DB_PATH, 0o600); } catch { /* created lazily on first write */ }
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 5000");
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try { fs.chmodSync(file, 0o600); } catch { /* SQLite may create sidecars lazily */ }
}
// Enable incremental auto-vacuum on fresh DBs so the prune action (B6) can
// reclaim space via PRAGMA incremental_vacuum. Legacy DBs keep their existing
// vacuum mode (switching would require a full rewrite) and skip vacuuming.
if (isNewDb) db.run("PRAGMA auto_vacuum = INCREMENTAL");
db.run(`
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT,
  canonical_root TEXT,
  cwd TEXT,
  session_dir TEXT,
  telemetry_log TEXT,
  conversation_log TEXT,
  state_file TEXT,
  first_ts TEXT,
  last_ts TEXT,
  -- "events ever ingested" for this session — a monotonic counter bumped +1 per
  -- ingest. It is NOT decremented by prune, and replay's pruned-history check
  -- relies on that: a fetched-count shortfall vs this value means older events
  -- were trimmed. Do not repurpose it as a live/remaining-rows count.
  event_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  -- verified = entirely event-derived; legacy-unverified = includes a one-time
  -- floor captured from pre-projection snapshots whose overlap is unknowable.
  usage_status TEXT NOT NULL DEFAULT 'verified',
  topology_hash TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT,
  seq INTEGER,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT,
  pid INTEGER,
  cwd TEXT,
  telemetry_log TEXT,
  -- JSONB BLOB (SQLite has no JSONB column type; jsonb() produces a BLOB). Reads
  -- go through json() which decodes both new BLOBs and legacy TEXT-JSON rows.
  payload_json BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hive_events_session_seq ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_hive_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_hive_events_type ON events(type);
-- cwd-filtered paging (queryEvents/recentEvents) orders by rowid; a plain cwd
-- index carries rowid as its implicit trailing key, so the WHERE seek and the
-- ORDER BY rowid are both served without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_hive_events_cwd ON events(cwd);
CREATE TABLE IF NOT EXISTS states (
  session_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  project_id TEXT,
  canonical_root TEXT,
  cwd TEXT,
  session_dir TEXT,
  telemetry_log TEXT,
  state_json BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_verdicts (
  id            TEXT PRIMARY KEY,
  change_id     TEXT NOT NULL,
  reviewer      TEXT NOT NULL,
  verdict       TEXT NOT NULL,
  summary       TEXT,
  evidence_json BLOB,
  concerns_json BLOB,
  blockers_json BLOB,
  session_id    TEXT,
  project_id    TEXT,
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
  project_id   TEXT,
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
  project_id   TEXT,
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
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  status TEXT,
  stop_reason TEXT,
  model TEXT,
  -- 0 = legacy cumulative (session-lifetime) token/cost values; 1 = per-run
  -- deltas (Decision 1). Never SUM across the two: aggregations filter >= 1.
  schema_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_delegations_session ON delegations(session_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_delegations_cwd ON delegations(cwd, ended_at);
-- Additive usage ledger. Every authoritative worker delta and orchestrator
-- message is recorded once by event_id. accounted=0 rows were backfilled at
-- the legacy cutover and are represented by the session's captured floor; new
-- rows are accounted directly and make the SQL session totals monotonic.
CREATE TABLE IF NOT EXISTS usage_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  source TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  accounted INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_id, ts);
CREATE TABLE IF NOT EXISTS schema_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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
-- The messages typed table was dropped in Phase 2.2 (nothing read it). Raw
-- user_message/assistant_message rows still live in the events table, so message
-- history remains queryable/backfillable from there.

-- Incremental-ingest byte offsets so boot resumes each JSONL where it left off
-- instead of replaying from 0 (B4). Persisted in the same transaction as the
-- batch it covers.
CREATE TABLE IF NOT EXISTS ingest_sources (
  path TEXT PRIMARY KEY,
  session_id TEXT,
  offset INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  device INTEGER,
  inode INTEGER,
  checkpoint TEXT,
  last_successful_ingest TEXT
);

-- Versioned topology (Phase C). One immutable row per unique team configuration,
-- keyed by content hash; sessions reference the hash they ran under.
CREATE TABLE IF NOT EXISTS topology_versions (
  hash          TEXT PRIMARY KEY,
  cwd           TEXT NOT NULL,
  topology_json BLOB NOT NULL,
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
  agent_type      TEXT,
  model           TEXT,
  thinking        TEXT,
  thinking_levels BLOB,
  color           TEXT,
  group_name      TEXT,
  -- tools_json holds a raw comma-string (not JSON), so it stays TEXT and is
  -- excluded from the JSONB migration (see the write/read paths).
  tools_json      TEXT,
  domain_json     BLOB,
  stages_json     BLOB,
  commit_allowed  INTEGER NOT NULL DEFAULT 0,
  routing_tags_json BLOB,
  consult_when    TEXT,
  responsibilities_json BLOB,
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
  thinking_levels BLOB NOT NULL,
  context_window  INTEGER,
  max_tokens      INTEGER,
  cost_input REAL, cost_output REAL, cost_cache_read REAL, cost_cache_write REAL,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_versions_model ON model_versions(provider, model_id, last_seen_at);
`);

// Per-project display-name overrides are keyed by canonical project identity;
// cwd remains telemetry detail and is never an authority or grouping key.
db.run(`
CREATE TABLE IF NOT EXISTS project_overrides (
  project_id TEXT PRIMARY KEY,
  canonical_root TEXT,
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
try { db.run(`ALTER TABLE sessions ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE sessions ADD COLUMN usage_status TEXT NOT NULL DEFAULT 'verified'`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE sessions ADD COLUMN topology_hash TEXT`); } catch { /* column already exists */ }
// Canonical project identity. Legacy rows are backfilled below from their cwd;
// malformed or vanished roots remain NULL and therefore cannot be targeted by a
// project-id mutation.
try { db.run(`ALTER TABLE sessions ADD COLUMN project_id TEXT`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE sessions ADD COLUMN canonical_root TEXT`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE events ADD COLUMN project_id TEXT`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE states ADD COLUMN project_id TEXT`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE states ADD COLUMN canonical_root TEXT`); } catch { /* column already exists */ }
for (const table of ["plan_verdicts", "plan_approvals", "plan_comments"] as const) {
  try { db.run(`ALTER TABLE ${table} ADD COLUMN project_id TEXT`); } catch { /* column already exists */ }
}
try { db.run(`ALTER TABLE project_overrides ADD COLUMN project_id TEXT`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE project_overrides ADD COLUMN canonical_root TEXT`); } catch { /* column already exists */ }
// Decision 1: delegations token/cost columns became PER-RUN DELTAS. Legacy rows
// written before this migration hold session-lifetime CUMULATIVE values, so they
// must never be summed alongside deltas. schema_version defaults to 0 (legacy);
// the delta producer stamps 1. Every aggregation of delegation token/cost rows
// MUST filter `schema_version >= 1`.
try { db.run(`ALTER TABLE delegations ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }
// Phase 4.8: reasoning ("thinking") tokens per delegation run.
try { db.run(`ALTER TABLE delegations ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }
// T08: persist the file identity beside its committed newline offset so a
// rotated path is replayed from byte zero even across daemon restarts.
try { db.run(`ALTER TABLE ingest_sources ADD COLUMN device INTEGER`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE ingest_sources ADD COLUMN inode INTEGER`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE ingest_sources ADD COLUMN checkpoint TEXT`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE ingest_sources ADD COLUMN last_successful_ingest TEXT`); } catch { /* column already exists */ }
// Phase 2.5: drop the unused (session_id, ts, seq) events index — no query
// orders by (session_id, ts); session-filtered reads order by rowid and are
// served by idx_hive_events_session_seq. Dropping frees write/space overhead.
try { db.run(`DROP INDEX IF EXISTS idx_hive_events_session_ts`); } catch { /* best-effort */ }

// The cwd composite indexes are created HERE, after the ALTER TABLE migrations
// above — on a legacy DB the plan_* tables predate the cwd column, so an index
// referencing cwd inside the CREATE-block would fail ("no such column: cwd").
db.run(`
CREATE INDEX IF NOT EXISTS idx_plan_verdicts_cwd ON plan_verdicts(cwd, change_id, created_at);
CREATE INDEX IF NOT EXISTS idx_plan_approvals_cwd ON plan_approvals(cwd, change_id, created_at);
CREATE INDEX IF NOT EXISTS idx_plan_comments_cwd ON plan_comments(cwd, change_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_events_project_id ON events(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_overrides_project_id ON project_overrides(project_id);
`);

function tableHasColumn(table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export function backfillProjectIdentities(): void {
  const sessions = db.query(`SELECT session_id, cwd FROM sessions WHERE project_id IS NULL AND cwd IS NOT NULL`).all() as Array<{ session_id: string; cwd: string }>;
  for (const row of sessions) {
    const identity = tryResolveProjectIdentity(row.cwd);
    if (!identity) continue;
    const params = { $session_id: row.session_id, $project_id: identity.projectId, $canonical_root: identity.canonicalRoot };
    db.run(`UPDATE sessions SET project_id = $project_id, canonical_root = $canonical_root WHERE session_id = $session_id`, params as any);
    db.run(`UPDATE events SET project_id = $project_id WHERE session_id = $session_id AND project_id IS NULL`, params as any);
    db.run(`UPDATE states SET project_id = $project_id, canonical_root = $canonical_root WHERE session_id = $session_id AND project_id IS NULL`, params as any);
    for (const table of ["plan_verdicts", "plan_approvals", "plan_comments"] as const) {
      db.run(`UPDATE ${table} SET project_id = $project_id WHERE session_id = $session_id AND project_id IS NULL`, params as any);
    }
  }

  // Backfill orphaned telemetry/approval rows that have cwd but no resolvable
  // session link. This keeps legacy data scoped without treating basename labels
  // as authority.
  for (const table of ["events", "states", "plan_verdicts", "plan_approvals", "plan_comments"] as const) {
    const roots = db.query(`SELECT DISTINCT cwd FROM ${table} WHERE project_id IS NULL AND cwd IS NOT NULL`).all() as Array<{ cwd: string }>;
    for (const row of roots) {
      const identity = tryResolveProjectIdentity(row.cwd);
      if (!identity) continue;
      db.run(`UPDATE ${table} SET project_id = $project_id WHERE cwd = $cwd AND project_id IS NULL`, {
        $project_id: identity.projectId, $cwd: row.cwd,
      } as any);
      if (table === "states") {
        db.run(`UPDATE states SET canonical_root = $canonical_root WHERE cwd = $cwd AND canonical_root IS NULL`, {
          $canonical_root: identity.canonicalRoot, $cwd: row.cwd,
        } as any);
      }
    }
  }

  // Old override tables were keyed by cwd. Preserve their labels under the new
  // canonical identity key; when multiple cwd rows resolve to one Git root, the
  // most recently updated label wins deterministically.
  if (tableHasColumn("project_overrides", "cwd")) {
    const overrides = db.query(`SELECT rowid, cwd, label, updated_at FROM project_overrides WHERE project_id IS NULL AND cwd IS NOT NULL ORDER BY COALESCE(updated_at, ''), rowid`).all() as Array<{ rowid: number; cwd: string; label: string; updated_at: string | null }>;
    for (const row of overrides) {
      const identity = tryResolveProjectIdentity(row.cwd);
      if (!identity) continue;
      const existing = db.query(`SELECT rowid FROM project_overrides WHERE project_id = $project_id`).get({ $project_id: identity.projectId }) as { rowid: number } | null;
      if (existing && existing.rowid !== row.rowid) {
        db.run(`UPDATE project_overrides SET label = $label, canonical_root = $canonical_root, updated_at = $updated_at WHERE rowid = $rowid`, {
          $label: row.label, $canonical_root: identity.canonicalRoot, $updated_at: row.updated_at, $rowid: existing.rowid,
        } as any);
        db.run(`DELETE FROM project_overrides WHERE rowid = $rowid`, { $rowid: row.rowid } as any);
      } else {
        db.run(`UPDATE project_overrides SET project_id = $project_id, canonical_root = $canonical_root WHERE rowid = $rowid`, {
          $project_id: identity.projectId, $canonical_root: identity.canonicalRoot, $rowid: row.rowid,
        } as any);
      }
    }
  }
}
backfillProjectIdentities();

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
    (event_id, session_id, project_id, seq, ts, type, actor, pid, cwd, telemetry_log, payload_json)
  VALUES
    ($event_id, $session_id, $project_id, $seq, $ts, $type, $actor, $pid, $cwd, $telemetry_log, jsonb($payload_json))
`);

// Per-event session upsert. event_count uses arithmetic (+1) instead of the old
// correlated (SELECT COUNT(*) …) subquery — the latter made boot replay of a
// long JSONL quadratic. Callers MUST run this only for genuinely new events
// (behind the INSERT-OR-IGNORE dup check) so the increment stays accurate.
export const upsertSession = db.query(`
  INSERT INTO sessions
    (session_id, project_id, canonical_root, cwd, session_dir, telemetry_log, conversation_log, state_file, first_ts, last_ts, event_count)
  VALUES
    ($session_id, $project_id, $canonical_root, $cwd, $session_dir, $telemetry_log, $conversation_log, $state_file, $ts, $ts, 1)
  ON CONFLICT(session_id) DO UPDATE SET
    project_id = COALESCE(excluded.project_id, sessions.project_id),
    canonical_root = COALESCE(excluded.canonical_root, sessions.canonical_root),
    cwd = COALESCE(excluded.cwd, sessions.cwd),
    session_dir = COALESCE(excluded.session_dir, sessions.session_dir),
    telemetry_log = COALESCE(excluded.telemetry_log, sessions.telemetry_log),
    conversation_log = COALESCE(excluded.conversation_log, sessions.conversation_log),
    state_file = COALESCE(excluded.state_file, sessions.state_file),
    first_ts = CASE WHEN sessions.first_ts IS NULL OR excluded.first_ts < sessions.first_ts THEN excluded.first_ts ELSE sessions.first_ts END,
    last_ts = CASE WHEN sessions.last_ts IS NULL OR excluded.last_ts > sessions.last_ts THEN excluded.last_ts ELSE sessions.last_ts END,
    event_count = sessions.event_count + 1
`);

// Snapshot ingestion updates liveness/topology metadata only. Historical usage
// is projected from additive usage_events and must never be overwritten by an
// active runtime snapshot (fresh runs and mode switches can legitimately carry
// smaller counters than earlier completed runs).
export const updateSessionStats = db.query(`
  UPDATE sessions SET
    topology_hash = COALESCE($topology_hash, topology_hash),
    last_ts = CASE WHEN last_ts IS NULL OR $updated_at > last_ts THEN $updated_at ELSE last_ts END,
    project_id = COALESCE(project_id, $project_id),
    canonical_root = COALESCE(canonical_root, $canonical_root),
    cwd = COALESCE(cwd, $cwd),
    session_dir = COALESCE(session_dir, $session_dir),
    telemetry_log = COALESCE(telemetry_log, $telemetry_log)
  WHERE session_id = $session_id
`);

// Ensure a session row exists (used before updateSessionStats when a snapshot
// arrives before any event). Bumps timestamps but not event_count.
export const ensureSession = db.query(`
  INSERT INTO sessions (session_id, project_id, canonical_root, cwd, session_dir, telemetry_log, first_ts, last_ts, event_count)
  VALUES ($session_id, $project_id, $canonical_root, $cwd, $session_dir, $telemetry_log, $ts, $ts, 0)
  ON CONFLICT(session_id) DO NOTHING
`);

export const upsertState = db.query(`
  INSERT INTO states (session_id, updated_at, project_id, canonical_root, cwd, session_dir, telemetry_log, state_json)
  VALUES ($session_id, $updated_at, $project_id, $canonical_root, $cwd, $session_dir, $telemetry_log, jsonb($state_json))
  ON CONFLICT(session_id) DO UPDATE SET
    updated_at = excluded.updated_at,
    project_id = COALESCE(excluded.project_id, states.project_id),
    canonical_root = COALESCE(excluded.canonical_root, states.canonical_root),
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
const deleteUsageEventsStmt = db.query(`DELETE FROM usage_events WHERE session_id = $id`);
const deleteIngestSourcesStmt = db.query(`DELETE FROM ingest_sources WHERE session_id = $id`);

export function dbEventRow(event: HiveTelemetryEvent) {
  const identity = event.project_id ? undefined : tryResolveProjectIdentity(event.cwd);
  return {
    $event_id: event.event_id,
    $session_id: event.session_id || "unknown",
    $project_id: event.project_id || identity?.projectId || null,
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
  const identity = event.project_id && event.project_root ? undefined : tryResolveProjectIdentity(event.cwd);
  return {
    $session_id: event.session_id || "unknown",
    $project_id: event.project_id || identity?.projectId || null,
    $canonical_root: event.project_root || identity?.canonicalRoot || null,
    $cwd: event.cwd || null,
    $session_dir: event.session_dir || null,
    $telemetry_log: event.telemetry_log || null,
    $conversation_log: event.conversation_log || null,
    $state_file: event.state_file || (event.telemetry_log ? path.join(path.dirname(event.telemetry_log), "hive-state.json") : null),
    $ts: event.ts || new Date().toISOString(),
  };
}

interface EventDbRow {
  rowid?: number;
  event_id: string;
  session_id: string;
  project_id: string | null;
  seq: number;
  ts: string;
  type: string;
  actor: string;
  pid: number;
  cwd: string | null;
  telemetry_log: string | null;
  payload_json: string;
}

type EventQueryParams = Record<string, string | number>;

export function rowToEvent(row: EventDbRow): HiveTelemetryEvent {
  let payload: JsonRecord = {};
  try {
    const parsed: unknown = JSON.parse(row.payload_json || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as JsonRecord;
  } catch { /* ignore */ }
  return {
    event_id: row.event_id,
    session_id: row.session_id,
    project_id: row.project_id || undefined,
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    actor: row.actor,
    pid: row.pid,
    cwd: row.cwd || undefined,
    telemetry_log: row.telemetry_log || undefined,
    payload,
  };
}

// The events table's rowid is a global monotonic cursor: it doubles as the SSE
// resume token, so reconnect catch-up is exact (B5). rowToEvent enriches with
// it when present.
function rowToEventWithCursor(row: EventDbRow): HiveTelemetryEvent & { cursor: number } {
  return { ...rowToEvent(row), cursor: Number(row.rowid) };
}

// json(payload_json) decodes BOTH new JSONB BLOBs and legacy TEXT-JSON rows to
// canonical TEXT, so rowToEvent's JSON.parse works uniformly across the migration.
const EVENT_COLS = `rowid, event_id, session_id, project_id, seq, ts, type, actor, pid, cwd, telemetry_log, json(payload_json) AS payload_json`;

// Paginated, cursor-ordered event reads (B5). Replaces the boot-time
// load-everything-into-memory path. `after` is an events.rowid; results are
// ordered by rowid so the cursor is stable across restarts.
export interface EventQuery { session?: string; cwd?: string; type?: string; after?: number; before?: number; through?: number; limit?: number; }

export function queryEvents(q: EventQuery): Array<HiveTelemetryEvent & { cursor: number }> {
  const where: string[] = [];
  const params: EventQueryParams = {};
  if (q.after != null) { where.push(`rowid > $after`); params.$after = q.after; }
  if (q.through != null) { where.push(`rowid <= $through`); params.$through = q.through; }
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
  const rows = db.query<EventDbRow, EventQueryParams>(
    `SELECT ${EVENT_COLS} FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid ${order} LIMIT $limit`,
  ).all(params);
  if (q.before != null) rows.reverse(); // return chronological regardless of paging direction
  return rows.map(rowToEventWithCursor);
}

// The most recent N events by cursor (initial page load, newest first re-sorted
// ascending for the client's append model).
export function recentEvents(limit: number, filter: { session?: string; cwd?: string } = {}): Array<HiveTelemetryEvent & { cursor: number }> {
  const where: string[] = [];
  const params: EventQueryParams = { $limit: Math.min(Math.max(1, limit), 5000) };
  if (filter.session) { where.push(`session_id = $session`); params.$session = filter.session; }
  if (filter.cwd) { where.push(`cwd = $cwd`); params.$cwd = filter.cwd; }
  const rows = db.query<EventDbRow, EventQueryParams>(
    `SELECT ${EVENT_COLS} FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid DESC LIMIT $limit`,
  ).all(params);
  return rows.map(rowToEventWithCursor).reverse();
}

export function maxEventCursor(): number {
  const row = db.query<{ m: number | null }, Record<string, never>>(`SELECT MAX(rowid) AS m FROM events`).get({});
  return Number(row?.m || 0);
}

export function loadPersistedStates(): HiveStateSnapshot[] {
  const stateRows = db.query<{ state_json: string }, Record<string, never>>(`SELECT json(state_json) AS state_json FROM states`).all({});
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
      deleteUsageEventsStmt.run({ $id: id });
      deleteIngestSourcesStmt.run({ $id: id });
      deleteSessionStmt.run({ $id: id });
    }
  });
  tx(ids);
}

// ── Incremental-ingest offsets (B4) ──────────────────────────────────────────

const upsertIngestSourceStmt = db.query(`
  INSERT INTO ingest_sources (path, session_id, offset, updated_at, device, inode, checkpoint, last_successful_ingest)
  VALUES ($path, $session_id, $offset, $updated_at, $device, $inode, $checkpoint, $last_successful_ingest)
  ON CONFLICT(path) DO UPDATE SET
    session_id = COALESCE(excluded.session_id, ingest_sources.session_id),
    offset = excluded.offset,
    updated_at = excluded.updated_at,
    device = COALESCE(excluded.device, ingest_sources.device),
    inode = COALESCE(excluded.inode, ingest_sources.inode),
    checkpoint = COALESCE(excluded.checkpoint, ingest_sources.checkpoint),
    last_successful_ingest = COALESCE(excluded.last_successful_ingest, ingest_sources.last_successful_ingest)
`);

export interface IngestSourceCursor {
  offset: number;
  updatedAt?: string;
  device?: number;
  inode?: number;
  checkpoint?: string;
}

export function getIngestSource(sourcePath: string): IngestSourceCursor {
  const row = db.query(`SELECT offset, last_successful_ingest, device, inode, checkpoint FROM ingest_sources WHERE path = $path`).get({ $path: sourcePath }) as any;
  return {
    offset: Number(row?.offset || 0),
    updatedAt: row?.last_successful_ingest || undefined,
    device: row?.device == null ? undefined : Number(row.device),
    inode: row?.inode == null ? undefined : Number(row.inode),
    checkpoint: row?.checkpoint || undefined,
  };
}

export function getIngestOffset(sourcePath: string): number {
  return getIngestSource(sourcePath).offset;
}

export function setIngestOffset(
  sourcePath: string,
  offset: number,
  sessionId: string | undefined,
  updatedAt: string,
  identity: { device?: number; inode?: number; checkpoint?: string } = {},
): void {
  upsertIngestSourceStmt.run({
    $path: sourcePath,
    $session_id: sessionId ?? null,
    $offset: offset,
    $updated_at: updatedAt,
    $device: identity.device ?? null,
    $inode: identity.inode ?? null,
    $checkpoint: identity.checkpoint ?? null,
    $last_successful_ingest: updatedAt,
  });
}

export function setIngestIdentity(
  sourcePath: string,
  offset: number,
  sessionId: string | undefined,
  updatedAt: string,
  identity: { device?: number; inode?: number; checkpoint?: string },
): void {
  upsertIngestSourceStmt.run({
    $path: sourcePath,
    $session_id: sessionId ?? null,
    $offset: offset,
    $updated_at: updatedAt,
    $device: identity.device ?? null,
    $inode: identity.inode ?? null,
    $checkpoint: identity.checkpoint ?? null,
    $last_successful_ingest: null,
  });
}

// ── Typed projections: delegations / tool_calls (B3) ──────────────────────────

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
    reasoning_tokens = $reasoning_tokens,
    cost_usd = $cost_usd,
    schema_version = $schema_version,
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
    (event_id, session_id, cwd, agent, parent, ended_at, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, schema_version, status, stop_reason, model)
  VALUES
    ($event_id, $session_id, $cwd, $agent, $parent, $ended_at, $duration_ms, $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens, $reasoning_tokens, $cost_usd, $schema_version, $status, $stop_reason, $model)
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

export function materializeDelegationStart(input: { eventId: string; sessionId: string; cwd?: string; agent?: string; parent?: string; startedAt: string; model?: string }): void {
  insertDelegationStartStmt.run({
    $event_id: input.eventId, $session_id: input.sessionId, $cwd: input.cwd ?? null,
    $agent: input.agent ?? null, $parent: input.parent ?? null, $started_at: input.startedAt, $model: input.model ?? null,
  });
}

export function materializeDelegationEnd(input: {
  eventId: string; sessionId: string; cwd?: string; agent?: string; parent?: string; endedAt: string; durationMs?: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens?: number; costUsd: number;
  // 0 = legacy cumulative, 1 = per-run delta (Decision 1). Producer stamps this.
  schemaVersion: number; status?: string; stopReason?: string; model?: string;
}): void {
  const params = {
    $event_id: input.eventId, $session_id: input.sessionId, $cwd: input.cwd ?? null, $agent: input.agent ?? null,
    $parent: input.parent ?? null, $ended_at: input.endedAt, $duration_ms: input.durationMs ?? null,
    $input_tokens: input.inputTokens, $output_tokens: input.outputTokens,
    $cache_read_tokens: input.cacheReadTokens, $cache_write_tokens: input.cacheWriteTokens,
    $reasoning_tokens: input.reasoningTokens ?? 0,
    $cost_usd: input.costUsd, $schema_version: input.schemaVersion,
    $status: input.status ?? null, $stop_reason: input.stopReason ?? null, $model: input.model ?? null,
  };
  const res = completeDelegationStmt.run(params);
  if (res.changes === 0) insertDelegationEndStmt.run(params);
}

interface UsageProjectionInput {
  eventId: string;
  sessionId: string;
  ts: string;
  type: string;
  payload: any;
}

const insertUsageEventStmt = db.query(`
  INSERT OR IGNORE INTO usage_events
    (event_id, session_id, ts, source, input_tokens, output_tokens, cache_read_tokens,
     cache_write_tokens, reasoning_tokens, cost_usd, accounted)
  VALUES
    ($event_id, $session_id, $ts, $source, $input_tokens, $output_tokens,
     $cache_read_tokens, $cache_write_tokens, $reasoning_tokens, $cost_usd, $accounted)
`);

const incrementSessionUsageStmt = db.query(`
  UPDATE sessions SET
    input_tokens = input_tokens + $input_tokens,
    output_tokens = output_tokens + $output_tokens,
    cache_read_tokens = cache_read_tokens + $cache_read_tokens,
    cache_write_tokens = cache_write_tokens + $cache_write_tokens,
    reasoning_tokens = reasoning_tokens + $reasoning_tokens,
    cost_usd = cost_usd + $cost_usd
  WHERE session_id = $session_id
`);

function nonnegativeUsage(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Project only additive, authoritative usage sources. Legacy delegation_end
// runtime snapshots are cumulative and intentionally excluded. Returns true
// when this event type carried a usable projection (including all-zero usage).
export function projectUsageEvent(input: UsageProjectionInput, accounted = true): boolean {
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  let usage: any;
  let source: string;
  if (input.type === "delegation_end") {
    const delta = payload.delta;
    if (Number(payload.delegationsSchema) < 1 || !delta || typeof delta !== "object") return false;
    usage = delta;
    source = "worker_delta";
  } else if (input.type === "orchestrator_message") {
    if (!payload.usage || typeof payload.usage !== "object") return false;
    usage = payload.usage;
    source = "orchestrator_message";
  } else {
    return false;
  }
  const values = {
    inputTokens: nonnegativeUsage(usage.inputTokens ?? usage.input),
    outputTokens: nonnegativeUsage(usage.outputTokens ?? usage.output),
    cacheReadTokens: nonnegativeUsage(usage.cacheReadTokens ?? usage.cacheRead),
    cacheWriteTokens: nonnegativeUsage(usage.cacheWriteTokens ?? usage.cacheWrite),
    reasoningTokens: nonnegativeUsage(usage.reasoningTokens ?? usage.reasoning),
    costUsd: nonnegativeUsage(usage.costUsd ?? usage.cost),
  };
  const inserted = insertUsageEventStmt.run({
    $event_id: input.eventId,
    $session_id: input.sessionId,
    $ts: input.ts,
    $source: source,
    $input_tokens: values.inputTokens,
    $output_tokens: values.outputTokens,
    $cache_read_tokens: values.cacheReadTokens,
    $cache_write_tokens: values.cacheWriteTokens,
    $reasoning_tokens: values.reasoningTokens,
    $cost_usd: values.costUsd,
    $accounted: accounted ? 1 : 0,
  });
  if (inserted.changes > 0 && accounted) {
    incrementSessionUsageStmt.run({
      $session_id: input.sessionId,
      $input_tokens: values.inputTokens,
      $output_tokens: values.outputTokens,
      $cache_read_tokens: values.cacheReadTokens,
      $cache_write_tokens: values.cacheWriteTokens,
      $reasoning_tokens: values.reasoningTokens,
      $cost_usd: values.costUsd,
    });
  }
  return true;
}

// One-time cutover for databases created before the event-derived projection.
// Historical authoritative rows are retained in usage_events for audit/prune,
// but marked unaccounted because they may overlap the old snapshot totals. The
// session receives the larger of the old snapshot and known-event totals as an
// explicitly unverified floor; all post-cutover rows then add monotonically.
function backfillUsageProjection(): void {
  const done = db.query(`SELECT value FROM schema_metadata WHERE key = 'usage_projection_v1'`).get() as any;
  if (done) return;
  const tx = db.transaction(() => {
    const existingSessions = db.query(`
      SELECT session_id, event_count, input_tokens, output_tokens, cache_read_tokens,
             cache_write_tokens, reasoning_tokens, cost_usd FROM sessions
    `).all() as any[];
    const events = db.query(`
      SELECT event_id, session_id, ts, type, json(payload_json) AS payload_json
      FROM events WHERE type IN ('delegation_end', 'orchestrator_message') ORDER BY rowid
    `).all() as any[];
    for (const event of events) {
      let payload: any = {};
      try { payload = JSON.parse(event.payload_json || "{}"); } catch { /* corrupt legacy payload: not verifiable */ }
      projectUsageEvent({
        eventId: event.event_id, sessionId: event.session_id, ts: event.ts,
        type: event.type, payload,
      }, false);
    }
    for (const session of existingSessions) {
      const known = db.query(`
        SELECT COALESCE(SUM(input_tokens),0) AS input_tokens,
               COALESCE(SUM(output_tokens),0) AS output_tokens,
               COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
               COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens,
               COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
               COALESCE(SUM(cost_usd),0) AS cost_usd
        FROM usage_events WHERE session_id = $session_id
      `).get({ $session_id: session.session_id }) as any;
      db.run(`
        UPDATE sessions SET
          input_tokens = $input_tokens, output_tokens = $output_tokens,
          cache_read_tokens = $cache_read_tokens, cache_write_tokens = $cache_write_tokens,
          reasoning_tokens = $reasoning_tokens, cost_usd = $cost_usd,
          usage_status = 'legacy-unverified'
        WHERE session_id = $session_id
      `, {
        $session_id: session.session_id,
        $input_tokens: Math.max(nonnegativeUsage(session.input_tokens), nonnegativeUsage(known?.input_tokens)),
        $output_tokens: Math.max(nonnegativeUsage(session.output_tokens), nonnegativeUsage(known?.output_tokens)),
        $cache_read_tokens: Math.max(nonnegativeUsage(session.cache_read_tokens), nonnegativeUsage(known?.cache_read_tokens)),
        $cache_write_tokens: Math.max(nonnegativeUsage(session.cache_write_tokens), nonnegativeUsage(known?.cache_write_tokens)),
        $reasoning_tokens: Math.max(nonnegativeUsage(session.reasoning_tokens), nonnegativeUsage(known?.reasoning_tokens)),
        $cost_usd: Math.max(nonnegativeUsage(session.cost_usd), nonnegativeUsage(known?.cost_usd)),
      } as any);
    }
    db.run(`INSERT INTO schema_metadata (key, value) VALUES ('usage_projection_v1', $value)`, {
      $value: new Date().toISOString(),
    } as any);
  });
  tx();
}
backfillUsageProjection();

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

export interface DelegationRow {
  cursor: number;
  sessionId: string;
  cwd?: string;
  agent?: string;
  parent?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd?: number;
  schemaVersion: number;
  status?: string;
  stopReason?: string;
  model?: string;
}

export function queryDelegations(q: { session?: string; cwd?: string; after?: number; limit?: number; deltasOnly?: boolean }): DelegationRow[] {
  const where: string[] = ["ended_at IS NOT NULL"];
  const params: any = { $limit: Math.min(Math.max(1, q.limit || 1000), 5000) };
  if (q.session) { where.push(`session_id = $session`); params.$session = q.session; }
  if (q.cwd) { where.push(`cwd = $cwd`); params.$cwd = q.cwd; }
  if (q.after != null) { where.push(`rowid > $after`); params.$after = q.after; }
  // Decision 1: token/cost aggregation MUST pass deltasOnly so legacy cumulative
  // rows (schema_version 0, session-lifetime values) are never summed with the
  // per-run deltas (schema_version 1). Row-level reads (Activity feed) omit it.
  if (q.deltasOnly) where.push(`schema_version >= 1`);
  const rows = db.query(`SELECT rowid, * FROM delegations WHERE ${where.join(" AND ")} ORDER BY rowid ASC LIMIT $limit`).all(params) as any[];
  return rows.map((r) => ({
    cursor: Number(r.rowid), sessionId: r.session_id, cwd: r.cwd, agent: r.agent, parent: r.parent,
    startedAt: r.started_at, endedAt: r.ended_at, durationMs: r.duration_ms,
    inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens,
    reasoningTokens: r.reasoning_tokens ?? 0,
    costUsd: r.cost_usd, schemaVersion: r.schema_version ?? 0, status: r.status, stopReason: r.stop_reason, model: r.model,
  }));
}

export interface ToolCallRow {
  cursor: number;
  sessionId: string;
  cwd?: string;
  agent?: string;
  toolName?: string;
  toolCallId?: string;
  argsPreview?: string;
  resultPreview?: string;
  isError: boolean;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

export function queryToolCalls(q: { session?: string; after?: number; limit?: number }): ToolCallRow[] {
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

// Raw snake_case session row — the caller (runtime.sessionSummaries) projects it
// into the camelCase TelemetrySessionSummary and folds in live snapshot counts.
export interface SessionSummaryRow {
  session_id: string;
  project_id: string | null;
  canonical_root: string | null;
  cwd: string | null;
  session_dir: string | null;
  telemetry_log: string | null;
  first_ts: string | null;
  last_ts: string | null;
  event_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  usage_status: string;
  topology_hash: string | null;
}

export function querySessionSummaries(options: { offset?: number; limit?: number } = {}): SessionSummaryRow[] {
  const paged = options.offset != null || options.limit != null;
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(options.limit) || 250)));
  const sql = `
    SELECT session_id, project_id, canonical_root, cwd, session_dir, telemetry_log, first_ts, last_ts, event_count,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
           cost_usd, usage_status, topology_hash
    FROM sessions
    ORDER BY last_ts DESC, session_id ASC
    ${paged ? "LIMIT $limit OFFSET $offset" : ""}
  `;
  return paged
    ? db.query(sql).all({ $limit: limit, $offset: offset }) as SessionSummaryRow[]
    : db.query(sql).all() as SessionSummaryRow[];
}

export function knownCwds(projectId?: string): string[] {
  const rows = projectId
    ? db.query(`SELECT DISTINCT cwd FROM sessions WHERE project_id = $project_id AND cwd IS NOT NULL`).all({ $project_id: projectId }) as any[]
    : db.query(`SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL`).all() as any[];
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
  const toolBytes = Number(one(`SELECT COALESCE(SUM(length(COALESCE(args_preview,'')) + length(COALESCE(result_preview,''))),0) AS b FROM tool_calls WHERE ${cwdWhere}`).b || 0);
  const bytes = Number(eventsAgg.b || 0) + toolBytes;
  const events = Number(eventsAgg.n || 0);
  const sessions = Number(one(`SELECT COUNT(*) AS n FROM sessions WHERE ${cwdWhere}`).n || 0);

  const out: StorageBreakdown = { bytes, events, sessions };

  if (cutoffIso) {
    // Events (and their payload bytes) older than the cutoff are trimmed.
    const rem = one(`SELECT COUNT(*) AS n, COALESCE(SUM(length(payload_json)),0) AS b FROM events WHERE ${cwdWhere} AND ts < $cutoff`, { $cutoff: cutoffIso });
    const remTool = Number(one(`SELECT COALESCE(SUM(length(COALESCE(args_preview,'')) + length(COALESCE(result_preview,''))),0) AS b FROM tool_calls WHERE ${cwdWhere} AND started_at IS NOT NULL AND started_at < $cutoff`, { $cutoff: cutoffIso }).b || 0);
    const removeBytes = Number(rem.b || 0) + remTool;
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
    db.run(`DELETE FROM usage_events WHERE ts < $cutoff`, { $cutoff: cutoffIso } as any);
    db.run(`DELETE FROM events WHERE ts < $cutoff`, { $cutoff: cutoffIso } as any);
    // Prune is the one operation allowed to lower historical totals. Once old
    // rows are intentionally removed, normalize every remaining usage row into
    // the projection and rebuild session totals exactly from that retained set.
    db.run(`UPDATE usage_events SET accounted = 1`);
    db.run(`
      UPDATE sessions SET
        input_tokens = COALESCE((SELECT SUM(u.input_tokens) FROM usage_events u WHERE u.session_id = sessions.session_id), 0),
        output_tokens = COALESCE((SELECT SUM(u.output_tokens) FROM usage_events u WHERE u.session_id = sessions.session_id), 0),
        cache_read_tokens = COALESCE((SELECT SUM(u.cache_read_tokens) FROM usage_events u WHERE u.session_id = sessions.session_id), 0),
        cache_write_tokens = COALESCE((SELECT SUM(u.cache_write_tokens) FROM usage_events u WHERE u.session_id = sessions.session_id), 0),
        reasoning_tokens = COALESCE((SELECT SUM(u.reasoning_tokens) FROM usage_events u WHERE u.session_id = sessions.session_id), 0),
        cost_usd = COALESCE((SELECT SUM(u.cost_usd) FROM usage_events u WHERE u.session_id = sessions.session_id), 0)
    `);
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
  VALUES ($hash, $cwd, jsonb($topology_json), $ts, $ts)
  ON CONFLICT(hash) DO UPDATE SET
    last_seen_at = CASE WHEN excluded.last_seen_at > topology_versions.last_seen_at THEN excluded.last_seen_at ELSE topology_versions.last_seen_at END
`);

const insertTopologyNodeStmt = db.query(`
  INSERT OR IGNORE INTO topology_nodes
    (topology_hash, team, node_id, parent_id, name, agent_type, model, thinking, thinking_levels,
     color, group_name, tools_json, domain_json, stages_json, commit_allowed, routing_tags_json, consult_when, responsibilities_json)
  VALUES
    ($topology_hash, $team, $node_id, $parent_id, $name, $agent_type, $model, $thinking, jsonb($thinking_levels),
     $color, $group_name, $tools_json, jsonb($domain_json), jsonb($stages_json), $commit_allowed, jsonb($routing_tags_json), $consult_when, jsonb($responsibilities_json))
`);

const updateNodeThinkingLevelsStmt = db.query(`
  UPDATE topology_nodes SET thinking_levels = jsonb($thinking_levels)
  WHERE topology_hash = $topology_hash AND name = $name AND (thinking_levels IS NULL OR thinking_levels = '')
`);

export function topologyVersionExists(hash: string): boolean {
  return !!(db.query(`SELECT 1 FROM topology_versions WHERE hash = $hash`).get({ $hash: hash }) as any);
}

export interface TopologyNodeRow {
  topologyHash: string; team: string; nodeId: number; parentId: number | null; name: string;
  agentType?: string; model?: string; thinking?: string; thinkingLevels?: string[];
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
        $name: n.name, $agent_type: n.agentType ?? null, $model: n.model ?? null,
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
    name: r.name, agentType: r.agent_type || undefined, model: r.model || undefined,
    thinking: r.thinking || undefined, thinkingLevels: parseJsonMaybe(r.thinking_levels),
    color: r.color || undefined, group: r.group_name || undefined, tools: r.tools_json || undefined,
    domain: parseJsonMaybe(r.domain_json), stages: parseJsonMaybe(r.stages_json),
    commitAllowed: !!r.commit_allowed, routingTags: parseJsonMaybe(r.routing_tags_json),
    consultWhen: r.consult_when || undefined, responsibilities: parseJsonMaybe(r.responsibilities_json),
  };
}

// Explicit column list so json() decodes the JSONB (or legacy TEXT) JSON columns
// to canonical TEXT for parseJsonMaybe. tools_json is a raw string, not JSON, so
// it is read verbatim (excluded from the JSONB migration — see the write path).
const TOPOLOGY_NODE_COLS = `topology_hash, team, node_id, parent_id, name, agent_type, model, thinking,
  json(thinking_levels) AS thinking_levels, color, group_name, tools_json,
  json(domain_json) AS domain_json, json(stages_json) AS stages_json, commit_allowed,
  json(routing_tags_json) AS routing_tags_json, consult_when, json(responsibilities_json) AS responsibilities_json`;

export function topologyNodes(hash: string): TopologyNodeRow[] {
  const rows = db.query(`SELECT ${TOPOLOGY_NODE_COLS} FROM topology_nodes WHERE topology_hash = $hash ORDER BY team, node_id`).all({ $hash: hash }) as any[];
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
  const r = db.query(`SELECT hash, cwd, json(topology_json) AS topology_json, first_seen_at, last_seen_at FROM topology_versions WHERE hash = $hash`).get({ $hash: hash }) as any;
  return r ? { hash: r.hash, cwd: r.cwd, topologyJson: r.topology_json, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at } : null;
}

// States that still carry embedded topologies (pre-slim). Used by the C4 backfill.
export function statesWithEmbeddedTopologies(): Array<{ sessionId: string; cwd?: string; updatedAt: string; stateJson: string }> {
  const rows = db.query(`SELECT session_id, cwd, updated_at, json(state_json) AS state_json FROM states`).all() as any[];
  return rows.map((r) => ({ sessionId: r.session_id, cwd: r.cwd || undefined, updatedAt: r.updated_at, stateJson: r.state_json }));
}

export function rewriteStateJson(sessionId: string, stateJson: string): void {
  db.run(`UPDATE states SET state_json = jsonb($json) WHERE session_id = $id`, { $json: stateJson, $id: sessionId } as any);
}

export function stampSessionTopology(sessionId: string, hash: string): void {
  db.run(`UPDATE sessions SET topology_hash = $hash WHERE session_id = $id AND (topology_hash IS NULL OR topology_hash != $hash)`, { $hash: hash, $id: sessionId } as any);
}

const insertModelVersionStmt = db.query(`
  INSERT INTO model_versions (model_hash, provider, model_id, name, api, reasoning, thinking_levels,
    context_window, max_tokens, cost_input, cost_output, cost_cache_read, cost_cache_write, first_seen_at, last_seen_at)
  VALUES ($model_hash, $provider, $model_id, $name, $api, $reasoning, jsonb($thinking_levels),
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

// mv-qualified so it serves both the single-table and the latest-per-model JOIN
// query. json(thinking_levels) decodes new JSONB BLOBs and legacy TEXT alike.
const MODEL_VERSION_COLS = `mv.model_hash, mv.provider, mv.model_id, mv.name, mv.api, mv.reasoning,
  json(mv.thinking_levels) AS thinking_levels, mv.context_window, mv.max_tokens,
  mv.cost_input, mv.cost_output, mv.cost_cache_read, mv.cost_cache_write, mv.first_seen_at, mv.last_seen_at`;

export interface ModelVersionRow {
  modelHash: string;
  provider: string;
  modelId: string;
  name?: string;
  api?: string;
  reasoning: boolean;
  thinkingLevels: string[];
  contextWindow?: number;
  maxTokens?: number;
  costRates: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null };
  firstSeenAt: string;
  lastSeenAt: string;
}

function modelRow(r: any): ModelVersionRow {
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
export function listModels(allVersions = false): ModelVersionRow[] {
  if (allVersions) {
    const rows = db.query(`SELECT ${MODEL_VERSION_COLS} FROM model_versions mv ORDER BY provider, model_id, last_seen_at DESC`).all() as any[];
    return rows.map(modelRow);
  }
  const rows = db.query(`
    SELECT ${MODEL_VERSION_COLS} FROM model_versions mv
    JOIN (SELECT provider, model_id, MAX(last_seen_at) AS mx FROM model_versions GROUP BY provider, model_id) latest
      ON mv.provider = latest.provider AND mv.model_id = latest.model_id AND mv.last_seen_at = latest.mx
    ORDER BY mv.provider, mv.model_id
  `).all() as any[];
  return rows.map(modelRow);
}

// ── Plan-store typed tables (verdicts / approvals / comments) ────────────────

const insertPlanVerdictStmt = db.query(`
  INSERT OR IGNORE INTO plan_verdicts
    (id, change_id, reviewer, verdict, summary, evidence_json, concerns_json, blockers_json, session_id, project_id, cwd, created_at)
  VALUES
    ($id, $change_id, $reviewer, $verdict, $summary, jsonb($evidence_json), jsonb($concerns_json), jsonb($blockers_json), $session_id, $project_id, $cwd, $created_at)
`);

const insertPlanApprovalStmt = db.query(`
  INSERT OR IGNORE INTO plan_approvals
    (id, change_id, phase, approved_by, actor, summary, session_id, project_id, cwd, created_at)
  VALUES
    ($id, $change_id, $phase, $approved_by, $actor, $summary, $session_id, $project_id, $cwd, $created_at)
`);

const insertPlanCommentStmt = db.query(`
  INSERT OR IGNORE INTO plan_comments
    (id, change_id, file, anchor, author, body, annotation_type, original_text, session_id, project_id, cwd, created_at)
  VALUES
    ($id, $change_id, $file, $anchor, $author, $body, $annotation_type, $original_text, $session_id, $project_id, $cwd, $created_at)
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
  projectId?: string;
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
    $project_id: input.projectId ?? tryResolveProjectIdentity(input.cwd)?.projectId ?? null,
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
  projectId?: string;
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
    $project_id: input.projectId ?? tryResolveProjectIdentity(input.cwd)?.projectId ?? null,
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
  projectId?: string;
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
    $project_id: input.projectId ?? tryResolveProjectIdentity(input.cwd)?.projectId ?? null,
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

export interface PlanVerdictRow {
  id: string;
  changeId: string;
  reviewer: string;
  verdict: string;
  summary: string;
  evidence: string[];
  concerns: string[];
  blockers: string[];
  sessionId?: string;
  createdAt: string;
}

function verdictRow(row: any): PlanVerdictRow {
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

// json() decodes new JSONB BLOBs and legacy TEXT-JSON alike for parseJsonArray.
const PLAN_VERDICT_COLS = `id, change_id, reviewer, verdict, summary,
  json(evidence_json) AS evidence_json, json(concerns_json) AS concerns_json, json(blockers_json) AS blockers_json,
  session_id, cwd, created_at`;

export function listVerdicts(changeId: string, cwd?: string): PlanVerdictRow[] {
  const params: any = { $id: changeId };
  const rows = db.query(`SELECT ${PLAN_VERDICT_COLS} FROM plan_verdicts WHERE change_id = $id${cwdFilter(cwd, params)} ORDER BY created_at ASC`).all(params) as any[];
  return rows.map(verdictRow);
}

export function latestVerdict(changeId: string, cwd?: string): PlanVerdictRow | null {
  const params: any = { $id: changeId };
  const row = db.query(`SELECT ${PLAN_VERDICT_COLS} FROM plan_verdicts WHERE change_id = $id${cwdFilter(cwd, params)} ORDER BY created_at DESC LIMIT 1`).get(params) as any;
  return row ? verdictRow(row) : null;
}

export interface PlanApprovalRow {
  id: string;
  changeId: string;
  phase: string;
  approvedBy: string;
  actor?: string;
  summary: string;
  sessionId?: string;
  createdAt: string;
}

export function listApprovals(changeId: string, cwd?: string): PlanApprovalRow[] {
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

export interface PlanCommentRow {
  id: string;
  changeId: string;
  file?: string;
  anchor?: string;
  author?: string;
  body: string;
  annotationType?: string;
  originalText?: string;
  sessionId?: string;
  createdAt: string;
}

export function listComments(changeId: string, cwd?: string): PlanCommentRow[] {
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
  INSERT INTO project_overrides (project_id, canonical_root, label, updated_at)
  VALUES ($project_id, $canonical_root, $label, $updated_at)
  ON CONFLICT(project_id) DO UPDATE SET
    canonical_root = excluded.canonical_root,
    label = excluded.label,
    updated_at = excluded.updated_at
`);
const deleteProjectOverrideStmt = db.query(`DELETE FROM project_overrides WHERE project_id = $project_id`);

export interface ProjectOverrideRow {
  projectId: string;
  canonicalRoot?: string;
  label: string;
  updatedAt?: string;
}

export function listProjectOverrides(): ProjectOverrideRow[] {
  const rows = db.query(`SELECT project_id, canonical_root, label, updated_at FROM project_overrides WHERE project_id IS NOT NULL`).all() as any[];
  return rows.map((r) => ({ projectId: r.project_id, canonicalRoot: r.canonical_root || undefined, label: r.label, updatedAt: r.updated_at || undefined }));
}

export function setProjectOverride(projectId: string, canonicalRoot: string | undefined, label: string, updatedAt: string) {
  upsertProjectOverrideStmt.run({ $project_id: projectId, $canonical_root: canonicalRoot ?? null, $label: label, $updated_at: updatedAt });
}

export function clearProjectOverride(projectId: string) {
  deleteProjectOverrideStmt.run({ $project_id: projectId });
}
