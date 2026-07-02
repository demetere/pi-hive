import { For } from "solid-js";
import {
  activeTab, connection, projectGroups, scope, selectFleet, selectProject,
  theme, setTheme, setActiveTab,
} from "../store";

const TABS = [
  { id: "overview", label: "Overview", icon: "⌂" },
  { id: "sessions", label: "Sessions", icon: "▤" },
  { id: "activity", label: "Activity", icon: "↯" },
  { id: "plans", label: "Plans", icon: "☷" },
  { id: "cost", label: "Cost", icon: "$" },
];

export default function Sidebar() {
  const scopeValue = () => {
    const s = scope();
    return s.level === "fleet" ? "__fleet" : s.project;
  };
  const live = () => connection() === "live";

  function chooseProject(value: string) {
    if (value === "__fleet") selectFleet();
    else selectProject(value);
  }

  return (
    <nav class="sidebar">
      <div class="side-brand"><span class="logo">◆</span><span>pi-hive</span></div>

      <div class="scope-picker">
        <label>Project</label>
        <select value={scopeValue()} onChange={(e) => chooseProject(e.currentTarget.value)}>
          <option value="__fleet">All projects</option>
          <For each={projectGroups()}>{(g) => <option value={g.name}>{g.live ? "● " : ""}{g.name}</option>}</For>
        </select>
      </div>

      <div class="side-section">Navigate</div>
      <div class="nav-tabs" role="tablist" aria-label="Dashboard sections">
        <For each={TABS}>
          {(t) => (
            <button
              class={`nav-tab ${activeTab() === t.id ? "active" : ""}`}
              role="tab"
              aria-selected={activeTab() === t.id}
              onClick={() => setActiveTab(t.id)}
            >
              <span class="si-ic">{t.icon}</span><span class="si-name">{t.label}</span>
            </button>
          )}
        </For>
      </div>

      <div class="side-foot">
        <div class="status-line"><span class="live-pip" style={{ background: live() ? "var(--ok)" : "var(--muted)" }} />{connection()}</div>
        <button class="theme-toggle" title="Toggle theme" onClick={() => setTheme(theme() === "dark" ? "light" : "dark")}>
          {theme() === "dark" ? "☀" : "☾"}
        </button>
      </div>
    </nav>
  );
}
