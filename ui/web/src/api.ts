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
      .then((r) => (r.ok ? r.json() : { token: null }))
      .then((b: { token: string | null }) => b.token)
      .catch(() => null);
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

// Fetch the latest snapshots (reconnect re-sync of snapshot-shaped state, E1).
export async function fetchStates(): Promise<Snapshot[]> {
  const data = await jsonOr<{ states: Snapshot[] }>(fetch("/states"), { states: [] });
  return data.states || [];
}

export async function deleteSessionRemote(sessionId: string): Promise<boolean> {
  try {
    const res = await writeFetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteProjectRemote(project: string): Promise<boolean> {
  try {
    const res = await writeFetch(`/projects/${encodeURIComponent(project)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
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
export async function saveProjectOverride(cwd: string, label: string): Promise<boolean> {
  try {
    const res = await writeFetch("/project-overrides", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, label }) });
    return res.ok;
  } catch { return false; }
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

export async function postPlanComment(changeId: string, body: { file?: string; anchor?: string; author?: string; body: string; annotationType?: string; originalText?: string }, cwd?: string): Promise<boolean> {
  try {
    const res = await writeFetch(`/plans/${encodeURIComponent(changeId)}/comments${cwdQuery(cwd)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return res.ok;
  } catch { return false; }
}

export async function postPlanApproval(changeId: string, body: { phase: string; actor?: string; summary?: string }, cwd?: string): Promise<boolean> {
  try {
    const res = await writeFetch(`/plans/${encodeURIComponent(changeId)}/approval${cwdQuery(cwd)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return res.ok;
  } catch { return false; }
}
