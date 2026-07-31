import { HiveMark, NavIcon } from "../dashboard/brand";
import { NAV_GROUPS, VIEW_TITLES } from "../dashboard/navigation";
import type { DashboardShellProps } from "./dashboard-shell";
import { ConnectionStatus, ProjectSelector, ThemeSelector } from "./shell-controls";

export default function SoftSignalShell(props: DashboardShellProps) {
  return <div className="workflow-dashboard dashboard-frame renderer-soft-signal">
    <a className="skip-link" href="#workflow-content" onClick={(event) => { event.preventDefault(); document.getElementById("workflow-content")?.focus(); }}>Skip to content</a>
    <aside className="dashboard-sidebar">
      <div className="sidebar-brand"><HiveMark /><div><strong>pi-hive</strong><span>Mission control</span></div></div>
      <ProjectSelector value={props.projectScope} options={props.projectOptions} onChange={props.onProjectChange} />
      <nav aria-label="Workflow dashboard views">{NAV_GROUPS.map((group) => <div className="nav-group" key={group.label}><span className="nav-group-label">{group.label}</span>{group.views.map((entry) => <button type="button" aria-label={VIEW_TITLES[entry]} aria-current={entry === props.view ? "page" : undefined} key={entry} onClick={() => props.onNavigate(entry)}><NavIcon view={entry} /><span>{VIEW_TITLES[entry]}</span>{props.navCounts[entry] !== undefined && <small aria-hidden="true">{props.navCounts[entry]}</small>}</button>)}</div>)}</nav>
      <div className="sidebar-footer"><ConnectionStatus state={props.streamState} /><ThemeSelector value={props.themeId} onChange={props.onThemeChange} /></div>
    </aside>
    <div className="dashboard-main">
      <header className="dashboard-topbar"><div><span className={`topbar-live ${props.streamState}`}><i />{props.streamState}</span><span className="topbar-divider" /><span className="topbar-project">{props.projectLabel}</span></div><time dateTime={props.now.toISOString()}>{props.now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></header>
      <main id="workflow-content" tabIndex={-1}>{props.children}</main>
    </div>
  </div>;
}
