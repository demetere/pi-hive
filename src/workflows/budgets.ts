import { createHash } from "node:crypto";
import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import { PACKAGE_BUDGET_CAPS, type BudgetField } from "../config/budgets";
import type { JsonValue } from "../config/types";
import { createWorkflowEvent, sealWorkflowEvent, type WorkflowEventEnvelope, type WorkflowEventType } from "./events";
import { appendWorkflowEventChecked, readWorkflowJournal } from "./journal";
import { replayWorkflowJournal } from "./replay";
import { boundedId, deepFreeze, plainRecord } from "./values";

const FORMAT_VERSION = 1 as const;
export const BUDGET_POLICY_V1 = Object.freeze({
  version: 1 as const,
  warningFractions: Object.freeze([0.8, 0.9] as const),
  rootFinalizationModelAttempts: 1,
  rootFinalizationToolAttempts: 1,
  finalizationTools: Object.freeze(["workflow_status", "workflow_finish", "question_status", "question_resolve"] as const),
});

export interface RunBudgetLimits {
  readonly maxParallel: number;
  readonly maxDelegations: number;
  readonly maxToolCalls: number;
  readonly tokenBudget: number;
  readonly activeWallTimeMs: number;
}
export interface NodeBudgetLimits {
  readonly maxAgentTurns: number;
  readonly maxToolCalls: number;
  readonly tokenBudget: number;
  readonly activeWallTimeMs: number;
}
export interface EffectiveRuntimeBudgetLimits {
  readonly run: RunBudgetLimits;
  readonly nodes: Readonly<Record<string, NodeBudgetLimits>>;
}
export type UsagePrecision = "estimated" | "provider-confirmed";
export interface ModelUsageInput { readonly inputTokens: number; readonly outputTokens: number; readonly precision: UsagePrecision }
export interface BudgetWarning {
  readonly key: string; readonly scope: "run" | "node"; readonly nodeId?: string;
  readonly resource: "turns" | "tools" | "tokens" | "active-wall-time" | "delegations";
  readonly fraction: number; readonly used: number; readonly limit: number; readonly sequence: number;
}
export interface ModelBudgetAttempt {
  readonly attemptId: string; readonly correlationId: string; readonly nodeId: string; readonly finalization: boolean;
  readonly sequence: number; readonly usage?: ModelUsageInput;
}
export interface ToolBudgetAttempt {
  readonly attemptId: string; readonly correlationId: string; readonly nodeId: string; readonly toolName: string;
  readonly policyOutcome: "allowed" | "denied"; readonly finalization: boolean; readonly sequence: number;
}
export interface BudgetCounterTotals {
  readonly delegations: number; readonly turns: number; readonly toolCalls: number; readonly tokens: number;
  readonly estimatedTokens: number; readonly providerConfirmedTokens: number; readonly activeWallTimeMs: number;
}
export type NodeBudgetCounterTotals = Omit<BudgetCounterTotals, "delegations">;
export interface ActiveBudgetBatch { readonly activityId: string; readonly nodeId: string; readonly startedAtMs: number }
export interface BudgetState {
  readonly sessionId: string; readonly runId: string; readonly rootNodeId: string; readonly limits: EffectiveRuntimeBudgetLimits;
  readonly run: BudgetCounterTotals; readonly nodes: Readonly<Record<string, NodeBudgetCounterTotals>>;
  readonly modelAttempts: Readonly<Record<string, ModelBudgetAttempt>>; readonly toolAttempts: Readonly<Record<string, ToolBudgetAttempt>>;
  readonly delegationTaskIds: readonly string[]; readonly activeBatches: readonly ActiveBudgetBatch[];
  readonly runActiveSinceMs?: number; readonly paused: boolean; readonly warnings: readonly BudgetWarning[];
}
export type BudgetExhaustionScope = "node" | "run";
export type BudgetAdmission = Readonly<{ ok: true; attemptId?: string }> | Readonly<{ ok: false; reason: string; exhausted: readonly string[]; budgetExhausted: boolean; scope: BudgetExhaustionScope }>;
export type BudgetAttemptAdmission = Readonly<{ ok: true; attemptId: string }> | Readonly<{ ok: false; reason: string; exhausted: readonly string[]; budgetExhausted: boolean; scope: BudgetExhaustionScope }>;
type DeniedBudgetAdmission = Extract<BudgetAdmission, { ok: false }>;
class BudgetAdmissionDenied extends Error {
  readonly admission: DeniedBudgetAdmission;
  constructor(admission: DeniedBudgetAdmission) { super(admission.reason); this.name = "BudgetAdmissionDenied"; this.admission = admission; }
}
export interface BudgetRuntimeOptions {
  readonly projectRoot: string; readonly projectId: string; readonly sessionId: string; readonly runId: string; readonly rootNodeId: string;
  readonly limits: EffectiveRuntimeBudgetLimits; readonly now?: () => string; readonly nowMs?: () => number;
}

const BUDGET_EVENTS = new Set<WorkflowEventType>([
  "budget.model.attempted", "budget.model.usage.recorded", "budget.tool.attempted", "budget.clock.started",
  "budget.clock.stopped", "budget.clock.paused", "budget.clock.resumed", "budget.warning.recorded", "task.accepted",
]);

function safePositive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive safe integer`);
  return Number(value);
}
function cappedPositive(value: unknown, label: string, field: BudgetField): number {
  return Math.min(safePositive(value, label), PACKAGE_BUDGET_CAPS[field]);
}
function validateLimits(limits: EffectiveRuntimeBudgetLimits, rootNodeId: string): EffectiveRuntimeBudgetLimits {
  if (!plainRecord(limits) || !plainRecord(limits.run) || !plainRecord(limits.nodes) || !plainRecord(limits.nodes[rootNodeId])) throw new Error("Runtime budget limits are incomplete");
  const run = Object.freeze({
    maxParallel: cappedPositive(limits.run.maxParallel, "maxParallel", "max-parallel"),
    maxDelegations: cappedPositive(limits.run.maxDelegations, "maxDelegations", "max-delegations"),
    maxToolCalls: cappedPositive(limits.run.maxToolCalls, "maxToolCalls", "max-tool-calls"),
    tokenBudget: cappedPositive(limits.run.tokenBudget, "tokenBudget", "token-budget"),
    activeWallTimeMs: cappedPositive(limits.run.activeWallTimeMs, "activeWallTimeMs", "active-wall-time"),
  });
  const nodes: Record<string, NodeBudgetLimits> = {};
  for (const [nodeId, raw] of Object.entries(limits.nodes)) {
    boundedId(nodeId, "Budget node ID");
    if (!plainRecord(raw)) throw new Error(`Runtime budget limits for ${nodeId} are invalid`);
    nodes[nodeId] = Object.freeze({
      maxAgentTurns: cappedPositive(raw.maxAgentTurns, `${nodeId}.maxAgentTurns`, "max-agent-turns"),
      maxToolCalls: cappedPositive(raw.maxToolCalls, `${nodeId}.maxToolCalls`, "max-tool-calls"),
      tokenBudget: cappedPositive(raw.tokenBudget, `${nodeId}.tokenBudget`, "token-budget"),
      activeWallTimeMs: cappedPositive(raw.activeWallTimeMs, `${nodeId}.activeWallTimeMs`, "active-wall-time"),
    });
  }
  return deepFreeze({ run, nodes });
}
function zeroNode(): NodeBudgetCounterTotals { return { turns: 0, toolCalls: 0, tokens: 0, estimatedTokens: 0, providerConfirmedTokens: 0, activeWallTimeMs: 0 }; }
export function createBudgetState(sessionId: string, runId: string, rootNodeId: string, limits: EffectiveRuntimeBudgetLimits): BudgetState {
  const checked = validateLimits(limits, rootNodeId);
  const nodes = Object.fromEntries(Object.keys(checked.nodes).map((nodeId) => [nodeId, zeroNode()]));
  return deepFreeze({
    sessionId: boundedId(sessionId, "Budget session ID"), runId: boundedId(runId, "Budget run ID"), rootNodeId: boundedId(rootNodeId, "Budget root node ID"), limits: checked,
    run: { delegations: 0, turns: 0, toolCalls: 0, tokens: 0, estimatedTokens: 0, providerConfirmedTokens: 0, activeWallTimeMs: 0 },
    nodes, modelAttempts: {}, toolAttempts: {}, delegationTaskIds: [], activeBatches: [], paused: false, warnings: [],
  });
}
function payload(event: WorkflowEventEnvelope): Record<string, unknown> {
  if (!plainRecord(event.payload) || event.payload.formatVersion !== FORMAT_VERSION) throw new Error("Budget event payload is invalid");
  return event.payload;
}
function eventMs(event: WorkflowEventEnvelope): number {
  const value = Date.parse(event.timestamp);
  if (!Number.isFinite(value)) throw new Error("Budget event timestamp is invalid");
  return value;
}
function tokens(usage: ModelUsageInput): number { return usage.inputTokens + usage.outputTokens; }
function sameUsage(left: ModelUsageInput, right: ModelUsageInput): boolean {
  return left.inputTokens === right.inputTokens && left.outputTokens === right.outputTokens && left.precision === right.precision;
}
function parseUsage(value: unknown): ModelUsageInput {
  if (!plainRecord(value) || !Number.isSafeInteger(value.inputTokens) || Number(value.inputTokens) < 0 || !Number.isSafeInteger(value.outputTokens) || Number(value.outputTokens) < 0
    || (value.precision !== "estimated" && value.precision !== "provider-confirmed")) throw new Error("Model usage is invalid");
  return Object.freeze({ inputTokens: Number(value.inputTokens), outputTokens: Number(value.outputTokens), precision: value.precision });
}
function counterWithUsage(counter: NodeBudgetCounterTotals | BudgetCounterTotals, previous: ModelUsageInput | undefined, next: ModelUsageInput) {
  let total = counter.tokens;
  let estimated = counter.estimatedTokens;
  let confirmed = counter.providerConfirmedTokens;
  if (previous) {
    total -= tokens(previous);
    if (previous.precision === "estimated") estimated -= tokens(previous); else confirmed -= tokens(previous);
  }
  total += tokens(next);
  if (next.precision === "estimated") estimated += tokens(next); else confirmed += tokens(next);
  return { ...counter, tokens: total, estimatedTokens: estimated, providerConfirmedTokens: confirmed };
}
function closeActive(state: BudgetState, timestampMs: number, activityIds?: ReadonlySet<string>): BudgetState {
  const selected = state.activeBatches.filter((entry) => !activityIds || activityIds.has(entry.activityId));
  if (!selected.length) return state;
  const nodes = structuredClone(state.nodes) as Record<string, NodeBudgetCounterTotals>;
  for (const entry of selected) {
    nodes[entry.nodeId] = { ...nodes[entry.nodeId], activeWallTimeMs: nodes[entry.nodeId].activeWallTimeMs + Math.max(0, timestampMs - entry.startedAtMs) };
  }
  const remaining = state.activeBatches.filter((entry) => !selected.includes(entry));
  let run = state.run;
  let runActiveSinceMs = state.runActiveSinceMs;
  if (!remaining.length && runActiveSinceMs !== undefined) {
    run = { ...run, activeWallTimeMs: run.activeWallTimeMs + Math.max(0, timestampMs - runActiveSinceMs) };
    runActiveSinceMs = undefined;
  }
  return deepFreeze({ ...state, run, nodes, activeBatches: remaining, ...(runActiveSinceMs === undefined ? { runActiveSinceMs: undefined } : { runActiveSinceMs }) });
}
export function reduceBudgetState(state: BudgetState, event: WorkflowEventEnvelope): BudgetState {
  if (!BUDGET_EVENTS.has(event.type) || event.runId !== state.runId) return state;
  if (event.sessionId !== state.sessionId) throw new Error("Budget event session identity mismatch");
  if (event.type === "task.accepted") {
    if (!plainRecord(event.payload) || typeof event.payload.taskId !== "string") throw new Error("Accepted task budget event is invalid");
    if (state.delegationTaskIds.includes(event.payload.taskId)) return state;
    return deepFreeze({ ...state, run: { ...state.run, delegations: state.run.delegations + 1 }, delegationTaskIds: [...state.delegationTaskIds, event.payload.taskId] });
  }
  const data = payload(event);
  if (event.type === "budget.model.attempted") {
    const attemptId = boundedId(String(data.attemptId ?? ""), "Budget model attempt ID");
    const correlationId = boundedId(String(data.correlationId ?? ""), "Budget model correlation ID");
    const nodeId = boundedId(String(data.nodeId ?? ""), "Budget model node ID");
    if (!state.nodes[nodeId] || state.modelAttempts[attemptId] || Object.values(state.modelAttempts).some((attempt) => attempt.correlationId === correlationId)) throw new Error("Budget model attempt is duplicated or targets an unknown node");
    const finalization = data.finalization === true;
    const attempt = Object.freeze({ attemptId, correlationId, nodeId, finalization, sequence: event.sequence });
    return deepFreeze({ ...state, run: { ...state.run, turns: state.run.turns + 1 }, nodes: { ...state.nodes, [nodeId]: { ...state.nodes[nodeId], turns: state.nodes[nodeId].turns + 1 } }, modelAttempts: { ...state.modelAttempts, [attemptId]: attempt } });
  }
  if (event.type === "budget.model.usage.recorded") {
    const attemptId = boundedId(String(data.attemptId ?? ""), "Budget model usage attempt ID");
    const attempt = state.modelAttempts[attemptId];
    if (!attempt) throw new Error("Model usage has no matching attempt");
    const usage = parseUsage(data.usage);
    if (attempt.usage) {
      if (sameUsage(attempt.usage, usage)) return state;
      if (attempt.usage.precision === "provider-confirmed") throw new Error("Provider-confirmed model usage is immutable and cannot regress or conflict");
      if (usage.precision === "estimated" && (usage.inputTokens < attempt.usage.inputTokens || usage.outputTokens < attempt.usage.outputTokens)) throw new Error("Estimated model usage cannot regress");
      if (usage.precision === "provider-confirmed" && (usage.inputTokens < attempt.usage.inputTokens || usage.outputTokens < attempt.usage.outputTokens)) throw new Error("Confirmed model usage cannot regress below the durable estimate");
    }
    return deepFreeze({
      ...state,
      run: counterWithUsage(state.run, attempt.usage, usage) as BudgetCounterTotals,
      nodes: { ...state.nodes, [attempt.nodeId]: counterWithUsage(state.nodes[attempt.nodeId], attempt.usage, usage) as NodeBudgetCounterTotals },
      modelAttempts: { ...state.modelAttempts, [attemptId]: { ...attempt, usage } },
    });
  }
  if (event.type === "budget.tool.attempted") {
    const attemptId = boundedId(String(data.attemptId ?? ""), "Budget tool attempt ID");
    const correlationId = boundedId(String(data.correlationId ?? ""), "Budget tool correlation ID");
    const nodeId = boundedId(String(data.nodeId ?? ""), "Budget tool node ID");
    const toolName = boundedId(String(data.toolName ?? ""), "Budget tool name");
    if (!state.nodes[nodeId] || state.toolAttempts[attemptId] || Object.values(state.toolAttempts).some((attempt) => attempt.correlationId === correlationId)) throw new Error("Budget tool attempt is duplicated or targets an unknown node");
    if (data.policyOutcome !== "allowed" && data.policyOutcome !== "denied") throw new Error("Budget tool policy outcome is invalid");
    const attempt = Object.freeze({ attemptId, correlationId, nodeId, toolName, policyOutcome: data.policyOutcome, finalization: data.finalization === true, sequence: event.sequence }) as ToolBudgetAttempt;
    return deepFreeze({ ...state, run: { ...state.run, toolCalls: state.run.toolCalls + 1 }, nodes: { ...state.nodes, [nodeId]: { ...state.nodes[nodeId], toolCalls: state.nodes[nodeId].toolCalls + 1 } }, toolAttempts: { ...state.toolAttempts, [attemptId]: attempt } });
  }
  if (event.type === "budget.clock.started") {
    const activityId = boundedId(String(data.activityId ?? ""), "Budget activity ID");
    const nodeId = boundedId(String(data.nodeId ?? ""), "Budget activity node ID");
    if (state.paused || !state.nodes[nodeId] || state.activeBatches.some((entry) => entry.activityId === activityId || entry.nodeId === nodeId)) throw new Error("Budget active clock start is invalid");
    const startedAtMs = eventMs(event);
    return deepFreeze({ ...state, activeBatches: [...state.activeBatches, { activityId, nodeId, startedAtMs }], runActiveSinceMs: state.runActiveSinceMs ?? startedAtMs });
  }
  if (event.type === "budget.clock.stopped") {
    const activityId = boundedId(String(data.activityId ?? ""), "Budget activity ID");
    if (!state.activeBatches.some((entry) => entry.activityId === activityId)) throw new Error("Budget active clock stop is stale");
    return closeActive(state, eventMs(event), new Set([activityId]));
  }
  if (event.type === "budget.clock.paused") return deepFreeze({ ...closeActive(state, eventMs(event)), paused: true });
  if (event.type === "budget.clock.resumed") {
    if (!state.paused || state.activeBatches.length) throw new Error("Budget active clock resume is invalid");
    return deepFreeze({ ...state, paused: false });
  }
  if (event.type === "budget.warning.recorded") {
    const key = boundedId(String(data.key ?? ""), "Budget warning key");
    if (state.warnings.some((warning) => warning.key === key)) throw new Error("Budget warning is duplicated");
    if ((data.scope !== "run" && data.scope !== "node") || typeof data.resource !== "string" || typeof data.fraction !== "number" || typeof data.used !== "number" || typeof data.limit !== "number") throw new Error("Budget warning is invalid");
    const warning: BudgetWarning = Object.freeze({ key, scope: data.scope, ...(typeof data.nodeId === "string" ? { nodeId: data.nodeId } : {}), resource: data.resource as BudgetWarning["resource"], fraction: data.fraction, used: data.used, limit: data.limit, sequence: event.sequence });
    return deepFreeze({ ...state, warnings: [...state.warnings, warning] });
  }
  return state;
}

function resolvedEffective(value: unknown, field: BudgetField): number {
  if (!plainRecord(value) || !plainRecord(value[field]) || !Number.isSafeInteger(value[field].effective)) return PACKAGE_BUDGET_CAPS[field];
  return Math.min(PACKAGE_BUDGET_CAPS[field], Number(value[field].effective));
}
export function effectiveRuntimeBudgetLimitsFromSnapshot(snapshot: ActivationSnapshotFileV1): EffectiveRuntimeBudgetLimits {
  const workflow = snapshot.payload.workflow;
  const budgetRecord = plainRecord(workflow.budgets) ? workflow.budgets : {};
  const runRecord = plainRecord(budgetRecord.run) ? budgetRecord.run : {};
  const team = plainRecord(workflow.team) && Array.isArray(workflow.team.nodes) ? workflow.team.nodes : [];
  const nodes: Record<string, NodeBudgetLimits> = {};
  for (const raw of team) {
    if (!plainRecord(raw) || typeof raw.id !== "string") continue;
    const declarations = plainRecord(raw.budgets) && plainRecord(raw.budgets.node) ? raw.budgets.node : {};
    nodes[raw.id] = {
      maxAgentTurns: resolvedEffective(declarations, "max-agent-turns"), maxToolCalls: resolvedEffective(declarations, "max-tool-calls"),
      tokenBudget: resolvedEffective(declarations, "token-budget"), activeWallTimeMs: resolvedEffective(declarations, "active-wall-time"),
    };
  }
  return validateLimits({ run: {
    maxParallel: resolvedEffective(runRecord, "max-parallel"), maxDelegations: resolvedEffective(runRecord, "max-delegations"),
    maxToolCalls: resolvedEffective(runRecord, "max-tool-calls"), tokenBudget: resolvedEffective(runRecord, "token-budget"), activeWallTimeMs: resolvedEffective(runRecord, "active-wall-time"),
  }, nodes }, String((plainRecord(workflow.team) && workflow.team.rootId) || ""));
}

function stableAttemptId(kind: "model" | "tool", correlationId: string, nodeId: string): string {
  return `${kind}-${createHash("sha256").update(`pi-hive-budget-${kind}-attempt-v1\0${correlationId}\0${nodeId}`).digest("hex").slice(0, 32)}`;
}
function usageWithOngoing(state: BudgetState, nowMs: number): { runActive: number; nodeActive: Record<string, number> } {
  const nodeActive = Object.fromEntries(Object.entries(state.nodes).map(([nodeId, value]) => [nodeId, value.activeWallTimeMs]));
  for (const batch of state.activeBatches) nodeActive[batch.nodeId] += Math.max(0, nowMs - batch.startedAtMs);
  return { runActive: state.run.activeWallTimeMs + (state.runActiveSinceMs === undefined ? 0 : Math.max(0, nowMs - state.runActiveSinceMs)), nodeActive };
}
export function budgetExhaustionScope(exhausted: readonly string[]): BudgetExhaustionScope {
  return exhausted.some((item) => item.startsWith("run ") || item.startsWith("root finalization") || item === "unknown node") ? "run" : "node";
}

export class BudgetRuntime {
  readonly options: BudgetRuntimeOptions;
  private readonly zero: BudgetState;
  constructor(options: BudgetRuntimeOptions) {
    this.options = options;
    this.zero = createBudgetState(options.sessionId, options.runId, options.rootNodeId, options.limits);
  }
  restore(): BudgetState { return replayWorkflowJournal(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), this.zero, reduceBudgetState).state; }
  private timestamp(ms?: number): string { return ms === undefined ? (this.options.now?.() ?? new Date(this.nowMs()).toISOString()) : new Date(ms).toISOString(); }
  private nowMs(): number { const value = this.options.nowMs?.() ?? Date.now(); if (!Number.isFinite(value)) throw new Error("Budget clock is invalid"); return value; }
  private append(
    type: Exclude<WorkflowEventType, "task.accepted">,
    data: Record<string, JsonValue>,
    timestamp?: string,
    validateLocked?: (state: BudgetState) => void,
  ): WorkflowEventEnvelope {
    const draft = createWorkflowEvent({ projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId, type, payload: { formatVersion: FORMAT_VERSION, ...data }, producer: "harness", timestamp: timestamp ?? this.timestamp() });
    return appendWorkflowEventChecked(this.options.projectRoot, draft, (events) => {
      const replayed = replayWorkflowJournal(events, this.zero, reduceBudgetState);
      validateLocked?.(replayed.state);
      reduceBudgetState(replayed.state, sealWorkflowEvent(draft, replayed.lastSequence + 1, replayed.lastHash));
    });
  }
  private exhaustedFromState(state: BudgetState, nodeId: string, kind: "model" | "tool" | "delegation", finalization = false, toolName?: string): string[] {
    const node = state.nodes[nodeId];
    if (!node) return ["unknown node"];
    const active = usageWithOngoing(state, this.nowMs());
    const exhausted: string[] = [];
    if (kind === "delegation" && state.run.delegations >= state.limits.run.maxDelegations) exhausted.push("run max-delegations");
    if (!finalization) {
      if (state.run.tokens >= state.limits.run.tokenBudget) exhausted.push("run token-budget");
      if (node.tokens >= state.limits.nodes[nodeId].tokenBudget) exhausted.push("node token-budget");
      if (active.runActive >= state.limits.run.activeWallTimeMs) exhausted.push("run active-wall-time");
      if (active.nodeActive[nodeId] >= state.limits.nodes[nodeId].activeWallTimeMs) exhausted.push("node active-wall-time");
    }
    if (kind === "model") {
      const reserve = nodeId === state.rootNodeId && !finalization ? BUDGET_POLICY_V1.rootFinalizationModelAttempts : 0;
      if (!finalization && node.turns >= Math.max(0, state.limits.nodes[nodeId].maxAgentTurns - reserve)) exhausted.push(reserve ? "node max-agent-turns finalization reserve" : "node max-agent-turns");
      if (finalization && (nodeId !== state.rootNodeId || Object.values(state.modelAttempts).some((attempt) => attempt.finalization))) exhausted.push("root finalization model reserve");
    }
    if (kind === "tool") {
      const reserve = !finalization ? BUDGET_POLICY_V1.rootFinalizationToolAttempts : 0;
      if (!finalization && state.run.toolCalls >= Math.max(0, state.limits.run.maxToolCalls - reserve)) exhausted.push("run max-tool-calls finalization reserve");
      if (!finalization && node.toolCalls >= Math.max(0, state.limits.nodes[nodeId].maxToolCalls - (nodeId === state.rootNodeId ? reserve : 0))) exhausted.push("node max-tool-calls");
      if (finalization && (nodeId !== state.rootNodeId || !BUDGET_POLICY_V1.finalizationTools.includes(toolName as never) || Object.values(state.toolAttempts).some((attempt) => attempt.finalization))) exhausted.push("root finalization tool reserve or restriction");
    }
    return exhausted;
  }
  private exhausted(nodeId: string, kind: "model" | "tool" | "delegation", finalization = false, toolName?: string): string[] {
    return this.exhaustedFromState(this.restore(), nodeId, kind, finalization, toolName);
  }
  private denied(exhausted: readonly string[]): DeniedBudgetAdmission {
    return Object.freeze({ ok: false, reason: `Budget admission denied: ${exhausted.join(", ")}`, exhausted: Object.freeze([...exhausted]), budgetExhausted: true, scope: budgetExhaustionScope(exhausted) });
  }
  admitDelegation(nodeId: string): BudgetAdmission {
    const exhausted = this.exhausted(nodeId, "delegation");
    return exhausted.length ? this.denied(exhausted) : Object.freeze({ ok: true });
  }
  /** Called only from a task-acceptance journal check while that journal's append lock is held. */
  admitDelegationAgainst(events: readonly WorkflowEventEnvelope[], nodeId: string): BudgetAdmission {
    const state = replayWorkflowJournal(events, this.zero, reduceBudgetState).state;
    const exhausted = this.exhaustedFromState(state, nodeId, "delegation");
    return exhausted.length ? this.denied(exhausted) : Object.freeze({ ok: true });
  }
  startModelAttempt(nodeId: string, correlationId: string, options: { finalization?: boolean } = {}): BudgetAttemptAdmission {
    try { boundedId(correlationId, "Model correlation ID"); } catch (error) { return Object.freeze({ ok: false, reason: String(error instanceof Error ? error.message : error), exhausted: ["invalid correlation"], budgetExhausted: false, scope: "node" }); }
    const finalization = options.finalization === true;
    const exhausted = this.exhausted(nodeId, "model", finalization);
    if (exhausted.length) return this.denied(exhausted);
    const attemptId = stableAttemptId("model", correlationId, nodeId);
    try {
      this.append("budget.model.attempted", { attemptId, correlationId, nodeId, finalization }, undefined, (locked) => {
        const lockedExhausted = this.exhaustedFromState(locked, nodeId, "model", finalization);
        if (lockedExhausted.length) throw new BudgetAdmissionDenied(this.denied(lockedExhausted));
      });
    } catch (error) {
      if (error instanceof BudgetAdmissionDenied) return error.admission;
      return Object.freeze({ ok: false, reason: String(error instanceof Error ? error.message : error), exhausted: ["duplicate or stale attempt"], budgetExhausted: false, scope: "node" });
    }
    this.emitWarnings();
    return Object.freeze({ ok: true, attemptId });
  }
  recordModelUsage(attemptId: string, usage: ModelUsageInput): void {
    const parsed = parseUsage(usage);
    const existing = this.restore().modelAttempts[attemptId];
    if (!existing) throw new Error("Model usage has no matching attempt");
    if (existing.usage && sameUsage(existing.usage, parsed)) return;
    this.append("budget.model.usage.recorded", { attemptId, usage: parsed as unknown as JsonValue });
    this.emitWarnings();
  }
  postResponseOverages(nodeId: string): readonly string[] {
    const state = this.restore();
    const node = state.nodes[nodeId];
    if (!node) return Object.freeze(["unknown node"]);
    const active = usageWithOngoing(state, this.nowMs());
    const overages: string[] = [];
    if (state.run.tokens > state.limits.run.tokenBudget) overages.push("run token-budget overage");
    if (node.tokens > state.limits.nodes[nodeId].tokenBudget) overages.push("node token-budget overage");
    if (active.runActive > state.limits.run.activeWallTimeMs) overages.push("run active-wall-time overage");
    if (active.nodeActive[nodeId] > state.limits.nodes[nodeId].activeWallTimeMs) overages.push("node active-wall-time overage");
    return Object.freeze(overages);
  }
  recordToolAttempt(nodeId: string, correlationId: string, input: { toolName: string; policyOutcome: "allowed" | "denied"; finalization?: boolean }): BudgetAdmission {
    try { boundedId(correlationId, "Tool correlation ID"); boundedId(input.toolName, "Tool name"); } catch (error) { return Object.freeze({ ok: false, reason: String(error instanceof Error ? error.message : error), exhausted: ["invalid tool attempt"], budgetExhausted: false, scope: "node" }); }
    const finalization = input.finalization === true;
    const exhausted = this.exhausted(nodeId, "tool", finalization, input.toolName);
    if (exhausted.length) return this.denied(exhausted);
    const attemptId = stableAttemptId("tool", correlationId, nodeId);
    try {
      this.append("budget.tool.attempted", { attemptId, correlationId, nodeId, toolName: input.toolName, policyOutcome: input.policyOutcome, finalization }, undefined, (locked) => {
        const lockedExhausted = this.exhaustedFromState(locked, nodeId, "tool", finalization, input.toolName);
        if (lockedExhausted.length) throw new BudgetAdmissionDenied(this.denied(lockedExhausted));
      });
    } catch (error) {
      if (error instanceof BudgetAdmissionDenied) return error.admission;
      return Object.freeze({ ok: false, reason: String(error instanceof Error ? error.message : error), exhausted: ["duplicate or stale attempt"], budgetExhausted: false, scope: "node" });
    }
    this.emitWarnings();
    return Object.freeze({ ok: true, attemptId });
  }
  beginActive(nodeId: string, activityId: string): BudgetAdmission {
    const exhausted = this.exhausted(nodeId, "model");
    const relevant = exhausted.filter((item) => item.includes("active-wall-time") || item === "unknown node");
    if (relevant.length) return Object.freeze({ ok: false, reason: `Active-time admission denied: ${relevant.join(", ")}`, exhausted: relevant, budgetExhausted: true, scope: budgetExhaustionScope(relevant) });
    try { this.append("budget.clock.started", { nodeId, activityId }); }
    catch (error) { return Object.freeze({ ok: false, reason: String(error instanceof Error ? error.message : error), exhausted: ["active clock conflict"], budgetExhausted: false, scope: "node" }); }
    return Object.freeze({ ok: true });
  }
  endActive(activityId: string): void { this.append("budget.clock.stopped", { activityId }); this.emitWarnings(); }
  pauseActive(reason: string): void { if (!this.restore().paused) this.append("budget.clock.paused", { reason: reason.slice(0, 2_048) }); this.emitWarnings(); }
  resumeActive(): void { if (this.restore().paused) this.append("budget.clock.resumed", {}); }
  reconcileAbandonedActiveTime(lastOwnedAtMs: number, reason: string): void {
    if (!Number.isFinite(lastOwnedAtMs)) throw new Error("Abandoned active-time boundary is invalid");
    if (!this.restore().activeBatches.length) return;
    this.append("budget.clock.paused", { reason: reason.slice(0, 2_048), recovered: true }, this.timestamp(lastOwnedAtMs));
  }
  private warningCandidates(state: BudgetState): Array<Omit<BudgetWarning, "key" | "sequence">> {
    const active = usageWithOngoing(state, this.nowMs());
    const result: Array<Omit<BudgetWarning, "key" | "sequence">> = [];
    const add = (scope: "run" | "node", resource: BudgetWarning["resource"], used: number, limit: number, nodeId?: string) => {
      for (const fraction of BUDGET_POLICY_V1.warningFractions) if (used / limit >= fraction) result.push({ scope, resource, used, limit, fraction, ...(nodeId ? { nodeId } : {}) });
    };
    add("run", "delegations", state.run.delegations, state.limits.run.maxDelegations);
    add("run", "tools", state.run.toolCalls, state.limits.run.maxToolCalls);
    add("run", "tokens", state.run.tokens, state.limits.run.tokenBudget);
    add("run", "active-wall-time", active.runActive, state.limits.run.activeWallTimeMs);
    for (const [nodeId, node] of Object.entries(state.nodes)) {
      add("node", "turns", node.turns, state.limits.nodes[nodeId].maxAgentTurns, nodeId);
      add("node", "tools", node.toolCalls, state.limits.nodes[nodeId].maxToolCalls, nodeId);
      add("node", "tokens", node.tokens, state.limits.nodes[nodeId].tokenBudget, nodeId);
      add("node", "active-wall-time", active.nodeActive[nodeId], state.limits.nodes[nodeId].activeWallTimeMs, nodeId);
    }
    return result;
  }
  private emitWarnings(): void {
    for (;;) {
      const state = this.restore();
      const candidate = this.warningCandidates(state).find((warning) => {
        const key = `${warning.scope}-${warning.nodeId ?? "run"}-${warning.resource}-${Math.round(warning.fraction * 100)}`;
        return !state.warnings.some((existing) => existing.key === key);
      });
      if (!candidate) return;
      const key = `${candidate.scope}-${candidate.nodeId ?? "run"}-${candidate.resource}-${Math.round(candidate.fraction * 100)}`;
      this.append("budget.warning.recorded", { key, ...candidate } as unknown as Record<string, JsonValue>);
    }
  }
}
