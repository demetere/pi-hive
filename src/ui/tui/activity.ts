import type { AgentConfig, HiveActivityEntry, HiveState } from "../../core/types";
import { agentSlug, configuredChildAgents, truncateMiddle } from "../../core/utils";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const WIDGET_ID = "hive-activity";
const MAX_ENTRIES = 40;
const MAX_RENDERED_ROWS = 3;
const MAX_ENTRY_TEXT = 72;
const MAX_BOX_WIDTH = 88;

function nowIso() {
  return new Date().toISOString();
}

function agentDepths(state: HiveState): Map<string, number> {
  const depths = new Map<string, number>();
  const visit = (agent: AgentConfig, depth: number) => {
    const slug = agentSlug(agent);
    depths.set(slug, depth);
    depths.set(String(agent.name || slug).trim().toLowerCase(), depth);
    for (const child of configuredChildAgents(agent)) visit(child, depth + 1);
  };
  if (state.config?.orchestrator) visit(state.config.orchestrator, 0);
  for (const root of state.config?.agents || []) visit(root, 1);
  return depths;
}

function depthFor(depths: Map<string, number>, agent?: string, fallback = 1): number {
  const key = String(agent || "").trim().toLowerCase();
  return key ? depths.get(key) ?? fallback : fallback;
}

function icon(status?: string) {
  if (status === "done") return "✓";
  if (status === "error") return "✗";
  if (status === "running") return "●";
  return "•";
}

function formatElapsed(ms: number) {
  if (!ms || ms < 1000) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function renderActiveRows(state: HiveState, theme: any, depths: Map<string, number>): string[] {
  return Array.from(state.runtimes.values())
    .filter((runtime) => runtime.status === "running")
    .sort((a, b) => depthFor(depths, a.config.name) - depthFor(depths, b.config.name) || a.config.name.localeCompare(b.config.name))
    .map((runtime) => {
      const depth = depthFor(depths, runtime.config.name);
      const indent = "  ".repeat(Math.max(0, depth));
      const elapsed = formatElapsed(runtime.elapsedMs);
      const rawWork = runtime.lastWork || runtime.task || "working";
      const work = rawWork.startsWith("tool: ") ? rawWork : truncateMiddle(rawWork, MAX_ENTRY_TEXT);
      const suffix = [elapsed, runtime.toolCount ? `${runtime.toolCount} tools` : ""].filter(Boolean).join(" · ");
      return `${theme.fg("accent", `${indent}${icon("running")} ${runtime.config.name}`)}${theme.fg("dim", suffix ? ` · ${suffix}` : "")} ${theme.fg("muted", `— ${work}`)}`;
    });
}

function renderEntry(entry: HiveActivityEntry, theme: any, depths: Map<string, number>): string {
  const depth = depthFor(depths, entry.agent, entry.parent ? depthFor(depths, entry.parent) + 1 : 1);
  const indent = "  ".repeat(Math.max(0, depth));
  const label = entry.agent || entry.parent || "Hive";
  const status = entry.status || (entry.kind === "delegation_start" || entry.kind === "tool_start" ? "running" : undefined);
  const color = status === "error" ? "error" : status === "done" ? "success" : status === "running" ? "accent" : "muted";
  const parent = entry.parent ? theme.fg("dim", `${entry.parent} → `) : "";
  const tool = entry.toolName ? theme.fg("dim", ` ${entry.toolName}`) : "";
  const text = entry.text ? ` — ${truncateMiddle(entry.text, MAX_ENTRY_TEXT)}` : "";
  return `${theme.fg(color, `${indent}${icon(status)} `)}${parent}${theme.fg(color, label)}${tool}${theme.fg("muted", text)}`;
}

function padToWidth(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

function renderCompactBox(body: string[], width: number, theme: any): string[] {
  // Pi places extension widgets inside an already-indented content region. Keep
  // a small safety margin so our decorative border never collides with the
  // terminal edge or draws through the editor/footer on narrow layouts.
  const safeWidth = Math.max(0, width - 2);
  if (safeWidth < 8) return [];
  const boxWidth = Math.min(Math.max(20, safeWidth), MAX_BOX_WIDTH);
  const contentWidth = Math.max(0, boxWidth - 4);
  const title = ` Hive activity `;
  const topPlain = `╭─${title}${"─".repeat(Math.max(0, boxWidth - title.length - 3))}╮`;
  const bottomPlain = `╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`;
  const rows = body.map((line) => {
    const content = truncateToWidth(line, contentWidth, theme.fg("dim", "…"));
    return theme.fg("dim", "│ ") + padToWidth(content, contentWidth) + theme.fg("dim", " │");
  });
  return [
    theme.fg("dim", "╭─") + theme.fg("accent", theme.bold(title)) + theme.fg("dim", topPlain.slice(2 + title.length)),
    ...rows,
    theme.fg("dim", bottomPlain),
  ].map((line) => truncateToWidth(line, width, theme.fg("dim", "…")));
}

export function addHiveActivity(state: HiveState, entry: Omit<HiveActivityEntry, "ts"> & { ts?: string }) {
  if (state.mode === "normal") return;
  const full: HiveActivityEntry = { ...entry, ts: entry.ts || nowIso() };
  state.activityLog ||= [];
  state.activityLog.push(full);
  if (state.activityLog.length > MAX_ENTRIES) state.activityLog.splice(0, state.activityLog.length - MAX_ENTRIES);
  state.activityRender?.();
}

export function updateHiveActivityWidget(state: HiveState) {
  const ctx = state.widgetCtx;
  if (!ctx || ctx.mode !== "tui") return;

  if (state.mode === "normal") {
    if (state.activityWidgetInstalled) ctx.ui.setWidget(WIDGET_ID, undefined);
    state.activityWidgetInstalled = false;
    state.activityRender = undefined;
    return;
  }

  if (state.activityWidgetInstalled) {
    state.activityRender?.();
    return;
  }

  state.activityWidgetInstalled = true;
  ctx.ui.setWidget(WIDGET_ID, (tui: any, theme: any) => {
    state.activityRender = () => tui.requestRender();
    return {
      invalidate() {},
      render(width: number): string[] {
        const depths = agentDepths(state);
        const active = renderActiveRows(state, theme, depths);
        const recent = [...(state.activityLog || [])]
          .reverse()
          // Keep the widget quiet: running tool calls are already reflected in
          // active rows via `tool: <name>`, and rendering their JSON args in the
          // persistent widget makes the TUI noisy. Only surface failures and
          // higher-level delegation/retry/compaction milestones.
          .filter((entry) => entry.kind !== "tool_start")
          .filter((entry) => entry.kind !== "tool_end" || entry.status === "error")
          .map((entry) => renderEntry(entry, theme, depths));
        const body = [...active, ...recent].slice(0, MAX_RENDERED_ROWS);
        if (!body.length) return [];
        return renderCompactBox(body, width, theme);
      },
    };
  });
}

export function clearHiveActivityWidget(state: HiveState) {
  const ctx = state.widgetCtx;
  if (ctx?.mode === "tui") ctx.ui.setWidget(WIDGET_ID, undefined);
  state.activityWidgetInstalled = false;
  state.activityRender = undefined;
}
