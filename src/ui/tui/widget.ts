import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HIVE_TOOL_NAMES } from "../../core/constants";
import { canonicalMode } from "../../core/types";
import type { HiveMode, HiveState } from "../../core/types";
import { activateTeamRuntimes } from "../../engine/session";
import { emitModelCatalog, startHiveTelemetrySession } from "../../engine/observability";
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
// Returns true when the mode was applied, false when the drain guard refused the
// switch (a worker is still running). Callers that drive follow-up work off a mode
// change (e.g. /hive-execute) MUST check the result so they don't proceed while
// stuck in the previous mode.
export function applyMode(state: HiveState, ctx: ExtensionContext, mode: HiveMode, options: { notify?: boolean } = {}): boolean {
  const shouldNotify = options.notify ?? true;

  const previous = state.mode;

  // Phase 5.4 drain guard: switching plan⇄hive rebuilds state.runtimes, which
  // disposes the previous team's live worker sessions. Doing that mid-dispatch
  // would kill an in-flight worker and leak its run. Refuse the switch while any
  // worker is running and tell the user to wait; keep the current mode intact.
  const rebuildsTeam = mode !== "normal" && state.config && canonicalMode(previous) !== mode;
  if (rebuildsTeam && state.activeRuns > 0) {
    if (shouldNotify && ctx.hasUI) {
      ctx.ui.notify(`Cannot switch mode while ${state.activeRuns} agent${state.activeRuns === 1 ? " is" : "s are"} running. Wait for the current work to finish, then switch.`, "error");
    }
    return false;
  }

  state.mode = mode;

  // Rebuild the active team's runtimes when entering plan/hive (or switching
  // between them). Normal mode leaves the runtimes as-is (harmless; tools are off).
  if (rebuildsTeam) {
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
    return true;
  }

  startHiveTelemetrySession(state, ctx.cwd);
  emitModelCatalog(state, (ctx as any).modelRegistry);
  startDashboardActionPoller(state, ctx);
  state.pi.setActiveTools(mode === "plan" ? PLAN_MODE_TOOLS : HIVE_MODE_TOOLS);
  updateWidget(state);
  if (shouldNotify && ctx.hasUI) {
    const msg = mode === "plan"
      ? "Plan mode enabled — drive planners to produce full specs, then switch to hive to execute."
      : "Hive mode enabled — delegate execution to coders/testers/reviewers.";
    ctx.ui.notify(msg, "success");
  }
  return true;
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
