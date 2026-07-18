import { createHash } from "node:crypto";
import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";
import { isTrustedCommandAttemptMetadata, type CommandAttemptMetadata } from "../capabilities/command";
import { isTrustedToolDescriptor } from "../capabilities/tools";
import type { TrustedToolDescriptor } from "../capabilities/types";
import { createWorkflowEvent, sealWorkflowEvent, type WorkflowEventEnvelope, type WorkflowEventType } from "./events";
import { appendWorkflowEventChecked, readWorkflowJournal } from "./journal";
import { replayWorkflowJournal } from "./replay";
import { boundedId, boundedJson, boundedText, deepFreeze, exactKeys, plainRecord } from "./values";

const FORMAT_VERSION = 1 as const;
export const ATTEMPT_POLICY_V1 = Object.freeze({
  modelTransientRetries: 2,
  readOnlyToolTransientRetries: 1,
  baseBackoffMs: 100,
  maxBackoffMs: 1_000,
  jitterFraction: 0.2,
});
export type AttemptEffect = "model" | "tool" | "filesystem" | "artifact" | "shell" | "git" | "network" | "approval" | "question" | "delegation" | "external";
export interface AttemptDescriptor { readonly effect: AttemptEffect; readonly readOnly: boolean; readonly idempotent: boolean }
const TRUSTED_ATTEMPT_DESCRIPTOR = Symbol("pi-hive.trusted-attempt-descriptor");
export type TrustedAttemptDescriptor = AttemptDescriptor & { readonly [TRUSTED_ATTEMPT_DESCRIPTOR]: true };
function trustedDescriptor(value: AttemptDescriptor): TrustedAttemptDescriptor {
  const result = { ...value } as AttemptDescriptor & { [TRUSTED_ATTEMPT_DESCRIPTOR]?: true };
  Object.defineProperty(result, TRUSTED_ATTEMPT_DESCRIPTOR, { value: true, enumerable: false, writable: false, configurable: false });
  return Object.freeze(result) as TrustedAttemptDescriptor;
}
function requireTrustedDescriptor(value: unknown): TrustedAttemptDescriptor {
  if (!value || typeof value !== "object" || (value as Record<PropertyKey, unknown>)[TRUSTED_ATTEMPT_DESCRIPTOR] !== true) throw new Error("Dispatch requires a package-branded trusted attempt descriptor");
  return trustedDescriptor(descriptor(value));
}
export function attemptDescriptorForModel(): TrustedAttemptDescriptor {
  return trustedDescriptor({ effect: "model", readOnly: true, idempotent: true });
}
export function attemptDescriptorFromTrustedTool(value: TrustedToolDescriptor): TrustedAttemptDescriptor {
  if (!isTrustedToolDescriptor(value)) throw new Error("Tool retry classification requires a trusted package descriptor identity");
  const effect: AttemptEffect = value.name === "write" ? "filesystem"
    : value.subsystem === "artifact" ? "artifact"
      : value.subsystem === "questions" ? "question"
        : value.name === "delegate_agent" ? "delegation" : "tool";
  return trustedDescriptor({ effect, readOnly: value.mutability === "read-only", idempotent: value.idempotency === "idempotent" });
}
export function attemptDescriptorFromCommandMetadata(value: CommandAttemptMetadata): TrustedAttemptDescriptor {
  if (!isTrustedCommandAttemptMetadata(value)) throw new Error("Trusted command attempt metadata identity is invalid");
  const effect: AttemptEffect = value.git ? "git" : value.networkTargets.length ? "network" : "shell";
  return trustedDescriptor({ effect, readOnly: value.valid && !value.mutating, idempotent: effect !== "network" && value.valid && !value.mutating && value.idempotency === "idempotent" });
}
export interface AttemptResult { readonly ok: boolean; readonly value?: JsonValue; readonly error?: string; readonly transient?: boolean; readonly policyDenied?: boolean; readonly effectNotApplied?: boolean; readonly assistantOutputObserved?: boolean; readonly toolCallObserved?: boolean; readonly budgetExhausted?: readonly string[] }
export type AttemptStatus = "pending" | "completed" | "failed" | "unknown_side_effect";
export interface PersistedAttempt {
  readonly attemptId: string; readonly correlationId: string; readonly nodeId: string; readonly operation: string;
  readonly inputHash: string; readonly descriptor: AttemptDescriptor; readonly status: AttemptStatus;
  readonly startedAt: string; readonly startedSequence: number; readonly result?: AttemptResult;
  readonly resultSequence?: number; readonly recovery: "none" | "safe-retry" | "reconcile-required";
  readonly reconciliation?: "applied" | "not-applied"; readonly diagnostic?: string;
}
export interface AttemptState { readonly sessionId: string; readonly runId: string; readonly attempts: Readonly<Record<string, PersistedAttempt>> }
export interface BeginAttemptInput {
  readonly attemptId: string; readonly correlationId: string; readonly nodeId: string; readonly operation: string;
  readonly input: unknown; readonly descriptor: AttemptDescriptor;
}
export type BeginAttemptResult = Readonly<{ state: "started"; attempt: PersistedAttempt }> | Readonly<{ state: "pending"; attempt: PersistedAttempt }> | Readonly<{ state: "completed"; attempt: PersistedAttempt; result: AttemptResult }>;
export interface AttemptRuntimeOptions { readonly projectRoot: string; readonly projectId: string; readonly sessionId: string; readonly runId: string; readonly now?: () => string }
export interface ConservativeRetryInput<T> {
  readonly correlationId: string; readonly nodeId: string; readonly operation: string; readonly input: unknown; readonly descriptor: TrustedAttemptDescriptor;
  readonly dispatch: (context: Readonly<{ attemptId: string; correlationId: string; ordinal: number }>) => T | Promise<T>;
  readonly sleep?: (milliseconds: number) => void | Promise<void>; readonly random?: () => number;
}

const ATTEMPT_EVENTS = new Set<WorkflowEventType>(["attempt.intent.recorded", "attempt.result.recorded", "attempt.reconciliation.recorded"]);
const EFFECTS = new Set<AttemptEffect>(["model", "tool", "filesystem", "artifact", "shell", "git", "network", "approval", "question", "delegation", "external"]);
function inputHash(input: unknown): string {
  const normalized = boundedJson(input, "Attempt input", { bytes: 131_072, depth: 32, nodes: 8_192 });
  return createHash("sha256").update("pi-hive-attempt-input-v1\0").update(canonicalJson(normalized)).digest("hex");
}
function descriptor(value: unknown): AttemptDescriptor {
  if (!plainRecord(value)) throw new Error("Attempt descriptor is invalid");
  exactKeys(value, ["effect", "readOnly", "idempotent"], [], "Attempt descriptor");
  if (!EFFECTS.has(value.effect as AttemptEffect) || typeof value.readOnly !== "boolean" || typeof value.idempotent !== "boolean") throw new Error("Attempt descriptor is invalid");
  if (["filesystem", "artifact", "shell", "git", "network", "approval", "question", "delegation", "external"].includes(String(value.effect)) && value.readOnly === false && value.idempotent === true) {
    throw new Error("Mutating attempt cannot claim idempotent automatic dispatch");
  }
  return Object.freeze({ effect: value.effect as AttemptEffect, readOnly: value.readOnly, idempotent: value.idempotent });
}
function isTrustedReadOnlyRetry(value: AttemptDescriptor): boolean {
  return (value.effect === "tool" || value.effect === "artifact") && value.readOnly && value.idempotent;
}
function recoveryFor(value: AttemptDescriptor): PersistedAttempt["recovery"] {
  // A model intent alone cannot prove that a crashed provider request emitted no
  // assistant output or tool call. Only a durable failed result can carry that proof.
  if (value.effect === "model") return "reconcile-required";
  if (isTrustedReadOnlyRetry(value)) return "safe-retry";
  return value.readOnly && value.idempotent && !["network", "approval", "question", "delegation"].includes(value.effect) ? "safe-retry" : "reconcile-required";
}
function payload(event: WorkflowEventEnvelope): Record<string, unknown> {
  if (!plainRecord(event.payload) || event.payload.formatVersion !== FORMAT_VERSION) throw new Error("Attempt event payload is invalid");
  return event.payload;
}
function parseResult(value: unknown): AttemptResult {
  if (!plainRecord(value)) throw new Error("Attempt result is invalid");
  exactKeys(value, ["ok"], ["value", "error", "transient", "policyDenied", "effectNotApplied", "assistantOutputObserved", "toolCallObserved", "budgetExhausted"], "Attempt result");
  if (typeof value.ok !== "boolean") throw new Error("Attempt result is invalid");
  if (value.ok && value.error !== undefined) throw new Error("Successful attempt result cannot contain an error");
  if (!value.ok && (typeof value.error !== "string" || !value.error)) throw new Error("Failed attempt result requires an error");
  const booleans: Record<string, boolean> = {};
  for (const key of ["transient", "policyDenied", "effectNotApplied", "assistantOutputObserved", "toolCallObserved"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error(`Attempt result ${key} is invalid`);
    if (typeof value[key] === "boolean") booleans[key] = value[key];
  }
  let budgetExhausted: readonly string[] | undefined;
  if (value.budgetExhausted !== undefined) {
    if (!Array.isArray(value.budgetExhausted) || value.budgetExhausted.length < 1 || value.budgetExhausted.length > 32) throw new Error("Attempt budget exhaustion metadata is invalid");
    budgetExhausted = Object.freeze(value.budgetExhausted.map((item) => boundedText(item, "Attempt exhausted budget", 2_048)));
  }
  const result: AttemptResult = {
    ok: value.ok,
    ...(value.value === undefined ? {} : { value: boundedJson(value.value, "Attempt result value", { bytes: 65_536, depth: 16, nodes: 4_096 }) }),
    ...(value.error === undefined ? {} : { error: boundedText(value.error, "Attempt result error", 8_192) }),
    ...booleans,
    ...(budgetExhausted ? { budgetExhausted } : {}),
  };
  return deepFreeze(result);
}
export function createAttemptState(sessionId: string, runId: string): AttemptState { return deepFreeze({ sessionId: boundedId(sessionId, "Attempt session ID"), runId: boundedId(runId, "Attempt run ID"), attempts: {} }); }
export function reduceAttemptState(state: AttemptState, event: WorkflowEventEnvelope): AttemptState {
  if (!ATTEMPT_EVENTS.has(event.type) || event.runId !== state.runId) return state;
  if (event.sessionId !== state.sessionId) throw new Error("Attempt event session identity mismatch");
  const data = payload(event);
  const attemptId = boundedId(String(data.attemptId ?? ""), "Attempt ID");
  if (event.type === "attempt.intent.recorded") {
    if (event.producer !== "harness" || state.attempts[attemptId]) throw new Error("Attempt intent is unauthorized or duplicated");
    const correlationId = boundedId(String(data.correlationId ?? ""), "Attempt correlation ID");
    const nodeId = boundedId(String(data.nodeId ?? ""), "Attempt node ID");
    const operation = boundedText(data.operation, "Attempt operation", 1_024);
    if (typeof data.inputHash !== "string" || !/^[a-f0-9]{64}$/u.test(data.inputHash)) throw new Error("Attempt input hash is invalid");
    const parsedDescriptor = descriptor(data.descriptor);
    const attempt: PersistedAttempt = Object.freeze({
      attemptId, correlationId, nodeId, operation, inputHash: data.inputHash, descriptor: parsedDescriptor,
      status: "pending", startedAt: event.timestamp, startedSequence: event.sequence, recovery: recoveryFor(parsedDescriptor),
    });
    return deepFreeze({ ...state, attempts: { ...state.attempts, [attemptId]: attempt } });
  }
  const attempt = state.attempts[attemptId];
  if (!attempt) throw new Error("Attempt result has no matching intent");
  if (event.type === "attempt.result.recorded") {
    if (event.producer !== "harness" || attempt.status !== "pending") throw new Error("Attempt result is unauthorized or duplicated");
    const result = parseResult(data.result);
    return deepFreeze({ ...state, attempts: { ...state.attempts, [attemptId]: { ...attempt, status: result.ok ? "completed" : "failed", result, resultSequence: event.sequence, recovery: "none" } } });
  }
  if (event.type === "attempt.reconciliation.recorded") {
    if (event.producer !== "recovery" || (attempt.status !== "pending" && attempt.status !== "unknown_side_effect")) throw new Error("Attempt reconciliation is unauthorized or stale");
    if (data.state === "unknown") {
      const diagnostic = boundedText(data.diagnostic, "Unknown side-effect diagnostic", 8_192);
      return deepFreeze({ ...state, attempts: { ...state.attempts, [attemptId]: { ...attempt, status: "unknown_side_effect", diagnostic, recovery: "reconcile-required" } } });
    }
    if (data.state !== "applied" && data.state !== "not-applied") throw new Error("Attempt reconciliation state is invalid");
    const result = parseResult(data.result);
    return deepFreeze({ ...state, attempts: { ...state.attempts, [attemptId]: { ...attempt, status: result.ok ? "completed" : "failed", result, resultSequence: event.sequence, recovery: "none", reconciliation: data.state, diagnostic: undefined } } });
  }
  return state;
}
function errorResult(error: unknown): AttemptResult {
  const record = error && (typeof error === "object" || typeof error === "function") ? error as Record<string, unknown> : {};
  const message = boundedText(String(error instanceof Error ? error.message : error) || "Attempt failed", "Attempt failure", 8_192);
  const boolean = (key: string): Record<string, boolean> => typeof record[key] === "boolean" ? { [key]: record[key] as boolean } : {};
  const budgetExhausted = Array.isArray(record.budgetExhausted)
    ? record.budgetExhausted.filter((item): item is string => typeof item === "string").slice(0, 32).map((item) => boundedText(item, "Attempt exhausted budget", 2_048))
    : [];
  return Object.freeze({
    ok: false, error: message,
    ...boolean("transient"), ...boolean("policyDenied"), ...boolean("effectNotApplied"),
    ...boolean("assistantOutputObserved"), ...boolean("toolCallObserved"),
    ...(budgetExhausted.length ? { budgetExhausted: Object.freeze(budgetExhausted) } : {}),
  });
}
function stableAttemptId(correlationId: string, ordinal: number): string {
  const hash = createHash("sha256").update(`pi-hive-attempt-id-v1\0${correlationId}`).digest("hex").slice(0, 32);
  return `attempt-${hash}-${ordinal}`;
}
export class AttemptRuntime {
  readonly options: AttemptRuntimeOptions;
  private readonly zero: AttemptState;
  private readonly dispatching = new Set<string>();
  constructor(options: AttemptRuntimeOptions) { this.options = options; this.zero = createAttemptState(options.sessionId, options.runId); }
  restore(): AttemptState { return replayWorkflowJournal(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), this.zero, reduceAttemptState).state; }
  private append(type: "attempt.intent.recorded" | "attempt.result.recorded" | "attempt.reconciliation.recorded", data: Record<string, JsonValue>, producer: "harness" | "recovery"): WorkflowEventEnvelope {
    const draft = createWorkflowEvent({ projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId, type, payload: { formatVersion: FORMAT_VERSION, ...data }, producer, timestamp: this.options.now?.() ?? new Date().toISOString(), ...(typeof data.attemptId === "string" ? { attemptId: data.attemptId } : {}) });
    return appendWorkflowEventChecked(this.options.projectRoot, draft, (events) => {
      const replayed = replayWorkflowJournal(events, this.zero, reduceAttemptState);
      reduceAttemptState(replayed.state, sealWorkflowEvent(draft, replayed.lastSequence + 1, replayed.lastHash));
    });
  }
  begin(input: BeginAttemptInput): BeginAttemptResult {
    const attemptId = boundedId(input.attemptId, "Attempt ID");
    const correlationId = boundedId(input.correlationId, "Attempt correlation ID");
    const nodeId = boundedId(input.nodeId, "Attempt node ID");
    const operation = boundedText(input.operation, "Attempt operation", 1_024);
    const parsedDescriptor = descriptor(input.descriptor);
    const hash = inputHash(input.input);
    const existing = this.restore().attempts[attemptId];
    if (existing) {
      if (existing.correlationId !== correlationId || existing.nodeId !== nodeId || existing.operation !== operation || existing.inputHash !== hash || canonicalJson(existing.descriptor) !== canonicalJson(parsedDescriptor)) throw new Error("Attempt ID reuse with different input or descriptor is rejected");
      if (existing.result) return Object.freeze({ state: "completed", attempt: existing, result: existing.result });
      return Object.freeze({ state: "pending", attempt: existing });
    }
    this.append("attempt.intent.recorded", { attemptId, correlationId, nodeId, operation, inputHash: hash, descriptor: parsedDescriptor as unknown as JsonValue }, "harness");
    return Object.freeze({ state: "started", attempt: this.restore().attempts[attemptId] });
  }
  complete(attemptId: string, result: AttemptResult): AttemptResult {
    const parsed = parseResult(result);
    const existing = this.restore().attempts[attemptId];
    if (!existing) throw new Error("Attempt completion has no intent");
    if (existing.result) {
      if (canonicalJson(existing.result) !== canonicalJson(parsed)) throw new Error("Attempt completion conflicts with the recorded result");
      return existing.result;
    }
    this.append("attempt.result.recorded", { attemptId, result: parsed as unknown as JsonValue }, "harness");
    return this.restore().attempts[attemptId].result!;
  }
  fail(attemptId: string, error: unknown): AttemptResult { return this.complete(attemptId, errorResult(error)); }
  markDispatching(attemptId: string): void {
    const attempt = this.restore().attempts[attemptId];
    if (!attempt || attempt.result || this.dispatching.has(attemptId)) throw new Error("Attempt dispatch claim is stale or duplicated");
    this.dispatching.add(attemptId);
  }
  clearDispatching(attemptId: string): void { this.dispatching.delete(attemptId); }
  isDispatching(attemptId: string): boolean { return this.dispatching.has(attemptId); }
  markUnknown(attemptId: string, diagnostic: string): void {
    const attempt = this.restore().attempts[attemptId];
    if (!attempt || attempt.result) throw new Error("Unknown side effect requires an unresolved attempt intent");
    if (attempt.status === "unknown_side_effect" && attempt.diagnostic === diagnostic) return;
    this.append("attempt.reconciliation.recorded", { attemptId, state: "unknown", diagnostic: boundedText(diagnostic, "Unknown side-effect diagnostic", 8_192) }, "recovery");
  }
  reconcile(attemptId: string, state: "applied" | "not-applied", result: AttemptResult): AttemptResult {
    const parsed = parseResult(result);
    const attempt = this.restore().attempts[attemptId];
    if (!attempt || attempt.result) throw new Error("Attempt reconciliation requires an unresolved intent");
    this.append("attempt.reconciliation.recorded", { attemptId, state, result: parsed as unknown as JsonValue }, "recovery");
    return this.restore().attempts[attemptId].result!;
  }
}
function retryLimit(descriptor: AttemptDescriptor): number {
  if (descriptor.effect === "model") return ATTEMPT_POLICY_V1.modelTransientRetries;
  if (isTrustedReadOnlyRetry(descriptor)) return ATTEMPT_POLICY_V1.readOnlyToolTransientRetries;
  return 0;
}
function retryableFailure(result: AttemptResult, descriptor: AttemptDescriptor): boolean {
  if (!result.transient || result.policyDenied) return false;
  if (descriptor.effect === "model") return result.assistantOutputObserved === false && result.toolCallObserved === false;
  return isTrustedReadOnlyRetry(descriptor);
}
function thrownFromResult(result: AttemptResult): Error {
  const error = new Error(result.error ?? "Attempt failed");
  Object.assign(error, result);
  return error;
}
export async function executeWithConservativeRetry<T>(runtime: AttemptRuntime, input: ConservativeRetryInput<T>): Promise<T> {
  boundedId(input.correlationId, "Retry correlation ID");
  const parsedDescriptor = requireTrustedDescriptor(input.descriptor);
  const retries = retryLimit(parsedDescriptor);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const random = input.random ?? Math.random;
  for (let ordinal = 1; ordinal <= retries + 1; ordinal++) {
    const attemptId = stableAttemptId(input.correlationId, ordinal);
    const begun = runtime.begin({ attemptId, correlationId: input.correlationId, nodeId: input.nodeId, operation: input.operation, input: input.input, descriptor: parsedDescriptor });
    if (begun.state === "pending") {
      if (begun.attempt.recovery === "reconcile-required") throw new Error(`Attempt ${attemptId} has an unknown side effect and requires reconciliation`);
      if (ordinal > retries) throw new Error(`Attempt ${attemptId} was interrupted and the conservative retry allowance is exhausted`);
    }
    if (begun.state === "completed") {
      if (begun.result.ok) return begun.result.value as T;
      if (!retryableFailure(begun.result, parsedDescriptor) || ordinal > retries) throw thrownFromResult(begun.result);
    } else if (begun.state === "started") {
      runtime.markDispatching(attemptId);
      try {
        try {
          const value = await input.dispatch({ attemptId, correlationId: input.correlationId, ordinal });
          runtime.complete(attemptId, value === undefined
            ? { ok: true }
            : { ok: true, value: boundedJson(value, "Attempt dispatch result", { bytes: 65_536, depth: 16, nodes: 4_096 }) });
          return value;
        } catch (error) {
          const candidate = errorResult(error);
          const modelNoOutputProof = parsedDescriptor.effect === "model"
            && candidate.assistantOutputObserved === false && candidate.toolCallObserved === false;
          const uncertain = candidate.effectNotApplied !== true && !modelNoOutputProof
            && (recoveryFor(parsedDescriptor) === "reconcile-required" || parsedDescriptor.effect === "model");
          if (uncertain) {
            runtime.markUnknown(attemptId, candidate.error ?? "dispatch outcome is uncertain");
            throw error;
          }
          const result = runtime.complete(attemptId, candidate);
          if (!retryableFailure(result, parsedDescriptor) || ordinal > retries) throw error;
        }
      } finally {
        runtime.clearDispatching(attemptId);
      }
    }
    const rawRandom = random();
    const unit = Number.isFinite(rawRandom) ? Math.max(0, Math.min(1, rawRandom)) : 0.5;
    const base = Math.min(ATTEMPT_POLICY_V1.maxBackoffMs, ATTEMPT_POLICY_V1.baseBackoffMs * (2 ** (ordinal - 1)));
    const delay = Math.round(base * (1 - ATTEMPT_POLICY_V1.jitterFraction + 2 * ATTEMPT_POLICY_V1.jitterFraction * unit));
    await sleep(delay);
  }
  throw new Error("Conservative retry policy exhausted unexpectedly");
}
