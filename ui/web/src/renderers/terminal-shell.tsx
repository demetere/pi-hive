import { HiveMark, NavIcon } from "../dashboard/brand";
import { NAV_GROUPS, VIEW_TITLES } from "../dashboard/navigation";
import type { DashboardShellProps } from "./dashboard-shell";
import { ConnectionStatus, ProjectSelector, ThemeSelector } from "./shell-controls";

export default function TerminalShell(props: DashboardShellProps) {
  return <div className="workflow-dashboard terminal-frame renderer-terminal">
    <a className="skip-link" href="#workflow-content" onClick={(event) => { event.preventDefault(); document.getElementById("workflow-content")?.focus(); }}>Skip to content</a>
    <header className="terminal-header">
      <div className="terminal-brand"><HiveMark compact /><span><strong>PI-HIVE</strong><small>OPERATIONS CONSOLE</small></span></div>
      <ProjectSelector value={props.projectScope} options={props.projectOptions} onChange={props.onProjectChange} />
      <div className="terminal-status"><ConnectionStatus state={props.streamState} showAddress={false} /><time dateTime={props.now.toISOString()}>{props.now.toLocaleTimeString([], { hour12: false })}</time><ThemeSelector value={props.themeId} onChange={props.onThemeChange} /></div>
    </header>
    <nav className="terminal-nav" aria-label="Workflow dashboard views">{NAV_GROUPS.map((group) => <div className="terminal-nav-group" key={group.label}><span>{group.label}</span><div>{group.views.map((entry) => <button type="button" aria-label={VIEW_TITLES[entry]} aria-current={entry === props.view ? "page" : undefined} key={entry} onClick={() => props.onNavigate(entry)}><NavIcon view={entry} /><b>{VIEW_TITLES[entry]}</b>{props.navCounts[entry] !== undefined && <small aria-hidden="true">{props.navCounts[entry]}</small>}</button>)}</div></div>)}</nav>
    <div className="terminal-commandbar"><span>PROJECT</span><strong>{props.projectLabel}</strong><i>/</i><span>VIEW</span><strong>{VIEW_TITLES[props.view]}</strong><em>API V1 · LOCAL ONLY</em></div>
    <main id="workflow-content" tabIndex={-1}>{props.children}</main>
  </div>;
}
