import { useEffect, useMemo, useRef, useState } from "react";
import { useHive } from "../store";
import { fmtCost, fmtNum } from "../lib/format";
import type { HiveEvent } from "../types";

interface Pt { t: number; tok: number; cost: number; }

// Cumulative cost/token series from the (scope-filtered) event stream.
function buildSeries(events: HiveEvent[]): Pt[] {
  const evs = [...events].reverse(); // scopedEvents is newest-first → chronological
  const pts: Pt[] = [];
  const tokByAgent = new Map<string, number>();
  const costByAgent = new Map<string, number>();
  let lastTok = 0, lastCost = 0;
  for (const e of evs) {
    if (e.type !== "delegation_end") continue;
    const p = e.payload || {};
    const rt = (p as any).runtime || {};
    const name = rt.name || (p as any).from;
    if (!name) continue;
    const tok = Number(rt.inputTokens || 0) + Number(rt.outputTokens || 0);
    const cost = Number(rt.costUsd || (p as any).costUsd || 0);
    tokByAgent.set(name, Math.max(tokByAgent.get(name) || 0, tok));
    costByAgent.set(name, Math.max(costByAgent.get(name) || 0, cost));
    let sumTok = 0, sumCost = 0;
    for (const v of tokByAgent.values()) sumTok += v;
    for (const v of costByAgent.values()) sumCost += v;
    lastTok = sumTok; lastCost = sumCost;
    pts.push({ t: new Date(e.ts).getTime(), tok: sumTok, cost: sumCost });
  }
  let mTok = 0, mCost = 0;
  for (const pt of pts) { mTok = Math.max(mTok, pt.tok); mCost = Math.max(mCost, pt.cost); pt.tok = mTok; pt.cost = mCost; }
  void lastTok; void lastCost;
  return pts;
}

const PAD = { l: 56, r: 56, t: 16, b: 30 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const f = v / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function CostTokensChart() {
  const scopedEvents = useHive((s) => s.scopedEvents);
  const series = useMemo(() => buildSeries(scopedEvents), [scopedEvents]);
  const [hover, setHover] = useState<{ i: number; px: number } | null>(null);
  const [size, setSize] = useState({ w: 760, h: 240 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hostRef.current || !("ResizeObserver" in window)) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(hostRef.current);
    return () => ro.disconnect();
  }, []);

  const geom = useMemo(() => {
    const pts = series;
    const { w: W, h: H } = size;
    const PLOT_W = W - PAD.l - PAD.r;
    const PLOT_H = H - PAD.t - PAD.b;
    if (pts.length < 2 || PLOT_W <= 0 || PLOT_H <= 0) return null;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
    const maxTok = niceMax(Math.max(1, ...pts.map((p) => p.tok)));
    const maxCost = niceMax(Math.max(0.01, ...pts.map((p) => p.cost)));
    const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0 || 1)) * PLOT_W;
    const yT = (v: number) => PAD.t + PLOT_H - (v / maxTok) * PLOT_H;
    const yC = (v: number) => PAD.t + PLOT_H - (v / maxCost) * PLOT_H;
    const line = (acc: (p: Pt) => number) => pts.map((p, i) => (i ? "L" : "M") + x(p.t).toFixed(1) + " " + acc(p).toFixed(1)).join(" ");
    const area = (acc: (p: Pt) => number) => line(acc) + ` L ${x(t1).toFixed(1)} ${PAD.t + PLOT_H} L ${x(t0).toFixed(1)} ${PAD.t + PLOT_H} Z`;
    const ticks = [0, 0.25, 0.5, 0.75, 1];
    return { pts, W, H, PLOT_H, t0, t1, maxTok, maxCost, x, yT, yC, line, area, ticks };
  }, [series, size]);

  function onMove(e: React.PointerEvent) {
    const g = geom; if (!g || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * g.W;
    let best = 0, bestD = Infinity;
    g.pts.forEach((p, i) => { const d = Math.abs(g.x(p.t) - vx); if (d < bestD) { bestD = d; best = i; } });
    setHover({ i: best, px: g.x(g.pts[best].t) });
  }

  const hp = geom && hover ? geom.pts[hover.i] : null;
  const plotBottom = geom ? PAD.t + geom.PLOT_H : 0;

  return (
    <div className="chart-wrap">
      <div className="chart-host" ref={hostRef}>
        {!geom ? <div className="empty">Not enough activity to chart yet.</div> : (
          <>
            <svg ref={svgRef} viewBox={`0 0 ${geom.W} ${geom.H}`} preserveAspectRatio="none" className="chart-svg" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
              <defs>
                <linearGradient id="gTok" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".28" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient>
                <linearGradient id="gCost" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--ok)" stopOpacity=".18" /><stop offset="1" stopColor="var(--ok)" stopOpacity="0" /></linearGradient>
              </defs>

              {geom.ticks.map((f) => {
                const y = plotBottom - f * geom.PLOT_H;
                return (
                  <g key={f}>
                    <line className="chart-grid" x1={PAD.l} x2={geom.W - PAD.r} y1={y} y2={y} />
                    <text className="ax tok" x={PAD.l - 8} y={y + 3} textAnchor="end">{fmtNum(geom.maxTok * f)}</text>
                    <text className="ax cost" x={geom.W - PAD.r + 8} y={y + 3} textAnchor="start">{fmtCost(geom.maxCost * f)}</text>
                  </g>
                );
              })}

              {[0, 0.5, 1].map((f) => {
                const t = geom.t0 + (geom.t1 - geom.t0) * f;
                const x = PAD.l + f * (geom.W - PAD.l - PAD.r);
                return <text key={f} className="ax x" x={x} y={geom.H - 8} textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}>{fmtTime(t)}</text>;
              })}

              <path d={geom.area((p) => geom.yT(p.tok))} fill="url(#gTok)" />
              <path d={geom.area((p) => geom.yC(p.cost))} fill="url(#gCost)" />
              <path className="ln tok" d={geom.line((p) => geom.yT(p.tok))} />
              <path className="ln cost" d={geom.line((p) => geom.yC(p.cost))} />

              {hp && hover && (
                <>
                  <line className="crosshair" x1={hover.px} x2={hover.px} y1={PAD.t} y2={plotBottom} />
                  <circle className="dot tok" cx={hover.px} cy={geom.yT(hp.tok)} r="3.5" />
                  <circle className="dot cost" cx={hover.px} cy={geom.yC(hp.cost)} r="3.5" />
                </>
              )}
            </svg>

            {hp && hover && (
              <div className="chart-tip" style={{ left: `${(hover.px / geom.W) * 100}%` }}>
                <div className="tip-time">{fmtTime(hp.t)}</div>
                <div className="tip-row"><i className="lg tok" />tokens<b>{fmtNum(hp.tok)}</b></div>
                <div className="tip-row"><i className="lg cost" />cost<b>{fmtCost(hp.cost)}</b></div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
