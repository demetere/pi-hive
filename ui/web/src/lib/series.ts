import type { Delegation } from "../api";
import type { HiveEvent } from "../types";

// Derive per-run delegation deltas from a raw delegation_end event slice — used
// only by REPLAY (Phase 3.1), which reconstructs a session over events[0..cursor]
// client-side and has no server delegation rows for a historical cursor. Reads
// the `delta` block Phase 2 stamps onto delegation_end (schemaVersion 1); an
// older event without it falls back to its lifetime runtime values (a legacy
// replay may then approximate, exactly as it did before this change).
export function delegationsFromEvents(events: HiveEvent[]): Delegation[] {
  const out: Delegation[] = [];
  for (const e of events) {
    if (e.type !== "delegation_end") continue;
    const p: any = e.payload || {};
    const d = p.delta;
    const isDelta = Number(p.delegationsSchema) >= 1 && d && typeof d === "object";
    const rt = p.runtime || {};
    out.push({
      cursor: Number(e.cursor || 0),
      sessionId: e.session_id,
      cwd: e.cwd,
      agent: rt.name || p.from,
      parent: p.to,
      endedAt: e.ts,
      durationMs: Number(p.elapsedMs) || undefined,
      inputTokens: Number((isDelta ? d.inputTokens : rt.inputTokens ?? p.inputTokens) ?? 0),
      outputTokens: Number((isDelta ? d.outputTokens : rt.outputTokens ?? p.outputTokens) ?? 0),
      cacheReadTokens: Number((isDelta ? d.cacheReadTokens : rt.cacheReadTokens) ?? 0),
      cacheWriteTokens: Number((isDelta ? d.cacheWriteTokens : rt.cacheWriteTokens) ?? 0),
      costUsd: Number((isDelta ? d.costUsd : rt.costUsd ?? p.costUsd) ?? 0),
      schemaVersion: isDelta ? 1 : 0,
      status: p.type,
      stopReason: p.stopReason,
      model: Array.isArray(p.models) && p.models.length ? p.models[p.models.length - 1] : p.model,
    });
  }
  return out;
}

// One aggregation to rule them all (E2). The Overview chart and the KPI cards
// derive their token/cost numbers from THIS function over the typed delegation
// rows (Phase 3.1) — NOT the raw ~1000-event window, which truncates history.
//
// Each delegation row carries PER-RUN DELTAS (Phase 2, schemaVersion 1): the
// tokens/cost THIS run consumed. Deltas are ADDITIVE, so the cumulative series
// is a simple running sum in endedAt order — no per-agent peak/max needed, and a
// re-run agent no longer double-counts (the old lifetime-peak approach did). The
// store fetches these deltas-only, so legacy cumulative rows never reach here.

export interface SeriesPoint {
  t: number;         // wall-clock ms
  tok: number;       // cumulative input+output tokens
  cost: number;      // cumulative USD
  cacheRead: number; // cumulative cache-read tokens
  cacheWrite: number;// cumulative cache-write tokens
}

export interface SeriesTotals {
  tok: number;
  cost: number;
  cacheRead: number;
  cacheWrite: number;
}

// Build the cumulative series by summing per-run deltas in completion order.
// `rows` should already be scope-filtered by the caller; we sort by endedAt so a
// late-arriving row lands at the right point on the timeline.
export function cumulativeSeries(rows: Delegation[]): SeriesPoint[] {
  const chrono = [...rows]
    .filter((r) => r.endedAt)
    .sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)));
  const pts: SeriesPoint[] = [];
  let tok = 0, cost = 0, cacheRead = 0, cacheWrite = 0;
  for (const r of chrono) {
    tok += Number(r.inputTokens || 0) + Number(r.outputTokens || 0);
    cost += Number(r.costUsd || 0);
    cacheRead += Number(r.cacheReadTokens || 0);
    cacheWrite += Number(r.cacheWriteTokens || 0);
    pts.push({ t: new Date(r.endedAt as string).getTime(), tok, cost, cacheRead, cacheWrite });
  }
  return pts;
}

// Final cumulative totals (the KPI-card figures). Includes cache split so the
// cards can show cache tokens as their own stat (Decision 2).
export function seriesTotals(rows: Delegation[]): SeriesTotals {
  const pts = cumulativeSeries(rows);
  const last = pts[pts.length - 1];
  return last ? { tok: last.tok, cost: last.cost, cacheRead: last.cacheRead, cacheWrite: last.cacheWrite }
    : { tok: 0, cost: 0, cacheRead: 0, cacheWrite: 0 };
}

// Per-minute RATE series over the last `windowMin` minutes (E2). Buckets tokens
// and cost by the minute they were produced (deltas of the cumulative series),
// so the Overview chart's "per minute" labels match what is plotted.
export interface RatePoint { t: number; tokPerMin: number; costPerMin: number; }
export function rateSeries(rows: Delegation[], windowMin = 60, now = Date.now()): RatePoint[] {
  const pts = cumulativeSeries(rows);
  const start = now - windowMin * 60_000;
  const buckets = new Map<number, { tok: number; cost: number }>();
  let prevTok = 0, prevCost = 0;
  for (const pt of pts) {
    const dTok = Math.max(0, pt.tok - prevTok);
    const dCost = Math.max(0, pt.cost - prevCost);
    prevTok = pt.tok; prevCost = pt.cost;
    if (pt.t < start) continue;
    const minute = Math.floor(pt.t / 60_000) * 60_000;
    const b = buckets.get(minute) || { tok: 0, cost: 0 };
    b.tok += dTok; b.cost += dCost;
    buckets.set(minute, b);
  }
  const out: RatePoint[] = [];
  for (let m = Math.floor(start / 60_000) * 60_000; m <= now; m += 60_000) {
    const b = buckets.get(m) || { tok: 0, cost: 0 };
    out.push({ t: m, tokPerMin: b.tok, costPerMin: b.cost });
  }
  return out;
}
