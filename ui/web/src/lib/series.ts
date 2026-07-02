import type { HiveEvent } from "../types";

// One aggregation to rule them all (E2). Both the Overview chart and the KPI
// cards derive their token/cost numbers from THIS function instead of each
// re-implementing the peak-and-sum over delegation_end payloads.
//
// Tokens/cost per agent are cumulative (Phase A overwrites the runtime counters
// from getSessionStats() at delegation end, so the latest delegation_end for an
// agent carries its true lifetime total — we take the peak to be robust to
// out-of-order events). Summing the per-agent peaks gives the session/scope
// total at each point in time.

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

// Build the cumulative, monotonic series from (scope-filtered) events. `events`
// may be newest-first (scopedEvents) or chronological — we sort by ts to be safe.
export function cumulativeSeries(events: HiveEvent[]): SeriesPoint[] {
  const chrono = [...events].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const peakTok = new Map<string, number>();
  const peakCost = new Map<string, number>();
  const peakCR = new Map<string, number>();
  const peakCW = new Map<string, number>();
  const pts: SeriesPoint[] = [];
  for (const e of chrono) {
    if (e.type !== "delegation_end") continue;
    const p: any = e.payload || {};
    const rt = p.runtime || {};
    const name = rt.name || p.from;
    if (!name) continue;
    peakTok.set(name, Math.max(peakTok.get(name) || 0, Number(rt.inputTokens || 0) + Number(rt.outputTokens || 0)));
    peakCost.set(name, Math.max(peakCost.get(name) || 0, Number(rt.costUsd ?? p.costUsd ?? 0)));
    peakCR.set(name, Math.max(peakCR.get(name) || 0, Number(rt.cacheReadTokens || 0)));
    peakCW.set(name, Math.max(peakCW.get(name) || 0, Number(rt.cacheWriteTokens || 0)));
    const sum = (m: Map<string, number>) => { let s = 0; for (const v of m.values()) s += v; return s; };
    pts.push({ t: new Date(e.ts).getTime(), tok: sum(peakTok), cost: sum(peakCost), cacheRead: sum(peakCR), cacheWrite: sum(peakCW) });
  }
  // Enforce monotonicity (a late out-of-order event can't drop the running total).
  let mTok = 0, mCost = 0, mCR = 0, mCW = 0;
  for (const pt of pts) {
    mTok = Math.max(mTok, pt.tok); pt.tok = mTok;
    mCost = Math.max(mCost, pt.cost); pt.cost = mCost;
    mCR = Math.max(mCR, pt.cacheRead); pt.cacheRead = mCR;
    mCW = Math.max(mCW, pt.cacheWrite); pt.cacheWrite = mCW;
  }
  return pts;
}

// Final cumulative totals (the KPI-card figures). Includes cache split so the
// cards can show cache tokens as their own stat (Decision 2).
export function seriesTotals(events: HiveEvent[]): SeriesTotals {
  const pts = cumulativeSeries(events);
  const last = pts[pts.length - 1];
  return last ? { tok: last.tok, cost: last.cost, cacheRead: last.cacheRead, cacheWrite: last.cacheWrite }
    : { tok: 0, cost: 0, cacheRead: 0, cacheWrite: 0 };
}

// Per-minute RATE series over the last `windowMin` minutes (E2). Buckets tokens
// and cost by the minute they were produced (deltas of the cumulative series),
// so the Overview chart's "per minute" labels match what is plotted.
export interface RatePoint { t: number; tokPerMin: number; costPerMin: number; }
export function rateSeries(events: HiveEvent[], windowMin = 60, now = Date.now()): RatePoint[] {
  const pts = cumulativeSeries(events);
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
