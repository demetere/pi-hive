import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../config/snapshot-canonical";
import { createWorkflowEvent, sealWorkflowEvent, type WorkflowEventEnvelope, type WorkflowEventProducer } from "../workflows/events";
import { appendWorkflowEventChecked, readWorkflowJournal, type JournalFaultStage } from "../workflows/journal";
import { createEmptyRunLifecycleState, isOpenRunStatus, reduceRunLifecycle, type CompletionGateResult, type OpenRunStatus, type RunCheckpointSnapshotProvider } from "../workflows/runs";
import { boundedId, boundedText, deepFreeze, exactKeys, plainRecord } from "../workflows/values";
import { canonicalJson as canonical } from "../config/snapshot-canonical";
import {
  resolveCheckpointDigest,
  validateRunCheckpointSnapshot,
  type CheckpointDescriptorV1,
  type CheckpointPolicy,
  type ResolvedCheckpointDigestV1,
  type RunCheckpointSnapshotV1,
} from "./checkpoints";
import { hashArtifactWorkspace, isArtifactHash, requireExpectedArtifactHash, type ArtifactWorkspaceHashesV1 } from "./hashes";
import { withWorkspaceLeaseRunValidation } from "./leases";
import type { ArtifactWorkspaceBinding } from "./types";
import { providerArtifactArgumentContract, type ProviderArtifactArgumentContractV1 } from "./action-contracts";

export const CHECKPOINT_APPROVAL_FORMAT_VERSION = 1 as const;
export const CHECKPOINT_REQUEST_ACTION_ID = "checkpoint-request" as const;
export const CHECKPOINT_APPROVAL_LIMITS = Object.freeze({ requests: 4_096, decisions: 4_096, feedbackBytes: 8_192, outputBytes: 65_536, statusCheckpointItems: 32, statusPendingIds: 32 });

export interface CheckpointRequestActionArguments { readonly checkpointId: string }
export function checkpointRequestProviderContract(checkpointIds: readonly string[]): ProviderArtifactArgumentContractV1 {
  if (checkpointIds.length > CHECKPOINT_APPROVAL_LIMITS.statusCheckpointItems || new Set(checkpointIds).size !== checkpointIds.length) throw new Error("Checkpoint request argument contract IDs exceed their bound or are duplicated");
  return providerArtifactArgumentContract("1", {
    type: "object",
    required: ["checkpointId"],
    properties: { checkpointId: { type: "string", enum: [...checkpointIds] } },
    additionalProperties: false,
  });
}
/** Strict harness-owned arguments; this action is never dispatched to an adapter. */
export function parseCheckpointRequestActionArguments(value: unknown): CheckpointRequestActionArguments {
  if (!plainRecord(value)) throw new Error("checkpoint-request arguments must be an object");
  exactKeys(value, ["checkpointId"], [], "checkpoint-request arguments");
  return Object.freeze({ checkpointId: identifier(value.checkpointId, "checkpoint-request checkpoint ID") });
}

export type CheckpointDecisionValue = "approved" | "denied";
export type CheckpointControlChannel = "dashboard" | "tui";
export type CheckpointRuntimeMode = "tui" | "headless";

export interface HumanControlIdentity {
  readonly approverId: string;
  readonly authenticationId: string;
  readonly mechanism: string;
}
export interface AuthenticateCheckpointControlInput {
  readonly channel: CheckpointControlChannel;
  readonly credential: unknown;
  readonly action: "checkpoint-decision";
  readonly operationId: string;
}
export interface CheckpointControlContext {
  readonly channel: CheckpointControlChannel;
  readonly mode: CheckpointRuntimeMode;
  readonly dashboardAvailable: boolean;
  readonly credential: unknown;
}
export interface ResolveCheckpointDescriptorInput {
  readonly runId: string;
  readonly checkpointId: string;
  readonly binding: ArtifactWorkspaceBinding;
}

export interface CheckpointApprovalServiceOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileSchemaVersion: string;
  readonly checkpointPolicies: Readonly<Record<string, CheckpointPolicy>>;
  readonly resolveDescriptor?: (input: ResolveCheckpointDescriptorInput) => CheckpointDescriptorV1;
  readonly authenticateControl: (input: AuthenticateCheckpointControlInput) => HumanControlIdentity | undefined;
  readonly createRequestId?: () => string;
  readonly createDecisionId?: () => string;
  readonly now?: () => string;
  readonly fault?: (operation: "default" | "request" | "decision", stage: JournalFaultStage) => void;
  /** Projection hook shared with the run lifecycle so active-time clocks follow approval waits. */
  readonly onRunStatusChanged?: (runId: string, status: OpenRunStatus, timestamp: string) => void;
}

export interface CheckpointDefaultView {
  readonly checkpointId: string;
  readonly policy: CheckpointPolicy;
  readonly enabled: boolean;
  readonly defaultsRevision: number;
}
export interface SetOptionalCheckpointDefaultInput {
  readonly operationId: string;
  readonly checkpointId: string;
  readonly enabled: boolean;
  readonly expectedDefaultsRevision: number;
}
export interface CheckpointDecisionRecord {
  readonly decisionId: string;
  readonly requestId: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileSchemaVersion: string;
  readonly checkpointId: string;
  readonly checkpointVersion: string;
  readonly decision: CheckpointDecisionValue;
  readonly digest: string;
  readonly expectedRequestSequence: number;
  readonly decisionSequence: number;
  readonly decidedAt: string;
  readonly decisionWorkspaceHash: string;
  readonly approverId: string;
  readonly channel: CheckpointControlChannel;
  readonly provenance: Readonly<{ authenticationId: string; mechanism: string }>;
  readonly feedback?: string;
}
export interface CheckpointApprovalRequestRecord {
  readonly requestId: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileSchemaVersion: string;
  readonly checkpointId: string;
  readonly checkpointVersion: string;
  readonly digest: string;
  readonly contributorCount: number;
  readonly requestWorkspaceHash: string;
  readonly requestedAt: string;
  readonly requestSequence: number;
  readonly decision?: CheckpointDecisionRecord;
}
type OperationRecord =
  | Readonly<{ kind: "default"; inputHash: string; result: CheckpointDefaultView }>
  | Readonly<{ kind: "request"; inputHash: string; requestId: string }>
  | Readonly<{ kind: "decision"; inputHash: string; requestId: string; decisionId: string }>;
export interface CheckpointApprovalState {
  readonly defaults: Readonly<Record<string, boolean>>;
  readonly defaultsRevision: number;
  readonly runSnapshots: Readonly<Record<string, RunCheckpointSnapshotV1>>;
  readonly requests: Readonly<Record<string, CheckpointApprovalRequestRecord>>;
  readonly requestOrder: readonly string[];
  readonly operations: Readonly<Record<string, OperationRecord>>;
  readonly openRunId?: string;
}

export interface RequestCheckpointApprovalInput {
  readonly operationId: string;
  readonly checkpointId: string;
  readonly expectedWorkspaceHash: string;
}
export interface DecideCheckpointApprovalInput {
  readonly operationId: string;
  readonly requestId: string;
  readonly expectedRequestSequence: number;
  readonly digest: string;
  readonly expectedWorkspaceHash: string;
  readonly decision: CheckpointDecisionValue;
  readonly feedback?: string;
}

function inputHash(kind: string, value: unknown): string {
  return createHash("sha256").update(`pi-hive-checkpoint-${kind}-input-v1\0`).update(canonicalJson(value)).digest("hex");
}
function identifier(value: unknown, label: string): string {
  const result = boundedId(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(result)) throw new Error(`${label} is invalid`);
  return result;
}
function timestamp(value: unknown, label: string): string {
  const result = boundedText(value, label, 256);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} is invalid`);
  return result;
}
function payload(event: WorkflowEventEnvelope): Record<string, unknown> | undefined {
  if (event.type !== "approval.recorded" || !plainRecord(event.payload) || event.payload.subsystem !== "checkpoint-approval") return undefined;
  if (event.payload.formatVersion !== CHECKPOINT_APPROVAL_FORMAT_VERSION) throw new Error("Checkpoint approval event format is unsupported");
  return event.payload;
}
function persistedInputHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function withOperation(state: CheckpointApprovalState, operationId: string, operation: OperationRecord): Readonly<Record<string, OperationRecord>> {
  if (state.operations[operationId]) throw new Error("Checkpoint operation is duplicated");
  if (Object.keys(state.operations).length >= CHECKPOINT_APPROVAL_LIMITS.requests + CHECKPOINT_APPROVAL_LIMITS.decisions) throw new Error("Checkpoint operation history exceeds its bound");
  return Object.freeze({ ...state.operations, [operationId]: Object.freeze(operation) });
}

export function createEmptyCheckpointApprovalState(): CheckpointApprovalState {
  return deepFreeze({ defaults: {}, defaultsRevision: 0, runSnapshots: {}, requests: {}, requestOrder: [], operations: {} });
}

export function reduceCheckpointApprovalState(state: CheckpointApprovalState, event: WorkflowEventEnvelope): CheckpointApprovalState {
  if (event.type === "run.started") {
    if (!event.runId) throw new Error("Checkpoint run snapshot has no run ID");
    if (state.openRunId) throw new Error("Checkpoint state already has an open run");
    if (!plainRecord(event.payload)) throw new Error("Run start payload is invalid");
    if (event.payload.checkpointSnapshot === undefined) return deepFreeze({ ...state, openRunId: event.runId });
    const snapshot = validateRunCheckpointSnapshot(event.payload.checkpointSnapshot);
    if (snapshot.runId !== event.runId || snapshot.defaultsRevision !== state.defaultsRevision) throw new Error("Run checkpoint snapshot is stale or targets another run");
    if (state.runSnapshots[event.runId]) throw new Error("Run checkpoint snapshot is duplicated");
    return deepFreeze({ ...state, openRunId: event.runId, runSnapshots: { ...state.runSnapshots, [event.runId]: snapshot } });
  }
  if (event.type === "terminal.recorded" && event.runId === state.openRunId) return deepFreeze({ ...state, openRunId: undefined });
  const data = payload(event);
  if (!data) return state;
  const operation = data.operation;
  const operationId = identifier(data.operationId, "Checkpoint operation ID");

  if (operation === "default-set") {
    exactKeys(data, ["formatVersion", "subsystem", "operation", "operationId", "inputHash", "checkpointId", "enabled", "expectedDefaultsRevision"], [], "Checkpoint default event");
    if (event.producer !== "harness" || event.runId || state.openRunId) throw new Error("Checkpoint defaults can change only through the idle harness");
    if (!Number.isSafeInteger(data.expectedDefaultsRevision) || (data.expectedDefaultsRevision as number) < 0 || data.expectedDefaultsRevision !== state.defaultsRevision) {
      throw new Error("Checkpoint default revision CAS failed");
    }
    const checkpointId = identifier(data.checkpointId, "Checkpoint default ID");
    if (typeof data.enabled !== "boolean") throw new Error("Checkpoint default enabled value is invalid");
    const hash = persistedInputHash(data.inputHash, "Checkpoint default input hash");
    const result: CheckpointDefaultView = Object.freeze({ checkpointId, policy: "optional", enabled: data.enabled, defaultsRevision: event.sequence });
    return deepFreeze({
      ...state,
      defaults: { ...state.defaults, [checkpointId]: data.enabled },
      defaultsRevision: event.sequence,
      operations: withOperation(state, operationId, { kind: "default", inputHash: hash, result }),
    });
  }

  if (operation === "request-bind") {
    exactKeys(data, ["formatVersion", "subsystem", "operation", "operationId", "inputHash", "requestId"], [], "Checkpoint request binding event");
    if (event.producer !== "harness" || !event.runId || event.runId !== state.openRunId) throw new Error("Checkpoint request binding lacks harness authority or an open run");
    const requestId = identifier(data.requestId, "Checkpoint bound request ID");
    const request = state.requests[requestId];
    if (!request || request.runId !== event.runId) throw new Error("Checkpoint request binding result is missing or targets another run");
    const hash = persistedInputHash(data.inputHash, "Checkpoint request binding input hash");
    return deepFreeze({ ...state, operations: withOperation(state, operationId, { kind: "request", inputHash: hash, requestId }) });
  }

  if (operation === "request") {
    exactKeys(data, ["formatVersion", "subsystem", "operation", "operationId", "inputHash", "requestId", "workspaceId", "adapterId", "adapterVersion", "profileId", "profileVersion", "profileSchemaVersion", "checkpointId", "checkpointVersion", "digest", "contributorCount", "requestWorkspaceHash"], [], "Checkpoint request event");
    if (event.producer !== "harness" || !event.runId || event.runId !== state.openRunId) throw new Error("Checkpoint request lacks harness authority or an open run");
    if (state.requestOrder.length >= CHECKPOINT_APPROVAL_LIMITS.requests) throw new Error("Checkpoint approval requests exceed their bound");
    const requestId = identifier(data.requestId, "Checkpoint request ID");
    if (state.requests[requestId]) throw new Error("Checkpoint request ID is duplicated");
    const snapshot = state.runSnapshots[event.runId];
    const checkpointId = identifier(data.checkpointId, "Checkpoint request checkpoint ID");
    if (!snapshot?.enabledCheckpointIds.includes(checkpointId)) throw new Error("Checkpoint request does not target an enabled run checkpoint");
    if (!isArtifactHash(data.digest) || !isArtifactHash(data.requestWorkspaceHash) || !Number.isSafeInteger(data.contributorCount) || (data.contributorCount as number) < 0) throw new Error("Checkpoint request digest or contributor count is invalid");
    const hash = persistedInputHash(data.inputHash, "Checkpoint request input hash");
    const request: CheckpointApprovalRequestRecord = Object.freeze({
      requestId, operationId, projectId: event.projectId, sessionId: event.sessionId, runId: event.runId,
      workspaceId: identifier(data.workspaceId, "Checkpoint workspace ID"),
      adapterId: identifier(data.adapterId, "Checkpoint adapter ID"), adapterVersion: identifier(data.adapterVersion, "Checkpoint adapter version"),
      profileId: identifier(data.profileId, "Checkpoint profile ID"), profileVersion: identifier(data.profileVersion, "Checkpoint profile version"),
      profileSchemaVersion: identifier(data.profileSchemaVersion, "Checkpoint profile schema version"), checkpointId,
      checkpointVersion: identifier(data.checkpointVersion, "Checkpoint version"), digest: data.digest,
      contributorCount: data.contributorCount as number, requestWorkspaceHash: data.requestWorkspaceHash,
      requestedAt: timestamp(event.timestamp, "Checkpoint request timestamp"), requestSequence: event.sequence,
    });
    return deepFreeze({
      ...state,
      requests: { ...state.requests, [requestId]: request }, requestOrder: [...state.requestOrder, requestId],
      operations: withOperation(state, operationId, { kind: "request", inputHash: hash, requestId }),
    });
  }

  if (operation === "decision") {
    exactKeys(data, ["formatVersion", "subsystem", "operation", "operationId", "inputHash", "decisionId", "requestId", "expectedRequestSequence", "digest", "decisionWorkspaceHash", "decision", "approverId", "channel", "provenance"], ["feedback"], "Checkpoint decision event");
    if (!event.runId || event.runId !== state.openRunId) throw new Error("Checkpoint decision does not target the open run");
    const channel = data.channel;
    if ((channel !== "dashboard" && channel !== "tui") || (channel === "dashboard" ? event.producer !== "dashboard" : event.producer !== "harness")) throw new Error("Checkpoint decision channel lacks persisted control authority");
    const requestId = identifier(data.requestId, "Checkpoint decision request ID");
    const request = state.requests[requestId];
    if (!request || request.runId !== event.runId || request.decision) throw new Error("Checkpoint request is missing or already decided; first valid decision wins");
    if (!Number.isSafeInteger(data.expectedRequestSequence) || data.expectedRequestSequence !== request.requestSequence || data.digest !== request.digest) throw new Error("Checkpoint decision exact request CAS failed");
    if (data.decision !== "approved" && data.decision !== "denied") throw new Error("Checkpoint decision value is invalid");
    if (!isArtifactHash(data.decisionWorkspaceHash)) throw new Error("Checkpoint decision workspace hash is invalid");
    const feedback = data.feedback === undefined ? undefined : boundedText(data.feedback, "Checkpoint decision feedback", CHECKPOINT_APPROVAL_LIMITS.feedbackBytes);
    if (!plainRecord(data.provenance)) throw new Error("Checkpoint decision provenance is invalid");
    exactKeys(data.provenance, ["authenticationId", "mechanism"], [], "Checkpoint decision provenance");
    const provenance = Object.freeze({
      authenticationId: identifier(data.provenance.authenticationId, "Checkpoint authentication ID"),
      mechanism: identifier(data.provenance.mechanism, "Checkpoint authentication mechanism"),
    });
    const decisionId = identifier(data.decisionId, "Checkpoint decision ID");
    if (Object.values(state.requests).some((candidate) => candidate.decision?.decisionId === decisionId)) throw new Error("Checkpoint decision ID is duplicated");
    const hash = persistedInputHash(data.inputHash, "Checkpoint decision input hash");
    const decision: CheckpointDecisionRecord = Object.freeze({
      decisionId, requestId, operationId,
      projectId: request.projectId, sessionId: request.sessionId, runId: request.runId, workspaceId: request.workspaceId,
      adapterId: request.adapterId, adapterVersion: request.adapterVersion, profileId: request.profileId, profileVersion: request.profileVersion,
      profileSchemaVersion: request.profileSchemaVersion, checkpointId: request.checkpointId, checkpointVersion: request.checkpointVersion,
      decision: data.decision, digest: request.digest,
      expectedRequestSequence: request.requestSequence, decisionSequence: event.sequence, decidedAt: timestamp(event.timestamp, "Checkpoint decision timestamp"),
      decisionWorkspaceHash: data.decisionWorkspaceHash, approverId: identifier(data.approverId, "Checkpoint approver ID"), channel, provenance,
      ...(feedback === undefined ? {} : { feedback }),
    });
    return deepFreeze({
      ...state,
      requests: { ...state.requests, [requestId]: { ...request, decision } },
      operations: withOperation(state, operationId, { kind: "decision", inputHash: hash, requestId, decisionId }),
    });
  }
  throw new Error("Checkpoint approval operation is unsupported");
}

interface ResolvedCurrentCheckpoint {
  readonly runId: string;
  readonly binding: ArtifactWorkspaceBinding;
  readonly hashes: ArtifactWorkspaceHashesV1;
  readonly resolved: ResolvedCheckpointDigestV1;
}

export class CheckpointApprovalService {
  readonly options: CheckpointApprovalServiceOptions;
  private readonly policies: Readonly<Record<string, CheckpointPolicy>>;

  constructor(options: CheckpointApprovalServiceOptions) {
    this.options = options;
    identifier(options.projectId, "Checkpoint project ID"); identifier(options.sessionId, "Checkpoint session ID");
    identifier(options.adapterId, "Checkpoint adapter ID"); identifier(options.adapterVersion, "Checkpoint adapter version");
    identifier(options.profileId, "Checkpoint profile ID"); identifier(options.profileVersion, "Checkpoint profile version"); identifier(options.profileSchemaVersion, "Checkpoint profile schema version");
    if (!plainRecord(options.checkpointPolicies)) throw new Error("Checkpoint policies are invalid");
    const policies: Record<string, CheckpointPolicy> = {};
    for (const key of Object.keys(options.checkpointPolicies).sort()) {
      const id = identifier(key, "Checkpoint policy ID");
      const policy = options.checkpointPolicies[key];
      if (policy !== "required" && policy !== "optional" && policy !== "none") throw new Error("Checkpoint policy value is invalid");
      policies[id] = policy;
    }
    if (Object.values(policies).some((policy) => policy !== "none") && !options.resolveDescriptor) throw new Error("Enabled checkpoint profiles require a trusted descriptor resolver");
    this.policies = Object.freeze(policies);
  }

  restore(events = readWorkflowJournal(this.options.projectRoot, this.options.sessionId)): CheckpointApprovalState {
    return events.reduce(reduceCheckpointApprovalState, createEmptyCheckpointApprovalState());
  }

  nextRunDefaults(): readonly CheckpointDefaultView[] {
    const state = this.restore();
    return Object.freeze(Object.entries(this.policies).map(([checkpointId, policy]) => Object.freeze({
      checkpointId, policy, enabled: policy === "required" || (policy === "optional" && (state.defaults[checkpointId] ?? true)), defaultsRevision: state.defaultsRevision,
    })));
  }

  setOptionalDefault(input: SetOptionalCheckpointDefaultInput): CheckpointDefaultView {
    if (!plainRecord(input)) throw new Error("Checkpoint default input is invalid");
    exactKeys(input, ["operationId", "checkpointId", "enabled", "expectedDefaultsRevision"], [], "Checkpoint default input");
    const operationId = identifier(input.operationId, "Checkpoint default operation ID");
    const checkpointId = identifier(input.checkpointId, "Checkpoint default ID");
    if (this.policies[checkpointId] !== "optional") throw new Error(`Checkpoint ${checkpointId} is not optional; required/none policy cannot be changed`);
    if (typeof input.enabled !== "boolean") throw new Error("Checkpoint default enabled value is invalid");
    if (!Number.isSafeInteger(input.expectedDefaultsRevision) || input.expectedDefaultsRevision < 0) throw new Error("Checkpoint expected default revision is invalid");
    const expectedHash = inputHash("default", { checkpointId, enabled: input.enabled, expectedDefaultsRevision: input.expectedDefaultsRevision });
    const initialOperation = this.restore().operations[operationId];
    if (initialOperation) return this.replayDefaultOperation(initialOperation, expectedHash);
    const current = this.restore();
    if (current.openRunId) throw new Error("Checkpoint defaults can change only while the workflow session is idle; an open run exists");
    if (current.defaultsRevision !== input.expectedDefaultsRevision) throw new Error("Checkpoint default revision CAS failed; expected revision is stale");
    const draft = createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, type: "approval.recorded", producer: "harness", timestamp: this.time(),
      payload: {
        formatVersion: 1, subsystem: "checkpoint-approval", operation: "default-set", operationId, inputHash: expectedHash,
        checkpointId, enabled: input.enabled, expectedDefaultsRevision: input.expectedDefaultsRevision,
      },
    });
    try {
      this.appendValidated(draft, "default", (events) => {
        const locked = this.restore(events);
        const operation = locked.operations[operationId];
        if (operation) throw new Error("Checkpoint default operation was recorded concurrently");
        if (locked.openRunId) throw new Error("Checkpoint defaults can change only while the workflow session is idle; an open run exists");
        if (locked.defaultsRevision !== input.expectedDefaultsRevision) throw new Error("Checkpoint default revision CAS failed; expected revision is stale");
      });
    } catch (error) {
      const replayed = this.restore().operations[operationId];
      if (!replayed) throw error;
      return this.replayDefaultOperation(replayed, expectedHash);
    }
    return this.replayDefaultOperation(this.restore().operations[operationId], expectedHash);
  }

  private replayDefaultOperation(operation: OperationRecord | undefined, expectedHash: string): CheckpointDefaultView {
    if (!operation || operation.kind !== "default" || operation.inputHash !== expectedHash) throw new Error("Checkpoint default operation ID reuse with different input is rejected");
    return operation.result;
  }

  private createSnapshot(runId: string, state = this.restore()): RunCheckpointSnapshotV1 {
    identifier(runId, "Checkpoint snapshot run ID");
    if (state.openRunId) throw new Error("A checkpoint run snapshot can be created only while the session is idle");
    const checkpoints = Object.entries(this.policies).map(([checkpointId, policy]) => Object.freeze({
      checkpointId, policy, enabled: policy === "required" || (policy === "optional" && (state.defaults[checkpointId] ?? true)),
    }));
    return validateRunCheckpointSnapshot({
      formatVersion: 1, runId, adapterId: this.options.adapterId, adapterVersion: this.options.adapterVersion,
      profileId: this.options.profileId, profileVersion: this.options.profileVersion, profileSchemaVersion: this.options.profileSchemaVersion,
      defaultsRevision: state.defaultsRevision, checkpoints, enabledCheckpointIds: checkpoints.filter((entry) => entry.enabled).map((entry) => entry.checkpointId),
    });
  }

  runSnapshotProvider(): RunCheckpointSnapshotProvider {
    return Object.freeze({
      create: (runId: string) => this.createSnapshot(runId),
      validate: (snapshot: RunCheckpointSnapshotV1, events: readonly WorkflowEventEnvelope[]) => {
        const current = this.restore(events);
        const expected = this.createSnapshot(snapshot.runId, current);
        if (canonical(expected) !== canonical(snapshot)) throw new Error("Checkpoint defaults changed before atomic run creation");
      },
    });
  }

  private time(): string { return timestamp(this.options.now?.() ?? new Date().toISOString(), "Checkpoint event timestamp"); }

  private appendValidated(draft: ReturnType<typeof createWorkflowEvent>, operation: "default" | "request" | "decision", check?: (events: readonly WorkflowEventEnvelope[]) => void): WorkflowEventEnvelope {
    return appendWorkflowEventChecked(this.options.projectRoot, draft, (events) => {
      check?.(events);
      const previous = events.at(-1);
      const candidate = sealWorkflowEvent(draft, (previous?.sequence ?? 0) + 1, previous?.eventHash ?? null);
      reduceCheckpointApprovalState(this.restore(events), candidate);
      reduceRunLifecycle(
        events.reduce(reduceRunLifecycle, createEmptyRunLifecycleState(this.options.sessionId)),
        candidate,
      );
    }, { fault: (stage) => this.options.fault?.(operation, stage) });
  }

  private publishedDraft(draft: ReturnType<typeof createWorkflowEvent>): WorkflowEventEnvelope | undefined {
    return readWorkflowJournal(this.options.projectRoot, this.options.sessionId).find((event) => event.eventId === draft.eventId);
  }

  private projectApprovalStatus(event: WorkflowEventEnvelope, _status: Extract<OpenRunStatus, "running" | "waiting_for_human">): void {
    if (!event.runId) throw new Error("Checkpoint status projection requires a run ID");
    const status = readWorkflowJournal(this.options.projectRoot, this.options.sessionId)
      .reduce(reduceRunLifecycle, createEmptyRunLifecycleState(this.options.sessionId)).latestRun?.status;
    if (status !== "running" && status !== "waiting_for_human") throw new Error("Checkpoint status projection did not restore an open human-control state");
    this.options.onRunStatusChanged?.(event.runId, status, event.timestamp);
  }

  private currentRunBinding(events: readonly WorkflowEventEnvelope[], requestedRunId?: string): Readonly<{ runId: string; binding: ArtifactWorkspaceBinding; snapshot: RunCheckpointSnapshotV1 }> {
    const run = events.reduce(reduceRunLifecycle, createEmptyRunLifecycleState(this.options.sessionId)).latestRun;
    if (!run || !isOpenRunStatus(run.status) || (requestedRunId && run.runId !== requestedRunId)) throw new Error("Checkpoint operation requires the current open run");
    const binding = run.artifactWorkspace;
    if (!binding || binding.workspace.kind !== "physical" || !binding.path) throw new Error("Checkpoint operation requires a bound physical artifact workspace");
    const snapshot = run.checkpointSnapshot;
    if (!snapshot || snapshot.runId !== run.runId) throw new Error("Run has no frozen checkpoint policy snapshot");
    if (binding.adapterId !== this.options.adapterId || binding.adapterVersion !== this.options.adapterVersion || binding.profileId !== this.options.profileId || binding.profileVersion !== this.options.profileVersion
      || snapshot.adapterId !== this.options.adapterId || snapshot.adapterVersion !== this.options.adapterVersion || snapshot.profileId !== this.options.profileId || snapshot.profileVersion !== this.options.profileVersion || snapshot.profileSchemaVersion !== this.options.profileSchemaVersion) {
      throw new Error("Checkpoint service identity does not match the bound adapter/profile snapshot");
    }
    return Object.freeze({ runId: run.runId, binding, snapshot });
  }

  private assertCheckpointAvailable(current: Readonly<{ binding: ArtifactWorkspaceBinding; snapshot: RunCheckpointSnapshotV1 }>, checkpointId: string): void {
    if (!current.snapshot.enabledCheckpointIds.includes(checkpointId)) throw new Error(`Checkpoint ${checkpointId} is disabled for this frozen run and has no human gate`);
    if (!current.binding.checkpointIds.includes(checkpointId)) throw new Error("Checkpoint is not published by the bound adapter profile");
  }

  private resolveCurrent(events: readonly WorkflowEventEnvelope[], checkpointId: string, expectedWorkspaceHash: string, runId?: string): ResolvedCurrentCheckpoint {
    const current = this.currentRunBinding(events, runId);
    this.assertCheckpointAvailable(current, checkpointId);
    const hashes = hashArtifactWorkspace(current.binding.path!);
    requireExpectedArtifactHash(expectedWorkspaceHash, hashes);
    const descriptor = this.options.resolveDescriptor?.({ runId: current.runId, checkpointId, binding: current.binding });
    if (!descriptor) throw new Error("Trusted checkpoint descriptor is unavailable");
    const resolved = resolveCheckpointDigest(descriptor, hashes);
    if (resolved.adapterId !== this.options.adapterId || resolved.adapterVersion !== this.options.adapterVersion || resolved.profileId !== this.options.profileId
      || resolved.profileVersion !== this.options.profileVersion || resolved.profileSchemaVersion !== this.options.profileSchemaVersion || resolved.checkpointId !== checkpointId) {
      throw new Error("Checkpoint descriptor identity does not match the active adapter/profile/checkpoint");
    }
    return Object.freeze({ runId: current.runId, binding: current.binding, hashes, resolved });
  }

  async requestApproval(rawInput: RequestCheckpointApprovalInput): Promise<CheckpointApprovalRequestRecord> {
    if (!plainRecord(rawInput)) throw new Error("Checkpoint approval request input is invalid");
    exactKeys(rawInput, ["operationId", "checkpointId", "expectedWorkspaceHash"], [], "Checkpoint approval request input");
    const operationId = identifier(rawInput.operationId, "Checkpoint request operation ID");
    const checkpointId = identifier(rawInput.checkpointId, "Checkpoint request checkpoint ID");
    if (!isArtifactHash(rawInput.expectedWorkspaceHash)) throw new Error("Checkpoint request expected workspace hash is invalid");
    const requestInputHash = inputHash("request", { checkpointId, expectedWorkspaceHash: rawInput.expectedWorkspaceHash });
    const existingOperation = this.restore().operations[operationId];
    if (existingOperation) return this.replayRequestOperation(existingOperation, requestInputHash);
    const initialEvents = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
    const initial = this.currentRunBinding(initialEvents);
    this.assertCheckpointAvailable(initial, checkpointId);
    return withWorkspaceLeaseRunValidation(this.options.projectRoot, initial.binding.adapterId, initial.binding.workspace.id, { sessionId: this.options.sessionId, runId: initial.runId }, async () => {
      const replayedOperation = this.restore().operations[operationId];
      if (replayedOperation) return this.replayRequestOperation(replayedOperation, requestInputHash);
      const lockedEvents = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
      const current = this.resolveCurrent(lockedEvents, checkpointId, rawInput.expectedWorkspaceHash, initial.runId);
      const state = this.restore(lockedEvents);
      const exact = state.requestOrder.map((id) => state.requests[id]).find((request) => request.runId === current.runId && request.checkpointId === checkpointId && request.digest === current.resolved.digest);
      if (exact) {
        const bindingDraft = createWorkflowEvent({
          projectId: this.options.projectId, sessionId: this.options.sessionId, runId: current.runId, type: "approval.recorded", producer: "harness", timestamp: this.time(), attemptId: operationId,
          payload: { formatVersion: 1, subsystem: "checkpoint-approval", operation: "request-bind", operationId, inputHash: requestInputHash, requestId: exact.requestId },
        });
        try {
          this.appendValidated(bindingDraft, "request", (events) => {
            const lockedState = this.restore(events);
            if (lockedState.operations[operationId]) throw new Error("Checkpoint request operation was recorded concurrently");
            const lockedExact = lockedState.requests[exact.requestId];
            if (!lockedExact || lockedExact.runId !== current.runId || lockedExact.checkpointId !== checkpointId || lockedExact.digest !== current.resolved.digest) {
              throw new Error("Checkpoint exact request result changed before operation binding");
            }
          });
        } catch (error) {
          const replayed = this.restore().operations[operationId];
          if (!replayed) throw error;
          return this.replayRequestOperation(replayed, requestInputHash);
        }
        return this.replayRequestOperation(this.restore().operations[operationId], requestInputHash);
      }
      // A workspace revision may supersede an undecided stale digest. The old
      // request remains immutable/auditable, while this exact current digest
      // receives a new request. Exact-digest replay was handled above.
      const requestId = identifier(this.options.createRequestId?.() ?? `checkpoint-request-${randomUUID()}`, "Checkpoint request ID");
      const draft = createWorkflowEvent({
        projectId: this.options.projectId, sessionId: this.options.sessionId, runId: current.runId, type: "approval.recorded", producer: "harness", timestamp: this.time(), attemptId: operationId,
        payload: {
          formatVersion: 1, subsystem: "checkpoint-approval", operation: "request", operationId, inputHash: requestInputHash, requestId,
          workspaceId: current.binding.workspace.id, adapterId: current.resolved.adapterId, adapterVersion: current.resolved.adapterVersion,
          profileId: current.resolved.profileId, profileVersion: current.resolved.profileVersion, profileSchemaVersion: current.resolved.profileSchemaVersion,
          checkpointId, checkpointVersion: current.resolved.checkpointVersion, digest: current.resolved.digest,
          contributorCount: current.resolved.contributors.length, requestWorkspaceHash: current.hashes.workspaceHash,
        },
      });
      let published: WorkflowEventEnvelope | undefined;
      try {
        published = this.appendValidated(draft, "request", (events) => {
          const lockedState = this.restore(events);
          const operation = lockedState.operations[operationId];
          if (operation) throw new Error("Checkpoint request operation was recorded concurrently");
          const locked = this.resolveCurrent(events, checkpointId, rawInput.expectedWorkspaceHash, current.runId);
          if (locked.resolved.digest !== current.resolved.digest) throw new Error("Checkpoint digest changed before request publication");
          const active = lockedState.requestOrder.map((id) => lockedState.requests[id]).find((request) => request.runId === current.runId && request.checkpointId === checkpointId && request.digest === locked.resolved.digest && !request.decision);
          if (active) throw new Error("Checkpoint exact-digest request state changed before publication");
        });
      } catch (error) {
        const replayed = this.restore().operations[operationId];
        if (!replayed) throw error;
        published = this.publishedDraft(draft);
        if (published) this.projectApprovalStatus(published, "waiting_for_human");
        return this.replayRequestOperation(replayed, requestInputHash);
      }
      this.projectApprovalStatus(published, "waiting_for_human");
      return this.restore().requests[requestId];
    });
  }

  private replayRequestOperation(operation: OperationRecord, expectedHash: string): CheckpointApprovalRequestRecord {
    if (operation.kind !== "request" || operation.inputHash !== expectedHash || !operation.requestId) throw new Error("Checkpoint request operation ID reuse with different input is rejected");
    const request = this.restore().requests[operation.requestId];
    if (!request) throw new Error("Checkpoint request operation result is missing");
    return request;
  }

  async decide(rawInput: DecideCheckpointApprovalInput, context: CheckpointControlContext): Promise<CheckpointDecisionRecord> {
    const input = this.validateDecisionInput(rawInput);
    const control = this.authenticate(input.operationId, context);
    const decisionInputHash = inputHash("decision", input);
    const existingOperation = this.restore().operations[input.operationId];
    if (existingOperation) return this.replayDecisionOperation(existingOperation, decisionInputHash);
    const initial = this.restore();
    const request = initial.requests[input.requestId];
    if (!request) throw new Error("Checkpoint approval request does not exist");
    if (request.decision) throw new Error("Checkpoint request is already decided and immutable; first valid decision wins");
    if (request.requestSequence !== input.expectedRequestSequence || request.digest !== input.digest) throw new Error("Checkpoint decision must bind the exact request sequence and digest");
    const producer: WorkflowEventProducer = context.channel === "dashboard" ? "dashboard" : "harness";
    const decisionId = identifier(this.options.createDecisionId?.() ?? `checkpoint-decision-${randomUUID()}`, "Checkpoint decision ID");
    return withWorkspaceLeaseRunValidation(this.options.projectRoot, request.adapterId, request.workspaceId, { sessionId: this.options.sessionId, runId: request.runId }, async () => {
      const beforeEvents = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
      const current = this.resolveCurrent(beforeEvents, request.checkpointId, input.expectedWorkspaceHash, request.runId);
      if (current.resolved.digest !== request.digest || input.digest !== request.digest) throw new Error("Checkpoint decision digest is stale or does not match the exact current contributors");
      const draft = createWorkflowEvent({
        projectId: this.options.projectId, sessionId: this.options.sessionId, runId: request.runId, type: "approval.recorded", producer, timestamp: this.time(), attemptId: input.operationId,
        payload: {
          formatVersion: 1, subsystem: "checkpoint-approval", operation: "decision", operationId: input.operationId, inputHash: decisionInputHash, decisionId,
          requestId: request.requestId, expectedRequestSequence: input.expectedRequestSequence, digest: input.digest,
          decisionWorkspaceHash: current.hashes.workspaceHash, decision: input.decision, approverId: control.approverId,
          channel: context.channel, provenance: { authenticationId: control.authenticationId, mechanism: control.mechanism },
          ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
        },
      });
      let published: WorkflowEventEnvelope | undefined;
      try {
        published = this.appendValidated(draft, "decision", (events) => {
          const state = this.restore(events);
          const operation = state.operations[input.operationId];
          if (operation) throw new Error("Checkpoint decision operation was recorded concurrently");
          const lockedRequest = state.requests[request.requestId];
          if (!lockedRequest || lockedRequest.decision || lockedRequest.requestSequence !== input.expectedRequestSequence || lockedRequest.digest !== input.digest) throw new Error("Checkpoint decision CAS lost; first valid decision wins");
          const locked = this.resolveCurrent(events, request.checkpointId, input.expectedWorkspaceHash, request.runId);
          if (locked.resolved.digest !== request.digest) throw new Error("Checkpoint digest changed before decision publication");
        });
      } catch (error) {
        const replayed = this.restore().operations[input.operationId];
        if (!replayed) throw error;
        published = this.publishedDraft(draft);
        if (published) this.projectApprovalStatus(published, "running");
        return this.replayDecisionOperation(replayed, decisionInputHash);
      }
      this.projectApprovalStatus(published, "running");
      return this.restore().requests[request.requestId].decision!;
    });
  }

  private validateDecisionInput(value: DecideCheckpointApprovalInput): Required<Omit<DecideCheckpointApprovalInput, "feedback">> & Pick<DecideCheckpointApprovalInput, "feedback"> {
    if (!plainRecord(value)) throw new Error("Checkpoint decision input is invalid");
    exactKeys(value, ["operationId", "requestId", "expectedRequestSequence", "digest", "expectedWorkspaceHash", "decision"], ["feedback"], "Checkpoint decision input");
    const operationId = identifier(value.operationId, "Checkpoint decision operation ID");
    const requestId = identifier(value.requestId, "Checkpoint decision request ID");
    if (!Number.isSafeInteger(value.expectedRequestSequence) || value.expectedRequestSequence < 1) throw new Error("Checkpoint expected request sequence is invalid");
    if (!isArtifactHash(value.digest) || !isArtifactHash(value.expectedWorkspaceHash)) throw new Error("Checkpoint decision digest/hash is invalid");
    if (value.decision !== "approved" && value.decision !== "denied") throw new Error("Checkpoint decision value is invalid");
    const feedback = value.feedback === undefined ? undefined : boundedText(value.feedback, "Checkpoint decision feedback", CHECKPOINT_APPROVAL_LIMITS.feedbackBytes);
    return Object.freeze({ operationId, requestId, expectedRequestSequence: value.expectedRequestSequence, digest: value.digest, expectedWorkspaceHash: value.expectedWorkspaceHash, decision: value.decision, ...(feedback === undefined ? {} : { feedback }) });
  }

  private authenticate(operationId: string, context: CheckpointControlContext): HumanControlIdentity {
    if (!plainRecord(context)) throw new Error("Checkpoint control context is invalid");
    exactKeys(context, ["channel", "mode", "dashboardAvailable", "credential"], [], "Checkpoint control context");
    if (context.channel !== "dashboard" && context.channel !== "tui") throw new Error("Checkpoint decisions require a dashboard or TUI human channel");
    if (context.mode !== "tui" && context.mode !== "headless" || typeof context.dashboardAvailable !== "boolean") throw new Error("Checkpoint control runtime mode is invalid");
    if (context.channel === "dashboard" && !context.dashboardAvailable) throw new Error("Dashboard control channel is unavailable");
    if (context.channel === "tui" && (context.mode !== "tui" || context.dashboardAvailable)) throw new Error("TUI approval is allowed only in TUI mode when the dashboard is unavailable; headless requires dashboard");
    const raw = this.options.authenticateControl({ channel: context.channel, credential: context.credential, action: "checkpoint-decision", operationId });
    if (!raw || !plainRecord(raw)) throw new Error("Checkpoint decision is not an authenticated explicit human action");
    exactKeys(raw, ["approverId", "authenticationId", "mechanism"], [], "Checkpoint control identity");
    return Object.freeze({
      approverId: identifier(raw.approverId, "Checkpoint approver ID"),
      authenticationId: identifier(raw.authenticationId, "Checkpoint authentication ID"),
      mechanism: identifier(raw.mechanism, "Checkpoint authentication mechanism"),
    });
  }

  private replayDecisionOperation(operation: OperationRecord, expectedHash: string): CheckpointDecisionRecord {
    if (operation.kind !== "decision" || operation.inputHash !== expectedHash || !operation.requestId || !operation.decisionId) throw new Error("Checkpoint decision operation ID reuse with different input is rejected");
    const decision = this.restore().requests[operation.requestId]?.decision;
    if (!decision || decision.decisionId !== operation.decisionId) throw new Error("Checkpoint decision operation result is missing");
    return decision;
  }

  async completionGate(input: Readonly<{ expectedWorkspaceHash?: string; runId?: string }>): Promise<CompletionGateResult> {
    if (!plainRecord(input)) return Object.freeze({ state: "unsatisfied", issues: Object.freeze(["checkpoint approvals: completion input is invalid"]) });
    try {
      exactKeys(input, [], ["expectedWorkspaceHash", "runId"], "Checkpoint completion input");
      const events = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
      const run = events.reduce(reduceRunLifecycle, createEmptyRunLifecycleState(this.options.sessionId)).latestRun;
      if (!run || !isOpenRunStatus(run.status) || (input.runId !== undefined && input.runId !== run.runId) || !run.checkpointSnapshot) throw new Error("completion requires the current open run checkpoint snapshot");
      if (!run.checkpointSnapshot.enabledCheckpointIds.length) return Object.freeze({ state: "not-present" });
      if (!isArtifactHash(input.expectedWorkspaceHash)) throw new Error("expected workspace hash is invalid");
      const current = this.currentRunBinding(events, input.runId);
      const enabled = current.snapshot.enabledCheckpointIds;
      const state = this.restore(events);
      const issues: string[] = [];
      for (const checkpointId of enabled) {
        const resolved = this.resolveCurrent(events, checkpointId, input.expectedWorkspaceHash, current.runId).resolved;
        const exact = state.requestOrder.map((id) => state.requests[id]).find((request) => request.runId === current.runId && request.checkpointId === checkpointId && request.digest === resolved.digest);
        if (!exact) issues.push(`checkpoint ${checkpointId}: exact-digest approval is missing`);
        else if (!exact.decision) issues.push(`checkpoint ${checkpointId}: human decision is pending`);
        else if (exact.decision.decision === "denied") issues.push(`checkpoint ${checkpointId}: exact digest was denied and requires revision`);
      }
      return issues.length ? Object.freeze({ state: "unsatisfied", issues: Object.freeze(issues.slice(0, 128)) }) : Object.freeze({ state: "satisfied" });
    } catch (error) {
      return Object.freeze({ state: "unsatisfied", issues: Object.freeze([`checkpoint approvals: ${String(error instanceof Error ? error.message : error).slice(0, 2_048)}`]) });
    }
  }
}

export interface CheckpointControlServiceHandlers {
  listDefaults(): readonly CheckpointDefaultView[];
  setOptionalDefault(input: unknown): CheckpointDefaultView;
  decide(input: unknown, context: CheckpointControlContext): Promise<CheckpointDecisionRecord>;
}

function boundedControlOutput<T>(value: T): T {
  if (Buffer.byteLength(canonicalJson(value), "utf8") > CHECKPOINT_APPROVAL_LIMITS.outputBytes) throw new Error("Checkpoint control output exceeds its bound");
  return value;
}

/** Typed transport-neutral handlers for W25/W26. This module registers no routes or UI. */
export function createCheckpointControlHandlers(service: CheckpointApprovalService): CheckpointControlServiceHandlers {
  if (!(service instanceof CheckpointApprovalService)) throw new Error("Checkpoint control handlers require a checkpoint approval service");
  return Object.freeze({
    listDefaults: () => boundedControlOutput(service.nextRunDefaults()),
    setOptionalDefault: (input: unknown) => boundedControlOutput(service.setOptionalDefault(input as SetOptionalCheckpointDefaultInput)),
    decide: async (input: unknown, context: CheckpointControlContext) => boundedControlOutput(await service.decide(input as DecideCheckpointApprovalInput, context)),
  });
}
