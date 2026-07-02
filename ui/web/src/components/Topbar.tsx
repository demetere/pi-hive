export default function Topbar(props: { search: string; setSearch: (v: string) => void }) {
  return (
    <header className="flex items-center gap-3.5 h-[50px] shrink-0">
      <div className="font-bold text-base">Hive Telemetry</div>
      <div className="ml-2 flex-1 max-w-[420px] flex items-center gap-2 bg-panel border border-border rounded-[10px] px-3 h-9 text-muted">
        <span>⌕</span>
        <input
          className="flex-1 bg-transparent border-0 text-fg font-[inherit] outline-none"
          placeholder="Search sessions, agents, events…"
          value={props.search}
          onChange={(e) => props.setSearch(e.target.value)}
        />
      </div>
    </header>
  );
}
