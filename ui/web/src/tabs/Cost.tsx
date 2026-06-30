import { createMemo, For, Show } from "solid-js";
import CostTokensChart from "../components/CostTokensChart";
import { scope, scopedAgents, scopedStats } from "../store";
import { fmtCost, fmtNum, shortModel } from "../lib/format";
import "./tabs.css";

export default function Cost() {
  // Cost by agent in the current scope (aggregates across sessions for
  // project/fleet). Same-named agents across sessions are summed.
  const breakdown = createMemo(() => {
    const byName = new Map<string, { name: string; color: string; model: string; cost: number; tokens: number }>();
    for (const a of scopedAgents()) {
      if (a.cost <= 0 && a.tokens <= 0) continue;
      const cur = byName.get(a.name) || { name: a.name, color: a.color || "var(--accent)", model: shortModel(a.model), cost: 0, tokens: 0 };
      cur.cost += a.cost; cur.tokens += a.tokens;
      byName.set(a.name, cur);
    }
    const rows = Array.from(byName.values()).sort((a, b) => b.cost - a.cost);
    const max = Math.max(0.0001, ...rows.map((r) => r.cost));
    return { rows, max };
  });
  const scopeLabel = () => scope().level === "fleet" ? "all projects" : scope().level === "project" ? "this project" : "this session";

  return (
    <>
      <div class="kpis">
        <div class="kpi"><div class="kpi-label">Cost</div><div class="kpi-val">{fmtCost(scopedStats().cost)}</div><div class="kpi-sub">{scopeLabel()}</div></div>
        <div class="kpi"><div class="kpi-label">Tokens</div><div class="kpi-val">{fmtNum(scopedStats().tokens)}</div><div class="kpi-sub">input + output</div></div>
        <div class="kpi"><div class="kpi-label">Sessions</div><div class="kpi-val">{scopedStats().sessions}</div><div class="kpi-sub">{scopedStats().live} live</div></div>
        <div class="kpi"><div class="kpi-label">Running agents</div><div class="kpi-val">{scopedStats().running}</div><div class="kpi-sub">{scopeLabel()}</div></div>
      </div>
      <div class="cost-grid">
        <section class="widget">
          <div class="w-head"><span class="w-title">Cost &amp; tokens over time</span><span class="w-legend"><i class="lg cost" />cost<i class="lg tok" />tokens</span></div>
          <CostTokensChart />
        </section>
        <section class="widget">
          <div class="w-head"><span class="w-title">Cost by agent</span></div>
          <div style={{ padding: "14px 16px", flex: 1, overflow: "auto" }}>
            <Show when={breakdown().rows.length} fallback={<div class="empty">No cost recorded yet.</div>}>
              <For each={breakdown().rows}>
                {(r) => (
                  <div class="bar-row">
                    <span class="bar-name"><span class="cdot" style={{ background: r.color }} />{r.name}</span>
                    <span class="bar-track"><span class="bar-fill" style={{ width: `${(r.cost / breakdown().max) * 100}%`, background: r.color }} /></span>
                    <span class="bar-val">{fmtCost(r.cost)}</span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </section>
      </div>
    </>
  );
}
