import { DASHBOARD_THEMES, type DashboardThemeId } from "../themes/theme-registry";
import type { ProjectOption, StreamState } from "./dashboard-shell";

export function ProjectSelector({ value, options, onChange }: { readonly value: string; readonly options: readonly ProjectOption[]; readonly onChange: (value: string) => void }) {
  return <label className="project-scope"><i aria-hidden="true" /><span className="sr-only">Project scope</span><select aria-label="Project scope" value={value} onChange={(event) => onChange(event.target.value)}><option value="">All projects</option>{options.map((project) => <option key={project.projectId} value={project.projectId}>{project.projectLabel}</option>)}</select></label>;
}

export function ThemeSelector({ value, onChange }: { readonly value: DashboardThemeId; readonly onChange: (value: DashboardThemeId) => void }) {
  return <label className="theme-selector"><span className="sr-only">Dashboard theme</span><select aria-label="Dashboard theme" value={value} onChange={(event) => onChange(event.target.value as DashboardThemeId)}>{DASHBOARD_THEMES.map((theme) => <option key={theme.id} value={theme.id}>{theme.label}</option>)}</select></label>;
}

export function ConnectionStatus({ state, showAddress = true }: { readonly state: StreamState; readonly showAddress?: boolean }) {
  return <div className="connection-card"><span><i className={state} aria-hidden="true" />{state === "live" ? "Connected" : state === "connecting" ? "Connecting" : "Resyncing"}</span>{showAddress && <code>localhost:43191</code>}</div>;
}
