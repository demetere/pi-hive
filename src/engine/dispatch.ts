import { withFileMutationQueue, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { spawnManaged } from "./process";
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { HIVE_AGENTS_DIR, TYPE_SCOPED_TOOL_NAMES } from "../core/constants";
import { normalizeMentalModelSpine } from "../core/mental-model";
import type { AgentRuntime, HiveState } from "../core/types";
import {
  ensureDir,
  modelFrom,
  normalizeWorkerTools,
  safeJson,
  safeRead,
  slug,
  tailLines,
  textFromMessage,
  textOfResult,
  truncateMiddle,
  extractUsage,
} from "../core/utils";
import { logRecord } from "./state";
import { currentAgentName, currentChangeId, runAsAgent, runWithChange } from "./session";
import { canDelegateTo } from "./domain";
import { agentMentalModelTarget, buildDistillerPrompt, buildWorkerPrompt, extractTagged } from "./prompts";
import { emitHiveEvent, runtimeSummary, writeHiveStateSnapshot } from "./observability";
import { buildHiveTools } from "../agents/tools";
import { workerResourceLoader } from "./worker-extension";
import { isReadyToExecute } from "./plan-store";

function resolveModel(ctx: ExtensionContext, modelString: string): any {
  const [provider, ...idParts] = modelString.split("/");
  return (ctx as any).modelRegistry?.find(provider, idParts.join("/"));
}

function publishRuntimeUpdate(state: HiveState) {
  state.onRuntimeUpdate?.(state);
}

// Move an agent's current session log aside to a numbered archive so a fresh run
// can start clean without losing the prior run's transcript. "<slug>.jsonl"
// becomes "<slug>.run-<N>.jsonl" with N the next free index. Returns silently if
// there is nothing to archive.
function archivePriorRun(sessionFile: string) {
  const dir = dirname(sessionFile);
  const base = basename(sessionFile, ".jsonl"); // e.g. "core-tester"
  let existing: string[] = [];
  try { existing = readdirSync(dir); } catch { /* dir may not exist */ }
  const re = new RegExp(`^${base}\\.run-(\\d+)\\.jsonl$`);
  let max = 0;
  for (const f of existing) { const m = f.match(re); if (m) max = Math.max(max, Number(m[1])); }
  const archive = join(dir, `${base}.run-${max + 1}.jsonl`);
  renameSync(sessionFile, archive);
}

// Session factory seam (L1): defaults to the real createAgentSession, but a test
// can inject a scripted AgentSession to drive dispatchAgent end-to-end without a
// live model. Kept as the last optional param so existing callers are unchanged.
export type CreateAgentSession = typeof createAgentSession;

export async function dispatchAgent(
  state: HiveState, agentName: string, task: string, ctx: ExtensionContext, fresh = false,
  createSession: CreateAgentSession = createAgentSession,
): Promise<{ output: string; exitCode: number; elapsed: number }> {
  if (!state.config || !state.session) throw new Error("hive is not initialized");
  const caller = currentAgentName();
  const runtime = state.runtimes.get(agentName.toLowerCase());
  if (!runtime) {
    const available = Array.from(state.runtimes.values()).map((agent) => agent.config.name).join(", ");
    return { output: `Unknown agent "${agentName}". Available: ${available}`, exitCode: 1, elapsed: 0 };
  }
  // Plan mode delegates to planners, leads, AND reviewers (Phase 5.1 decision):
  // reviewers give plan-phase feedback but stay read-only on files via the type
  // matrix, so they are safe to run during planning. coder/tester remain blocked
  // (they mutate; that needs an approved plan + hive/execute mode).
  if (state.mode === "plan" && !["planner", "lead", "reviewer"].includes(runtime.config.agentType || "")) {
    return { output: `Delegation blocked: plan mode may only delegate to planners, leads, or reviewers; ${runtime.config.name} is agent-type "${runtime.config.agentType || "unknown"}". Switch to hive mode or use /hive-execute after tasks approval for execution.`, exitCode: 1, elapsed: 0 };
  }
  if (state.mode === "hive" && (runtime.config.agentType === "coder" || runtime.config.agentType === "tester")) {
    const changeId = currentChangeId() || state.activeChangeId || "";
    if (!changeId || !isReadyToExecute(ctx.cwd, changeId)) {
      return { output: `Delegation blocked: execution agents require an approved plan. Create specs in plan mode, approve the tasks gate, then run /hive-execute <change-id>. Active change: ${changeId || "none"}.`, exitCode: 1, elapsed: 0 };
    }
  }
  const permission = canDelegateTo(state, caller, runtime.config.name);
  if (!permission.ok) {
    return { output: `Delegation blocked: ${permission.reason}`, exitCode: 1, elapsed: 0 };
  }
  if (runtime.status === "running") {
    return { output: `${runtime.config.name} is already running.`, exitCode: 1, elapsed: runtime.elapsedMs };
  }
  if (state.activeRuns >= state.config.settings.maxParallel) {
    return { output: `Max parallel agent runs reached (${state.config.settings.maxParallel}). Wait for a worker to finish.`, exitCode: 1, elapsed: 0 };
  }

  const prompt = buildWorkerPrompt(state, ctx, runtime, task);
  const model = modelFrom(ctx, runtime.config.model);
  const tools = normalizeWorkerTools(runtime.config.tools, state.config.settings.defaultTools);
  const thinking = runtime.config.thinking!;
  // fresh=true starts this agent's conversation clean. Rather than DELETE the
  // prior session (which would lose the transcript of earlier runs while their
  // token/cost still count), ARCHIVE it to a numbered run file so the dashboard
  // can show every run. The live sessionFile always holds the current run.
  if (fresh && existsSync(runtime.sessionFile)) {
    try { archivePriorRun(runtime.sessionFile); } catch { /* noop */ }
  }

  // Resolve the model FIRST, before mutating any per-run state. This is the
  // J4/Decision-5 reorder (the session is the only authoritative source of
  // getAvailableThinkingLevels(), so it must exist before delegation_start), and
  // it also means an unresolvable model aborts cleanly: no run-start field —
  // runCount, startedAt, elapsedMs, the token baselines — is touched for a run
  // that never happens (M-misc), so the previous run's stats stay intact.
  const resolvedModel = resolveModel(ctx, model);
  if (!resolvedModel) {
    runtime.status = "error";
    return { output: `Cannot resolve model "${model}" for ${runtime.config.name}.`, exitCode: 1, elapsed: 0 };
  }

  runtime.status = "running";
  runtime.task = task;
  runtime.lastWork = task;
  runtime.toolCount = 0;
  runtime.elapsedMs = 0;
  runtime.runCount++;
  runtime.startedAt = Date.now();
  state.activeRuns++;
  // TOK/S baselines (J8/Decision 4): lifetime token counts at run start so the UI
  // divides the *per-run* delta by *per-run* elapsedMs — not lifetime tokens by
  // per-run elapsed.
  runtime.runStartInputTokens = runtime.inputTokens;
  runtime.runStartOutputTokens = runtime.outputTokens;
  // Full baselines so delegation_end can emit per-run deltas for every token
  // dimension + cost (Decision 1), not just the two TOK/S needs.
  runtime.runStartCacheReadTokens = runtime.cacheReadTokens;
  runtime.runStartCacheWriteTokens = runtime.cacheWriteTokens;
  runtime.runStartReasoningTokens = runtime.reasoningTokens;
  runtime.runStartCostUsd = runtime.costUsd;

  const toolNames = tools.split(",").map((t) => t.trim()).filter(Boolean);
  // Type-scoped tools (e.g. submit_review_verdict) are granted by agent type,
  // not the tools list, so keep them even when the agent does not enumerate
  // them. buildHiveTools only emits them for the eligible type.
  const hiveTools = buildHiveTools(state, runtime.config.name).filter((t) => toolNames.includes(t.name) || TYPE_SCOPED_TOOL_NAMES.has(t.name));
  const skillPaths = (runtime.config.skills || []).map((skill) => resolve(ctx.cwd, skill.path));

  const chunks: string[] = [];
  const sessionManager = SessionManager.open(runtime.sessionFile);

  const { session } = await createSession({
    cwd: ctx.cwd,
    model: resolvedModel,
    modelRegistry: (ctx as any).modelRegistry,
    thinkingLevel: thinking as any,
    tools: toolNames,
    customTools: hiveTools,
    sessionManager,
    resourceLoader: workerResourceLoader(state, ctx.cwd, runtime.config.name, skillPaths),
  });
  runtime.session = session;

  // Authoritative per-model thinking levels for this worker's effective model.
  // This is the SDK's own answer — no ModelRegistry plumbing needed (A10).
  try {
    const levels = session.getAvailableThinkingLevels?.();
    if (Array.isArray(levels) && levels.length) runtime.thinkingLevels = levels.map(String);
  } catch { /* capability probe is best-effort */ }

  logRecord(state, { from: caller, to: runtime.config.name, type: "delegation", message: task });
  emitHiveEvent(state, "delegation_start", {
    from: caller,
    to: runtime.config.name,
    task,
    fresh,
    model,
    tools,
    thinking,
    // Authoritative per-model thinking levels, captured from the session created
    // above (A10). Now populated on the FIRST run too (J4); the topology_nodes
    // sidecar fills in from this.
    thinkingLevels: runtime.thinkingLevels,
    runtime: runtimeSummary(runtime),
  }, caller);
  publishRuntimeUpdate(state);
  writeHiveStateSnapshot(state);

  // Every nesting level shares one process and one state.runtimes Map now, so
  // a nested delegation already mutates the same AgentRuntime the top-level
  // status modal reads directly — no cross-process mirroring needed. This
  // timer keeps elapsedMs ticking and polls the live context-window fill via
  // runtime.session (assigned above) — the same underlying data
  // ctx.getContextUsage() exposes for the top-level session's own TUI footer,
  // now readable per-worker since it's in-process.
  runtime.timer = setInterval(() => {
    runtime.elapsedMs = runtime.startedAt ? Date.now() - runtime.startedAt : runtime.elapsedMs;
    // percent is null right after compaction until a fresh assistant response
    // provides usage data again — keep the last known value rather than
    // flashing to 0 during that transient window.
    const usage = runtime.session?.getContextUsage?.();
    if (usage?.percent != null) runtime.contextPct = usage.percent;
    // Phase 4.7: keep raw tokens/contextWindow too, not just the percent.
    if (usage?.tokens != null) runtime.contextTokens = usage.tokens;
    if (usage?.contextWindow != null) runtime.contextWindow = usage.contextWindow;
    publishRuntimeUpdate(state);
    writeHiveStateSnapshot(state);
  }, 1000);
  runtime.timer.unref?.();

  // Distinct actual models seen across this run's assistant messages (A3).
  const modelsSeen = new Set<string>();
  let lastStopReason: string | undefined;
  // toolCallId → startedAt, for per-call durationMs (A4). Bounded by in-flight
  // calls: deleted on tool_execution_end.
  const toolStartedAt = new Map<string, number>();
  // The SDK's `auto_retry_end` event does NOT carry `maxAttempts`; only the
  // matching `auto_retry_start` does. Remember the last seen value so the
  // retry-end telemetry can report it instead of always emitting `undefined`.
  let lastRetryMaxAttempts: number | undefined;

  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      const text = delta?.delta || delta?.text || "";
      if (delta?.type === "text_delta" && text) {
        chunks.push(text);
        const last = chunks.join("").split("\n").filter((line: string) => line.trim()).pop();
        if (last) runtime.lastWork = last;
      }
    } else if (event.type === "tool_execution_start") {
      runtime.toolCount++;
      const toolName = event.toolName || event.name || "unknown";
      runtime.lastWork = `tool: ${toolName}`;
      if (event.toolCallId) toolStartedAt.set(event.toolCallId, Date.now());
      const argsJson = safeJson(event.args ?? {});
      emitHiveEvent(state, "worker_tool_start", {
        agent: runtime.config.name,
        toolName,
        toolCallId: event.toolCallId,
        args: truncateMiddle(argsJson, 500),
        truncated: argsJson.length > 500,
      }, runtime.config.name);
    } else if (event.type === "tool_execution_end") {
      const startedAt = event.toolCallId ? toolStartedAt.get(event.toolCallId) : undefined;
      if (event.toolCallId) toolStartedAt.delete(event.toolCallId);
      const resultText = textOfResult(event.result);
      emitHiveEvent(state, "worker_tool_end", {
        agent: runtime.config.name,
        toolName: event.toolName || event.name || "unknown",
        toolCallId: event.toolCallId,
        isError: event.isError === true,
        resultPreview: truncateMiddle(resultText, 500),
        truncated: resultText.length > 500,
        durationMs: startedAt != null ? Date.now() - startedAt : undefined,
      }, runtime.config.name);
    } else if (event.type === "auto_retry_start") {
      if (event.maxAttempts != null) lastRetryMaxAttempts = event.maxAttempts;
      emitHiveEvent(state, "worker_retry", {
        agent: runtime.config.name,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        errorMessage: event.errorMessage ? truncateMiddle(String(event.errorMessage), 500) : undefined,
        // Phase 4.6: the backoff delay before this retry.
        delayMs: Number(event.delayMs) || undefined,
        phase: "start",
      }, runtime.config.name);
    } else if (event.type === "auto_retry_end") {
      // The SDK does not carry maxAttempts on retry-end; fall back to the value
      // captured at the matching retry-start.
      emitHiveEvent(state, "worker_retry", {
        agent: runtime.config.name,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts ?? lastRetryMaxAttempts,
        phase: "end",
        success: event.success,
        // Phase 4.6: the terminal error when retries are exhausted.
        finalError: event.finalError ? truncateMiddle(String(event.finalError), 500) : undefined,
      }, runtime.config.name);
    } else if (event.type === "compaction_start") {
      emitHiveEvent(state, "worker_compaction", { agent: runtime.config.name, reason: event.reason, phase: "start" }, runtime.config.name);
    } else if (event.type === "compaction_end") {
      // Phase 4.5: keep the compaction RESULT fields, not just {reason, phase}.
      const result = event.result || {};
      emitHiveEvent(state, "worker_compaction", {
        agent: runtime.config.name, reason: event.reason, phase: "end",
        tokensBefore: Number(result.tokensBefore ?? event.tokensBefore) || undefined,
        estimatedTokensAfter: Number(result.estimatedTokensAfter ?? event.estimatedTokensAfter) || undefined,
        aborted: (result.aborted ?? event.aborted) === true ? true : undefined,
        willRetry: (result.willRetry ?? event.willRetry) === true ? true : undefined,
        errorMessage: (result.errorMessage ?? event.errorMessage) ? truncateMiddle(String(result.errorMessage ?? event.errorMessage), 500) : undefined,
      }, runtime.config.name);
    } else if (event.type === "message_end") {
      const message = event.message;
      const actualModel = message?.model || message?.responseModel;
      if (actualModel) modelsSeen.add(String(actualModel));
      if (message?.stopReason) lastStopReason = String(message.stopReason);
      const usage = message?.usage;
      if (usage) {
        // Incremental accumulation for live display only. Authoritative totals
        // are overwritten from getSessionStats() at run end (A1) — this avoids
        // the historical double-count where agent_end re-added the final
        // message's usage.
        const u = extractUsage(usage);
        runtime.inputTokens += u.input;
        runtime.outputTokens += u.output;
        runtime.cacheReadTokens += u.cacheRead;
        runtime.cacheWriteTokens += u.cacheWrite;
        runtime.reasoningTokens += u.reasoning;
        runtime.costUsd += u.cost;
      }
    } else if (event.type === "agent_end") {
      const messages = event.messages || [];
      const last = [...messages].reverse().find((message: any) => message.role === "assistant");
      // Keep the chunks fallback for output text; the usage-add block that used
      // to live here is deleted (double-count fix, Decision 1).
      if (last && !chunks.length) chunks.push(textFromMessage(last));
    }
    publishRuntimeUpdate(state);
    writeHiveStateSnapshot(state);
  });

  let errorMessage: string | undefined;
  try {
    // Scoped so currentAgentName() resolves to this worker for everything
    // causally downstream of prompt() — subscribed event handlers, tool
    // execute() calls (including a nested delegate_agent recursing into
    // dispatchAgent again), and enforceDomainForTool's lookup. Workers can run
    // concurrently now that there's no process boundary between them, so this
    // can no longer be a shared/global value (see currentAgentStorage in
    // session.ts) — each concurrent call gets its own isolated context.
    //
    // prompt() throws synchronously for pre-acceptance failures (no model, no
    // API key); a failure mid-run instead surfaces via session.state.errorMessage.
    //
    // The active change-id is scoped alongside the agent name so the worker's
    // tools (e.g. submit_review_verdict / approve_plan) resolve currentChangeId()
    // to the selected change. A nested delegation inherits the caller's change-id
    // unless a more specific one is set. state.activeChangeId is the persistent
    // selection; currentChangeId() carries an already-scoped value into nesting.
    const scopedChangeId = currentChangeId() ?? state.activeChangeId;
    await runAsAgent(runtime.config.name, () => runWithChange(scopedChangeId, () => session.prompt(task)));
    errorMessage = session.state.errorMessage;
    // The 1s timer polls this too, but relying on it alone can miss the final,
    // most accurate reading if the last tick landed moments before completion.
    const finalUsage = session.getContextUsage?.();
    if (finalUsage?.percent != null) runtime.contextPct = finalUsage.percent;
  } catch (error: any) {
    errorMessage = error?.message || String(error);
  }

  // Authoritative usage: overwrite the incremental live-display counters with
  // the SDK's session-lifetime aggregate (includes cache splits). This kills
  // the double-count and any accumulation drift in one move (Decision 1). If
  // stats throws, the incremental values already on the runtime are kept.
  try {
    const stats: any = session.getSessionStats?.();
    if (stats) {
      const tokens = stats.tokens ?? stats.usage ?? stats;
      const input = Number(tokens.input ?? tokens.inputTokens);
      const output = Number(tokens.output ?? tokens.outputTokens);
      if (Number.isFinite(input)) runtime.inputTokens = input;
      if (Number.isFinite(output)) runtime.outputTokens = output;
      const cacheRead = Number(tokens.cacheRead ?? tokens.cacheReadTokens);
      const cacheWrite = Number(tokens.cacheWrite ?? tokens.cacheWriteTokens);
      if (Number.isFinite(cacheRead)) runtime.cacheReadTokens = cacheRead;
      if (Number.isFinite(cacheWrite)) runtime.cacheWriteTokens = cacheWrite;
      const cost = Number(stats.cost?.total ?? stats.cost ?? stats.costUsd);
      if (Number.isFinite(cost)) runtime.costUsd = cost;
      // reasoning is NOT part of SessionStats.tokens (Phase 4.8): only overwrite
      // when the SDK actually reports it, otherwise keep the value accumulated
      // from message_end so reasoning tokens are not silently zeroed.
      const reasoning = Number(tokens.reasoning ?? tokens.reasoningTokens);
      if (Number.isFinite(reasoning)) runtime.reasoningTokens = reasoning;
    }
  } catch { /* keep incremental values if stats is unavailable */ }

  unsubscribe();
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.elapsedMs = runtime.startedAt ? Date.now() - runtime.startedAt : runtime.elapsedMs;
  runtime.status = errorMessage ? "error" : "done";
  const exitCode = errorMessage ? 1 : 0;
  state.activeRuns = Math.max(0, state.activeRuns - 1);
  session.dispose();
  runtime.session = undefined;

  const output = chunks.join("").trim() || errorMessage || "[no output]";
  runtime.lastWork = output.split("\n").filter((line) => line.trim()).pop() || runtime.status;
  // The shared log keeps only a bounded summary of the result — the full
  // output is returned to the caller and persisted in this agent's own
  // transcript (agents/<slug>.jsonl). Logging the whole thing here is what
  // turned the shared log into a multi-hundred-KB-per-line firehose.
  const completion = {
    from: runtime.config.name,
    // The real delegation parent: the ALS caller (A6). For top-level
    // delegations this resolves to "Orchestrator"; nested lead→member
    // delegations now record the truthful parent instead of a hardcoded root.
    to: caller,
    type: runtime.status,
    message: truncateMiddle(output, 2_000),
    costUsd: runtime.costUsd,
    inputTokens: runtime.inputTokens,
    outputTokens: runtime.outputTokens,
    elapsedMs: runtime.elapsedMs,
  };
  logRecord(state, completion);
  // Per-run deltas (Decision 1): runtime.* now hold session-lifetime aggregates
  // (overwritten from getSessionStats above), so a re-run agent's runtime would
  // make SUM() over delegations double-count. Subtract the run-start baseline so
  // each delegation_end row records only what THIS run consumed. Clamp at 0 in
  // case the SDK's lifetime total ever regresses across a compaction.
  const nonneg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const delta = {
    inputTokens: nonneg(runtime.inputTokens - (runtime.runStartInputTokens ?? 0)),
    outputTokens: nonneg(runtime.outputTokens - (runtime.runStartOutputTokens ?? 0)),
    cacheReadTokens: nonneg(runtime.cacheReadTokens - (runtime.runStartCacheReadTokens ?? 0)),
    cacheWriteTokens: nonneg(runtime.cacheWriteTokens - (runtime.runStartCacheWriteTokens ?? 0)),
    reasoningTokens: nonneg(runtime.reasoningTokens - (runtime.runStartReasoningTokens ?? 0)),
    costUsd: nonneg(runtime.costUsd - (runtime.runStartCostUsd ?? 0)),
  };
  emitHiveEvent(state, "delegation_end", {
    ...completion,
    truncated: output.length > 2_000,
    exitCode,
    stopReason: lastStopReason,
    errorMessage: errorMessage ? truncateMiddle(errorMessage, 500) : undefined,
    models: [...modelsSeen],
    // Schema marker so the materializer stores per-run deltas and the dashboard
    // never sums these rows with legacy cumulative ones (delegationsSchema=1).
    delegationsSchema: 1,
    delta,
    runtime: runtimeSummary(runtime),
  }, runtime.config.name);
  // Surface delegation failures as the now-live `error` telemetry event (A3).
  if (errorMessage) {
    emitHiveEvent(state, "error", {
      agent: runtime.config.name,
      message: truncateMiddle(errorMessage, 500),
      stopReason: lastStopReason,
    }, runtime.config.name);
  }
  publishRuntimeUpdate(state);
  writeHiveStateSnapshot(state);
  state.onRuntimeFinish?.(runtime, ctx);
  return { output, exitCode, elapsed: runtime.elapsedMs };
}

// ── Mental-model distiller ────────────────────────────────────────────────
// After a worker finishes, a separate constrained `pi` run reads a SNAPSHOT of
// the just-completed conversation plus the agent's current mental model, then
// returns a consolidated rewrite of that file. This replaces inline self-update
// tools: the worker focuses on the task; memory is curated out-of-band, can
// consolidate (not just append), and never pollutes the worker's context.

export async function runDistillerProcess(state: HiveState, ctx: ExtensionContext, prompt: string, model: string): Promise<string> {
  const resolvedModel = resolveModel(ctx, model);
  if (!resolvedModel) return "";

  // In-process now: no separate session to inherit. The distiller's transcript
  // is a scratch prompt/response pair, not durably meaningful on its own, so it
  // never needs a session file — SessionManager.inMemory() is correct here.
  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    model: resolvedModel,
    modelRegistry: (ctx as any).modelRegistry,
    thinkingLevel: "off",
    tools: [],
    noTools: "all",
    sessionManager: SessionManager.inMemory(ctx.cwd),
  });

  const chunks: string[] = [];
  session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      chunks.push(event.assistantMessageEvent.delta || event.assistantMessageEvent.text || "");
    } else if (event.type === "agent_end") {
      const last = [...(event.messages || [])].reverse().find((m: any) => m.role === "assistant");
      if (last && !chunks.length) chunks.push(textFromMessage(last));
    }
  });

  try {
    await session.prompt(prompt);
  } catch {
    return "";
  } finally {
    session.dispose();
  }
  return chunks.join("").trim();
}

export async function distillMentalModel(state: HiveState, ctx: ExtensionContext, runtime: AgentRuntime): Promise<void> {
  if (!state.config || !state.session || !state.config.settings.distiller.enabled) return;
  const target = agentMentalModelTarget(runtime);
  if (!target) return;

  // Write guard: the mental-model file must live under the agents/ root.
  const agentsRoot = resolve(ctx.cwd, HIVE_AGENTS_DIR);
  const targetPath = resolve(ctx.cwd, target.path);
  if (!targetPath.startsWith(agentsRoot)) return;

  // Snapshot the just-finished conversation, distill from the copy, then delete
  // it — so a re-delegation of the same agent can reuse its live session freely.
  const snapshotDir = join(state.session.sessionDir, "distill");
  ensureDir(snapshotDir);
  const snapshotPath = join(snapshotDir, `${slug(runtime.config.name)}-${runtime.runCount}.jsonl`);
  let conversation = "";
  try {
    if (existsSync(runtime.sessionFile)) {
      copyFileSync(runtime.sessionFile, snapshotPath);
      conversation = tailLines(safeRead(snapshotPath), state.config.settings.distiller.conversationLines);
    }
  } catch { /* no session yet */ }
  if (!conversation) { try { rmSync(snapshotPath, { force: true }); } catch { /* noop */ } return; }

  try {
    const currentModel = safeRead(targetPath);
    const today = new Date().toISOString().slice(0, 10);
    const prompt = buildDistillerPrompt(runtime.config.name, currentModel, conversation, today);
    emitHiveEvent(state, "distill_start", { agent: runtime.config.name, target: target.path, model: state.config.settings.distiller.model }, "Distiller");
    const output = await runDistillerProcess(state, ctx, prompt, state.config.settings.distiller.model);
    const extracted = extractTagged(output, "mental_model");
    // Mechanical safety net: guarantee the hard spine (owner/updated/spine keys)
    // even if the distiller's output drifts. The soft body is left byte-exact.
    const distilled = extracted ? normalizeMentalModelSpine(extracted, runtime.config.name).trim() : null;
    if (distilled && distilled !== currentModel.trim()) {
      await withFileMutationQueue(targetPath, async () => {
        writeFileSync(targetPath, `${distilled}\n`);
      });
      logRecord(state, { from: "Distiller", to: runtime.config.name, type: "mental_model_distilled", message: `Updated ${target.path}`, path: target.path });
      emitHiveEvent(state, "distill_end", { agent: runtime.config.name, target: target.path, changed: true }, "Distiller");
    }
  } catch { /* distillation is best-effort; never fail the delegation */ }
  finally { try { rmSync(snapshotPath, { force: true }); } catch { /* noop */ } }
}
