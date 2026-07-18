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
import { NO_DLP_PROSE_LIMITATION } from "./references";
import { deepFreeze, utf8Prefix } from "./values";

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
}
export interface WorkerDelegationServices {
  route(input: RouteDirectMembersInput): readonly RouteRecommendation[];
  delegate(input: AcceptDelegationInput): Readonly<{ accepted: true; queued: true; taskId: string }>;
  status(options?: { limit?: number; cursor?: string }): DelegationStatusPage;
  preparedResultDelivery(): ResultDeliveryBatch | undefined;
  prepareResultDelivery(deliveryId: string, options?: { limit?: number }): ResultDeliveryBatch;
  acceptResultDelivery(deliveryId: string): void;
}
export interface WorkerPromptInvocation {
  readonly promptContext: WorkerPromptContext;
  readonly delegation?: WorkerDelegationServices;
}
export interface WorkerSessionHandle {
  readonly linkedSessionId: string;
  prompt(text: string, signal?: AbortSignal, invocation?: WorkerPromptInvocation): string | Promise<string>;
  abort?(): void | Promise<void>; dispose(): void | Promise<void>;
}
export type WorkerSessionFactory = (input: WorkerSessionFactoryInput) => WorkerSessionHandle | Promise<WorkerSessionHandle>;
export interface WorkerSessionPoolOptions {
  readonly projectRoot: string; readonly sessionId: string; readonly runId: string;
  readonly snapshot: ActivationSnapshotFileV1; readonly factory: WorkerSessionFactory; readonly resultSummaryBytes?: number;
}
export type WorkerExecutionResult = WorkerResultInput | Readonly<{ status: "suspended"; dependencyTaskIds: readonly string[] }>;

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

function renderTask(task: PersistedDelegationTask, deliveredResults: WorkerPromptTaskContract["deliveredResults"]): string {
  const references = task.contextRefs.map((entry) => entry.authorization === "authorized"
    ? { ref: entry.ref, authorization: entry.authorization, ...(entry.resolved === undefined ? {} : { resolved: entry.resolved }) }
    : { ref: entry.ref, authorization: entry.authorization, diagnostic: entry.diagnostic });
  return [
    "## Delegation task boundary",
    `task_id: ${task.taskId}`,
    `run_id: ${task.runId}`,
    `node_id: ${task.targetNodeId}`,
    "",
    "### Objective",
    task.objective,
    "",
    "### Authorized structured context",
    canonicalJson(references),
    "",
    "### Deliverables",
    ...task.deliverables.map((deliverable) => `- ${deliverable}`),
    ...(deliveredResults.length ? ["", "### Durably delivered child results", canonicalJson(deliveredResults)] : []),
    "",
    `Safety limitation: ${NO_DLP_PROSE_LIMITATION}`,
    "Return a concise bounded result. Do not attempt to finish or close the workflow run.",
  ].join("\n");
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
  });
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
  });
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
    }) satisfies WorkerDelegationServices : undefined;
    const promptContext = deriveWorkerPromptContext(this.options.snapshot, task, deliveredResults);
    const invocation: WorkerPromptInvocation = Object.freeze({ promptContext, ...(delegation ? { delegation } : {}) });
    const execution = (async (): Promise<WorkerExecutionResult> => {
      try {
        const pooled = await this.get(task);
        if (signal?.aborted) throw new Error("Worker task cancelled before model execution");
        const output = await pooled.session.prompt(renderTask(task, deliveredResults), signal, invocation);
        if (delegatedTaskIds.length && !signal?.aborted && !this.closed) {
          return Object.freeze({ status: "suspended" as const, dependencyTaskIds: Object.freeze([...new Set(delegatedTaskIds)]) });
        }
        return {
          status: signal?.aborted || this.closed ? "cancelled" : "completed",
          summary: utf8Prefix(String(output || "[no worker output]"), this.options.resultSummaryBytes ?? DELEGATION_LIMITS.resultSummaryBytes),
          outputRefs: [],
          evidenceRefs: [],
          data: { linkedSessionId: pooled.session.linkedSessionId },
        };
      } catch (error) {
        if (delegatedTaskIds.length && !signal?.aborted && !this.closed) {
          return Object.freeze({ status: "suspended" as const, dependencyTaskIds: Object.freeze([...new Set(delegatedTaskIds)]) });
        }
        return {
          status: signal?.aborted || this.closed ? "cancelled" : "failed",
          summary: utf8Prefix(String(error instanceof Error ? error.message : error), this.options.resultSummaryBytes ?? DELEGATION_LIMITS.resultSummaryBytes),
          outputRefs: [],
          evidenceRefs: [],
          data: {},
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
