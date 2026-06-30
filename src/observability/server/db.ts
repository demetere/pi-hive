import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB_PATH } from "./config";

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
`);

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

export function dbEventRow(event: any) {
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

export function dbSessionRowFromEvent(event: any) {
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

export function rowToEvent(row: any) {
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

export function loadPersistedEvents(limit: number): any[] {
  const eventRows = db.query(`
    SELECT event_id, session_id, seq, ts, type, actor, pid, cwd, telemetry_log, payload_json
    FROM events
    ORDER BY ts DESC
    LIMIT $limit
  `).all({ $limit: limit }) as any[];
  return eventRows.map(rowToEvent).reverse();
}

export function loadPersistedStates(): any[] {
  const stateRows = db.query(`SELECT state_json FROM states`).all() as any[];
  const states: any[] = [];
  for (const row of stateRows) {
    try {
      const snapshot = JSON.parse(row.state_json || "{}");
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
