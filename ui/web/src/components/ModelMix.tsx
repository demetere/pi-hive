import { useMemo } from "react";
import { useHive } from "../store";
import { fmtCost, fmtNum, shortModel } from "../lib/format";

const PALETTE = ["var(--accent)", "var(--ok)", "#f59e0b", "#ff6b6b", "#a78bfa", "#38bdf8"];
const R = 52, C = 2 * Math.PI * R;

export default function ModelMix() {
  const scopedAgents = useHive((s) => s.scopedAgents);

  const data = useMemo(() => {
    const byModel = new Map<string, number>();
    const byAgent = new Map<string, { name: string; tok: number; cost: number; color: string }>();
    for (const a of scopedAgents) {
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
  }, [scopedAgents]);

  if (!(data.total > 1 || data.leaders.length)) {
    return <div className="mix-wrap"><div className="empty">No agent usage yet.</div></div>;
  }

  let acc = 0;
  return (
    <div className="mix-wrap">
      <div className="donut-row">
        <svg viewBox="0 0 140 140" className="donut">
          <circle className="track" r={R} cx="70" cy="70" />
          {data.segments.map((s, i) => {
            const rot = acc * 360; acc += s.frac;
            return (
              <circle key={i} className="seg" r={R} cx="70" cy="70" stroke={s.color}
                strokeDasharray={`${(C * s.frac).toFixed(1)} ${C.toFixed(1)}`}
                transform={`rotate(${rot - 90} 70 70)`} />
            );
          })}
          <text x="70" y="66" className="d-big">{fmtNum(data.total)}</text>
          <text x="70" y="84" className="d-sm">tokens</text>
        </svg>
        <div className="lg-list">
          {data.segments.map((s, i) => (
            <div className="lg-row" key={i}><span className="lg-dot" style={{ background: s.color }} />{s.model}<b>{s.pct}%</b></div>
          ))}
        </div>
      </div>
      <div className="leaders">
        {data.leaders.map((a, i) => (
          <div className="ld" key={i}>
            <span className="ld-dot" style={{ background: a.color }} />
            <span className="ld-name">{a.name}</span>
            <span className="ld-tok">{fmtNum(a.tok)}</span>
            <span className="ld-cost">{fmtCost(a.cost)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
