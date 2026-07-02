import type { HiveEvent, Snapshot } from "./types";

export interface InitialData {
  events: HiveEvent[];
  states: Snapshot[];
  cursor: number;
}

// Per-daemon write token (Phase D). Fetched once from the same-origin
// /bootstrap.json and attached as a Bearer header on every POST/DELETE. Cached
// so repeated writes don't refetch; the promise dedupes concurrent first calls.
let tokenPromise: Promise<string | null> | null = null;
function daemonToken(): Promise<string | null> {
  if (!tokenPromise) {
    tokenPromise = fetch("/bootstrap.json")
      .then(async (r): Promise<string | null> => {
        if (!r.ok) return null;
        const body = (await r.json()) as { token: string | null };
        return body.token;
      })
      .catch((): string | null => null);
  }
  return tokenPromise;
}

// fetch() for a mutating request: attaches the write token. Returns the Response
// so callers can surface {ok, error} (see E5).
export async function writeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = await daemonToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

async function jsonOr<T>(request: Promise<Response>, fallback: T): Promise<T> {
  try {
    const response = await request;
    if (!response.ok) return fallback;
    return await response.json();
  } catch {
    return fallback;
  }
}

export async function fetchInitialData(): Promise<InitialData> {
  const [ev, st] = await Promise.all([
    jsonOr<{ events: HiveEvent[]; cursor?: number }>(fetch("/events"), { events: [], cursor: 0 }),
    jsonOr<{ states: Snapshot[] }>(fetch("/states"), { states: [] }),
  ]);
  return { events: ev.events || [], states: st.states || [], cursor: Number(ev.cursor || 0) };
}

// Fetch events newer than a cursor (lossless SSE reconnect catch-up, E1). Pages
// forward until the server returns fewer than the page size.
export async function fetchEventsAfter(cursor: number): Promise<{ events: HiveEvent[]; cursor: number }> {
  const all: HiveEvent[] = [];
  let after = cursor;
  let latest = cursor;
  for (let guard = 0; guard < 100; guard++) {
    const page = await jsonOr<{ events: HiveEvent[]; cursor?: number }>(
      fetch(`/events?after=${after}&limit=1000`), { events: [], cursor: latest });
    const evs = page.events || [];
    all.push(...evs);
    latest = Math.max(latest, Number(page.cursor || 0));
    if (evs.length < 1000) break;
    const lastCursor = evs[evs.length - 1]?.cursor;
    if (lastCursor == null || lastCursor <= after) break;
    after = lastCursor;
  }
  return { events: all, cursor: latest };
}

// Fetch one page of events OLDER than a cursor (K7 "load older"). Single bounded
// page; the caller loops if it wants more. Empty when the anchor is the oldest.
export async function fetchEventsBefore(cursor: number, opts: { session?: string; cwd?: string; limit?: number } = {}): Promise<HiveEvent[]> {
  const q = new URLSearchParams({ before: String(cursor), limit: String(opts.limit ?? 500) });
  if (opts.session) q.set("session", opts.session);
  if (opts.cwd) q.set("cwd", opts.cwd);
  const page = await jsonOr<{ events: HiveEvent[] }>(fetch(`/events?${q.toString()}`), { events: [] });
  return page.events || [];
}

// Fetch the latest snapshots (reconnect re-sync of snapshot-shaped state, E1).
export async function fetchStates(): Promise<Snapshot[]> {
  const data = await jsonOr<{ states: Snapshot[] }>(fetch("/states"), { states: [] });
  return data.states || [];
}

// Page a whole session's event history for replay (F1). SQL-backed, cursor
// ordered; onProgress reports the running count so the UI can show a loader.
// The server drops delegation_progress at ingest (runtime.ts) and never stores
// or counts them, so what we page is exactly what sessions.event_count reflects —
// `fetchedTotal` is the like-for-like baseline for pruned-history detection (I4).
export async function fetchSessionEvents(
  sessionId: string,
  onProgress?: (n: number) => void,
): Promise<{ events: HiveEvent[]; fetchedTotal: number }> {
  const all: HiveEvent[] = [];
  let fetchedTotal = 0;
  let after = 0;
  for (let guard = 0; guard < 500; guard++) {
    const page = await jsonOr<{ events: HiveEvent[] }>(
      fetch(`/events?session=${encodeURIComponent(sessionId)}&after=${after}&limit=1000`), { events: [] });
    const raw = page.events || [];
    fetchedTotal += raw.length;
    all.push(...raw);
    onProgress?.(all.length);
    if (raw.length < 1000) break;
    const last = raw[raw.length - 1]?.cursor;
    if (last == null || last <= after) break;
    after = last;
  }
  return { events: all, fetchedTotal };
}

// Server-authoritative session summaries (GET /sessions). The `event_count`
// here is the DB's true row count for the session — unlike the client-derived
// SessionView count (which only ever counts the events currently loaded), so it
// is the correct baseline for detecting pruned/absent early history (I4/F3).
export interface SessionSummary {
  session_id: string;
  cwd?: string;
  session_dir?: string;
  first_ts?: string;
  last_ts?: string;
  event_count: number;
  running?: number;
  // Authoritative token/cost totals from the SQL sessions row (B2). Carried so
  // the KPI TOKENS + CACHE cards read one consistent source instead of TOKENS
  // from the snapshot and CACHE re-derived from the raw event window (Phase 3.0).
  tokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  topologyHash?: string;
}
export async function fetchSessionSummaries(): Promise<SessionSummary[]> {
  const data = await jsonOr<{ sessions: SessionSummary[] }>(fetch("/sessions"), { sessions: [] });
  return data.sessions || [];
}

// A typed, completed delegation row from the SQL projection (Phase 2/3). Token
// and cost figures are PER-RUN DELTAS (schemaVersion 1) — additive across rows,
// so summing them never double-counts a re-run agent. Legacy cumulative rows
// (schemaVersion 0) are excluded server-side when deltasOnly is passed.
export interface Delegation {
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
  reasoningTokens?: number;
  costUsd: number;
  schemaVersion: number;
  status?: string;
  stopReason?: string;
  model?: string;
}
// Typed delegations for cost/token aggregation (Phase 3.1). ALWAYS request
// deltasOnly for anything that SUMS these rows — mixing per-run deltas with
// legacy cumulative rows would double-count. `after` pages forward by cursor.
export async function fetchDelegations(opts: { session?: string; cwd?: string; after?: number; limit?: number; deltasOnly?: boolean } = {}): Promise<Delegation[]> {
  const q = new URLSearchParams();
  if (opts.session) q.set("session", opts.session);
  if (opts.cwd) q.set("cwd", opts.cwd);
  if (opts.after != null) q.set("after", String(opts.after));
  if (opts.limit != null) q.set("limit", String(opts.limit));
  if (opts.deltasOnly !== false) q.set("deltasOnly", "1"); // default on
  const data = await jsonOr<{ delegations: Delegation[] }>(fetch(`/delegations?${q.toString()}`), { delegations: [] });
  return data.delegations || [];
}

// Storage usage + prune preview (GET /storage). `cwd` scopes to a project; add
// `olderThanDays` for the remove/keep estimate at that cutoff. `bytes` is logical
// telemetry content (payloads + projection text), not the physical .db size.
export interface StorageBreakdown {
  bytes: number;
  events: number;
  sessions: number;
  prune?: { removeBytes: number; removeEvents: number; removeSessions: number; keepBytes: number; keepEvents: number };
}
export async function fetchStorage(cwd?: string, olderThanDays?: number): Promise<StorageBreakdown | null> {
  const q = new URLSearchParams();
  if (cwd) q.set("cwd", cwd);
  if (olderThanDays != null && Number.isFinite(olderThanDays)) q.set("olderThanDays", String(olderThanDays));
  const qs = q.toString();
  return jsonOr<StorageBreakdown | null>(fetch(`/storage${qs ? `?${qs}` : ""}`), null);
}

// Model capability lookup (GET /models). Feeds the thinking dial's fallback:
// when a node lacks its own thinkingLevels sidecar, we look the effective model
// up here for its SDK-reported levels (K3/Decision 6) instead of inventing a
// full 6-level ladder.
export interface ModelInfo {
  provider: string;
  modelId: string;
  name?: string;
  reasoning: boolean;
  thinkingLevels: string[];
}
export async function fetchModels(): Promise<ModelInfo[]> {
  const data = await jsonOr<{ models: ModelInfo[] }>(fetch("/models"), { models: [] });
  return data.models || [];
}

// Versioned topology surface (K2). A cwd's distinct topology versions ordered by
// first_seen_at (rank = "v1", "v2", …); and one reassembled tree by hash.
export interface TopologyVersionSummary { hash: string; firstSeenAt: string; lastSeenAt: string; sessionCount: number; }
export async function fetchTopologies(cwd?: string): Promise<TopologyVersionSummary[]> {
  const data = await jsonOr<{ topologies: TopologyVersionSummary[] }>(fetch(`/topologies${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`), { topologies: [] });
  return data.topologies || [];
}
export interface TopologyDetail {
  hash: string; cwd: string; firstSeenAt: string; lastSeenAt: string;
  planning?: { orchestrator?: any; agents: any[] };
  hive?: { orchestrator?: any; agents: any[] };
  canonicalJson?: string;
}
export async function fetchTopologyDetail(hash: string): Promise<TopologyDetail | null> {
  return jsonOr<TopologyDetail | null>(fetch(`/topologies/${encodeURIComponent(hash)}`), null);
}

// Uniform result for mutating helpers so callers can surface a real status/error
// (401 vs network vs 500) in a toast, not just a generic failure (M7a).
export interface WriteResult { ok: boolean; status: number; error?: string; }

// Run a mutating request and normalize it to WriteResult. `label` names the
// action for the fallback error text ("comment failed (401)").
async function writeResult(label: string, req: Promise<Response>): Promise<WriteResult> {
  try {
    const res = await req;
    if (!res.ok) return { ok: false, status: res.status, error: `${label} failed (${res.status})` };
    return { ok: true, status: res.status };
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.message || "network error" };
  }
}

// Prune telemetry older than N days via the daemon (K1 Settings action / J1).
export async function pruneTelemetryRemote(olderThanDays: number): Promise<{ ok: boolean; status: number; events?: number; sessions?: number; error?: string }> {
  try {
    const res = await writeFetch("/prune", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ olderThanDays }) });
    if (!res.ok) return { ok: false, status: res.status, error: `prune failed (${res.status})` };
    const body = await res.json() as { events: number; sessions: number };
    return { ok: true, status: res.status, events: body.events, sessions: body.sessions };
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.message || "network error" };
  }
}

export function deleteSessionRemote(sessionId: string): Promise<WriteResult> {
  return writeResult("delete session", writeFetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }));
}

export function deleteProjectRemote(project: string): Promise<WriteResult> {
  return writeResult("delete project", writeFetch(`/projects/${encodeURIComponent(project)}`, { method: "DELETE" }));
}

export function openEventStream(): EventSource {
  return new EventSource("/stream");
}

// Recent agent "thinking"/reasoning across a session — lives only in per-agent
// transcripts, so it's fetched separately and merged into the activity feed.
export interface ThinkingEntry { agent: string; ts: string; text: string; tokens?: number; }
export async function fetchThinking(sessionId: string): Promise<ThinkingEntry[]> {
  if (!sessionId) return [];
  const data = await jsonOr<{ thinking: ThinkingEntry[] }>(fetch(`/thinking?session=${encodeURIComponent(sessionId)}`), { thinking: [] });
  return data.thinking || [];
}

// ── project display-name overrides (settings) ────────────────────────────────
export interface ProjectOverride { cwd: string; label: string; updatedAt?: string; }
export async function fetchProjectOverrides(): Promise<ProjectOverride[]> {
  const data = await jsonOr<{ overrides: ProjectOverride[] }>(fetch("/project-overrides"), { overrides: [] });
  return data.overrides || [];
}
// Set (label non-empty) or clear (label empty) a project's override by cwd.
export function saveProjectOverride(cwd: string, label: string): Promise<WriteResult> {
  return writeResult("save project name", writeFetch("/project-overrides", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, label }) }));
}

// ── Plan store ───────────────────────────────────────────────────────────────

export interface PlanVerdict {
  id: string; changeId: string; reviewer: string; verdict: "red" | "yellow" | "green";
  summary: string; evidence: string[]; concerns: string[]; blockers: string[]; createdAt: string;
}
export interface PlanApproval { id: string; changeId: string; phase: string; approvedBy: string; actor?: string; summary?: string; createdAt: string; }
export interface PlanComment { id: string; changeId: string; file?: string; anchor?: string; author?: string; body: string; annotationType?: string; originalText?: string; createdAt: string; }
export interface PlanSummary { changeId: string; title?: string; phase: string; status?: string; owner?: string; artifacts: string[]; latestVerdict: PlanVerdict | null; }
export interface PlanDetail {
  changeId: string; title?: string; status?: string; owner?: string; phase: string;
  gates: Array<{ gate: string; present: boolean }>; artifacts: string[];
  verdicts: PlanVerdict[]; approvals: PlanApproval[]; comments: PlanComment[];
}

const cwdQuery = (cwd?: string) => (cwd ? `?cwd=${encodeURIComponent(cwd)}` : "");

export async function fetchPlans(cwd?: string): Promise<PlanSummary[]> {
  const data = await jsonOr<{ plans: PlanSummary[] }>(fetch(`/plans${cwdQuery(cwd)}`), { plans: [] });
  return data.plans || [];
}

export async function fetchPlanDetail(changeId: string, cwd?: string): Promise<PlanDetail | null> {
  return jsonOr<PlanDetail | null>(fetch(`/plans/${encodeURIComponent(changeId)}${cwdQuery(cwd)}`), null);
}

export interface PlanFileResult { content: string | null; truncated?: boolean; size?: number; error?: boolean; }
export async function fetchPlanFile(changeId: string, path: string, cwd?: string): Promise<PlanFileResult> {
  const q = new URLSearchParams({ path });
  if (cwd) q.set("cwd", cwd);
  try {
    const res = await fetch(`/plans/${encodeURIComponent(changeId)}/file?${q.toString()}`);
    if (!res.ok) return { content: null, error: true };
    const data = await res.json() as { content: string | null; truncated?: boolean; size?: number };
    return { content: data.content ?? null, truncated: data.truncated, size: data.size };
  } catch {
    return { content: null, error: true };
  }
}

export function postPlanComment(changeId: string, body: { file?: string; anchor?: string; author?: string; body: string; annotationType?: string; originalText?: string }, cwd?: string): Promise<WriteResult> {
  return writeResult("comment", writeFetch(`/plans/${encodeURIComponent(changeId)}/comments${cwdQuery(cwd)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

export function postPlanApproval(changeId: string, body: { phase: string; actor?: string; summary?: string }, cwd?: string): Promise<WriteResult> {
  return writeResult("approval", writeFetch(`/plans/${encodeURIComponent(changeId)}/approval${cwdQuery(cwd)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}
