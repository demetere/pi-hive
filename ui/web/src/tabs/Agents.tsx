import { useMemo } from "react";
import { useHive } from "../store";
import type { ScopeAgent } from "../store";
import { viewAgent } from "../store/raw";
import { fmtCost, fmtNum, shortModel } from "../lib/format";

// Status group order: actively-running first, then those blocked waiting on a
// child, then finished, idle, errored. Within a group, keep hierarchy order.
const STATUS_RANK: Record<string, number> = { running: 0, waiting: 1, done: 2, idle: 3, error: 4 };

// Collapse per-(session,agent) rows into one row per agent name, summing
// tokens/cost/runs/tools. The representative row keeps the most-active status,
// the earliest order (stable hierarchy sort), and the first non-empty
// task/type/model/color/role seen. Used at project/fleet scope so the table
// matches the deduped "N agents" count instead of showing K copies.
function collapseByName(agents: ScopeAgent[]): ScopeAgent[] {
  const byName = new Map<string, ScopeAgent>();
  for (const a of agents) {
    const key = a.name.trim().toLowerCase();
    if (!key) continue;
    const cur = byName.get(key);
    if (!cur) {
      byName.set(key, { ...a });
      continue;
    }
    cur.tokens += a.tokens;
    cur.cost += a.cost;
    cur.runs += a.runs;
    cur.tools += a.tools;
    // Prefer the more-active status (lower rank) as the shown state.
    if ((STATUS_RANK[a.status] ?? 5) < (STATUS_RANK[cur.status] ?? 5)) cur.status = a.status;
    if (a.order < cur.order) cur.order = a.order;
    if (!cur.task && a.task) cur.task = a.task;
    if (!cur.model && a.model) cur.model = a.model;
    if (!cur.color && a.color) cur.color = a.color;
    if (!cur.role && a.role) cur.role = a.role;
    if (!cur.agentType && a.agentType) cur.agentType = a.agentType;
  }
  return Array.from(byName.values());
}

export default function Agents(props: { search: string }) {
  const scopedAgents = useHive((s) => s.scopedAgents);
  const scope = useHive((s) => s.scope);
  // Per-session rows only make sense at session scope; elsewhere collapse by name.
  const collapsed = scope.level !== "session";

  const rows = useMemo<ScopeAgent[]>(() => {
    const base = collapsed ? collapseByName(scopedAgents) : scopedAgents;
    const q = props.search.toLowerCase();
    const filtered = base.filter((r) => !q || r.name.toLowerCase().includes(q) || shortModel(r.model).toLowerCase().includes(q) || (r.role || "").toLowerCase().includes(q) || (r.agentType || "").toLowerCase().includes(q));
    return [...filtered].sort((a, b) => {
      const sr = (STATUS_RANK[a.status] ?? 5) - (STATUS_RANK[b.status] ?? 5);
      if (sr !== 0) return sr;
      return a.order - b.order;
    });
  }, [scopedAgents, props.search, collapsed]);

  return (
    <div className="tab-card">
      <table className="table">
        <thead>
          <tr>
            <th>Agent</th><th>Role</th><th>Type</th><th>Status</th><th>Model</th>
            <th className="num">Tokens</th><th className="num">Cost</th><th className="num">Runs</th><th className="num">Tools</th>
            {!collapsed && <th className="num">Context</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="clickable" onClick={() => viewAgent({ sessionId: r.session_id, name: r.name, color: r.color, status: r.status, model: r.model })}>
              <td>
                <span><span className="cdot" style={{ background: r.color || "var(--muted)" }} /><b>{r.name}</b></span>
                {r.task && <div className="muted-cell" style={{ fontSize: "11px", marginTop: "2px", maxWidth: "340px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.task}</div>}
              </td>
              <td className="muted-cell">{r.role || "member"}</td>
              <td className="muted-cell mono">{r.agentType || "—"}</td>
              <td><span className={`status-tag ${r.status}`}>{r.status}</span></td>
              <td className="muted-cell mono">{shortModel(r.model)}</td>
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
