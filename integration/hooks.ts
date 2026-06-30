import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, HiveState } from "../core/types";
import { configuredChildAgents, textFromMessage } from "../core/utils";
import { logRecord } from "../engine/state";
import { reloadTeam } from "../engine/session";
import { enforceDomainForTool } from "../engine/domain";
import { startConversationWatch, stopConversationWatch } from "../engine/watch";
import { buildOrchestratorPrompt } from "../agents/prompts";
import { applyTeamMode, captureNormalTools } from "../ui/tui/widget";
import { refreshSkillRegistry } from "../engine/skill-registry";
import { resolveHiveSddStatus } from "../engine/sdd";
import { emitHiveEvent, hiveTopology, registerHiveTelemetrySession, writeHiveStateSnapshot } from "../engine/observability";

export function registerHooks(pi: ExtensionAPI, state: HiveState) {
  pi.on("tool_call", async (event, ctx) => {
    if (state.teamMode === "normal" && process.env.PI_HIVE_CHILD !== "1") return;
    return enforceDomainForTool(state, event, ctx);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!state.config || process.env.PI_HIVE_CHILD === "1" || state.teamMode === "normal") return;
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

  pi.on("message_update", async (event) => {
    if (process.env.PI_HIVE_CHILD === "1") return;
    const delta = (event as any).assistantMessageEvent;
    if (delta?.type === "text_delta" && typeof delta.delta === "string") {
      if (!state.streamStartMs) state.streamStartMs = Date.now();
      state.streamedChars += delta.delta.length;
      const elapsedSeconds = Math.max(0.1, (Date.now() - state.streamStartMs) / 1000);
      state.lastTokPerSec = (state.streamedChars / 4) / elapsedSeconds;
    }
  });

  pi.on("message_end", async (event) => {
    if ((event as any).message?.role === "assistant") {
      state.streamStartMs = 0;
      state.streamedChars = 0;
    }
    // Only the top-level orchestrator narrates into the SHARED log. Child
    // processes (workers, distiller) would otherwise dump their full messages
    // here — mislabeled as "Orchestrator" and unbounded (a worker answer or a
    // mental-model YAML can be hundreds of KB), which is what bloated the shared
    // log and blew up team_conversation. Each child already keeps its own full
    // transcript in agents/<slug>.jsonl (read it via team_conversation(agent)).
    if (process.env.PI_HIVE_CHILD === "1") return;
    const message = (event as any).message;
    const role = message?.role;
    if (!role || role === "toolResult") return;
    const text = textFromMessage(message).trim();
    if (!text) return;
    const from = role === "user" ? "User" : role === "assistant" ? "Orchestrator" : role;
    logRecord(state, { from, type: role, message: text });
    emitHiveEvent(state, role === "user" ? "user_message" : "assistant_message", { text: text.slice(0, 8000) }, from);
  });

  pi.on("session_start", async (_event, ctx) => {
    state.widgetCtx = ctx;
    try {
      reloadTeam(state, ctx);
      const registry = refreshSkillRegistry(state, ctx);
      state.sddStatus = resolveHiveSddStatus(state, ctx.cwd);
      logRecord(state, { from: "System", type: "system", message: process.env.PI_HIVE_CHILD === "1" ? `Nested worker started: ${process.env.PI_HIVE_PARENT_AGENT || "unknown"}` : "Session started" });
      if (process.env.PI_HIVE_CHILD === "1") {
        emitHiveEvent(state, "agent_session_start", { parent: process.env.PI_HIVE_PARENT_AGENT || "unknown", agent: process.env.PI_HIVE_CURRENT_AGENT || "unknown" }, process.env.PI_HIVE_CURRENT_AGENT || "Worker");
        return;
      }
      registerHiveTelemetrySession(state, ctx.cwd);
      emitHiveEvent(state, "session_start", {
        cwd: ctx.cwd,
        sessionDir: state.session.sessionDir,
        conversationLog: state.session.conversationLog,
        observabilityLog: state.session.observabilityLog,
        topology: hiveTopology(state),
      }, "System");
      writeHiveStateSnapshot(state);
      // Top-level process only: mirror nested (lead→member) activity from the
      // shared log into our runtimes so the status modal shows the full tree.
      startConversationWatch(state);
      captureNormalTools(state);
      applyTeamMode(state, ctx, "normal", { notify: false });
      const missing = registry.missingConfigured.length ? `\nMissing configured skills: ${registry.missingConfigured.slice(0, 5).join(", ")}${registry.missingConfigured.length > 5 ? "..." : ""}` : "";
      ctx.ui.notify(`Hive loaded: ${state.runtimes.size} agents in normal mode\nSkill registry: ${registry.entries.length} skill(s) → ${registry.path}\nUse /hive-toggle or Ctrl+Alt+T to switch to orchestrator mode.${missing}`, registry.missingConfigured.length ? "warning" : "info");
    } catch (error: any) {
      ctx.ui.notify(`Hive failed to load: ${error?.message || error}`, "error");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopConversationWatch(state);
    for (const runtime of state.runtimes.values()) if (runtime.timer) clearInterval(runtime.timer);
    if (state.obsServer?.proc) {
      try { state.obsServer.proc.kill(); } catch { /* noop */ }
      state.obsServer = undefined;
    }
    ctx.ui.setHeader(undefined);
    ctx.ui.setFooter(undefined);
    ctx.ui.setStatus("hive", undefined);
    ctx.ui.setWidget("hive-tree", undefined);
  });
}
