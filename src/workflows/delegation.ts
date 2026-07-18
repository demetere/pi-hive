import { randomUUID } from "node:crypto";
import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";
import { createWorkflowEvent, sealWorkflowEvent, type WorkflowEventEnvelope } from "./events";
import { appendWorkflowEventChecked, readWorkflowJournal, type JournalFaultStage } from "./journal";
import { replayWorkflowJournal } from "./replay";
import {
  authorizeReferences,
  validateStructuredReference,
  type AuthorizedReference,
  REFERENCE_AUTHORIZATION_LIMITS,
  type ReferenceAuthorizer,
  type StructuredReference,
} from "./references";
import { boundedId, boundedJson, boundedText, compareText, deepFreeze, exactKeys, plainRecord, utf8Prefix } from "./values";

const FORMAT_VERSION = 1 as const;
const bounded = boundedText;
const compare = compareText;
const LIMITS = Object.freeze({
  objectiveBytes: 131_072,
  deliverables: 128,
  deliverableBytes: 2_048,
  resultSummaryBytes: 8_192,
  resultReferences: 128,
  dataBytes: 65_536,
  dataDepth: 16,
  dataNodes: 4_096,
  statusPage: 100,
  statusObjectivePreviewBytes: 1_024,
  cursorBytes: 512,
});

export type DelegationContextReference = StructuredReference;
export type WorkerTerminalStatus = "completed" | "blocked" | "failed" | "cancelled";
export type DelegationQueueState = "queued" | "active" | "suspended" | "terminal";

export interface DelegationProvenance {
  readonly source: "delegate_agent" | "runtime" | "recovery";
  readonly correlationId?: string; readonly parentTaskId?: string;
}
export interface WorkerResultInput {
  readonly status: WorkerTerminalStatus; readonly summary: string;
  readonly outputRefs?: readonly StructuredReference[]; readonly evidenceRefs?: readonly StructuredReference[];
  readonly data?: Readonly<Record<string, JsonValue>>;
}
export interface PersistedWorkerResult {
  readonly status: WorkerTerminalStatus; readonly summary: string;
  readonly outputRefs: readonly AuthorizedReference[]; readonly evidenceRefs: readonly AuthorizedReference[];
  readonly data: Readonly<Record<string, JsonValue>>; readonly attemptId?: string;
  readonly recordedAt: string; readonly recordedSequence: number;
}
export interface DelegationAttempt {
  readonly attemptId: string; readonly startedSequence: number; readonly startedAt?: string;
  readonly resultSequence?: number; readonly interruptedSequence?: number;
}
export interface PersistedDelegationTask {
  readonly taskId: string; readonly runId: string;
  readonly parentNodeId: string; readonly targetNodeId: string; readonly objective: string;
  readonly contextRefs: readonly AuthorizedReference[]; readonly deliverables: readonly string[];
  readonly provenance: DelegationProvenance; readonly creationSequence: number; readonly createdAt: string;
  readonly queueState: DelegationQueueState; readonly attempts: readonly DelegationAttempt[];
  readonly lastStartedSequence?: number; readonly suspendedOn?: readonly string[];
  readonly resumedByResultSequence?: number; readonly result?: PersistedWorkerResult;
  readonly resultDeliveryPreparedSequence?: number; readonly resultAcceptedSequence?: number;
}
export interface PreparedResultDelivery {
  readonly deliveryId: string; readonly recipientNodeId: string; readonly taskIds: readonly string[];
  readonly preparedSequence: number; readonly preparedAt: string; readonly acceptedSequence?: number;
}
export interface DelegationTopologyNode {
  readonly nodeId: string; readonly agentId: string; readonly parentNodeId?: string;
  readonly directMemberIds: readonly string[];
}
export interface DelegationState {
  readonly sessionId: string; readonly runId: string; readonly rootNodeId: string;
  readonly topology: Readonly<Record<string, DelegationTopologyNode>>;
  readonly tasks: Readonly<Record<string, PersistedDelegationTask>>;
  readonly deliveries: Readonly<Record<string, PreparedResultDelivery>>;
  readonly schedulerStatus: "running" | "paused" | "closed";
  readonly admissionOpen: boolean; readonly closedReason?: string;
}
export interface AcceptDelegationInput {
  readonly targetNodeId: string; readonly objective: string;
  readonly contextRefs?: readonly DelegationContextReference[]; readonly deliverables: readonly string[];
  readonly provenance?: Readonly<{ correlationId?: string }>;
}
export interface DelegationAcceptanceAuthority {
  /** Evaluated under the workflow journal append lock immediately before task acceptance publication. */
  admit(events: readonly WorkflowEventEnvelope[], parentNodeId: string): Readonly<{ ok: true }> | Readonly<{
    ok: false; reason: string; exhausted: readonly string[]; budgetExhausted: boolean; scope: "node" | "run";
  }>;
}
export interface DelegationRuntimeOptions {
  readonly projectRoot: string; readonly projectId: string; readonly sessionId: string; readonly runId: string;
  readonly snapshot: ActivationSnapshotFileV1; readonly createTaskId?: () => string; readonly now?: () => string;
  readonly referenceAuthorizer?: ReferenceAuthorizer; readonly acceptanceAuthority?: DelegationAcceptanceAuthority;
  /** Fault-injection seam for durable delegation publication recovery tests. */
  readonly journalFault?: (eventType: WorkflowEventEnvelope["type"], stage: JournalFaultStage) => void;
}
export interface DelegationExecutionContext {
  readonly nodeId: string; readonly taskId?: string; readonly attemptId?: string;
}
export interface DelegationStatusItem {
  readonly taskId: string; readonly parentNodeId: string; readonly targetNodeId: string;
  readonly objectivePreview: string; readonly creationSequence: number; readonly queueState: DelegationQueueState;
  readonly attempts: number; readonly terminalStatus?: WorkerTerminalStatus; readonly resultAccepted: boolean;
}
export interface DelegationStatusPage {
  readonly summary: Readonly<Record<DelegationQueueState | WorkerTerminalStatus, number>>;
  readonly items: readonly DelegationStatusItem[]; readonly nextCursor?: string;
}
export interface ResultDeliveryBatch {
  readonly deliveryId: string; readonly recipientNodeId: string;
  readonly items: readonly Readonly<{ taskId: string; result: PersistedWorkerResult }>[];
}

const TRUSTED_CONTEXTS = new WeakMap<object, Readonly<{ sessionId: string; runId: string; bindingSequence: number }>>();
const DELEGATION_EVENTS = new Set([
  "task.accepted",
  "task.started",
  "task.suspended",
  "task.interrupted",
  "task.result.recorded",
  "task.result.delivery.prepared",
  "task.result.delivery.accepted",
  "scheduler.paused",
  "scheduler.resumed",
  "scheduler.closed",
]);

function payloadRecord(event: WorkflowEventEnvelope): Record<string, unknown> {
  if (!plainRecord(event.payload)) throw new Error("Delegation event payload is invalid");
  if (event.payload.formatVersion !== FORMAT_VERSION) throw new Error("Delegation event payload format version is invalid");
  return event.payload;
}

function topologyFromSnapshot(snapshot: ActivationSnapshotFileV1): { rootNodeId: string; topology: Record<string, DelegationTopologyNode> } {
  const team = snapshot.payload.workflow.team as { rootId?: unknown; nodes?: unknown } | undefined;
  if (!team || typeof team.rootId !== "string" || !Array.isArray(team.nodes)) throw new Error("Activation snapshot has no valid delegation topology");
  const topology: Record<string, DelegationTopologyNode> = {};
  for (const raw of team.nodes) {
    if (!plainRecord(raw)) throw new Error("Activation snapshot team node is invalid");
    const nodeId = boundedId(raw.id, "Team node ID");
    const agentId = boundedId(raw.agentId, "Team agent ID");
    if (topology[nodeId]) throw new Error("Activation snapshot contains duplicate team node IDs");
    if (!Array.isArray(raw.memberIds) || raw.memberIds.length > 1_024) throw new Error("Activation snapshot direct members are invalid");
    topology[nodeId] = Object.freeze({
      nodeId,
      agentId,
      ...(raw.parentId === undefined ? {} : { parentNodeId: boundedId(raw.parentId, "Parent node ID") }),
      directMemberIds: Object.freeze(raw.memberIds.map((member, index) => boundedId(member, `Direct member ${index}`))),
    });
  }
  if (!topology[team.rootId]) throw new Error("Activation snapshot root node is missing");
  for (const node of Object.values(topology)) {
    for (const member of node.directMemberIds) {
      if (!topology[member] || topology[member].parentNodeId !== node.nodeId) throw new Error("Activation snapshot delegation topology is inconsistent");
    }
  }
  return { rootNodeId: team.rootId, topology };
}

export function createDelegationState(sessionId: string, runId: string, snapshot: ActivationSnapshotFileV1): DelegationState {
  const { rootNodeId, topology } = topologyFromSnapshot(snapshot);
  return deepFreeze({
    sessionId: boundedId(sessionId, "Session ID"),
    runId: boundedId(runId, "Run ID"),
    rootNodeId,
    topology,
    tasks: {},
    deliveries: {},
    schedulerStatus: "running",
    admissionOpen: true,
  });
}

function parseProvenance(value: unknown): DelegationProvenance {
  if (!plainRecord(value)) throw new Error("Delegation provenance is invalid");
  exactKeys(value, ["source"], ["correlationId", "parentTaskId"], "Delegation provenance");
  if (value.source !== "delegate_agent" && value.source !== "runtime" && value.source !== "recovery") throw new Error("Delegation provenance is invalid");
  return Object.freeze({
    source: value.source,
    ...(value.correlationId === undefined ? {} : { correlationId: boundedId(value.correlationId, "Correlation ID") }),
    ...(value.parentTaskId === undefined ? {} : { parentTaskId: boundedId(value.parentTaskId, "Parent task ID") }),
  });
}

function parseAuthorizedRefs(value: unknown, label = "Authorized context references"): readonly AuthorizedReference[] {
  if (!Array.isArray(value) || value.length > LIMITS.resultReferences) throw new Error(`${label} are invalid`);
  let aggregateResolvedBytes = 0;
  return Object.freeze(value.map((entry, index) => {
    if (!plainRecord(entry)) throw new Error(`${label} ${index} is invalid`);
    const ref = validateStructuredReference(entry.ref, `${label} ${index}`);
    if (entry.authorization === "authorized") {
      exactKeys(entry, ["ref", "authorization"], ["resolved"], `${label} ${index}`);
      if (entry.resolved === undefined) return Object.freeze({ ref, authorization: "authorized" as const });
      const resolved = boundedJson(entry.resolved, `${label} ${index} resolved content`, {
        bytes: REFERENCE_AUTHORIZATION_LIMITS.resolvedItemBytes,
        depth: REFERENCE_AUTHORIZATION_LIMITS.resolvedDepth,
        nodes: REFERENCE_AUTHORIZATION_LIMITS.resolvedNodes,
      });
      aggregateResolvedBytes += Buffer.byteLength(canonicalJson(resolved), "utf8");
      if (aggregateResolvedBytes > REFERENCE_AUTHORIZATION_LIMITS.resolvedAggregateBytes) throw new Error(`${label} resolved content exceeds its aggregate bound`);
      return Object.freeze({ ref, authorization: "authorized" as const, resolved });
    }
    if (entry.authorization === "denied") {
      exactKeys(entry, ["ref", "authorization", "diagnostic"], [], `${label} ${index}`);
      return Object.freeze({ ref, authorization: "denied" as const, diagnostic: bounded(entry.diagnostic, "Reference denial diagnostic", 2_048) });
    }
    throw new Error(`${label} ${index} has an invalid decision`);
  }));
}

function stringArray(value: unknown, label: string, limit: number, itemBytes: number): readonly string[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label} limit exceeded`);
  return Object.freeze(value.map((item, index) => bounded(item, `${label} ${index}`, itemBytes)));
}

function dataRecord(value: unknown): Readonly<Record<string, JsonValue>> {
  return deepFreeze(boundedJson(value, "Worker result data", {
    bytes: LIMITS.dataBytes,
    depth: LIMITS.dataDepth,
    nodes: LIMITS.dataNodes,
    rootRecord: true,
  }) as Record<string, JsonValue>);
}

function resultRefs(value: unknown, label: string): readonly StructuredReference[] {
  if (!Array.isArray(value) || value.length > LIMITS.resultReferences) throw new Error(`${label} limit exceeded`);
  return Object.freeze(value.map((entry, index) => validateStructuredReference(entry, `${label} ${index}`)));
}

function parseResult(value: unknown, event: WorkflowEventEnvelope): PersistedWorkerResult {
  if (!plainRecord(value)) throw new Error("Worker result is invalid");
  exactKeys(value, ["status", "summary", "outputRefs", "evidenceRefs", "data"], ["attemptId"], "Worker result");
  if (value.status !== "completed" && value.status !== "blocked" && value.status !== "failed" && value.status !== "cancelled") throw new Error("Worker result status is invalid");
  return deepFreeze({
    status: value.status,
    summary: bounded(value.summary, "Worker result summary", LIMITS.resultSummaryBytes),
    outputRefs: parseAuthorizedRefs(value.outputRefs, "Worker output references"),
    evidenceRefs: parseAuthorizedRefs(value.evidenceRefs, "Worker evidence references"),
    data: dataRecord(value.data),
    ...(value.attemptId === undefined ? {} : { attemptId: boundedId(value.attemptId, "Worker result attempt ID") }),
    recordedAt: event.timestamp,
    recordedSequence: event.sequence,
  });
}

function cloneState(state: DelegationState): DelegationState {
  return structuredClone(state);
}

function queueHead(state: DelegationState, targetNodeId: string): PersistedDelegationTask | undefined {
  return Object.values(state.tasks)
    .filter((task) => task.targetNodeId === targetNodeId && task.queueState !== "terminal")
    .sort((a, b) => a.creationSequence - b.creationSequence || compare(a.taskId, b.taskId))[0];
}

function dependenciesAccepted(state: DelegationState, task: PersistedDelegationTask): boolean {
  return Boolean(task.suspendedOn?.length) && task.suspendedOn!.every((dependency) => state.tasks[dependency]?.resultAcceptedSequence !== undefined);
}

function validateEventPayload(event: WorkflowEventEnvelope, payload: Record<string, unknown>): void {
  const specifications: Partial<Record<WorkflowEventEnvelope["type"], readonly [readonly string[], readonly string[]]>> = {
    "task.accepted": [["formatVersion", "taskId", "parentNodeId", "targetNodeId", "objective", "contextRefs", "deliverables", "provenance"], []],
    "task.started": [["formatVersion", "taskId", "attemptId"], []],
    "task.suspended": [["formatVersion", "taskId", "dependencyTaskIds"], []],
    "task.interrupted": [["formatVersion", "taskId", "attemptId", "reason"], []],
    "task.result.recorded": [["formatVersion", "taskId", "result"], []],
    "task.result.delivery.prepared": [["formatVersion", "deliveryId", "recipientNodeId", "taskIds"], []],
    "task.result.delivery.accepted": [["formatVersion", "deliveryId", "recipientNodeId"], []],
    "scheduler.paused": [["formatVersion", "reason"], []],
    "scheduler.resumed": [["formatVersion"], []],
    "scheduler.closed": [["formatVersion", "reason"], []],
  };
  const specification = specifications[event.type];
  if (!specification) throw new Error("Unknown delegation event type");
  exactKeys(payload, specification[0], specification[1], `${event.type} payload`);
}

export function reduceDelegationState(state: DelegationState, event: WorkflowEventEnvelope): DelegationState {
  if (!DELEGATION_EVENTS.has(event.type)) return state;
  if (event.sessionId !== state.sessionId) throw new Error("Delegation event session identity mismatch");
  if (event.runId !== state.runId) return state;
  const payload = payloadRecord(event);
  validateEventPayload(event, payload);
  const next = cloneState(state) as DelegationState;
  const mutable = next as unknown as {
    tasks: Record<string, PersistedDelegationTask>;
    deliveries: Record<string, PreparedResultDelivery>;
    schedulerStatus: DelegationState["schedulerStatus"];
    admissionOpen: boolean;
    closedReason?: string;
  };
  const tasks = mutable.tasks;

  if (event.type === "scheduler.paused") {
    if (event.producer !== "harness" || mutable.schedulerStatus !== "running") throw new Error("Scheduler pause transition is invalid");
    mutable.schedulerStatus = "paused";
    mutable.admissionOpen = false;
    mutable.closedReason = bounded(payload.reason, "Scheduler pause reason", LIMITS.resultSummaryBytes);
    return deepFreeze(next);
  }
  if (event.type === "scheduler.resumed") {
    if (event.producer !== "harness" || mutable.schedulerStatus !== "paused") throw new Error("Scheduler resume transition is invalid");
    mutable.schedulerStatus = "running";
    mutable.admissionOpen = true;
    delete mutable.closedReason;
    return deepFreeze(next);
  }
  if (event.type === "scheduler.closed") {
    if (event.producer !== "harness" || mutable.schedulerStatus === "closed") throw new Error("Only the harness may close scheduler admission once");
    mutable.schedulerStatus = "closed";
    mutable.admissionOpen = false;
    mutable.closedReason = bounded(payload.reason, "Scheduler close reason", LIMITS.resultSummaryBytes);
    return deepFreeze(next);
  }

  if (event.type === "task.result.delivery.prepared") {
    if (event.producer !== "runtime") throw new Error("Result delivery preparation is unauthorized");
    const deliveryId = boundedId(payload.deliveryId, "Result delivery ID");
    const recipientNodeId = boundedId(payload.recipientNodeId, "Result recipient node ID");
    const taskIds = stringArray(payload.taskIds, "Result delivery tasks", LIMITS.resultReferences, 256);
    if (!taskIds.length || new Set(taskIds).size !== taskIds.length || mutable.deliveries[deliveryId]) throw new Error("Result delivery preparation is empty or duplicated");
    if (Object.values(mutable.deliveries).some((delivery) => delivery.recipientNodeId === recipientNodeId && delivery.acceptedSequence === undefined)) throw new Error("Recipient already has an unaccepted result delivery");
    for (const taskId of taskIds) {
      const task = tasks[taskId];
      if (!task?.result || task.parentNodeId !== recipientNodeId || task.resultAcceptedSequence !== undefined || task.resultDeliveryPreparedSequence !== undefined) throw new Error("Result delivery task is not pending for the recipient");
      tasks[taskId] = deepFreeze({ ...task, resultDeliveryPreparedSequence: event.sequence });
    }
    mutable.deliveries[deliveryId] = deepFreeze({ deliveryId, recipientNodeId, taskIds, preparedSequence: event.sequence, preparedAt: event.timestamp });
    return deepFreeze(next);
  }

  if (event.type === "task.result.delivery.accepted") {
    if (event.producer !== "runtime") throw new Error("Result delivery acceptance is unauthorized");
    const deliveryId = boundedId(payload.deliveryId, "Result delivery ID");
    const recipientNodeId = boundedId(payload.recipientNodeId, "Result recipient node ID");
    const delivery = mutable.deliveries[deliveryId];
    if (!delivery || delivery.recipientNodeId !== recipientNodeId || delivery.acceptedSequence !== undefined) throw new Error("Result delivery acceptance is stale or duplicated");
    mutable.deliveries[deliveryId] = deepFreeze({ ...delivery, acceptedSequence: event.sequence });
    for (const taskId of delivery.taskIds) {
      const task = tasks[taskId];
      if (!task?.result || task.resultAcceptedSequence !== undefined) throw new Error("Result delivery task acceptance is invalid");
      tasks[taskId] = deepFreeze({ ...task, resultAcceptedSequence: event.sequence });
    }
    for (const candidate of Object.values(tasks)) {
      if (candidate.queueState === "suspended" && dependenciesAccepted(next, candidate)) {
        tasks[candidate.taskId] = deepFreeze({ ...candidate, queueState: "active", resumedByResultSequence: event.sequence });
      }
    }
    return deepFreeze(next);
  }

  const taskId = boundedId(payload.taskId, "Delegation task ID");
  if (event.type === "task.accepted") {
    if (event.producer !== "runtime" || !mutable.admissionOpen || tasks[taskId]) throw new Error("Delegation acceptance is unauthorized, closed, or duplicated");
    const parentNodeId = boundedId(payload.parentNodeId, "Delegation parent node ID");
    const targetNodeId = boundedId(payload.targetNodeId, "Delegation target node ID");
    const parent = next.topology[parentNodeId];
    if (!parent) throw new Error(`Unknown parent node ${parentNodeId}`);
    if (!next.topology[targetNodeId] || !parent.directMemberIds.includes(targetNodeId)) throw new Error(`${targetNodeId} is not a direct member of ${parentNodeId}`);
    const provenance = parseProvenance(payload.provenance);
    const parentTask = provenance.parentTaskId ? tasks[provenance.parentTaskId] : undefined;
    if (provenance.parentTaskId && (!parentTask || parentTask.targetNodeId !== parentNodeId || parentTask.queueState !== "active" || !parentTask.attempts.at(-1)?.attemptId)) {
      throw new Error("Nested delegation parent is not the journal-active caller task");
    }
    tasks[taskId] = deepFreeze({
      taskId,
      runId: state.runId,
      parentNodeId,
      targetNodeId,
      objective: bounded(payload.objective, "Delegation objective", LIMITS.objectiveBytes),
      contextRefs: parseAuthorizedRefs(payload.contextRefs),
      deliverables: stringArray(payload.deliverables, "Delegation deliverables", LIMITS.deliverables, LIMITS.deliverableBytes),
      provenance,
      creationSequence: event.sequence,
      createdAt: event.timestamp,
      queueState: "queued",
      attempts: [],
    });
    if (parentTask) {
      tasks[parentTask.taskId] = deepFreeze({
        ...parentTask,
        suspendedOn: [...(parentTask.suspendedOn ?? []), taskId],
      });
    }
    return deepFreeze(next);
  }

  const task = tasks[taskId];
  if (!task) throw new Error(`Unknown delegation task ${taskId}`);
  if (event.type === "task.started") {
    if (event.producer !== "harness" || queueHead(next, task.targetNodeId)?.taskId !== taskId) throw new Error("Delegation task cannot start out of FIFO order");
    if (Object.values(tasks).some((other) => other.taskId !== taskId && other.targetNodeId === task.targetNodeId && other.queueState === "active")) throw new Error("Delegation node already has an active task");
    const attemptId = boundedId(payload.attemptId, "Delegation attempt ID");
    if (task.queueState === "active" && task.resumedByResultSequence !== undefined) {
      if (task.attempts.at(-1)?.attemptId !== attemptId) throw new Error("Delegation continuation must preserve the active attempt ID");
      const { resumedByResultSequence: _resumed, ...continued } = task;
      tasks[taskId] = deepFreeze({ ...continued, lastStartedSequence: event.sequence });
    } else {
      if (task.queueState !== "queued") throw new Error("Delegation task cannot start outside queued or resumed state");
      if (task.attempts.some((attempt) => attempt.attemptId === attemptId)) throw new Error("Delegation attempt ID is duplicated");
      tasks[taskId] = deepFreeze({
        ...task,
        queueState: "active",
        suspendedOn: undefined,
        attempts: [...task.attempts, { attemptId, startedSequence: event.sequence, startedAt: event.timestamp }],
        lastStartedSequence: event.sequence,
      });
    }
  } else if (event.type === "task.suspended") {
    if ((event.producer !== "harness" && event.producer !== "recovery") || task.queueState !== "active") throw new Error("Only an active worker task can suspend");
    const dependencyTaskIds = stringArray(payload.dependencyTaskIds, "Delegation dependencies", 128, 256);
    if (!dependencyTaskIds.length || new Set(dependencyTaskIds).size !== dependencyTaskIds.length) throw new Error("Delegation suspension dependencies are empty or duplicated");
    if (!task.suspendedOn || canonicalJson([...task.suspendedOn].sort(compare)) !== canonicalJson([...dependencyTaskIds].sort(compare))) {
      throw new Error("Delegation suspension dependencies do not match durable child acceptance linkage");
    }
    for (const dependencyId of dependencyTaskIds) {
      const dependency = tasks[dependencyId];
      if (!dependency || dependency.parentNodeId !== task.targetNodeId || (dependency.queueState === "terminal" && !dependency.result)) throw new Error("Delegation suspension dependency is not a direct child task");
    }
    tasks[taskId] = deepFreeze({ ...task, queueState: "suspended", suspendedOn: dependencyTaskIds });
  } else if (event.type === "task.interrupted") {
    const attemptId = boundedId(payload.attemptId, "Interrupted attempt ID");
    const latestAttempt = task.attempts.at(-1);
    const authorized = event.producer === "recovery" || (event.producer === "harness" && mutable.schedulerStatus === "paused");
    if (!authorized || task.queueState !== "active" || latestAttempt?.attemptId !== attemptId) throw new Error("Task interruption requires the current active attempt and interruption authority");
    bounded(payload.reason, "Task interruption reason", LIMITS.resultSummaryBytes);
    const attempts = task.attempts.map((attempt, index) => index === task.attempts.length - 1 ? { ...attempt, interruptedSequence: event.sequence } : attempt);
    tasks[taskId] = deepFreeze({ ...task, queueState: "queued", attempts });
  } else if (event.type === "task.result.recorded") {
    if (event.producer !== "harness" || task.queueState === "terminal") throw new Error("Worker result is unauthorized or duplicated");
    const result = parseResult(payload.result, event);
    if (result.status !== "cancelled" && task.suspendedOn?.some((dependencyId) => tasks[dependencyId]?.resultAcceptedSequence === undefined)) {
      throw new Error("Worker cannot publish a terminal result while durable child dependencies are pending");
    }
    if (task.queueState !== "active" && task.queueState !== "suspended" && !(result.status === "cancelled" && !mutable.admissionOpen && task.queueState === "queued")) throw new Error("Worker result does not match task execution state");
    const activeAttemptId = task.attempts.at(-1)?.attemptId;
    if ((task.queueState === "active" || task.queueState === "suspended") && (!activeAttemptId || result.attemptId !== activeAttemptId)) throw new Error("Worker result does not match the journal-active attempt");
    if (task.queueState === "queued" && result.attemptId !== undefined) throw new Error("Queued cancellation cannot claim a worker attempt");
    const attempts = task.attempts.map((attempt) => attempt.attemptId === result.attemptId ? { ...attempt, resultSequence: event.sequence } : attempt);
    tasks[taskId] = deepFreeze({ ...task, queueState: "terminal", suspendedOn: undefined, attempts, result });
  }
  return deepFreeze(next);
}

function normalizedResult(input: WorkerResultInput, task: PersistedDelegationTask, authorizer?: ReferenceAuthorizer): Record<string, JsonValue> {
  if (!plainRecord(input)) throw new Error("Worker result must be an object");
  if (input.status !== "completed" && input.status !== "blocked" && input.status !== "failed" && input.status !== "cancelled") throw new Error("Worker result status is invalid");
  return {
    status: input.status,
    summary: bounded(input.summary, "Worker result summary", LIMITS.resultSummaryBytes),
    outputRefs: authorizeReferences(resultRefs(input.outputRefs ?? [], "Worker output references"), task.parentNodeId, authorizer) as unknown as JsonValue,
    evidenceRefs: authorizeReferences(resultRefs(input.evidenceRefs ?? [], "Worker evidence references"), task.parentNodeId, authorizer) as unknown as JsonValue,
    data: dataRecord(input.data ?? {}) as Record<string, JsonValue>,
  };
}

export class DelegationRuntime {
  readonly options: DelegationRuntimeOptions;
  private readonly zero: DelegationState;

  constructor(options: DelegationRuntimeOptions) {
    this.options = options;
    this.zero = createDelegationState(options.sessionId, options.runId, options.snapshot);
  }

  restore(): DelegationState {
    return replayWorkflowJournal(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), this.zero, reduceDelegationState).state;
  }

  private context(nodeId: string, taskId?: string, attemptId?: string, bindingSequence = 0): DelegationExecutionContext {
    const context = Object.freeze({ nodeId, ...(taskId ? { taskId } : {}), ...(attemptId ? { attemptId } : {}) });
    TRUSTED_CONTEXTS.set(context, { sessionId: this.options.sessionId, runId: this.options.runId, bindingSequence });
    return context;
  }

  rootExecutionContext(): DelegationExecutionContext {
    if (!this.restore().admissionOpen) throw new Error("Trusted root execution context requires an open delegation run");
    return this.context(this.zero.rootNodeId);
  }

  workerExecutionContext(taskId: string, attemptId: string): DelegationExecutionContext {
    const task = this.restore().tasks[boundedId(taskId, "Worker task ID")];
    if (!task || task.queueState !== "active" || task.attempts.at(-1)?.attemptId !== attemptId) throw new Error("Trusted execution context requires the current active worker task");
    const bindingSequence = Math.max(task.lastStartedSequence ?? 0, task.resumedByResultSequence ?? 0);
    return this.context(task.targetNodeId, task.taskId, attemptId, bindingSequence);
  }

  private assertContext(context: DelegationExecutionContext): DelegationExecutionContext {
    if (!context || typeof context !== "object") throw new Error("A trusted execution context is required");
    const authority = TRUSTED_CONTEXTS.get(context as object);
    if (!authority || authority.sessionId !== this.options.sessionId || authority.runId !== this.options.runId) throw new Error("A trusted execution context is required");
    if (!this.zero.topology[context.nodeId]) throw new Error("Trusted execution context targets an unknown node");
    const state = this.restore();
    if (context.nodeId === state.rootNodeId && context.taskId === undefined && context.attemptId === undefined) {
      if (!state.admissionOpen) throw new Error("Trusted root execution context is no longer current");
      return context;
    }
    const task = context.taskId ? state.tasks[context.taskId] : undefined;
    const bindingSequence = task ? Math.max(task.lastStartedSequence ?? 0, task.resumedByResultSequence ?? 0) : -1;
    if (!task || task.queueState !== "active" || task.targetNodeId !== context.nodeId
      || task.attempts.at(-1)?.attemptId !== context.attemptId || authority.bindingSequence !== bindingSequence) {
      throw new Error("Trusted worker execution context is no longer the active matching task attempt");
    }
    return context;
  }

  assertExecutionContext(context: DelegationExecutionContext): void {
    this.assertContext(context);
  }

  private assertDelegatingContext(context: DelegationExecutionContext): DelegationExecutionContext {
    return this.assertContext(context);
  }

  private append(
    type: "task.accepted" | "task.started" | "task.suspended" | "task.interrupted" | "task.result.recorded" | "task.result.delivery.prepared" | "task.result.delivery.accepted" | "scheduler.paused" | "scheduler.resumed" | "scheduler.closed",
    payload: Record<string, JsonValue>,
    producer: "runtime" | "harness" | "recovery",
    validateLocked?: (events: readonly WorkflowEventEnvelope[]) => void,
  ): WorkflowEventEnvelope {
    const draft = createWorkflowEvent({
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      runId: this.options.runId,
      type,
      payload,
      producer,
      timestamp: this.options.now?.() ?? new Date().toISOString(),
    });
    return appendWorkflowEventChecked(this.options.projectRoot, draft, (events) => {
      const replayed = replayWorkflowJournal(events, this.zero, reduceDelegationState);
      const prospective = sealWorkflowEvent(draft, replayed.lastSequence + 1, replayed.lastHash);
      validateLocked?.(events);
      reduceDelegationState(replayed.state, prospective);
    }, { fault: (stage) => this.options.journalFault?.(type, stage) });
  }

  accept(context: DelegationExecutionContext, input: AcceptDelegationInput): Readonly<{ accepted: true; queued: true; taskId: string }> {
    const caller = this.assertDelegatingContext(context);
    const state = this.restore();
    if (!state.admissionOpen) throw new Error(`Delegation admission is closed: ${state.closedReason ?? "new work rejected"}`);
    const parent = state.topology[caller.nodeId];
    if (!state.topology[input.targetNodeId]) throw new Error(`Unknown target node ${input.targetNodeId}`);
    if (!parent.directMemberIds.includes(input.targetNodeId)) throw new Error(`${input.targetNodeId} is not a direct member of ${caller.nodeId}`);
    const taskId = boundedId(this.options.createTaskId?.() ?? `task-${randomUUID()}`, "Delegation task ID");
    const contextRefs = authorizeReferences(input.contextRefs, input.targetNodeId, this.options.referenceAuthorizer);
    if (input.provenance !== undefined) {
      if (!plainRecord(input.provenance)) throw new Error("Delegation provenance is invalid");
      exactKeys(input.provenance, [], ["correlationId"], "Delegation provenance");
    }
    const provenance: DelegationProvenance = Object.freeze({
      source: "delegate_agent",
      ...(input.provenance?.correlationId === undefined ? {} : { correlationId: boundedId(input.provenance.correlationId, "Correlation ID") }),
      ...(caller.taskId ? { parentTaskId: caller.taskId } : {}),
    });
    this.append("task.accepted", {
      formatVersion: FORMAT_VERSION,
      taskId,
      parentNodeId: caller.nodeId,
      targetNodeId: input.targetNodeId,
      objective: bounded(input.objective, "Delegation objective", LIMITS.objectiveBytes),
      contextRefs: contextRefs as unknown as JsonValue,
      deliverables: [...stringArray(input.deliverables, "Delegation deliverables", LIMITS.deliverables, LIMITS.deliverableBytes)],
      provenance: provenance as unknown as JsonValue,
    }, "runtime", (events) => {
      const admission = this.options.acceptanceAuthority?.admit(events, caller.nodeId);
      if (admission && !admission.ok) {
        throw Object.assign(new Error(admission.reason), {
          policyDenied: true,
          effectNotApplied: true,
          ...(admission.budgetExhausted ? { budgetExhausted: [...admission.exhausted], budgetScope: admission.scope } : {}),
        });
      }
    });
    return Object.freeze({ accepted: true, queued: true, taskId });
  }

  start(taskId: string, attemptId: string): void {
    this.append("task.started", { formatVersion: FORMAT_VERSION, taskId: boundedId(taskId, "Task ID"), attemptId: boundedId(attemptId, "Attempt ID") }, "harness");
  }

  suspend(taskId: string, dependencyTaskIds: readonly string[]): void {
    this.append("task.suspended", { formatVersion: FORMAT_VERSION, taskId: boundedId(taskId, "Task ID"), dependencyTaskIds: [...dependencyTaskIds] }, "harness");
  }

  interrupt(taskId: string, reason: string): void {
    const task = this.restore().tasks[taskId];
    const attemptId = task?.attempts.at(-1)?.attemptId;
    if (!attemptId) throw new Error("Task interruption requires an active attempt");
    this.append("task.interrupted", { formatVersion: FORMAT_VERSION, taskId, attemptId, reason: bounded(reason, "Task interruption reason", LIMITS.resultSummaryBytes) }, "harness");
  }

  reconcileActiveAfterTakeover(verified: boolean, reason = "Verified runtime takeover interrupted the prior attempt"): number {
    const active = Object.values(this.restore().tasks).filter((task) => task.queueState === "active" && task.resumedByResultSequence === undefined);
    if (active.length && !verified) throw new Error("Active delegation recovery requires verified takeover");
    for (const task of active.sort((a, b) => a.creationSequence - b.creationSequence || compare(a.taskId, b.taskId))) {
      const attemptId = task.attempts.at(-1)?.attemptId;
      if (!attemptId) throw new Error("Active delegation task has no attempt to reconcile");
      const pendingDependencies = task.suspendedOn?.filter((dependencyId) => this.restore().tasks[dependencyId]?.resultAcceptedSequence === undefined) ?? [];
      if (pendingDependencies.length) {
        this.append("task.suspended", { formatVersion: FORMAT_VERSION, taskId: task.taskId, dependencyTaskIds: [...task.suspendedOn!] }, "recovery");
      } else {
        this.append("task.interrupted", { formatVersion: FORMAT_VERSION, taskId: task.taskId, attemptId, reason: bounded(reason, "Task interruption reason", LIMITS.resultSummaryBytes) }, "recovery");
      }
    }
    return active.length;
  }

  recordResult(taskId: string, input: WorkerResultInput): void {
    const state = this.restore();
    const task = state.tasks[taskId];
    if (!task) throw new Error(`Unknown delegation task ${taskId}`);
    const result = normalizedResult(input, task, this.options.referenceAuthorizer);
    if (task.queueState !== "queued") result.attemptId = task.attempts.at(-1)!.attemptId;
    this.append("task.result.recorded", { formatVersion: FORMAT_VERSION, taskId, result }, "harness");
  }

  pauseAdmission(reason: string): void {
    if (this.restore().schedulerStatus === "running") this.append("scheduler.paused", { formatVersion: FORMAT_VERSION, reason: bounded(reason, "Scheduler pause reason", LIMITS.resultSummaryBytes) }, "harness");
  }

  resumeAdmission(): void {
    if (this.restore().schedulerStatus === "paused") this.append("scheduler.resumed", { formatVersion: FORMAT_VERSION }, "harness");
  }

  closeAdmission(reason: string): void {
    if (this.restore().schedulerStatus !== "closed") this.append("scheduler.closed", { formatVersion: FORMAT_VERSION, reason: bounded(reason, "Scheduler close reason", LIMITS.resultSummaryBytes) }, "harness");
  }

  cancelPending(reason: string): void {
    this.closeAdmission(reason);
    for (const task of Object.values(this.restore().tasks).sort((a, b) => a.creationSequence - b.creationSequence || compare(a.taskId, b.taskId))) {
      if (task.queueState === "queued" || task.queueState === "suspended") {
        this.recordResult(task.taskId, { status: "cancelled", summary: utf8Prefix(reason, LIMITS.resultSummaryBytes), outputRefs: [], evidenceRefs: [] });
      }
    }
  }

  private preparedForRecipient(recipientNodeId: string): ResultDeliveryBatch | undefined {
    const state = this.restore();
    const delivery = Object.values(state.deliveries).find((candidate) => candidate.recipientNodeId === recipientNodeId && candidate.acceptedSequence === undefined);
    if (!delivery) return undefined;
    const items = delivery.taskIds.map((taskId) => {
      const result = state.tasks[taskId]?.result;
      if (!result) throw new Error("Prepared result delivery references a missing result");
      return Object.freeze({ taskId, result });
    });
    return deepFreeze({ deliveryId: delivery.deliveryId, recipientNodeId, items });
  }

  preparedResultDelivery(context: DelegationExecutionContext): ResultDeliveryBatch | undefined {
    return this.preparedForRecipient(this.assertContext(context).nodeId);
  }

  private prepareForRecipient(recipientNodeId: string, deliveryId: string, options: { limit?: number } = {}): ResultDeliveryBatch {
    const existing = this.preparedForRecipient(recipientNodeId);
    if (existing) {
      if (existing.deliveryId !== deliveryId) throw new Error("An unaccepted result delivery already exists for this recipient");
      return existing;
    }
    const state = this.restore();
    const limit = Number.isSafeInteger(options.limit) && Number(options.limit) > 0 ? Math.min(LIMITS.statusPage, Number(options.limit)) : 20;
    const pending = Object.values(state.tasks)
      .filter((task) => task.parentNodeId === recipientNodeId && task.result && task.resultAcceptedSequence === undefined && task.resultDeliveryPreparedSequence === undefined)
      .sort((a, b) => a.creationSequence - b.creationSequence || compare(a.taskId, b.taskId))
      .slice(0, limit);
    if (!pending.length) throw new Error("No durable worker results are pending for this recipient");
    this.append("task.result.delivery.prepared", {
      formatVersion: FORMAT_VERSION,
      deliveryId: boundedId(deliveryId, "Result delivery ID"),
      recipientNodeId,
      taskIds: pending.map((task) => task.taskId),
    }, "runtime");
    return this.preparedForRecipient(recipientNodeId)!;
  }

  prepareResultDelivery(context: DelegationExecutionContext, deliveryId: string, options: { limit?: number } = {}): ResultDeliveryBatch {
    return this.prepareForRecipient(this.assertContext(context).nodeId, deliveryId, options);
  }

  private acceptForRecipient(recipientNodeId: string, deliveryId: string): void {
    const prepared = this.preparedForRecipient(recipientNodeId);
    if (!prepared || prepared.deliveryId !== deliveryId) throw new Error("Result delivery acceptance does not match a durable preparation");
    this.append("task.result.delivery.accepted", { formatVersion: FORMAT_VERSION, deliveryId, recipientNodeId }, "runtime");
  }

  acceptResultDelivery(context: DelegationExecutionContext, deliveryId: string): void {
    this.acceptForRecipient(this.assertContext(context).nodeId, deliveryId);
  }

  prepareResultDeliveryForSuspendedTask(taskId: string, deliveryId: string, options: { limit?: number } = {}): ResultDeliveryBatch {
    const task = this.restore().tasks[boundedId(taskId, "Suspended parent task ID")];
    if (!task || task.queueState !== "suspended" || !task.attempts.at(-1)?.attemptId) throw new Error("Result delivery bridge requires the current suspended parent task");
    return this.prepareForRecipient(task.targetNodeId, deliveryId, options);
  }

  deliverPendingResultsToSuspendedTask(taskId: string, deliveryId: string, options: { limit?: number } = {}): ResultDeliveryBatch {
    const task = this.restore().tasks[boundedId(taskId, "Suspended parent task ID")];
    if (!task || task.queueState !== "suspended" || !task.attempts.at(-1)?.attemptId) throw new Error("Result delivery bridge requires the current suspended parent task");
    const prepared = this.prepareForRecipient(task.targetNodeId, deliveryId, options);
    this.acceptForRecipient(task.targetNodeId, prepared.deliveryId);
    return prepared;
  }

  status(context: DelegationExecutionContext, options: { limit?: number; cursor?: string } = {}): DelegationStatusPage {
    const caller = this.assertContext(context);
    const state = this.restore();
    const limit = Number.isSafeInteger(options.limit) && Number(options.limit) > 0 ? Math.min(LIMITS.statusPage, Number(options.limit)) : 20;
    let after = 0;
    if (options.cursor !== undefined) {
      if (Buffer.byteLength(options.cursor, "utf8") > LIMITS.cursorBytes || !/^[1-9][0-9]*$/u.test(options.cursor)) throw new Error("Delegation status cursor is invalid");
      after = Number(options.cursor);
      if (!Number.isSafeInteger(after)) throw new Error("Delegation status cursor is invalid");
    }
    const visible = Object.values(state.tasks)
      .filter((task) => caller.nodeId === state.rootNodeId || task.parentNodeId === caller.nodeId || task.targetNodeId === caller.nodeId)
      .sort((a, b) => a.creationSequence - b.creationSequence || compare(a.taskId, b.taskId));
    const summary: Record<DelegationQueueState | WorkerTerminalStatus, number> = { queued: 0, active: 0, suspended: 0, terminal: 0, completed: 0, blocked: 0, failed: 0, cancelled: 0 };
    for (const task of visible) {
      summary[task.queueState]++;
      if (task.result) summary[task.result.status]++;
    }
    const page = visible.filter((task) => task.creationSequence > after).slice(0, limit);
    const items = page.map((task): DelegationStatusItem => Object.freeze({
      taskId: task.taskId,
      parentNodeId: task.parentNodeId,
      targetNodeId: task.targetNodeId,
      objectivePreview: utf8Prefix(task.objective, LIMITS.statusObjectivePreviewBytes),
      creationSequence: task.creationSequence,
      queueState: task.queueState,
      attempts: task.attempts.length,
      ...(task.result ? { terminalStatus: task.result.status } : {}),
      resultAccepted: task.resultAcceptedSequence !== undefined,
    }));
    const hasMore = visible.some((task) => task.creationSequence > (page.at(-1)?.creationSequence ?? after));
    return deepFreeze({ summary, items, ...(hasMore && page.length ? { nextCursor: String(page.at(-1)!.creationSequence) } : {}) });
  }
}

export { LIMITS as DELEGATION_LIMITS, FORMAT_VERSION as DELEGATION_FORMAT_VERSION };
