import { useMemo } from "react";
import CostTokensChart from "../components/CostTokensChart";
import { useHive } from "../store";
import { fmtCost, fmtNum, shortModel } from "../lib/format";

export default function Cost() {
  const scope = useHive((s) => s.scope);
  const scopedAgents = useHive((s) => s.scopedAgents);
  const scopedStats = useHive((s) => s.scopedStats);

  const breakdown = useMemo(() => {
    const byName = new Map<string, { name: string; color: string; model: string; cost: number; tokens: number }>();
    for (const a of scopedAgents) {
      if (a.cost <= 0 && a.tokens <= 0) continue;
      const cur = byName.get(a.name) || { name: a.name, color: a.color || "var(--accent)", model: shortModel(a.model), cost: 0, tokens: 0 };
      cur.cost += a.cost; cur.tokens += a.tokens;
      byName.set(a.name, cur);
    }
    const rows = Array.from(byName.values()).sort((a, b) => b.cost - a.cost);
    const max = Math.max(0.0001, ...rows.map((r) => r.cost));
    return { rows, max };
  }, [scopedAgents]);
  const scopeLabel = scope.level === "fleet" ? "all projects" : scope.level === "project" ? "this project" : "this session";

  return (
    <>
      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Cost</div><div className="kpi-val">{fmtCost(scopedStats.cost)}</div><div className="kpi-sub">{scopeLabel}</div></div>
        <div className="kpi"><div className="kpi-label">Tokens</div><div className="kpi-val">{fmtNum(scopedStats.tokens)}</div><div className="kpi-sub">input + output</div></div>
        <div className="kpi"><div className="kpi-label">Sessions</div><div className="kpi-val">{scopedStats.sessions}</div><div className="kpi-sub">{scopedStats.live} live</div></div>
        <div className="kpi"><div className="kpi-label">Running agents</div><div className="kpi-val">{scopedStats.running}</div><div className="kpi-sub">{scopeLabel}</div></div>
      </div>
      <div className="cost-grid">
        <section className="widget">
          <div className="w-head"><span className="w-title">Cost &amp; tokens over time</span><span className="w-legend"><i className="lg cost" />cost<i className="lg tok" />tokens</span></div>
          <CostTokensChart />
        </section>
        <section className="widget">
          <div className="w-head"><span className="w-title">Cost by agent</span></div>
          <div style={{ padding: "14px 16px", flex: 1, overflow: "auto" }}>
            {breakdown.rows.length ? breakdown.rows.map((r, i) => (
              <div className="bar-row" key={i}>
                <span className="bar-name"><span className="cdot" style={{ background: r.color }} />{r.name}</span>
                <span className="bar-track"><span className="bar-fill" style={{ width: `${(r.cost / breakdown.max) * 100}%`, background: r.color }} /></span>
                <span className="bar-val">{fmtCost(r.cost)}</span>
              </div>
            )) : <div className="empty">No cost recorded yet.</div>}
          </div>
        </section>
      </div>
    </>
  );
}
