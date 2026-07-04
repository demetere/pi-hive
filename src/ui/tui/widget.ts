import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HIVE_TOOL_NAMES } from "../../core/constants";
import { canonicalMode } from "../../core/types";
import type { HiveMode, HiveState } from "../../core/types";
import { activateTeamRuntimes } from "../../engine/session";
import { startHiveTelemetrySession } from "../../engine/observability";
import { recordQuestion } from "../../engine/questions";
import { installHiveFooter, requestHiveFooterRender } from "./footer";
import { updateHiveActivityWidget } from "./activity";

// Surface a delegated planner's promoted clarifying question to the human. With
// a UI we block on an input dialog; either way we record the Q&A alongside the
// change and re-inject the answer so the planning main session proceeds.
async function handlePromotedQuestion(state: HiveState, ctx: ExtensionContext, action: { question: string; change?: string; askedBy?: string }) {
  const { question } = action;
  let answer: string | undefined;
  if (ctx.hasUI && typeof (ctx.ui as any)?.input === "function") {
    try {
      // Pi's ExtensionInputComponent currently ignores its placeholder, so keep
      // the question visible in the notification/title rather than only there.
      (ctx.ui as any).notify?.(`Planning question from ${action.askedBy || "a planner"}: ${question}`, "info");
      answer = await (ctx.ui as any).input(`Planning question from ${action.askedBy || "a planner"}: ${question}`, question);
    } catch { answer = undefined; }
  }
  if (action.change) recordQuestion(ctx.cwd, action.change, question, answer || undefined);
  if (answer && answer.trim()) {
    state.pi.sendUserMessage(`The human answered a planning question from ${action.askedBy || "a planner"}:\n\nQ: ${question}\nA: ${answer.trim()}\n\nRelay this answer to that planner (resume its delegation) so it can continue.`);
  } else {
    state.pi.sendUserMessage(`${action.askedBy || "A planner"} asked: "${question}". Please answer it in chat, then relay the answer to that planner so it can continue.`);
  }
}

// Common hive tools are active in both plan and execution mode. Plan lifecycle
// tools are active only in plan mode. Approval is no longer a tool — it happens
// in the dashboard's plan-review UI. ask_user lets a planner interrogate the
// human before writing artifacts.
const COMMON_HIVE_TOOLS = ["route_agent", "delegate_agent", "team_status", "team_conversation", "hive_sdd_status"];
const PLAN_MODE_TOOLS = [...COMMON_HIVE_TOOLS, "plan_new", "plan_select", "ask_user"];
const HIVE_MODE_TOOLS = COMMON_HIVE_TOOLS;

// The bridge cursor is persisted BESIDE the action queue so it survives an
// accidental close/reopen of the same session: on re-entry we resume from the
// last consumed byte instead of seeding to file-end, so feedback enqueued by the
// dashboard while the session was down gets replayed and delivered.
function cursorFile(sessionDir: string): string {
  return join(sessionDir, "dashboard-actions.cursor");
}
function readCursor(sessionDir: string): number {
  try {
    const n = Number(readFileSync(cursorFile(sessionDir), "utf8").trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
function writeCursor(sessionDir: string, offset: number): void {
  try { writeFileSync(cursorFile(sessionDir), String(offset)); } catch { /* best-effort */ }
}

function startDashboardActionPoller(state: HiveState, ctx: ExtensionContext) {
  if (!state.session || state.dashboardActionTimer) return;
  const dir = state.session.sessionDir;
  const file = join(dir, "dashboard-actions.jsonl");
  // Resume from the durable cursor (not file-end), so anything enqueued while
  // this session was closed is replayed on reopen.
  state.dashboardActionOffset = readCursor(dir);
  state.dashboardActionTimer = setInterval(() => {
    if (!state.session) return;
    try {
      if (!existsSync(file)) return;
      const text = readFileSync(file, "utf8");
      const offset = state.dashboardActionOffset || 0;
      if (text.length <= offset) return;
      state.dashboardActionOffset = text.length;
      writeCursor(dir, text.length);
      for (const line of text.slice(offset).split("\n")) {
        if (!line.trim()) continue;
        const action = JSON.parse(line);
        if (action.type === "plan_review_approved" && action.changeId) {
          const next = action.readyToExecute
            ? `The plan-review UI approved the tasks artifact for change "${action.changeId}". The plan is validated and ready; summarize readiness and ask whether to run /hive-execute ${action.changeId}.`
            : action.nextArtifact
              ? `The plan-review UI approved the ${action.artifact || "artifact"} for change "${action.changeId}". Author the next artifact (${action.nextArtifact}) with the planning team, then submit it for review.`
              : `The plan-review UI approved the ${action.artifact || "artifact"} for change "${action.changeId}". Continue with the planning team.`;
          state.pi.sendUserMessage(action.feedback ? `${next}\n\nReviewer note:\n${action.feedback}` : next);
        } else if (action.type === "plan_review_denied" && action.changeId) {
          state.pi.sendUserMessage(`The plan-review UI rejected the ${action.artifact || "artifact"} for change "${action.changeId}":\n\n${action.feedback || "(no feedback given)"}\n\nRevise that artifact with the planning team, then re-submit it for review before continuing.`);
        } else if (action.type === "question" && action.question) {
          // WS-D: a delegated planner promoted a clarifying question to the main
          // session. Surface it to the human (inline dialog when we have a UI),
          // record the answer alongside the change, and feed it back so planning
          // proceeds. The delegated session resumes on its next turn.
          void handlePromotedQuestion(state, ctx, action);
        } else if (action.type === "answer" && action.question && action.answer) {
          state.pi.sendUserMessage(`Answer to the clarifying question "${action.question}":\n\n${action.answer}\n\nUse this to proceed with planning.`);
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
  if (ctx.hasUI) {
    ctx.ui.setStatus("hive", modeStatusText(state, mode));
    // Hive has its own live activity widget. Pi's generic streaming loader can
    // briefly stack several "Working..." rows during nested delegation before
    // the TUI reconciles them, which makes the start of a run look noisy. Hide
    // that generic row only while Hive/Plan mode is active; restore it in normal.
    if (ctx.mode === "tui") ctx.ui.setWorkingVisible(mode === "normal");
  }
  requestHiveFooterRender();

  if (mode === "normal") {
    state.pi.setActiveTools(state.normalToolNames);
    if (ctx.mode === "tui") {
      ctx.ui.setWidget("hive-tree", undefined);
      updateHiveActivityWidget(state);
    }
    if (shouldNotify && ctx.hasUI) ctx.ui.notify("Normal Pi chat mode enabled", "info");
    return true;
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
  updateHiveActivityWidget(state);
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
