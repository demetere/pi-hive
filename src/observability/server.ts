import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { agentRuns, parseAgentLog } from "./agent-log";
import { isSameOriginWrite } from "./security";
import { dashboardFile, dashboardHtml } from "./static";

const PORT = Number(process.env.HIVE_TELEMETRY_PORT || 43191);
const HOST = process.env.HIVE_TELEMETRY_HOST || "127.0.0.1";
const SINGLE_LOG_PATH = process.env.HIVE_TELEMETRY_LOG || "";
const HIVE_GLOBAL_DIR = path.join(process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"), "hive");
const REGISTRY_PATH = process.env.HIVE_TELEMETRY_REGISTRY || path.join(HIVE_GLOBAL_DIR, "telemetry-sessions.jsonl");
const DB_PATH = process.env.HIVE_TELEMETRY_DB || path.join(HIVE_GLOBAL_DIR, "telemetry.db");
const CONVERSATION_LOG = process.env.HIVE_CONVERSATION_LOG || "";
const BOOT_SESSION_ID = process.env.HIVE_SESSION_ID || "global";
const PROJECT_CWD = process.env.HIVE_PROJECT_CWD || process.cwd();
const MAX_EVENTS = 20_000;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
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

const insertEvent = db.query(`
  INSERT OR IGNORE INTO events
    (event_id, session_id, seq, ts, type, actor, pid, cwd, telemetry_log, payload_json)
  VALUES
    ($event_id, $session_id, $seq, $ts, $type, $actor, $pid, $cwd, $telemetry_log, $payload_json)
`);
const upsertSession = db.query(`
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
const upsertState = db.query(`
  INSERT INTO states (session_id, updated_at, cwd, session_dir, telemetry_log, state_json)
  VALUES ($session_id, $updated_at, $cwd, $session_dir, $telemetry_log, $state_json)
  ON CONFLICT(session_id) DO UPDATE SET
    updated_at = excluded.updated_at,
    cwd = COALESCE(excluded.cwd, states.cwd),
    session_dir = COALESCE(excluded.session_dir, states.session_dir),
    telemetry_log = COALESCE(excluded.telemetry_log, states.telemetry_log),
    state_json = excluded.state_json
`);

function dbEventRow(event: any) {
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

function dbSessionRowFromEvent(event: any) {
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

type Subscriber = ReadableStreamDefaultController<Uint8Array>;
type Source = { logPath: string; offset: number; meta: Record<string, any>; statePath: string; stateMtimeMs: number };

const encoder = new TextEncoder();
const subscribers = new Set<Subscriber>();
const sources = new Map<string, Source>();
const snapshots = new Map<string, any>();
let events: any[] = [];

function addSource(logPath: string, meta: Record<string, any> = {}) {
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

function readRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) return;
  const latest = new Map<string, any>();
  const lines = fs.readFileSync(REGISTRY_PATH, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.telemetry_log) latest.set(path.resolve(row.telemetry_log), row);
    } catch { /* ignore corrupt registry rows */ }
  }
  for (const row of latest.values()) addSource(row.telemetry_log, row);
}

function readSource(logPath: string) {
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

function readState(logPath: string) {
  const source = sources.get(path.resolve(logPath));
  if (!source || !fs.existsSync(source.statePath)) return;
  let stat: fs.Stats;
  try { stat = fs.statSync(source.statePath); } catch { return; }
  if (stat.mtimeMs <= source.stateMtimeMs) return;
  source.stateMtimeMs = stat.mtimeMs;
  try {
    const snapshot = JSON.parse(fs.readFileSync(source.statePath, "utf8"));
    snapshot.telemetry_log ||= source.logPath;
    snapshot.cwd ||= source.meta.cwd;
    addSnapshot(snapshot);
  } catch { /* ignore partial snapshot writes */ }
}

function addSnapshot(snapshot: any) {
  if (!snapshot || !snapshot.session_id) return;
  snapshot.updated_at ||= new Date().toISOString();
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
  const frame = `event: hive_state\ndata: ${JSON.stringify(snapshot)}\n\n`;
  for (const sub of Array.from(subscribers)) {
    try { sub.enqueue(encoder.encode(frame)); } catch { subscribers.delete(sub); }
  }
}

function enrichEvent(event: any, source: Source) {
  event.cwd ||= source.meta.cwd;
  event.session_dir ||= source.meta.session_dir;
  event.telemetry_log ||= source.logPath;
  event.conversation_log ||= source.meta.conversation_log;
  return event;
}

function addEvent(event: any) {
  if (!event || !event.event_id) return;
  // Progress is volatile node state, not durable history. Older logs may contain
  // delegation_progress rows; ignore them so event counts/lists stay meaningful.
  if (event.type === "delegation_progress") return;
  if (events.some((existing) => existing.event_id === event.event_id)) return;
  const result = insertEvent.run(dbEventRow(event));
  upsertSession.run(dbSessionRowFromEvent(event));
  if (result.changes === 0) return;
  events.push(event);
  events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.session_id).localeCompare(String(b.session_id)) || Number(a.seq || 0) - Number(b.seq || 0));
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  const frame = `event: hive\ndata: ${JSON.stringify(event)}\n\n`;
  for (const sub of Array.from(subscribers)) {
    try { sub.enqueue(encoder.encode(frame)); } catch { subscribers.delete(sub); }
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

function rowToEvent(row: any) {
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

function loadDbIntoMemory() {
  const eventRows = db.query(`
    SELECT event_id, session_id, seq, ts, type, actor, pid, cwd, telemetry_log, payload_json
    FROM events
    ORDER BY ts DESC
    LIMIT $limit
  `).all({ $limit: MAX_EVENTS }) as any[];
  events = eventRows.map(rowToEvent).reverse();

  const stateRows = db.query(`SELECT state_json FROM states`).all() as any[];
  for (const row of stateRows) {
    try {
      const snapshot = JSON.parse(row.state_json || "{}");
      if (snapshot.session_id) snapshots.set(snapshot.session_id, snapshot);
    } catch { /* ignore */ }
  }
}

function sessionSummaries() {
  const byId = new Map<string, any>();
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
    current.first_ts = current.first_ts < event.ts ? current.first_ts : event.ts;
    current.last_ts = current.last_ts > event.ts ? current.last_ts : event.ts;
    current.event_count++;
    const rt = event.payload?.runtime;
    if (rt) {
      current.tokens = Math.max(current.tokens, Number(rt.inputTokens || 0) + Number(rt.outputTokens || 0));
      current.cost = Math.max(current.cost, Number(rt.costUsd || 0));
    }
    byId.set(id, current);
  }
  for (const snapshot of snapshots.values()) {
    const id = snapshot.session_id;
    const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
    const tokens = agents.reduce((sum: number, agent: any) => sum + Number(agent.inputTokens || 0) + Number(agent.outputTokens || 0), 0);
    const cost = agents.reduce((sum: number, agent: any) => sum + Number(agent.costUsd || 0), 0);
    const running = agents.filter((agent: any) => agent.status === "running").length;
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

const deleteEventsStmt = db.query(`DELETE FROM events WHERE session_id = $id`);
const deleteStateStmt = db.query(`DELETE FROM states WHERE session_id = $id`);
const deleteSessionStmt = db.query(`DELETE FROM sessions WHERE session_id = $id`);

// Derive the human project label from a cwd the same way the UI does, so a
// project-level delete matches exactly what the user sees grouped together.
function projectNameOf(cwd?: string): string {
  if (!cwd) return "unknown";
  const parts = String(cwd).split("/").filter(Boolean);
  if (!parts.length) return cwd;
  const last = parts[parts.length - 1], parent = parts[parts.length - 2];
  const generic = new Set(["backend", "frontend", "web", "app", "src", "api", "server", "packages"]);
  if (parts.length >= 2 && (generic.has(last) || last === parent)) return parent + " / " + last;
  return last;
}

// Rewrite the global registry file, dropping any rows for the given session ids.
function pruneRegistry(removed: Set<string>) {
  if (!fs.existsSync(REGISTRY_PATH)) return;
  const kept: string[] = [];
  for (const line of fs.readFileSync(REGISTRY_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!removed.has(row.session_id)) kept.push(line);
    } catch { kept.push(line); }
  }
  fs.writeFileSync(REGISTRY_PATH, kept.length ? kept.join("\n") + "\n" : "");
}

// Delete sessions everywhere they live: SQLite (events/states/sessions),
// in-memory caches, the live source watchers, and the registry. This only
// purges telemetry — it never touches the project's own conversation logs or
// hive-state files on disk. Returns the count actually removed.
function deleteSessions(ids: string[]): number {
  const idSet = new Set(ids.filter(Boolean));
  if (!idSet.size) return 0;
  const tx = db.transaction((list: string[]) => {
    for (const id of list) { deleteEventsStmt.run({ $id: id }); deleteStateStmt.run({ $id: id }); deleteSessionStmt.run({ $id: id }); }
  });
  tx(Array.from(idSet));

  // in-memory event list + snapshots
  events = events.filter((e) => !idSet.has(e.session_id));
  for (const id of idSet) snapshots.delete(id);

  // stop watching and drop the sources whose snapshot/log belongs to a deleted
  // session, so a recreated session id starts clean.
  for (const [abs, source] of Array.from(sources.entries())) {
    const sid = source.meta?.session_id;
    if (sid && idSet.has(sid)) {
      try { fs.unwatchFile(abs); fs.unwatchFile(source.statePath); } catch { /* noop */ }
      sources.delete(abs);
    }
  }
  pruneRegistry(idSet);

  // tell live clients to drop these sessions
  const frame = `event: hive_delete\ndata: ${JSON.stringify({ session_ids: Array.from(idSet) })}\n\n`;
  for (const sub of Array.from(subscribers)) {
    try { sub.enqueue(encoder.encode(frame)); } catch { subscribers.delete(sub); }
  }
  return idSet.size;
}

function deleteProject(name: string): number {
  const ids = sessionSummaries().filter((s) => projectNameOf(s.cwd) === name).map((s) => s.session_id);
  return deleteSessions(ids);
}


// Resolve an agent's own conversation-log file from the latest snapshot. The
// snapshot's agents[] carry the sessionFile each pi subprocess writes to.
function agentLogPath(sessionId: string, agentName: string): { file?: string; status?: string } {
  const snap = snapshots.get(sessionId);
  if (!snap || !Array.isArray(snap.agents)) return {};
  const a = snap.agents.find((x: any) => x.name === agentName);
  if (!a || !a.sessionFile) return { status: a?.status };
  return { file: a.sessionFile, status: a.status };
}

loadDbIntoMemory();
readRegistry();
if (SINGLE_LOG_PATH) addSource(SINGLE_LOG_PATH, { cwd: PROJECT_CWD, conversation_log: CONVERSATION_LOG, session_id: BOOT_SESSION_ID });
fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
fs.closeSync(fs.openSync(REGISTRY_PATH, "a"));
fs.watchFile(REGISTRY_PATH, { interval: 1000 }, readRegistry);
setInterval(() => { readRegistry(); for (const source of sources.values()) { readSource(source.logPath); readState(source.logPath); } }, 2000).unref?.();

// SSE heartbeat: send a comment line to every open stream every 15s. Without
// it, an idle /stream connection (no events for a while) gets closed by the
// browser/proxy, the client's EventSource fires `error`, and the dashboard
// flickers to "reconnecting". A comment (": ping") keeps the socket alive and
// is ignored by EventSource.
setInterval(() => {
  if (!subscribers.size) return;
  const ping = encoder.encode(": ping\n\n");
  for (const sub of Array.from(subscribers)) {
    try { sub.enqueue(ping); } catch { subscribers.delete(sub); }
  }
}, 15_000);

Bun.serve({
  hostname: HOST,
  port: PORT,
  // Disable the per-connection idle timeout. SSE (/stream) connections are
  // intentionally long-lived and silent between events; Bun's default idle
  // timeout (~10s) would otherwise close them, making the client reconnect and
  // the dashboard flicker "reconnecting". The 15s heartbeat above is the
  // secondary guard for any proxy in front of us.
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "DELETE") {
      if (!isSameOriginWrite(req, url)) return json({ error: "cross-origin write blocked" }, 403);
      // DELETE /sessions/:id  — purge one session's telemetry.
      const sessionMatch = url.pathname.match(/^\/sessions\/(.+)$/);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]);
        const deleted = deleteSessions([id]);
        return json({ ok: true, deleted, sessions: deleted });
      }
      // DELETE /projects/:name — purge every session in a project.
      const projectMatch = url.pathname.match(/^\/projects\/(.+)$/);
      if (projectMatch) {
        const name = decodeURIComponent(projectMatch[1]);
        const deleted = deleteProject(name);
        return json({ ok: true, project: name, sessions: deleted });
      }
      return json({ error: "not found" }, 404);
    }

    if (url.pathname === "/") return dashboardHtml();
    if (url.pathname.startsWith("/assets/") || url.pathname === "/favicon.ico") {
      const asset = dashboardFile(url.pathname);
      if (asset) return asset;
    }
    if (url.pathname === "/health") return json({ ok: true, mode: "global", boot_session_id: BOOT_SESSION_ID, sessions: sessionSummaries().length, events: events.length, registry: REGISTRY_PATH, db: DB_PATH, sources: Array.from(sources.keys()) });
    if (url.pathname === "/events") return json({ events });
    if (url.pathname === "/states") return json({ states: Array.from(snapshots.values()) });
    if (url.pathname === "/sessions") return json({ sessions: sessionSummaries() });
    if (url.pathname === "/stream") {
      let sub: Subscriber | undefined;
      return new Response(new ReadableStream({
        start(controller) {
          sub = controller;
          subscribers.add(controller);
          controller.enqueue(encoder.encode(`event: hello\ndata: ${JSON.stringify({ mode: "global", registry: REGISTRY_PATH })}\n\n`));
        },
        cancel() { if (sub) subscribers.delete(sub); },
      }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive", "access-control-allow-origin": "*" } });
    }
    if (url.pathname === "/conversation") return json({ path: CONVERSATION_LOG });
    if (url.pathname === "/agent-log") {
      const sessionId = url.searchParams.get("session") || "";
      const agent = url.searchParams.get("agent") || "";
      const offset = Number(url.searchParams.get("offset") || 0);
      const runId = url.searchParams.get("run") || "";
      const { file: currentFile, status } = agentLogPath(sessionId, agent);
      if (!currentFile) return json({ entries: [], offset: 0, size: 0, status: status || "unknown", exists: false, runs: [] });
      const runs = agentRuns(currentFile);
      if (!runs.length) return json({ entries: [], offset: 0, size: 0, status, exists: false, runs: [] });
      // pick the requested run, else the current/newest
      const chosen = runs.find((r) => r.id === runId) || runs[0];
      const { entries, offset: newOffset, size } = parseAgentLog(chosen.file, offset);
      return json({
        entries, offset: newOffset, size, status,
        exists: true, running: status === "running" && chosen.id === "current",
        runs: runs.map((r) => ({ id: r.id, label: r.label })),
        run: chosen.id,
      });
    }
    return json({ error: "not found" }, 404);
  },
});

console.log(`pi-hive telemetry dashboard: http://${HOST}:${PORT}`);
console.log(`registry: ${REGISTRY_PATH}`);
console.log(`sources: ${Array.from(sources.keys()).length}`);
