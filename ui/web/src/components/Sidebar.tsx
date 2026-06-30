import { createSignal, For, Show } from "solid-js";
import {
  projectGroups, scope, selectFleet, selectProject, selectSessionScope,
  deleteSession, deleteProject, fleetStats, theme, setTheme,
} from "../store";
import { confirmAction } from "./ConfirmModal";
import { absTime, fmtCost, relTime, sessionSlug } from "../lib/format";
import { isLive, now } from "../store";
import type { SessionView } from "../types";

export default function Sidebar() {
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());

  const isExpanded = (p: string) => expanded().has(p);
  function toggleExpand(p: string, e: MouseEvent) {
    e.stopPropagation();
    setExpanded((prev) => { const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); return n; });
  }

  const projActive = (p: string) => { const s = scope(); return (s.level === "project" || s.level === "session") && s.project === p; };
  const sesActive = (id: string) => { const s = scope(); return s.level === "session" && s.sessionId === id; };

  function askDeleteSession(s: SessionView, e: MouseEvent) {
    e.stopPropagation();
    confirmAction({
      title: "Delete session telemetry?",
      danger: true,
      confirmLabel: "Delete session",
      message: <>This permanently removes telemetry for <b>{s.project} · {sessionSlug(s.session_id)}</b> ({s.event_count} events). The project's own logs on disk are not touched.</>,
      onConfirm: () => deleteSession(s.session_id),
    });
  }
  function askDeleteProject(name: string, count: number, e: MouseEvent) {
    e.stopPropagation();
    confirmAction({
      title: "Delete project telemetry?",
      danger: true,
      confirmLabel: "Delete project",
      message: <>This permanently removes telemetry for <b>all {count} session{count === 1 ? "" : "s"}</b> in <b>{name}</b>. The project's own logs on disk are not touched.</>,
      onConfirm: () => deleteProject(name),
    });
  }

  return (
    <nav class="sidebar">
      <div class="side-brand"><span class="logo">◆</span><span>pi-hive</span></div>

      <div class="side-list" style={{ "margin-bottom": "6px" }}>
        <button class={`side-item ${scope().level === "fleet" ? "active" : ""}`} onClick={selectFleet}>
          <span class="si-ic">▣</span><span class="si-name">Overview</span>
          <span class="si-badge">{fleetStats().sessions}</span>
        </button>
      </div>

      <div class="side-section">Projects</div>
      <div class="side-list">
        <For each={projectGroups()}>
          {(g) => {
            return (
              <div class="proj-block">
                <div class={`side-item proj ${projActive(g.name) ? "active" : ""}`} onClick={() => selectProject(g.name)}>
                  <span class="si-ic disc" onClick={(e) => toggleExpand(g.name, e)}>{isExpanded(g.name) ? "▾" : "▸"}</span>
                  <span class="proj-status">{g.live ? "◉" : "◌"}</span>
                  <span class="si-name">{g.name}</span>
                  <span class="si-badge" classList={{ on: g.live }}>{g.sessions.length}</span>
                  <button class="row-del" title="Delete project telemetry" onClick={(e) => askDeleteProject(g.name, g.sessions.length, e)}>🗑</button>
                </div>

                <Show when={isExpanded(g.name)}>
                  <div class="ses-list">
                    <For each={g.sessions}>
                      {(s) => (
                        <div class={`ses-item ${sesActive(s.session_id) ? "active" : ""}`} onClick={() => selectSessionScope(s.session_id)}>
                          <span class={`ses-dot ${isLive(s.session_id) ? "live" : "idle"}`} />
                          <span class="ses-label">
                            <span class="ses-id">{sessionSlug(s.session_id)} <span class="ses-start">{absTime(s.first_ts)}</span></span>
                            <span class="ses-meta">{isLive(s.session_id) ? `${s.running} running · ` : ""}{fmtCost(s.cost)} · {relTime(s.last_ts, now())}</span>
                          </span>
                          <button class="row-del" title="Delete session telemetry" onClick={(e) => askDeleteSession(s, e)}>🗑</button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
        <Show when={!projectGroups().length}><div class="empty" style={{ padding: "16px", "font-size": "12px" }}>No hive sessions yet.</div></Show>
      </div>

      <div class="side-foot">
        <div class="avatar">PH</div>
        <div class="side-foot-meta"><b>pi-hive</b><small>operator</small></div>
        <button class="theme-toggle" title="Toggle theme" onClick={() => setTheme(theme() === "dark" ? "light" : "dark")}>
          {theme() === "dark" ? "☀" : "☾"}
        </button>
      </div>
    </nav>
  );
}
