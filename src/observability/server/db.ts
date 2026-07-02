import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB_PATH } from "./config";
import type { HiveStateSnapshot, HiveTelemetryEvent } from "../../shared/telemetry";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
export const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 5000");
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
  event_count INTEGER NOT NULL DEFAULT 0
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
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_comments_change ON plan_comments(change_id, created_at);
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

// Lightweight migrations for existing local dashboard DBs.
try { db.run(`ALTER TABLE plan_comments ADD COLUMN annotation_type TEXT`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE plan_comments ADD COLUMN original_text TEXT`); } catch { /* column already exists */ }

export const insertEvent = db.query(`
  INSERT OR IGNORE INTO events
    (event_id, session_id, seq, ts, type, actor, pid, cwd, telemetry_log, payload_json)
  VALUES
    ($event_id, $session_id, $seq, $ts, $type, $actor, $pid, $cwd, $telemetry_log, $payload_json)
`);

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
    event_count = (SELECT COUNT(*) FROM events WHERE session_id = excluded.session_id)
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

export function loadPersistedEvents(limit: number): HiveTelemetryEvent[] {
  const eventRows = db.query(`
    SELECT event_id, session_id, seq, ts, type, actor, pid, cwd, telemetry_log, payload_json
    FROM events
    ORDER BY ts DESC
    LIMIT $limit
  `).all({ $limit: limit }) as any[];
  return eventRows.map(rowToEvent).reverse();
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
      deleteSessionStmt.run({ $id: id });
    }
  });
  tx(ids);
}

// ── Plan-store typed tables (verdicts / approvals / comments) ────────────────

const insertPlanVerdictStmt = db.query(`
  INSERT OR IGNORE INTO plan_verdicts
    (id, change_id, reviewer, verdict, summary, evidence_json, concerns_json, blockers_json, session_id, created_at)
  VALUES
    ($id, $change_id, $reviewer, $verdict, $summary, $evidence_json, $concerns_json, $blockers_json, $session_id, $created_at)
`);

const insertPlanApprovalStmt = db.query(`
  INSERT OR IGNORE INTO plan_approvals
    (id, change_id, phase, approved_by, actor, summary, session_id, created_at)
  VALUES
    ($id, $change_id, $phase, $approved_by, $actor, $summary, $session_id, $created_at)
`);

const insertPlanCommentStmt = db.query(`
  INSERT OR IGNORE INTO plan_comments
    (id, change_id, file, anchor, author, body, annotation_type, original_text, session_id, created_at)
  VALUES
    ($id, $change_id, $file, $anchor, $author, $body, $annotation_type, $original_text, $session_id, $created_at)
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

export function listVerdicts(changeId: string) {
  const rows = db.query(`SELECT * FROM plan_verdicts WHERE change_id = $id ORDER BY created_at ASC`).all({ $id: changeId }) as any[];
  return rows.map(verdictRow);
}

export function latestVerdict(changeId: string) {
  const row = db.query(`SELECT * FROM plan_verdicts WHERE change_id = $id ORDER BY created_at DESC LIMIT 1`).get({ $id: changeId }) as any;
  return row ? verdictRow(row) : null;
}

export function listApprovals(changeId: string) {
  const rows = db.query(`SELECT * FROM plan_approvals WHERE change_id = $id ORDER BY created_at ASC`).all({ $id: changeId }) as any[];
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

export function listComments(changeId: string) {
  const rows = db.query(`SELECT * FROM plan_comments WHERE change_id = $id ORDER BY created_at ASC`).all({ $id: changeId }) as any[];
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
