import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool as definePiTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { resolve } from "node:path";
import type { AgentType, HiveState, ReviewVerdictLevel } from "../core/types";
import {
  extractFinalAnswer,
  hexAnsi,
  safeRead,
  tailLines,
  truncateMiddle,
} from "../core/utils";
import { routeAgents } from "../engine/routing";
import { dispatchAgent, scheduleMentalModelDistillation } from "../engine/dispatch";
import { renderHiveSddStatus, resolveHiveSddStatus } from "../engine/sdd";
import { currentAgentName, currentChangeId } from "../engine/session";
import { emitHiveEvent } from "../engine/observability";
import * as openspec from "../engine/openspec";
import { enqueueQuestion, recordQuestion } from "../engine/questions";
import { agentRef, agentRoster, resolveRuntime } from "../engine/agent-lookup";
import { agentSlug } from "../core/utils";
import { budgetRemaining } from "../engine/governance";

type ToolUpdate = AgentToolUpdateCallback<object>;
type ToolRenderOptions = { isPartial?: boolean; expanded?: boolean };

// Pi infers a tool's details shape from the first return branch. Hive tools
// intentionally return several bounded detail variants, so widen details to a
// JSON-like record while preserving each TypeBox parameter schema.
function defineTool<TParams extends TSchema>(
  tool: ToolDefinition<TParams, object>,
) {
  return definePiTool(tool);
}

// Structural Component shape. Avoid importing pi-tui's `Component` type: its
// barrel re-exports it with a `.ts` specifier that tsc (moduleResolution
// "Bundler") cannot resolve, so `import { type Component }` fails to typecheck.
type ToolRenderComponent = { render: (width: number) => string[]; invalidate: () => void };

function emptyToolRender(): ToolRenderComponent {
  return { render: () => [], invalidate() {} };
}

function boundedToolRender(lines: string[] | (() => string[]), ellipsis: string): ToolRenderComponent {
  return {
    invalidate() {},
    render(width: number): string[] {
      const safeWidth = Math.max(0, width - 2);
      if (safeWidth <= 0) return [];
      const rendered = typeof lines === "function" ? lines() : lines;
      return rendered.map((line) => truncateToWidth(line, safeWidth, ellipsis));
    },
  };
}

function boundedPositiveInteger(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(max, Math.floor(number)) : fallback;
}

function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "?";
  if (count < 1000) return Math.round(count).toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatContextFill(row: { contextPct?: number; contextTokens?: number; contextWindow?: number }): string {
  const pct = Number(row.contextPct);
  const pctText = Number.isFinite(pct) ? `${pct.toFixed(1)}%` : "?";
  const tokens = Number(row.contextTokens);
  const window = Number(row.contextWindow);
  const tokenText = Number.isFinite(tokens) && Number.isFinite(window) && window > 0
    ? ` (${formatTokens(tokens)}/${formatTokens(window)})`
    : Number.isFinite(window) && window > 0
      ? ` (of ${formatTokens(window)})`
      : "";
  return `${pctText}${tokenText}`;
}

function contextAdvice(contextPct?: number): "resume-ok" | "consider-fresh" | "fresh-recommended" {
  const pct = Number(contextPct);
  if (!Number.isFinite(pct)) return "resume-ok";
  if (pct >= 85) return "fresh-recommended";
  if (pct >= 75) return "consider-fresh";
  return "resume-ok";
}

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
    const runtime = resolveRuntime(state, name);
    const color = runtime?.config.color;
    return hexAnsi(color, runtime?.config.name || name) || theme.fg("accent", runtime?.config.name || name);
  };

  const callerRuntime = resolveRuntime(state, callerName);
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
      const recommendations = routeAgents(state, task, boundedPositiveInteger(limit, 5, 10));
      const text = recommendations.length
        ? recommendations.map((entry, index) => `${index + 1}. ${entry.slug} — ${entry.name}${entry.group ? ` (${entry.group})` : ""} — score ${entry.score}${entry.reasons.length ? ` — ${entry.reasons.join(", ")}` : ""}`).join("\n")
        : "No strong route found. Delegate to the team lead whose consultWhen best matches, or ask the user to clarify scope.";
      return { content: [{ type: "text", text }], details: { task, recommendations } };
    },
  }),

  defineTool({
    name: "team_status",
    label: "Team Status",
    description: "Return the current hive session, log path, active workers, per-agent state, and context-window fill so leads can decide whether to resume or use fresh=true.",
    parameters: Type.Object({}),
    async execute() {
      const rows = Array.from(state.runtimes.values()).map((runtime) => ({
        agent: agentRef(runtime),
        name: runtime.config.name,
        group: runtime.config.groupName || "Orchestration",
        status: runtime.status,
        runs: runtime.runCount,
        task: runtime.task,
        lastWork: runtime.lastWork,
        costUsd: runtime.costUsd,
        tokens: runtime.inputTokens + runtime.outputTokens,
        contextPct: runtime.contextPct,
        contextTokens: runtime.contextTokens,
        contextWindow: runtime.contextWindow,
        contextAdvice: contextAdvice(runtime.contextPct),
        budgetRemaining: budgetRemaining(state, runtime),
      }));
      const verdicts = Array.from((state.latestVerdicts || new Map()).values());
      const verdictLines = verdicts.length
        ? ["", "latest verdicts:", ...verdicts.map((v) => `- ${v.changeId}: ${v.verdict.toUpperCase()} by ${v.reviewer}${v.verdict === "red" && v.blockers.length ? ` — ${v.blockers.length} blocker(s)` : v.verdict === "yellow" && v.concerns.length ? ` — ${v.concerns.length} concern(s)` : ""}${v.summary ? ` — ${v.summary.slice(0, 120)}` : ""}`)]
        : [];
      const text = [
        `session: ${state.session?.sessionId || "not initialized"}`,
        `conversation: ${state.session?.conversationLog || "n/a"}`,
        `active_runs: ${state.activeRuns}`,
        `queued_runs: ${state.workerQueue?.length || 0}`,
        "",
        ...rows.map((row) => `- ${row.agent} [${row.group}] ${row.status}, runs=${row.runs}, ctx=${formatContextFill(row)} ${row.contextAdvice}, tokens=${row.tokens}, cost=$${row.costUsd.toFixed(3)}${Object.values(row.budgetRemaining.worker).some((value) => value !== undefined) ? `, remaining=${JSON.stringify(row.budgetRemaining.worker)}` : ""}${row.task ? ` — ${row.task.slice(0, 120)}` : ""}`),
        ...verdictLines,
      ].join("\n");
      return { content: [{ type: "text", text }], details: { session: state.session, activeRuns: state.activeRuns, queuedRuns: state.workerQueue?.length || 0, agents: rows, verdicts } };
    },
  }),

  defineTool({
    name: "delegate_agent",
    label: "Delegate Agent",
    description: "Delegate a focused task to one configured hive agent and receive its answer. Use this for all substantive work. By default the agent RESUMES its prior session (it remembers earlier work — ideal for a review→fix loop); pass fresh=true to start it from a clean slate.",
    parameters: Type.Object({
      agent: Type.String({ description: "Configured agent name (one of your delegation targets)." }),
      task: Type.String({ description: "Focused task for that agent. Include the exact question and expected output." }),
      fresh: Type.Optional(Type.Boolean({ description: "Start the agent from a clean session, discarding its prior memory. Default false (resume). Use when the previous session is irrelevant or should not influence this task." })),
    }),
    async execute(_toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
      const p = (params || {}) as { agent?: string; task?: string; fresh?: boolean };
      const agent = String(p.agent || "").trim();
      const task = String(p.task || "").trim();
      const fresh = p.fresh;
      if (!agent || !task) {
        const available = agentRoster(state);
        const missing = [!agent ? "agent" : "", !task ? "task" : ""].filter(Boolean).join(" and ");
        return {
          content: [{ type: "text", text: `delegate_agent requires ${missing}. Call it as {"agent":"<one of: ${available}>","task":"<focused task and expected output>"}.` }],
          details: { ok: false, status: "error", reason: "missing parameters", missing, available },
        };
      }
      onUpdate?.({ content: [{ type: "text", text: `Delegating to ${agent}${fresh ? " (fresh session)" : ""}...` }], details: { agent, task, status: "running" } });
      const result = await dispatchAgent(state, agent, task, ctx, Boolean(fresh), undefined, signal);
      // Fire-and-forget memory distillation on success. Non-blocking: the
      // worker's answer returns immediately; the distiller reads a snapshot, so
      // re-delegating the same agent never races it.
      if (result.exitCode === 0) {
        const distillRuntime = resolveRuntime(state, agent);
        if (distillRuntime) void scheduleMentalModelDistillation(state, ctx, distillRuntime);
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
      const task = truncateMiddle(String((args as any).task || ""), 500);
      const line = theme.fg("toolTitle", theme.bold("delegate_agent ")) +
        agentColored(agent, theme) +
        theme.fg("dim", task ? ` — ${task}` : "");
      return boundedToolRender([line], theme.fg("dim", "…"));
    },
    renderResult(result: any, options: ToolRenderOptions, theme: any) {
      const details = result.details as any;
      const agent = details?.agent || "agent";
      // While a delegation is running, the persistent Hive activity widget is
      // the single source of live progress. Rendering "working..." for every
      // nested delegate_agent call creates the repeated rows seen above the
      // editor, so keep the tool call line but suppress this interim result row.
      if (options.isPartial || details?.status === "running") return emptyToolRender();
      const ok = details?.status === "done";
      const header = theme.fg(ok ? "success" : "error", `${ok ? "✓" : "✗"} `) + agentColored(agent, theme) + theme.fg("dim", ` ${Math.round((details?.elapsed || 0) / 1000)}s`);
      if (options.expanded && details?.outputPreview) {
        const preview = theme.fg("muted", truncateMiddle(details.outputPreview, 4000));
        return boundedToolRender([header, preview], theme.fg("dim", "…"));
      }
      return boundedToolRender([header], theme.fg("dim", "…"));
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
      const lines = boundedPositiveInteger((params as any).lines, 80, 1000);
      const agentName = String((params as any).agent || "").trim();
      // Scoped-only: an empty agent (including a lines-only call) is rejected.
      // Reading the shared log dumped its entire interleaved tail — individual
      // records embed full agent outputs, so an 80-line tail could be >500KB and
      // blow up the caller's context. Per-agent transcripts are bounded.
      if (!agentName) {
        const available = agentRoster(state);
        return { content: [{ type: "text", text: `team_conversation requires an 'agent' slug or name. Pass one of: ${available}.` }], details: { ok: false } };
      }
      const runtime = resolveRuntime(state, agentName);
      if (!runtime) {
        const available = agentRoster(state);
        return { content: [{ type: "text", text: `Unknown agent "${agentName}". Available: ${available}` }], details: { ok: false } };
      }
      const limit = state.config?.settings.subagentOutputLimit || 12_000;
      const text = truncateMiddle(tailLines(safeRead(runtime.sessionFile), lines), limit);
      return { content: [{ type: "text", text: text || `${runtime.config.name} has no session transcript yet.` }], details: { ok: true, agent: agentSlug(runtime.config), name: runtime.config.name, lines } };
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

  defineTool({
    name: "ask_user",
    label: "Ask User",
    description: "Ask the human a clarifying question BEFORE writing plan artifacts when scope, requirements, or acceptance criteria are ambiguous. In a TUI session this pops a native input dialog and blocks for the answer (works from a delegated planner too, since it uses the main session's UI). Do not guess ambiguous requirements — ask.",
    parameters: Type.Object({
      question: Type.String({ description: "The specific clarifying question to put to the human." }),
      changeId: Type.Optional(Type.String({ description: "The change this question relates to. Defaults to the active change." })),
    }),
    async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
      const p = params as { question: string; changeId?: string };
      const question = String(p.question || "").trim();
      if (!question) return { content: [{ type: "text", text: "ask_user requires a non-empty question." }], details: { ok: false } };
      const change = (p.changeId?.trim() || currentChangeId() || state.activeChangeId || "").trim();
      const askedBy = currentAgentName();

      // Prefer pi's NATIVE input dialog and block this turn for the answer —
      // returning it directly to the caller, no dashboard-actions round-trip.
      // A delegated planner's own ctx is headless (hasUI:false), but workers run
      // in-process, so it reaches the MAIN session's ui via state.widgetCtx. Use
      // the worker's own ui when it has one, else the main session's TUI ui.
      const ownUi = ctx.hasUI ? (ctx as any).ui : undefined;
      const mainUi = state.widgetCtx?.mode === "tui" ? (state.widgetCtx as any).ui : undefined;
      const ui = (ownUi?.input ? ownUi : mainUi?.input ? mainUi : undefined) as
        | { input(title: string, placeholder?: string, opts?: { timeout?: number }): Promise<string | undefined>; notify?: (message: string, level?: "info" | "warning" | "error") => void }
        | undefined;
      if (ui) {
        let answer: string | undefined;
        try {
          // Pi's ExtensionInputComponent currently ignores its placeholder, so
          // the question must be visible outside the placeholder field.
          ui.notify?.(`Planning question from ${askedBy}: ${question}`, "info");
          answer = await ui.input(`Planning question from ${askedBy}: ${question}`, question);
        } catch {
          answer = undefined;
        }
        if (change) await recordQuestion(ctx.cwd, change, question, answer || undefined);
        if (answer && answer.trim()) {
          return { content: [{ type: "text", text: `User answered: ${answer.trim()}` }], details: { ok: true, question, answer: answer.trim() } };
        }
        return { content: [{ type: "text", text: "The user dismissed the question without answering. Proceed with a clearly-stated assumption and flag it for later confirmation." }], details: { ok: true, question, answer: null } };
      }

      // Truly headless (no TUI anywhere — cron / RPC / print mode): fall back to
      // the dashboard-actions bridge so the question is at least surfaced and
      // file-recorded, and the planner records an assumption to proceed.
      if (change) await recordQuestion(ctx.cwd, change, question);
      const mainDir = state.session?.sessionDir;
      const promoted = mainDir ? await enqueueQuestion(mainDir, { question, change: change || undefined, askedBy }) : false;
      const text = promoted
        ? `No interactive prompt is available; your question was recorded and surfaced to the dashboard:\n"${question}"\nRecord a clearly-stated assumption and proceed; flag it for the human to confirm.`
        : `No interactive session is available to answer right now. Record a clearly-stated assumption for "${question}", proceed, and flag it for the human to confirm.`;
      return { content: [{ type: "text", text }], details: { ok: true, question, promoted } };
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
      description: "Submit your FINAL structured review verdict (red/yellow/green). green = clean approval; yellow = approve with non-blocking concerns (proceed, surface them); red = blocked, list blockers. Reviewers MUST call this before their final answer; do not put the verdict only in chat text.",
      parameters: Type.Object({
        verdict: Type.Union([Type.Literal("red"), Type.Literal("yellow"), Type.Literal("green")], { description: "red = blocked (populate blockers); yellow = approve with non-blocking concerns; green = clean approval." }),
        summary: Type.String({ description: "One- or two-sentence summary of the review conclusion." }),
        evidence: Type.Optional(Type.Array(Type.String(), { description: "What was checked / commands run / files inspected." })),
        concerns: Type.Optional(Type.Array(Type.String(), { description: "Yellow: non-blocking follow-ups to surface to the human." })),
        blockers: Type.Optional(Type.Array(Type.String(), { description: "Red: must-fix items before proceeding." })),
        changeId: Type.Optional(Type.String({ description: "The change-id under review. Defaults to the active change if one is set." })),
        artifact: Type.Optional(Type.String({ description: "The OpenSpec artifact under review, e.g. proposal.md, design.md, specs/**/*.md, or tasks.md. Required for OpenSpec plan-review gates." })),
      }),
      async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
        const p = params as { verdict: ReviewVerdictLevel; summary: string; evidence?: string[]; concerns?: string[]; blockers?: string[]; changeId?: string; artifact?: string };
        const changeId = (p.changeId?.trim() || currentChangeId() || state.activeChangeId || "").trim();
        const evidence = p.evidence || [];
        const concerns = p.concerns || [];
        const blockers = p.blockers || [];
        // Persist content-bound automated review authority before publishing
        // telemetry or in-memory state. The queue covers the complete
        // validation/read/write window and shares a key with built-in writes.
        if (changeId && p.artifact?.trim()) {
          const artifact = p.artifact.trim();
          const recordPath = openspec.approvalRecordPath(ctx.cwd, changeId, artifact, "automated-review");
          if (!recordPath) throw new Error(`Invalid automated review target: ${changeId}/${artifact}`);
          await withFileMutationQueue(recordPath, async () => {
            openspec.setAgentReviewVerdict(ctx.cwd, changeId, artifact, p.verdict, callerName);
          });
        }
        // Emit only after authoritative persistence succeeds. The dashboard
        // materializes this event into plan_verdicts for display.
        emitHiveEvent(state, "review_verdict", { changeId, reviewer: callerName, verdict: p.verdict, summary: p.summary, evidence, concerns, blockers }, callerName);
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

  // Plan lifecycle tools. Available to leads (incl. the orchestrator), who
  // select/create an OpenSpec change and then delegate planners under it.
  // Approval is NOT a chat tool anymore: each artifact is approved in the
  // dashboard's plan-review UI (the review IS the gate). Approving the tasks
  // artifact opens the execution gate.
  if (callerType === "lead") {
    typeScopedTools.push(defineTool({
      name: "plan_new",
      label: "New Plan",
      description: "Scaffold a new OpenSpec change under openspec/changes/<change-id>/ and make it the active change. Then use /opsx-propose (or delegate a planner) to author proposal/design/specs/tasks artifacts into it.",
      parameters: Type.Object({
        title: Type.String({ description: "Human title for the change (also used to derive the kebab change-id)." }),
      }),
      async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
        const { title } = params as { title: string };
        if (!openspec.isAvailable()) {
          return { content: [{ type: "text", text: "OpenSpec CLI is not installed, so no plan store is available. Install @fission-ai/openspec to author plans." }], details: { ok: false, reason: "openspec unavailable" } };
        }
        const requestedChangeId = openspec.toChangeId(title);
        if (state.activeChangeId && openspec.changeExists(ctx.cwd, state.activeChangeId) && state.activeChangeId !== requestedChangeId) {
          return {
            content: [{
              type: "text",
              text: `This planning session already has active change "${state.activeChangeId}". Continue that plan and put related slices inside it. To intentionally switch, use plan_select(changeId). Do not create a second plan from the same session unless the user explicitly asks to switch scope.`,
            }],
            details: { ok: false, activeChangeId: state.activeChangeId, requestedChangeId },
          };
        }
        const result = await withFileMutationQueue(resolve(ctx.cwd, "openspec", "changes", requestedChangeId), async () => {
          openspec.ensureInit(ctx.cwd);
          return openspec.newChange(ctx.cwd, title);
        });
        if (!result) {
          return { content: [{ type: "text", text: `Could not create change from "${title}". Ensure the derived id is valid kebab-case and OpenSpec is initialized.` }], details: { ok: false } };
        }
        state.activeChangeId = result.changeId;
        const note = result.created ? "created" : "already existed";
        return { content: [{ type: "text", text: `OpenSpec change "${result.changeId}" ${note} and is now the active change (openspec/changes/${result.changeId}/). Author its proposal → design/specs → tasks via /opsx-propose; spec deltas go in specs/<capability>/spec.md (capability slug, not the change-id repeated). Keep this session focused on this change.` }], details: { ok: true, ...result } };
      },
    }));

    typeScopedTools.push(defineTool({
      name: "plan_task_complete",
      label: "Complete Plan Task",
      description: "Record one executed tasks.md checkbox as complete without mutating the human-approved OpenSpec artifact. The record is bound to the exact approved tasks hash and requires implementation evidence.",
      parameters: Type.Object({
        taskId: Type.String({ description: "Task identifier from a tasks.md checkbox, for example 1.1 or api-tests." }),
        evidence: Type.String({ description: "Concrete implementation/test evidence supporting completion." }),
        changeId: Type.Optional(Type.String({ description: "OpenSpec change-id. Defaults to the active change." })),
      }),
      async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
        const p = params as { taskId: string; evidence: string; changeId?: string };
        const changeId = String(p.changeId || state.activeChangeId || currentChangeId() || "").trim();
        const taskId = String(p.taskId || "").trim();
        const recordPath = openspec.executionTaskRecordPath(ctx.cwd, changeId, taskId);
        if (!recordPath) throw new Error(`Invalid execution task target: ${changeId}/${taskId}`);
        const progress = await withFileMutationQueue(recordPath, async () =>
          openspec.markExecutionTaskComplete(ctx.cwd, changeId, taskId, callerName, String(p.evidence || "")));
        return {
          content: [{ type: "text", text: `Recorded task ${progress.taskId} complete for change "${changeId}". The approved tasks.md was not modified.` }],
          details: { ok: true, changeId, progress },
        };
      },
    }));

    typeScopedTools.push(defineTool({
      name: "plan_select",
      label: "Select Plan",
      description: "Set the active OpenSpec change by change-id (must exist under openspec/changes/). With no argument, lists available changes.",
      parameters: Type.Object({
        changeId: Type.Optional(Type.String({ description: "The change-id to activate. Omit to list available changes." })),
      }),
      async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
        const changeId = String((params as any).changeId || "").trim();
        const available = openspec.listChanges(ctx.cwd).map((c) => c.name);
        if (!changeId) {
          const list = available.length ? available.map((id) => `- ${id}${state.activeChangeId === id ? " (active)" : ""}`).join("\n") : "(none)";
          return { content: [{ type: "text", text: `Available OpenSpec changes:\n${list}` }], details: { ok: true, available, active: state.activeChangeId } };
        }
        if (!openspec.changeExists(ctx.cwd, changeId)) {
          return { content: [{ type: "text", text: `No change "${changeId}" under openspec/changes/. Available: ${available.join(", ") || "none"}. Use plan_new to create one.` }], details: { ok: false, available } };
        }
        state.activeChangeId = changeId;
        const detail = openspec.changeDetail(ctx.cwd, changeId);
        const next = detail?.nextReady ? ` (next artifact: ${detail.nextReady})` : "";
        return { content: [{ type: "text", text: `Active change set to "${changeId}"${next}.` }], details: { ok: true, changeId, detail } };
      },
    }));
  }

  return [...baseTools, ...typeScopedTools];
}

export function registerTools(pi: ExtensionAPI, state: HiveState) {
  for (const tool of buildHiveTools(state, "Orchestrator")) pi.registerTool(tool);
}
