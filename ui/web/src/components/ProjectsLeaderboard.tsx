import { createMemo, For, Show } from "solid-js";
import { projectGroups, selectProject } from "../store";
import { fmtCost, fmtNum } from "../lib/format";
import "./cards.css";

// Fleet hero: ranked projects. Click drills into a project.
export default function ProjectsLeaderboard() {
  const rows = createMemo(() => {
    return projectGroups().map((g) => {
      const tokens = g.sessions.reduce((a, s) => a + s.tokens, 0);
      const running = g.sessions.reduce((a, s) => a + s.running, 0);
      return { name: g.name, sessions: g.sessions.length, live: g.live, running, tokens, cost: g.totalCost };
    }).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  });
  const maxCost = () => Math.max(0.0001, ...rows().map((r) => r.cost));

  return (
    <div class="cards-scroll">
      <Show when={rows().length} fallback={<div class="empty">No projects yet.</div>}>
        <For each={rows()}>
          {(p) => (
            <div class="lcard" onClick={() => selectProject(p.name)}>
              <div class="lcard-top">
                <span class={`lcard-dot ${p.live ? "live" : ""}`} />
                <span class="lcard-name">{p.name}</span>
                <span class="lcard-cost">{fmtCost(p.cost)}</span>
              </div>
              <div class="lcard-bar"><span class="lcard-fill" style={{ width: `${(p.cost / maxCost()) * 100}%` }} /></div>
              <div class="lcard-meta">
                <span>{p.sessions} session{p.sessions === 1 ? "" : "s"}</span>
                <span>{p.running} running</span>
                <span>{fmtNum(p.tokens)} tok</span>
              </div>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
