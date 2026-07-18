import type { JsonValue } from "../config/types";
import { type AttemptEffect, type AttemptResult, type AttemptRuntime, type PersistedAttempt } from "./attempts";
import { deepFreeze, utf8Prefix } from "./values";

export type SideEffectReconciliation =
  | Readonly<{ state: "applied" | "not-applied"; result: AttemptResult }>
  | Readonly<{ state: "unknown"; diagnostic: string }>;
export type SideEffectReconciler = (attempt: PersistedAttempt) => SideEffectReconciliation | Promise<SideEffectReconciliation>;
export interface UnknownSideEffectRecoveryOptions {
  readonly reconcilers?: Partial<Record<AttemptEffect, SideEffectReconciler>>;
  readonly pauseUnknownSideEffect: (diagnostics: readonly string[]) => void | Promise<void>;
  /** Deliberate test seam: non-idempotent recovery must never invoke it. */
  readonly redispatch?: (attempt: PersistedAttempt) => unknown | Promise<unknown>;
}
export interface UnknownSideEffectRecoveryReport {
  readonly reconciled: readonly string[];
  readonly safeRetry: readonly string[];
  readonly unresolved: readonly string[];
  readonly diagnostics: readonly string[];
  readonly paused: boolean;
}

function boundedDiagnostic(value: unknown): string {
  const text = String(value instanceof Error ? value.message : value) || "reconciliation returned no diagnostic";
  return Buffer.byteLength(text, "utf8") <= 8_192 ? text : Buffer.from(text).subarray(0, 8_192).toString("utf8");
}

/**
 * Reconcile durable intent-without-result records. This function intentionally
 * has no automatic dispatch path for uncertain effects: the redispatch seam is
 * accepted only so fault tests can prove it remains unused.
 */
export async function recoverUnknownSideEffects(runtime: AttemptRuntime, options: UnknownSideEffectRecoveryOptions): Promise<UnknownSideEffectRecoveryReport> {
  const state = runtime.restore();
  const pending = Object.values(state.attempts)
    .filter((attempt) => !attempt.result && (attempt.status === "pending" || attempt.status === "unknown_side_effect"))
    .sort((a, b) => a.startedSequence - b.startedSequence || (a.attemptId < b.attemptId ? -1 : 1));
  const reconciled: string[] = [];
  const safeRetry: string[] = [];
  const unresolved: string[] = [];
  const diagnostics: string[] = [];
  for (const attempt of pending) {
    if (attempt.recovery === "safe-retry") {
      safeRetry.push(attempt.attemptId);
      continue;
    }
    const reconciler = options.reconcilers?.[attempt.descriptor.effect];
    let decision: SideEffectReconciliation;
    if (!reconciler) {
      decision = { state: "unknown", diagnostic: `no trusted ${attempt.descriptor.effect} reconciler is registered` };
    } else {
      try { decision = await reconciler(attempt); }
      catch (error) { decision = { state: "unknown", diagnostic: `reconciler failed: ${boundedDiagnostic(error)}` }; }
    }
    if (decision.state === "applied" || decision.state === "not-applied") {
      runtime.reconcile(attempt.attemptId, decision.state, decision.result);
      reconciled.push(attempt.attemptId);
      continue;
    }
    const detail = "diagnostic" in decision ? decision.diagnostic : "reconciliation outcome was not safely classifiable";
    const diagnostic = utf8Prefix(`${attempt.attemptId} (${attempt.descriptor.effect}): ${boundedDiagnostic(detail)}`, 8_192);
    runtime.markUnknown(attempt.attemptId, diagnostic);
    unresolved.push(attempt.attemptId);
    diagnostics.push(diagnostic);
  }
  if (unresolved.length) await options.pauseUnknownSideEffect(Object.freeze(diagnostics));
  return deepFreeze({ reconciled, safeRetry, unresolved, diagnostics, paused: unresolved.length > 0 });
}

export interface HashReconciliationInput {
  readonly expectedBeforeHash?: string;
  readonly expectedAfterHash?: string;
  readonly currentHash?: string;
  readonly appliedResult?: Readonly<Record<string, JsonValue>>;
}

/** Common deterministic hash reconciliation used by filesystem/artifact hooks. */
export function reconcileExpectedHashes(input: HashReconciliationInput): SideEffectReconciliation {
  if (input.expectedAfterHash !== undefined && input.currentHash === input.expectedAfterHash) {
    return Object.freeze({ state: "applied", result: Object.freeze({ ok: true, value: (input.appliedResult ?? { afterHash: input.currentHash }) as JsonValue }) });
  }
  if (input.currentHash === input.expectedBeforeHash) {
    return Object.freeze({ state: "not-applied", result: Object.freeze({ ok: false, error: "effect was proven not applied" }) });
  }
  return Object.freeze({ state: "unknown", diagnostic: "current state matches neither the recorded before nor expected after hash" });
}
