import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import { canonicalJson } from "../config/snapshot-canonical";
import { resolveProjectPath } from "../core/safe-path";
import {
  DELEGATION_LIMITS,
  type AcceptDelegationInput,
  type DelegationStatusPage,
  type PersistedDelegationTask,
  type PersistedWorkerResult,
  type ResultDeliveryBatch,
  type WorkerResultInput,
} from "./delegation";
import type { RouteDirectMembersInput, RouteRecommendation } from "./routing";
import type { MutationAccountingRecorder } from "./change-accounting";
import type { AttemptConsumerReceiptBinding } from "./attempts";
import type { AcceptedQuestionForTask, QuestionService, TaskQuestionAnswerDelivery } from "./questions";
import { deepFreeze, utf8Prefix } from "./values";
import {
  assembleWorkerWorkflowPrompt,
  assertCompactionPreservation,
  assertLosslessDynamicPromptInputs,
  buildCompactionPreservationBlock,
  losslessDynamicPromptInputs,
  type DynamicPromptInput,
} from "./prompts";

export interface WorkerSessionFactoryInput {
  readonly sessionId: string; readonly runId: string; readonly nodeId: string; readonly agentId: string;
  readonly modelId: string; readonly thinking: string; readonly transcriptPath: string; readonly tools: readonly string[];
}
export interface WorkerPromptTaskContract {
  readonly taskId: string; readonly runId: string; readonly parentNodeId: string; readonly targetNodeId: string;
  readonly objective: string; readonly contextRefs: PersistedDelegationTask["contextRefs"];
  readonly deliverables: readonly string[]; readonly provenance: PersistedDelegationTask["provenance"];
  readonly creationSequence: number; readonly createdAt: string;
  readonly deliveredResults: readonly Readonly<{ taskId: string; result: PersistedWorkerResult }>[];
  readonly acceptedAnswers: readonly AcceptedQuestionForTask[];
}
export interface WorkerPromptContext {
  readonly snapshotHash: string; readonly workflowId: string; readonly nodeId: string; readonly agentId: string;
  readonly agentPrompt: string; readonly sharedInstructions: string; readonly rootInstructions?: string;
  readonly role?: string; readonly responsibilities: readonly string[];
  readonly skills: readonly Readonly<Record<string, unknown>>[];
  readonly knowledge: readonly Readonly<Record<string, unknown>>[];
  readonly adapterContract: Readonly<Record<string, unknown>>;
  readonly effectivePolicy: Readonly<Record<string, unknown>>;
  readonly taskContract: WorkerPromptTaskContract;
  readonly assembledPrompt: string;
  readonly operatingContractHash: string;
  readonly compactionPreservation: string;
  validateCompactionPreservation(value: string): void;
}
export interface WorkerDelegationServices {
  route(input: RouteDirectMembersInput): readonly RouteRecommendation[];
  delegate(input: AcceptDelegationInput): Readonly<{ accepted: true; queued: true; taskId: string }>;
  status(options?: { limit?: number; cursor?: string }): DelegationStatusPage;
  preparedResultDelivery(): ResultDeliveryBatch | undefined;
  prepareResultDelivery(deliveryId: string, options?: { limit?: number }): ResultDeliveryBatch;
  acceptResultDelivery(deliveryId: string): void;
  deliverResults(deliveryId: string, options?: { limit?: number }): ResultDeliveryBatch;
  runWithToolRuntime<T>(callback: () => T): T;
}
export interface WorkerDirectMutationAccounting {
  readonly schemaVersion: 1; readonly attemptId: string; readonly recorder: MutationAccountingRecorder;
}
export interface WorkerTrustedToolExecutionContext {
  readonly schemaVersion: 1; readonly attemptId: string; readonly mutationAccounting?: WorkerDirectMutationAccounting;
}
export interface WorkerTrustedToolDispatchRequest<T> {
  readonly correlationId: string; readonly toolName: string; readonly operation: string; readonly input: unknown;
  readonly policyOutcome: "allowed" | "denied"; readonly denialReason?: string; readonly finalization?: boolean;
  /** Package-validated call IDs for the containing trusted assistant batch. */
  readonly questionBatchCallIds?: readonly string[];
  readonly questionBatchCurrentCallId?: string;
  readonly commandMetadata?: unknown; readonly dispatch: (context: WorkerTrustedToolExecutionContext) => T | Promise<T>;
}
export interface WorkerTrustedDispatch {
  readonly schemaVersion: 1;
  tool<T>(input: WorkerTrustedToolDispatchRequest<T>): Promise<T>;
}
export interface WorkerPromptInvocation {
  readonly schemaVersion: 1;
  readonly promptContext: WorkerPromptContext;
  readonly delegation?: WorkerDelegationServices;
  readonly dispatch?: WorkerTrustedDispatch;
  readonly runWithToolRuntime?: <T>(callback: () => T) => T;
}
export interface WorkerProviderUsage {
  readonly inputTokens: number; readonly outputTokens: number; readonly precision: "estimated" | "provider-confirmed";
}
export interface WorkerPromptResponse { readonly output: string; readonly usage?: WorkerProviderUsage; readonly compactionSummary?: string }
export interface WorkerCompactionBoundary { readonly preservation: string; validate(value: string): void }
export interface WorkerSessionHandle {
  readonly linkedSessionId: string;
  installCompactionBoundary?(boundary: WorkerCompactionBoundary): void;
  prompt(text: string, signal?: AbortSignal, invocation?: WorkerPromptInvocation): string | WorkerPromptResponse | Promise<string | WorkerPromptResponse>;
  abort?(): void | Promise<void>; dispose(): void | Promise<void>;
}
export type WorkerSessionFactory = (input: WorkerSessionFactoryInput) => WorkerSessionHandle | Promise<WorkerSessionHandle>;
export interface WorkerModelDispatchInput {
  readonly task: PersistedDelegationTask; readonly text: string; readonly signal?: AbortSignal; readonly invocation: WorkerPromptInvocation;
  readonly questionDeliveryIds: readonly string[]; readonly promptHash: string; readonly transcriptRef: string;
  /** Includes live-tool deliveries created while this exact provider attempt is running. */
  readonly resolveQuestionDeliveryIds: () => readonly string[];
  readonly onConsumerSuccess: (modelAttemptId: string, binding: AttemptConsumerReceiptBinding) => void;
  readonly questionContinuationReady: () => boolean;
  readonly invoke: () => string | WorkerPromptResponse | Promise<string | WorkerPromptResponse>;
}
export type WorkerModelDispatcher = (input: WorkerModelDispatchInput) => string | WorkerPromptResponse | Promise<string | WorkerPromptResponse>;
export interface WorkerSessionPoolOptions {
  readonly projectRoot: string; readonly sessionId: string; readonly runId: string;
  readonly snapshot: ActivationSnapshotFileV1; readonly factory: WorkerSessionFactory; readonly resultSummaryBytes?: number;
  readonly dispatchModel?: WorkerModelDispatcher;
  readonly dispatchTool?: <T>(task: PersistedDelegationTask, input: WorkerTrustedToolDispatchRequest<T>) => Promise<T>;
  readonly questions?: Pick<QuestionService, "pendingForTask" | "prepareTaskAnswerDeliveries" | "preparedTaskAnswerDeliveries" | "recordTaskAnswerDeliveryReceipt" | "taskAnswerDeliveryReturnedByTool" | "acceptTaskAnswerDelivery" | "markTaskConsumerReplaySettled">;
}
export type WorkerExecutionResult = WorkerResultInput
  | Readonly<{ status: "suspended"; dependencyTaskIds?: readonly string[]; questionIds?: readonly string[] }>
  | Readonly<{ status: "continuation"; questionIds: readonly string[] }>;

interface WorkerExecutionConfig {
  readonly agentId: string; readonly modelId: string; readonly thinking: string; readonly tools: readonly string[];
}
interface PooledSession {
  readonly nodeId: string; readonly transcriptPath: string; readonly session: WorkerSessionHandle;
}
interface BoundaryRecord {
  readonly formatVersion: 1; readonly runId: string; readonly nodeId: string; readonly taskId: string;
  readonly kind: "start" | "result"; readonly creationSequence: number; readonly payloadHash: string;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedId(value: string, label: string): string {
  const unsafe = [...value].some((character) => character === "/" || character === "\\" || character.codePointAt(0)! <= 0x1f);
  if (!value || Buffer.byteLength(value, "utf8") > 256 || unsafe) throw new Error(`${label} is invalid`);
  return value;
}

function workerDirectory(projectRoot: string, sessionId: string, runId: string): string {
  boundedId(sessionId, "Worker session ID");
  boundedId(runId, "Worker run ID");
  const resolved = resolveProjectPath(projectRoot, `.pi/hive/sessions/${sessionId}/runs/${runId}/workers`, { allowMissing: true });
  if (!resolved) throw new Error("Worker transcript path escapes project");
  return resolved.lexicalPath;
}

export function workerTranscriptPath(projectRoot: string, sessionId: string, runId: string, nodeId: string): string {
  return join(workerDirectory(projectRoot, sessionId, runId), `${boundedId(nodeId, "Worker node ID")}.jsonl`);
}

function ensureTranscript(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600));
  chmodSync(path, 0o600);
}

function boundaryHash(value: unknown): string {
  return createHash("sha256").update("pi-hive-worker-boundary-v1\0").update(canonicalJson(value)).digest("hex");
}

function writeBoundary(base: string, task: PersistedDelegationTask, kind: "start" | "result", payload: unknown): void {
  const directory = join(base, `${boundedId(task.targetNodeId, "Worker node ID")}.boundaries`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const record: BoundaryRecord = {
    formatVersion: 1,
    runId: task.runId,
    nodeId: task.targetNodeId,
    taskId: task.taskId,
    kind,
    creationSequence: task.creationSequence,
    payloadHash: boundaryHash(payload),
  };
  const content = `${canonicalJson(record)}\n`;
  const path = join(directory, `${String(task.creationSequence).padStart(16, "0")}-${kind === "start" ? 0 : 1}-${kind}-${boundedId(task.taskId, "Worker task ID")}.json`);
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== content) throw new Error("Worker boundary conflict with authoritative journal projection");
    return;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { unlinkSync(temporary); } catch { /* published or absent */ }
  }
}

function snapshotExecutionConfig(snapshot: ActivationSnapshotFileV1, nodeId: string): WorkerExecutionConfig {
  const team = snapshot.payload.workflow.team as { nodes?: unknown } | undefined;
  const nodes = Array.isArray(team?.nodes) ? team.nodes : [];
  const node = nodes.find((entry) => plainRecord(entry) && entry.id === nodeId);
  if (!plainRecord(node) || typeof node.agentId !== "string" || !node.agentId) throw new Error(`Snapshot target node ${nodeId} is missing`);
  const authority = snapshot.payload.authority.nodes.find((entry) => entry.nodeId === nodeId);
  const model = snapshot.payload.models.find((entry) => entry.nodeId === nodeId);
  const agent = snapshot.payload.agents.find((entry) => entry.id === node.agentId);
  if (!plainRecord(authority) || !model || !plainRecord(agent)) throw new Error(`Snapshot execution configuration for ${nodeId} is incomplete`);
  if (!Array.isArray(authority.tools) || authority.tools.some((tool) => typeof tool !== "string")) throw new Error(`Snapshot tools for ${nodeId} are invalid`);
  if (authority.tools.includes("workflow_finish")) throw new Error(`Worker snapshot tools for ${nodeId} illegally include workflow_finish`);
  if (typeof model.modelId !== "string" || !model.modelId || typeof model.thinking !== "string" || !model.thinking) throw new Error(`Snapshot model configuration for ${nodeId} is invalid`);
  return Object.freeze({
    agentId: node.agentId,
    modelId: model.modelId,
    thinking: model.thinking,
    tools: Object.freeze([...authority.tools]),
  });
}

function resolvedAttachmentIds(value: unknown): readonly string[] {
  if (!plainRecord(value) || !Array.isArray(value.resolved) || value.resolved.some((entry) => typeof entry !== "string")) return Object.freeze([]);
  return Object.freeze([...value.resolved].sort());
}

function frozenRecord(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return deepFreeze(structuredClone(value));
}

export function deriveWorkerPromptContext(
  snapshot: ActivationSnapshotFileV1,
  task: PersistedDelegationTask,
  deliveredResults: readonly Readonly<{ taskId: string; result: PersistedWorkerResult }>[] = [],
  sessionId = task.runId,
  acceptedAnswers: readonly AcceptedQuestionForTask[] = [],
): WorkerPromptContext {
  const workflow = snapshot.payload.workflow;
  const team = plainRecord(workflow.team) ? workflow.team : undefined;
  const nodes = Array.isArray(team?.nodes) ? team.nodes : [];
  const node = nodes.find((entry) => plainRecord(entry) && entry.id === task.targetNodeId);
  if (!plainRecord(node) || typeof node.agentId !== "string") throw new Error(`Snapshot prompt context for ${task.targetNodeId} is missing`);
  const agent = snapshot.payload.agents.find((entry) => entry.id === node.agentId);
  const authority = snapshot.payload.authority.nodes.find((entry) => entry.nodeId === task.targetNodeId);
  if (!plainRecord(agent) || typeof agent.prompt !== "string" || !plainRecord(authority) || !plainRecord(authority.capabilities)) {
    throw new Error(`Snapshot prompt context for ${task.targetNodeId} is incomplete`);
  }
  const instructions = plainRecord(workflow.instructions) ? workflow.instructions : {};
  const skillIds = new Set(resolvedAttachmentIds(node.skills));
  const knowledgeIds = new Set(resolvedAttachmentIds(node.knowledge));
  const responsibilities = Array.isArray(node.responsibilities) && node.responsibilities.every((entry) => typeof entry === "string")
    ? node.responsibilities as string[]
    : [];
  const skills = snapshot.payload.skills
    .filter((entry) => typeof entry.id === "string" && skillIds.has(entry.id))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map(frozenRecord);
  const knowledge = snapshot.payload.knowledge
    .filter((entry) => typeof entry.id === "string" && knowledgeIds.has(entry.id))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map(frozenRecord);
  const adapter = plainRecord(workflow.artifact) ? workflow.artifact : {};
  const taskContract: WorkerPromptTaskContract = deepFreeze({
    taskId: task.taskId,
    runId: task.runId,
    parentNodeId: task.parentNodeId,
    targetNodeId: task.targetNodeId,
    objective: task.objective,
    contextRefs: structuredClone(task.contextRefs),
    deliverables: [...task.deliverables],
    provenance: structuredClone(task.provenance),
    creationSequence: task.creationSequence,
    createdAt: task.createdAt,
    deliveredResults: structuredClone(deliveredResults),
    acceptedAnswers: structuredClone(acceptedAnswers),
  });
  const promptRefs: DynamicPromptInput[] = task.contextRefs.map((entry) => {
    const source = entry.ref.kind === "artifact" || entry.ref.kind === "knowledge" || entry.ref.kind === "repository"
      ? entry.ref.kind
      : "external";
    return {
      source,
      provenance: `${entry.ref.kind}:${entry.ref.id}`,
      content: entry.authorization === "authorized" ? (entry.resolved ?? { ref: entry.ref, authorization: "authorized" }) : { ref: entry.ref, authorization: "denied", diagnostic: entry.diagnostic },
      ref: `${entry.ref.kind}:${entry.ref.id}`,
    };
  });
  for (const delivered of deliveredResults) promptRefs.push({
    source: "tool-output",
    provenance: `worker-result:${delivered.taskId}@${delivered.result.recordedSequence}`,
    content: delivered.result,
    ref: `run:${task.runId}/task:${delivered.taskId}/result`,
  });
  const answerPromptInputs = acceptedAnswers.flatMap((accepted) => losslessDynamicPromptInputs({
    provenance: `human-answer:${accepted.questionId}:${accepted.answer.channel}:${accepted.answer.identity}`,
    content: { questionId: accepted.questionId, definition: accepted.definition, answer: accepted.answer },
    ref: accepted.transcriptRef,
  }));
  promptRefs.push(...answerPromptInputs);
  const assembled = assembleWorkerWorkflowPrompt({
    snapshot,
    nodeId: task.targetNodeId,
    sessionId,
    runId: task.runId,
    task: { taskId: task.taskId, parentNodeId: task.parentNodeId, objective: task.objective, deliverables: task.deliverables, refs: promptRefs },
  });
  assertLosslessDynamicPromptInputs(assembled, answerPromptInputs);
  return deepFreeze({
    snapshotHash: snapshot.snapshotHash,
    workflowId: typeof workflow.id === "string" ? workflow.id : "",
    nodeId: task.targetNodeId,
    agentId: node.agentId,
    agentPrompt: agent.prompt,
    sharedInstructions: typeof instructions.shared === "string" ? instructions.shared : "",
    ...(task.targetNodeId === team?.rootId && typeof instructions.root === "string" ? { rootInstructions: instructions.root } : {}),
    ...(typeof node.role === "string" ? { role: node.role } : {}),
    responsibilities: [...responsibilities],
    skills,
    knowledge,
    adapterContract: frozenRecord(adapter),
    effectivePolicy: frozenRecord(authority.capabilities),
    taskContract,
    assembledPrompt: assembled.text,
    operatingContractHash: assembled.contractHash,
    compactionPreservation: buildCompactionPreservationBlock(assembled),
    validateCompactionPreservation: (value: string) => assertCompactionPreservation(value, assembled),
  });
}

function selectTaskAnswerPromptPage(
  snapshot: ActivationSnapshotFileV1,
  task: PersistedDelegationTask,
  deliveredResults: readonly Readonly<{ taskId: string; result: PersistedWorkerResult }>[],
  sessionId: string,
  prepared: readonly TaskQuestionAnswerDelivery[],
): Readonly<{ deliveries: readonly TaskQuestionAnswerDelivery[]; promptContext: WorkerPromptContext }> {
  const selected: TaskQuestionAnswerDelivery[] = [];
  let promptContext = deriveWorkerPromptContext(snapshot, task, deliveredResults, sessionId);
  for (const delivery of prepared) {
    try {
      const candidate = [...selected, delivery];
      promptContext = deriveWorkerPromptContext(snapshot, task, deliveredResults, sessionId, candidate.flatMap((entry) => entry.answers));
      selected.push(delivery);
    } catch (error) {
      if (!selected.length || !String(error instanceof Error ? error.message : error).includes("Authority-relevant prompt data was omitted or truncated")) throw error;
      break;
    }
  }
  return Object.freeze({ deliveries: Object.freeze(selected), promptContext });
}

export class WorkerSessionPool {
  private readonly options: WorkerSessionPoolOptions;
  private readonly sessions = new Map<string, PooledSession>();
  private readonly opening = new Map<string, Promise<PooledSession>>();
  private readonly activeExecutions = new Set<Promise<WorkerExecutionResult>>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(options: WorkerSessionPoolOptions) {
    boundedId(options.sessionId, "Worker session ID");
    boundedId(options.runId, "Worker run ID");
    if (options.resultSummaryBytes !== undefined && (!Number.isSafeInteger(options.resultSummaryBytes) || options.resultSummaryBytes < 1 || options.resultSummaryBytes > DELEGATION_LIMITS.resultSummaryBytes)) {
      throw new Error("Worker result bound invalid");
    }
    this.options = options;
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  get activeExecutionCount(): number {
    return this.activeExecutions.size;
  }

  hasLiveHandles(): boolean {
    return this.sessions.size > 0 || this.opening.size > 0 || this.activeExecutions.size > 0 || this.closing !== undefined;
  }

  private async get(task: PersistedDelegationTask): Promise<PooledSession> {
    if (this.closed) throw new Error("Worker session pool is closed");
    if (task.runId !== this.options.runId) throw new Error("Worker task belongs to another run");
    const existing = this.sessions.get(task.targetNodeId);
    if (existing) return existing;
    const pending = this.opening.get(task.targetNodeId);
    if (pending) return pending;
    const opening = (async (): Promise<PooledSession> => {
      const transcriptPath = workerTranscriptPath(this.options.projectRoot, this.options.sessionId, this.options.runId, task.targetNodeId);
      ensureTranscript(transcriptPath);
      const config = snapshotExecutionConfig(this.options.snapshot, task.targetNodeId);
      const session = await this.options.factory({
        sessionId: this.options.sessionId,
        runId: this.options.runId,
        nodeId: task.targetNodeId,
        agentId: config.agentId,
        modelId: config.modelId,
        thinking: config.thinking,
        transcriptPath,
        tools: config.tools,
      });
      if (!session?.linkedSessionId || typeof session.prompt !== "function" || typeof session.dispose !== "function") throw new Error("Invalid linked worker session");
      if (this.closed) {
        try { await session.abort?.(); } finally { await session.dispose(); }
        throw new Error("Worker pool closed during creation");
      }
      const pooled = { nodeId: task.targetNodeId, transcriptPath, session };
      this.sessions.set(task.targetNodeId, pooled);
      return pooled;
    })().finally(() => { this.opening.delete(task.targetNodeId); });
    this.opening.set(task.targetNodeId, opening);
    return opening;
  }

  execute(
    task: PersistedDelegationTask,
    signal?: AbortSignal,
    services?: WorkerDelegationServices,
    deliveredResults: WorkerPromptTaskContract["deliveredResults"] = [],
  ): Promise<WorkerExecutionResult> {
    const delegatedTaskIds: string[] = [];
    const delegation = services ? Object.freeze({
      route: (input: RouteDirectMembersInput) => services.route(input),
      delegate: (input: AcceptDelegationInput) => {
        const accepted = services.delegate(input);
        delegatedTaskIds.push(accepted.taskId);
        return accepted;
      },
      status: (options: { limit?: number; cursor?: string } = {}) => services.status(options),
      preparedResultDelivery: () => services.preparedResultDelivery(),
      prepareResultDelivery: (deliveryId: string, options: { limit?: number } = {}) => services.prepareResultDelivery(deliveryId, options),
      acceptResultDelivery: (deliveryId: string) => services.acceptResultDelivery(deliveryId),
      deliverResults: (deliveryId: string, options: { limit?: number } = {}) => services.deliverResults(deliveryId, options),
      runWithToolRuntime: <T>(callback: () => T): T => services.runWithToolRuntime(callback),
    }) satisfies WorkerDelegationServices : undefined;
    const preparedAnswerDeliveries: readonly TaskQuestionAnswerDelivery[] = this.options.questions?.prepareTaskAnswerDeliveries(task.taskId) ?? [];
    const answerPage = selectTaskAnswerPromptPage(this.options.snapshot, task, deliveredResults, this.options.sessionId, preparedAnswerDeliveries);
    const answerDeliveries = answerPage.deliveries;
    const promptContext = answerPage.promptContext;
    const promptHash = createHash("sha256").update(promptContext.assembledPrompt).digest("hex");
    const transcriptRef = `run:${task.runId}/node:${task.targetNodeId}/task:${task.taskId}/transcript`;
    const consumedDeliveryIds = new Set<string>();
    let consumerCompletionObserved = false;
    let recoveredConsumerReplay = false;
    const markRecoveredContinuation = (questionIds: readonly string[]): void => {
      if (!recoveredConsumerReplay) return;
      const taskAttemptId = task.attempts.at(-1)?.attemptId;
      if (!taskAttemptId) throw new Error("Recovered worker continuation is missing its immutable task attempt");
      this.options.questions?.markTaskConsumerReplaySettled(task.taskId, taskAttemptId, questionIds);
    };
    const recordConsumerSuccess = (attemptId: string, binding: AttemptConsumerReceiptBinding): void => {
      consumerCompletionObserved = true;
      if (binding.transcriptRef !== transcriptRef) throw new Error("Worker consumer settlement transcript does not match the task transcript");
      if (binding.promptHash !== promptHash) recoveredConsumerReplay = true;
      const boundDeliveryIds = new Set(binding.deliveryIds);
      const prepared = this.options.questions?.preparedTaskAnswerDeliveries(task.taskId) ?? answerDeliveries;
      for (const delivery of prepared) {
        if (!boundDeliveryIds.has(delivery.deliveryId)) continue;
        try { this.options.questions?.recordTaskAnswerDeliveryReceipt(delivery, { promptHash: binding.promptHash, attemptId, transcriptRef: binding.transcriptRef }); }
        catch {
          // A completed containing attempt is retryable control settlement. A
          // second publication attempt never re-invokes the provider.
          this.options.questions?.recordTaskAnswerDeliveryReceipt(delivery, { promptHash: binding.promptHash, attemptId, transcriptRef: binding.transcriptRef });
        }
        consumedDeliveryIds.add(delivery.deliveryId);
      }
    };
    const dispatch: WorkerTrustedDispatch | undefined = this.options.dispatchTool ? Object.freeze({
      schemaVersion: 1 as const,
      tool: <T>(input: WorkerTrustedToolDispatchRequest<T>) => this.options.dispatchTool!(task, input),
    }) : undefined;
    const invocation: WorkerPromptInvocation = Object.freeze({
      schemaVersion: 1 as const,
      promptContext,
      ...(delegation ? { delegation, runWithToolRuntime: delegation.runWithToolRuntime } : {}),
      ...(dispatch ? { dispatch } : {}),
    });
    const execution = (async (): Promise<WorkerExecutionResult> => {
      try {
        const pooled = await this.get(task);
        if (signal?.aborted) throw new Error("Worker task cancelled before model execution");
        const text = promptContext.assembledPrompt;
        pooled.session.installCompactionBoundary?.(Object.freeze({
          preservation: promptContext.compactionPreservation,
          validate: promptContext.validateCompactionPreservation,
        }));
        let consumerReceiptRecorded = false;
        const response = await (this.options.dispatchModel
          ? this.options.dispatchModel({
            task, text, signal, invocation, promptHash, transcriptRef,
            questionDeliveryIds: answerDeliveries.map((delivery) => delivery.deliveryId),
            resolveQuestionDeliveryIds: () => {
              const deliveries = this.options.questions?.preparedTaskAnswerDeliveries(task.taskId) ?? answerDeliveries;
              return [...new Set(deliveries.filter((delivery) => answerDeliveries.some((candidate) => candidate.deliveryId === delivery.deliveryId)
                || this.options.questions?.taskAnswerDeliveryReturnedByTool(delivery)).map((delivery) => delivery.deliveryId))];
            },
            onConsumerSuccess: (attemptId, binding) => { recordConsumerSuccess(attemptId, binding); consumerReceiptRecorded = true; },
            questionContinuationReady: () => {
              const pending = this.options.questions?.pendingForTask(task.taskId) ?? [];
              const prepared = this.options.questions?.prepareTaskAnswerDeliveries(task.taskId) ?? [];
              return pending.length === 0 && prepared.some((delivery) => !answerDeliveries.some((included) => included.deliveryId === delivery.deliveryId));
            },
            invoke: () => pooled.session.prompt(text, signal, invocation),
          })
          : pooled.session.prompt(text, signal, invocation));
        if (!consumerReceiptRecorded) {
          const prepared = this.options.questions?.preparedTaskAnswerDeliveries(task.taskId) ?? answerDeliveries;
          const deliveryIds = prepared.filter((delivery) => answerDeliveries.some((candidate) => candidate.deliveryId === delivery.deliveryId)
            || this.options.questions?.taskAnswerDeliveryReturnedByTool(delivery)).map((delivery) => delivery.deliveryId);
          recordConsumerSuccess(task.attempts.at(-1)?.attemptId ?? `task-${task.taskId}-transcript`, { deliveryIds, promptHash, transcriptRef });
        }
        let output: string;
        if (plainRecord(response)) {
          if (typeof response.output !== "string") throw new Error("Worker prompt response output is invalid");
          if (response.compactionSummary !== undefined) {
            if (typeof response.compactionSummary !== "string") throw new Error("Worker compaction summary is invalid");
            promptContext.validateCompactionPreservation(response.compactionSummary);
          }
          output = response.output;
          if (response.usage !== undefined && (!plainRecord(response.usage) || !Number.isSafeInteger(response.usage.inputTokens) || Number(response.usage.inputTokens) < 0
            || !Number.isSafeInteger(response.usage.outputTokens) || Number(response.usage.outputTokens) < 0
            || (response.usage.precision !== "estimated" && response.usage.precision !== "provider-confirmed"))) throw new Error("Worker provider usage is invalid");
        } else output = String(response ?? "");
        for (const delivery of this.options.questions?.preparedTaskAnswerDeliveries(task.taskId) ?? answerDeliveries) {
          if (!consumedDeliveryIds.has(delivery.deliveryId)) continue;
          try { this.options.questions?.acceptTaskAnswerDelivery(delivery); }
          catch {
            // A before-publication acceptance fault is safe to retry because the
            // exact consumer receipt is already authoritative and idempotent.
            this.options.questions?.acceptTaskAnswerDelivery(delivery);
          }
        }
        const pendingQuestionIds = this.options.questions?.pendingForTask(task.taskId).map((question) => question.questionId) ?? [];
        const newlyPrepared = this.options.questions?.prepareTaskAnswerDeliveries(task.taskId) ?? [];
        const continuationQuestionIds = newlyPrepared.filter((delivery) => !consumedDeliveryIds.has(delivery.deliveryId)).flatMap((delivery) => delivery.questionIds);
        if (delegatedTaskIds.length && (pendingQuestionIds.length || continuationQuestionIds.length)) throw new Error("Worker turn cannot suspend on delegation dependencies and human questions simultaneously");
        if (pendingQuestionIds.length && !signal?.aborted && !this.closed) {
          return Object.freeze({ status: "suspended" as const, questionIds: Object.freeze([...new Set(pendingQuestionIds)]) });
        }
        if (continuationQuestionIds.length && !signal?.aborted && !this.closed) {
          const questionIds = Object.freeze([...new Set(continuationQuestionIds)]);
          markRecoveredContinuation(questionIds);
          return Object.freeze({ status: "continuation" as const, questionIds });
        }
        if (delegatedTaskIds.length && !signal?.aborted && !this.closed) {
          return Object.freeze({ status: "suspended" as const, dependencyTaskIds: Object.freeze([...new Set(delegatedTaskIds)]) });
        }
        return {
          status: signal?.aborted || this.closed ? "cancelled" : "completed",
          summary: utf8Prefix(output || "[no worker output]", this.options.resultSummaryBytes ?? DELEGATION_LIMITS.resultSummaryBytes),
          outputRefs: [],
          evidenceRefs: [],
          data: { linkedSessionId: pooled.session.linkedSessionId },
        };
      } catch (error) {
        const detail = error && typeof error === "object" ? error as Record<string, unknown> : {};
        const pendingQuestionIds = this.options.questions?.pendingForTask(task.taskId).map((question) => question.questionId) ?? [];
        let continuationQuestionIds: readonly string[] = [];
        try {
          continuationQuestionIds = (this.options.questions?.prepareTaskAnswerDeliveries(task.taskId) ?? [])
            .filter((delivery) => !answerDeliveries.some((included) => included.deliveryId === delivery.deliveryId) || consumedDeliveryIds.has(delivery.deliveryId))
            .flatMap((delivery) => delivery.questionIds);
        } catch {
          continuationQuestionIds = (this.options.questions?.preparedTaskAnswerDeliveries(task.taskId) ?? [])
            .filter((delivery) => consumedDeliveryIds.has(delivery.deliveryId))
            .flatMap((delivery) => delivery.questionIds);
        }
        if (pendingQuestionIds.length && !delegatedTaskIds.length && !signal?.aborted && !this.closed) {
          return Object.freeze({ status: "suspended" as const, questionIds: Object.freeze([...new Set(pendingQuestionIds)]) });
        }
        const providerKnownNotApplied = detail.effectNotApplied === true
          || (detail.assistantOutputObserved === false && detail.toolCallObserved === false);
        if (providerKnownNotApplied && !detail.policyDenied && !Array.isArray(detail.budgetExhausted) && !consumerCompletionObserved
          && answerDeliveries.length && !delegatedTaskIds.length && !signal?.aborted && !this.closed) {
          // Keep the answer undelivered: scheduler settlement advances only the
          // durable continuation-turn identity, never this failed consumer.
          return Object.freeze({ status: "continuation" as const, questionIds: Object.freeze([...new Set(answerDeliveries.flatMap((delivery) => delivery.questionIds))]) });
        }
        if ((continuationQuestionIds.length || (consumerCompletionObserved && answerDeliveries.length)) && !delegatedTaskIds.length && !signal?.aborted && !this.closed) {
          const ids = Object.freeze([...new Set(continuationQuestionIds.length ? continuationQuestionIds : answerDeliveries.flatMap((delivery) => delivery.questionIds))]);
          markRecoveredContinuation(ids);
          return Object.freeze({ status: "continuation" as const, questionIds: ids });
        }
        if (delegatedTaskIds.length && !pendingQuestionIds.length && !continuationQuestionIds.length && !signal?.aborted && !this.closed) {
          return Object.freeze({ status: "suspended" as const, dependencyTaskIds: Object.freeze([...new Set(delegatedTaskIds)]) });
        }
        const budgetExhausted = Array.isArray(detail.budgetExhausted) ? detail.budgetExhausted.filter((item): item is string => typeof item === "string").slice(0, 32) : [];
        return {
          status: signal?.aborted || this.closed ? "cancelled" : budgetExhausted.length ? "blocked" : "failed",
          summary: utf8Prefix(String(error instanceof Error ? error.message : error), this.options.resultSummaryBytes ?? DELEGATION_LIMITS.resultSummaryBytes),
          outputRefs: [],
          evidenceRefs: [],
          data: budgetExhausted.length ? { budgetExhausted } : {},
        };
      }
    })();
    this.activeExecutions.add(execution);
    void execution.then(
      () => { this.activeExecutions.delete(execution); },
      () => { this.activeExecutions.delete(execution); },
    );
    return execution;
  }

  rebuildBoundaries(tasks: readonly PersistedDelegationTask[]): void {
    const base = workerDirectory(this.options.projectRoot, this.options.sessionId, this.options.runId);
    const ordered = [...tasks]
      .filter((task) => task.runId === this.options.runId)
      .sort((a, b) => a.creationSequence - b.creationSequence || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    for (const task of ordered) {
      if (task.attempts.length) {
        writeBoundary(base, task, "start", {
          objective: task.objective,
          contextRefs: task.contextRefs,
          deliverables: task.deliverables,
          provenance: task.provenance,
        });
      }
      if (task.result) writeBoundary(base, task, "result", task.result);
    }
  }

  async abortSessionsExcept(nodeId: string): Promise<void> {
    const sessions = [...this.sessions.values()].filter((pooled) => pooled.nodeId !== nodeId);
    for (const pooled of sessions) this.sessions.delete(pooled.nodeId);
    await Promise.allSettled(sessions.map(async ({ session }) => {
      try { await session.abort?.(); } finally { await session.dispose(); }
    }));
  }

  async closeSessions(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed && !this.sessions.size) return;
    this.closed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const closing = Promise.allSettled(sessions.map(async ({ session }) => {
      try { await session.abort?.(); } finally { await session.dispose(); }
    })).then(() => undefined);
    this.closing = closing;
    try {
      await closing;
    } finally {
      if (this.closing === closing) this.closing = undefined;
    }
  }

  async waitForSettlement(timeoutMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error("Worker settlement timeout is invalid");
    const pending = [...this.activeExecutions, ...this.opening.values()];
    if (!pending.length) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.allSettled(pending).then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
