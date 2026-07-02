import { useMemo } from "react";
import { useHive } from "../store";
import { fmtNum, shortModel } from "../lib/format";

// The one sanctioned local categorical ramp — used ONLY inside this widget's
// donut + its adjacent legend. Model is neutral everywhere else on screen.
const RAMP = ["var(--brand)", "var(--ink)", "var(--ink-dim)", "var(--ink-dimmer)"];
const R = 42, C = 2 * Math.PI * R, GAP = 3;

export default function ModelMix() {
  const scopedAgents = useHive((s) => s.scopedAgents);
  // The one canonical distinct-agent count, shared with the Overview header and
  // Sidebar badge so all three headline "N agents" figures agree (the donut's
  // token-only byAgent.size would otherwise undercount idle/zero-token agents).
  const scopedAgentCount = useHive((s) => s.scopedAgentCount);

  const scopedDelegations = useHive((s) => s.scopedDelegations);
  // Actual model per agent from the typed delegation rows (Phase 3.1) — the real
  // model the provider ran, resolving a config-declared "inherit" to something
  // concrete (E4). Reading the untruncated delegation projection instead of the
  // raw-event window means older sessions no longer lose their model attribution.
  // Rows are cursor-ordered, so the last row for an agent wins (its latest run).
  const actualModelByAgent = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of scopedDelegations) {
      if (d.agent && d.model) m.set(d.agent, d.model);
    }
    return m;
  }, [scopedDelegations]);

  const data = useMemo(() => {
    const byModel = new Map<string, number>();
    const byAgent = new Map<string, { name: string; model?: string; color: string; tok: number }>();
    const resolveModel = (a: { name: string; model?: string }) => {
      const actual = actualModelByAgent.get(a.name);
      const raw = actual || (a.model && a.model !== "inherit" ? a.model : "");
      return raw ? shortModel(raw) : "";
    };
    for (const a of scopedAgents) {
      const tok = a.tokens;
      if (!tok) continue; // donut counts only token-bearing agents (E4)
      const model = resolveModel(a);
      if (model) byModel.set(model, (byModel.get(model) || 0) + tok);
      const cur = byAgent.get(a.name) || { name: a.name, model: a.model, color: a.color || "var(--brand)", tok: 0 };
      cur.tok += tok;
      byAgent.set(a.name, cur);
    }
    const total = Array.from(byModel.values()).reduce((a, b) => a + b, 0) || 1;
    const segments = Array.from(byModel.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([model, v], i) => ({ model, frac: v / total, pct: Math.round((v / total) * 100), color: RAMP[i % RAMP.length] }));
    const leaders = Array.from(byAgent.values()).sort((a, b) => b.tok - a.tok).slice(0, 5);
    const topTok = leaders[0]?.tok || 1;
    return { total, segments, leaders, topTok };
  }, [scopedAgents, actualModelByAgent]);

  if (!(data.total > 1 || data.leaders.length)) {
    return <div className="mix-wrap"><div className="empty">No agent usage yet.</div></div>;
  }

  // Donut arc offsets, rotated so the first segment starts at 12 o'clock.
  let acc = 0;
  const arcs = data.segments.map((s) => {
    const len = Math.max(0, (s.frac * C) - GAP);
    const arc = { color: s.color, dash: `${len.toFixed(2)} ${(C - len).toFixed(2)}`, offset: (-acc).toFixed(2) };
    acc += s.frac * C;
    return arc;
  });

  return (
    <div className="mix-wrap">
      <div className="donut-row">
        <svg width="96" height="96" viewBox="0 0 104 104" className="donut flex-none">
          <g transform="rotate(-90 52 52)">
            <circle cx="52" cy="52" r={R} fill="none" stroke="var(--well)" strokeWidth="12" />
            {arcs.map((a, i) => (
              <circle key={i} cx="52" cy="52" r={R} fill="none" stroke={a.color} strokeWidth="12"
                strokeLinecap="round" strokeDasharray={a.dash} strokeDashoffset={a.offset} />
            ))}
          </g>
          <text x="52" y="48" textAnchor="middle" className="d-big">{scopedAgentCount}</text>
          <text x="52" y="62" textAnchor="middle" className="d-sm">AGENTS</text>
        </svg>
        <div className="lg-list">
          {data.segments.map((s, i) => (
            <div className="lg-row" key={i}>
              <i className="lg-dot" style={{ background: s.color }} />
              <span className="flex-1 text-ink font-medium">{s.model}</span>
              <span className="text-ink-dim font-mono text-[11px]">{s.pct}%</span>
            </div>
          ))}
        </div>
      </div>

      <div className="leaders-head">TOP AGENTS · TOKENS</div>
      <div className="leaders">
        {data.leaders.map((a, i) => (
          <div key={i}>
            <div className="ld-row">
              <span className="cdot" style={{ background: a.color }} />
              <span className="flex-1 text-ink font-medium overflow-hidden text-ellipsis whitespace-nowrap">{a.name}</span>
              <span className="text-ink font-mono text-[11px] w-[50px] text-right tabular-nums">{fmtNum(a.tok)}</span>
            </div>
            <div className="ld-track"><div className="ld-fill" style={{ width: `${Math.round((a.tok / data.topTok) * 100)}%`, background: a.color }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}
