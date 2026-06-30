import { createMemo, For, Show } from "solid-js";
import { scopedAgents } from "../store";
import { fmtCost, fmtNum, shortModel } from "../lib/format";
import "./mix.css";

const PALETTE = ["var(--accent)", "var(--ok)", "#f59e0b", "#ff6b6b", "#a78bfa", "#38bdf8"];
const R = 52, C = 2 * Math.PI * R;

export default function ModelMix() {
  const data = createMemo(() => {
    // Aggregate across the current scope (one session, a project, or the fleet).
    const byModel = new Map<string, number>();
    const byAgent = new Map<string, { name: string; tok: number; cost: number; color: string }>();
    for (const a of scopedAgents()) {
      const tok = a.tokens;
      if (tok) byModel.set(shortModel(a.model), (byModel.get(shortModel(a.model)) || 0) + tok);
      if (tok || a.cost) {
        const cur = byAgent.get(a.name) || { name: a.name, tok: 0, cost: 0, color: a.color || "var(--muted)" };
        cur.tok += tok; cur.cost += a.cost;
        byAgent.set(a.name, cur);
      }
    }
    const total = Array.from(byModel.values()).reduce((a, b) => a + b, 0) || 1;
    const segments = Array.from(byModel.entries()).sort((a, b) => b[1] - a[1]).map(([model, v], i) => ({ model, frac: v / total, pct: Math.round((v / total) * 100), color: PALETTE[i % PALETTE.length] }));
    const leaders = Array.from(byAgent.values()).sort((a, b) => b.cost - a.cost || b.tok - a.tok).slice(0, 6);
    return { total, segments, leaders };
  });

  return (
    <div class="mix-wrap">
      <Show when={data().total > 1 || data().leaders.length} fallback={<div class="empty">No agent usage yet.</div>}>
        <div class="donut-row">
          <svg viewBox="0 0 140 140" class="donut">
            <circle class="track" r={R} cx="70" cy="70" />
            {(() => { let acc = 0; return (
              <For each={data().segments}>
                {(s) => { const rot = acc * 360; acc += s.frac; return (
                  <circle class="seg" r={R} cx="70" cy="70" stroke={s.color}
                    stroke-dasharray={`${(C * s.frac).toFixed(1)} ${C.toFixed(1)}`}
                    transform={`rotate(${rot - 90} 70 70)`} />
                ); }}
              </For>
            ); })()}
            <text x="70" y="66" class="d-big">{fmtNum(data().total)}</text>
            <text x="70" y="84" class="d-sm">tokens</text>
          </svg>
          <div class="lg-list">
            <For each={data().segments}>
              {(s) => (
                <div class="lg-row"><span class="lg-dot" style={{ background: s.color }} />{s.model}<b>{s.pct}%</b></div>
              )}
            </For>
          </div>
        </div>
        <div class="leaders">
          <For each={data().leaders}>
            {(a) => (
              <div class="ld">
                <span class="ld-dot" style={{ background: a.color }} />
                <span class="ld-name">{a.name}</span>
                <span class="ld-tok">{fmtNum(a.tok)}</span>
                <span class="ld-cost">{fmtCost(a.cost)}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
