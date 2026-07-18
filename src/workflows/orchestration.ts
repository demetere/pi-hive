import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import type { JsonValue } from "../config/types";
import {
  DelegationRuntime,
  type AcceptDelegationInput,
  type DelegationExecutionContext,
  type DelegationState,
  type DelegationStatusPage,
  type ResultDeliveryBatch,
} from "./delegation";
import { routeDirectMembers, type RouteDirectMembersInput, type RouteRecommendation } from "./routing";
import {
  CANCELLATION_TIMING,
  WorkflowRunLifecycle,
  isOpenRunStatus,
  type CancellationCoordinator,
  type CancellationResult,
  type CompletionValidationHooks,
  type PauseCoordinator,
  type ResumeCoordinator,
  type WorkflowRunLifecycleOptions,
} from "./runs";
import { DurableDelegationScheduler } from "./scheduler";
import { WorkerSessionPool, type WorkerSessionFactory } from "./workers";

export interface RunOrchestrationServiceOptions {
  readonly projectRoot: string; readonly projectId: string; readonly sessionId: string;
  readonly snapshot: ActivationSnapshotFileV1; readonly runtimeOwnerNonce: string; readonly maxParallel: number;
  readonly workerFactory: WorkerSessionFactory;
  readonly createRunId?: () => string; readonly createTaskId?: () => string; readonly createAttemptId?: () => string;
  readonly now?: () => string; readonly referenceAuthorizer?: DelegationRuntime["options"]["referenceAuthorizer"];
  readonly verifiedTakeover?: () => boolean | Promise<boolean>;
  readonly completion?: Omit<CompletionValidationHooks, "descendants">;
  /** Fault-injection seam for workflow lifecycle crash-recovery tests. */
  readonly journalFault?: WorkflowRunLifecycleOptions["journalFault"];
  readonly pauseAuthority: PauseCoordinator; readonly resumeAuthority: ResumeCoordinator;
  readonly cancellationAuthority: Pick<CancellationCoordinator, "terminateProcessTrees" | "capturePartialState" | "releaseLeases">;
}
export interface BoundDelegationServices {
  readonly context: DelegationExecutionContext;
  route(input: RouteDirectMembersInput): readonly RouteRecommendation[];
  delegate(input: AcceptDelegationInput): Readonly<{ accepted: true; queued: true; taskId: string }>;
  status(options?: { limit?: number; cursor?: string }): DelegationStatusPage;
  preparedResultDelivery(): ResultDeliveryBatch | undefined;
  prepareResultDelivery(deliveryId: string, options?: { limit?: number }): ResultDeliveryBatch;
  acceptResultDelivery(deliveryId: string): void;
}
interface RunResources {
  readonly runId: string; readonly runtime: DelegationRuntime;
  readonly scheduler: DurableDelegationScheduler; readonly workers: WorkerSessionPool;
}

function rootNodeId(snapshot: ActivationSnapshotFileV1): string {
  const team = snapshot.payload.workflow.team as { rootId?: unknown } | undefined;
  if (typeof team?.rootId !== "string" || !team.rootId) throw new Error("Activation snapshot root node is invalid");
  return team.rootId;
}

export class RunOrchestrationService {
  readonly lifecycle: WorkflowRunLifecycle;
  private readonly options: RunOrchestrationServiceOptions;
  private current?: RunResources;
  private readonly cleanup = new Set<Promise<void>>();

  constructor(options: RunOrchestrationServiceOptions) {
    this.options = options;
    const completion: CompletionValidationHooks = {
      ...(options.completion ?? {}),
      descendants: () => this.descendantGate(),
      settleTerminal: async (settlement) => {
        await this.settleTerminalResources(settlement.runId);
        await options.completion?.settleTerminal?.(settlement);
      },
    };
    this.lifecycle = new WorkflowRunLifecycle({
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      sessionId: options.sessionId,
      snapshotId: options.snapshot.snapshotHash,
      rootNodeId: rootNodeId(options.snapshot),
      runtimeOwnerNonce: options.runtimeOwnerNonce,
      createRunId: options.createRunId,
      now: options.now,
      completion,
      journalFault: options.journalFault,
    });
  }

  private trackCleanup(promise: Promise<void>): void {
    this.cleanup.add(promise);
    void promise.finally(() => { this.cleanup.delete(promise); }).catch(() => undefined);
  }

  private reconcileDurableNestedDeliveries(runtime: DelegationRuntime): void {
    for (;;) {
      const state = runtime.restore();
      const parent = Object.values(state.tasks)
        .filter((task) => task.queueState === "suspended" && task.suspendedOn?.some((taskId) => {
          const dependency = state.tasks[taskId];
          return dependency?.result !== undefined && dependency.resultAcceptedSequence === undefined;
        }))
        .sort((a, b) => a.creationSequence - b.creationSequence || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0))[0];
      if (!parent) return;
      const existing = Object.values(state.deliveries).find((delivery) => delivery.recipientNodeId === parent.targetNodeId && delivery.acceptedSequence === undefined);
      const dependency = parent.suspendedOn!.map((taskId) => state.tasks[taskId]).find((task) => task?.result && task.resultAcceptedSequence === undefined);
      if (!dependency) return;
      runtime.deliverPendingResultsToSuspendedTask(
        parent.taskId,
        existing?.deliveryId ?? `delivery-${dependency.taskId}-${dependency.result!.recordedSequence}`,
      );
    }
  }

  private createResources(runId: string): RunResources {
    const runtime = new DelegationRuntime({
      projectRoot: this.options.projectRoot,
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      runId,
      snapshot: this.options.snapshot,
      createTaskId: this.options.createTaskId,
      now: this.options.now,
      referenceAuthorizer: this.options.referenceAuthorizer,
    });
    const workers = new WorkerSessionPool({
      projectRoot: this.options.projectRoot,
      sessionId: this.options.sessionId,
      runId,
      snapshot: this.options.snapshot,
      factory: this.options.workerFactory,
    });
    workers.rebuildBoundaries(Object.values(runtime.restore().tasks));
    const scheduler = new DurableDelegationScheduler({
      runtime,
      maxParallel: this.options.maxParallel,
      createAttemptId: this.options.createAttemptId,
      verifiedTakeover: this.options.verifiedTakeover,
      onRecoveryReconciled: () => this.reconcileDurableNestedDeliveries(runtime),
      execute: (task, control) => {
        const state = runtime.restore();
        const deliveredResults = (task.suspendedOn ?? []).flatMap((taskId) => {
          const child = state.tasks[taskId];
          return child?.result && child.resultAcceptedSequence !== undefined ? [Object.freeze({ taskId, result: child.result })] : [];
        });
        return workers.execute(task, control.signal, this.bind(control.executionContext, { runId, runtime }), deliveredResults);
      },
      onResultDurable: (task) => {
        const parentTaskId = task.provenance.parentTaskId;
        const state = runtime.restore();
        const parent = parentTaskId ? state.tasks[parentTaskId] : undefined;
        if (parent?.queueState === "suspended" && parent.suspendedOn?.includes(task.taskId)) {
          runtime.deliverPendingResultsToSuspendedTask(parent.taskId, `delivery-${task.taskId}-${task.result?.recordedSequence ?? task.creationSequence}`);
        }
        workers.rebuildBoundaries(Object.values(runtime.restore().tasks));
      },
    });
    const resources = { runId, runtime, scheduler, workers };
    const run = this.lifecycle.restore().latestRun;
    if (run?.runId === runId && run.pendingTerminal) this.failClosedForTerminal(resources);
    else this.reconcileDurableNestedDeliveries(runtime);
    return resources;
  }

  private failClosedForTerminal(resources: RunResources): void {
    resources.scheduler.closeAdmission("workflow terminal settlement");
    resources.scheduler.cancelPending("workflow terminal settlement");
    resources.scheduler.abortOwnedWork("workflow terminal settlement");
  }

  private resources(): RunResources {
    const run = this.lifecycle.restore().latestRun;
    if (!run || !isOpenRunStatus(run.status)) throw new Error("Run-scoped orchestration requires a current open workflow run");
    if (this.current?.runId !== run.runId) {
      if (this.current) this.trackCleanup(this.current.workers.closeSessions());
      this.current = this.createResources(run.runId);
    }
    if (run.pendingTerminal) {
      this.failClosedForTerminal(this.current);
      throw new Error("Run-scoped orchestration is unavailable while terminal settlement is finalizing");
    }
    return this.current;
  }

  private async settleTerminalResources(runId: string): Promise<void> {
    const run = this.lifecycle.restore().latestRun;
    if (!run || run.runId !== runId || !isOpenRunStatus(run.status) || !run.pendingTerminal) throw new Error("Terminal resource settlement does not target the current finalizing run");
    const resources = this.current?.runId === runId ? this.current : this.createResources(runId);
    this.current = resources;
    this.failClosedForTerminal(resources);
    await resources.workers.closeSessions();
    const [schedulerSettled, workersSettled] = await Promise.all([
      resources.scheduler.waitForSettlement(CANCELLATION_TIMING.killSettleMs),
      resources.workers.waitForSettlement(CANCELLATION_TIMING.killSettleMs),
    ]);
    if (!schedulerSettled || !workersSettled) throw new Error("Worker execution did not settle during terminal finish");
    await resources.scheduler.runUntilSettled();
    resources.scheduler.cancelPending("workflow terminal settlement");
    const unsettled = Object.values(resources.runtime.restore().tasks).filter((task) => task.queueState !== "terminal");
    if (unsettled.length) throw new Error(`${unsettled.length} descendant task(s) remain unsettled during terminal finish`);
  }

  private descendantGate(): Readonly<{ state: "satisfied" | "unsatisfied"; issues?: readonly string[] }> {
    const run = this.lifecycle.restore().latestRun;
    if (!run) return Object.freeze({ state: "unsatisfied", issues: Object.freeze(["no workflow run is active"]) });
    const resources = this.resources();
    const tasks = Object.values(resources.runtime.restore().tasks);
    const unsettled = tasks.filter((task) => task.queueState !== "terminal");
    const undelivered = tasks.filter((task) => task.parentNodeId === resources.runtime.restore().rootNodeId && task.result && task.resultAcceptedSequence === undefined);
    if (!unsettled.length && !undelivered.length) return Object.freeze({ state: "satisfied" });
    return Object.freeze({
      state: "unsatisfied",
      issues: Object.freeze([
        ...(unsettled.length ? [`${unsettled.length} descendant task(s) are queued, active, or suspended`] : []),
        ...(undelivered.length ? [`${undelivered.length} durable descendant result(s) have not been accepted by the parent`] : []),
      ]),
    });
  }

  private bind(context: DelegationExecutionContext, resources: Pick<RunResources, "runId" | "runtime">): BoundDelegationServices {
    const assertCurrent = (): void => {
      const run = this.lifecycle.restore().latestRun;
      if (run?.runId === resources.runId && run.pendingTerminal) {
        const current = this.current?.runId === resources.runId ? this.current : undefined;
        if (current) this.failClosedForTerminal(current);
        throw new Error("Delegation services are unavailable while terminal settlement is finalizing");
      }
      if (!run || !isOpenRunStatus(run.status) || run.runId !== resources.runId || this.current?.runId !== resources.runId || !resources.runtime.restore().admissionOpen) {
        throw new Error("Delegation services are stale and do not target the current open run");
      }
      resources.runtime.assertExecutionContext(context);
    };
    return Object.freeze({
      context,
      route: (input: RouteDirectMembersInput) => { assertCurrent(); return routeDirectMembers(this.options.snapshot, context.nodeId, input); },
      delegate: (input: AcceptDelegationInput) => { assertCurrent(); return resources.runtime.accept(context, input); },
      status: (options: { limit?: number; cursor?: string } = {}) => { assertCurrent(); return resources.runtime.status(context, options); },
      preparedResultDelivery: () => { assertCurrent(); return resources.runtime.preparedResultDelivery(context); },
      prepareResultDelivery: (deliveryId: string, options: { limit?: number } = {}) => { assertCurrent(); return resources.runtime.prepareResultDelivery(context, deliveryId, options); },
      acceptResultDelivery: (deliveryId: string) => { assertCurrent(); resources.runtime.acceptResultDelivery(context, deliveryId); },
    });
  }

  rootServices(): BoundDelegationServices {
    const resources = this.resources();
    return this.bind(resources.runtime.rootExecutionContext(), resources);
  }

  servicesFor(context: DelegationExecutionContext): BoundDelegationServices {
    const resources = this.resources();
    resources.runtime.status(context, { limit: 1 });
    return this.bind(context, resources);
  }

  delegationState(): DelegationState {
    const run = this.lifecycle.restore().latestRun;
    if (!run || !isOpenRunStatus(run.status)) {
      if (this.current) return this.current.runtime.restore();
      throw new Error("Delegation state requires a current workflow run");
    }
    if (this.current?.runId !== run.runId) {
      if (this.current) this.trackCleanup(this.current.workers.closeSessions());
      this.current = this.createResources(run.runId);
    }
    if (run.pendingTerminal) this.failClosedForTerminal(this.current);
    return this.current.runtime.restore();
  }

  async runWorkers(): Promise<void> {
    const resources = this.resources();
    const run = this.lifecycle.restore().latestRun;
    if (!run || run.runId !== resources.runId || !isOpenRunStatus(run.status) || run.status === "paused" || run.cancellationRequested) {
      throw new Error("Workers can run only for the current running workflow run");
    }
    await resources.scheduler.runUntilSettled();
  }

  private async suspendResources(reason: string): Promise<void> {
    const resources = this.resources();
    resources.scheduler.pauseAdmission(reason);
    resources.scheduler.abortOwnedWork(reason);
    if (!await resources.scheduler.waitForSettlement(CANCELLATION_TIMING.settleGraceMs)) throw new Error("Worker scheduler did not settle during pause");
    await resources.workers.closeSessions();
    if (!await resources.workers.waitForSettlement(CANCELLATION_TIMING.killSettleMs)) throw new Error("Worker sessions did not settle during pause");
  }

  async pause(reason: string): Promise<boolean> {
    return this.lifecycle.pause(reason, {
      ...this.options.pauseAuthority,
      suspendOwnedWork: async () => {
        await this.suspendResources(reason);
        await this.options.pauseAuthority.suspendOwnedWork?.();
      },
    });
  }

  async resume(): Promise<boolean> {
    const resumed = await this.lifecycle.resume(this.options.resumeAuthority);
    if (!resumed) return false;
    const run = this.lifecycle.restore().latestRun;
    if (!run) throw new Error("Resumed workflow run disappeared");
    if (this.current) await this.current.workers.closeSessions();
    this.current = this.createResources(run.runId);
    this.current.scheduler.resume();
    return true;
  }

  private cancellationCoordinator(reason: string): CancellationCoordinator {
    const resources = this.resources();
    return {
      rejectNewWork: () => { resources.scheduler.closeAdmission(reason); },
      cancelQueuedWork: () => { resources.scheduler.cancelPending(reason); },
      abortOwnedWork: async () => {
        resources.scheduler.abortOwnedWork(reason);
        await resources.workers.closeSessions();
      },
      waitForSettlement: async (timeoutMs) => {
        const [schedulerSettled, workersSettled] = await Promise.all([
          resources.scheduler.waitForSettlement(timeoutMs),
          resources.workers.waitForSettlement(timeoutMs),
        ]);
        return schedulerSettled && workersSettled;
      },
      terminateProcessTrees: this.options.cancellationAuthority.terminateProcessTrees,
      capturePartialState: async () => {
        const base = await this.options.cancellationAuthority.capturePartialState?.() ?? {};
        return {
          ...base,
          delegation: {
            runId: resources.runId,
            schedulerStatus: resources.runtime.restore().schedulerStatus,
            taskCount: Object.keys(resources.runtime.restore().tasks).length,
          },
        } as Readonly<Record<string, JsonValue>>;
      },
      releaseLeases: this.options.cancellationAuthority.releaseLeases,
    };
  }

  async cancel(reason: string): Promise<CancellationResult> {
    const result = await this.lifecycle.cancel(reason, this.cancellationCoordinator(reason));
    if (this.current) await this.current.workers.closeSessions();
    return result;
  }

  async shutdown(reason = "process shutdown"): Promise<void> {
    const run = this.lifecycle.restore().latestRun;
    if (run && isOpenRunStatus(run.status)) await this.pause(reason);
    if (this.current) await this.current.workers.closeSessions();
    if (this.cleanup.size) await Promise.allSettled([...this.cleanup]);
  }

  hasLiveHandles(): boolean {
    return Boolean(this.current?.scheduler.hasLiveHandles() || this.current?.workers.hasLiveHandles() || this.cleanup.size);
  }
}
