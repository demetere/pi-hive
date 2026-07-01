import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentConfig, HiveState } from "../core/types";
import { configuredChildAgents, textFromMessage } from "../core/utils";
import { logRecord } from "../engine/state";
import { reloadTeam } from "../engine/session";
import { enforceDomainForTool } from "../engine/domain";
import { buildOrchestratorPrompt } from "../agents/prompts";
import { applyTeamMode, captureNormalTools, updateWidget } from "../ui/tui/widget";
import { resolveHiveSddStatus } from "../engine/sdd";
import { emitHiveEvent, hiveTopology, registerHiveTelemetrySession, writeHiveStateSnapshot } from "../engine/observability";

export function registerHooks(pi: ExtensionAPI, state: HiveState) {
  pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
    if (state.teamMode === "normal") return;
    return enforceDomainForTool(state, event, ctx);
  });

  pi.on("before_agent_start", async (event: any, _ctx: ExtensionContext) => {
    if (!state.config || state.teamMode === "normal") return;
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

    return {
      systemPrompt: `${event.systemPrompt}

# Hive orchestrator mode
${buildOrchestratorPrompt(state, _ctx)}

Use route_agent when the best specialist is not obvious, delegate to specialists with delegate_agent, then synthesize their findings.
Use team_status to inspect live team state and team_conversation(agent: "<name>") to read one specific agent's own transcript. When stable lessons should be preserved, ask the relevant specialist to update its own mental model.
Keep delegations focused and include enough context for the worker to act independently.

Available agents:
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
    const message = (event as any).message;
    const role = message?.role;
    if (!role || role === "toolResult") return;
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
      registerHiveTelemetrySession(state, ctx.cwd);
      emitHiveEvent(state, "session_start", {
        cwd: ctx.cwd,
        sessionDir: state.session.sessionDir,
        conversationLog: state.session.conversationLog,
        observabilityLog: state.session.observabilityLog,
        topology: hiveTopology(state),
      }, "System");
      writeHiveStateSnapshot(state);
      captureNormalTools(state);
      applyTeamMode(state, ctx, "normal", { notify: false });
      const missingSkills = Array.from(state.runtimes.values()).flatMap((runtime) =>
        (runtime.config.skills || [])
          .filter((ref) => !existsSync(ref.path.startsWith("/") ? ref.path : resolve(ctx.cwd, ref.path)))
          .map((ref) => `${runtime.config.name}: ${ref.path}`),
      );
      const missing = missingSkills.length ? `\nMissing configured skills: ${missingSkills.slice(0, 5).join(", ")}${missingSkills.length > 5 ? "..." : ""}` : "";
      if (ctx.hasUI) ctx.ui.notify(`Hive loaded: ${state.runtimes.size} agents in normal mode\nUse /hive-toggle or Ctrl+Alt+T to switch to orchestrator mode.${missing}`, missingSkills.length ? "warning" : "info");
    } catch (error: any) {
      if (ctx.hasUI) ctx.ui.notify(`Hive failed to load: ${error?.message || error}`, "error");
    }
  });

  pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
    for (const runtime of state.runtimes.values()) {
      if (runtime.timer) clearInterval(runtime.timer);
      if (runtime.session) { try { runtime.session.dispose(); } catch { /* noop */ } runtime.session = undefined; }
    }
    if (state.obsServer?.proc) {
      try { state.obsServer.proc.kill(); } catch { /* noop */ }
      state.obsServer = undefined;
    }
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
