import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AgentConfig, HiveState } from "../core/types";
import { configuredChildAgents, extractUsage, safeJson, textFromMessage, textOfResult, truncateMiddle } from "../core/utils";
import { logRecord } from "../engine/state";
import { reloadTeam } from "../engine/session";
import { enforceDomainForTool } from "../engine/domain";
import { buildOrchestratorPrompt } from "../agents/prompts";
import { applyMode, captureNormalTools, installHeader, updateWidget } from "../ui/tui/widget";
import { installHiveFooter, registerFooterHooks } from "../ui/tui/footer";
import { resolveHiveSddStatus } from "../engine/sdd";
import { ensureDashboard } from "../engine/dashboard";
import { emitHiveEvent } from "../engine/observability";

const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function registerHooks(pi: ExtensionAPI, state: HiveState) {
  registerFooterHooks(pi, state);

  pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
    // Enforcement (domain + agent-type policy) runs in plan AND hive mode; only
    // normal mode is unguarded plain Pi.
    if (state.mode === "normal") return;
    // Orchestrator tool telemetry parity (A5). This hook fires on the main
    // session's own tool calls; worker tool calls are emitted from dispatch.ts.
    const orch = state.orchestratorRuntime;
    if (orch) orch.toolCount++;
    emitHiveEvent(state, "orchestrator_tool_start", {
      agent: "Orchestrator",
      toolName: event.toolName || event.name || "unknown",
      toolCallId: event.toolCallId,
      args: truncateMiddle(safeJson(event.args ?? {}), 500),
    }, "Orchestrator");
    return enforceDomainForTool(state, event, ctx);
  });

  pi.on("tool_result", async (event: any) => {
    if (state.mode === "normal") return;
    emitHiveEvent(state, "orchestrator_tool_end", {
      agent: "Orchestrator",
      toolName: event.toolName || event.name || "unknown",
      toolCallId: event.toolCallId,
      isError: event.isError === true,
      resultPreview: truncateMiddle(textOfResult(event.result), 500),
    }, "Orchestrator");
  });

  pi.on("before_agent_start", async (event: any, _ctx: ExtensionContext) => {
    if (!state.config || state.mode === "normal") return;
    const planMode = state.mode === "plan";
    const catalog = state.config.agents.map((root) => {
      const lines: string[] = [];
      const renderCatalogAgent = (agent: AgentConfig, depth: number) => {
        const runtime = state.runtimes.get(agent.name.toLowerCase());
        const agentConfig = runtime?.config || agent;
        const tags = agentConfig.routingTags?.length ? ` [${agentConfig.routingTags.join(", ")}]` : "";
        const indent = "  ".repeat(depth);
        lines.push(`${indent}- ${agentConfig.name}${tags}: ${agentConfig.consultWhen || "team work"}`);
        for (const child of configuredChildAgents(agent)) renderCatalogAgent(child, depth + 1);
      };
      configuredChildAgents(root).forEach((child) => renderCatalogAgent(child, 1));
      return `## ${root.name}\n- ${root.name}${root.routingTags?.length ? ` [${root.routingTags.join(", ")}]` : ""}: ${root.consultWhen || "team work"}\n${lines.join("\n")}`;
    }).join("\n\n");

    const planBlock = planMode
      ? `# Plan mode — you are the main session of the PLANNING team
You are running as the visible main session in PLAN mode. Your job is to produce a COMPLETE spec for the requested change, not to implement it. Drive the planning team (or write artifacts yourself) to fill the plan store under \`.pi/hive/plans/<change-id>/\` one gate at a time: proposal → requirements → design → tasks. Use plan_new to create/select a change, delegate to planners for each gate, and stop at each gate for user confirmation when scope is uncertain. Do NOT write or modify production/test code in this mode — that is execution, which happens in hive mode. The end result of plan mode is an approved tasks.md; then the user switches to hive mode (or runs /hive-execute) to build it.

`
      : "";

    return {
      systemPrompt: `${event.systemPrompt}

# ${planMode ? "Hive plan mode" : "Hive orchestrator mode"}
${planBlock}${buildOrchestratorPrompt(state, _ctx)}

Use route_agent when the best specialist is not obvious, delegate to specialists with delegate_agent, then synthesize their findings.
Use team_status to inspect live team state and team_conversation(agent: "<name>") to read one specific agent's own transcript. When stable lessons should be preserved, ask the relevant specialist to update its own mental model.
Keep delegations focused and include enough context for the worker to act independently.

Available ${planMode ? "planners" : "agents"}:
${catalog}`,
    };
  });

  pi.on("message_update", async (event: any) => {
    const delta = (event as any).assistantMessageEvent;
    if (delta?.type === "text_delta" && typeof delta.delta === "string") {
      if (!state.streamStartMs) state.streamStartMs = Date.now();
      state.streamedChars += delta.delta.length;
      const elapsedSeconds = Math.max(0.1, (Date.now() - state.streamStartMs) / 1000);
      state.lastTokPerSec = (state.streamedChars / 4) / elapsedSeconds;
    }
  });

  pi.on("message_end", async (event: any) => {
    if ((event as any).message?.role === "assistant") {
      state.streamStartMs = 0;
      state.streamedChars = 0;
    }
    // This hook is registered once, on the orchestrator's own pi: ExtensionAPI
    // — workers run as separate in-process AgentSessions (see dispatchAgent)
    // that never load pi-hive's extension hooks, so this handler structurally
    // never fires for worker output. It only ever sees the orchestrator's own
    // messages. Each worker keeps its own full transcript in agents/<slug>.jsonl
    // (read it via team_conversation(agent)) — unbounded worker output (a
    // mental-model YAML can be hundreds of KB) never reaches the shared log.
    if (state.mode === "normal") return;
    const message = (event as any).message;
    const role = message?.role;
    if (!role || role === "toolResult") return;
    // Accumulate the orchestrator's own usage/cost so the main session gets the
    // same token/cost observability workers have (A5).
    if (role === "assistant" && message?.usage && state.orchestratorRuntime) {
      const u = extractUsage(message.usage);
      const orch = state.orchestratorRuntime;
      orch.inputTokens += u.input;
      orch.outputTokens += u.output;
      orch.cacheReadTokens += u.cacheRead;
      orch.cacheWriteTokens += u.cacheWrite;
      orch.costUsd += u.cost;
    }
    const text = textFromMessage(message).trim();
    if (!text) return;
    const from = role === "user" ? "User" : role === "assistant" ? "Orchestrator" : role;
    logRecord(state, { from, type: role, message: text });
    emitHiveEvent(state, role === "user" ? "user_message" : "assistant_message", { text: text.slice(0, 8000) }, from);
  });

  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    state.widgetCtx = ctx;
    state.onRuntimeUpdate = () => updateWidget(state);
    state.onRuntimeFinish = (runtime, finishCtx) => {
      if (finishCtx.hasUI) finishCtx.ui.notify(`${runtime.config.name} ${runtime.status} in ${Math.round(runtime.elapsedMs / 1000)}s`, runtime.status === "done" ? "success" : "error");
    };
    try {
      reloadTeam(state, ctx);
      state.sddStatus = resolveHiveSddStatus(state, ctx.cwd);
      logRecord(state, { from: "System", type: "system", message: "Session started" });
      captureNormalTools(state);
      applyMode(state, ctx, "normal", { notify: false });
      // Other globally-installed footer extensions may also handle session_start.
      // Reinstall Hive's footer after the session_start dispatch settles so
      // hive-configured projects keep the Hive-extended footer instead of the
      // last generic footer that happened to register.
      if (ctx.mode === "tui") setTimeout(() => installHiveFooter(state, ctx), 0);
      // Ensure the shared, global telemetry dashboard daemon is running. This
      // hook only fires for hive-opted-in projects (the extension registers
      // nothing otherwise), so the opt-in gate is satisfied. Fire-and-forget and
      // Bun-gated: the first hive session with Bun starts the daemon, later
      // sessions adopt the running one. No browser tab opens automatically — the
      // header shows the URL. It is NOT torn down on session shutdown (shared).
      void ensureDashboard(state, ctx, EXTENSION_ROOT, { open: false }).then((result) => {
        if (result.running && ctx.mode === "tui") installHeader(state, ctx);
      }).catch(() => { /* best-effort; the dashboard is optional */ });
      const missingSkills = Array.from(state.runtimes.values()).flatMap((runtime) =>
        (runtime.config.skills || [])
          .filter((ref) => !existsSync(ref.path.startsWith("/") ? ref.path : resolve(ctx.cwd, ref.path)))
          .map((ref) => `${runtime.config.name}: ${ref.path}`),
      );
      const missing = missingSkills.length ? `\nMissing configured skills: ${missingSkills.slice(0, 5).join(", ")}${missingSkills.length > 5 ? "..." : ""}` : "";
      if (ctx.hasUI) ctx.ui.notify(`Hive loaded: ${state.runtimes.size} agents in normal mode\nUse /hive-toggle or Ctrl+Alt+T to switch to orchestrator mode.${missing}`, missingSkills.length ? "warning" : "info");
    } catch (error: any) {
      // H5: on a config-load failure, force the session back to plain-Pi normal
      // mode so it is never left with hive tools registered but unconfigured.
      // Best-effort — capture whatever the current tool set is and restore it.
      try {
        state.mode = "normal";
        captureNormalTools(state);
        applyMode(state, ctx, "normal", { notify: false });
      } catch { /* nothing more we can do; the notify below tells the user */ }
      if (ctx.hasUI) ctx.ui.notify(`Hive failed to load: ${error?.message || error}`, "error");
    }
  });

  pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
    for (const runtime of state.runtimes.values()) {
      if (runtime.timer) clearInterval(runtime.timer);
      if (runtime.session) { try { runtime.session.dispose(); } catch { /* noop */ } runtime.session = undefined; }
    }
    // The telemetry dashboard is a SHARED global daemon — other sessions may be
    // using it — so we do NOT kill it here. Just drop this session's reference.
    // Explicit teardown is /hive-observe-stop.
    state.obsServer = undefined;
    if (state.dashboardActionTimer) clearInterval(state.dashboardActionTimer);
    state.dashboardActionTimer = undefined;
    state.dashboardActionOffset = undefined;
    state.onRuntimeUpdate = undefined;
    state.onRuntimeFinish = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
      ctx.ui.setWidget("hive-tree", undefined);
    }
    if (ctx.hasUI) ctx.ui.setStatus("hive", undefined);
  });
}
