import { For } from "solid-js";
import { scope, scopedSessions, scopedStats } from "../store";
import { fmtCost, fmtNum } from "../lib/format";

export default function Kpis() {
  const cards = () => {
    const s = scopedStats();
    const lvl = scope().level;
    const sub = lvl === "fleet" ? "all projects" : lvl === "project" ? "this project" : "this session";
    // Wall-clock throughput, not model-internal runtime. Agent elapsedMs can be
    // much smaller than the real session window and makes huge prompts look like
    // impossible 1k+ tok/s bursts. For overview, use session first→last time.
    const sessions = scopedSessions().filter((x) => x.tokens > 0);
    const wallSeconds = sessions.reduce((sum, x) => {
      const first = new Date(x.first_ts).getTime();
      const last = new Date(x.last_ts).getTime();
      return sum + Math.max(1, Number.isFinite(last - first) ? (last - first) / 1000 : 0);
    }, 0);
    const tokSec = wallSeconds > 0 ? s.tokens / wallSeconds : 0;
    return [
      { label: lvl === "session" ? "Session" : "Active sessions", val: String(s.sessions), sub: `${s.live} live now` },
      { label: "Running agents", val: String(s.running), sub },
      { label: "Tokens burned", val: fmtNum(s.tokens), sub },
      { label: "Token throughput", val: `${tokSec.toFixed(1)}/s`, sub: `wall-clock average across ${sub}` },
      { label: "Total cost", val: fmtCost(s.cost), sub },
    ];
  };
  return (
    <div class="kpis">
      <For each={cards()}>
        {(c) => (
          <div class="kpi">
            <div class="kpi-top"><span class="kpi-label">{c.label}</span></div>
            <div class="kpi-val">{c.val}</div>
            <div class="kpi-sub">{c.sub}</div>
          </div>
        )}
      </For>
    </div>
  );
}
