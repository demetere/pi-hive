import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";
import { HIVE_TOOL_NAMES } from "../../core/constants";
import { canonicalMode } from "../../core/types";
import type { AgentConfig, AgentRuntime, HiveMode, HiveState } from "../../core/types";
import { hasPlanningTeam } from "../../core/config";
import { activateTeamRuntimes } from "../../engine/session";
import { configuredChildAgents, extractUsage } from "../../core/utils";

// The hive toolset active in BOTH plan and hive mode (the type-scoped tools —
// plan_new/submit_review_verdict/etc. — are added per agent-type by the tool
// builder, not here).
const HIVE_MODE_TOOLS = ["route_agent", "delegate_agent", "team_status", "team_conversation", "hive_sdd_status"];

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

  // Guard: plan mode without a configured planning team. Fall back to the hive
  // team (planners in the hive tree still work) but tell the user.
  if (mode === "plan" && !hasPlanningTeam(state.config)) {
    if (shouldNotify && ctx.hasUI) ctx.ui.notify("No planning: block configured — plan mode uses the hive team's planners. Add a planning: block to hive-config.yaml for a dedicated planning hierarchy.", "warning");
  }

  const previous = state.mode;
  state.mode = mode;

  // Rebuild the active team's runtimes when entering plan/hive (or switching
  // between them). Normal mode leaves the runtimes as-is (harmless; tools are off).
  if (mode !== "normal" && state.config && canonicalMode(previous) !== mode) {
    activateTeamRuntimes(state, ctx, mode);
  }

  installHeader(state, ctx);
  installFooter(state, ctx);
  if (ctx.hasUI) ctx.ui.setStatus("hive", modeStatusText(state, mode));

  if (mode === "normal") {
    state.pi.setActiveTools(state.normalToolNames);
    if (ctx.mode === "tui") ctx.ui.setWidget("hive-tree", undefined);
    if (shouldNotify && ctx.hasUI) ctx.ui.notify("Normal Pi chat mode enabled", "info");
    return;
  }

  state.pi.setActiveTools(HIVE_MODE_TOOLS);
  updateWidget(state);
  if (shouldNotify && ctx.hasUI) {
    const msg = mode === "plan"
      ? "Plan mode enabled — drive planners to produce full specs, then switch to hive to execute."
      : "Hive mode enabled — delegate execution to coders/testers/reviewers.";
    ctx.ui.notify(msg, "success");
  }
}


export function shortPath(path: string): string {
  const home = process.env.HOME || "";
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${Math.round(value / 1000)}K`;
  return `${Math.round(value)}`;
}

export function gitStatusLabel(cwd: string): string {
  try {
    const raw = execSync("git status --porcelain", { cwd, encoding: "utf-8", timeout: 500 }).trim();
    if (!raw) return "clean";
    const lines = raw.split("\n").filter(Boolean);
    const untracked = lines.filter((line: string) => line.startsWith("??")).length;
    if (untracked === lines.length) return `${untracked} untracked`;
    return `${lines.length} changes`;
  } catch {
    return "";
  }
}

export function aggregateUsage(ctx: ExtensionContext): { input: number; output: number; cost: number } {
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    const message = (entry as any).message;
    if ((entry as any).type === "message" && message?.role === "assistant" && message.usage) {
      const u = extractUsage(message.usage);
      input += u.input;
      output += u.output;
      cost += u.cost;
    }
  }
  return { input, output, cost };
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

export function installFooter(state: HiveState, ctx: ExtensionContext) {
  if (ctx.mode !== "tui") return;
  ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
    const unsub = footerData.onBranchChange(() => tui.requestRender());
    queueMicrotask(() => tui.requestRender());
    return {
      dispose: unsub,
      invalidate() {},
      render(width: number): string[] {
        const usage = ctx.getContextUsage?.();
        const pct = usage ? Number(usage.percent || 0) : 0;
        const contextWindow = (ctx as any).model?.contextWindow || (ctx as any).model?.context_window || 0;
        const branch = footerData.getGitBranch?.() || "";
        const gitStatus = gitStatusLabel(ctx.cwd);
        const totals = aggregateUsage(ctx);
        const totalCost = totals.cost + Array.from(state.runtimes.values()).reduce((sum, runtime) => sum + runtime.costUsd, 0);
        const model = (ctx as any).model?.id || "no-model";
        const thinking = state.pi.getThinkingLevel?.() || "off";
        const speed = state.lastTokPerSec > 0 ? `${Math.round(state.lastTokPerSec)} tok/s` : `${formatCount(totals.output)} tok`;

        const label = modeLabel(state.mode);
        const modeColor = state.mode === "hive" ? "accent" : state.mode === "plan" ? "warning" : "muted";
        const modePart = theme.fg(modeColor, `[${label}] `);
        const left = modePart + theme.fg("dim", `${shortPath(ctx.cwd)} `) +
          (branch ? theme.fg("accent", `↯ ${branch}`) : "") +
          (gitStatus ? theme.fg("dim", ` · ${gitStatus}`) : "");
        const right = theme.fg("dim", `${model} · `) +
          theme.fg("accent", `think ${thinking}`) +
          theme.fg("dim", ` · ⚡ ${speed} · `) +
          theme.fg("muted", `🧠 ${pct.toFixed(1)}%${contextWindow ? ` of ${formatCount(contextWindow)}` : ""} · `) +
          theme.fg("success", `$${totalCost.toFixed(3)}`);
        const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
        return [truncateToWidth(left + pad + right, width)];
      },
    };
  });
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
}

// Cycle normal → plan → hive → normal.
const MODE_CYCLE: HiveMode[] = ["normal", "plan", "hive"];
export function nextMode(mode: HiveMode): HiveMode {
  return MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length];
}

export function cycleMode(state: HiveState, ctx: ExtensionContext) {
  applyMode(state, ctx, nextMode(state.mode));
}
