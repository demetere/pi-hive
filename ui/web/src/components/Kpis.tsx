import { For } from "solid-js";
import { scope, scopedStats } from "../store";
import { fmtCost, fmtNum } from "../lib/format";

export default function Kpis() {
  const cards = () => {
    const s = scopedStats();
    const lvl = scope().level;
    const sub = lvl === "fleet" ? "all projects" : lvl === "project" ? "this project" : "this session";
    return [
      { label: lvl === "session" ? "Session" : "Active sessions", val: String(s.sessions), sub: `${s.live} live now` },
      { label: "Running agents", val: String(s.running), sub },
      { label: "Tokens burned", val: fmtNum(s.tokens), sub },
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
