import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HIVE_TOOL_NAMES } from "../../core/constants";
import { canonicalMode } from "../../core/types";
import type { AgentConfig, AgentRuntime, HiveMode, HiveState } from "../../core/types";
import { activateTeamRuntimes } from "../../engine/session";
import { startHiveTelemetrySession } from "../../engine/observability";
import { configuredChildAgents } from "../../core/utils";
import { installHiveFooter, requestHiveFooterRender } from "./footer";

// Common hive tools are active in both plan and execution mode. Plan lifecycle
// tools are active only in plan mode so approvals happen before /hive-execute.
const COMMON_HIVE_TOOLS = ["route_agent", "delegate_agent", "team_status", "team_conversation", "hive_sdd_status"];
const PLAN_MODE_TOOLS = [...COMMON_HIVE_TOOLS, "plan_new", "plan_select", "approve_plan"];
const HIVE_MODE_TOOLS = COMMON_HIVE_TOOLS;

function startDashboardActionPoller(state: HiveState, ctx: ExtensionContext) {
  if (!state.session || state.dashboardActionTimer) return;
  const file = join(state.session.sessionDir, "dashboard-actions.jsonl");
  try { state.dashboardActionOffset = existsSync(file) ? statSync(file).size : 0; } catch { state.dashboardActionOffset = 0; }
  state.dashboardActionTimer = setInterval(() => {
    if (!state.session) return;
    try {
      if (!existsSync(file)) return;
      const text = readFileSync(file, "utf8");
      const offset = state.dashboardActionOffset || 0;
      if (text.length <= offset) return;
      state.dashboardActionOffset = text.length;
      for (const line of text.slice(offset).split("\n")) {
        if (!line.trim()) continue;
        const action = JSON.parse(line);
        if (action.type === "plan_approval" && action.changeId && action.phase) {
          const next = action.nextPhase === "apply"
            ? `The dashboard approved tasks for change "${action.changeId}". The plan is ready; summarize readiness and ask whether to run /hive-execute ${action.changeId}.`
            : `The dashboard approved the ${action.phase} gate for change "${action.changeId}". Continue planning the next gate (${action.nextPhase || "next phase"}) with the planning team.`;
          state.pi.sendUserMessage(next);
        } else if (action.type === "plan_comment" && action.changeId && action.body) {
          const where = action.file ? ` on ${action.file}${action.anchor ? `#${action.anchor}` : ""}` : "";
          state.pi.sendUserMessage(`Dashboard feedback for change "${action.changeId}"${where}:\n\n${action.body}\n\nAddress this feedback in the active plan before continuing.`);
        }
      }
    } catch { /* best-effort bridge from dashboard to live TUI session */ }
  }, 1000);
}

export function captureNormalTools(state: HiveState) {
  const active = state.pi.getActiveTools().filter((name: string) => !HIVE_TOOL_NAMES.has(name));
  if (active.length > 0) {
    state.normalToolNames = active;
    return;
  }
  state.normalToolNames = state.pi.getAllTools()
    .map((tool: { name: string }) => tool.name)
    .filter((name: string) => !HIVE_TOOL_NAMES.has(name));
}

// Short uppercase label for the status bar / header / footer.
export function modeLabel(mode: HiveMode): string {
  return mode === "plan" ? "PLAN" : mode === "hive" ? "HIVE" : "NORMAL";
}

export function modeStatusText(state: HiveState, mode: HiveMode = state.mode): string {
  if (mode === "normal") return "NORMAL";
  return `${modeLabel(mode)} (${state.runtimes.size})`;
}

// Apply a session mode. normal = plain Pi (no hive tools, no enforcement);
// plan = planning team active (main session = planning main/planner); hive =
// execution team active. Switching plan/hive rebuilds the active team's runtimes
// so "who I can delegate to now" and the main session's own identity/permissions
// match the mode.
export function applyMode(state: HiveState, ctx: ExtensionContext, mode: HiveMode, options: { notify?: boolean } = {}) {
  const shouldNotify = options.notify ?? true;

  const previous = state.mode;
  state.mode = mode;

  // Rebuild the active team's runtimes when entering plan/hive (or switching
  // between them). Normal mode leaves the runtimes as-is (harmless; tools are off).
  if (mode !== "normal" && state.config && canonicalMode(previous) !== mode) {
    activateTeamRuntimes(state, ctx, mode);
  }

  installHeader(state, ctx);
  installHiveFooter(state, ctx);
  if (ctx.hasUI) ctx.ui.setStatus("hive", modeStatusText(state, mode));
  requestHiveFooterRender();

  if (mode === "normal") {
    state.pi.setActiveTools(state.normalToolNames);
    if (ctx.mode === "tui") ctx.ui.setWidget("hive-tree", undefined);
    if (shouldNotify && ctx.hasUI) ctx.ui.notify("Normal Pi chat mode enabled", "info");
    return;
  }

  startHiveTelemetrySession(state, ctx.cwd);
  startDashboardActionPoller(state, ctx);
  state.pi.setActiveTools(mode === "plan" ? PLAN_MODE_TOOLS : HIVE_MODE_TOOLS);
  updateWidget(state);
  if (shouldNotify && ctx.hasUI) {
    const msg = mode === "plan"
      ? "Plan mode enabled — drive planners to produce full specs, then switch to hive to execute."
      : "Hive mode enabled — delegate execution to coders/testers/reviewers.";
    ctx.ui.notify(msg, "success");
  }
}


export function installHeader(state: HiveState, ctx: ExtensionContext) {
  if (ctx.mode !== "tui") return;
  ctx.ui.setHeader((_tui: any, theme: any) => ({
    dispose() {},
    invalidate() {},
    render(width: number): string[] {
      const label = modeLabel(state.mode);
      const modeColor = state.mode === "hive" ? "accent" : state.mode === "plan" ? "warning" : "muted";
      const details = state.mode === "normal"
        ? `normal chat`
        : `${state.mode === "plan" ? "planning" : "execution"} · ${state.runtimes.size} agents · ${state.activeRuns} running`;
      // Dashboard indicator: shown only while the shared daemon is up (its url is
      // recorded on state.obsServer); nothing when it is off.
      const dash = state.obsServer?.url ? theme.fg("success", ` · ◉ ${state.obsServer.url.replace(/^https?:\/\//, "")}`) : "";
      const line = theme.fg("dim", "pi mode ") +
        theme.fg(modeColor, theme.bold(label)) +
        theme.fg("dim", ` · ${details} · Ctrl+Alt+T cycle`) +
        dash;
      return [truncateToWidth(line, width, theme.fg("dim", "..."))];
    },
  }));
}


export function renderTeamLines(state: HiveState, width: number, theme: any): string[] {
  if (!state.config || !state.session) return [theme.fg("dim", "hive: not loaded")];
  const lines: string[] = [];
  const orch = state.runtimes.get(state.config.orchestrator.name.toLowerCase());
  const title = theme.fg("accent", theme.bold(`hive`)) + theme.fg("dim", ` | ${state.session.sessionId.slice(0, 14)} | ${state.activeRuns} running`);
  lines.push(truncateToWidth(title, width));

  const renderAgent = (prefix: string, runtime: AgentRuntime, last: boolean) => {
    const statusIcon = runtime.status === "running" ? "●" : runtime.status === "done" ? "✓" : runtime.status === "error" ? "✗" : "○";
    const statusRole = runtime.status === "running" ? "accent" : runtime.status === "done" ? "success" : runtime.status === "error" ? "error" : "dim";
    const tokens = runtime.inputTokens + runtime.outputTokens;
    const usage = `$${runtime.costUsd.toFixed(3)} 🧠${Math.round(tokens / 1000)}K`;
    const elapsed = runtime.status === "running" ? ` ${Math.round(runtime.elapsedMs / 1000)}s` : "";
    const raw = `${prefix}${last ? "└" : "├"} ${statusIcon} ${runtime.config.name} ${usage}${elapsed} ${runtime.config.model || "inherit"}`;
    const styled = theme.fg("dim", `${prefix}${last ? "└" : "├"} `) + theme.fg(statusRole, statusIcon) + " " + theme.fg("accent", runtime.config.name) + theme.fg("dim", ` ${usage}${elapsed} ${runtime.config.model || "inherit"}`);
    lines.push(truncateToWidth(styled, width || visibleWidth(raw)));
  };

  const renderAgentNode = (agent: AgentConfig, prefix: string, last: boolean, childrenOverride?: AgentConfig[]) => {
    const runtime = state.runtimes.get(agent.name.toLowerCase());
    if (runtime) renderAgent(prefix, runtime, last);
    const children = childrenOverride || configuredChildAgents(agent);
    const childPrefix = `${prefix}${last ? "   " : "│  "}`;
    for (let i = 0; i < children.length; i++) {
      renderAgentNode(children[i], childPrefix, i === children.length - 1);
    }
  };

  if (orch) renderAgent("", orch, false);
  // Top-level agents are the orchestrator's direct reports; render each as a
  // normal node (it heads its own subtree).
  for (let t = 0; t < state.config.agents.length; t++) {
    renderAgentNode(state.config.agents[t], "│  ", t === state.config.agents.length - 1);
  }
  return lines.slice(0, 28);
}

export function updateWidget(state: HiveState) {
  // Keep team mode active without rendering the full team tree near the footer.
  if (!state.widgetCtx || state.widgetCtx.mode !== "tui") return;
  state.widgetCtx.ui.setWidget("hive-tree", undefined);
  installHeader(state, state.widgetCtx);
  requestHiveFooterRender();
}

// Cycle normal → plan → hive → normal.
const MODE_CYCLE: HiveMode[] = ["normal", "plan", "hive"];
export function nextMode(mode: HiveMode): HiveMode {
  return MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length];
}

export function cycleMode(state: HiveState, ctx: ExtensionContext) {
  applyMode(state, ctx, nextMode(state.mode));
}
