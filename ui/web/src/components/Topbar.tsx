export default function Topbar(props: { search: string; setSearch: (v: string) => void }) {
  return (
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
    </header>
  );
}
