import * as fs from "node:fs";
import * as path from "node:path";
import { agentRuns, parseAgentLog } from "./agent-log";
import { isSameOriginWrite } from "./security";
import { dashboardFile, dashboardHtml } from "./static";
import {
  BOOT_SESSION_ID,
  CONVERSATION_LOG,
  DB_PATH,
  HOST,
  MAX_EVENTS,
  PORT,
  PROJECT_CWD,
  REGISTRY_PATH,
  SINGLE_LOG_PATH,
} from "./server/config";
import {
  dbEventRow,
  dbSessionRowFromEvent,
  deleteSessionRows,
  insertEvent,
  loadPersistedEvents,
  loadPersistedStates,
  upsertSession,
  upsertState,
} from "./server/db";
import { projectName } from "../shared/project";
import { broadcastEvent, broadcastFrame, broadcastPing, encoder, eventFrame, subscribers } from "./server/sse";
import type { Source, Subscriber } from "./server/types";

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
  broadcastEvent("hive_state", snapshot);
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
  broadcastEvent("hive", event);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

function loadDbIntoMemory() {
  events = loadPersistedEvents(MAX_EVENTS);
  for (const snapshot of loadPersistedStates()) snapshots.set(snapshot.session_id, snapshot);
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
  deleteSessionRows(Array.from(idSet));

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
  broadcastEvent("hive_delete", { session_ids: Array.from(idSet) });
  return idSet.size;
}

function deleteProject(name: string): number {
  const ids = sessionSummaries().filter((s) => projectName(s.cwd) === name).map((s) => s.session_id);
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
setInterval(broadcastPing, 15_000);

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
          controller.enqueue(encoder.encode(eventFrame("hello", { mode: "global", registry: REGISTRY_PATH })));
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
