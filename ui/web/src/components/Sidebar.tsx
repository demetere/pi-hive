import { useHive } from "../store";
import { selectFleet, selectProject, setActiveTab, setTheme } from "../store/raw";

const TABS = [
  { id: "overview", label: "Overview", icon: "⌂" },
  { id: "sessions", label: "Sessions", icon: "▤" },
  { id: "activity", label: "Activity", icon: "↯" },
  { id: "plans", label: "Plans", icon: "☷" },
  { id: "cost", label: "Cost", icon: "$" },
];

export default function Sidebar() {
  const scope = useHive((s) => s.scope);
  const activeTab = useHive((s) => s.activeTab);
  const connection = useHive((s) => s.connection);
  const theme = useHive((s) => s.theme);
  const projectGroups = useHive((s) => s.projectGroups);

  const scopeValue = scope.level === "fleet" ? "__fleet" : scope.project;
  const live = connection === "live";

  function chooseProject(value: string) {
    if (value === "__fleet") selectFleet();
    else selectProject(value);
  }

  return (
    <nav className="bg-panel border border-border rounded-2xl flex flex-col p-[14px_12px] overflow-hidden min-h-0">
      <div className="flex items-center gap-[9px] font-bold text-[15px] px-2 pt-1 pb-3.5">
        <span className="text-accent [filter:drop-shadow(0_0_8px_var(--accent-glow))]">◆</span>
        <span>pi-hive</span>
      </div>

      <div className="mx-1 mb-2 p-2.5 border border-border rounded-xl bg-chip">
        <label className="block text-muted text-[10.5px] font-extrabold uppercase tracking-[.8px] mb-1.5">Project</label>
        <select
          className="w-full min-w-0 bg-panel border border-border text-fg rounded-[9px] px-2.5 py-2 font-semibold outline-none focus:border-accent-border focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          value={scopeValue}
          onChange={(e) => chooseProject(e.target.value)}
        >
          <option value="__fleet">All projects</option>
          {projectGroups.map((g) => (
            <option key={g.name} value={g.name}>{g.live ? "● " : ""}{g.name}</option>
          ))}
        </select>
      </div>

      <div className="text-muted text-[10.5px] font-bold uppercase tracking-[.8px] px-[9px] pt-3.5 pb-1.5">Navigate</div>
      <div className="flex flex-col gap-1 mb-1" role="tablist" aria-label="Dashboard sections">
        {TABS.map((t) => {
          const on = activeTab === t.id;
          return (
            <button
              key={t.id}
              className={`flex items-center gap-2.5 w-full px-2.5 py-[9px] border rounded-[11px] font-bold cursor-pointer text-left transition-[background,color,border-color,transform] duration-[.14s] ${
                on ? "bg-accent-soft text-accent-fg border-accent-border shadow-[0_0_0_1px_var(--accent-soft)]"
                   : "border-transparent bg-transparent text-fg2 hover:bg-hover hover:text-fg hover:translate-x-px"
              }`}
              role="tab"
              aria-selected={on}
              onClick={() => setActiveTab(t.id)}
            >
              <span className="w-[18px] text-center opacity-85 shrink-0">{t.icon}</span>
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{t.label}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-auto shrink-0 flex items-center gap-[9px] px-2 pt-2.5 pb-1 border-t border-border">
        <div className="min-w-0 inline-flex items-center gap-[7px] text-fg2 text-xs font-bold capitalize">
          <span className="w-2 h-2 rounded-full animate-ping2" style={{ background: live ? "var(--ok)" : "var(--muted)" }} />
          {connection}
        </div>
        <button
          className="ml-auto bg-chip border border-border rounded-lg text-fg2 cursor-pointer px-[7px] py-1 text-[13px]"
          title="Toggle theme"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
      </div>
    </nav>
  );
}
