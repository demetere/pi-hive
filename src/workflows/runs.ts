import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";
import { createWorkflowEvent, type WorkflowEventEnvelope, type WorkflowEventType } from "./events";
import { appendWorkflowEventChecked, readWorkflowJournal, workflowJournalIdentity, type JournalFaultStage } from "./journal";
import { heartbeatCurrentRuntimeOwnership } from "./ownership";
import { replayWorkflowJournal } from "./replay";

export const RUN_LIFECYCLE_FORMAT_VERSION = 1 as const;
export const CANCELLATION_TIMING = Object.freeze({ settleGraceMs: 2_000, killSettleMs: 1_000, coordinatorStepMs: 2_000 });
export const RUN_LIFECYCLE_LIMITS = Object.freeze({
  inputBytes: 131_072,
  summaryBytes: 8_192,
  requestIdBytes: 256,
  referenceItems: 128,
  referenceFieldBytes: 2_048,
  dataBytes: 65_536,
  dataDepth: 16,
  dataNodes: 4_096,
  renderedTerminalBytes: 131_072,
});

export type OpenRunStatus = "running" | "waiting_for_human" | "paused";
export type TerminalRunStatus = "completed" | "blocked" | "failed" | "cancelled";
export type FinishableRunStatus = Exclude<TerminalRunStatus, "cancelled">;
export type RunStatus = OpenRunStatus | TerminalRunStatus;
export type RunInputKind = "initial" | "steering" | "handoff";

const OPEN_RUN_STATUSES = new Set<RunStatus>(["running", "waiting_for_human", "paused"]);
const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["completed", "blocked", "failed", "cancelled"]);

export interface RunInputRecord {
  readonly sequence: number;
  readonly inputId: string;
  readonly kind: RunInputKind;
  readonly text: string;
  readonly source: "interactive" | "rpc" | "extension" | "handoff";
  readonly receivedAt: string;
}

export interface PendingInputDelivery {
  readonly requestId: string;
  readonly throughSequence: number;
  readonly preparedAt: string;
}

export interface ArtifactReference {
  readonly workspaceId: string;
  readonly checkpoint: string;
  readonly digest: string;
}

export interface EvidenceReference {
  readonly kind: string;
  readonly toolCallId?: string;
  readonly claim: string;
}

export interface FileChangeRecord {
  readonly path: string;
  readonly operation: "create" | "update" | "delete";
  readonly beforeHash?: string;
  readonly afterHash?: string;
  readonly attribution: "recorded" | "reconciled" | "unknown";
}

export interface PersistedTerminalEnvelope {
  readonly status: TerminalRunStatus;
  readonly summary: string;
  readonly fileChanges: readonly FileChangeRecord[];
  readonly changeCoverage: string;
  readonly artifactRefs: readonly ArtifactReference[];
  readonly evidenceRefs: readonly EvidenceReference[];
  readonly data: Readonly<Record<string, JsonValue>>;
  readonly unsatisfiedGates: readonly string[];
  readonly closedQuestionIds: readonly string[];
  readonly partialState: Readonly<Record<string, JsonValue>>;
  readonly finishedByNodeId: string;
  readonly finishedAt: string;
  readonly snapshotId: string;
  readonly runId: string;
  readonly terminalEventHash: string;
}

export interface PendingTerminalSettlement extends Omit<PersistedTerminalEnvelope, "terminalEventHash"> {
  readonly operationId: string;
}

export interface WorkflowRunRecord {
  readonly runId: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly inputs: readonly RunInputRecord[];
  readonly deliveredThrough: number;
  readonly pendingDelivery?: PendingInputDelivery;
  readonly cancellationRequested: boolean;
  readonly cancellationReason?: string;
  readonly cancellationSettlementFailure?: string;
  readonly pauseState?: Readonly<Record<string, JsonValue>>;
  readonly resumeStatus?: Exclude<OpenRunStatus, "paused">;
  readonly pauseReleasePending?: boolean;
  readonly pendingTerminal?: PendingTerminalSettlement;
  readonly terminal?: PersistedTerminalEnvelope;
}

export interface RunLifecycleState {
  readonly sessionId: string;
  readonly latestRun?: WorkflowRunRecord;
  readonly inputAssignments?: Readonly<Record<string, Readonly<{ runId: string; input: RunInputRecord }>>>;
}

export type CompletionGateState = "satisfied" | "unsatisfied" | "not-present";
export interface CompletionGateResult {
  readonly state: CompletionGateState;
  readonly issues?: readonly string[];
  readonly pendingQuestionIds?: readonly string[];
}
export interface ProjectStateResult extends CompletionGateResult {
  readonly fileChanges?: readonly FileChangeRecord[];
  readonly changeCoverage?: string;
  readonly partialState?: Readonly<Record<string, JsonValue>>;
}
export interface TerminalSettlementRequest {
  readonly operationId: string;
  readonly runId: string;
  readonly status: FinishableRunStatus;
  readonly closedQuestionIds: readonly string[];
  readonly unsatisfiedGates: readonly string[];
  readonly releaseLease: true;
}

export interface CompletionValidationHooks {
  readonly descendants?: () => CompletionGateResult | Promise<CompletionGateResult>;
  readonly questions?: () => CompletionGateResult | Promise<CompletionGateResult>;
  readonly adapter?: () => CompletionGateResult | Promise<CompletionGateResult>;
  readonly approvals?: () => CompletionGateResult | Promise<CompletionGateResult>;
  readonly evidence?: (references: readonly EvidenceReference[]) => CompletionGateResult | Promise<CompletionGateResult>;
  readonly artifacts?: (references: readonly ArtifactReference[]) => CompletionGateResult | Promise<CompletionGateResult>;
  readonly projectState?: () => ProjectStateResult | Promise<ProjectStateResult>;
  readonly lease?: () => CompletionGateResult | Promise<CompletionGateResult>;
  /** Idempotently applies terminal question/gate closure and releases any owned lease. */
  readonly settleTerminal?: (settlement: TerminalSettlementRequest) => void | Promise<void>;
}

export interface WorkflowRunLifecycleOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly snapshotId: string;
  readonly rootNodeId: string;
  /** Capability proving this process currently owns the workflow session. */
  readonly runtimeOwnerNonce?: string;
  readonly createRunId?: () => string;
  readonly now?: () => string;
  readonly completion?: CompletionValidationHooks;
  /** Fault-injection seam used to verify durable journal publication recovery. */
  readonly journalFault?: (eventType: WorkflowEventType, stage: JournalFaultStage) => void;
}

export interface FinishRequest {
  readonly status: FinishableRunStatus;
  readonly summary: string;
  readonly artifactRefs?: readonly ArtifactReference[];
  readonly evidenceRefs?: readonly EvidenceReference[];
  readonly data?: Readonly<Record<string, JsonValue>>;
}

export interface FinishCallContext {
  readonly callerNodeId: string;
  readonly toolBatch: readonly string[];
}

export type FinishResult =
  | Readonly<{ ok: false; issues: readonly string[] }>
  | Readonly<{ ok: true; envelope: PersistedTerminalEnvelope; rendered: string }>;

export interface CancellationCoordinator {
  readonly rejectNewWork?: () => void | Promise<void>;
  readonly cancelQueuedWork?: () => void | Promise<void>;
  readonly abortOwnedWork?: () => void | Promise<void>;
  readonly waitForSettlement?: (timeoutMs: number) => boolean | Promise<boolean>;
  readonly terminateProcessTrees?: () => void | Promise<void>;
  readonly capturePartialState?: () => Readonly<Record<string, JsonValue>> | Promise<Readonly<Record<string, JsonValue>>>;
  readonly releaseLeases?: () => void | Promise<void>;
}

export interface CancellationResult {
  readonly envelope: PersistedTerminalEnvelope;
  readonly rendered: string;
}

export interface PauseCoordinator {
  readonly suspendOwnedWork?: () => void | Promise<void>;
  readonly captureState?: () => Readonly<Record<string, JsonValue>> | Promise<Readonly<Record<string, JsonValue>>>;
  /** Release actions must be idempotent because a crash can occur between release and confirmation. */
  readonly releaseLeases?: () => void | Promise<void>;
  readonly releaseOwnership?: () => void | Promise<void>;
}
export interface ResumeCoordinator {
  readonly acquireOwnership: () => void | Promise<void>;
  readonly acquireLeases: () => void | Promise<void>;
  readonly revalidateHashes: (pauseState: Readonly<Record<string, JsonValue>>) => boolean | Promise<boolean>;
  /** Must idempotently release every authority acquired by this resume attempt. */
  readonly rollbackAuthority: () => void | Promise<void>;
}

export interface RecordRunInput {
  readonly inputId: string;
  readonly text: string;
  readonly source: RunInputRecord["source"];
}

export interface RecordRunInputResult {
  readonly runId: string;
  readonly input: RunInputRecord;
  readonly created: boolean;
  readonly duplicate: boolean;
}

export function createEmptyRunLifecycleState(sessionId: string): RunLifecycleState {
  if (!sessionId) throw new Error("Run lifecycle session ID is required");
  return Object.freeze({ sessionId });
}

export function isOpenRunStatus(status: RunStatus): status is OpenRunStatus {
  return OPEN_RUN_STATUSES.has(status);
}

function recordPayload(payload: JsonValue): Record<string, JsonValue> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Run event payload is invalid");
  return payload as Record<string, JsonValue>;
}

function statusValue(value: JsonValue | undefined): RunStatus {
  if (typeof value !== "string" || (!OPEN_RUN_STATUSES.has(value as RunStatus) && !TERMINAL_RUN_STATUSES.has(value as RunStatus))) {
    throw new Error("Run status is invalid");
  }
  return value as RunStatus;
}

function requireCurrentRun(state: RunLifecycleState, event: WorkflowEventEnvelope): WorkflowRunRecord {
  const run = state.latestRun;
  if (!run || !event.runId || event.runId !== run.runId) throw new Error("Run event does not target the current run");
  return run;
}

function freezeInput(input: RunInputRecord): RunInputRecord {
  return Object.freeze({ ...input });
}

function freezeRun(state: RunLifecycleState, run: WorkflowRunRecord, assignment?: { inputId: string; runId: string; input: RunInputRecord }): RunLifecycleState {
  const latestRun = Object.freeze({ ...run, inputs: Object.freeze(run.inputs.map(freezeInput)) });
  const inputAssignments = assignment
    ? Object.freeze({ ...(state.inputAssignments ?? {}), [assignment.inputId]: Object.freeze({ runId: assignment.runId, input: freezeInput(assignment.input) }) })
    : state.inputAssignments;
  return Object.freeze({ ...state, latestRun, ...(inputAssignments ? { inputAssignments } : {}) });
}

function requiredString(payload: Record<string, JsonValue>, key: string, maxBytes = 256): string {
  const value = payload[key];
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`Run event ${key} is invalid`);
  return value;
}

function parseInput(value: JsonValue | undefined, expectedKind?: RunInputKind): RunInputRecord {
  const input = recordPayload(value as JsonValue);
  const sequence = input.sequence;
  const kind = input.kind;
  const source = input.source;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) throw new Error("Run input sequence is invalid");
  if (kind !== "initial" && kind !== "steering" && kind !== "handoff") throw new Error("Run input kind is invalid");
  if (expectedKind && kind !== expectedKind) throw new Error("Run input kind does not match event");
  if (source !== "interactive" && source !== "rpc" && source !== "extension" && source !== "handoff") throw new Error("Run input source is invalid");
  return freezeInput({
    sequence: sequence as number,
    inputId: requiredString(input, "inputId"),
    kind,
    text: requiredString(input, "text", RUN_LIFECYCLE_LIMITS.inputBytes),
    source,
    receivedAt: requiredString(input, "receivedAt"),
  });
}

export function reduceRunLifecycle(state: RunLifecycleState, event: WorkflowEventEnvelope): RunLifecycleState {
  if (event.sessionId !== state.sessionId) throw new Error("Run event session identity mismatch");
  const requiredProducer = event.type === "run.cancel.requested" || event.type === "run.cancel.settlement.failed" || event.type === "run.terminal.prepared" || event.type === "terminal.recorded"
    ? "harness"
    : event.type.startsWith("run.")
      ? "runtime"
      : undefined;
  if (requiredProducer && event.producer !== requiredProducer) throw new Error(`Run event producer lacks ${requiredProducer} authority`);
  const payload = recordPayload(event.payload);

  if (event.type === "run.started") {
    if (!event.runId) throw new Error("Run start is missing a run ID");
    if (state.latestRun && isOpenRunStatus(state.latestRun.status)) throw new Error("Workflow session already has an open run");
    const input = parseInput(payload.input, "initial");
    if (input.sequence !== 1 || state.inputAssignments?.[input.inputId]) throw new Error("Run initial input is invalid or duplicated");
    const run: WorkflowRunRecord = {
      runId: event.runId,
      status: "running",
      startedAt: event.timestamp,
      inputs: [input],
      deliveredThrough: 0,
      cancellationRequested: false,
    };
    return freezeRun(state, run, { inputId: input.inputId, runId: event.runId, input });
  }

  if (event.type === "run.input.recorded") {
    const run = requireCurrentRun(state, event);
    if (!isOpenRunStatus(run.status) || run.cancellationRequested || run.pendingTerminal) throw new Error("Run does not accept new input");
    const input = parseInput(payload.input, "steering");
    if (input.sequence !== run.inputs.length + 1 || state.inputAssignments?.[input.inputId]) throw new Error("Run input sequence is invalid or duplicated");
    return freezeRun(state, { ...run, inputs: [...run.inputs, input] }, { inputId: input.inputId, runId: run.runId, input });
  }

  if (event.type === "run.input.delivery.prepared") {
    const run = requireCurrentRun(state, event);
    if (!isOpenRunStatus(run.status) || run.cancellationRequested || run.pendingTerminal) throw new Error("Cannot prepare input delivery for a terminal, cancelling, or finalizing run");
    if (run.pendingDelivery) throw new Error("An input delivery is already prepared");
    const requestId = requiredString(payload, "requestId", RUN_LIFECYCLE_LIMITS.requestIdBytes);
    const throughSequence = payload.throughSequence;
    if (!Number.isSafeInteger(throughSequence) || (throughSequence as number) <= run.deliveredThrough || (throughSequence as number) > run.inputs.length) throw new Error("Prepared input delivery range is invalid");
    return freezeRun(state, { ...run, pendingDelivery: Object.freeze({ requestId, throughSequence: throughSequence as number, preparedAt: event.timestamp }) });
  }

  if (event.type === "run.input.delivered") {
    const run = requireCurrentRun(state, event);
    if (!isOpenRunStatus(run.status) || run.cancellationRequested || run.pendingTerminal) throw new Error("Cannot deliver input to a terminal, cancelling, or finalizing run");
    const requestId = requiredString(payload, "requestId", RUN_LIFECYCLE_LIMITS.requestIdBytes);
    if (!run.pendingDelivery || run.pendingDelivery.requestId !== requestId) throw new Error("Input delivery request does not match preparation");
    return freezeRun(state, { ...run, deliveredThrough: run.pendingDelivery.throughSequence, pendingDelivery: undefined });
  }

  if (event.type === "run.cancel.requested") {
    const run = requireCurrentRun(state, event);
    if (!isOpenRunStatus(run.status)) throw new Error("Terminal run state is immutable");
    if (run.pendingTerminal) throw new Error("Run terminal settlement is already prepared");
    if (run.cancellationRequested) throw new Error("Run cancellation was already requested");
    const reason = requiredString(payload, "reason", RUN_LIFECYCLE_LIMITS.summaryBytes);
    return freezeRun(state, { ...run, cancellationRequested: true, cancellationReason: reason });
  }

  if (event.type === "run.cancel.settlement.failed") {
    const run = requireCurrentRun(state, event);
    if (!isOpenRunStatus(run.status) || !run.cancellationRequested) throw new Error("Cancellation settlement failure requires a cancelling open run");
    const diagnostic = requiredString(payload, "diagnostic", RUN_LIFECYCLE_LIMITS.summaryBytes);
    return freezeRun(state, { ...run, cancellationSettlementFailure: diagnostic });
  }

  if (event.type === "run.pause.release.confirmed") {
    const run = requireCurrentRun(state, event);
    if (run.status !== "paused" || run.pauseReleasePending !== true) throw new Error("Pause authority release confirmation does not match a pending paused run");
    return freezeRun(state, { ...run, pauseReleasePending: false });
  }

  if (event.type === "run.terminal.prepared") {
    const run = requireCurrentRun(state, event);
    if (!isOpenRunStatus(run.status) || run.cancellationRequested || run.pendingTerminal) throw new Error("Run cannot prepare terminal settlement");
    if (run.pendingDelivery || run.deliveredThrough !== run.inputs.length) throw new Error("Terminal settlement requires every input to be delivered");
    const operationId = requiredString(payload, "operationId", RUN_LIFECYCLE_LIMITS.requestIdBytes);
    const terminal = validateTerminalPayload(payload.terminal, { runId: run.runId, timestamp: event.timestamp });
    if (terminal.status === "cancelled") throw new Error("Cancelled terminal outcomes do not use root settlement");
    return freezeRun(state, { ...run, pendingTerminal: Object.freeze({ ...terminal, operationId }) });
  }

  if (event.type === "run.transition") {
    const run = requireCurrentRun(state, event);
    if (!isOpenRunStatus(run.status) || run.cancellationRequested || run.pendingTerminal) throw new Error("Terminal, cancelling, or finalizing run state is immutable");
    const from = statusValue(payload.from);
    const to = statusValue(payload.to);
    if (from !== run.status || !isOpenRunStatus(from) || !isOpenRunStatus(to) || from === to) {
      throw new Error(`Invalid run transition: ${String(from)} -> ${String(to)}`);
    }
    if (to === "paused") {
      if (from === "paused") throw new Error(`Invalid run transition: ${String(from)} -> ${String(to)}`);
      const resumeStatus = statusValue(payload.resumeStatus);
      if (resumeStatus !== from) throw new Error("Paused run resume status is invalid");
      const pauseState = Object.freeze({ ...recordPayload(payload.pauseState ?? {}) });
      return freezeRun(state, { ...run, status: to, pauseState, resumeStatus, pauseReleasePending: true });
    }
    if (from === "paused" && run.pauseReleasePending !== false) throw new Error("Run cannot resume until paused authority release is confirmed");
    if (from === "paused" && to !== run.resumeStatus) throw new Error("Run must resume to its recorded prior status");
    return freezeRun(state, { ...run, status: to, ...(from === "paused" ? { resumeStatus: undefined, pauseReleasePending: undefined } : {}) });
  }

  if (event.type === "terminal.recorded") {
    const run = requireCurrentRun(state, event);
    if (!isOpenRunStatus(run.status)) throw new Error("Terminal run state is immutable");
    const terminal = terminalEnvelopeFromEvent(event);
    if (terminal.status !== "cancelled" && (run.pendingDelivery || run.deliveredThrough !== run.inputs.length)) throw new Error("Terminal outcome requires every input to be delivered");
    if (terminal.runId !== run.runId) throw new Error("Terminal envelope run identity mismatch");
    if (terminal.status === "cancelled" && !run.cancellationRequested) throw new Error("Cancelled terminal requires a cancellation request");
    if (terminal.status !== "cancelled" && run.cancellationRequested) throw new Error("Cancellation in progress blocks a non-cancelled terminal outcome");
    if (terminal.status !== "cancelled") {
      if (!run.pendingTerminal) throw new Error("Non-cancelled terminal outcome requires durable settlement preparation");
      const { operationId: _operationId, ...prepared } = run.pendingTerminal;
      const { terminalEventHash: _terminalEventHash, ...terminalPayload } = terminal;
      if (canonicalJson(prepared) !== canonicalJson(terminalPayload)) throw new Error("Terminal outcome does not match its settlement preparation");
    }
    return freezeRun(state, { ...run, status: terminal.status, pendingDelivery: undefined, pendingTerminal: undefined, terminal });
  }

  return state;
}

export function terminalEnvelopeFromEvent(event: WorkflowEventEnvelope): PersistedTerminalEnvelope {
  if (event.type !== "terminal.recorded" || !event.runId) throw new Error("Event is not a terminal workflow event");
  const terminal = validateTerminalPayload(event.payload, { runId: event.runId, timestamp: event.timestamp });
  return Object.freeze({ ...terminal, terminalEventHash: event.eventHash });
}

function asJson(value: unknown): JsonValue {
  return structuredClone(value) as JsonValue;
}

function validateInput(input: RecordRunInput): void {
  if (!input.inputId || Buffer.byteLength(input.inputId, "utf8") > 256) throw new Error("Run input ID is invalid");
  if (!input.text || Buffer.byteLength(input.text, "utf8") > RUN_LIFECYCLE_LIMITS.inputBytes) throw new Error("Run input text is empty or too large");
  if (input.source !== "interactive" && input.source !== "rpc" && input.source !== "extension" && input.source !== "handoff") throw new Error("Run input source is invalid");
}

function duplicateInputResult(input: RecordRunInput, assigned: Readonly<{ runId: string; input: RunInputRecord }>): RecordRunInputResult {
  if (assigned.input.text !== input.text || assigned.input.source !== input.source) {
    throw new Error("Run input identity was reused with a different payload or source");
  }
  return Object.freeze({ runId: assigned.runId, input: assigned.input, created: false, duplicate: true });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${label} contains unsupported field: ${extra[0]}`);
}

function boundedField(value: unknown, label: string, maxBytes: number = RUN_LIFECYCLE_LIMITS.referenceFieldBytes, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} is invalid`);
  return value;
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CHANGE_COVERAGE = new Set(["recorded", "git-reconciled", "scoped-reconciled", "partial"]);

function digestField(value: unknown, label: string): string {
  const digest = boundedField(value, label)!;
  if (!SHA256_DIGEST.test(digest)) throw new Error(`${label} digest is invalid`);
  return digest;
}

function projectRelativePath(value: unknown, label: string): string {
  const path = boundedField(value, label)!;
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:\//u.test(path) || path === "." || posix.normalize(path) !== path || path.split("/").includes("..")) {
    throw new Error(`${label} must be a normalized project-relative path`);
  }
  return path;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return value.slice(0, end);
}

function validateJsonData(value: unknown): Readonly<Record<string, JsonValue>> {
  if (!isPlainRecord(value)) throw new Error("workflow_finish data must be a plain JSON object");
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > RUN_LIFECYCLE_LIMITS.dataNodes || depth > RUN_LIFECYCLE_LIMITS.dataDepth) throw new Error("workflow_finish data exceeds structural limits");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") { if (!Number.isFinite(item)) throw new Error("workflow_finish data contains a non-finite number"); return; }
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    if (!isPlainRecord(item)) throw new Error("workflow_finish data contains a non-JSON value");
    for (const [key, child] of Object.entries(item)) {
      if (Buffer.byteLength(key, "utf8") > RUN_LIFECYCLE_LIMITS.referenceFieldBytes) throw new Error("workflow_finish data key is too large");
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  const cloned = structuredClone(value) as Record<string, JsonValue>;
  if (Buffer.byteLength(canonicalJson(cloned), "utf8") > RUN_LIFECYCLE_LIMITS.dataBytes) throw new Error("workflow_finish data exceeds its byte limit");
  return Object.freeze(cloned);
}

function terminalStringArray(value: unknown, label: string, itemBytes: number): readonly string[] {
  if (!Array.isArray(value) || value.length > RUN_LIFECYCLE_LIMITS.referenceItems) throw new Error(`Terminal ${label} is invalid`);
  return Object.freeze(value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || Buffer.byteLength(entry, "utf8") > itemBytes) throw new Error(`Terminal ${label} is invalid`);
    return entry;
  }));
}

type TerminalPayload = Omit<PersistedTerminalEnvelope, "terminalEventHash">;

function validateTerminalPayload(value: unknown, authority?: Readonly<{ runId: string; timestamp: string }>): TerminalPayload {
  if (!isPlainRecord(value)) throw new Error("Terminal envelope is invalid");
  exactKeys(value, ["formatVersion", "status", "summary", "fileChanges", "changeCoverage", "artifactRefs", "evidenceRefs", "data", "unsatisfiedGates", "closedQuestionIds", "partialState", "finishedByNodeId", "finishedAt", "snapshotId", "runId"], "Terminal envelope");
  if (value.formatVersion !== RUN_LIFECYCLE_FORMAT_VERSION) throw new Error("Terminal envelope format version is invalid");
  if (value.status !== "completed" && value.status !== "blocked" && value.status !== "failed" && value.status !== "cancelled") throw new Error("Terminal status is invalid");
  const summary = boundedField(value.summary, "Terminal summary", RUN_LIFECYCLE_LIMITS.summaryBytes)!;
  if (Buffer.byteLength(summary, "utf8") > RUN_LIFECYCLE_LIMITS.summaryBytes) throw new Error("Terminal summary is too large");
  if (!Array.isArray(value.fileChanges) || value.fileChanges.length > 4_096) throw new Error("Terminal file changes are invalid");
  const seenPaths = new Set<string>();
  const fileChanges = Object.freeze(value.fileChanges.map((entry, index): FileChangeRecord => {
    if (!isPlainRecord(entry)) throw new Error(`Terminal fileChanges[${index}] is invalid`);
    exactKeys(entry, ["path", "operation", "beforeHash", "afterHash", "attribution"], `Terminal fileChanges[${index}]`);
    if (entry.operation !== "create" && entry.operation !== "update" && entry.operation !== "delete") throw new Error(`Terminal fileChanges[${index}] operation is invalid`);
    if (entry.attribution !== "recorded" && entry.attribution !== "reconciled" && entry.attribution !== "unknown") throw new Error(`Terminal fileChanges[${index}] attribution is invalid`);
    const path = projectRelativePath(entry.path, `Terminal fileChanges[${index}].path`);
    if (seenPaths.has(path)) throw new Error(`Terminal fileChanges[${index}].path is duplicated`);
    seenPaths.add(path);
    const beforeHash = entry.beforeHash === undefined ? undefined : digestField(entry.beforeHash, `Terminal fileChanges[${index}].beforeHash`);
    const afterHash = entry.afterHash === undefined ? undefined : digestField(entry.afterHash, `Terminal fileChanges[${index}].afterHash`);
    if (entry.operation === "create" && (beforeHash !== undefined || afterHash === undefined)) throw new Error(`Terminal fileChanges[${index}] create requires only afterHash`);
    if (entry.operation === "update" && (beforeHash === undefined || afterHash === undefined)) throw new Error(`Terminal fileChanges[${index}] update requires beforeHash and afterHash`);
    if (entry.operation === "delete" && (beforeHash === undefined || afterHash !== undefined)) throw new Error(`Terminal fileChanges[${index}] delete requires only beforeHash`);
    return Object.freeze({ path, operation: entry.operation, ...(beforeHash === undefined ? {} : { beforeHash }), ...(afterHash === undefined ? {} : { afterHash }), attribution: entry.attribution });
  }));
  const parseArtifacts = (raw: unknown): readonly ArtifactReference[] => {
    if (!Array.isArray(raw) || raw.length > RUN_LIFECYCLE_LIMITS.referenceItems) throw new Error("Terminal artifact references are invalid");
    return Object.freeze(raw.map((entry, index) => {
      if (!isPlainRecord(entry)) throw new Error(`Terminal artifactRefs[${index}] is invalid`);
      exactKeys(entry, ["workspaceId", "checkpoint", "digest"], `Terminal artifactRefs[${index}]`);
      return Object.freeze({ workspaceId: boundedField(entry.workspaceId, `Terminal artifactRefs[${index}].workspaceId`)!, checkpoint: boundedField(entry.checkpoint, `Terminal artifactRefs[${index}].checkpoint`)!, digest: digestField(entry.digest, `Terminal artifactRefs[${index}].digest`) });
    }));
  };
  const parseEvidence = (raw: unknown): readonly EvidenceReference[] => {
    if (!Array.isArray(raw) || raw.length > RUN_LIFECYCLE_LIMITS.referenceItems) throw new Error("Terminal evidence references are invalid");
    return Object.freeze(raw.map((entry, index) => {
      if (!isPlainRecord(entry)) throw new Error(`Terminal evidenceRefs[${index}] is invalid`);
      exactKeys(entry, ["kind", "toolCallId", "claim"], `Terminal evidenceRefs[${index}]`);
      return Object.freeze({ kind: boundedField(entry.kind, `Terminal evidenceRefs[${index}].kind`)!, ...(entry.toolCallId === undefined ? {} : { toolCallId: boundedField(entry.toolCallId, `Terminal evidenceRefs[${index}].toolCallId`)! }), claim: boundedField(entry.claim, `Terminal evidenceRefs[${index}].claim`)! });
    }));
  };
  const finishedAt = boundedField(value.finishedAt, "Terminal finishedAt")!;
  if (!Number.isFinite(Date.parse(finishedAt))) throw new Error("Terminal finishedAt is invalid");
  const result: TerminalPayload = Object.freeze({
    status: value.status,
    summary,
    fileChanges,
    changeCoverage: (() => {
      const coverage = boundedField(value.changeCoverage, "Terminal changeCoverage")!;
      if (!CHANGE_COVERAGE.has(coverage)) throw new Error("Terminal changeCoverage is invalid");
      return coverage;
    })(),
    artifactRefs: parseArtifacts(value.artifactRefs),
    evidenceRefs: parseEvidence(value.evidenceRefs),
    data: validateJsonData(value.data),
    unsatisfiedGates: terminalStringArray(value.unsatisfiedGates, "unsatisfied gates", RUN_LIFECYCLE_LIMITS.referenceFieldBytes),
    closedQuestionIds: terminalStringArray(value.closedQuestionIds, "closed questions", 256),
    partialState: validateJsonData(value.partialState),
    finishedByNodeId: boundedField(value.finishedByNodeId, "Terminal finishedByNodeId")!,
    finishedAt,
    snapshotId: boundedField(value.snapshotId, "Terminal snapshotId")!,
    runId: boundedField(value.runId, "Terminal runId")!,
  });
  if (authority && (result.runId !== authority.runId || result.finishedAt !== authority.timestamp)) throw new Error("Terminal authority fields do not match the event envelope");
  if (Buffer.byteLength(canonicalJson({ ...result, terminalEventHash: "0".repeat(64) }), "utf8") > RUN_LIFECYCLE_LIMITS.renderedTerminalBytes) throw new Error("Terminal envelope exceeds its byte limit");
  return result;
}

function validateFinishRequest(value: unknown): Required<FinishRequest> {
  if (!isPlainRecord(value)) throw new Error("workflow_finish request must be an object");
  exactKeys(value, ["status", "summary", "artifactRefs", "evidenceRefs", "data"], "workflow_finish request");
  if (value.status !== "completed" && value.status !== "blocked" && value.status !== "failed") throw new Error("workflow_finish status is invalid; cancelled is harness-only");
  const summary = boundedField(value.summary, "workflow_finish summary", RUN_LIFECYCLE_LIMITS.summaryBytes)!;
  if (Buffer.byteLength(summary, "utf8") > RUN_LIFECYCLE_LIMITS.summaryBytes) throw new Error("workflow_finish summary is too large");
  const artifactValues = value.artifactRefs ?? [];
  const evidenceValues = value.evidenceRefs ?? [];
  if (!Array.isArray(artifactValues) || artifactValues.length > RUN_LIFECYCLE_LIMITS.referenceItems) throw new Error("workflow_finish artifactRefs is invalid or too large");
  if (!Array.isArray(evidenceValues) || evidenceValues.length > RUN_LIFECYCLE_LIMITS.referenceItems) throw new Error("workflow_finish evidenceRefs is invalid or too large");
  const artifactRefs = artifactValues.map((entry, index): ArtifactReference => {
    if (!isPlainRecord(entry)) throw new Error(`artifactRefs[${index}] is invalid`);
    exactKeys(entry, ["workspaceId", "checkpoint", "digest"], `artifactRefs[${index}]`);
    return Object.freeze({ workspaceId: boundedField(entry.workspaceId, `artifactRefs[${index}].workspaceId`)!, checkpoint: boundedField(entry.checkpoint, `artifactRefs[${index}].checkpoint`)!, digest: digestField(entry.digest, `artifactRefs[${index}].digest`) });
  });
  const evidenceRefs = evidenceValues.map((entry, index): EvidenceReference => {
    if (!isPlainRecord(entry)) throw new Error(`evidenceRefs[${index}] is invalid`);
    exactKeys(entry, ["kind", "toolCallId", "claim"], `evidenceRefs[${index}]`);
    return Object.freeze({ kind: boundedField(entry.kind, `evidenceRefs[${index}].kind`)!, ...(entry.toolCallId === undefined ? {} : { toolCallId: boundedField(entry.toolCallId, `evidenceRefs[${index}].toolCallId`)! }), claim: boundedField(entry.claim, `evidenceRefs[${index}].claim`)! });
  });
  return Object.freeze({ status: value.status, summary, artifactRefs: Object.freeze(artifactRefs), evidenceRefs: Object.freeze(evidenceRefs), data: validateJsonData(value.data ?? {}) });
}

function normalizeGate(result: CompletionGateResult, label: string): CompletionGateResult {
  if (!result || !["satisfied", "unsatisfied", "not-present"].includes(result.state)) return Object.freeze({ state: "unsatisfied", issues: [`${label}: validator returned an invalid result`] });
  const issues = (result.issues ?? []).slice(0, 128).map((issue) => `${label}: ${String(issue).slice(0, 2_048)}`);
  const pendingQuestionIds = (result.pendingQuestionIds ?? []).slice(0, 128).map((id) => String(id).slice(0, 256));
  return Object.freeze({ state: result.state, ...(issues.length ? { issues: Object.freeze(issues) } : {}), ...(pendingQuestionIds.length ? { pendingQuestionIds: Object.freeze(pendingQuestionIds) } : {}) });
}

async function runGate(label: string, hook: (() => CompletionGateResult | Promise<CompletionGateResult>) | undefined): Promise<CompletionGateResult> {
  if (!hook) return Object.freeze({ state: "not-present" });
  try { return normalizeGate(await hook(), label); }
  catch (error) { return Object.freeze({ state: "unsatisfied", issues: [`${label}: validator failed: ${String(error instanceof Error ? error.message : error).slice(0, 2_048)}`] }); }
}

function gateIssues(gate: CompletionGateResult): readonly string[] {
  return gate.state === "unsatisfied" ? (gate.issues?.length ? gate.issues : ["completion gate is unsatisfied"]) : [];
}

async function boundedCoordinatorStep<T>(label: string, action: (() => T | Promise<T>) | undefined, diagnostics: string[]): Promise<T | undefined> {
  if (!action) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), CANCELLATION_TIMING.coordinatorStepMs); }),
    ]);
  } catch (error) {
    diagnostics.push(`${label}: ${String(error instanceof Error ? error.message : error).slice(0, 2_048)}`);
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface CoordinatorStepResult<T> { readonly ok: boolean; readonly value?: T; readonly outstanding?: Promise<unknown> }
const ACTIVE_CANCELLATION_SETTLEMENTS = new Map<string, Promise<CancellationResult>>();
const OUTSTANDING_CANCELLATION_STEPS = new Map<string, Set<Promise<unknown>>>();
function trackOutstandingCancellationStep(key: string, promise: Promise<unknown>): void {
  const pending = OUTSTANDING_CANCELLATION_STEPS.get(key) ?? new Set<Promise<unknown>>();
  pending.add(promise);
  OUTSTANDING_CANCELLATION_STEPS.set(key, pending);
  void promise.catch(() => undefined).finally(() => {
    pending.delete(promise);
    if (!pending.size) OUTSTANDING_CANCELLATION_STEPS.delete(key);
  });
}

async function cancellationCoordinatorStep<T>(label: string, action: (() => T | Promise<T>) | undefined, diagnostics: string[], required = false): Promise<CoordinatorStepResult<T>> {
  if (!action) {
    if (required) diagnostics.push(`${label}: coordinator action is required`);
    return Object.freeze({ ok: !required });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const actionPromise = Promise.resolve().then(action);
  try {
    const value = await Promise.race([
      actionPromise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error(`${label} timed out`)); }, CANCELLATION_TIMING.coordinatorStepMs); }),
    ]);
    return Object.freeze({ ok: true, value });
  } catch (error) {
    diagnostics.push(`${label}: ${String(error instanceof Error ? error.message : error).slice(0, 2_048)}`);
    return Object.freeze({ ok: false, ...(timedOut ? { outstanding: actionPromise } : {}) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class WorkflowRunLifecycle {
  readonly options: WorkflowRunLifecycleOptions;

  constructor(options: WorkflowRunLifecycleOptions) {
    this.options = options;
  }

  restore(): RunLifecycleState {
    return replayWorkflowJournal(
      readWorkflowJournal(this.options.projectRoot, this.options.sessionId),
      createEmptyRunLifecycleState(this.options.sessionId),
      reduceRunLifecycle,
    ).state;
  }

  pendingInputs(): readonly RunInputRecord[] {
    const run = this.restore().latestRun;
    if (!run || !isOpenRunStatus(run.status)) return Object.freeze([]);
    return Object.freeze(run.inputs.filter((input) => input.sequence > run.deliveredThrough));
  }

  recordUserInput(input: RecordRunInput): RecordRunInputResult {
    validateInput(input);
    const state = this.restore();
    const assigned = state.inputAssignments?.[input.inputId];
    if (assigned) return duplicateInputResult(input, assigned);
    const now = this.options.now?.() ?? new Date().toISOString();
    const current = state.latestRun;
    if (!current || !isOpenRunStatus(current.status)) {
      const runId = this.options.createRunId?.() ?? `run-${randomUUID()}`;
      const record = freezeInput({ ...input, sequence: 1, kind: "initial", receivedAt: now });
      try {
        appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
          projectId: this.options.projectId,
          sessionId: this.options.sessionId,
          runId,
          type: "run.started",
          payload: asJson({ formatVersion: RUN_LIFECYCLE_FORMAT_VERSION, input: record }),
          producer: "runtime",
          timestamp: now,
        }), (existing) => {
          const locked = replayWorkflowJournal(existing, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state;
          if (locked.inputAssignments?.[input.inputId]) throw new Error("Run input callback was recorded concurrently");
          if (locked.latestRun && isOpenRunStatus(locked.latestRun.status)) throw new Error("Workflow session already has an open run");
        });
      } catch (error) {
        const concurrent = this.restore().inputAssignments?.[input.inputId];
        if (concurrent) return duplicateInputResult(input, concurrent);
        throw error;
      }
      return Object.freeze({ runId, input: record, created: true, duplicate: false });
    }
    if (current.cancellationRequested || current.pendingTerminal) throw new Error("Run cancellation or terminal settlement is in progress; new input is rejected");
    const record = freezeInput({ ...input, sequence: current.inputs.length + 1, kind: "steering", receivedAt: now });
    try {
      appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
        projectId: this.options.projectId,
        sessionId: this.options.sessionId,
        runId: current.runId,
        type: "run.input.recorded",
        payload: asJson({ formatVersion: RUN_LIFECYCLE_FORMAT_VERSION, input: record }),
        producer: "runtime",
        timestamp: now,
      }), (existing) => {
        const locked = replayWorkflowJournal(existing, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state;
        if (locked.inputAssignments?.[input.inputId]) throw new Error("Run input callback was recorded concurrently");
        if (!locked.latestRun || locked.latestRun.runId !== current.runId || !isOpenRunStatus(locked.latestRun.status) || locked.latestRun.cancellationRequested || locked.latestRun.pendingTerminal || locked.latestRun.inputs.length + 1 !== record.sequence) throw new Error("Run changed before steering input could be recorded");
      });
    } catch (error) {
      const concurrent = this.restore().inputAssignments?.[input.inputId];
      if (concurrent) return duplicateInputResult(input, concurrent);
      throw error;
    }
    return Object.freeze({ runId: current.runId, input: record, created: false, duplicate: false });
  }

  preparedInputDelivery(): Readonly<{ requestId: string; runId: string; inputs: readonly RunInputRecord[] }> | undefined {
    const run = this.restore().latestRun;
    if (!run || !isOpenRunStatus(run.status) || !run.pendingDelivery) return undefined;
    const inputs = run.inputs.filter((input) => input.sequence > run.deliveredThrough && input.sequence <= run.pendingDelivery!.throughSequence);
    return Object.freeze({ requestId: run.pendingDelivery.requestId, runId: run.runId, inputs: Object.freeze(inputs) });
  }

  prepareInputDelivery(requestId: string): Readonly<{ requestId: string; runId: string; inputs: readonly RunInputRecord[] }> {
    if (!requestId || Buffer.byteLength(requestId, "utf8") > RUN_LIFECYCLE_LIMITS.requestIdBytes) throw new Error("Root request ID is invalid");
    const state = this.restore();
    const run = state.latestRun;
    if (!run || !isOpenRunStatus(run.status)) throw new Error("No open run has input to deliver");
    if (run.pendingDelivery) {
      if (run.pendingDelivery.requestId !== requestId) throw new Error("An overlapping input delivery is already pending");
      return this.preparedInputDelivery()!;
    }
    const inputs = run.inputs.filter((input) => input.sequence > run.deliveredThrough);
    if (!inputs.length) return Object.freeze({ requestId, runId: run.runId, inputs: Object.freeze([]) });
    const throughSequence = inputs.at(-1)!.sequence;
    appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      runId: run.runId,
      type: "run.input.delivery.prepared",
      payload: { formatVersion: RUN_LIFECYCLE_FORMAT_VERSION, requestId, throughSequence },
      producer: "runtime",
      timestamp: this.options.now?.() ?? new Date().toISOString(),
    }), (existing) => {
      const locked = replayWorkflowJournal(existing, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
      if (!locked || locked.runId !== run.runId || !isOpenRunStatus(locked.status) || locked.cancellationRequested) throw new Error("Run changed before input delivery preparation");
      if (locked.pendingDelivery) throw new Error("An overlapping input delivery is already pending");
      if (locked.deliveredThrough !== run.deliveredThrough || locked.inputs.at(-1)?.sequence !== throughSequence) throw new Error("Input range changed before delivery preparation");
    });
    return Object.freeze({ requestId, runId: run.runId, inputs: Object.freeze(inputs) });
  }

  confirmInputDelivery(requestId: string): void {
    const run = this.restore().latestRun;
    if (!run || !isOpenRunStatus(run.status) || !run.pendingDelivery || run.pendingDelivery.requestId !== requestId) {
      throw new Error("Stale root request does not match a prepared input delivery");
    }
    appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      runId: run.runId,
      type: "run.input.delivered",
      payload: { formatVersion: RUN_LIFECYCLE_FORMAT_VERSION, requestId },
      producer: "runtime",
      timestamp: this.options.now?.() ?? new Date().toISOString(),
    }), (existing) => {
      const locked = replayWorkflowJournal(existing, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
      if (!locked || locked.runId !== run.runId || !isOpenRunStatus(locked.status) || locked.pendingDelivery?.requestId !== requestId || locked.pendingDelivery.throughSequence !== run.pendingDelivery!.throughSequence) {
        throw new Error("Stale input delivery confirmation was rejected");
      }
    });
  }

  transitionToWaitingForHuman(reason: string): void {
    if (!reason.trim()) throw new Error("Waiting reason is required");
    const run = this.restore().latestRun;
    if (!run || run.status !== "running" || run.cancellationRequested || run.pendingTerminal) throw new Error("Only a running non-finalizing run can wait for human input");
    appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      runId: run.runId,
      type: "run.transition",
      payload: { formatVersion: RUN_LIFECYCLE_FORMAT_VERSION, from: "running", to: "waiting_for_human", reason: reason.slice(0, 2_048) },
      producer: "runtime",
      timestamp: this.options.now?.() ?? new Date().toISOString(),
    }), (existing) => {
      const locked = replayWorkflowJournal(existing, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
      if (!locked || locked.runId !== run.runId || locked.status !== "running" || locked.cancellationRequested || locked.pendingTerminal) throw new Error("Run changed before waiting state persistence");
    });
  }

  private async releasePausedAuthority(run: WorkflowRunRecord, coordinator: PauseCoordinator): Promise<boolean> {
    const diagnostics: string[] = [];
    await boundedCoordinatorStep("release leases", coordinator.releaseLeases, diagnostics);
    await boundedCoordinatorStep("release runtime ownership", coordinator.releaseOwnership, diagnostics);
    if (diagnostics.length) throw new Error(`Run is paused but authority release failed: ${diagnostics.join("; ")}`);
    const timestamp = this.options.now?.() ?? new Date().toISOString();
    try {
      appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
        projectId: this.options.projectId,
        sessionId: this.options.sessionId,
        runId: run.runId,
        type: "run.pause.release.confirmed",
        payload: { formatVersion: RUN_LIFECYCLE_FORMAT_VERSION },
        producer: "runtime",
        timestamp,
      }), (existing) => {
        const locked = replayWorkflowJournal(existing, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
        if (!locked || locked.runId !== run.runId || locked.status !== "paused" || locked.pauseReleasePending !== true) throw new Error("Paused authority release no longer requires confirmation");
      }, { fault: (stage) => this.options.journalFault?.("run.pause.release.confirmed", stage) });
    } catch (error) {
      const restored = this.restore().latestRun;
      if (restored?.runId === run.runId && restored.status === "paused" && restored.pauseReleasePending === false) return true;
      throw error;
    }
    return true;
  }

  async pause(reason: string, coordinator: PauseCoordinator): Promise<boolean> {
    const run = this.restore().latestRun;
    if (!run || !isOpenRunStatus(run.status)) return false;
    if (run.status === "paused") return run.pauseReleasePending === true ? this.releasePausedAuthority(run, coordinator) : false;
    if (run.cancellationRequested || run.pendingTerminal) throw new Error("Cannot pause while cancellation or terminal settlement is in progress");
    const diagnostics: string[] = [];
    await boundedCoordinatorStep("suspend owned work", coordinator.suspendOwnedWork, diagnostics);
    const captured = await boundedCoordinatorStep("capture pause state", coordinator.captureState, diagnostics);
    if (diagnostics.length) throw new Error(`Cannot pause workflow run: ${diagnostics.join("; ")}`);
    const pauseState = validateJsonData(captured ?? {});
    const timestamp = this.options.now?.() ?? new Date().toISOString();
    appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      runId: run.runId,
      type: "run.transition",
      payload: { formatVersion: RUN_LIFECYCLE_FORMAT_VERSION, from: run.status, to: "paused", resumeStatus: run.status, reason: truncateUtf8(reason, 2_048), pauseState },
      producer: "runtime",
      timestamp,
    }), (existing) => {
      const locked = replayWorkflowJournal(existing, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
      if (!locked || locked.runId !== run.runId || locked.status !== run.status || locked.cancellationRequested || locked.pendingTerminal) throw new Error("Run changed before pause persistence");
    }, { fault: (stage) => this.options.journalFault?.("run.transition", stage) });
    const paused = this.restore().latestRun;
    if (!paused || paused.runId !== run.runId || paused.status !== "paused" || paused.pauseReleasePending !== true) throw new Error("Persisted pause release state could not be restored");
    return this.releasePausedAuthority(paused, coordinator);
  }

  async resume(coordinator: ResumeCoordinator): Promise<boolean> {
    const run = this.restore().latestRun;
    if (!run || run.status !== "paused" || run.cancellationRequested || run.pauseReleasePending !== false) throw new Error("Only a non-cancelling paused run with confirmed authority release can resume");
    const resumeStatus = run.resumeStatus ?? "running";
    let authorityAcquisitionStarted = false;
    let transitionEventId: string | undefined;
    try {
      authorityAcquisitionStarted = true;
      await coordinator.acquireOwnership();
      await coordinator.acquireLeases();
      if (!await coordinator.revalidateHashes(run.pauseState ?? Object.freeze({}))) throw new Error("Recorded pause hashes failed revalidation");
      const timestamp = this.options.now?.() ?? new Date().toISOString();
      const transition = createWorkflowEvent({
        projectId: this.options.projectId,
        sessionId: this.options.sessionId,
        runId: run.runId,
        type: "run.transition",
        payload: { formatVersion: RUN_LIFECYCLE_FORMAT_VERSION, from: "paused", to: resumeStatus, reason: "resume after authority and hash checks" },
        producer: "runtime",
        timestamp,
      });
      transitionEventId = transition.eventId;
      appendWorkflowEventChecked(this.options.projectRoot, transition, (existing) => {
        const locked = replayWorkflowJournal(existing, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
        if (!locked || locked.runId !== run.runId || locked.status !== "paused" || locked.resumeStatus !== run.resumeStatus || locked.cancellationRequested) throw new Error("Run changed before resume persistence");
      }, { fault: (stage) => this.options.journalFault?.("run.transition", stage) });
      return true;
    } catch (error) {
      if (transitionEventId) {
        try {
          const events = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
          replayWorkflowJournal(events, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle);
          if (events.some((event) => event.eventId === transitionEventId)) return true;
        } catch (replayError) {
          throw new AggregateError([error, replayError], "Resume failed and durable state reconciliation also failed");
        }
      }
      if (authorityAcquisitionStarted) {
        try { await coordinator.rollbackAuthority(); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "Resume failed and authority rollback also failed"); }
      }
      throw error;
    }
  }

  requestCancellation(reason: string): void {
    if (!reason.trim()) throw new Error("Cancellation reason is empty");
    const boundedReason = truncateUtf8(reason, RUN_LIFECYCLE_LIMITS.summaryBytes);
    const events = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
    const state = replayWorkflowJournal(events, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state;
    const run = state.latestRun;
    if (!run || !isOpenRunStatus(run.status)) throw new Error("Cannot cancel a terminal or missing run");
    if (run.pendingTerminal) throw new Error("Cannot cancel while terminal settlement is in progress");
    if (run.cancellationRequested) return;
    const timestamp = this.options.now?.() ?? new Date().toISOString();
    const draft = createWorkflowEvent({ projectId: this.options.projectId, sessionId: this.options.sessionId, runId: run.runId, type: "run.cancel.requested", payload: { formatVersion: RUN_LIFECYCLE_FORMAT_VERSION, reason: boundedReason }, producer: "harness", timestamp });
    try {
      appendWorkflowEventChecked(this.options.projectRoot, draft, (existing) => {
        const locked = replayWorkflowJournal(existing, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
        if (!locked || locked.runId !== run.runId || !isOpenRunStatus(locked.status) || locked.pendingTerminal) throw new Error("Run changed before cancellation could be requested");
        if (locked.cancellationRequested) throw new Error("Cancellation was already requested concurrently");
      });
    } catch (error) {
      const latest = this.restore().latestRun;
      if (latest?.runId === run.runId && latest.cancellationRequested) return;
      throw error;
    }
  }

  private persistCancellationSettlementFailure(runId: string, diagnostics: readonly string[]): never {
    const diagnostic = truncateUtf8(diagnostics.join("; "), RUN_LIFECYCLE_LIMITS.summaryBytes) || "owned work settlement was not conclusive";
    appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      runId,
      type: "run.cancel.settlement.failed",
      payload: { formatVersion: RUN_LIFECYCLE_FORMAT_VERSION, diagnostic, retryable: true },
      producer: "harness",
      timestamp: this.options.now?.() ?? new Date().toISOString(),
    }), (existing) => {
      const locked = replayWorkflowJournal(existing, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
      if (!locked || locked.runId !== runId || !isOpenRunStatus(locked.status) || !locked.cancellationRequested) throw new Error("Cancellation settlement no longer targets an open cancelling run");
    });
    throw new Error(`Cancellation settlement is retryable: ${diagnostic}`);
  }

  private assertCurrentRuntimeOwner(): void {
    const nonce = this.options.runtimeOwnerNonce;
    if (!nonce || !heartbeatCurrentRuntimeOwnership(this.options.projectRoot, this.options.sessionId, nonce)) {
      throw new Error("Cancellation requires the current runtime owner");
    }
  }

  async cancel(reason: string, coordinator: CancellationCoordinator): Promise<CancellationResult> {
    const initial = this.restore().latestRun;
    if (initial?.status === "cancelled" && initial.terminal) return Object.freeze({ envelope: initial.terminal, rendered: canonicalJson(initial.terminal) });
    if (!initial || !isOpenRunStatus(initial.status)) throw new Error("Cannot cancel a terminal or missing run");
    this.assertCurrentRuntimeOwner();
    if (!initial.cancellationRequested) this.requestCancellation(reason);
    const run = this.restore().latestRun!;
    const terminalSummary = truncateUtf8(`Cancelled: ${run.cancellationReason ?? reason}`, RUN_LIFECYCLE_LIMITS.summaryBytes);
    if (!terminalSummary) throw new Error("Cancellation terminal summary is invalid");
    const settlementKey = `${workflowJournalIdentity(this.options.projectRoot, this.options.sessionId)}\0${run.runId}`;
    const active = ACTIVE_CANCELLATION_SETTLEMENTS.get(settlementKey);
    if (active) return active;

    const settlement = this.settleCancellation(run, terminalSummary, coordinator, settlementKey);
    ACTIVE_CANCELLATION_SETTLEMENTS.set(settlementKey, settlement);
    try {
      return await settlement;
    } finally {
      if (ACTIVE_CANCELLATION_SETTLEMENTS.get(settlementKey) === settlement) ACTIVE_CANCELLATION_SETTLEMENTS.delete(settlementKey);
    }
  }

  private async settleCancellation(run: WorkflowRunRecord, terminalSummary: string, coordinator: CancellationCoordinator, settlementKey: string): Promise<CancellationResult> {
    const diagnostics: string[] = [];
    if (OUTSTANDING_CANCELLATION_STEPS.get(settlementKey)?.size) {
      this.persistCancellationSettlementFailure(run.runId, ["a previously timed-out coordinator action is still running"]);
    }
    const requireStep = <T>(step: CoordinatorStepResult<T>): void => {
      if (step.outstanding) trackOutstandingCancellationStep(settlementKey, step.outstanding);
      if (!step.ok) this.persistCancellationSettlementFailure(run.runId, diagnostics);
    };

    for (const [label, action] of [
      ["reject new work", coordinator.rejectNewWork],
      ["cancel queued work", coordinator.cancelQueuedWork],
      ["abort owned work", coordinator.abortOwnedWork],
    ] as const) {
      const step = await cancellationCoordinatorStep(label, action, diagnostics);
      requireStep(step);
    }
    const firstSettlement = await cancellationCoordinatorStep("graceful settlement", coordinator.waitForSettlement ? () => coordinator.waitForSettlement!(CANCELLATION_TIMING.settleGraceMs) : undefined, diagnostics, true);
    requireStep(firstSettlement);
    if (firstSettlement.value !== true) {
      const termination = await cancellationCoordinatorStep("terminate process trees", coordinator.terminateProcessTrees, diagnostics, true);
      requireStep(termination);
      const forcedSettlement = await cancellationCoordinatorStep("forced settlement", coordinator.waitForSettlement ? () => coordinator.waitForSettlement!(CANCELLATION_TIMING.killSettleMs) : undefined, diagnostics, true);
      requireStep(forcedSettlement);
      if (forcedSettlement.value !== true) {
        diagnostics.push("owned work did not report settled after forced termination");
        this.persistCancellationSettlementFailure(run.runId, diagnostics);
      }
    }
    const capture = await cancellationCoordinatorStep("capture partial state", coordinator.capturePartialState, diagnostics);
    requireStep(capture);
    const captured = capture.value;
    const partialState = validateJsonData(captured ?? {});
    const released = await cancellationCoordinatorStep("release leases", coordinator.releaseLeases, diagnostics);
    requireStep(released);
    this.assertCurrentRuntimeOwner();
    const finishedAt = this.options.now?.() ?? new Date().toISOString();
    const payload = {
      formatVersion: RUN_LIFECYCLE_FORMAT_VERSION,
      status: "cancelled" as const,
      summary: terminalSummary,
      fileChanges: [],
      changeCoverage: "partial",
      artifactRefs: [],
      evidenceRefs: [],
      data: {},
      unsatisfiedGates: [],
      closedQuestionIds: [],
      partialState,
      finishedByNodeId: "harness",
      finishedAt,
      snapshotId: this.options.snapshotId,
      runId: run.runId,
    } as const;
    validateTerminalPayload(payload, { runId: run.runId, timestamp: finishedAt });
    let event: WorkflowEventEnvelope;
    try {
      event = appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({ projectId: this.options.projectId, sessionId: this.options.sessionId, runId: run.runId, type: "terminal.recorded", payload: asJson(payload), producer: "harness", timestamp: finishedAt }), (existing) => {
        const locked = replayWorkflowJournal(existing, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
        if (!locked || locked.runId !== run.runId || !isOpenRunStatus(locked.status) || !locked.cancellationRequested) throw new Error("Run is not in cancellation settlement");
      }, { fault: (stage) => this.options.journalFault?.("terminal.recorded", stage) });
    } catch (error) {
      const latest = this.restore().latestRun;
      if (latest?.status === "cancelled" && latest.terminal) return Object.freeze({ envelope: latest.terminal, rendered: canonicalJson(latest.terminal) });
      throw error;
    }
    const envelope = terminalEnvelopeFromEvent(event);
    return Object.freeze({ envelope, rendered: canonicalJson(envelope) });
  }

  private async commitPreparedTerminal(run: WorkflowRunRecord, prepared: PendingTerminalSettlement): Promise<FinishResult> {
    const hooks = this.options.completion ?? {};
    if (hooks.settleTerminal) {
      try {
        await hooks.settleTerminal(Object.freeze({
          operationId: prepared.operationId,
          runId: prepared.runId,
          status: prepared.status as FinishableRunStatus,
          closedQuestionIds: prepared.closedQuestionIds,
          unsatisfiedGates: prepared.unsatisfiedGates,
          releaseLease: true,
        }));
      } catch (error) {
        return Object.freeze({ ok: false, issues: Object.freeze([`terminal settlement failed: ${String(error instanceof Error ? error.message : error).slice(0, 2_048)}`]) });
      }
    }
    const { operationId: _operationId, ...payload } = prepared;
    let terminalEvent: WorkflowEventEnvelope;
    try {
      terminalEvent = appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
        projectId: this.options.projectId,
        sessionId: this.options.sessionId,
        runId: run.runId,
        type: "terminal.recorded",
        payload: asJson({ formatVersion: RUN_LIFECYCLE_FORMAT_VERSION, ...payload }),
        producer: "harness",
        timestamp: prepared.finishedAt,
      }), (existing) => {
        const locked = replayWorkflowJournal(existing, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
        if (!locked || locked.runId !== run.runId || !isOpenRunStatus(locked.status) || locked.cancellationRequested || locked.pendingTerminal?.operationId !== prepared.operationId) throw new Error("Terminal settlement changed before commit");
        const { operationId: _lockedOperationId, ...lockedPayload } = locked.pendingTerminal;
        if (canonicalJson(lockedPayload) !== canonicalJson(payload)) throw new Error("Terminal settlement payload changed before commit");
      });
    } catch (error) {
      const latest = this.restore().latestRun;
      if (latest?.terminal && latest.runId === run.runId) return Object.freeze({ ok: true, envelope: latest.terminal, rendered: canonicalJson(latest.terminal) });
      return Object.freeze({ ok: false, issues: Object.freeze([String(error instanceof Error ? error.message : error)]) });
    }
    const envelope = terminalEnvelopeFromEvent(terminalEvent);
    return Object.freeze({ ok: true, envelope, rendered: canonicalJson(envelope) });
  }

  async finish(rawRequest: unknown, context: FinishCallContext): Promise<FinishResult> {
    const invocationIssues: string[] = [];
    if (context.callerNodeId !== this.options.rootNodeId) invocationIssues.push("workflow_finish is root-only");
    if (context.toolBatch.length !== 1 || context.toolBatch[0] !== "workflow_finish") invocationIssues.push("workflow_finish must be the sole call in its tool batch");
    let request: Required<FinishRequest>;
    try { request = validateFinishRequest(rawRequest); }
    catch (error) { invocationIssues.push(String(error instanceof Error ? error.message : error)); return Object.freeze({ ok: false, issues: Object.freeze(invocationIssues) }); }
    if (invocationIssues.length) return Object.freeze({ ok: false, issues: Object.freeze(invocationIssues) });

    const eventsAtValidation = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
    const state = replayWorkflowJournal(eventsAtValidation, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state;
    const run = state.latestRun;
    const issues: string[] = [];
    if (!run || !isOpenRunStatus(run.status)) issues.push("workflow_finish requires an open run");
    if (run?.cancellationRequested) issues.push("workflow_finish is blocked while cancellation is in progress");
    if (run && (run.deliveredThrough !== run.inputs.length || run.pendingDelivery)) issues.push("workflow_finish is blocked until every input is delivered in a root model input");
    if (issues.length || !run) return Object.freeze({ ok: false, issues: Object.freeze(issues) });
    if (run.pendingTerminal) {
      const matches = run.pendingTerminal.status === request.status
        && run.pendingTerminal.summary === request.summary
        && canonicalJson(run.pendingTerminal.artifactRefs) === canonicalJson(request.artifactRefs)
        && canonicalJson(run.pendingTerminal.evidenceRefs) === canonicalJson(request.evidenceRefs)
        && canonicalJson(run.pendingTerminal.data) === canonicalJson(request.data);
      if (!matches) return Object.freeze({ ok: false, issues: Object.freeze(["A different terminal settlement is already prepared for this run"]) });
      return this.commitPreparedTerminal(run, run.pendingTerminal);
    }

    const hooks = this.options.completion ?? {};
    const descendants = await runGate("descendants", hooks.descendants);
    const questions = await runGate("questions", hooks.questions);
    const adapter = await runGate("adapter", hooks.adapter);
    const approvals = await runGate("approvals", hooks.approvals);
    const lease = await runGate("lease", hooks.lease);
    const evidence = await runGate("evidence", hooks.evidence ? () => hooks.evidence!(request.evidenceRefs) : undefined);
    const artifacts = await runGate("artifacts", hooks.artifacts ? () => hooks.artifacts!(request.artifactRefs) : undefined);
    let projectState: ProjectStateResult;
    if (!hooks.projectState) projectState = Object.freeze({ state: "not-present" });
    else {
      try {
        const raw = await hooks.projectState();
        const normalized = normalizeGate(raw, "project state");
        projectState = Object.freeze({ ...normalized, fileChanges: raw.fileChanges, changeCoverage: raw.changeCoverage, partialState: raw.partialState });
      } catch (error) {
        projectState = Object.freeze({ state: "unsatisfied", issues: [`project state: validator failed: ${String(error instanceof Error ? error.message : error).slice(0, 2_048)}`] });
      }
    }

    issues.push(...gateIssues(descendants), ...gateIssues(projectState));
    if (request.evidenceRefs.length && evidence.state !== "satisfied") issues.push(...(gateIssues(evidence).length ? gateIssues(evidence) : ["evidence: claimed references cannot be verified"]));
    if (request.artifactRefs.length && artifacts.state !== "satisfied") issues.push(...(gateIssues(artifacts).length ? gateIssues(artifacts) : ["artifacts: claimed references cannot be verified"]));
    const closeableGates = [questions, adapter, approvals, lease];
    if (request.status === "completed") {
      for (const gate of closeableGates) issues.push(...gateIssues(gate));
    } else if (!request.evidenceRefs.length || evidence.state !== "satisfied") {
      issues.push(`${request.status} completion requires verified evidence for its durable reason`);
    }
    if (issues.length) return Object.freeze({ ok: false, issues: Object.freeze([...new Set(issues)]) });

    const unsatisfiedGates = request.status === "completed"
      ? []
      : closeableGates.flatMap((gate) => gateIssues(gate));
    const closedQuestionIds = request.status === "completed" ? [] : [...(questions.pendingQuestionIds ?? [])];
    if ((hooks.lease || closedQuestionIds.length || unsatisfiedGates.length) && !hooks.settleTerminal) {
      return Object.freeze({ ok: false, issues: Object.freeze(["terminal settlement hook is required to close questions/gates and release leases replay-safely"]) });
    }
    let fileChanges: readonly FileChangeRecord[] = [];
    let partialState: Readonly<Record<string, JsonValue>> = Object.freeze({});
    try {
      if (projectState.fileChanges) {
        if (!Array.isArray(projectState.fileChanges) || projectState.fileChanges.length > 4_096) throw new Error("project state returned too many file changes");
        fileChanges = Object.freeze(projectState.fileChanges.map((change) => Object.freeze(structuredClone(change))));
      }
      partialState = projectState.partialState ? validateJsonData(projectState.partialState) : Object.freeze({});
    } catch (error) {
      return Object.freeze({ ok: false, issues: Object.freeze([String(error instanceof Error ? error.message : error)]) });
    }
    const finishedAt = this.options.now?.() ?? new Date().toISOString();
    const payload = {
      formatVersion: RUN_LIFECYCLE_FORMAT_VERSION,
      status: request.status,
      summary: request.summary,
      fileChanges,
      changeCoverage: projectState.changeCoverage ?? (projectState.state === "not-present" ? "partial" : "recorded"),
      artifactRefs: request.artifactRefs,
      evidenceRefs: request.evidenceRefs,
      data: request.data,
      unsatisfiedGates,
      closedQuestionIds,
      partialState,
      finishedByNodeId: this.options.rootNodeId,
      finishedAt,
      snapshotId: this.options.snapshotId,
      runId: run.runId,
    } as const;
    try { validateTerminalPayload(payload, { runId: run.runId, timestamp: finishedAt }); }
    catch (error) { return Object.freeze({ ok: false, issues: Object.freeze([String(error instanceof Error ? error.message : error)]) }); }

    const operationId = `terminal-${randomUUID()}`;
    try {
      appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
        projectId: this.options.projectId,
        sessionId: this.options.sessionId,
        runId: run.runId,
        type: "run.terminal.prepared",
        payload: asJson({ formatVersion: RUN_LIFECYCLE_FORMAT_VERSION, operationId, terminal: payload }),
        producer: "harness",
        timestamp: finishedAt,
      }), (existing) => {
        if (existing.length !== eventsAtValidation.length) throw new Error("workflow state changed during finish validation");
        const lockedRun = replayWorkflowJournal(existing, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
        if (!lockedRun || lockedRun.runId !== run.runId || !isOpenRunStatus(lockedRun.status)) throw new Error("run changed during finish validation");
        if (lockedRun.cancellationRequested || lockedRun.pendingTerminal) throw new Error("cancellation or terminal settlement started during finish validation");
        if (lockedRun.pendingDelivery || lockedRun.deliveredThrough !== lockedRun.inputs.length) throw new Error("input arrived during finish validation and must be delivered");
      });
    } catch (error) {
      return Object.freeze({ ok: false, issues: Object.freeze([String(error instanceof Error ? error.message : error)]) });
    }
    const prepared = this.restore().latestRun?.pendingTerminal;
    if (!prepared || prepared.operationId !== operationId) return Object.freeze({ ok: false, issues: Object.freeze(["terminal settlement preparation could not be restored"]) });
    return this.commitPreparedTerminal(run, prepared);
  }
}
