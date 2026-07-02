import { Fragment, lazy, Suspense, useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useHive } from "../store";
import { deleteSession, selectSessionScope, setActiveTab, confirmAction } from "../store/raw";
import { ensureTopologyDetail } from "../store/wiring";
import { useFrozenOrder } from "../hooks/useFrozenOrder";
import RelTime from "../hooks/RelTime";
import { absTime, fmtCost, fmtNum, sessionSlug } from "../lib/format";
import type { SessionView } from "../types";

// Lazy like Overview does, so the d3-hierarchy chunk only loads when the
// topology-version modal is actually opened (keeps the code-split intact).
const TopologyGraph = lazy(() => import("../components/TopologyGraph"));

type Key = "project" | "first_ts" | "last_ts" | "running" | "event_count" | "tokens" | "cost";

export default function Sessions(props: { search: string }) {
  const sessions = useHive((s) => s.sessions);
  const scope = useHive((s) => s.scope);
  const liveSet = useHive((s) => s.liveSet);
  const projectGroups = useHive((s) => s.projectGroups);
  const sessionSummaries = useHive((s) => s.sessionSummaries);
  const topologiesByCwd = useHive((s) => s.topologiesByCwd);
  // The topology whose versioned tree is open in the modal (K2), or null.
  const [openTopoHash, setOpenTopoHash] = useState<string | null>(null);

  // Server-authoritative topology hash for a session (K2).
  const hashOf = useCallback((s: SessionView): string | undefined => sessionSummaries.get(s.session_id)?.topologyHash, [sessionSummaries]);
  // The DB's true "events ever ingested" count. `s.event_count` only counts the
  // events currently loaded in the ~1000-row window (derive.ts), so both the
  // Events column and the destructive delete-confirmation would understate the
  // real row count. Prefer the server summary; fall back to the window count
  // only until the summary arrives.
  const countOf = useCallback((s: SessionView): number => sessionSummaries.get(s.session_id)?.event_count ?? s.event_count, [sessionSummaries]);
  // "vN" rank of a hash within its cwd — the 1-based index of the version by
  // first_seen_at (topologiesByCwd is already ordered that way). undefined if the
  // versions for that cwd aren't loaded yet or the hash isn't among them.
  const versionRankOf = useCallback((s: SessionView): number | undefined => {
    const hash = hashOf(s);
    if (!hash || !s.cwd) return undefined;
    const versions = topologiesByCwd.get(s.cwd);
    if (!versions) return undefined;
    const idx = versions.findIndex((v) => v.hash === hash);
    return idx >= 0 ? idx + 1 : undefined;
  }, [hashOf, topologiesByCwd]);

  function openTopology(hash: string) {
    void ensureTopologyDetail(hash);
    setOpenTopoHash(hash);
  }

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
      message: <>This permanently removes telemetry for <b>{s.project} · {sessionSlug(s.session_id)}</b> ({countOf(s)} events). The project's own logs on disk are not touched.</>,
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
    // Sort the Events column by the same authoritative count the cell renders,
    // not the window-local count on the row object.
    const va = sortKey === "event_count" ? countOf(a) : (a[sortKey] as any);
    const vb = sortKey === "event_count" ? countOf(b) : (b[sortKey] as any);
    const cmp = typeof va === "string" ? String(va).localeCompare(String(vb)) : (va - vb);
    return cmp * dir;
  }, [sortKey, dir, countOf]);
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
          {rows.map((s, i) => {
            const rank = versionRankOf(s);
            const hash = hashOf(s);
            // "topology changed" divider between adjacent rows in the SAME cwd
            // whose topology hash differs (K2). Only meaningful when both hashes
            // are known and the rows belong to the same project working dir.
            const prev = rows[i - 1];
            const prevHash = prev ? hashOf(prev) : undefined;
            const showDivider = !!prev && !!hash && !!prevHash && hash !== prevHash && prev.cwd === s.cwd && !!s.cwd;
            return (
            <Fragment key={s.session_id}>
            {showDivider && (
              <tr className="topo-divider" aria-hidden="true">
                <td colSpan={9} style={{ padding: "2px 10px" }}>
                  <span className="text-[10px] text-wait italic">◇ topology changed</span>
                </td>
              </tr>
            )}
            <tr className={selectedId === s.session_id ? "active" : ""} onClick={() => openSession(s.session_id)}>
              <td><span className={`dot ${liveSet.has(s.session_id) ? "live" : "idle"}`} /><b>{labelOf(s.project)}</b></td>
              <td className="mono">
                {sessionSlug(s.session_id)}
                {rank != null && hash && (
                  <button
                    className="ml-1.5 inline-flex items-center rounded-full bg-well border border-line px-1.5 py-[1px] text-[9px] text-ink-dim hover:text-ink hover:border-brand"
                    title="View this session's topology version"
                    onClick={(e) => { e.stopPropagation(); openTopology(hash); }}
                  >
                    topology v{rank}
                  </button>
                )}
              </td>
              <td className="muted-cell">{absTime(s.first_ts)}</td>
              <td className="num">{s.running}</td>
              <td className="num">{countOf(s)}</td>
              <td className="num">{fmtNum(s.tokens)}</td>
              <td className="num">{fmtCost(s.cost)}</td>
              <td className="num muted-cell"><RelTime ts={s.last_ts} /></td>
              <td className="del-col" onClick={(e) => e.stopPropagation()}>
                <button className="row-del" title="Delete session telemetry" onClick={(e) => askDelete(s, e)}>🗑</button>
              </td>
            </tr>
            </Fragment>
            );
          })}
        </tbody>
      </table>
      {!rows.length && <div className="empty">No sessions match.</div>}
      {openTopoHash && <TopologyVersionModal hash={openTopoHash} onClose={() => setOpenTopoHash(null)} />}
    </div>
  );
}

// K2: modal showing one session's versioned topology tree, reusing TopologyGraph
// with live statuses off (this is a historical version, not a running session).
function TopologyVersionModal({ hash, onClose }: { hash: string; onClose: () => void }) {
  const detail = useHive((s) => s.topologyByHash.get(hash));
  // Reassemble the reassembled tree into the TopoSource TopologyGraph consumes.
  const source = useMemo(() => {
    if (!detail) return undefined;
    const active: "hive" | "planning" = detail.hive?.orchestrator || detail.hive?.agents?.length ? "hive" : "planning";
    return { session_id: "", topologies: { active, hive: detail.hive, planning: detail.planning } as any, agents: new Map() };
  }, [detail]);
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="rounded-xl border border-line bg-panel p-4 w-[80vw] h-[80vh] max-w-[1100px] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2 flex-none">
          <b className="text-[13px]">Topology version <span className="font-mono text-ink-dim">{hash.slice(0, 10)}</span></b>
          <button className="text-ink-dim text-[12px] hover:text-ink" onClick={onClose}>✕ close</button>
        </div>
        <div className="flex-1 min-h-0">
          {!detail || !source ? <div className="empty">Loading topology…</div>
            : <Suspense fallback={<div className="g-empty">Loading topology…</div>}><TopologyGraph source={source} statusMode="none" /></Suspense>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
