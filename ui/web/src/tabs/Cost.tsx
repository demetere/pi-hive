import { useMemo } from "react";
import CostTokensChart from "../components/CostTokensChart";
import { useHive } from "../store";
import { fmtCost, fmtNum, shortModel } from "../lib/format";

export default function Cost() {
  const scope = useHive((s) => s.scope);
  const scopedAgents = useHive((s) => s.scopedAgents);
  const scopedDelegations = useHive((s) => s.scopedDelegations);
  const scopedStats = useHive((s) => s.scopedStats);

  // Per-agent cost/tokens from the typed delegation deltas (Phase 3.1) — additive
  // and untruncated, so a dead session outside the raw-event window still counts.
  // The live snapshot (scopedAgents) is a per-agent top-up via max(): it carries
  // an in-flight run's usage before its delegation_end row lands, mirroring how
  // Kpis treats the delta series as authoritative and the snapshot as live top-up.
  const breakdown = useMemo(() => {
    const byName = new Map<string, { name: string; color: string; model: string; cost: number; tokens: number }>();
    const ensure = (name: string) => {
      let cur = byName.get(name);
      if (!cur) { cur = { name, color: "var(--accent)", model: "", cost: 0, tokens: 0 }; byName.set(name, cur); }
      return cur;
    };
    for (const d of scopedDelegations) {
      const name = d.agent;
      if (!name) continue;
      const cur = ensure(name);
      cur.cost += d.costUsd || 0;
      cur.tokens += (d.inputTokens || 0) + (d.outputTokens || 0);
      if (!cur.model && d.model) cur.model = shortModel(d.model);
    }
    // Snapshot top-up: fold in live per-agent totals (color/model + max usage so
    // an in-flight run isn't undercounted before its delegation row completes).
    const snapByName = new Map<string, { cost: number; tokens: number }>();
    for (const a of scopedAgents) {
      const s = snapByName.get(a.name) || { cost: 0, tokens: 0 };
      s.cost += a.cost; s.tokens += a.tokens;
      snapByName.set(a.name, s);
      const cur = ensure(a.name);
      if (cur.color === "var(--accent)" && a.color) cur.color = a.color;
      if (!cur.model && a.model) cur.model = shortModel(a.model);
    }
    for (const [name, s] of snapByName) {
      const cur = byName.get(name)!;
      cur.cost = Math.max(cur.cost, s.cost);
      cur.tokens = Math.max(cur.tokens, s.tokens);
    }
    const rows = Array.from(byName.values()).filter((r) => r.cost > 0 || r.tokens > 0).sort((a, b) => b.cost - a.cost);
    const max = Math.max(0.0001, ...rows.map((r) => r.cost));
    return { rows, max };
  }, [scopedAgents, scopedDelegations]);
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
