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
  //
  // R3-2.3: the delta-vs-snapshot max() is taken PER-(session,agent), then summed
  // across sessions — not on the scope-level aggregate. In a mixed legacy/delta
  // scope (session A has only a legacy snapshot, session B has delta rows), a
  // scope-level max would pick whichever single session was larger instead of
  // adding them; per-session max-then-sum counts every session once.
  const breakdown = useMemo(() => {
    // key = `${sessionId}::${agent}` → per-session-agent delta sums + snapshot.
    const cell = new Map<string, { session: string; name: string; delCost: number; delTok: number; snapCost: number; snapTok: number }>();
    const ensure = (session: string, name: string) => {
      const k = `${session}::${name}`;
      let cur = cell.get(k);
      if (!cur) { cur = { session, name, delCost: 0, delTok: 0, snapCost: 0, snapTok: 0 }; cell.set(k, cur); }
      return cur;
    };
    // Per-agent color + LAST-run model (R3-2.2: cursor-ordered rows, last wins —
    // standardized with ModelMix so the two tabs never disagree on an agent's model).
    const colorOf = new Map<string, string>();
    const modelOf = new Map<string, string>();
    for (const d of scopedDelegations) {
      const name = d.agent;
      if (!name) continue;
      const cur = ensure(d.sessionId, name);
      cur.delCost += d.costUsd || 0;
      cur.delTok += (d.inputTokens || 0) + (d.outputTokens || 0);
      if (d.model) modelOf.set(name, shortModel(d.model)); // last row wins
    }
    for (const a of scopedAgents) {
      const cur = ensure(a.session_id, a.name);
      cur.snapCost += a.cost; cur.snapTok += a.tokens;
      if (a.color && !colorOf.has(a.name)) colorOf.set(a.name, a.color);
      // R4.3: skip the "inherit" placeholder as a model label (align with ModelMix),
      // so an agent without a resolved model doesn't show the literal "inherit".
      if (a.model && a.model !== "inherit" && !modelOf.has(a.name)) modelOf.set(a.name, shortModel(a.model));
    }
    // Per (session,agent): max(delta, snapshot). Then sum across sessions per agent.
    const byName = new Map<string, { name: string; color: string; model: string; cost: number; tokens: number }>();
    for (const c of cell.values()) {
      let row = byName.get(c.name);
      if (!row) { row = { name: c.name, color: colorOf.get(c.name) || "var(--accent)", model: modelOf.get(c.name) || "", cost: 0, tokens: 0 }; byName.set(c.name, row); }
      row.cost += Math.max(c.delCost, c.snapCost);
      row.tokens += Math.max(c.delTok, c.snapTok);
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
                <span className="bar-name">
                  <span className="cdot" style={{ background: r.color }} />{r.name}
                  {r.model && <span className="text-ink-dim font-mono text-[10px] ml-1.5">{r.model}</span>}
                </span>
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
