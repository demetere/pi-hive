import { useMemo } from "react";
import { useHive } from "../store";
import { viewAgent } from "../store/raw";
import { fmtCost, fmtNum, sessionSlug, shortModel } from "../lib/format";

// Status group order: actively-running first, then those blocked waiting on a
// child, then finished, idle, errored. Within a group, keep hierarchy order.
const STATUS_RANK: Record<string, number> = { running: 0, waiting: 1, done: 2, idle: 3, error: 4 };

export default function Agents(props: { search: string }) {
  const scopedAgents = useHive((s) => s.scopedAgents);
  const scope = useHive((s) => s.scope);

  const rows = useMemo(() => {
    const q = props.search.toLowerCase();
    const filtered = scopedAgents.filter((r) => !q || r.name.toLowerCase().includes(q) || shortModel(r.model).toLowerCase().includes(q) || (r.role || "").toLowerCase().includes(q));
    return [...filtered].sort((a, b) => {
      const sr = (STATUS_RANK[a.status] ?? 5) - (STATUS_RANK[b.status] ?? 5);
      if (sr !== 0) return sr;
      return a.order - b.order;
    });
  }, [scopedAgents, props.search]);
  const showSession = scope.level !== "session";

  return (
    <div className="tab-card">
      <table className="table">
        <thead>
          <tr>
            <th>Agent</th><th>Role</th><th>Status</th><th>Model</th>
            {showSession && <th>Session</th>}
            <th className="num">Tokens</th><th className="num">Cost</th><th className="num">Runs</th><th className="num">Tools</th><th className="num">Context</th>
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
              {showSession && <td className="muted-cell mono">{sessionSlug(r.session_id)}</td>}
              <td className="num">{fmtNum(r.tokens)}</td>
              <td className="num">{fmtCost(r.cost)}</td>
              <td className="num">{r.runs}</td>
              <td className="num">{r.tools}</td>
              <td className="num">{r.contextPct != null ? `${Math.round(r.contextPct)}%` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty">No agents in this scope yet.</div>}
    </div>
  );
}
