import { createMemo, For, Show } from "solid-js";
import { scopedAgents, scope, viewAgent } from "../store";
import { fmtCost, fmtNum, sessionSlug, shortModel } from "../lib/format";
import "./tabs.css";

// Status group order: actively-running first, then those blocked waiting on a
// child, then finished, idle, errored. Within a group, keep hierarchy order.
const STATUS_RANK: Record<string, number> = { running: 0, waiting: 1, done: 2, idle: 3, error: 4 };

export default function Agents(props: { search: string }) {
  const rows = createMemo(() => {
    const q = props.search.toLowerCase();
    const filtered = scopedAgents().filter((r) => !q || r.name.toLowerCase().includes(q) || shortModel(r.model).toLowerCase().includes(q) || (r.role || "").toLowerCase().includes(q));
    return [...filtered].sort((a, b) => {
      const sr = (STATUS_RANK[a.status] ?? 5) - (STATUS_RANK[b.status] ?? 5);
      if (sr !== 0) return sr;
      return a.order - b.order; // hierarchy order within a status group
    });
  });
  const showSession = () => scope().level !== "session";

  return (
    <div class="tab-card">
      <table class="table">
        <thead>
          <tr>
            <th>Agent</th><th>Role</th><th>Status</th><th>Model</th>
            <Show when={showSession()}><th>Session</th></Show>
            <th class="num">Tokens</th><th class="num">Cost</th><th class="num">Runs</th><th class="num">Tools</th><th class="num">Context</th>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(r) => (
              <tr class="clickable" onClick={() => viewAgent({ sessionId: r.session_id, name: r.name, color: r.color, status: r.status, model: r.model })}>
                <td><span style={{ "padding-left": `${r.depth * 16}px` }}><span class="cdot" style={{ background: r.color || "var(--muted)" }} /><b>{r.name}</b></span><Show when={r.task}><div class="muted-cell" style={{ "font-size": "11px", "margin-top": "2px", "padding-left": `${r.depth * 16}px`, "max-width": "340px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{r.task}</div></Show></td>
                <td class="muted-cell">{r.role || "member"}</td>
                <td><span class={`status-tag ${r.status}`}>{r.status}</span></td>
                <td class="muted-cell mono">{shortModel(r.model)}</td>
                <Show when={showSession()}><td class="muted-cell mono">{sessionSlug(r.session_id)}</td></Show>
                <td class="num">{fmtNum(r.tokens)}</td>
                <td class="num">{fmtCost(r.cost)}</td>
                <td class="num">{r.runs}</td>
                <td class="num">{r.tools}</td>
                <td class="num">{r.contextPct != null ? `${Math.round(r.contextPct)}%` : "—"}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={!rows().length}><div class="empty">No agents in this scope yet.</div></Show>
    </div>
  );
}
