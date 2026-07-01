import { connection, activeTab, setActiveTab } from "../store";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "sessions", label: "Sessions" },
  { id: "agents", label: "Agents" },
  { id: "plans", label: "Plans" },
  { id: "activity", label: "Activity" },
  { id: "cost", label: "Cost" },
];

export default function Topbar(props: { search: string; setSearch: (v: string) => void }) {
  const live = () => connection() === "live";
  return (
    <>
      <header class="topbar">
        <div class="tb-title">Hive Telemetry</div>
        <div class="tb-search">
          <span>⌕</span>
          <input
            placeholder="Search sessions, agents, events…"
            value={props.search}
            onInput={(e) => props.setSearch(e.currentTarget.value)}
          />
        </div>
        <button class={`btn ghost ${live() ? "" : "off"}`} title={connection()}>
          <span class="live-pip" style={{ background: live() ? "var(--ok)" : "var(--muted)" }} />
          {connection()}
        </button>
      </header>
      <div class="tabs">
        {TABS.map((t) => (
          <button class={`tab ${activeTab() === t.id ? "active" : ""}`} onClick={() => setActiveTab(t.id)}>{t.label}</button>
        ))}
      </div>
    </>
  );
}
