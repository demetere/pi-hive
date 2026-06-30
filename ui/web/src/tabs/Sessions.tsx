import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { scopedSessions, scope, selectSessionScope, deleteSession, isLive, now } from "../store";
import { confirmAction } from "../components/ConfirmModal";
import { absTime, fmtCost, fmtNum, relTime, sessionSlug } from "../lib/format";
import type { SessionView } from "../types";
import "./tabs.css";

type Key = "project" | "first_ts" | "last_ts" | "running" | "event_count" | "tokens" | "cost";

export default function Sessions(props: { search: string }) {
  const [sortKey, setSortKey] = createSignal<Key>("last_ts");
  const [dir, setDir] = createSignal<1 | -1>(-1);

  function clickSort(k: Key) {
    if (sortKey() === k) setDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setDir(k === "project" ? 1 : -1); }
  }

  function askDelete(s: SessionView, e: MouseEvent) {
    e.stopPropagation();
    confirmAction({
      title: "Delete session telemetry?",
      danger: true,
      confirmLabel: "Delete session",
      message: <>This permanently removes telemetry for <b>{s.project} · {sessionSlug(s.session_id)}</b> ({s.event_count} events). The project's own logs on disk are not touched.</>,
      onConfirm: () => deleteSession(s.session_id),
    });
  }

  // The visible set, filtered by search (no sort here).
  const filtered = createMemo<SessionView[]>(() => {
    const q = props.search.toLowerCase();
    return scopedSessions().filter((s) => !q || s.project.toLowerCase().includes(q) || s.session_id.toLowerCase().includes(q) || (s.cwd || "").toLowerCase().includes(q));
  });

  // Frozen row order: recomputed ONLY when the sort (key/dir), the search, or the
  // SET of sessions changes — NOT when a session's values change on a live
  // snapshot. This keeps rows from jumping/reordering (and "flashing") every
  // update; values still refresh in place. A manual sort-column click re-sorts.
  const [order, setOrder] = createSignal<string[]>([]);
  const resortKey = createMemo(() => sortKey() + ":" + dir() + "|" + filtered().map((s) => s.session_id).slice().sort().join(","));
  createEffect(on(resortKey, () => {
    const k = sortKey(), d = dir();
    const sorted = [...filtered()].sort((a, b) => {
      const va = a[k] as any, vb = b[k] as any;
      const cmp = typeof va === "string" ? String(va).localeCompare(String(vb)) : (va - vb);
      return cmp * d;
    });
    setOrder(sorted.map((s) => s.session_id));
  }));

  const rows = createMemo<SessionView[]>(() => {
    const byId = new Map(filtered().map((s) => [s.session_id, s]));
    const ordered = order().map((id) => byId.get(id)).filter(Boolean) as SessionView[];
    // include any brand-new session not yet in the frozen order, appended
    for (const s of filtered()) if (!order().includes(s.session_id)) ordered.push(s);
    return ordered;
  });

  const arrow = (k: Key) => (sortKey() === k ? <span class="arrow">{dir() === 1 ? "↑" : "↓"}</span> : null);

  return (
    <div class="tab-card">
      <table class="table">
        <thead>
          <tr>
            <th onClick={() => clickSort("project")}>Project {arrow("project")}</th>
            <th>Session</th>
            <th onClick={() => clickSort("first_ts")}>Started {arrow("first_ts")}</th>
            <th onClick={() => clickSort("running")} class="num">Running {arrow("running")}</th>
            <th onClick={() => clickSort("event_count")} class="num">Events {arrow("event_count")}</th>
            <th onClick={() => clickSort("tokens")} class="num">Tokens {arrow("tokens")}</th>
            <th onClick={() => clickSort("cost")} class="num">Cost {arrow("cost")}</th>
            <th onClick={() => clickSort("last_ts")} class="num">Updated {arrow("last_ts")}</th>
            <th class="del-col" />
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(s) => (
              <tr class={scope().level === "session" && (scope() as any).sessionId === s.session_id ? "active" : ""} onClick={() => selectSessionScope(s.session_id)}>
                <td><span class={`dot ${isLive(s.session_id) ? "live" : "idle"}`} /><b>{s.project}</b></td>
                <td class="mono">{sessionSlug(s.session_id)}</td>
                <td class="muted-cell">{absTime(s.first_ts)}</td>
                <td class="num">{s.running}</td>
                <td class="num">{s.event_count}</td>
                <td class="num">{fmtNum(s.tokens)}</td>
                <td class="num">{fmtCost(s.cost)}</td>
                <td class="num muted-cell">{relTime(s.last_ts, now())}</td>
                <td class="del-col" onClick={(e) => e.stopPropagation()}>
                  <button class="row-del" title="Delete session telemetry" onClick={(e) => askDelete(s, e)}>🗑</button>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={!rows().length}><div class="empty">No sessions match.</div></Show>
    </div>
  );
}
