import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { withCrossProcessFileLock } from "../core/file-lock";
import type { JsonValue } from "../config/types";
import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import { validateSnapshotResumeCompatibility, type SnapshotCompatibilityRuntime } from "../config/snapshot-compat";
import { readActivationSnapshot } from "../config/snapshot-store";
import { type AttemptEffect, type AttemptResult, type AttemptRuntime, type PersistedAttempt } from "./attempts";
import { deepFreeze, utf8Prefix } from "./values";
import { createWorkflowEvent, type WorkflowEventDraft, type WorkflowEventEnvelope } from "./events";
import { appendWorkflowEventChecked, readWorkflowJournal, workflowSessionDirectory, type JournalFaultStage } from "./journal";
import { isUnprovenSessionRestoration, type SessionNavigationAdapter } from "./navigation";
import { acquireRuntimeOwnership, settleRuntimeOwnershipRelease, type AcquireOwnershipOptions } from "./ownership";
import { commitWorkflowRecovery, listSessionLinks, markMissingPiSession, prepareWorkflowRecoveryLink, recordWorkflowRecoveryBlocked, rollbackWorkflowRecovery, sameWorkflowLinkGeneration, workflowLinkGenerationHash, type WorkflowSessionLink } from "./sessions";

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
function recoveryInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

export interface OrphanDetectionResult {
  readonly workflowSessionId: string;
  readonly workflowId: string;
  readonly piSessionId: string;
  readonly piSessionFile: string;
  readonly orphaned: true;
}
function missingOrUnsupportedPiSession(path: string): boolean {
  try { const stat = lstatSync(path); return !stat.isFile() || stat.isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}
export function detectOrphanedWorkflowSessions(input: { projectRoot: string; projectId: string }): readonly OrphanDetectionResult[] {
  reconcilePreparedWorkflowRecoveries(input);
  const results: OrphanDetectionResult[] = [];
  for (const link of listSessionLinks(input.projectRoot)) {
    if (link.kind !== "workflow") continue;
    if (link.orphaned === true || missingOrUnsupportedPiSession(link.piSessionFile)) {
      if (link.orphaned !== true) markMissingPiSession(input.projectRoot, input.projectId, link.workflowSessionId);
      results.push(Object.freeze({ workflowSessionId: link.workflowSessionId, workflowId: link.workflowId, piSessionId: link.piSessionId, piSessionFile: link.piSessionFile, orphaned: true }));
    }
  }
  return Object.freeze(results);
}

export interface RecoveryActivationValidation { readonly ok: boolean; readonly codes: readonly string[] }
function validateRecoverySnapshot(snapshot: ActivationSnapshotFileV1, input: RecoverOrphanedWorkflowSessionInput, link: WorkflowSessionLink): RecoveryActivationValidation {
  const compatibility = validateSnapshotResumeCompatibility(snapshot, input.runtime);
  const codes = [
    ...compatibility.codes,
    ...(snapshot.snapshotHash === link.activationHash ? [] : ["SNAPSHOT_ACTIVATION_IDENTITY_MISMATCH"]),
    ...(snapshot.payload.project.projectId === input.projectId ? [] : ["SNAPSHOT_PROJECT_IDENTITY_MISMATCH"]),
    ...(snapshot.payload.workflow.id === link.workflowId ? [] : ["SNAPSHOT_WORKFLOW_IDENTITY_MISMATCH"]),
  ];
  return Object.freeze({ ok: codes.length === 0, codes: Object.freeze([...new Set(codes)].sort()) });
}
export interface RecoverOrphanedWorkflowSessionInput {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly workflowSessionId: string;
  readonly adapter: SessionNavigationAdapter;
  readonly owner: AcquireOwnershipOptions & { nonce: string };
  /** Runtime/model/knowledge/artifact/workspace probes are mandatory recovery authority. */
  readonly runtime: SnapshotCompatibilityRuntime;
  /** Pi session that was active before recovery and must be restored on failure. */
  readonly restorePiSessionFile: string;
  /** Additional policy may only narrow the mandatory compatibility decision. */
  readonly validateActivation?: (snapshot: ActivationSnapshotFileV1) => RecoveryActivationValidation;
  /** Fault-injection seam for transactional recovery tests. */
  readonly journalFault?: (stage: JournalFaultStage) => void;
  /** Process-crash seam. Tests may terminate the process at a durable protocol boundary. */
  readonly recoveryFault?: (stage: RecoveryFaultStage) => void;
}
export type RecoveryFaultStage = "afterPrepared" | "afterLinkPrepared" | "afterCommitted";
function withRecoverySettlementLock<T>(projectRoot: string, workflowSessionId: string, settle: () => T): T {
  const directory = workflowSessionDirectory(projectRoot, workflowSessionId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return withCrossProcessFileLock(join(directory, "recovery-settlement"), settle, { timeoutMs: 35_000, staleMs: 30_000 });
}
function orphanLink(input: RecoverOrphanedWorkflowSessionInput): WorkflowSessionLink {
  const link = listSessionLinks(input.projectRoot).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.workflowSessionId === input.workflowSessionId);
  recoveryInvariant(link, "Orphan workflow session link is missing");
  recoveryInvariant(link.formatVersion === 1, "Workflow runtime contract is unsupported; recovery is blocked");
  recoveryInvariant(link.orphaned === true, "Workflow session is not marked orphaned");
  return link;
}
function eventPayload(event: { payload: unknown }): Record<string, unknown> | undefined {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : undefined;
}
function preparedReference(event: { type: string; payload: unknown }): string | undefined {
  if (event.type !== "session.recovered" && event.type !== "session.orphaned") return undefined;
  const payload = eventPayload(event);
  return typeof payload?.preparedEventHash === "string" ? payload.preparedEventHash : undefined;
}
function isPublishedRecoveryRollback(event: { type: string; payload: unknown }, preparedEventHash: string): boolean {
  return event.type === "session.orphaned" && preparedReference(event) === preparedEventHash && eventPayload(event)?.rolledBack === true;
}
function committedFor(events: readonly WorkflowEventEnvelope[], preparedEventHash: string): WorkflowEventEnvelope | undefined {
  return events.find((event) => event.type === "session.recovered" && preparedReference(event) === preparedEventHash);
}
function preparedPayload(event: WorkflowEventEnvelope): { expected: WorkflowSessionLink; piSessionId: string; piSessionFile: string; preparedAt: string } | undefined {
  // Every caller obtains this envelope from a session.recovery.prepared-only path.
  const payload = eventPayload(event);
  const expected = payload?.expectedLink as WorkflowSessionLink | undefined;
  if (!expected || expected.kind !== "workflow" || expected.formatVersion !== 1 || expected.workflowSessionId !== event.sessionId) return undefined;
  if (payload?.expectedLinkHash !== workflowLinkGenerationHash(expected)) return undefined;
  if (typeof payload.piSessionId !== "string" || typeof payload.piSessionFile !== "string" || typeof payload.preparedAt !== "string" || !Number.isFinite(Date.parse(payload.preparedAt))) return undefined;
  if (payload.previousPiSessionId !== expected.piSessionId || payload.previousPiSessionFile !== expected.piSessionFile || payload.activationHash !== expected.activationHash) return undefined;
  return { expected, piSessionId: payload.piSessionId, piSessionFile: payload.piSessionFile, preparedAt: payload.preparedAt };
}
function preparedLinkGeneration(prepared: WorkflowEventEnvelope, parsed: NonNullable<ReturnType<typeof preparedPayload>>): WorkflowSessionLink {
  return {
    ...parsed.expected, piSessionId: parsed.piSessionId, piSessionFile: parsed.piSessionFile, orphaned: true,
    recovery: {
      state: "prepared", previousPiSessionId: parsed.expected.piSessionId, previousPiSessionFile: parsed.expected.piSessionFile,
      preparedAt: parsed.preparedAt, preparedEventHash: prepared.eventHash, expectedLinkHash: workflowLinkGenerationHash(parsed.expected),
    },
    updatedAt: parsed.preparedAt,
  };
}
function preparedLinkMatches(link: WorkflowSessionLink, prepared: WorkflowEventEnvelope, parsed: NonNullable<ReturnType<typeof preparedPayload>>): boolean {
  return sameWorkflowLinkGeneration(link, preparedLinkGeneration(prepared, parsed));
}
function recoveredLinkMatches(link: WorkflowSessionLink, prepared: WorkflowEventEnvelope, committed: WorkflowEventEnvelope | undefined): boolean {
  return Boolean(committed) && link.orphaned === false && link.recovery?.state === "recovered"
    && link.recovery.preparedEventHash === prepared.eventHash && link.recovery.eventHash === committed?.eventHash;
}
function appendRecoveryRollback(input: { projectRoot: string; projectId: string; sessionId: string; prepared: WorkflowEventEnvelope; candidate: { piSessionId: string; piSessionFile: string }; reason: string }): void {
  const existing = readWorkflowJournal(input.projectRoot, input.sessionId);
  if (committedFor(existing, input.prepared.eventHash)) throw new Error("Committed workflow recovery cannot be rolled back");
  if (existing.some((event) => isPublishedRecoveryRollback(event, input.prepared.eventHash))) return;
  appendWorkflowEventChecked(input.projectRoot, createWorkflowEvent({
    projectId: input.projectId, sessionId: input.sessionId, type: "session.orphaned", producer: "recovery",
    payload: {
      reason: input.reason.slice(0, 2_048), piSessionId: input.candidate.piSessionId, piSessionFile: input.candidate.piSessionFile,
      preparedEventHash: input.prepared.eventHash, rolledBack: true,
    },
  }), (locked) => {
    if (committedFor(locked, input.prepared.eventHash)) throw new Error("Committed workflow recovery cannot be rolled back");
    if (locked.some((event) => isPublishedRecoveryRollback(event, input.prepared.eventHash))) throw new Error("Workflow recovery was already rolled back concurrently");
  });
}
function appendRecoveryCommit(input: { projectRoot: string; projectId: string; prepared: WorkflowEventEnvelope; preparedLink: WorkflowSessionLink; recoveredAt: string; fault?: (stage: JournalFaultStage) => void }): WorkflowEventEnvelope {
  recoveryInvariant(input.preparedLink.recovery?.state === "prepared" && input.preparedLink.recovery.preparedEventHash === input.prepared.eventHash, "Workflow recovery link is not durably prepared");
  return appendWorkflowEventChecked(input.projectRoot, createWorkflowEvent({
    projectId: input.projectId, sessionId: input.preparedLink.workflowSessionId, type: "session.recovered", producer: "recovery", timestamp: input.recoveredAt,
    payload: {
      preparedEventHash: input.prepared.eventHash,
      previousPiSessionId: input.preparedLink.recovery.previousPiSessionId, previousPiSessionFile: input.preparedLink.recovery.previousPiSessionFile,
      piSessionId: input.preparedLink.piSessionId, piSessionFile: input.preparedLink.piSessionFile,
      activationHash: input.preparedLink.activationHash, recoveredAt: input.recoveredAt,
    },
  }), (events) => {
    recoveryInvariant(events.some((event) => event.eventHash === input.prepared.eventHash && event.type === "session.recovery.prepared"), "Workflow recovery preparation is missing");
    recoveryInvariant(!events.some((event) => isPublishedRecoveryRollback(event, input.prepared.eventHash)), "Workflow recovery preparation was rolled back");
    recoveryInvariant(!committedFor(events, input.prepared.eventHash), "Workflow recovery was committed concurrently");
  }, { fault: input.fault });
}
function currentWorkflowLink(projectRoot: string, workflowSessionId: string): WorkflowSessionLink {
  const current = listSessionLinks(projectRoot).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.workflowSessionId === workflowSessionId);
  recoveryInvariant(current, "Prepared workflow session link is missing");
  return current;
}
function committedTimestamp(committed: WorkflowEventEnvelope): string {
  const recoveredAt = eventPayload(committed)?.recoveredAt;
  recoveryInvariant(typeof recoveredAt === "string" && Number.isFinite(Date.parse(recoveredAt)), "Workflow recovery commit timestamp is invalid");
  return recoveredAt;
}
/** Must be called while holding the per-session recovery settlement lock. */
function commitRecoverySettlement(input: { projectRoot: string; projectId: string; prepared: WorkflowEventEnvelope; recoveredAt: string; fault?: (stage: JournalFaultStage) => void; afterCommitPublished?: () => void }): WorkflowSessionLink {
  const parsed = preparedPayload(input.prepared);
  recoveryInvariant(parsed, "Workflow recovery preparation is invalid");
  let events = readWorkflowJournal(input.projectRoot, input.prepared.sessionId);
  recoveryInvariant(!events.some((event) => isPublishedRecoveryRollback(event, input.prepared.eventHash)), "Workflow recovery preparation was rolled back");
  let committed = committedFor(events, input.prepared.eventHash);
  let current = currentWorkflowLink(input.projectRoot, input.prepared.sessionId);
  if (recoveredLinkMatches(current, input.prepared, committed)) return current;
  recoveryInvariant(preparedLinkMatches(current, input.prepared, parsed), "Prepared workflow link changed before recovery commit");
  if (!committed) {
    try { committed = appendRecoveryCommit({ ...input, preparedLink: current }); }
    catch (error) {
      events = readWorkflowJournal(input.projectRoot, input.prepared.sessionId);
      committed = committedFor(events, input.prepared.eventHash);
      if (!committed) throw error;
    }
    events = readWorkflowJournal(input.projectRoot, input.prepared.sessionId);
    committed = committedFor(events, input.prepared.eventHash) ?? committed;
    input.afterCommitPublished?.();
  }
  current = currentWorkflowLink(input.projectRoot, input.prepared.sessionId);
  if (recoveredLinkMatches(current, input.prepared, committed)) return current;
  return commitWorkflowRecovery(input.projectRoot, current, { recoveredAt: committedTimestamp(committed), preparedEventHash: input.prepared.eventHash, eventHash: committed.eventHash });
}
/** Must be called while holding the per-session recovery settlement lock. A published commit always wins. */
function rollbackRecoverySettlement(input: { projectRoot: string; projectId: string; prepared: WorkflowEventEnvelope; reason: string }): WorkflowSessionLink | undefined {
  const parsed = preparedPayload(input.prepared);
  recoveryInvariant(parsed, "Workflow recovery preparation is invalid");
  const events = readWorkflowJournal(input.projectRoot, input.prepared.sessionId);
  const committed = committedFor(events, input.prepared.eventHash);
  let current = currentWorkflowLink(input.projectRoot, input.prepared.sessionId);
  if (committed) {
    if (recoveredLinkMatches(current, input.prepared, committed)) return current;
    recoveryInvariant(preparedLinkMatches(current, input.prepared, parsed), "Committed workflow recovery link changed before reconciliation");
    return commitWorkflowRecovery(input.projectRoot, current, { recoveredAt: committedTimestamp(committed), preparedEventHash: input.prepared.eventHash, eventHash: committed.eventHash });
  }
  if (events.some((event) => isPublishedRecoveryRollback(event, input.prepared.eventHash))) return undefined;
  if (!sameWorkflowLinkGeneration(current, parsed.expected)) {
    recoveryInvariant(preparedLinkMatches(current, input.prepared, parsed), "Workflow recovery rollback refused a changed link generation");
    rollbackWorkflowRecovery(input.projectRoot, current, parsed.expected, input.prepared.eventHash);
    current = currentWorkflowLink(input.projectRoot, input.prepared.sessionId);
    recoveryInvariant(sameWorkflowLinkGeneration(current, parsed.expected), "Workflow recovery rollback did not restore the exact prior generation");
  }
  appendRecoveryRollback({ projectRoot: input.projectRoot, projectId: input.projectId, sessionId: input.prepared.sessionId, prepared: input.prepared, candidate: parsed, reason: input.reason });
  return undefined;
}
/** Resolve durable recovery preparations left by a terminated process before orphan status is reported. */
export function reconcilePreparedWorkflowRecoveries(input: { projectRoot: string; projectId: string }): void {
  for (const initial of listSessionLinks(input.projectRoot)) {
    if (initial.kind !== "workflow") continue;
    const preparedEvents = readWorkflowJournal(input.projectRoot, initial.workflowSessionId).filter((event) => event.type === "session.recovery.prepared");
    for (const prepared of preparedEvents) {
      withRecoverySettlementLock(input.projectRoot, initial.workflowSessionId, () => {
        const parsed = preparedPayload(prepared);
        recoveryInvariant(parsed, "Workflow recovery preparation is invalid");
        const events = readWorkflowJournal(input.projectRoot, initial.workflowSessionId);
        const committed = committedFor(events, prepared.eventHash);
        if (events.some((event) => isPublishedRecoveryRollback(event, prepared.eventHash))) return;
        let current = currentWorkflowLink(input.projectRoot, initial.workflowSessionId);
        if (recoveredLinkMatches(current, prepared, committed)) return;
        try {
          if (!preparedLinkMatches(current, prepared, parsed)) {
            recoveryInvariant(sameWorkflowLinkGeneration(current, parsed.expected), "prepared recovery lost its exact link generation");
            if (missingOrUnsupportedPiSession(parsed.piSessionFile)) {
              rollbackRecoverySettlement({ ...input, prepared, reason: "recovery restart reconciliation rolled back a missing Pi session" });
              return;
            }
            current = prepareWorkflowRecoveryLink(input.projectRoot, parsed.expected, { ...parsed, preparedEventHash: prepared.eventHash });
          }
          if (missingOrUnsupportedPiSession(current.piSessionFile)) {
            rollbackRecoverySettlement({ ...input, prepared, reason: "recovery restart reconciliation rolled back a missing Pi session" });
            return;
          }
          commitRecoverySettlement({ ...input, prepared, recoveredAt: new Date().toISOString() });
        } catch (error) {
          const recovered = rollbackRecoverySettlement({ ...input, prepared, reason: `recovery restart reconciliation blocked: ${boundedDiagnostic(error)}` });
          if (recovered) return;
        }
      });
    }
  }
}

export async function recoverOrphanedWorkflowSession(input: RecoverOrphanedWorkflowSessionInput): Promise<WorkflowSessionLink> {
  const link = orphanLink(input);
  recoveryInvariant(link.recovery?.state !== "prepared", "Workflow recovery has a durable preparation that must be reconciled first");
  recoveryInvariant(!missingOrUnsupportedPiSession(input.restorePiSessionFile), "Recovery requires a persisted prior Pi session restoration target");
  let snapshot: ActivationSnapshotFileV1;
  let validation: RecoveryActivationValidation;
  try {
    snapshot = readActivationSnapshot(input.projectRoot, link.activationHash);
    const base = validateRecoverySnapshot(snapshot, input, link);
    let narrowing: RecoveryActivationValidation = Object.freeze({ ok: true, codes: Object.freeze([]) });
    if (input.validateActivation) {
      try { narrowing = input.validateActivation(snapshot); }
      catch { narrowing = Object.freeze({ ok: false, codes: Object.freeze(["RECOVERY_VALIDATION_FAILED"]) }); }
    }
    validation = Object.freeze({ ok: base.ok && narrowing.ok, codes: Object.freeze([...new Set([...base.codes, ...narrowing.codes])].sort()) });
  } catch (error) {
    validation = Object.freeze({ ok: false, codes: Object.freeze(["SNAPSHOT_INVALID"]) });
    recordWorkflowRecoveryBlocked(input.projectRoot, input.projectId, link, validation.codes, `Snapshot invalid or missing: ${String(error instanceof Error ? error.message : error)}`);
    throw new Error(`Snapshot invalid or missing; recovery blocked: ${validation.codes.join(",")}`);
  }
  if (!validation.ok) {
    recordWorkflowRecoveryBlocked(input.projectRoot, input.projectId, link, validation.codes, "Stored activation/runtime contract is unsupported");
    throw new Error(`Recovery blocked by unsupported activation/runtime contract: ${validation.codes.join(",")}`);
  }
  const ownership = acquireRuntimeOwnership(input.projectRoot, link.workflowSessionId, input.owner);
  recoveryInvariant(ownership.ok && ownership.owner, `Recovery refuses a live owner: ${ownership.reason}`);
  let prepared: WorkflowEventEnvelope | undefined;
  let preparedDraft: WorkflowEventDraft | undefined;
  let preparedGeneration: Readonly<{ workflowSessionId: string; linkGenerationHash: string }> | undefined;
  let created: Readonly<{ piSessionId: string; piSessionFile: string }> | undefined;
  try {
    created = await input.adapter.create({
      projectRoot: input.projectRoot,
      parentSession: link.normalParentFile,
      name: `${link.name}:recovered`,
      workflowId: link.workflowId,
      activationHash: link.activationHash,
      recovery: { workflowSessionId: link.workflowSessionId, previousPiSessionId: link.piSessionId, previousPiSessionFile: link.piSessionFile },
    });
    const preparedAt = new Date().toISOString();
    const draft = createWorkflowEvent({
      projectId: input.projectId, sessionId: link.workflowSessionId, type: "session.recovery.prepared", producer: "recovery", timestamp: preparedAt,
      payload: {
        expectedLinkHash: workflowLinkGenerationHash(link), expectedLink: link as unknown as JsonValue,
        previousPiSessionId: link.piSessionId, previousPiSessionFile: link.piSessionFile,
        piSessionId: created.piSessionId, piSessionFile: created.piSessionFile, activationHash: link.activationHash, preparedAt,
      },
    });
    preparedDraft = draft;
    prepared = appendWorkflowEventChecked(input.projectRoot, draft, (events) => {
      const unresolved = events.filter((event) => event.type === "session.recovery.prepared").some((event) => !committedFor(events, event.eventHash) && !events.some((entry) => isPublishedRecoveryRollback(entry, event.eventHash)));
      recoveryInvariant(!unresolved, "Another workflow recovery preparation is unresolved");
    });
    input.recoveryFault?.("afterPrepared");
    const preparedLink = prepareWorkflowRecoveryLink(input.projectRoot, link, { ...created, preparedAt, preparedEventHash: prepared.eventHash });
    preparedGeneration = Object.freeze({ workflowSessionId: preparedLink.workflowSessionId, linkGenerationHash: workflowLinkGenerationHash(preparedLink) });
    input.recoveryFault?.("afterLinkPrepared");
    let recovered: WorkflowSessionLink | undefined;
    const switched = await input.adapter.switch({
      piSessionFile: created.piSessionFile,
      withSession: async () => {
        recoveryInvariant(prepared, "Workflow recovery preparation was not committed before Pi session replacement");
        recovered = withRecoverySettlementLock(input.projectRoot, link.workflowSessionId, () => commitRecoverySettlement({
          projectRoot: input.projectRoot, projectId: input.projectId, prepared: prepared!, recoveredAt: new Date().toISOString(), fault: input.journalFault,
          afterCommitPublished: () => input.recoveryFault?.("afterCommitted"),
        }));
      },
      replacement: {
        projectRoot: input.projectRoot,
        projectId: input.projectId,
        piSessionId: created.piSessionId,
        restoreSession: input.restorePiSessionFile,
        generation: preparedGeneration,
      },
    });
    recoveryInvariant(!switched.cancelled, "Workflow recovery Pi session switch was cancelled");
    recoveryInvariant(recovered, "Workflow recovery settlement did not complete inside the replacement session");
    return recovered;
  } catch (error) {
    // A prepared generation is the restart-reconciliation authority when Pi's
    // active session could not be restored with proof.
    if (prepared && isUnprovenSessionRestoration(error)) throw error;
    const cleanupErrors: unknown[] = [];
    try {
      const events = readWorkflowJournal(input.projectRoot, link.workflowSessionId);
      prepared = prepared ?? (preparedDraft ? events.find((event) => event.eventId === preparedDraft!.eventId && event.type === "session.recovery.prepared") : undefined);
      if (prepared) {
        const recovered = withRecoverySettlementLock(input.projectRoot, link.workflowSessionId, () => rollbackRecoverySettlement({
          projectRoot: input.projectRoot, projectId: input.projectId, prepared: prepared!, reason: "recovery transaction rolled back",
        }));
        if (recovered) return recovered;
      }
    } catch (cleanupError) { cleanupErrors.push(new Error(`Recovery protocol rollback failed: ${boundedDiagnostic(cleanupError)}`)); }
    if (!settleRuntimeOwnershipRelease(input.projectRoot, link.workflowSessionId, ownership.owner)) cleanupErrors.push(new Error("Recovery ownership release failed"));
    if (created && input.adapter.cleanup) {
      try { await input.adapter.cleanup({ projectRoot: input.projectRoot, created }); }
      catch (cleanupError) { cleanupErrors.push(new Error(`precreated recovery Pi session cleanup failed: ${boundedDiagnostic(cleanupError)}`)); }
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "Workflow recovery failed and compensation was incomplete");
    throw error;
  }
}
