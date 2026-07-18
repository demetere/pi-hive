import { createHash } from "node:crypto";
import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import type { JsonValue } from "../config/types";
import { classifyTrustedTool } from "../capabilities/tools";
import type { CommandAttemptMetadata } from "../capabilities/command";
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
import {
  WorkerSessionPool,
  type WorkerPromptResponse,
  type WorkerProviderUsage,
  type WorkerSessionFactory,
  type WorkerTrustedDispatch,
  type WorkerTrustedToolDispatchRequest,
} from "./workers";
import {
  BudgetRuntime,
  budgetExhaustionScope,
  effectiveRuntimeBudgetLimitsFromSnapshot,
  type BudgetAdmission,
  type BudgetState,
  type EffectiveRuntimeBudgetLimits,
} from "./budgets";
import {
  AttemptRuntime,
  attemptDescriptorForModel,
  attemptDescriptorFromCommandMetadata,
  attemptDescriptorFromTrustedTool,
  executeWithConservativeRetry,
  type TrustedAttemptDescriptor,
} from "./attempts";
import { ChangeAccountingRuntime, type ChangeAccountingOptions } from "./change-accounting";
import { recoverUnknownSideEffects, type UnknownSideEffectRecoveryOptions, type UnknownSideEffectRecoveryReport } from "./recovery";

export interface RunOrchestrationServiceOptions {
  readonly projectRoot: string; readonly projectId: string; readonly sessionId: string;
  readonly snapshot: ActivationSnapshotFileV1; readonly runtimeOwnerNonce: string; readonly maxParallel: number;
  readonly workerFactory: WorkerSessionFactory;
  readonly budgetLimits?: EffectiveRuntimeBudgetLimits;
  readonly nowMs?: () => number;
  /** Required when taking over a run whose previous owner left an active budget clock. */
  readonly recoveredOwnerHeartbeatAt?: string;
  readonly recoveryReconcilers?: UnknownSideEffectRecoveryOptions["reconcilers"];
  readonly changeAccounting?: Pick<ChangeAccountingOptions, "scopes" | "protectedRoots" | "limits">;
  readonly createRunId?: () => string; readonly createTaskId?: () => string; readonly createAttemptId?: () => string;
  readonly now?: () => string; readonly referenceAuthorizer?: DelegationRuntime["options"]["referenceAuthorizer"];
  readonly verifiedTakeover?: () => boolean | Promise<boolean>;
  readonly completion?: Omit<CompletionValidationHooks, "descendants">;
  /** Fault-injection seam for workflow lifecycle crash-recovery tests. */
  readonly journalFault?: WorkflowRunLifecycleOptions["journalFault"];
  readonly pauseAuthority: PauseCoordinator; readonly resumeAuthority: ResumeCoordinator;
  readonly cancellationAuthority: Pick<CancellationCoordinator, "terminateProcessTrees" | "capturePartialState" | "releaseLeases">;
}
export interface RootModelDispatchRequest {
  readonly correlationId: string; readonly operation: string; readonly input: unknown; readonly finalization?: boolean;
  readonly dispatch: () => string | WorkerPromptResponse | Promise<string | WorkerPromptResponse>;
}
export interface TrustedWorkflowDispatch extends WorkerTrustedDispatch {
  model(input: RootModelDispatchRequest): Promise<string | WorkerPromptResponse>;
}
export interface BoundDelegationServices {
  readonly context: DelegationExecutionContext;
  readonly dispatch: TrustedWorkflowDispatch;
  route(input: RouteDirectMembersInput): readonly RouteRecommendation[];
  delegate(input: AcceptDelegationInput): Readonly<{ accepted: true; queued: true; taskId: string }>;
  status(options?: { limit?: number; cursor?: string }): DelegationStatusPage;
  preparedResultDelivery(): ResultDeliveryBatch | undefined;
  prepareResultDelivery(deliveryId: string, options?: { limit?: number }): ResultDeliveryBatch;
  acceptResultDelivery(deliveryId: string): void;
}
interface RunResources {
  readonly runId: string; readonly runtime: DelegationRuntime;
  readonly budgets: BudgetRuntime; readonly attempts: AttemptRuntime; readonly changes: ChangeAccountingRuntime;
  readonly recoveryIssues: readonly string[];
  readonly dispatchRuntime: DispatchResources;
  readonly scheduler: DurableDelegationScheduler; readonly workers: WorkerSessionPool;
}
interface DispatchResources extends Pick<RunResources, "budgets" | "attempts" | "changes"> {
  readonly assertAdmission: () => void;
  readonly pauseUnknown: (reason: string) => void;
  readonly blockRunBudget: (nodeId: string, reason: string) => void;
  readonly canTerminalizeRunBudget: () => boolean;
}

function rootNodeId(snapshot: ActivationSnapshotFileV1): string {
  const team = snapshot.payload.workflow.team as { rootId?: unknown } | undefined;
  if (typeof team?.rootId !== "string" || !team.rootId) throw new Error("Activation snapshot root node is invalid");
  return team.rootId;
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function estimatedTokens(value: string): number { return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4)); }
function responseOutput(value: string | WorkerPromptResponse): string {
  if (typeof value === "string") return value;
  if (!record(value) || typeof value.output !== "string") throw Object.assign(new Error("Model provider response output is invalid"), { assistantOutputObserved: true, effectNotApplied: true });
  return value.output;
}
function responseUsage(value: string | WorkerPromptResponse, inputText: string): WorkerProviderUsage {
  if (record(value) && value.usage !== undefined) {
    const usage = value.usage;
    if (!record(usage) || !Number.isSafeInteger(usage.inputTokens) || Number(usage.inputTokens) < 0
      || !Number.isSafeInteger(usage.outputTokens) || Number(usage.outputTokens) < 0
      || (usage.precision !== "estimated" && usage.precision !== "provider-confirmed")) {
      throw Object.assign(new Error("Model provider usage is invalid"), { assistantOutputObserved: true, effectNotApplied: true });
    }
    return Object.freeze({ inputTokens: Number(usage.inputTokens), outputTokens: Number(usage.outputTokens), precision: usage.precision });
  }
  return Object.freeze({ inputTokens: estimatedTokens(inputText), outputTokens: estimatedTokens(responseOutput(value)), precision: "estimated" });
}
function budgetError(reason: string, exhausted: readonly string[], scope: "node" | "run"): Error {
  return Object.assign(new Error(reason), { policyDenied: true, effectNotApplied: true, budgetExhausted: [...exhausted], budgetScope: scope });
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
      projectState: async () => {
        const run = this.lifecycle.restore().latestRun;
        if (!run) return Object.freeze({ state: "unsatisfied" as const, issues: Object.freeze(["project state: no workflow run is active"]) });
        const accounting = this.changeAccountingFor(run.runId);
        const derived = accounting.reconcile();
        const attempts = new AttemptRuntime({ projectRoot: options.projectRoot, projectId: options.projectId, sessionId: options.sessionId, runId: run.runId, now: options.now }).restore();
        const unresolvedAttempts = Object.values(attempts.attempts).filter((attempt) => !attempt.result);
        const attemptIssues = unresolvedAttempts.length ? [`${unresolvedAttempts.length} attempt intent(s) remain unresolved and require recovery`] : [];
        const upstream = options.completion?.projectState ? await options.completion.projectState() : undefined;
        const upstreamIssues = upstream?.state === "unsatisfied" ? [...(upstream.issues ?? ["upstream project-state gate is unsatisfied"])] : [];
        return Object.freeze({
          ...derived,
          state: derived.state === "unsatisfied" || attemptIssues.length || upstreamIssues.length ? "unsatisfied" as const : "satisfied" as const,
          issues: Object.freeze([...(derived.issues ?? []), ...attemptIssues, ...upstreamIssues]),
        });
      },
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
      onRunStarted: (runId) => { this.changeAccountingFor(runId).captureBaseline(); },
      onRunStatusChanged: (runId, status) => {
        const budgets = this.budgetRuntimeFor(runId);
        if (status === "paused" || status === "waiting_for_human") budgets.pauseActive(status);
        else budgets.resumeActive();
      },
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

  private budgetRuntimeFor(runId: string): BudgetRuntime {
    return new BudgetRuntime({
      projectRoot: this.options.projectRoot, projectId: this.options.projectId, sessionId: this.options.sessionId, runId,
      rootNodeId: rootNodeId(this.options.snapshot), limits: this.options.budgetLimits ?? effectiveRuntimeBudgetLimitsFromSnapshot(this.options.snapshot),
      now: this.options.now, nowMs: this.options.nowMs,
    });
  }

  private changeAccountingFor(runId: string): ChangeAccountingRuntime {
    return new ChangeAccountingRuntime({
      projectRoot: this.options.projectRoot, projectId: this.options.projectId, sessionId: this.options.sessionId, runId,
      now: this.options.now, ...this.options.changeAccounting,
    });
  }

  private modelInputText(input: unknown): string {
    try { return JSON.stringify(input) ?? String(input); } catch { return String(input); }
  }

  private blockRunForBudget(resources: RunResources, nodeId: string, reason: string): void {
    const bounded = `budget_exhausted: ${reason}`.slice(0, 2_048);
    resources.scheduler.closeAdmission(bounded);
    resources.scheduler.cancelPending(bounded);
    resources.scheduler.abortOwnedWork(bounded, nodeId);
    this.trackCleanup(resources.workers.abortSessionsExcept(nodeId));
  }

  private pauseForUnknownSideEffect(resources: RunResources, reason: string): void {
    const bounded = `unknown_side_effect: ${reason}`.slice(0, 2_048);
    if (resources.runtime.restore().schedulerStatus === "running") resources.scheduler.pauseAdmission(bounded);
    resources.scheduler.abortOwnedWork(bounded);
    this.trackCleanup(resources.workers.closeSessions());
  }

  private throwBudgetAdmission(resources: DispatchResources, nodeId: string, admission: Extract<BudgetAdmission, { ok: false }>): never {
    if (!admission.budgetExhausted) throw Object.assign(new Error(admission.reason), { policyDenied: true, effectNotApplied: true });
    if (admission.scope === "run") resources.blockRunBudget(nodeId, admission.reason);
    throw budgetError(admission.reason, admission.exhausted, admission.scope);
  }

  private recoveryErrorAfterDispatch(resources: DispatchResources, detail: string): Error | undefined {
    const issues = this.recoveryAdmissionIssuesFromDispatch(resources);
    if (!issues.length) return undefined;
    const message = `${detail}: ${issues.join("; ")}`.slice(0, 8_192);
    resources.pauseUnknown(message);
    return Object.assign(new Error(message), { effectNotApplied: true, assistantOutputObserved: true });
  }

  private async terminalizeRunBudgetIfSafe(resources: DispatchResources, error: unknown): Promise<void> {
    const detail = record(error) ? error : {};
    if (detail.budgetScope !== "run" || !resources.canTerminalizeRunBudget()) return;
    const result = await this.lifecycle.failBudgetExhaustion(String(error instanceof Error ? error.message : error));
    if (!result.ok) throw new AggregateError([error, ...result.issues.map((issue) => new Error(issue))], "Run-wide budget exhaustion could not be durably terminalized");
  }

  private async persistUnknownPauseIfSafe(resources: DispatchResources, issues: readonly string[]): Promise<void> {
    if (!issues.length || !resources.canTerminalizeRunBudget() || this.lifecycle.restore().latestRun?.status !== "running") return;
    await this.pause(`unknown_side_effect: ${issues.join("; ").slice(0, 2_048)}`);
  }

  private async dispatchModel(
    resources: DispatchResources,
    nodeId: string,
    request: RootModelDispatchRequest,
    inputText = this.modelInputText(request.input),
  ): Promise<string | WorkerPromptResponse> {
    resources.assertAdmission();
    try {
      const value = await executeWithConservativeRetry(resources.attempts, {
        correlationId: request.correlationId, nodeId, operation: request.operation, input: request.input,
        descriptor: attemptDescriptorForModel(),
        dispatch: async ({ attemptId, ordinal }) => {
          resources.assertAdmission();
          const admitted = resources.budgets.startModelAttempt(nodeId, `${request.correlationId}-provider-${ordinal}`, { finalization: request.finalization });
          if (!admitted.ok) this.throwBudgetAdmission(resources, nodeId, admitted);
          const activityId = `${attemptId}-active`;
          const active = resources.budgets.beginActive(nodeId, activityId);
          if (!active.ok) this.throwBudgetAdmission(resources, nodeId, active);
          let response: string | WorkerPromptResponse;
          try {
            response = await request.dispatch();
            const recovery = this.recoveryErrorAfterDispatch(resources, "Model response rejected after a recovery barrier appeared");
            if (recovery) throw recovery;
            resources.budgets.recordModelUsage(admitted.attemptId, responseUsage(response, inputText));
          } catch (error) {
            const candidate = record(error) && record(error.usage)
              ? { output: "", usage: error.usage } as unknown as WorkerPromptResponse
              : undefined;
            try {
              resources.budgets.recordModelUsage(admitted.attemptId, candidate
                ? responseUsage(candidate, inputText)
                : { inputTokens: estimatedTokens(inputText), outputTokens: 0, precision: "estimated" });
            } catch (usageError) {
              if (error && typeof error === "object") Object.assign(error, { usageAccountingError: String(usageError instanceof Error ? usageError.message : usageError) });
            }
            throw error;
          } finally {
            resources.budgets.endActive(activityId);
          }
          const overages = resources.budgets.postResponseOverages(nodeId);
          if (overages.length && request.finalization !== true) {
            const reason = `Budget blocked after model response: ${overages.join(", ")}`;
            const scope = budgetExhaustionScope(overages);
            if (scope === "run") resources.blockRunBudget(nodeId, reason);
            throw Object.assign(budgetError(reason, overages, scope), { assistantOutputObserved: true });
          }
          return response;
        },
      });
      const recovery = this.recoveryErrorAfterDispatch(resources, "Model dispatch completed with unresolved side effects");
      if (recovery) throw recovery;
      return value;
    } catch (error) {
      const recovery = this.recoveryAdmissionIssuesFromDispatch(resources);
      if (recovery.length) resources.pauseUnknown(recovery.join("; "));
      await this.persistUnknownPauseIfSafe(resources, recovery);
      await this.terminalizeRunBudgetIfSafe(resources, error);
      throw error;
    }
  }

  private toolDescriptor(toolName: string, commandMetadata?: unknown): TrustedAttemptDescriptor {
    const tool = classifyTrustedTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} has no trusted package registration`);
    if (toolName === "bash") return attemptDescriptorFromCommandMetadata(commandMetadata as CommandAttemptMetadata);
    if (commandMetadata !== undefined) throw new Error("Command metadata is accepted only for the trusted bash tool");
    return attemptDescriptorFromTrustedTool(tool);
  }

  private async dispatchTool<T>(
    resources: DispatchResources,
    nodeId: string,
    request: WorkerTrustedToolDispatchRequest<T>,
  ): Promise<T> {
    resources.assertAdmission();
    const descriptor = this.toolDescriptor(request.toolName, request.commandMetadata);
    const tool = classifyTrustedTool(request.toolName)!;
    const authority = this.options.snapshot.payload.authority.nodes.find((entry) => entry.nodeId === nodeId);
    if (request.policyOutcome === "allowed" && (!authority || !Array.isArray(authority.tools) || !authority.tools.includes(request.toolName))) throw new Error(`Tool ${request.toolName} is not enabled for node ${nodeId}`);
    try {
      const value = await executeWithConservativeRetry(resources.attempts, {
        correlationId: request.correlationId, nodeId, operation: request.operation, input: request.input, descriptor,
        dispatch: async ({ attemptId, ordinal }) => {
          resources.assertAdmission();
          const admitted = resources.budgets.recordToolAttempt(nodeId, `${request.correlationId}-tool-${ordinal}`, {
            toolName: request.toolName, policyOutcome: request.policyOutcome, finalization: request.finalization,
          });
          if (!admitted.ok) this.throwBudgetAdmission(resources, nodeId, admitted);
          if (request.policyOutcome === "denied") {
            throw Object.assign(new Error(request.denialReason?.slice(0, 2_048) || `Policy denied ${request.toolName}`), { policyDenied: true, effectNotApplied: true });
          }
          const activityId = `${attemptId}-active`;
          const ownsActivity = !resources.budgets.restore().activeBatches.some((activity) => activity.nodeId === nodeId);
          if (ownsActivity) {
            const active = resources.budgets.beginActive(nodeId, activityId);
            if (!active.ok) this.throwBudgetAdmission(resources, nodeId, active);
          }
          try {
            const metadata = request.toolName === "bash" ? request.commandMetadata as CommandAttemptMetadata : undefined;
            const command = metadata?.mutating ? resources.changes.beginCommandAttempt(attemptId, metadata) : undefined;
            const mutationAccounting = tool.name === "write" ? Object.freeze({ schemaVersion: 1 as const, attemptId, recorder: resources.changes.mutationRecorder() }) : undefined;
            const result = await request.dispatch(Object.freeze({ schemaVersion: 1 as const, attemptId, ...(mutationAccounting ? { mutationAccounting } : {}) }));
            // Publish this successful command's command/path accounting before the
            // global recovery barrier inspects unrelated unresolved effects.
            if (command) resources.changes.completeCommandAttempt(command);
            const recovery = this.recoveryErrorAfterDispatch(resources, `Tool ${request.toolName} completed with an unresolved side effect`);
            if (recovery) throw recovery;
            return result;
          } finally {
            if (ownsActivity) resources.budgets.endActive(activityId);
          }
        },
      });
      const recovery = this.recoveryErrorAfterDispatch(resources, `Tool ${request.toolName} dispatch completed with unresolved side effects`);
      if (recovery) throw recovery;
      return value;
    } catch (error) {
      const recovery = this.recoveryAdmissionIssuesFromDispatch(resources);
      if (recovery.length) resources.pauseUnknown(recovery.join("; "));
      await this.persistUnknownPauseIfSafe(resources, recovery);
      await this.terminalizeRunBudgetIfSafe(resources, error);
      throw error;
    }
  }

  private createResources(runId: string): RunResources {
    const budgets = this.budgetRuntimeFor(runId);
    const changes = this.changeAccountingFor(runId);
    const attempts = new AttemptRuntime({ projectRoot: this.options.projectRoot, projectId: this.options.projectId, sessionId: this.options.sessionId, runId, now: this.options.now });
    const recoveryIssues: string[] = [];
    for (const attempt of Object.values(attempts.restore().attempts)) {
      if (!attempt.result && attempt.recovery === "reconcile-required" && attempt.status === "pending") {
        attempts.markUnknown(attempt.attemptId, "interrupted non-idempotent dispatch requires trusted reconciliation before admission");
      }
    }
    if (budgets.restore().activeBatches.length) {
      const boundary = this.options.recoveredOwnerHeartbeatAt === undefined ? Number.NaN : Date.parse(this.options.recoveredOwnerHeartbeatAt);
      if (!Number.isFinite(boundary)) recoveryIssues.push("abandoned active budget clock has no verified previous-owner heartbeat boundary");
      else {
        budgets.reconcileAbandonedActiveTime(boundary, "reconciled at verified previous-owner heartbeat");
        budgets.resumeActive();
      }
    }
    const runtime = new DelegationRuntime({
      projectRoot: this.options.projectRoot,
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      runId,
      snapshot: this.options.snapshot,
      createTaskId: this.options.createTaskId,
      now: this.options.now,
      referenceAuthorizer: this.options.referenceAuthorizer,
      acceptanceAuthority: { admit: (events, parentNodeId) => budgets.admitDelegationAgainst(events, parentNodeId) },
    });
    const assertDispatchAdmission = (): void => {
      const run = this.lifecycle.restore().latestRun;
      const delegation = runtime.restore();
      if (!run || run.runId !== runId || run.status !== "running" || run.cancellationRequested || run.pendingTerminal || !delegation.admissionOpen || delegation.schedulerStatus !== "running") {
        throw new Error("Model/tool dispatch admission requires the current running recovered workflow run");
      }
      this.assertRecoveredForAdmission({ attempts, changes, recoveryIssues });
    };
    const dispatchResources: DispatchResources = {
      budgets, attempts, changes,
      assertAdmission: assertDispatchAdmission,
      pauseUnknown: (reason) => this.pauseForUnknownSideEffect(resources, reason),
      blockRunBudget: (nodeId, reason) => this.blockRunForBudget(resources, nodeId, reason),
      canTerminalizeRunBudget: () => resources.scheduler.activeCount === 0,
    };
    const workers = new WorkerSessionPool({
      projectRoot: this.options.projectRoot,
      sessionId: this.options.sessionId,
      runId,
      snapshot: this.options.snapshot,
      factory: this.options.workerFactory,
      dispatchModel: ({ task, text, invoke }) => this.dispatchModel(dispatchResources, task.targetNodeId, {
        correlationId: `worker-model-${task.taskId}-${createHash("sha256").update(text).digest("hex").slice(0, 24)}`,
        operation: "worker.provider.prompt", input: { taskId: task.taskId, promptHash: createHash("sha256").update(text).digest("hex") }, dispatch: invoke,
      }, text),
      dispatchTool: (task, input) => this.dispatchTool(dispatchResources, task.targetNodeId, input),
    });
    workers.rebuildBoundaries(Object.values(runtime.restore().tasks));
    const scheduler = new DurableDelegationScheduler({
      runtime,
      maxParallel: Math.min(this.options.maxParallel, budgets.restore().limits.run.maxParallel),
      createAttemptId: this.options.createAttemptId,
      verifiedTakeover: this.options.verifiedTakeover,
      onRecoveryReconciled: () => this.reconcileDurableNestedDeliveries(runtime),
      execute: async (task, control) => {
        const state = runtime.restore();
        const deliveredResults = (task.suspendedOn ?? []).flatMap((taskId) => {
          const child = state.tasks[taskId];
          return child?.result && child.resultAcceptedSequence !== undefined ? [Object.freeze({ taskId, result: child.result })] : [];
        });
        assertDispatchAdmission();
        return workers.execute(task, control.signal, this.bind(control.executionContext, resources), deliveredResults);
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
    const resources: RunResources = { runId, runtime, budgets, attempts, changes, recoveryIssues: Object.freeze(recoveryIssues), dispatchRuntime: dispatchResources, scheduler, workers };
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

  private recoveryAdmissionIssuesFromDispatch(resources: Pick<RunResources, "attempts" | "changes">): readonly string[] {
    const unresolvedAttempts = Object.values(resources.attempts.restore().attempts)
      .filter((attempt) => !attempt.result && attempt.recovery === "reconcile-required" && !resources.attempts.isDispatching(attempt.attemptId));
    const changes = resources.changes.restore();
    const completedMutations = new Set(changes.mutations.map((mutation) => mutation.attemptId));
    const unresolvedMutations = Object.values(changes.intents).filter((intent) => !changes.notApplied[intent.attemptId] && !completedMutations.has(intent.attemptId));
    const unresolvedCommands = Object.values(changes.commandAttempts).filter((attempt) => attempt.status === "pending");
    return Object.freeze([
      ...(unresolvedAttempts.length ? [`${unresolvedAttempts.length} unresolved unknown-side-effect attempt(s) require reconciliation`] : []),
      ...(unresolvedMutations.length ? [`${unresolvedMutations.length} unresolved queued mutation accounting intent(s) require reconciliation`] : []),
      ...(unresolvedCommands.length ? [`${unresolvedCommands.length} unresolved shell/Git change-accounting attempt(s) require reconciliation`] : []),
    ]);
  }

  private recoveryAdmissionIssues(resources: Pick<RunResources, "attempts" | "changes" | "recoveryIssues">): readonly string[] {
    return Object.freeze([...resources.recoveryIssues, ...this.recoveryAdmissionIssuesFromDispatch(resources)]);
  }

  private assertRecoveredForAdmission(resources: Pick<RunResources, "attempts" | "changes" | "recoveryIssues">): void {
    const issues = this.recoveryAdmissionIssues(resources);
    if (issues.length) throw new Error(`Workflow admission blocked by recovery: ${issues.join("; ")}`);
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
    if (!this.current.changes.restore().baseline) throw new Error("Durable run-start change baseline is missing; execution fails closed");
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

  private bind(context: DelegationExecutionContext, resources: RunResources): BoundDelegationServices {
    const assertCurrent = (): void => {
      const run = this.lifecycle.restore().latestRun;
      if (run?.runId === resources.runId && run.pendingTerminal) {
        const current = this.current?.runId === resources.runId ? this.current : undefined;
        if (current) this.failClosedForTerminal(current);
        throw new Error("Delegation services are unavailable while terminal settlement is finalizing");
      }
      const delegation = resources.runtime.restore();
      if (!run || !isOpenRunStatus(run.status) || run.runId !== resources.runId || this.current?.runId !== resources.runId || !delegation.admissionOpen) {
        throw new Error(`Delegation services are stale and do not target the current open run${delegation.closedReason ? `: ${delegation.closedReason}` : ""}`);
      }
      resources.runtime.assertExecutionContext(context);
    };
    const assertAdmission = (): void => {
      assertCurrent();
      if (this.lifecycle.restore().latestRun?.status !== "running") throw new Error("Workflow admission requires a running run");
      this.assertRecoveredForAdmission(resources);
    };
    const dispatch: TrustedWorkflowDispatch = Object.freeze({
      schemaVersion: 1 as const,
      model: (input: RootModelDispatchRequest) => { assertAdmission(); return this.dispatchModel(resources.dispatchRuntime, context.nodeId, input); },
      tool: <T>(input: WorkerTrustedToolDispatchRequest<T>) => { assertAdmission(); return this.dispatchTool(resources.dispatchRuntime, context.nodeId, input); },
    });
    return Object.freeze({
      context,
      dispatch,
      route: (input: RouteDirectMembersInput) => { assertCurrent(); return routeDirectMembers(this.options.snapshot, context.nodeId, input); },
      delegate: (input: AcceptDelegationInput) => {
        assertAdmission();
        try { return resources.runtime.accept(context, input); }
        catch (error) {
          const detail = record(error) ? error : {};
          if (detail.budgetScope === "run" && Array.isArray(detail.budgetExhausted)) this.blockRunForBudget(resources, context.nodeId, String(error instanceof Error ? error.message : error));
          throw error;
        }
      },
      status: (options: { limit?: number; cursor?: string } = {}) => { assertCurrent(); return resources.runtime.status(context, options); },
      preparedResultDelivery: () => { assertCurrent(); return resources.runtime.preparedResultDelivery(context); },
      prepareResultDelivery: (deliveryId: string, options: { limit?: number } = {}) => { assertCurrent(); return resources.runtime.prepareResultDelivery(context, deliveryId, options); },
      acceptResultDelivery: (deliveryId: string) => { assertCurrent(); resources.runtime.acceptResultDelivery(context, deliveryId); },
    });
  }

  rootServices(): BoundDelegationServices {
    const resources = this.resources();
    this.assertRecoveredForAdmission(resources);
    return this.bind(resources.runtime.rootExecutionContext(), resources);
  }

  servicesFor(context: DelegationExecutionContext): BoundDelegationServices {
    const resources = this.resources();
    this.assertRecoveredForAdmission(resources);
    resources.runtime.status(context, { limit: 1 });
    return this.bind(context, resources);
  }

  budgetRuntime(): BudgetRuntime {
    const run = this.lifecycle.restore().latestRun;
    if (!run) throw new Error("Budget runtime requires a workflow run");
    return this.current?.runId === run.runId ? this.current.budgets : this.budgetRuntimeFor(run.runId);
  }

  budgetState(): BudgetState {
    return this.budgetRuntime().restore();
  }

  attemptRuntime(): AttemptRuntime {
    const run = this.lifecycle.restore().latestRun;
    if (!run) throw new Error("Attempt runtime requires a workflow run");
    return this.current?.runId === run.runId ? this.current.attempts : new AttemptRuntime({ projectRoot: this.options.projectRoot, projectId: this.options.projectId, sessionId: this.options.sessionId, runId: run.runId, now: this.options.now });
  }

  changeAccounting(): ChangeAccountingRuntime {
    const run = this.lifecycle.restore().latestRun;
    if (!run) throw new Error("Change accounting requires a workflow run");
    return this.current?.runId === run.runId ? this.current.changes : this.changeAccountingFor(run.runId);
  }

  private reconcileRecoveredCommandAccounting(attempts: AttemptRuntime, changes: ChangeAccountingRuntime): void {
    const attemptState = attempts.restore();
    for (const command of Object.values(changes.restore().commandAttempts)) {
      const attempt = attemptState.attempts[command.attemptId];
      if (command.status === "pending" && attempt?.reconciliation) changes.reconcileCommandAttempt(command.attemptId, attempt.reconciliation);
    }
  }

  async recoverSideEffects(options: Omit<UnknownSideEffectRecoveryOptions, "pauseUnknownSideEffect">): Promise<UnknownSideEffectRecoveryReport> {
    const attempts = this.attemptRuntime();
    const report = await recoverUnknownSideEffects(attempts, {
      ...options,
      pauseUnknownSideEffect: async (diagnostics) => {
        await this.pause(`unknown_side_effect: ${diagnostics.join("; ").slice(0, 2_048)}`);
      },
    });
    this.reconcileRecoveredCommandAccounting(attempts, this.changeAccounting());
    return report;
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
    if (Object.values(resources.attempts.restore().attempts).some((attempt) => !attempt.result && attempt.recovery === "reconcile-required")) {
      const report = await recoverUnknownSideEffects(resources.attempts, {
        reconcilers: this.options.recoveryReconcilers,
        pauseUnknownSideEffect: async (diagnostics) => { await this.pause(`unknown_side_effect: ${diagnostics.join("; ").slice(0, 2_048)}`); },
      });
      this.reconcileRecoveredCommandAccounting(resources.attempts, resources.changes);
      if (report.paused) throw new Error(`Worker admission paused for unresolved unknown side effects: ${report.diagnostics.join("; ")}`);
    }
    this.assertRecoveredForAdmission(resources);
    const run = this.lifecycle.restore().latestRun;
    if (!run || run.runId !== resources.runId || !isOpenRunStatus(run.status) || run.status === "paused" || run.cancellationRequested) {
      throw new Error("Workers can run only for the current running workflow run");
    }
    await resources.scheduler.runUntilSettled();
    const recoveryIssues = this.recoveryAdmissionIssues(resources);
    if (recoveryIssues.length) {
      if (this.lifecycle.restore().latestRun?.status === "running") await this.pause(`unknown_side_effect: ${recoveryIssues.join("; ").slice(0, 2_048)}`);
      throw new Error(`Worker execution paused for unresolved unknown side effects: ${recoveryIssues.join("; ")}`);
    }
    const runWideFailure = Object.values(resources.attempts.restore().attempts)
      .flatMap((attempt) => attempt.result?.budgetExhausted?.length ? [attempt.result] : [])
      .find((result) => budgetExhaustionScope(result.budgetExhausted!) === "run");
    if (runWideFailure) {
      const reason = runWideFailure.error ?? runWideFailure.budgetExhausted!.join(", ");
      const terminal = await this.lifecycle.failBudgetExhaustion(reason);
      if (!terminal.ok) throw new Error(`Run-wide budget exhaustion failed to settle: ${terminal.issues.join("; ")}`);
      throw budgetError(reason, runWideFailure.budgetExhausted!, "run");
    }
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
