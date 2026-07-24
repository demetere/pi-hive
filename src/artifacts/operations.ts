import { createHash } from "node:crypto";
import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";
import { createWorkflowEvent, sealWorkflowEvent, type WorkflowEventEnvelope } from "../workflows/events";
import { appendWorkflowEventChecked, readWorkflowJournal } from "../workflows/journal";
import { hashAttemptInput } from "../workflows/attempts";
import { boundedId, boundedJson, boundedText, deepFreeze, plainRecord } from "../workflows/values";
import { ARTIFACT_ACTION_VERSION } from "./contracts";
import { isArtifactHash, type ArtifactWorkspaceHashesV1 } from "./hashes";
import type { ArtifactActionResultV1 } from "./types";

export const ARTIFACT_OPERATION_FORMAT_VERSION = 1 as const;
export const ARTIFACT_OPERATION_LIMITS = Object.freeze({ operations: 4_096, inputBytes: 65_536, resultBytes: 65_536, diagnosticBytes: 8_192 });

export type ArtifactOperationStatus = "pending" | "completed" | "unknown_side_effect";
export interface PersistedArtifactOperation {
  readonly operationId: string;
  readonly actionId: string;
  readonly inputHash: string;
  /** W13 enclosing tool-attempt input identity; absent only on pre-W17 journals. */
  readonly attemptInputHash?: string;
  readonly expectedWorkspaceHash: string;
  readonly status: ArtifactOperationStatus;
  readonly intentSequence: number;
  readonly intentAt: string;
  readonly result?: ArtifactActionResultV1;
  readonly resultSequence?: number;
  readonly reconciliation?: "applied" | "not-applied";
  readonly diagnostic?: string;
}
export interface ArtifactOperationState { readonly operations: Readonly<Record<string, PersistedArtifactOperation>> }
export interface ArtifactOperationRuntimeOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly now?: () => string;
  readonly fault?: (stage: "afterIntent" | "afterResult") => void;
}
export interface BeginArtifactOperationInput {
  readonly operationId: string;
  readonly actionId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly expectedWorkspaceHash: string;
}
export type BeginArtifactOperationResult =
  | Readonly<{ state: "started"; operation: PersistedArtifactOperation }>
  | Readonly<{ state: "pending"; operation: PersistedArtifactOperation }>
  | Readonly<{ state: "completed"; operation: PersistedArtifactOperation; result: ArtifactActionResultV1 }>;

function operationInputHash(input: Omit<BeginArtifactOperationInput, "operationId">): string {
  const args = boundedJson(input.arguments, "Artifact operation arguments", { bytes: ARTIFACT_OPERATION_LIMITS.inputBytes, depth: 16, nodes: 4_096, rootRecord: true });
  return createHash("sha256").update("pi-hive-artifact-operation-input-v1\0").update(canonicalJson({ actionId: input.actionId, arguments: args, expectedWorkspaceHash: input.expectedWorkspaceHash })).digest("hex");
}
function payload(event: WorkflowEventEnvelope): Record<string, unknown> | undefined {
  if (event.type !== "artifact.recorded" || !plainRecord(event.payload) || event.payload.subsystem !== "operation") return undefined;
  if (event.payload.formatVersion !== ARTIFACT_OPERATION_FORMAT_VERSION) throw new Error("Artifact operation event format is unsupported");
  return event.payload;
}
function actionResult(value: unknown, operationId: string, actionId: string): ArtifactActionResultV1 {
  boundedJson(value, "Artifact operation result", { bytes: ARTIFACT_OPERATION_LIMITS.resultBytes, depth: 16, nodes: 4_096, rootRecord: true });
  if (!plainRecord(value)) throw new Error("Artifact operation result is invalid");
  const required = ["schemaVersion", "operationId", "actionId", "status", "summary", "changed", "data", "refs"];
  const allowed = new Set([...required, "workspaceHash"]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key)) || value.schemaVersion !== ARTIFACT_ACTION_VERSION
    || value.operationId !== operationId || value.actionId !== actionId || (value.status !== "completed" && value.status !== "blocked")
    || typeof value.changed !== "boolean" || !plainRecord(value.data) || !Array.isArray(value.refs)
    || (value.workspaceHash !== undefined && !isArtifactHash(value.workspaceHash))) throw new Error("Artifact operation result identity or shape is invalid");
  boundedText(value.summary, "Artifact operation result summary", 8_192);
  return deepFreeze(structuredClone(value)) as unknown as ArtifactActionResultV1;
}
export function createEmptyArtifactOperationState(): ArtifactOperationState { return Object.freeze({ operations: Object.freeze({}) }); }
export function reduceArtifactOperationState(state: ArtifactOperationState, event: WorkflowEventEnvelope): ArtifactOperationState {
  const data = payload(event);
  if (!data) return state;
  if (event.producer !== "harness" && event.producer !== "recovery") throw new Error("Artifact operation event lacks trusted authority");
  const operationId = boundedId(String(data.operationId ?? ""), "Artifact operation ID");
  const operation = data.operation;
  if (operation === "intent") {
    if (event.producer !== "harness" || state.operations[operationId] || Object.keys(state.operations).length >= ARTIFACT_OPERATION_LIMITS.operations) throw new Error("Artifact operation intent is duplicated or exceeds its bound");
    const actionId = boundedId(String(data.actionId ?? ""), "Artifact action ID");
    if (typeof data.inputHash !== "string" || !/^[0-9a-f]{64}$/u.test(data.inputHash)
      || (data.attemptInputHash !== undefined && (typeof data.attemptInputHash !== "string" || !/^[0-9a-f]{64}$/u.test(data.attemptInputHash)))
      || !isArtifactHash(data.expectedWorkspaceHash)) throw new Error("Artifact operation intent hashes are invalid");
    const record: PersistedArtifactOperation = Object.freeze({
      operationId, actionId, inputHash: data.inputHash, ...(typeof data.attemptInputHash === "string" ? { attemptInputHash: data.attemptInputHash } : {}), expectedWorkspaceHash: data.expectedWorkspaceHash,
      status: "pending", intentSequence: event.sequence, intentAt: event.timestamp,
    });
    return deepFreeze({ operations: { ...state.operations, [operationId]: record } });
  }
  const existing = state.operations[operationId];
  if (!existing) throw new Error("Artifact operation result has no matching intent");
  if (operation === "result") {
    if (event.producer !== "harness" && event.producer !== "recovery") throw new Error("Artifact operation result lacks authority");
    if (existing.result) throw new Error("Artifact operation result is duplicated");
    const result = actionResult(data.result, operationId, existing.actionId);
    const reconciliation = data.reconciliation;
    if (reconciliation !== undefined && reconciliation !== "applied" && reconciliation !== "not-applied") throw new Error("Artifact operation reconciliation state is invalid");
    return deepFreeze({ operations: { ...state.operations, [operationId]: { ...existing, status: "completed", result, resultSequence: event.sequence, ...(reconciliation ? { reconciliation } : {}), diagnostic: undefined } } });
  }
  if (operation === "unknown") {
    if (event.producer !== "recovery" || existing.result) throw new Error("Artifact unknown-side-effect transition is invalid");
    const diagnostic = boundedText(data.diagnostic, "Artifact operation unknown-side-effect diagnostic", ARTIFACT_OPERATION_LIMITS.diagnosticBytes);
    if (existing.status === "unknown_side_effect" && existing.diagnostic === diagnostic) return state;
    return deepFreeze({ operations: { ...state.operations, [operationId]: { ...existing, status: "unknown_side_effect", diagnostic } } });
  }
  throw new Error("Artifact operation event is unsupported");
}

export class ArtifactOperationRuntime {
  readonly options: ArtifactOperationRuntimeOptions;
  constructor(options: ArtifactOperationRuntimeOptions) { this.options = options; }
  restore(): ArtifactOperationState {
    return readWorkflowJournal(this.options.projectRoot, this.options.sessionId)
      .filter((event) => event.runId === this.options.runId)
      .reduce(reduceArtifactOperationState, createEmptyArtifactOperationState());
  }
  private append(operation: "intent" | "result" | "unknown", data: Record<string, JsonValue>, producer: "harness" | "recovery"): WorkflowEventEnvelope {
    const draft = createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId,
      type: "artifact.recorded", producer, timestamp: this.options.now?.() ?? new Date().toISOString(),
      payload: { formatVersion: ARTIFACT_OPERATION_FORMAT_VERSION, subsystem: "operation", operation, ...data },
      ...(typeof data.operationId === "string" ? { attemptId: data.operationId } : {}),
    });
    return appendWorkflowEventChecked(this.options.projectRoot, draft, (events) => {
      const relevant = events.filter((event) => event.runId === this.options.runId);
      const state = relevant.reduce(reduceArtifactOperationState, createEmptyArtifactOperationState());
      const previous = events.at(-1);
      reduceArtifactOperationState(state, sealWorkflowEvent(draft, (previous?.sequence ?? 0) + 1, previous?.eventHash ?? null));
    });
  }
  begin(input: BeginArtifactOperationInput): BeginArtifactOperationResult {
    const operationId = boundedId(input.operationId, "Artifact operation ID");
    const actionId = boundedId(input.actionId, "Artifact action ID");
    if (!isArtifactHash(input.expectedWorkspaceHash)) throw new Error("Artifact operation expected workspace hash is invalid");
    const normalizedInput = { actionId, arguments: input.arguments, expectedWorkspaceHash: input.expectedWorkspaceHash };
    const inputHash = operationInputHash(normalizedInput);
    const attemptInputHash = hashAttemptInput(normalizedInput);
    const existing = this.restore().operations[operationId];
    if (existing) {
      if (existing.actionId !== actionId || existing.inputHash !== inputHash || existing.expectedWorkspaceHash !== input.expectedWorkspaceHash
        || (existing.attemptInputHash !== undefined && existing.attemptInputHash !== attemptInputHash)) throw new Error("Artifact operation ID reuse with different arguments or expected hash is rejected");
      if (existing.result) return Object.freeze({ state: "completed", operation: existing, result: existing.result });
      return Object.freeze({ state: "pending", operation: existing });
    }
    this.append("intent", { operationId, actionId, inputHash, attemptInputHash, expectedWorkspaceHash: input.expectedWorkspaceHash }, "harness");
    this.options.fault?.("afterIntent");
    return Object.freeze({ state: "started", operation: this.restore().operations[operationId] });
  }
  complete(operationId: string, result: ArtifactActionResultV1, reconciliation?: "applied" | "not-applied"): ArtifactActionResultV1 {
    const existing = this.restore().operations[operationId];
    if (!existing) throw new Error("Artifact operation completion has no intent");
    const parsed = actionResult(result, operationId, existing.actionId);
    if (existing.result) {
      if (canonicalJson(existing.result) !== canonicalJson(parsed)) throw new Error("Artifact operation completion conflicts with its recorded result");
      return existing.result;
    }
    this.append("result", { operationId, result: parsed as unknown as JsonValue, ...(reconciliation ? { reconciliation } : {}) }, reconciliation ? "recovery" : "harness");
    this.options.fault?.("afterResult");
    return this.restore().operations[operationId].result!;
  }
  markUnknown(operationId: string, diagnostic: string): void {
    const existing = this.restore().operations[operationId];
    if (!existing || existing.result) throw new Error("Artifact unknown-side-effect state requires unresolved intent");
    const bounded = boundedText(diagnostic, "Artifact operation unknown-side-effect diagnostic", ARTIFACT_OPERATION_LIMITS.diagnosticBytes);
    if (existing.status === "unknown_side_effect" && existing.diagnostic === bounded) return;
    this.append("unknown", { operationId, diagnostic: bounded }, "recovery");
  }
}

export type ArtifactOperationRecoveryResult =
  | Readonly<{ state: "completed" | "not-applied"; result: ArtifactActionResultV1 }>
  | Readonly<{ state: "unknown"; diagnostic: string }>;
export type ArtifactAppliedOperationReconciler = (
  operation: PersistedArtifactOperation,
  hashes: ArtifactWorkspaceHashesV1,
) => ArtifactActionResultV1 | undefined;

export function recoverArtifactOperation(
  runtime: ArtifactOperationRuntime,
  operationId: string,
  current: ArtifactWorkspaceHashesV1,
  reconcileApplied: ArtifactAppliedOperationReconciler,
  _options: Readonly<{
    /** Fault-test seam. Recovery deliberately never invokes it. */
    redispatch?: () => unknown;
  }> = {},
): ArtifactOperationRecoveryResult {
  const operation = runtime.restore().operations[operationId];
  if (!operation) throw new Error("Artifact operation recovery intent is missing");
  if (operation.result) return Object.freeze({ state: "completed", result: operation.result });
  if (current.workspaceHash === operation.expectedWorkspaceHash) {
    const result: ArtifactActionResultV1 = Object.freeze({
      schemaVersion: ARTIFACT_ACTION_VERSION, operationId, actionId: operation.actionId, status: "blocked",
      summary: "Interrupted artifact mutation was proven not applied.", changed: false, workspaceHash: current.workspaceHash,
      data: Object.freeze({ reconciliation: "not-applied" }), refs: Object.freeze([]),
    });
    return Object.freeze({ state: "not-applied", result: runtime.complete(operationId, result, "not-applied") });
  }
  const applied = reconcileApplied(operation, current);
  if (applied) return Object.freeze({ state: "completed", result: runtime.complete(operationId, applied, "applied") });
  const diagnostic = "Artifact mutation outcome is indeterminate: current hash differs from intent and no adapter proof matches the committed result";
  runtime.markUnknown(operationId, diagnostic);
  return Object.freeze({ state: "unknown", diagnostic });
}
