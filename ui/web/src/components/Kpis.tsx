import { useMemo } from "react";
import { useHive } from "../store";
import { fmtCost, fmtNum } from "../lib/format";
import { smooth } from "../lib/agents";
import type { HiveEvent } from "../types";

// Downsample a numeric series to N points in [0..1] then map into the 56×24
// sparkline box (y inverted). Returns smoothed line + closed area paths.
function sparkPaths(values: number[]): { line: string; area: string } | null {
  if (values.length < 2) return null;
  const N = 14;
  const step = (values.length - 1) / (N - 1);
  const sampled: number[] = [];
  for (let i = 0; i < N; i++) sampled.push(values[Math.round(i * step)]);
  const min = Math.min(...sampled), max = Math.max(...sampled);
  const span = max - min || 1;
  const pts: [number, number][] = sampled.map((v, i) => [
    (i / (N - 1)) * 56,
    24 - ((v - min) / span) * 18 - 3,
  ]);
  const line = smooth(pts);
  return { line, area: line + " L 56 24 L 0 24 Z" };
}

// Cumulative token/cost series from delegation_end events, for KPI sparklines.
function cumulativeSeries(events: HiveEvent[]): { tok: number[]; cost: number[] } {
  const evs = [...events].reverse(); // scopedEvents is newest-first
  const tokByAgent = new Map<string, number>();
  const costByAgent = new Map<string, number>();
  const tok: number[] = [], cost: number[] = [];
  for (const e of evs) {
    if (e.type !== "delegation_end") continue;
    const p: any = e.payload || {};
    const rt = p.runtime || {};
    const name = rt.name || p.from;
    if (!name) continue;
    tokByAgent.set(name, Math.max(tokByAgent.get(name) || 0, Number(rt.inputTokens || 0) + Number(rt.outputTokens || 0)));
    costByAgent.set(name, Math.max(costByAgent.get(name) || 0, Number(rt.costUsd || p.costUsd || 0)));
    let sTok = 0, sCost = 0;
    for (const v of tokByAgent.values()) sTok += v;
    for (const v of costByAgent.values()) sCost += v;
    tok.push(sTok); cost.push(sCost);
  }
  return { tok, cost };
}

function Sparkline({ paths, color }: { paths: { line: string; area: string } | null; color: string }) {
  if (!paths) return <div className="w-12 h-[22px] flex-none" aria-hidden="true" />;
  return (
    <svg width="48" height="22" viewBox="0 0 56 24" preserveAspectRatio="none" className="flex-none" aria-hidden="true">
      <path d={paths.area} fill={color} opacity=".1" />
      <path d={paths.line} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity=".85" />
    </svg>
  );
}

export default function Kpis() {
  const scope = useHive((s) => s.scope);
  const scopedStats = useHive((s) => s.scopedStats);
  const scopedSessions = useHive((s) => s.scopedSessions);
  const scopedEvents = useHive((s) => s.scopedEvents);

  const s = scopedStats;

  // Wall-clock throughput, not model-internal runtime (matches the prior KPI).
  const tokSec = useMemo(() => {
    const sessions = scopedSessions.filter((x) => x.tokens > 0);
    const wallSeconds = sessions.reduce((sum, x) => {
      const first = new Date(x.first_ts).getTime();
      const last = new Date(x.last_ts).getTime();
      return sum + Math.max(1, Number.isFinite(last - first) ? (last - first) / 1000 : 0);
    }, 0);
    return wallSeconds > 0 ? s.tokens / wallSeconds : 0;
  }, [scopedSessions, s.tokens]);

  const series = useMemo(() => cumulativeSeries(scopedEvents), [scopedEvents]);
  const tokSpark = useMemo(() => sparkPaths(series.tok), [series.tok]);
  const costSpark = useMemo(() => sparkPaths(series.cost), [series.cost]);

  const cards = [
    { label: "RUNNING", unit: "live", value: String(s.running), color: "var(--run)", spark: null },
    { label: "SESSIONS", unit: "now", value: String(s.sessions), color: "var(--ink)", spark: null },
    { label: "TOKENS", unit: "total", value: fmtNum(s.tokens), color: "var(--ink)", spark: tokSpark },
    { label: "THROUGHPUT", unit: "tok/s", value: tokSec >= 1000 ? (tokSec / 1000).toFixed(2) + "k" : tokSec.toFixed(1), color: "var(--brand)", spark: tokSpark },
    { label: "TOTAL COST", unit: "usd", value: fmtCost(s.cost), color: "var(--ink)", spark: costSpark },
  ];
  void scope;

  return (
    <div className="grid grid-cols-5 gap-4 mb-[18px] max-[1180px]:grid-cols-2">
      {cards.map((c) => (
        <div
          key={c.label}
          className="min-w-0 bg-panel border border-line rounded-2xl shadow-panel p-[15px_16px_14px] overflow-hidden"
        >
          <div className="flex items-baseline justify-between gap-1.5">
            <span className="font-mono text-[10px] tracking-[.04em] text-ink-dim whitespace-nowrap overflow-hidden text-ellipsis">{c.label}</span>
            <span className="font-mono text-[9.5px] text-ink-dimmer flex-none">{c.unit}</span>
          </div>
          <div className="flex items-end justify-between mt-[13px] gap-2">
            <span className="font-extrabold text-[29px] leading-[.92] tracking-[-.02em] tabular-nums" style={{ color: c.color }}>{c.value}</span>
            <Sparkline paths={c.spark} color={c.color} />
          </div>
        </div>
      ))}
    </div>
  );
}
