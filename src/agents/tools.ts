import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { HiveState } from "../core/types";
import {
  extractFinalAnswer,
  hexAnsi,
  safeRead,
  tailLines,
  truncateMiddle,
} from "../core/utils";
import { routeAgents } from "../engine/routing";
import { dispatchAgent, distillMentalModel } from "../engine/dispatch";
import { renderHiveSddStatus, resolveHiveSddStatus } from "../engine/sdd";

type ToolUpdate = (result: any) => void;
type ToolRenderOptions = { isPartial?: boolean; expanded?: boolean };

// Builds pi-hive's five custom tools as plain, reusable ToolDefinition objects
// (defineTool() does no registration — it's a pure identity/typing wrapper).
// The SAME definitions are used for the orchestrator's own pi.registerTool()
// call and for every worker AgentSession's customTools, so tool behavior never
// diverges between "the orchestrator's delegate_agent" and "a worker's own
// delegate_agent" (nested delegation intentionally grants workers this tool
// too — see normalizeWorkerTools's comment in core/normalize.ts).
export function buildHiveTools(state: HiveState, callerName: string): ToolDefinition[] {
  // Render an agent's name in ITS OWN configured color (matching the status
  // modal), falling back to the theme accent if no/invalid hex is configured.
  const agentColored = (name: string, theme: any): string => {
    const color = state.runtimes.get(name.toLowerCase())?.config.color;
    return hexAnsi(color, name) || theme.fg("accent", name);
  };

  return [
    defineTool({
    name: "route_agent",
    label: "Route Agent",
    description: "Score the configured hive agents for a task and recommend who should handle it before delegation.",
    parameters: Type.Object({
      task: Type.String({ description: "The user's task or subtask to route." }),
      limit: Type.Optional(Type.Number({ description: "Maximum number of recommended agents to return." })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { task, limit } = params as { task: string; limit?: number };
      const recommendations = routeAgents(state, task, Math.max(1, Math.min(10, Number(limit || 5))));
      const text = recommendations.length
        ? recommendations.map((entry, index) => `${index + 1}. ${entry.name}${entry.group ? ` (${entry.group})` : ""} — score ${entry.score}${entry.reasons.length ? ` — ${entry.reasons.join(", ")}` : ""}`).join("\n")
        : "No strong route found. Use Planning Lead for clarification or Engineering Lead for codebase mapping.";
      return { content: [{ type: "text", text }], details: { task, recommendations } };
    },
  }),

  defineTool({
    name: "team_status",
    label: "Team Status",
    description: "Return the current hive session, log path, active workers, and per-agent state.",
    parameters: Type.Object({}),
    async execute() {
      const rows = Array.from(state.runtimes.values()).map((runtime) => ({
        agent: runtime.config.name,
        group: runtime.config.groupName || "Orchestration",
        status: runtime.status,
        runs: runtime.runCount,
        task: runtime.task,
        lastWork: runtime.lastWork,
        costUsd: runtime.costUsd,
        tokens: runtime.inputTokens + runtime.outputTokens,
      }));
      const text = [
        `session: ${state.session?.sessionId || "not initialized"}`,
        `conversation: ${state.session?.conversationLog || "n/a"}`,
        `active_runs: ${state.activeRuns}`,
        "",
        ...rows.map((row) => `- ${row.agent} [${row.group}] ${row.status}, runs=${row.runs}, tokens=${row.tokens}, cost=$${row.costUsd.toFixed(3)}${row.task ? ` — ${row.task.slice(0, 120)}` : ""}`),
      ].join("\n");
      return { content: [{ type: "text", text }], details: { session: state.session, activeRuns: state.activeRuns, agents: rows } };
    },
  }),

  defineTool({
    name: "delegate_agent",
    label: "Delegate Agent",
    description: "Delegate a focused task to one configured hive agent and receive its answer. Use this for all substantive work. By default the agent RESUMES its prior session (it remembers earlier work — ideal for a review→fix loop); pass fresh=true to start it from a clean slate.",
    parameters: Type.Object({
      agent: Type.String({ description: "Configured agent name, e.g. Frontend Dev, Backend Dev, Planning Lead." }),
      task: Type.String({ description: "Focused task for that agent. Include the exact question and expected output." }),
      fresh: Type.Optional(Type.Boolean({ description: "Start the agent from a clean session, discarding its prior memory. Default false (resume). Use when the previous session is irrelevant or should not influence this task." })),
    }),
    async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
      const { agent, task, fresh } = params as { agent: string; task: string; fresh?: boolean };
      onUpdate?.({ content: [{ type: "text", text: `Delegating to ${agent}${fresh ? " (fresh session)" : ""}...` }], details: { agent, task, status: "running" } });
      const result = await dispatchAgent(state, agent, task, ctx, Boolean(fresh));
      // Fire-and-forget memory distillation on success. Non-blocking: the
      // worker's answer returns immediately; the distiller reads a snapshot, so
      // re-delegating the same agent never races it.
      if (result.exitCode === 0) {
        const distillRuntime = state.runtimes.get(agent.toLowerCase());
        if (distillRuntime) void distillMentalModel(state, ctx, distillRuntime);
      }
      const limit = state.config?.settings.subagentOutputLimit || 12_000;
      const finalAnswer = extractFinalAnswer(result.output);
      const output = truncateMiddle(finalAnswer || result.output, limit);
      return {
        content: [{ type: "text", text: `[${agent}] ${result.exitCode === 0 ? "done" : "error"} in ${Math.round(result.elapsed / 1000)}s${finalAnswer ? " — final_answer extracted" : ""}\n\n${output}` }],
        details: { agent, task, status: result.exitCode === 0 ? "done" : "error", elapsed: result.elapsed, exitCode: result.exitCode, finalAnswer, outputPreview: output },
      };
    },
    renderCall(args: unknown, theme: any) {
      const agent = (args as any).agent || "?";
      const task = String((args as any).task || "");
      return new Text(theme.fg("toolTitle", theme.bold("delegate_agent ")) + agentColored(agent, theme) + theme.fg("dim", ` — ${task.slice(0, 80)}`), 0, 0);
    },
    renderResult(result: any, options: ToolRenderOptions, theme: any) {
      const details = result.details as any;
      const agent = details?.agent || "agent";
      if (options.isPartial || details?.status === "running") return new Text(theme.fg("accent", "● ") + agentColored(agent, theme) + theme.fg("accent", " working..."), 0, 0);
      const ok = details?.status === "done";
      const header = theme.fg(ok ? "success" : "error", `${ok ? "✓" : "✗"} `) + agentColored(agent, theme) + theme.fg("dim", ` ${Math.round((details?.elapsed || 0) / 1000)}s`);
      if (options.expanded && details?.outputPreview) return new Text(`${header}\n${theme.fg("muted", truncateMiddle(details.outputPreview, 4000))}`, 0, 0);
      return new Text(header, 0, 0);
    },
  }),

  defineTool({
    name: "team_conversation",
    label: "Team Conversation",
    description: "Read one agent's own session transcript (clean — just that agent's work, e.g. to inspect what a reviewer found). You MUST name the agent: this tool is intentionally scoped per-agent. The shared interleaved team log is not readable this way because it is unbounded and would flood your context.",
    parameters: Type.Object({
      agent: Type.String({ description: "REQUIRED. Agent name (e.g. 'Security Reviewer'). Reads that agent's own session transcript." }),
      lines: Type.Optional(Type.Number({ description: "Number of JSONL lines from the tail to read (default 80, max 1000)." })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      if (!state.session) return { content: [{ type: "text", text: "hive session not initialized" }], details: { ok: false } };
      const lines = Math.max(1, Math.min(1000, Number((params as any).lines || 80)));
      const agentName = String((params as any).agent || "").trim();
      // Scoped-only: an empty agent (including a lines-only call) is rejected.
      // Reading the shared log dumped its entire interleaved tail — individual
      // records embed full agent outputs, so an 80-line tail could be >500KB and
      // blow up the caller's context. Per-agent transcripts are bounded.
      if (!agentName) {
        const available = Array.from(state.runtimes.values()).map((a) => a.config.name).join(", ");
        return { content: [{ type: "text", text: `team_conversation requires an 'agent' name. Pass one of: ${available}.` }], details: { ok: false } };
      }
      const runtime = state.runtimes.get(agentName.toLowerCase());
      if (!runtime) {
        const available = Array.from(state.runtimes.values()).map((a) => a.config.name).join(", ");
        return { content: [{ type: "text", text: `Unknown agent "${agentName}". Available: ${available}` }], details: { ok: false } };
      }
      const limit = state.config?.settings.subagentOutputLimit || 12_000;
      const text = truncateMiddle(tailLines(safeRead(runtime.sessionFile), lines), limit);
      return { content: [{ type: "text", text: text || `${runtime.config.name} has no session transcript yet.` }], details: { ok: true, agent: runtime.config.name, lines } };
    },
  }),

  defineTool({
    name: "hive_sdd_status",
    label: "Hive SDD Status",
    description: "Inspect OpenSpec/SDD status for this project and show the recommended hive phase routing.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
      const status = resolveHiveSddStatus(state, ctx.cwd);
      state.sddStatus = status;
      return { content: [{ type: "text", text: renderHiveSddStatus(status) }], details: status };
    },
  }),
  ];
}

export function registerTools(pi: ExtensionAPI, state: HiveState) {
  for (const tool of buildHiveTools(state, "Orchestrator")) pi.registerTool(tool);
}
