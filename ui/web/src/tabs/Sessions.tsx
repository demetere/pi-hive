import { useCallback, useMemo, useState } from "react";
import { useHive } from "../store";
import { deleteSession, selectSessionScope, setActiveTab, confirmAction } from "../store/raw";
import { useFrozenOrder } from "../hooks/useFrozenOrder";
import RelTime from "../hooks/RelTime";
import { absTime, fmtCost, fmtNum, sessionSlug } from "../lib/format";
import type { SessionView } from "../types";

type Key = "project" | "first_ts" | "last_ts" | "running" | "event_count" | "tokens" | "cost";

export default function Sessions(props: { search: string }) {
  const sessions = useHive((s) => s.sessions);
  const scope = useHive((s) => s.scope);
  const liveSet = useHive((s) => s.liveSet);
  const projectGroups = useHive((s) => s.projectGroups);

  // The Sessions tab lists every session for the CURRENT project (or all
  // projects at fleet scope). It never collapses to a single row when one
  // session is drilled into — the active session is highlighted instead, so you
  // can pick another. Session scope still narrows the OTHER tabs.
  const listSessions = useMemo<SessionView[]>(() => {
    if (scope.level === "fleet") return sessions;
    return sessions.filter((s) => s.project === scope.project);
  }, [sessions, scope]);
  const selectedId = scope.level === "session" ? scope.sessionId : "";

  // Derived project name → display label (honors renames from settings).
  const labelOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of projectGroups) m.set(g.name, g.label);
    return (project: string) => m.get(project) || project;
  }, [projectGroups]);

  const [sortKey, setSortKey] = useState<Key>("last_ts");
  const [dir, setDir] = useState<1 | -1>(-1);

  function clickSort(k: Key) {
    if (sortKey === k) setDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setDir(k === "project" ? 1 : -1); }
  }

  function askDelete(s: SessionView, e: React.MouseEvent) {
    e.stopPropagation();
    confirmAction({
      title: "Delete session telemetry?",
      danger: true,
      confirmLabel: "Delete session",
      message: <>This permanently removes telemetry for <b>{s.project} · {sessionSlug(s.session_id)}</b> ({s.event_count} events). The project's own logs on disk are not touched.</>,
      onConfirm: () => deleteSession(s.session_id),
    });
  }

  const filtered = useMemo<SessionView[]>(() => {
    const q = props.search.toLowerCase();
    return listSessions.filter((s) => !q || s.project.toLowerCase().includes(q) || s.session_id.toLowerCase().includes(q) || (s.cwd || "").toLowerCase().includes(q));
  }, [listSessions, props.search]);

  // Click a session → scope to it AND jump to its Overview.
  function openSession(id: string) {
    selectSessionScope(id);
    setActiveTab("overview");
  }

  const resortKey = sortKey + ":" + dir + "|" + filtered.map((s) => s.session_id).slice().sort().join(",");
  const idOf = useCallback((s: SessionView) => s.session_id, []);
  const sorter = useCallback((a: SessionView, b: SessionView) => {
    const va = a[sortKey] as any, vb = b[sortKey] as any;
    const cmp = typeof va === "string" ? String(va).localeCompare(String(vb)) : (va - vb);
    return cmp * dir;
  }, [sortKey, dir]);
  const rows = useFrozenOrder(filtered, idOf, resortKey, sorter);

  const arrow = (k: Key) => (sortKey === k ? <span className="arrow">{dir === 1 ? "↑" : "↓"}</span> : null);

  return (
    <div className="tab-card">
      <table className="table">
        <thead>
          <tr>
            <th onClick={() => clickSort("project")}>Project {arrow("project")}</th>
            <th>Session</th>
            <th onClick={() => clickSort("first_ts")}>Started {arrow("first_ts")}</th>
            <th onClick={() => clickSort("running")} className="num">Running {arrow("running")}</th>
            <th onClick={() => clickSort("event_count")} className="num">Events {arrow("event_count")}</th>
            <th onClick={() => clickSort("tokens")} className="num">Tokens {arrow("tokens")}</th>
            <th onClick={() => clickSort("cost")} className="num">Cost {arrow("cost")}</th>
            <th onClick={() => clickSort("last_ts")} className="num">Updated {arrow("last_ts")}</th>
            <th className="del-col" />
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.session_id} className={selectedId === s.session_id ? "active" : ""} onClick={() => openSession(s.session_id)}>
              <td><span className={`dot ${liveSet.has(s.session_id) ? "live" : "idle"}`} /><b>{labelOf(s.project)}</b></td>
              <td className="mono">{sessionSlug(s.session_id)}</td>
              <td className="muted-cell">{absTime(s.first_ts)}</td>
              <td className="num">{s.running}</td>
              <td className="num">{s.event_count}</td>
              <td className="num">{fmtNum(s.tokens)}</td>
              <td className="num">{fmtCost(s.cost)}</td>
              <td className="num muted-cell"><RelTime ts={s.last_ts} /></td>
              <td className="del-col" onClick={(e) => e.stopPropagation()}>
                <button className="row-del" title="Delete session telemetry" onClick={(e) => askDelete(s, e)}>🗑</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty">No sessions match.</div>}
    </div>
  );
}
