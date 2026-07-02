import { useMemo } from "react";
import { useHive } from "../store";
import type { ScopeAgent } from "../store";
import { viewAgent } from "../store/raw";
import { fmtCost, fmtNum, shortModel } from "../lib/format";

// Status group order: actively-running first, then those blocked waiting on a
// child, then finished, idle, errored. Within a group, keep hierarchy order.
const STATUS_RANK: Record<string, number> = { running: 0, waiting: 1, done: 2, idle: 3, error: 4 };

// A displayed row: a ScopeAgent plus how many sessions it aggregates. At session
// scope that's always 1; at project/fleet scope same-named agents collapse into
// one row summing their per-session numbers.
type AgentRow = ScopeAgent & { sessions: number };

// Collapse per-(session,agent) rows into one row per agent name, summing tokens/
// cost/runs/tools and counting the sessions. The representative row keeps the
// most-active status, the shallowest depth/earliest order (for hierarchy), and
// the first non-empty task/model/color seen. Used at project/fleet scope so the
// table matches the deduped "N agents" count instead of showing K copies.
function collapseByName(agents: ScopeAgent[]): AgentRow[] {
  const byName = new Map<string, AgentRow>();
  for (const a of agents) {
    const key = a.name.trim().toLowerCase();
    if (!key) continue;
    const cur = byName.get(key);
    if (!cur) {
      byName.set(key, { ...a, sessions: 1 });
      continue;
    }
    cur.tokens += a.tokens;
    cur.cost += a.cost;
    cur.runs += a.runs;
    cur.tools += a.tools;
    cur.sessions += 1;
    // Prefer the more-active status (lower rank) as the shown state.
    if ((STATUS_RANK[a.status] ?? 5) < (STATUS_RANK[cur.status] ?? 5)) cur.status = a.status;
    // Keep the shallowest placement for hierarchy indent + sort order.
    if (a.depth < cur.depth) cur.depth = a.depth;
    if (a.order < cur.order) cur.order = a.order;
    if (!cur.task && a.task) cur.task = a.task;
    if (!cur.model && a.model) cur.model = a.model;
    if (!cur.color && a.color) cur.color = a.color;
    if (!cur.role && a.role) cur.role = a.role;
  }
  return Array.from(byName.values());
}

export default function Agents(props: { search: string }) {
  const scopedAgents = useHive((s) => s.scopedAgents);
  const scope = useHive((s) => s.scope);
  // Per-session rows only make sense at session scope; elsewhere collapse by name.
  const collapsed = scope.level !== "session";

  const rows = useMemo<AgentRow[]>(() => {
    const base: AgentRow[] = collapsed
      ? collapseByName(scopedAgents)
      : scopedAgents.map((a) => ({ ...a, sessions: 1 }));
    const q = props.search.toLowerCase();
    const filtered = base.filter((r) => !q || r.name.toLowerCase().includes(q) || shortModel(r.model).toLowerCase().includes(q) || (r.role || "").toLowerCase().includes(q));
    return filtered.sort((a, b) => {
      const sr = (STATUS_RANK[a.status] ?? 5) - (STATUS_RANK[b.status] ?? 5);
      if (sr !== 0) return sr;
      return a.order - b.order;
    });
  }, [scopedAgents, props.search, collapsed]);
  // Collapsed (project/fleet) rows show how many sessions each agent spans.
  const showSessionsCount = collapsed;

  return (
    <div className="tab-card">
      <table className="table">
        <thead>
          <tr>
            <th>Agent</th><th>Role</th><th>Status</th><th>Model</th>
            {showSessionsCount && <th className="num">Sessions</th>}
            <th className="num">Tokens</th><th className="num">Cost</th><th className="num">Runs</th><th className="num">Tools</th>
            {!collapsed && <th className="num">Context</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="clickable" onClick={() => viewAgent({ sessionId: r.session_id, name: r.name, color: r.color, status: r.status, model: r.model })}>
              <td>
                <span style={{ paddingLeft: `${r.depth * 16}px` }}><span className="cdot" style={{ background: r.color || "var(--muted)" }} /><b>{r.name}</b></span>
                {r.task && <div className="muted-cell" style={{ fontSize: "11px", marginTop: "2px", paddingLeft: `${r.depth * 16}px`, maxWidth: "340px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.task}</div>}
              </td>
              <td className="muted-cell">{r.role || "member"}</td>
              <td><span className={`status-tag ${r.status}`}>{r.status}</span></td>
              <td className="muted-cell mono">{shortModel(r.model)}</td>
              {showSessionsCount && <td className="num">{r.sessions}</td>}
              <td className="num">{fmtNum(r.tokens)}</td>
              <td className="num">{fmtCost(r.cost)}</td>
              <td className="num">{r.runs}</td>
              <td className="num">{r.tools}</td>
              {!collapsed && <td className="num">{r.contextPct != null ? `${Math.round(r.contextPct)}%` : "—"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty">No agents in this scope yet.</div>}
    </div>
  );
}
