import { useMemo } from "react";
import { useHive } from "../store";
import { fmtCost, fmtNum } from "../lib/format";
import { smooth } from "../lib/agents";
import { cumulativeSeries, seriesTotals } from "../lib/series";

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
  const scopedDelegations = useHive((s) => s.scopedDelegations);

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

  // Single aggregation (E2/Phase 3.1): tokens/cost/cache come from the typed
  // delegation deltas — untruncated, unlike the old raw-event window. scopedStats
  // .tokens/cost still feed the headline (live snapshot sum); the sparkline +
  // CACHE read the delta series, so CACHE and TOKENS share one authoritative
  // source instead of one snapshot / one truncated window (the old bug).
  const series = useMemo(() => cumulativeSeries(scopedDelegations), [scopedDelegations]);
  const totals = useMemo(() => seriesTotals(scopedDelegations), [scopedDelegations]);
  const tokSpark = useMemo(() => sparkPaths(series.map((p) => p.tok)), [series]);
  const costSpark = useMemo(() => sparkPaths(series.map((p) => p.cost)), [series]);

  // Cache tokens are shown as their own figure, never folded into the "tokens"
  // headline (Decision 2).
  const cacheTokens = totals.cacheRead + totals.cacheWrite;
  const cards = [
    { label: "RUNNING", unit: "live", value: String(s.running), color: "var(--run)", spark: null },
    // "total" not "now": this counts every session in scope, including long-dead
    // ones — the live subset is the RUNNING/live figures, not this (Phase 3.4).
    { label: "SESSIONS", unit: "total", value: String(s.sessions), color: "var(--ink)", spark: null },
    { label: "TOKENS", unit: "in+out", value: fmtNum(s.tokens || totals.tok), color: "var(--ink)", spark: tokSpark },
    { label: "CACHE", unit: "r+w tok", value: fmtNum(cacheTokens), color: "var(--ink)", spark: null },
    { label: "THROUGHPUT", unit: "tok/s", value: tokSec >= 1000 ? (tokSec / 1000).toFixed(2) + "k" : tokSec.toFixed(1), color: "var(--brand)", spark: tokSpark },
    { label: "TOTAL COST", unit: "usd", value: fmtCost(s.cost || totals.cost), color: "var(--ink)", spark: costSpark },
  ];
  void scope;

  return (
    <div className="grid grid-cols-6 gap-4 mb-[18px] max-[1180px]:grid-cols-2">
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
