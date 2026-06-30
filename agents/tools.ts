import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolve } from "node:path";
import type { HiveState } from "../core/types";
import {
  extractFinalAnswer,
  hexAnsi,
  readIfSmall,
  safeRead,
  tailLines,
  truncateMiddle,
} from "../core/utils";
import { currentAgentName } from "../engine/session";
import { routeAgents } from "../engine/routing";
import { skillName } from "./prompts";
import { dispatchAgent, distillMentalModel } from "../engine/dispatch";
import { findRegisteredSkill } from "../engine/skill-registry";
import { renderHiveSddStatus, resolveHiveSddStatus } from "../engine/sdd";

export function registerTools(pi: ExtensionAPI, state: HiveState) {
  // Render an agent's name in ITS OWN configured color (matching the status
  // modal), falling back to the theme accent if no/invalid hex is configured.
  const agentColored = (name: string, theme: any): string => {
    const color = state.runtimes.get(name.toLowerCase())?.config.color;
    return hexAnsi(color, name) || theme.fg("accent", name);
  };

  pi.registerTool({
    name: "route_agent",
    label: "Route Agent",
    description: "Score the configured hive agents for a task and recommend who should handle it before delegation.",
    parameters: Type.Object({
      task: Type.String({ description: "The user's task or subtask to route." }),
      limit: Type.Optional(Type.Number({ description: "Maximum number of recommended agents to return." })),
    }),
    async execute(_toolCallId, params) {
      const { task, limit } = params as { task: string; limit?: number };
      const recommendations = routeAgents(state, task, Math.max(1, Math.min(10, Number(limit || 5))));
      const text = recommendations.length
        ? recommendations.map((entry, index) => `${index + 1}. ${entry.name}${entry.group ? ` (${entry.group})` : ""} — score ${entry.score}${entry.reasons.length ? ` — ${entry.reasons.join(", ")}` : ""}`).join("\n")
        : "No strong route found. Use Planning Lead for clarification or Engineering Lead for codebase mapping.";
      return { content: [{ type: "text", text }], details: { task, recommendations } };
    },
  });

  pi.registerTool({
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
  });

  pi.registerTool({
    name: "delegate_agent",
    label: "Delegate Agent",
    description: "Delegate a focused task to one configured hive agent and receive its answer. Use this for all substantive work. By default the agent RESUMES its prior session (it remembers earlier work — ideal for a review→fix loop); pass fresh=true to start it from a clean slate.",
    parameters: Type.Object({
      agent: Type.String({ description: "Configured agent name, e.g. Frontend Dev, Backend Dev, Planning Lead." }),
      task: Type.String({ description: "Focused task for that agent. Include the exact question and expected output." }),
      fresh: Type.Optional(Type.Boolean({ description: "Start the agent from a clean session, discarding its prior memory. Default false (resume). Use when the previous session is irrelevant or should not influence this task." })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
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
        details: { agent, task, status: result.exitCode === 0 ? "done" : "error", elapsed: result.elapsed, exitCode: result.exitCode, finalAnswer, fullOutput: result.output },
      };
    },
    renderCall(args, theme) {
      const agent = (args as any).agent || "?";
      const task = String((args as any).task || "");
      return new Text(theme.fg("toolTitle", theme.bold("delegate_agent ")) + agentColored(agent, theme) + theme.fg("dim", ` — ${task.slice(0, 80)}`), 0, 0);
    },
    renderResult(result, options, theme) {
      const details = result.details as any;
      const agent = details?.agent || "agent";
      if (options.isPartial || details?.status === "running") return new Text(theme.fg("accent", "● ") + agentColored(agent, theme) + theme.fg("accent", " working..."), 0, 0);
      const ok = details?.status === "done";
      const header = theme.fg(ok ? "success" : "error", `${ok ? "✓" : "✗"} `) + agentColored(agent, theme) + theme.fg("dim", ` ${Math.round((details?.elapsed || 0) / 1000)}s`);
      if (options.expanded && details?.fullOutput) return new Text(`${header}\n${theme.fg("muted", truncateMiddle(details.fullOutput, 4000))}`, 0, 0);
      return new Text(header, 0, 0);
    },
  });

  pi.registerTool({
    name: "team_conversation",
    label: "Team Conversation",
    description: "Read one agent's own session transcript (clean — just that agent's work, e.g. to inspect what a reviewer found). You MUST name the agent: this tool is intentionally scoped per-agent. The shared interleaved team log is not readable this way because it is unbounded and would flood your context.",
    parameters: Type.Object({
      agent: Type.String({ description: "REQUIRED. Agent name (e.g. 'Security Reviewer'). Reads that agent's own session transcript." }),
      lines: Type.Optional(Type.Number({ description: "Number of JSONL lines from the tail to read (default 80, max 1000)." })),
    }),
    async execute(_toolCallId, params) {
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
  });

  pi.registerTool({
    name: "hive_sdd_status",
    label: "Hive SDD Status",
    description: "Inspect OpenSpec/SDD status for this project and show the recommended hive phase routing.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const status = resolveHiveSddStatus(state, ctx.cwd);
      state.sddStatus = status;
      return { content: [{ type: "text", text: renderHiveSddStatus(status) }], details: status };
    },
  });

  pi.registerTool({
    name: "load_skill",
    label: "Load Skill",
    description: "Load the full instructions for one of your configured skills, by name. Call this before doing work the skill applies to (the skill menu in your prompt lists what is available).",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name as shown in your skill menu, e.g. backend-change-review." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = String((params as any).name || "").trim();
      const runtime = state.runtimes.get(currentAgentName().toLowerCase());
      const skills = runtime?.config.skills || [];
      const match = skills.find((ref) => skillName(ref).toLowerCase() === name.toLowerCase());
      const registryMatch = match ? undefined : findRegisteredSkill(state, name);
      if (!match && !registryMatch) {
        const configured = skills.map(skillName);
        const discovered = state.skillRegistry.map((entry) => entry.name).slice(0, 30);
        const available = [...configured, ...discovered].join(", ") || "none";
        return { content: [{ type: "text", text: `No skill named "${name}". Available: ${available}.` }], details: { ok: false } };
      }
      const skillPath = match?.path || registryMatch!.path;
      const content = readIfSmall(resolve(ctx.cwd, skillPath), 96_000);
      if (!content) return { content: [{ type: "text", text: `Skill "${name}" is not readable (${skillPath}).` }], details: { ok: false } };
      return { content: [{ type: "text", text: content }], details: { ok: true, skill: name, path: skillPath, source: match ? "configured" : "registry" } };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("load_skill ")) + theme.fg("accent", String((args as any).name || "?")), 0, 0);
    },
  });
}
