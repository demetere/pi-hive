import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentType, HiveState, ReviewVerdictLevel } from "../core/types";
import { PLAN_STAGES } from "../core/normalize";
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
import { currentAgentName, currentChangeId } from "../engine/session";
import { emitHiveEvent } from "../engine/observability";
import { approveGate, changeExists, createChange, listChangeIds, readPlanMeta, toChangeId } from "../engine/plan-store";

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

  const callerRuntime = state.runtimes.get(callerName.toLowerCase())
    || (callerName === "Orchestrator" ? state.runtimes.get(state.config?.orchestrator?.name?.toLowerCase() || "") : undefined);
  // The visible main session's tools are registered before config/runtimes are
  // loaded, and its configured name may be "Plan Main" / "Hive Main" rather
  // than the legacy literal "Orchestrator". Treat that registered top-level
  // tool set as a lead so plan lifecycle tools are available in plan mode.
  const callerType: AgentType | undefined = callerRuntime?.config.agentType || (callerName === "Orchestrator" ? "lead" : undefined);

  const baseTools: ToolDefinition[] = [
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
      const verdicts = Array.from((state.latestVerdicts || new Map()).values());
      const verdictLines = verdicts.length
        ? ["", "latest verdicts:", ...verdicts.map((v) => `- ${v.changeId}: ${v.verdict.toUpperCase()} by ${v.reviewer}${v.verdict === "red" && v.blockers.length ? ` — ${v.blockers.length} blocker(s)` : v.verdict === "yellow" && v.concerns.length ? ` — ${v.concerns.length} concern(s)` : ""}${v.summary ? ` — ${v.summary.slice(0, 120)}` : ""}`)]
        : [];
      const text = [
        `session: ${state.session?.sessionId || "not initialized"}`,
        `conversation: ${state.session?.conversationLog || "n/a"}`,
        `active_runs: ${state.activeRuns}`,
        "",
        ...rows.map((row) => `- ${row.agent} [${row.group}] ${row.status}, runs=${row.runs}, tokens=${row.tokens}, cost=$${row.costUsd.toFixed(3)}${row.task ? ` — ${row.task.slice(0, 120)}` : ""}`),
        ...verdictLines,
      ].join("\n");
      return { content: [{ type: "text", text }], details: { session: state.session, activeRuns: state.activeRuns, agents: rows, verdicts } };
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

  // Type-scoped tools. These are granted by AGENT TYPE (not the tools list), so
  // they are appended here only for the eligible type and are kept through
  // dispatch's tools-list filter (see TYPE_SCOPED_TOOL_NAMES).
  const typeScopedTools: ToolDefinition[] = [];

  // submit_review_verdict — reviewer-only by construction. Non-reviewers never
  // see it, so there is no runtime-rejection path.
  if (callerType === "reviewer") {
    typeScopedTools.push(defineTool({
      name: "submit_review_verdict",
      label: "Submit Review Verdict",
      description: "Submit your FINAL structured review verdict (red/yellow/green). green = clean approval; yellow = approve with non-blocking concerns (proceed, surface them); red = blocked, list blockers. This is how a reviewer reports its conclusion — do not put the verdict only in chat text.",
      parameters: Type.Object({
        verdict: Type.Union([Type.Literal("red"), Type.Literal("yellow"), Type.Literal("green")], { description: "red = blocked (populate blockers); yellow = approve with non-blocking concerns; green = clean approval." }),
        summary: Type.String({ description: "One- or two-sentence summary of the review conclusion." }),
        evidence: Type.Optional(Type.Array(Type.String(), { description: "What was checked / commands run / files inspected." })),
        concerns: Type.Optional(Type.Array(Type.String(), { description: "Yellow: non-blocking follow-ups to surface to the human." })),
        blockers: Type.Optional(Type.Array(Type.String(), { description: "Red: must-fix items before proceeding." })),
        changeId: Type.Optional(Type.String({ description: "The change-id under review. Defaults to the active change if one is set." })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const p = params as { verdict: ReviewVerdictLevel; summary: string; evidence?: string[]; concerns?: string[]; blockers?: string[]; changeId?: string };
        const changeId = (p.changeId?.trim() || currentChangeId() || state.activeChangeId || "").trim();
        const evidence = p.evidence || [];
        const concerns = p.concerns || [];
        const blockers = p.blockers || [];
        // Emit as a telemetry event; the dashboard materializes it into
        // plan_verdicts. The core cannot reach bun:sqlite, so this is the path.
        emitHiveEvent(state, "review_verdict", { changeId, reviewer: callerName, verdict: p.verdict, summary: p.summary, evidence, concerns, blockers }, callerName);
        // Also cache in-memory so team_status can surface the latest verdict
        // without a SQLite read (the core has no access to plan_verdicts).
        if (changeId) {
          (state.latestVerdicts ||= new Map()).set(changeId, {
            changeId, reviewer: callerName, verdict: p.verdict, summary: p.summary,
            evidence, concerns, blockers, createdAt: new Date().toISOString(),
          });
        }
        const scope = changeId ? `change "${changeId}"` : "the current session (no active change-id)";
        const detail = p.verdict === "red" ? `${blockers.length} blocker(s)` : p.verdict === "yellow" ? `${concerns.length} concern(s)` : "clean";
        return {
          content: [{ type: "text", text: `Verdict recorded for ${scope}: ${p.verdict.toUpperCase()} — ${detail}. ${p.summary}` }],
          details: { ok: true, changeId, verdict: p.verdict, evidence, concerns, blockers },
        };
      },
    }));
  }

  // Plan lifecycle + approval tools. Available to leads (incl. the orchestrator),
  // who select/create a change and then delegate planners/coders under it.
  if (callerType === "lead") {
    typeScopedTools.push(defineTool({
      name: "plan_new",
      label: "New Plan",
      description: "Create a new plan change under .pi/hive/plans/<change-id>/ (scaffolds plan.yaml) and make it the active change. Planners you then delegate to will write proposal/requirements/design/tasks artifacts into it.",
      parameters: Type.Object({
        title: Type.String({ description: "Human title for the change (also used to derive the kebab change-id)." }),
        owner: Type.Optional(Type.String({ description: "Who owns this change. Optional." })),
      }),
      async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
        const { title, owner } = params as { title: string; owner?: string };
        const requestedChangeId = toChangeId(title);
        if (state.activeChangeId && changeExists(ctx.cwd, state.activeChangeId) && state.activeChangeId !== requestedChangeId) {
          return {
            content: [{
              type: "text",
              text: `This planning session already has active change "${state.activeChangeId}". Continue that plan and put related slices/gates inside it. To intentionally switch to another existing plan, use plan_select(changeId). Do not create a second plan from the same session unless the user explicitly asks to switch scope.`,
            }],
            details: { ok: false, activeChangeId: state.activeChangeId, requestedChangeId },
          };
        }
        const result = await createChange(ctx.cwd, title, owner, state.session?.sessionId);
        state.activeChangeId = result.changeId;
        const note = result.created ? "created" : "already existed";
        return { content: [{ type: "text", text: `Plan change "${result.changeId}" ${note} and is now the active change (${result.path}). Keep this session focused on this plan; add related slices to its proposal/requirements/design/tasks instead of creating sibling plans.` }], details: { ok: true, ...result } };
      },
    }));

    typeScopedTools.push(defineTool({
      name: "plan_select",
      label: "Select Plan",
      description: "Set the active plan change by change-id (must exist under .pi/hive/plans/). With no argument, lists available changes.",
      parameters: Type.Object({
        changeId: Type.Optional(Type.String({ description: "The change-id to activate. Omit to list available changes." })),
      }),
      async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
        const changeId = String((params as any).changeId || "").trim();
        const available = listChangeIds(ctx.cwd);
        if (!changeId) {
          const list = available.length ? available.map((id) => `- ${id}${state.activeChangeId === id ? " (active)" : ""}`).join("\n") : "(none)";
          return { content: [{ type: "text", text: `Available plan changes:\n${list}` }], details: { ok: true, available, active: state.activeChangeId } };
        }
        if (!changeExists(ctx.cwd, changeId)) {
          return { content: [{ type: "text", text: `No change "${changeId}" under .pi/hive/plans/. Available: ${available.join(", ") || "none"}. Use plan_new to create one.` }], details: { ok: false, available } };
        }
        state.activeChangeId = changeId;
        const meta = readPlanMeta(ctx.cwd, changeId);
        return { content: [{ type: "text", text: `Active change set to "${changeId}"${meta.phase ? ` (phase: ${meta.phase})` : ""}.` }], details: { ok: true, changeId, meta } };
      },
    }));

    typeScopedTools.push(defineTool({
      name: "approve_plan",
      label: "Approve Plan",
      description: "Record a chat-side approval of a planning gate (proposal/requirements/design/tasks) for a change. Use when the user has approved that gate in conversation.",
      parameters: Type.Object({
        phase: Type.Union(PLAN_STAGES.map((stage) => Type.Literal(stage)) as any, { description: "Which planning gate is approved." }),
        changeId: Type.Optional(Type.String({ description: "The change-id being approved. Defaults to the active change if set." })),
        actor: Type.Optional(Type.String({ description: "Who approved (e.g. the user's name). Optional." })),
        summary: Type.Optional(Type.String({ description: "Optional note about the approval." })),
      }),
      async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
        const p = params as { phase: string; changeId?: string; actor?: string; summary?: string };
        // Approval authority (G5): only the visible main session (human-driven)
        // may approve gates. A worker lead has this tool via TYPE_SCOPED_TOOL_NAMES
        // but must not approve its own gates — reject when an ALS agent context is
        // present (i.e. the caller is a delegated worker, not the main session).
        const caller = currentAgentName();
        const mainName = state.config?.orchestrator?.name;
        const isMainSession = caller === "Orchestrator" || (!!mainName && caller === mainName);
        if (!isMainSession) {
          return { content: [{ type: "text", text: `${caller} may not approve planning gates. Only the main session (human-driven) approves gates; ask the user to approve in chat.` }], details: { ok: false, reason: "worker cannot approve" } };
        }
        const changeId = (p.changeId?.trim() || currentChangeId() || state.activeChangeId || "").trim();
        if (!changeId) {
          return { content: [{ type: "text", text: "No active change-id. Select or create a change first, or pass changeId." }], details: { ok: false } };
        }
        if (!changeExists(ctx.cwd, changeId)) {
          const available = listChangeIds(ctx.cwd);
          return { content: [{ type: "text", text: `No change "${changeId}" under .pi/hive/plans/. Available: ${available.join(", ") || "none"}. Use plan_new to create one.` }], details: { ok: false, changeId, available } };
        }
        try {
          const meta = await approveGate(ctx.cwd, changeId, p.phase);
          emitHiveEvent(state, "plan_approval", { changeId, phase: p.phase, approvedBy: "main", actor: p.actor, summary: p.summary, nextPhase: meta.phase, status: meta.status }, callerName);
          const ready = meta.status === "ready" ? " Change is ready for /hive-execute." : ` Next phase: ${meta.phase}.`;
          return { content: [{ type: "text", text: `Approved gate "${p.phase}" for change "${changeId}".${ready}` }], details: { ok: true, changeId, phase: p.phase, meta } };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text", text: message }], details: { ok: false, changeId, phase: p.phase } };
        }
      },
    }));
  }

  return [...baseTools, ...typeScopedTools];
}

export function registerTools(pi: ExtensionAPI, state: HiveState) {
  for (const tool of buildHiveTools(state, "Orchestrator")) pi.registerTool(tool);
}
