import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { scopedEvents } from "../store";
import { fmtCost, fmtNum } from "../lib/format";
import type { HiveEvent } from "../types";
import "./chart.css";

interface Pt { t: number; tok: number; cost: number; }

// Cumulative cost/token series from the (scope-filtered) event stream.
//
// Each delegation_end carries the agent's CUMULATIVE runtime total at that
// moment (runtime.inputTokens etc. is a running peak, not a per-call delta).
// So the fleet total at any time = the SUM of every agent's latest cumulative
// value seen so far — NOT a running sum of those numbers (that would count each
// agent's growing total repeatedly and massively over-report).
function buildSeries(events: HiveEvent[]): Pt[] {
  const evs = [...events].reverse(); // scopedEvents is newest-first → chronological
  const pts: Pt[] = [];
  const tokByAgent = new Map<string, number>();
  const costByAgent = new Map<string, number>();
  let lastTok = 0, lastCost = 0;
  for (const e of evs) {
    if (e.type !== "delegation_end") continue;
    const p = e.payload || {};
    const rt = p.runtime || {};
    const name = rt.name || p.from;
    if (!name) continue;
    const tok = Number(rt.inputTokens || 0) + Number(rt.outputTokens || 0);
    const cost = Number(rt.costUsd || p.costUsd || 0);
    // keep the running peak per agent (cumulative can only grow)
    tokByAgent.set(name, Math.max(tokByAgent.get(name) || 0, tok));
    costByAgent.set(name, Math.max(costByAgent.get(name) || 0, cost));
    let sumTok = 0, sumCost = 0;
    for (const v of tokByAgent.values()) sumTok += v;
    for (const v of costByAgent.values()) sumCost += v;
    lastTok = sumTok; lastCost = sumCost;
    pts.push({ t: new Date(e.ts).getTime(), tok: sumTok, cost: sumCost });
  }
  // ensure monotonic (cumulative never decreases) in case of out-of-order ts
  let mTok = 0, mCost = 0;
  for (const pt of pts) { mTok = Math.max(mTok, pt.tok); mCost = Math.max(mCost, pt.cost); pt.tok = mTok; pt.cost = mCost; }
  void lastTok; void lastCost;
  return pts;
}

const PAD = { l: 56, r: 56, t: 16, b: 30 }; // room for left (tokens) + right (cost) axes

// "nice" max for an axis so ticks land on round numbers
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
  const series = createMemo(() => buildSeries(scopedEvents()));
  const [hover, setHover] = createSignal<{ i: number; px: number } | null>(null);
  // Size tracks the container so the chart FILLS the widget (no fixed box).
  const [size, setSize] = createSignal({ w: 760, h: 240 });
  let svgRef: SVGSVGElement | undefined;
  let hostRef: HTMLDivElement | undefined;

  onMount(() => {
    if (!hostRef || !("ResizeObserver" in window)) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(hostRef);
    onCleanup(() => ro.disconnect());
  });

  const geom = createMemo(() => {
    const pts = series();
    const { w: W, h: H } = size();
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
  });

  function onMove(e: PointerEvent) {
    const g = geom(); if (!g || !svgRef) return;
    const rect = svgRef.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * g.W;
    let best = 0, bestD = Infinity;
    g.pts.forEach((p, i) => { const d = Math.abs(g.x(p.t) - vx); if (d < bestD) { bestD = d; best = i; } });
    setHover({ i: best, px: g.x(g.pts[best].t) });
  }
  function onLeave() { setHover(null); }

  return (
    <div class="chart-wrap">
      <div class="chart-host" ref={hostRef}>
        <Show when={geom()} fallback={<div class="empty">Not enough activity to chart yet.</div>}>
          {(g) => {
            const hp = () => { const h = hover(); return h ? g().pts[h.i] : null; };
            const plotBottom = () => PAD.t + g().PLOT_H;
            return (<>
              <svg ref={svgRef} viewBox={`0 0 ${g().W} ${g().H}`} preserveAspectRatio="none" class="chart-svg" onPointerMove={onMove} onPointerLeave={onLeave}>
                <defs>
                  <linearGradient id="gTok" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".28" /><stop offset="1" stop-color="var(--accent)" stop-opacity="0" /></linearGradient>
                  <linearGradient id="gCost" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--ok)" stop-opacity=".18" /><stop offset="1" stop-color="var(--ok)" stop-opacity="0" /></linearGradient>
                </defs>

                <For each={g().ticks}>
                  {(f) => {
                    const y = plotBottom() - f * g().PLOT_H;
                    return (<>
                      <line class="grid" x1={PAD.l} x2={g().W - PAD.r} y1={y} y2={y} />
                      <text class="ax tok" x={PAD.l - 8} y={y + 3} text-anchor="end">{fmtNum(g().maxTok * f)}</text>
                      <text class="ax cost" x={g().W - PAD.r + 8} y={y + 3} text-anchor="start">{fmtCost(g().maxCost * f)}</text>
                    </>);
                  }}
                </For>

                <For each={[0, 0.5, 1]}>
                  {(f) => {
                    const t = g().t0 + (g().t1 - g().t0) * f;
                    const x = PAD.l + f * (g().W - PAD.l - PAD.r);
                    return <text class="ax x" x={x} y={g().H - 8} text-anchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}>{fmtTime(t)}</text>;
                  }}
                </For>

                <path d={g().area((p) => g().yT(p.tok))} fill="url(#gTok)" />
                <path d={g().area((p) => g().yC(p.cost))} fill="url(#gCost)" />
                <path class="ln tok" d={g().line((p) => g().yT(p.tok))} />
                <path class="ln cost" d={g().line((p) => g().yC(p.cost))} />

                <Show when={hp()}>
                  {(p) => (<>
                    <line class="crosshair" x1={hover()!.px} x2={hover()!.px} y1={PAD.t} y2={plotBottom()} />
                    <circle class="dot tok" cx={hover()!.px} cy={g().yT(p().tok)} r="3.5" />
                    <circle class="dot cost" cx={hover()!.px} cy={g().yC(p().cost)} r="3.5" />
                  </>)}
                </Show>
              </svg>

              <Show when={hp()}>
                {(p) => (
                  <div class="chart-tip" style={{ left: `${(hover()!.px / g().W) * 100}%` }}>
                    <div class="tip-time">{fmtTime(p().t)}</div>
                    <div class="tip-row"><i class="lg tok" />tokens<b>{fmtNum(p().tok)}</b></div>
                    <div class="tip-row"><i class="lg cost" />cost<b>{fmtCost(p().cost)}</b></div>
                  </div>
                )}
              </Show>
            </>);
          }}
        </Show>
      </div>
    </div>
  );
}
