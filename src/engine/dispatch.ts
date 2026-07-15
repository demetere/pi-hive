import { withFileMutationQueue, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { spawnManaged } from "./process";
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { TYPE_SCOPED_TOOL_NAMES } from "../core/constants";
import { normalizeMentalModelSpine } from "../core/mental-model";
import type { AgentRuntime, HiveState } from "../core/types";
import {
  boundedDiagnostics,
  ensureDir,
  modelFrom,
  normalizeWorkerTools,
  readJsonlPage,
  safeJson,
  safeRead,
  slug,
  agentSlug,
  tailLines,
  textFromMessage,
  textOfResult,
  truncateMiddle,
  extractUsage,
} from "../core/utils";
import { logRecord } from "./state";
import { currentAgentName, currentChangeId, currentDelegationDepth, runAsAgent, runAtDelegationDepth, runWithChange } from "./session";
import { canDelegateTo } from "./domain";
import { agentMentalModelTarget, buildDistillerPrompt, buildWorkerPrompt, extractTagged } from "./prompts";
import { emitHiveEvent, runtimeSummary, writeHiveStateSnapshot } from "./observability";
import { buildHiveTools } from "../agents/tools";
import { normalizeWorkerSkillPaths, workerResourceLoader } from "./worker-extension";
import { approvalRecordPath, isExecutionGateOpen, isAwaitingHumanApproval, setAgentReviewVerdict, type AgentReviewVerdict } from "./openspec";
import { ARTIFACT_ORDER, type ArtifactId } from "../shared/openspec-artifacts";
import { agentRoster, resolveRuntime } from "./agent-lookup";
import { addHiveActivity } from "../ui/tui/activity";
import { resolveConfiguredPath } from "../core/safe-path";
import { acquireWorkerSlot, budgetRemaining, checkDispatchBudgets, effectiveWorkerGovernance, releaseWorkerSlot } from "./governance";

// Dashboard activity should show reviewer/worker conclusions without confusing
// middle elision in normal cases. Keep a high hard cap to avoid unbounded shared
// telemetry rows if an agent accidentally returns a huge dump.
const DELEGATION_EVENT_MESSAGE_LIMIT = 64_000;

function resolveModel(ctx: ExtensionContext, modelString: string): any {
  const [provider, ...idParts] = modelString.split("/");
  return (ctx as any).modelRegistry?.find(provider, idParts.join("/"));
}

function modelKey(model: any, fallback: string): string {
  if (model?.provider && model?.id) return `${model.provider}/${model.id}`;
  return fallback;
}

function publishRuntimeUpdate(state: HiveState) {
  state.onRuntimeUpdate?.(state);
}

// Coerce to a finite number or undefined. Unlike `Number(x) || undefined`, this
// preserves a legitimate 0 (a real delayMs/tokensAfter of 0 is meaningful; only
// NaN/absent should drop to undefined). Mirrors the Number.isFinite guards used
// on the SessionStats overwrite below. Guards null/undefined FIRST (R3-2.5) so an
// absent field stays undefined rather than coercing to Number(null) === 0.
function finiteOrUndef(x: unknown): number | undefined {
  if (x == null) return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
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

class WorkerRunLifecycle {
  private session: any;
  private unsubscribe?: () => void;
  private abortListener?: () => void;
  private closed = false;
  private readonly state: HiveState;
  private readonly runtime: AgentRuntime;
  private readonly abortSignal?: AbortSignal;

  constructor(state: HiveState, runtime: AgentRuntime, abortSignal?: AbortSignal) {
    this.state = state;
    this.runtime = runtime;
    this.abortSignal = abortSignal;
  }

  attachSession(session: any): void {
    this.session = session;
    this.runtime.session = session;
  }

  attachSubscription(unsubscribe: () => void): void {
    this.unsubscribe = unsubscribe;
  }

  watchParentAbort(listener: () => void): void {
    this.abortListener = listener;
    if (this.abortSignal?.aborted) listener();
    else this.abortSignal?.addEventListener("abort", listener, { once: true });
  }

  async close(failed: boolean): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.abortListener) this.abortSignal?.removeEventListener("abort", this.abortListener);
    if (this.runtime.timer) {
      clearInterval(this.runtime.timer);
      this.runtime.timer = undefined;
    }
    try { this.unsubscribe?.(); } catch { /* cleanup must continue */ }
    if (failed && this.session?.abort) {
      // Do not let a hung provider abort strand the slot forever. Invoking abort
      // starts cancellation; disposal and counter release remain unconditional.
      try { void Promise.resolve(this.session.abort()).catch((): void => undefined); } catch { /* cleanup must continue */ }
    }
    try { this.session?.dispose?.(); } catch { /* cleanup must continue */ }
    this.runtime.session = undefined;
    releaseWorkerSlot(this.state);
  }
}

export function resolveWorkerSkillPaths(cwd: string, refs: unknown[] = []): string[] {
  return normalizeWorkerSkillPaths(refs).flatMap((skillPath, index) => {
    const raw = refs[index] as any;
    const allowOutside = raw?.allowOutsideProject === true || raw?.path?.allowOutsideProject === true;
    const safe = resolveConfiguredPath(cwd, skillPath, allowOutside);
    return safe ? [safe.canonicalPath] : [];
  });
}

const ARTIFACT_REVISION_MARKERS = /\b(revise|revision|fix|address|correct|update|rewrite|repair|failed review|review failed|rejected|denied|blocker|blocking)\b/i;

const ARTIFACT_TARGET_MARKERS: Record<ArtifactId, RegExp> = {
  proposal: /\bproposal(?:\.md)?\b|proposal artifact|proposal gate/i,
  design: /\bdesign(?:\.md)?\b|design artifact|design gate/i,
  specs: /\bspecs?(?:\/\*\*\/\*\.md| artifact| gate)?\b|specs\/|spec\.md/i,
  tasks: /\btasks(?:\.md)?\b|tasks artifact|tasks gate/i,
};

export function isPendingArtifactRevisionTask(task: string, pending: ArtifactId): boolean {
  if (!ARTIFACT_REVISION_MARKERS.test(task)) return false;
  if (/\bauthor the next artifact\b/i.test(task)) return false;
  return ARTIFACT_TARGET_MARKERS[pending].test(task);
}

export function inferChangeIdFromReviewTask(task: string): string | null {
  const pathMatch = task.match(/openspec\/changes\/([a-z0-9]+(?:-[a-z0-9]+)*)\//i);
  if (pathMatch) return pathMatch[1];
  const quotedMatch = task.match(/OpenSpec change [`"]([a-z0-9]+(?:-[a-z0-9]+)*)[`"]|change [`"]([a-z0-9]+(?:-[a-z0-9]+)*)[`"]|change\s+([a-z0-9]+(?:-[a-z0-9]+)*)\b/i);
  return quotedMatch?.[1] || quotedMatch?.[2] || quotedMatch?.[3] || null;
}

export function inferArtifactFromReviewTask(task: string): ArtifactId | null {
  // Prefer the explicit review target. Review prompts often contain negative
  // scope clauses like "Do not consider design/specs/tasks"; a plain keyword
  // scan would otherwise tag a proposal review as tasks/specs/design.
  const explicit = task.match(/\breview\s+only\s+the\s+(proposal|design|specs?|requirements|tasks)\s+(?:artifact|gate)\b/i);
  if (explicit) {
    const target = explicit[1].toLowerCase();
    return target.startsWith("spec") || target === "requirements" ? "specs" : (target as ArtifactId);
  }

  const pathMatch = task.match(/openspec\/changes\/[^\s`'"]+\/((?:proposal|design|tasks)\.md|specs\/[^\s`'"]+|specs\/\*\*\/\*\.md)/i);
  if (pathMatch) return pathMatch[1].startsWith("specs/") ? "specs" : (pathMatch[1].replace(/\.md$/i, "") as ArtifactId);

  const positiveText = task
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => !/\bdo not\b|\bdon't\b|\bno\s+(?:design|specs|tasks|proposal)\b/i.test(sentence))
    .join("\n");
  let best: { id: ArtifactId; index: number } | null = null;
  for (const id of ARTIFACT_ORDER) {
    const match = positiveText.match(ARTIFACT_TARGET_MARKERS[id]);
    if (match?.index != null && (!best || match.index < best.index)) best = { id, index: match.index };
  }
  return best?.id ?? null;
}

function inferReviewVerdict(output: string): Exclude<AgentReviewVerdict, null> | null {
  const text = output.trim();
  const match = text.match(/^\s*(?:#{1,6}\s*)?(?:verdict\s*[:—-]\s*)?(PASS|GREEN|YELLOW|FAIL|RED)\b/i);
  const verdict = match?.[1]?.toLowerCase();
  if (verdict === "pass" || verdict === "green") return "green";
  if (verdict === "yellow") return "yellow";
  if (verdict === "fail" || verdict === "red") return "red";
  return null;
}

export async function dispatchAgent(
  state: HiveState, agentName: string, task: string, ctx: ExtensionContext, fresh = false,
  createSession: CreateAgentSession = createAgentSession,
  abortSignal?: AbortSignal,
): Promise<{ output: string; exitCode: number; elapsed: number }> {
  if (!state.config || !state.session) throw new Error("hive is not initialized");
  const caller = currentAgentName();
  const runtime = resolveRuntime(state, agentName);
  if (!runtime) {
    const available = agentRoster(state);
    return { output: `Unknown agent "${agentName}". Available: ${available}`, exitCode: 1, elapsed: 0 };
  }
  // Plan mode delegates to planners, leads, AND reviewers (Phase 5.1 decision):
  // reviewers give plan-phase feedback but stay read-only on files via the type
  // matrix, so they are safe to run during planning. coder/tester remain blocked
  // (they mutate; that needs an approved plan + hive/execute mode).
  if (state.mode === "plan" && !["planner", "lead", "reviewer"].includes(runtime.config.agentType || "")) {
    return { output: `Delegation blocked: plan mode may only delegate to planners, leads, or reviewers; ${runtime.config.name} is agent-type "${runtime.config.agentType || "unknown"}". Switch to hive mode or use /hive-execute after tasks approval for execution.`, exitCode: 1, elapsed: 0 };
  }
  // Hard per-artifact planning stop: once a planner has authored an artifact and
  // it is awaiting the human's review, the pipeline HALTS — no planner may author
  // the next artifact until the human approves the pending one in the review UI.
  // Reviewers still run. If an agent review finds defects before the human has
  // decided, allow an explicit same-artifact revision task instead of forcing a
  // pointless human reject/deny round-trip.
  if (state.mode === "plan" && runtime.config.agentType === "planner") {
    const changeId = currentChangeId() || state.activeChangeId || "";
    const pending = changeId ? isAwaitingHumanApproval(ctx.cwd, changeId) : null;
    if (pending && !isPendingArtifactRevisionTask(task, pending)) {
      return { output: `Delegation blocked: the "${pending}" artifact for change "${changeId}" is authored and awaiting human review in the dashboard. The planning pipeline holds until it is approved (or denied for revision). Ask the human to review it at the Plans tab; reviewers may still run.`, exitCode: 1, elapsed: 0 };
    }
  }
  if (state.mode === "hive" && (runtime.config.agentType === "coder" || runtime.config.agentType === "tester")) {
    const changeId = currentChangeId() || state.activeChangeId || "";
    if (!changeId || !isExecutionGateOpen(ctx.cwd, changeId)) {
      return { output: `Delegation blocked: execution agents require an approved plan. Draft the OpenSpec change in plan mode (/opsx-propose), get the tasks artifact approved in the review UI, then run /hive-execute <change-id>. Active change: ${changeId || "none"}.`, exitCode: 1, elapsed: 0 };
    }
  }
  const permission = canDelegateTo(state, caller, agentSlug(runtime.config));
  if (!permission.ok) {
    return { output: `Delegation blocked: ${permission.reason}`, exitCode: 1, elapsed: 0 };
  }
  if (runtime.status === "running") {
    return { output: `${runtime.config.name} is already running.`, exitCode: 1, elapsed: runtime.elapsedMs };
  }
  const delegationDepth = currentDelegationDepth() + 1;
  const blocked = checkDispatchBudgets(state, runtime, delegationDepth);
  if (blocked) {
    emitHiveEvent(state, "budget_exhausted", { agent: runtime.config.name, resource: blocked.resource, scope: blocked.scope, remaining: budgetRemaining(state, runtime) }, caller);
    return { output: `Delegation blocked: ${blocked.message}`, exitCode: 1, elapsed: 0 };
  }
  const willQueue = state.config.settings.maxParallel !== undefined
    && state.activeRuns >= state.config.settings.maxParallel
    && state.config.settings.queueSize !== undefined;
  const slotPromise = acquireWorkerSlot(state, abortSignal);
  if (willQueue) emitHiveEvent(state, "queue_update", { workerQueue: state.workerQueue?.length || 0, agent: runtime.config.name, phase: "queued" }, caller);
  const slot = await slotPromise;
  if (willQueue) emitHiveEvent(state, "queue_update", { workerQueue: state.workerQueue?.length || 0, agent: runtime.config.name, phase: slot }, caller);
  if (slot !== "acquired") {
    const reason = slot === "parallel"
      ? `Max parallel agent runs reached (${state.config.settings.maxParallel}); configure queue-size to enable fair waiting.`
      : slot === "queue-full"
        ? `Worker queue is full (${state.config.settings.queueSize}).`
        : "Delegation cancelled while waiting for a worker slot.";
    return { output: reason, exitCode: 1, elapsed: 0 };
  }
  // A queued request can become stale while waiting: another request may have
  // started the same worker or consumed its remaining budget.
  if ((runtime.status as AgentRuntime["status"]) === "running") {
    releaseWorkerSlot(state);
    return { output: `${runtime.config.name} is already running.`, exitCode: 1, elapsed: runtime.elapsedMs };
  }
  const queuedBlock = checkDispatchBudgets(state, runtime, delegationDepth);
  if (queuedBlock) {
    releaseWorkerSlot(state);
    emitHiveEvent(state, "budget_exhausted", { agent: runtime.config.name, resource: queuedBlock.resource, scope: queuedBlock.scope, remaining: budgetRemaining(state, runtime) }, caller);
    return { output: `Delegation blocked: ${queuedBlock.message}`, exitCode: 1, elapsed: 0 };
  }

  let prompt: string;
  try {
    prompt = buildWorkerPrompt(state, ctx, runtime, task);
  } catch (error: any) {
    releaseWorkerSlot(state);
    return { output: `Cannot prepare ${runtime.config.name}: ${error?.message || String(error)}`, exitCode: 1, elapsed: 0 };
  }
  const model = modelFrom(ctx, runtime.config.model);
  const tools = normalizeWorkerTools(runtime.config.tools, state.config.settings.defaultTools);
  const thinking = runtime.config.thinking!;
  // Fix #3: capture whether a prior transcript exists BEFORE the archive step.
  // This determines whether this dispatch is a new session (no prior transcript)
  // or a resume (existing transcript the SDK will replay on prompt()). The value
  // is used below to decide which input to pass to session.prompt(): the full
  // assembled worker context (new/fresh) or the lean task alone (resume).
  const sessionFileExisted = existsSync(runtime.sessionFile);
  // Governance accounting is monotonic even when fresh=true archives the SDK
  // transcript and resets its session-lifetime counters.
  runtime.governanceTokens ??= runtime.inputTokens + runtime.outputTokens + runtime.cacheReadTokens + runtime.cacheWriteTokens + runtime.reasoningTokens;
  runtime.governanceCostUsd ??= runtime.costUsd;
  // fresh=true starts this agent's conversation clean. Rather than DELETE the
  // prior session (which would lose the transcript of earlier runs while their
  // token/cost still count), ARCHIVE it to a numbered run file so the dashboard
  // can show every run. The live sessionFile always holds the current run.
  //
  // Archiving means end-of-run getSessionStats() covers ONLY the fresh session
  // (the prior transcript is no longer attached), so runtime.* will be overwritten
  // with just-this-run totals — but the run-start baselines below would still hold
  // the prior lifetime aggregates, making `runOnly − priorLifetime` go negative and
  // silently clamp to 0 (the fresh-archive under-count). Reset the lifetime
  // counters to 0 here so the baselines captured below are 0 and the per-run delta
  // equals the fresh session's real usage.
  if (fresh && existsSync(runtime.sessionFile)) {
    try {
      archivePriorRun(runtime.sessionFile);
      runtime.inputTokens = 0;
      runtime.outputTokens = 0;
      runtime.cacheReadTokens = 0;
      runtime.cacheWriteTokens = 0;
      runtime.reasoningTokens = 0;
      runtime.costUsd = 0;
    } catch { /* noop */ }
  }

  // Resolve the model FIRST, before mutating any per-run state. This is the
  // J4/Decision-5 reorder (the session is the only authoritative source of
  // getAvailableThinkingLevels(), so it must exist before delegation_start), and
  // it also means an unresolvable model aborts cleanly: no run-start field —
  // runCount, startedAt, elapsedMs, the token baselines — is touched for a run
  // that never happens (M-misc), so the previous run's stats stay intact.
  let resolvedModel: any;
  try { resolvedModel = resolveModel(ctx, model); } catch { resolvedModel = undefined; }
  if (!resolvedModel) {
    runtime.status = "error";
    releaseWorkerSlot(state);
    return { output: `Cannot resolve model "${model}" for ${runtime.config.name}.`, exitCode: 1, elapsed: 0 };
  }

  const resolvedModelKey = modelKey(resolvedModel, model);

  runtime.status = "running";
  runtime.task = task;
  runtime.lastWork = task;
  runtime.toolCount = 0;
  runtime.elapsedMs = 0;
  runtime.runCount++;
  runtime.startedAt = Date.now();
  const governance = effectiveWorkerGovernance(state, runtime);
  const runController = new AbortController();
  let timedOut = false;
  const abortFromParent = () => runController.abort(abortSignal?.reason);
  if (abortSignal?.aborted) abortFromParent();
  else abortSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = governance.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    runController.abort(new Error(`Worker timeout after ${governance.timeoutMs}ms`));
  }, governance.timeoutMs);
  timeout?.unref?.();
  const lifecycle = new WorkerRunLifecycle(state, runtime, runController.signal);
  // TOK/S baselines (J8/Decision 4): lifetime token counts at run start so the UI
  // divides the *per-run output* delta by *per-run* elapsedMs — not lifetime
  // tokens by per-run elapsed.
  runtime.runStartInputTokens = runtime.inputTokens;
  runtime.runStartOutputTokens = runtime.outputTokens;
  // Full baselines so delegation_end can emit per-run deltas for every token
  // dimension + cost (Decision 1), not just the two TOK/S needs.
  runtime.runStartCacheReadTokens = runtime.cacheReadTokens;
  runtime.runStartCacheWriteTokens = runtime.cacheWriteTokens;
  runtime.runStartReasoningTokens = runtime.reasoningTokens;
  runtime.runStartCostUsd = runtime.costUsd;

  const chunks: string[] = [];
  let streamedSnapshot = "";
  let session: any;
  let abortedByParent = false;
  let errorMessage: string | undefined;
  const modelsSeen = new Set<string>();
  const providersSeen = new Set<string>();
  const apisSeen = new Set<string>();
  let firstResponseId: string | undefined;
  let lastResponseId: string | undefined;
  const diagnostics: Array<{ type?: string; message?: string }> = [];
  const MAX_DIAGNOSTICS = 20;
  let lastStopReason: string | undefined;
  const toolStartedAt = new Map<string, number>();
  let lastRetryMaxAttempts: number | undefined;
  let sdkCounts: { toolCalls?: number; toolResults?: number; userMessages?: number; assistantMessages?: number } | undefined;

  try {
  const toolNames = tools.split(",").map((t) => t.trim()).filter(Boolean);
  // Type-scoped tools (e.g. submit_review_verdict) are granted by agent type,
  // not the tools list, so keep them even when the agent does not enumerate
  // them. buildHiveTools only emits them for the eligible type.
  const hiveTools = buildHiveTools(state, runtime.config.name).filter((t) => toolNames.includes(t.name) || TYPE_SCOPED_TOOL_NAMES.has(t.name));
  const skillPaths = resolveWorkerSkillPaths(ctx.cwd, runtime.config.skills as unknown[]);

  const sessionManager = SessionManager.open(runtime.sessionFile);

  // createAgentSession only calls reload() when it creates its own resource
  // loader (sdk.js). When a loader is supplied by the caller, the SDK skips
  // reload, leaving extensionsResult empty (constructor default). Without
  // reload the extensionFactories never run, runner.hasHandlers("tool_call")
  // is false, beforeToolCall short-circuits, and domain enforcement is silently
  // bypassed for every worker tool call. Call reload() here so the factory
  // registers the tool_call handler before the session starts.
  const workerLoader = workerResourceLoader(state, ctx.cwd, runtime.config.name, skillPaths);
  await workerLoader.reload();

  const created = await createSession({
    cwd: ctx.cwd,
    model: resolvedModel,
    modelRegistry: (ctx as any).modelRegistry,
    thinkingLevel: thinking as any,
    tools: toolNames,
    customTools: hiveTools,
    sessionManager,
    resourceLoader: workerLoader,
  });
  session = created.session;
  lifecycle.attachSession(session);

  const abortWorker = (): void => {
    abortedByParent = true;
    runtime.lastWork = "cancelling";
    addHiveActivity(state, { kind: "delegation_end", parent: caller, agent: runtime.config.name, status: "error", text: "cancel requested" });
    void session.abort?.().catch((): undefined => undefined);
  };
  lifecycle.watchParentAbort(abortWorker);

  // Authoritative per-model thinking levels for this worker's effective model.
  // This is the SDK's own answer — no ModelRegistry plumbing needed (A10).
  try {
    const levels = session.getAvailableThinkingLevels?.();
    if (Array.isArray(levels) && levels.length) runtime.thinkingLevels = levels.map(String);
  } catch { /* capability probe is best-effort */ }

  logRecord(state, { from: caller, to: runtime.config.name, type: "delegation", message: task });
  addHiveActivity(state, { kind: "delegation_start", parent: caller, agent: runtime.config.name, status: "running", text: task });
  emitHiveEvent(state, "delegation_start", {
    from: caller,
    to: runtime.config.name,
    task,
    fresh,
    // Store the effective model key, not the raw config value (which may be
    // "inherit") or the full SDK object, so telemetry stays JSON/SQLite-safe.
    model: resolvedModelKey,
    configuredModel: model,
    tools,
    thinking,
    // Authoritative per-model thinking levels, captured from the session created
    // above (A10). Now populated on the FIRST run too (J4); the topology_nodes
    // sidecar fills in from this.
    thinkingLevels: runtime.thinkingLevels,
    runtime: runtimeSummary(state, runtime),
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
  // Per-message identity the SDK exposes on AssistantMessage (Item 9 / R3-1.4):
  // `.provider`, `.api`, `.responseId?`, `.diagnostics?` all ride the same
  // message_end object. Capture the distinct providers/apis, the first+last
  // responseId (bookends of the run), and a bounded set of diagnostics.
  // toolCallId → startedAt, for per-call durationMs (A4). Bounded by in-flight
  // calls: deleted on tool_execution_end. Retry metadata is retained only for
  // this reserved run and cleared by the outer lifecycle cleanup.
  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta?.type === "text_delta") {
        // The documented SDK contract exposes incremental text on `delta`. Some
        // event shapes also carry `text`/`message` as the full accumulated
        // snapshot; appending that snapshot duplicates every prefix in the final
        // worker result (e.g. "P", "Pl", "Ple" as separate lines in the TUI).
        // Keep snapshots only for live status/fallback output, never as chunks.
        const deltaText = typeof delta.delta === "string" ? delta.delta : "";
        if (deltaText) chunks.push(deltaText);
        const snapshot = textFromMessage(event.message) || (typeof delta.text === "string" ? delta.text : "");
        if (snapshot) streamedSnapshot = snapshot;
        const live = chunks.length ? chunks.join("") : streamedSnapshot;
        const last = live.split("\n").filter((line: string) => line.trim()).pop();
        if (last) runtime.lastWork = last;
      }
    } else if (event.type === "tool_execution_start") {
      runtime.toolCount++;
      const toolName = event.toolName || event.name || "unknown";
      runtime.lastWork = `tool: ${toolName}`;
      if (event.toolCallId) toolStartedAt.set(event.toolCallId, Date.now());
      const argsJson = safeJson(event.args ?? {});
      addHiveActivity(state, { kind: "tool_start", agent: runtime.config.name, toolName, status: "running" });
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
      addHiveActivity(state, { kind: "tool_end", agent: runtime.config.name, toolName: event.toolName || event.name || "unknown", status: event.isError === true ? "error" : "done", text: event.isError === true ? truncateMiddle(resultText, 160) : undefined });
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
      addHiveActivity(state, { kind: "retry", agent: runtime.config.name, status: "running", text: `retry ${event.attempt}${event.maxAttempts ? `/${event.maxAttempts}` : ""}${event.errorMessage ? `: ${truncateMiddle(String(event.errorMessage), 120)}` : ""}` });
      emitHiveEvent(state, "worker_retry", {
        agent: runtime.config.name,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        errorMessage: event.errorMessage ? truncateMiddle(String(event.errorMessage), 500) : undefined,
        // Phase 4.6: the backoff delay before this retry (W1.7: 0 is a valid delay).
        delayMs: finiteOrUndef(event.delayMs),
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
      addHiveActivity(state, { kind: "compaction", agent: runtime.config.name, status: "running", text: `compacting${event.reason ? `: ${event.reason}` : ""}` });
      emitHiveEvent(state, "worker_compaction", { agent: runtime.config.name, reason: event.reason, phase: "start" }, runtime.config.name);
    } else if (event.type === "compaction_end") {
      // Phase 4.5: keep the compaction RESULT fields, not just {reason, phase}.
      const result = event.result || {};
      emitHiveEvent(state, "worker_compaction", {
        agent: runtime.config.name, reason: event.reason, phase: "end",
        tokensBefore: finiteOrUndef(result.tokensBefore ?? event.tokensBefore),
        estimatedTokensAfter: finiteOrUndef(result.estimatedTokensAfter ?? event.estimatedTokensAfter),
        aborted: (result.aborted ?? event.aborted) === true ? true : undefined,
        willRetry: (result.willRetry ?? event.willRetry) === true ? true : undefined,
        errorMessage: (result.errorMessage ?? event.errorMessage) ? truncateMiddle(String(result.errorMessage ?? event.errorMessage), 500) : undefined,
      }, runtime.config.name);
    } else if (event.type === "queue_update") {
      // Worker steering/follow-up queue depth (Phase 4). Bounded to counts — the
      // queued message bodies are not carried into telemetry.
      emitHiveEvent(state, "queue_update", {
        agent: runtime.config.name,
        steering: Array.isArray(event.steering) ? event.steering.length : 0,
        followUp: Array.isArray(event.followUp) ? event.followUp.length : 0,
      }, runtime.config.name);
    } else if (event.type === "session_info_changed") {
      emitHiveEvent(state, "session_info_changed", {
        agent: runtime.config.name,
        name: event.name ? truncateMiddle(String(event.name), 200) : undefined,
      }, runtime.config.name);
    } else if (event.type === "message_end") {
      const message = event.message;
      const actualModel = message?.model || message?.responseModel;
      if (actualModel) modelsSeen.add(String(actualModel));
      if (message?.provider) providersSeen.add(String(message.provider));
      if (message?.api) apisSeen.add(String(message.api));
      if (message?.responseId) {
        const rid = String(message.responseId);
        if (!firstResponseId) firstResponseId = rid;
        lastResponseId = rid;
      }
      if (diagnostics.length < MAX_DIAGNOSTICS) {
        // R4.3: shared bounded/undefined-omitting normalizer, capped across the run.
        const norm = boundedDiagnostics(message?.diagnostics, MAX_DIAGNOSTICS - diagnostics.length);
        if (norm) diagnostics.push(...norm);
      }
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

        const remaining = budgetRemaining(state, runtime);
        const teamLimits = state.config?.settings.teamBudgets || {};
        const warn = (left: number | undefined, limit: number | undefined, scope: "worker" | "team", resource: "tokens" | "cost") => {
          if (left === undefined || limit === undefined || left <= 0 || left / limit > 0.2) return;
          const warningKey = `${scope}:${resource}:${scope === "worker" ? agentSlug(runtime.config) : "team"}`;
          const warnings = state.budgetWarnings ||= new Set<string>();
          if (warnings.has(warningKey)) return;
          warnings.add(warningKey);
          emitHiveEvent(state, "budget_warning", { agent: runtime.config.name, scope, resource, remaining: left, limit }, runtime.config.name);
        };
        warn(remaining.worker.tokens, governance.tokenBudget, "worker", "tokens");
        warn(remaining.worker.costUsd, governance.costBudgetUsd, "worker", "cost");
        warn(remaining.team.tokens, teamLimits.tokenBudget, "team", "tokens");
        warn(remaining.team.costUsd, teamLimits.costBudgetUsd, "team", "cost");
        const exhausted = remaining.worker.tokens === 0 ? { scope: "worker", resource: "tokens" }
          : remaining.worker.costUsd === 0 ? { scope: "worker", resource: "cost" }
          : remaining.team.tokens === 0 ? { scope: "team", resource: "tokens" }
          : remaining.team.costUsd === 0 ? { scope: "team", resource: "cost" }
          : undefined;
        if (exhausted && !runController.signal.aborted) {
          emitHiveEvent(state, "budget_exhausted", { agent: runtime.config.name, ...exhausted, remaining }, runtime.config.name);
          runController.abort(new Error(`${exhausted.scope} ${exhausted.resource} budget exhausted`));
        }
      }
    } else if (event.type === "agent_end") {
      const messages = event.messages || [];
      const last = [...messages].reverse().find((message: any) => message.role === "assistant");
      // Keep the chunks fallback for output text; the usage-add block that used
      // to live here is deleted (double-count fix, Decision 1).
      if (last && !chunks.length && !streamedSnapshot) chunks.push(textFromMessage(last));
    }
    publishRuntimeUpdate(state);
    writeHiveStateSnapshot(state);
  });
  lifecycle.attachSubscription(unsubscribe);

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
    // plan/review tools resolve currentChangeId()
    // to the selected change. A nested delegation inherits the caller's change-id
    // unless a more specific one is set. state.activeChangeId is the persistent
    // selection; currentChangeId() carries an already-scoped value into nesting.
    const scopedChangeId = currentChangeId() ?? state.activeChangeId;
    if (abortedByParent) throw new Error("aborted");
    // Fix #3: inject the assembled worker context on new/fresh session starts.
    // fresh=true always starts clean (prior transcript archived above, if any).
    // A first-ever session for this agent (no prior transcript file) also needs
    // the full context so shared_context and the domain boundary reach the worker.
    // Resumed sessions (fresh=false, existing transcript) receive the lean task
    // only — pi-hive's native transcript persistence already carries the context
    // forward, so re-injecting would duplicate it on every resumed delegation.
    // Deliberate non-goal: distiller re-injection into resumed workers (P4).
    const isNewSession = fresh || !sessionFileExisted;
    await runAtDelegationDepth(delegationDepth, () => runAsAgent(runtime.config.name, () => runWithChange(scopedChangeId, () => session.prompt(isNewSession ? prompt : task))));
    errorMessage = abortedByParent
      ? (timedOut ? `Worker timed out after ${governance.timeoutMs}ms` : "aborted")
      : state.shuttingDown
        ? "aborted during session shutdown"
        : session.state.errorMessage;
    // The 1s timer polls this too, but relying on it alone can miss the final,
    // most accurate reading if the last tick landed moments before completion.
    // Refresh the raw tokens/window alongside the percent (Phase 4.7) so the
    // final snapshot carries the last context fill, not just its percentage.
    const finalUsage = session.getContextUsage?.();
    if (finalUsage?.percent != null) runtime.contextPct = finalUsage.percent;
    if (finalUsage?.tokens != null) runtime.contextTokens = finalUsage.tokens;
    if (finalUsage?.contextWindow != null) runtime.contextWindow = finalUsage.contextWindow;
  } catch (error: any) {
    errorMessage = error?.message || String(error);
  }

  // Authoritative usage: overwrite the incremental live-display counters with
  // the SDK's session-lifetime aggregate (includes cache splits). This kills
  // the double-count and any accumulation drift in one move (Decision 1). If
  // stats throws, the incremental values already on the runtime are kept.
  // Item 9: SessionStats also carries authoritative message/tool counts —
  // preferred over the hand-tallied toolCount so the numbers match the SDK's own.
  try {
    const stats: any = session.getSessionStats?.();
    if (stats) {
      const toolCalls = Number(stats.toolCalls);
      const toolResults = Number(stats.toolResults);
      const userMessages = Number(stats.userMessages);
      const assistantMessages = Number(stats.assistantMessages);
      sdkCounts = {
        toolCalls: Number.isFinite(toolCalls) ? toolCalls : undefined,
        toolResults: Number.isFinite(toolResults) ? toolResults : undefined,
        userMessages: Number.isFinite(userMessages) ? userMessages : undefined,
        assistantMessages: Number.isFinite(assistantMessages) ? assistantMessages : undefined,
      };
      // R3-1.3: do NOT overwrite runtime.toolCount with stats.toolCalls here.
      // runtime.toolCount is reset per run (see the run-start block) and tallied
      // live from tool_execution_start, so it means "tool calls THIS run". But
      // stats.toolCalls is session-LIFETIME — on a resumed (non-fresh) re-run it
      // covers the whole conversation, which would make the Agents "Tools" cell and
      // delegation_end.runtime.toolCount jump from this-run to lifetime at run end.
      // The lifetime count is preserved separately in the `counts` payload below,
      // which honestly documents its session-lifetime semantics.
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
      // when the SDK actually reports a POSITIVE value, otherwise keep the value
      // accumulated from message_end. A finite 0 from stats (reasoning simply
      // absent) must not wipe accumulation — only trust it to zero when nothing
      // was accumulated in the first place.
      const reasoning = Number(tokens.reasoning ?? tokens.reasoningTokens);
      if (Number.isFinite(reasoning) && (reasoning > 0 || runtime.reasoningTokens === 0)) {
        runtime.reasoningTokens = reasoning;
      }
    }
  } catch { /* keep incremental values if stats is unavailable */ }

  } catch (error: any) {
    errorMessage = errorMessage || error?.message || String(error);
  } finally {
    toolStartedAt.clear();
    if (timeout) clearTimeout(timeout);
    abortSignal?.removeEventListener("abort", abortFromParent);
    await lifecycle.close(Boolean(errorMessage));
    runtime.elapsedMs = runtime.startedAt ? Date.now() - runtime.startedAt : runtime.elapsedMs;
    runtime.status = errorMessage ? "error" : "done";
  }
  const exitCode = errorMessage ? 1 : 0;

  const output = chunks.join("").trim() || streamedSnapshot.trim() || errorMessage || "[no output]";
  runtime.lastWork = output.split("\n").filter((line) => line.trim()).pop() || runtime.status;
  // The shared log keeps a bounded copy of the result for the dashboard. The
  // cap is intentionally high enough that normal review verdicts are not
  // middle-elided in the web UI, while still protecting the shared telemetry log
  // from accidental multi-hundred-KB rows.
  const completionMessage = truncateMiddle(output, DELEGATION_EVENT_MESSAGE_LIMIT);
  const completion = {
    from: runtime.config.name,
    // The real delegation parent: the ALS caller (A6). For top-level
    // delegations this resolves to "Orchestrator"; nested lead→member
    // delegations now record the truthful parent instead of a hardcoded root.
    to: caller,
    type: runtime.status,
    message: completionMessage,
    costUsd: runtime.costUsd,
    inputTokens: runtime.inputTokens,
    outputTokens: runtime.outputTokens,
    elapsedMs: runtime.elapsedMs,
  };
  logRecord(state, completion);
  addHiveActivity(state, { kind: "delegation_end", parent: caller, agent: runtime.config.name, status: runtime.status, text: `${runtime.status} in ${Math.round(runtime.elapsedMs / 1000)}s${runtime.toolCount ? ` · ${runtime.toolCount} tools` : ""}` });
  // Per-run deltas (Decision 1): runtime.* now hold session-lifetime aggregates
  // (overwritten from getSessionStats above), so a re-run agent's runtime would
  // make SUM() over delegations double-count. Subtract the run-start baseline so
  // each delegation_end row records only what THIS run consumed. Clamp at 0 in
  // case the SDK's lifetime total ever regresses across a compaction — and as a
  // last-resort guard for the fresh-archive path (where the baselines are reset to
  // 0 above precisely so this clamp is NOT what saves the delta from going negative).
  const nonneg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const delta = {
    inputTokens: nonneg(runtime.inputTokens - (runtime.runStartInputTokens ?? 0)),
    outputTokens: nonneg(runtime.outputTokens - (runtime.runStartOutputTokens ?? 0)),
    cacheReadTokens: nonneg(runtime.cacheReadTokens - (runtime.runStartCacheReadTokens ?? 0)),
    cacheWriteTokens: nonneg(runtime.cacheWriteTokens - (runtime.runStartCacheWriteTokens ?? 0)),
    reasoningTokens: nonneg(runtime.reasoningTokens - (runtime.runStartReasoningTokens ?? 0)),
    costUsd: nonneg(runtime.costUsd - (runtime.runStartCostUsd ?? 0)),
  };
  runtime.governanceTokens = (runtime.governanceTokens || 0)
    + delta.inputTokens + delta.outputTokens + delta.cacheReadTokens + delta.cacheWriteTokens + delta.reasoningTokens;
  runtime.governanceCostUsd = (runtime.governanceCostUsd || 0) + delta.costUsd;
  if (runtime.config.agentType === "reviewer") {
    // Persist per-artifact reviewer clearance whenever a review prompt is
    // explicit enough to identify its target. Some dashboard-triggered review
    // turns can run without plan-mode ambient state after a session restore; in
    // that case, derive the change id from the OpenSpec paths in the task so the
    // Plans UI does not reject a freshly PASSed artifact as "not ready".
    const changeId = currentChangeId() || state.activeChangeId || inferChangeIdFromReviewTask(task) || "";
    const artifact = inferArtifactFromReviewTask(task);
    const verdict = inferReviewVerdict(output);
    if (changeId && artifact && verdict) {
      const recordPath = approvalRecordPath(ctx.cwd, changeId, artifact, "automated-review");
      if (recordPath) {
        await withFileMutationQueue(recordPath, async () => {
          setAgentReviewVerdict(ctx.cwd, changeId, artifact, verdict, runtime.config.name);
        });
      }
    }
  }

  emitHiveEvent(state, "delegation_end", {
    ...completion,
    truncated: output.length > DELEGATION_EVENT_MESSAGE_LIMIT,
    exitCode,
    stopReason: lastStopReason,
    errorMessage: errorMessage ? truncateMiddle(errorMessage, 500) : undefined,
    models: [...modelsSeen],
    // Per-message identity the SDK exposes on AssistantMessage (Item 9 / R3-1.4):
    // distinct providers + apis behind this run's assistant messages, the first and
    // last responseId (run bookends), and a bounded/truncated diagnostics list.
    providers: providersSeen.size ? [...providersSeen] : undefined,
    apis: apisSeen.size ? [...apisSeen] : undefined,
    firstResponseId,
    lastResponseId,
    diagnostics: diagnostics.length ? diagnostics : undefined,
    // Authoritative SDK message/tool counts for this session (Item 9), preferred
    // over the hand-tallied toolCount. Session-lifetime (not per-run) — a re-run
    // agent's stats cover the whole conversation.
    counts: sdkCounts,
    // Schema marker so the materializer stores per-run deltas and the dashboard
    // never sums these rows with legacy cumulative ones (delegationsSchema=1).
    delegationsSchema: 1,
    delta,
    runtime: runtimeSummary(state, runtime),
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
  let streamedSnapshot = "";
  (state.backgroundDistillerSessions ||= new Set()).add(session);
  session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const delta = event.assistantMessageEvent;
      const deltaText = typeof delta.delta === "string" ? delta.delta : "";
      if (deltaText) chunks.push(deltaText);
      const snapshot = textFromMessage(event.message) || (typeof delta.text === "string" ? delta.text : "");
      if (snapshot) streamedSnapshot = snapshot;
    } else if (event.type === "agent_end") {
      const last = [...(event.messages || [])].reverse().find((m: any) => m.role === "assistant");
      if (last && !chunks.length && !streamedSnapshot) chunks.push(textFromMessage(last));
    }
  });

  try {
    await session.prompt(prompt);
  } catch {
    return "";
  } finally {
    state.backgroundDistillerSessions?.delete(session);
    session.dispose();
  }
  return chunks.join("").trim() || streamedSnapshot.trim();
}

export async function distillMentalModel(state: HiveState, ctx: ExtensionContext, runtime: AgentRuntime): Promise<void> {
  if (!state.config || !state.session || !state.config.settings.distiller.enabled) return;
  const target = agentMentalModelTarget(runtime);
  if (!target) return;

  // Config validation already requires an explicit opt-in for targets outside
  // the project. Re-apply that rule at the write site before queueing mutation.
  const safeTarget = resolveConfiguredPath(ctx.cwd, target.path, target.allowOutsideProject === true, { allowMissing: true });
  if (!safeTarget) return;
  const targetPath = safeTarget.canonicalPath;

  // Snapshot the just-finished conversation, distill from the copy, then delete
  // it — so a re-delegation of the same agent can reuse its live session freely.
  const snapshotDir = join(state.session.sessionDir, "distill");
  ensureDir(snapshotDir);
  const snapshotPath = join(snapshotDir, `${slug(runtime.config.name)}-${runtime.runCount}.jsonl`);
  let conversation = "";
  try {
    if (existsSync(runtime.sessionFile)) {
      copyFileSync(runtime.sessionFile, snapshotPath);
      const tail = readJsonlPage(snapshotPath, { before: Number.MAX_SAFE_INTEGER, maxBytes: 1024 * 1024 });
      conversation = tailLines(tail.text, state.config.settings.distiller.conversationLines);
    }
  } catch { /* no session yet */ }
  if (!conversation) { try { rmSync(snapshotPath, { force: true }); } catch { /* noop */ } return; }

  let changed = false;
  let errorMessage: string | undefined;
  emitHiveEvent(state, "distill_start", { agent: runtime.config.name, target: target.path, model: state.config.settings.distiller.model, distillerRunCount: runtime.distillerRunCount || 0 }, "Distiller");
  try {
    const currentModel = safeRead(targetPath);
    const today = new Date().toISOString().slice(0, 10);
    const prompt = buildDistillerPrompt(runtime.config.name, currentModel, conversation, today);
    const output = await runDistillerProcess(state, ctx, prompt, state.config.settings.distiller.model);
    const extracted = extractTagged(output, "mental_model");
    // Mechanical safety net: guarantee the hard spine (owner/updated/spine keys)
    // even if the distiller's output drifts. The soft body is left byte-exact.
    const distilled = extracted ? normalizeMentalModelSpine(extracted, runtime.config.name).trim() : null;
    if (distilled && distilled !== currentModel.trim() && !state.shuttingDown) {
      await withFileMutationQueue(targetPath, async () => {
        // Re-read inside the queued mutation window. If another tool updated the
        // model while distillation was running, do not overwrite fresher state
        // with a result derived from the old snapshot.
        const latestModel = safeRead(targetPath);
        if (state.shuttingDown || latestModel.trim() !== currentModel.trim()) return;
        writeFileSync(targetPath, `${distilled}\n`);
        changed = true;
      });
      if (changed) {
        logRecord(state, { from: "Distiller", to: runtime.config.name, type: "mental_model_distilled", message: `Updated ${target.path}`, path: target.path });
      }
    }
  } catch (error: any) {
    errorMessage = truncateMiddle(error?.message || String(error), 500);
  } finally {
    emitHiveEvent(state, "distill_end", { agent: runtime.config.name, target: target.path, changed, errorMessage }, "Distiller");
    try { rmSync(snapshotPath, { force: true }); } catch { /* noop */ }
  }
}

export function scheduleMentalModelDistillation(
  state: HiveState,
  ctx: ExtensionContext,
  runtime: AgentRuntime,
  runDistiller: typeof distillMentalModel = distillMentalModel,
): Promise<void> {
  const target = agentMentalModelTarget(runtime);
  if (!target || state.shuttingDown) return Promise.resolve();
  const governance = effectiveWorkerGovernance(state, runtime);
  if (governance.distillerRuns !== undefined && (runtime.distillerRunCount || 0) >= governance.distillerRuns) {
    emitHiveEvent(state, "budget_exhausted", { agent: runtime.config.name, scope: "worker", resource: "distillerRuns", remaining: 0, limit: governance.distillerRuns }, "Distiller");
    return Promise.resolve();
  }
  const runCount = runtime.runCount;
  const queues = state.distillQueues ||= new Map<string, Promise<void>>();
  const background = state.backgroundTasks ||= new Set<Promise<void>>();
  const previous = queues.get(target.path) || Promise.resolve();
  const task = previous.catch((): void => undefined).then(async () => {
    // A newer run for the same runtime supersedes this queued snapshot. Skipping
    // it prevents an old conversation from overwriting a newer mental model.
    if (state.shuttingDown || runtime.runCount !== runCount) return;
    // Reserve at launch time so queued distillers cannot all pass the same cap.
    if (governance.distillerRuns !== undefined && (runtime.distillerRunCount || 0) >= governance.distillerRuns) return;
    runtime.distillerRunCount = (runtime.distillerRunCount || 0) + 1;
    await runDistiller(state, ctx, runtime);
  }).catch((): void => undefined);
  queues.set(target.path, task);
  background.add(task);
  void task.finally(() => {
    background.delete(task);
    if (queues.get(target.path) === task) queues.delete(target.path);
  });
  return task;
}
