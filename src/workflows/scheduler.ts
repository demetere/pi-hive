import { randomUUID } from "node:crypto";
import {
  DELEGATION_LIMITS,
  type DelegationExecutionContext,
  type DelegationRuntime,
  type PersistedDelegationTask,
  type WorkerResultInput,
} from "./delegation";
import { compareText as compare, utf8Prefix } from "./values";

export type SchedulerExecutionResult = WorkerResultInput | Readonly<{ status: "suspended"; dependencyTaskIds: readonly string[] }>;

export interface SchedulerTaskControl {
  readonly signal: AbortSignal; readonly attemptId: string;
  readonly executionContext: DelegationExecutionContext;
}
export interface SchedulerAttemptHooks {
  readonly onAttemptStarted?: (task: PersistedDelegationTask, attemptId: string) => void | Promise<void>;
  readonly onAttemptSettled?: (task: PersistedDelegationTask, attemptId: string, result: SchedulerExecutionResult) => void | Promise<void>;
}
export interface DurableDelegationSchedulerOptions {
  readonly runtime: DelegationRuntime; readonly maxParallel: number;
  readonly execute: (task: PersistedDelegationTask, control: SchedulerTaskControl) => SchedulerExecutionResult | Promise<SchedulerExecutionResult>;
  readonly createAttemptId?: () => string; readonly hooks?: SchedulerAttemptHooks;
  readonly verifiedTakeover?: () => boolean | Promise<boolean>;
  readonly onRecoveryReconciled?: () => void | Promise<void>;
  readonly onResultDurable?: (task: PersistedDelegationTask) => void | Promise<void>;
}
interface ActiveExecution {
  readonly nodeId: string; readonly attemptId: string;
  readonly controller: AbortController; readonly promise: Promise<void>;
}

function validateExecutionResult(value: SchedulerExecutionResult): void {
  if (!value || typeof value !== "object") throw new Error("Worker executor returned no result");
  if (value.status === "suspended") {
    if (!Array.isArray(value.dependencyTaskIds) || value.dependencyTaskIds.length === 0) throw new Error("Suspended worker returned no dependency tasks");
    return;
  }
  if (value.status !== "completed" && value.status !== "blocked" && value.status !== "failed" && value.status !== "cancelled") {
    throw new Error("Worker executor returned an invalid terminal status");
  }
}

/**
 * Fairness v1: preserve FIFO within each node, then choose the eligible node
 * with the least recent durable start sequence; creation sequence, node ID,
 * and task ID are stable tie-breakers.
 */
export function selectNextDelegationTask(runtime: DelegationRuntime, activeNodes: ReadonlySet<string> = new Set()): PersistedDelegationTask | undefined {
  const state = runtime.restore();
  const nodeQueues = new Map<string, PersistedDelegationTask[]>();
  const lastDispatched = new Map<string, number>();
  for (const task of Object.values(state.tasks)) {
    if (task.lastStartedSequence !== undefined) {
      lastDispatched.set(task.targetNodeId, Math.max(lastDispatched.get(task.targetNodeId) ?? 0, task.lastStartedSequence));
    }
    if (task.queueState === "terminal") continue;
    const queue = nodeQueues.get(task.targetNodeId) ?? [];
    queue.push(task);
    nodeQueues.set(task.targetNodeId, queue);
  }
  const eligible: PersistedDelegationTask[] = [];
  for (const [nodeId, queue] of nodeQueues) {
    if (activeNodes.has(nodeId)) continue;
    const head = queue.sort((a, b) => a.creationSequence - b.creationSequence || compare(a.taskId, b.taskId))[0];
    if (head?.queueState === "queued" || (head?.queueState === "active" && head.resumedByResultSequence !== undefined)) eligible.push(head);
  }
  return eligible.sort((a, b) =>
    (lastDispatched.get(a.targetNodeId) ?? 0) - (lastDispatched.get(b.targetNodeId) ?? 0)
    || a.creationSequence - b.creationSequence
    || compare(a.targetNodeId, b.targetNodeId)
    || compare(a.taskId, b.taskId))[0];
}

export class DurableDelegationScheduler {
  private readonly options: DurableDelegationSchedulerOptions;
  private readonly active = new Map<string, ActiveExecution>();
  private closing = false;
  private paused = false;
  private reason = "Scheduler stopped";
  private runPromise?: Promise<void>;
  private recoveryComplete = false;

  constructor(options: DurableDelegationSchedulerOptions) {
    if (!Number.isSafeInteger(options.maxParallel) || options.maxParallel < 1 || options.maxParallel > 1_024) {
      throw new Error("Scheduler maxParallel must be an integer from 1 through 1024");
    }
    this.options = options;
    const status = options.runtime.restore().schedulerStatus;
    this.paused = status === "paused";
    this.closing = status === "closed";
  }

  get activeCount(): number {
    return this.active.size;
  }

  hasLiveHandles(): boolean {
    return this.active.size > 0 || this.runPromise !== undefined;
  }

  private activeNodes(): ReadonlySet<string> {
    return new Set([...this.active.values()].map((entry) => entry.nodeId));
  }

  private async reconcileTakeover(): Promise<void> {
    if (this.recoveryComplete) return;
    const hasActive = Object.values(this.options.runtime.restore().tasks).some((task) => task.queueState === "active" && task.resumedByResultSequence === undefined);
    if (hasActive) {
      if (!this.options.verifiedTakeover || !await this.options.verifiedTakeover()) throw new Error("Journal-active delegation tasks require verified takeover before recovery");
      this.options.runtime.reconcileActiveAfterTakeover(true);
    }
    await this.options.onRecoveryReconciled?.();
    this.recoveryComplete = true;
  }

  private failureResult(error: unknown): WorkerResultInput {
    return {
      status: this.closing ? "cancelled" : "failed",
      summary: utf8Prefix(String(error instanceof Error ? error.message : error) || "Worker execution failed", DELEGATION_LIMITS.resultSummaryBytes),
      outputRefs: [],
      evidenceRefs: [],
      data: {},
    };
  }

  private launch(task: PersistedDelegationTask): void {
    const continuingAttempt = task.queueState === "active";
    const attemptId = continuingAttempt
      ? task.attempts.at(-1)?.attemptId
      : this.options.createAttemptId?.() ?? `attempt-${randomUUID()}`;
    if (!attemptId) throw new Error("Resumed delegation task has no current attempt");
    this.options.runtime.start(task.taskId, attemptId);
    const startedTask = this.options.runtime.restore().tasks[task.taskId];
    if (!startedTask) throw new Error("Started delegation task could not be restored");
    const executionContext = this.options.runtime.workerExecutionContext(task.taskId, attemptId);
    const controller = new AbortController();
    const promise = this.executeAttempt(startedTask, attemptId, executionContext, controller)
      .finally(() => { this.active.delete(task.taskId); });
    this.active.set(task.taskId, { nodeId: task.targetNodeId, attemptId, controller, promise });
  }

  private async executeAttempt(
    task: PersistedDelegationTask,
    attemptId: string,
    executionContext: DelegationExecutionContext,
    controller: AbortController,
  ): Promise<void> {
    let result: SchedulerExecutionResult;
    try {
      await this.options.hooks?.onAttemptStarted?.(task, attemptId);
      result = await this.options.execute(task, { signal: controller.signal, attemptId, executionContext });
      validateExecutionResult(result);
    } catch (error) {
      result = this.failureResult(error);
    }

    if (controller.signal.aborted && this.closing) {
      result = { status: "cancelled", summary: utf8Prefix(this.reason, DELEGATION_LIMITS.resultSummaryBytes), outputRefs: [], evidenceRefs: [], data: {} };
    }
    const currentState = this.options.runtime.restore();
    const current = currentState.tasks[task.taskId];
    if (!current || current.queueState === "terminal") return;
    const pendingDependencies = current.suspendedOn?.filter((dependencyId) => currentState.tasks[dependencyId]?.resultAcceptedSequence === undefined) ?? [];
    if (controller.signal.aborted && this.paused && !this.closing) {
      if (pendingDependencies.length) this.options.runtime.suspend(task.taskId, [...current.suspendedOn!]);
      else this.options.runtime.interrupt(task.taskId, this.reason);
      return;
    }
    let settledResult = result;
    if (pendingDependencies.length && !this.closing) {
      settledResult = Object.freeze({ status: "suspended" as const, dependencyTaskIds: Object.freeze([...current.suspendedOn!]) });
      this.options.runtime.suspend(task.taskId, [...current.suspendedOn!]);
    } else if (result.status === "suspended") {
      this.options.runtime.suspend(task.taskId, [...result.dependencyTaskIds]);
    } else {
      this.options.runtime.recordResult(task.taskId, result);
      const durable = this.options.runtime.restore().tasks[task.taskId];
      if (durable) await this.options.onResultDurable?.(durable);
    }
    await this.options.hooks?.onAttemptSettled?.(task, attemptId, settledResult);
  }

  private async runLoop(): Promise<void> {
    await this.reconcileTakeover();
    for (;;) {
      if (!this.closing && !this.paused) {
        while (this.active.size < this.options.maxParallel) {
          const task = selectNextDelegationTask(this.options.runtime, this.activeNodes());
          if (!task) break;
          this.launch(task);
        }
      }
      if (!this.active.size) return;
      await Promise.race([...this.active.values()].map((entry) => entry.promise));
    }
  }

  runUntilSettled(): Promise<void> {
    if (this.runPromise) return this.runPromise;
    const running = this.runLoop();
    const tracked = running.finally(() => {
      if (this.runPromise === tracked) this.runPromise = undefined;
    });
    this.runPromise = tracked;
    return tracked;
  }

  pauseAdmission(reason: string): void {
    if (this.closing) throw new Error("Closed scheduler cannot be paused");
    if (this.paused) return;
    this.paused = true;
    this.reason = utf8Prefix(reason.trim() || "Scheduler paused", DELEGATION_LIMITS.resultSummaryBytes);
    this.options.runtime.pauseAdmission(this.reason);
  }

  closeAdmission(reason: string): void {
    if (this.closing) return;
    this.closing = true;
    this.paused = true;
    this.reason = utf8Prefix(reason.trim() || "Scheduler closed", DELEGATION_LIMITS.resultSummaryBytes);
    this.options.runtime.closeAdmission(this.reason);
  }

  settlePending(reason = this.reason): void {
    const summary = utf8Prefix(reason.trim() || this.reason, DELEGATION_LIMITS.resultSummaryBytes);
    const temporarilyPaused = this.options.runtime.restore().schedulerStatus === "running";
    if (temporarilyPaused) this.options.runtime.pauseAdmission(summary);
    try {
      for (const task of Object.values(this.options.runtime.restore().tasks)
        .filter((candidate) => candidate.queueState === "queued" || candidate.queueState === "suspended")
        .sort((left, right) => left.creationSequence - right.creationSequence || compare(left.taskId, right.taskId))) {
        this.options.runtime.recordResult(task.taskId, { status: "cancelled", summary, outputRefs: [], evidenceRefs: [], data: { budgetExhausted: true } });
      }
    } finally {
      if (temporarilyPaused) this.options.runtime.resumeAdmission();
    }
  }

  cancelPending(reason = this.reason): void {
    this.options.runtime.cancelPending(utf8Prefix(reason.trim() || this.reason, DELEGATION_LIMITS.resultSummaryBytes));
  }

  abortOwnedWork(reason = this.reason, exceptNodeId?: string): void {
    this.reason = utf8Prefix(reason.trim() || this.reason, DELEGATION_LIMITS.resultSummaryBytes);
    for (const execution of this.active.values()) if (execution.nodeId !== exceptNodeId) execution.controller.abort(this.reason);
  }

  async waitForSettlement(timeoutMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error("Settlement timeout is invalid");
    const pending = [...this.active.values()].map((entry) => entry.promise);
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

  async pause(reason: string, timeoutMs = 2_000): Promise<boolean> {
    this.pauseAdmission(reason);
    this.abortOwnedWork(reason);
    return this.waitForSettlement(timeoutMs);
  }

  async shutdown(reason = "Process shutdown", timeoutMs = 2_000): Promise<boolean> {
    return this.pause(reason, timeoutMs);
  }

  resume(): void {
    if (this.closing) throw new Error("Closed scheduler cannot resume");
    if (!this.paused) return;
    if (this.active.size) throw new Error("Scheduler cannot resume until paused workers settle");
    this.options.runtime.resumeAdmission();
    this.paused = false;
  }

  async cancel(reason: string, timeoutMs = 2_000): Promise<boolean> {
    this.closeAdmission(reason);
    this.cancelPending(reason);
    this.abortOwnedWork(reason);
    const settled = await this.waitForSettlement(timeoutMs);
    this.cancelPending(reason);
    return settled;
  }
}
