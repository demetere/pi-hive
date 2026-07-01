/**
 * Hive footer renderer.
 *
 * This intentionally mirrors the adaptive footer used in the local dotfiles:
 * model/TPS/context/cost on the left, path/git on the right, keeping the path
 * right-aligned and wrapping only when needed. Hive extends that base footer with mode,
 * agent, and dashboard status so hive-enabled projects do not fall back to Pi's
 * noisier built-in footer.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { HiveMode, HiveState } from "../../core/types";

const execFileAsync = promisify(execFile);
const UPDATE_INTERVAL_MS = 2_000;

let gitInterval: ReturnType<typeof setInterval> | undefined;
let unstagedCount: number | undefined;
let requestFooterRender: (() => void) | undefined;

let messageStart: number | null = null;
let streamStart: number | null = null;
let estimatedStreamedTokens = 0;
let totalOutputTokens = 0;
let totalStreamMs = 0;
let tpsText = "⚡ idle";

function formatCwd(cwd: string) {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;

  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`));

  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function formatTokens(count: number) {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

async function runGit(args: string[], cwd: string) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trimEnd();
}

function countUnstagedFiles(statusOutput: string) {
  if (statusOutput.length === 0) return 0;

  let count = 0;
  for (const line of statusOutput.split("\n")) {
    if (line.startsWith("??") || line[1] !== " ") count += 1;
  }
  return count;
}

function rightAlign(text: string, width: number, ellipsis: string) {
  const truncated = truncateToWidth(text, width, ellipsis);
  const padding = Math.max(0, width - visibleWidth(truncated));
  return `${" ".repeat(padding)}${truncated}`;
}

function splitFooterLine(left: string, right: string, width: number, ellipsis: string) {
  const minimumGap = 2;
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);

  if (leftWidth + minimumGap + rightWidth <= width) {
    return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
  }

  const availableLeftWidth = Math.max(0, width - rightWidth - minimumGap);
  if (availableLeftWidth > 8) {
    const leftPart = truncateToWidth(left, availableLeftWidth, ellipsis);
    return `${leftPart}${" ".repeat(width - visibleWidth(leftPart) - rightWidth)}${right}`;
  }

  return undefined;
}

function footerModeLabel(mode: HiveMode): string {
  return mode === "plan" ? "PLAN" : mode === "hive" ? "HIVE" : "NORMAL";
}

function renderHiveStatus(state: HiveState, theme: any) {
  const label = footerModeLabel(state.mode);
  const color = state.mode === "hive" ? "accent" : state.mode === "plan" ? "warning" : "muted";
  const running = state.activeRuns > 0 ? ` · ${state.activeRuns} running` : "";
  const agents = state.mode === "normal" ? "" : ` · ${state.runtimes.size} agents${running}`;
  const dashboard = state.obsServer?.url
    ? theme.fg("success", ` · ◉ ${state.obsServer.url.replace(/^https?:\/\//, "")}`)
    : "";
  return theme.fg(color, `[${label}${agents}]`) + dashboard;
}

function totalAssistantCost(ctx: ExtensionContext) {
  let totalCost = 0;
  for (const entry of ctx.sessionManager.getEntries() as any[]) {
    if (entry.type === "message" && entry.message?.role === "assistant") {
      totalCost += entry.message?.usage?.cost?.total || 0;
    }
  }
  return totalCost;
}

function renderExternalStatuses(footerData: any, theme: any) {
  const statuses: string[] = [];
  for (const [key, text] of footerData.getExtensionStatuses() as ReadonlyMap<string, string>) {
    // Hive renders its own richer status; avoid showing it twice. Keep other
    // extension statuses so replacing the built-in footer remains cooperative.
    if (key === "hive" || !text) continue;
    statuses.push(theme.fg("muted", `[${text}]`));
  }
  return statuses;
}

export function requestHiveFooterRender() {
  requestFooterRender?.();
}

export function installHiveFooter(state: HiveState, ctx: ExtensionContext) {
  if (ctx.mode !== "tui") return;

  const updateGitState = async () => {
    try {
      await runGit(["rev-parse", "--is-inside-work-tree"], ctx.cwd);
      const status = await runGit(["status", "--porcelain", "--untracked-files=normal"], ctx.cwd);
      unstagedCount = countUnstagedFiles(status);
    } catch {
      unstagedCount = undefined;
    }
    requestHiveFooterRender();
  };

  void updateGitState();
  if (gitInterval) clearInterval(gitInterval);
  gitInterval = setInterval(() => {
    void updateGitState();
  }, UPDATE_INTERVAL_MS);

  ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
    requestFooterRender = () => tui.requestRender();
    const unsub = footerData.onBranchChange(requestFooterRender);

    return {
      dispose: () => {
        unsub();
        requestFooterRender = undefined;
      },
      invalidate() {},
      render(width: number): string[] {
        const branch = footerData.getGitBranch();
        const path = theme.fg("dim", formatCwd(ctx.cwd));
        const unstagedLabel = unstagedCount === undefined ? "" : ` · ${unstagedCount} unstaged`;
        const gitPart = branch
          ? ` ${theme.fg("muted", "")} ${theme.fg("accent", branch)}${theme.fg("dim", unstagedLabel)}`
          : "";
        const pathLine = path + gitPart;

        const model = ctx.model;
        const showApiPrice = model ? !ctx.modelRegistry.isUsingOAuth(model) : true;
        const pricePart = theme.fg("success", `$${totalAssistantCost(ctx).toFixed(3)}`);

        const modelName = model?.id || "no model";
        const thinkingLevel = state.pi.getThinkingLevel();
        const thinkingPart = theme.fg(
          thinkingLevel === "off" ? "dim" : "accent",
          `think ${thinkingLevel}`,
        );
        const modelPart = `${modelName} · ${thinkingPart}`;

        const usage = ctx.getContextUsage();
        const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
        const percent = usage?.percent ?? 0;
        const contextLabel = usage
          ? `${percent.toFixed(1)}% of ${formatTokens(contextWindow)}`
          : `? of ${formatTokens(contextWindow)}`;
        const contextPart = percent > 85
          ? theme.fg("warning", `🧠 ${contextLabel}`)
          : theme.fg("muted", `🧠 ${contextLabel}`);

        const tpsPart = tpsText.includes("idle")
          ? theme.fg("dim", tpsText)
          : theme.fg("accent", tpsText);

        const parts = [
          renderHiveStatus(state, theme),
          ...renderExternalStatuses(footerData, theme),
          theme.fg("dim", modelPart),
          tpsPart,
          contextPart,
          ...(showApiPrice ? [pricePart] : []),
        ];
        const statusLine = parts.join(theme.fg("dim", "  ·  "));
        const ellipsis = theme.fg("dim", "...");
        const splitLine = splitFooterLine(statusLine, pathLine, width, ellipsis);

        if (splitLine) {
          return [splitLine];
        }

        return [
          truncateToWidth(statusLine, width, ellipsis),
          rightAlign(pathLine, width, ellipsis),
        ];
      },
    };
  });
}

export function disposeHiveFooter(ctx?: ExtensionContext) {
  if (gitInterval) {
    clearInterval(gitInterval);
    gitInterval = undefined;
  }
  requestFooterRender = undefined;
  if (ctx?.mode === "tui") ctx.ui.setFooter(undefined);
}

export function registerFooterHooks(pi: ExtensionAPI, state: HiveState) {
  pi.on("thinking_level_select", async () => {
    requestHiveFooterRender();
  });

  pi.on("model_select", async () => {
    requestHiveFooterRender();
  });

  pi.on("agent_start", async () => {
    totalOutputTokens = 0;
    totalStreamMs = 0;
    messageStart = null;
    streamStart = null;
    estimatedStreamedTokens = 0;
    tpsText = "⚡ generating";
    requestHiveFooterRender();
  });

  pi.on("message_start", async (event: any) => {
    if (event.message?.role !== "assistant") return;
    messageStart = Date.now();
    streamStart = null;
    estimatedStreamedTokens = 0;
  });

  pi.on("message_update", async (event: any) => {
    if (event.message?.role !== "assistant") return;

    const streamEvent = event.assistantMessageEvent;
    const isOutputDelta =
      streamEvent?.type === "text_delta" ||
      streamEvent?.type === "thinking_delta" ||
      streamEvent?.type === "toolcall_delta";

    if (!isOutputDelta) return;

    const now = Date.now();
    streamStart ??= now;
    estimatedStreamedTokens += Math.max(0, streamEvent.delta.length / 4);

    const elapsed = (now - streamStart) / 1000;
    const officialTokens = event.message?.usage?.output || 0;
    const currentTokens = officialTokens > 0 ? officialTokens : estimatedStreamedTokens;

    if (elapsed > 0 && currentTokens > 0) {
      const tps = Math.round(currentTokens / elapsed);
      tpsText = `⚡ ${tps} tok/s`;
      requestHiveFooterRender();
    }
  });

  pi.on("message_end", async (event: any) => {
    if (event.message?.role !== "assistant") return;

    const messageTokens = event.message?.usage?.output || 0;
    const timingStart = streamStart ?? messageStart;
    if (!timingStart || messageTokens <= 0) {
      messageStart = null;
      streamStart = null;
      estimatedStreamedTokens = 0;
      return;
    }

    totalOutputTokens += messageTokens;
    totalStreamMs += Math.max(0, Date.now() - timingStart);

    messageStart = null;
    streamStart = null;
    estimatedStreamedTokens = 0;
    requestHiveFooterRender();
  });

  pi.on("agent_end", async (_event: any, ctx: ExtensionContext) => {
    const elapsed = totalStreamMs / 1000;
    const tps = totalOutputTokens > 0 && elapsed > 0 ? Math.round(totalOutputTokens / elapsed) : 0;
    tpsText = tps > 0 ? `⚡ ${tps} tok/s` : "⚡ idle";
    requestHiveFooterRender();

    if (!ctx.hasUI) return;
    const theme = ctx.ui.theme;
    const tpsLabel = tps > 0 ? theme.fg("accent", `${tps} tok/s`) : theme.fg("dim", "N/A");
    const detail = theme.fg("dim", `${totalOutputTokens} tokens in ${elapsed.toFixed(1)}s streaming`);
    ctx.ui.notify(`${theme.fg("success", "✓")} ${tpsLabel}  ${detail}`, "info");
  });

  pi.on("input", async () => {
    requestHiveFooterRender();
  });

  pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
    disposeHiveFooter(ctx);
  });
}
