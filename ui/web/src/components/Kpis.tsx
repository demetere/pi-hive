import { useHive } from "../store";
import { fmtCost, fmtNum } from "../lib/format";

export default function Kpis() {
  const scope = useHive((s) => s.scope);
  const scopedStats = useHive((s) => s.scopedStats);
  const scopedSessions = useHive((s) => s.scopedSessions);

  const s = scopedStats;
  const lvl = scope.level;
  const sub = lvl === "fleet" ? "all projects" : lvl === "project" ? "this project" : "this session";
  // Wall-clock throughput, not model-internal runtime.
  const sessions = scopedSessions.filter((x) => x.tokens > 0);
  const wallSeconds = sessions.reduce((sum, x) => {
    const first = new Date(x.first_ts).getTime();
    const last = new Date(x.last_ts).getTime();
    return sum + Math.max(1, Number.isFinite(last - first) ? (last - first) / 1000 : 0);
  }, 0);
  const tokSec = wallSeconds > 0 ? s.tokens / wallSeconds : 0;
  const cards = [
    { label: lvl === "session" ? "Session" : "Active sessions", val: String(s.sessions), sub: `${s.live} live now` },
    { label: "Running agents", val: String(s.running), sub },
    { label: "Tokens burned", val: fmtNum(s.tokens), sub },
    { label: "Token throughput", val: `${tokSec.toFixed(1)}/s`, sub: `wall-clock average across ${sub}` },
    { label: "Total cost", val: fmtCost(s.cost), sub },
  ];

  return (
    <div className="kpis">
      {cards.map((c) => (
        <div className="kpi" key={c.label}>
          <div className="kpi-top"><span className="kpi-label">{c.label}</span></div>
          <div className="kpi-val">{c.val}</div>
          <div className="kpi-sub">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}
