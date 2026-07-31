import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";
import { resolveCanonicalPath } from "../core/safe-path";
import { classifyTrustedTool } from "../capabilities/tools";
import type { CommandAttemptMetadata } from "../capabilities/command";
import { compileSnapshotNodeToolPolicies, type SnapshotNodeToolPolicy } from "../capabilities/runtime-policy";
import {
  DelegationRuntime,
  createDelegationState,
  reduceDelegationState,
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
  createEmptyRunLifecycleState,
  reduceRunLifecycle,
  isOpenRunStatus,
  type ArtifactReference,
  type CancellationCoordinator,
  type CancellationResult,
  type CompletionValidationHooks,
  type PauseCoordinator,
  type ResumeCoordinator,
  type WorkflowRunLifecycleOptions,
} from "./runs";
import { DurableDelegationScheduler } from "./scheduler";
import { replayWorkflowJournal } from "./replay";
import {
  WorkerSessionPool,
  type WorkerPromptResponse,
  type WorkerProviderUsage,
  type WorkerSessionFactory,
  type WorkerSessionHandle,
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
  hashAttemptInput,
  type AttemptConsumerReceiptBinding,
  type TrustedAttemptDescriptor,
} from "./attempts";
import { ChangeAccountingRuntime, type ChangeAccountingOptions } from "./change-accounting";
import { recoverUnknownSideEffects, type UnknownSideEffectRecoveryOptions, type UnknownSideEffectRecoveryReport } from "./recovery";
import {
  assertCompactionPreservation,
  assertLosslessDynamicPromptInputs,
  assembleRootWorkflowPrompt,
  buildCompactionPreservationBlock,
  losslessDynamicPromptInputs,
  type WorkflowPromptAssembly,
} from "./prompts";
import { appendWorkflowEvent, configureWorkflowJournalRedaction, readWorkflowJournal } from "./journal";
import type { WorkflowRedactionOptions } from "../observability/redaction";
import { createWorkflowEvent } from "./events";
import { handoffForRun, handoffPromptInput } from "./handoff";
import {
  buildWorkflowStatusPage,
  issueWorkflowToolRuntimeBinding,
  runWithWorkflowToolRuntime,
} from "./tools";
import { BUILTIN_ARTIFACT_REGISTRY, type ResolvedArtifactProfile } from "../artifacts/registry";
import { ArtifactFacade, type ArtifactMutationQueue, type ArtifactOperationRecoveryReport, type ArtifactWorkspaceAuthority } from "../artifacts/facade";
import { hashArtifactWorkspace } from "../artifacts/hashes";
import { WorkspaceLeaseRuntime, type WorkspaceLeaseRuntimeOptions } from "../artifacts/leases";
import { ArtifactOperationRuntime, type ArtifactOperationRuntimeOptions } from "../artifacts/operations";
import {
  ARTIFACT_WORKSPACE_BIND_ACTION_ID,
  bindPhysicalArtifactWorkspace,
  listPhysicalArtifactWorkspaces,
  parseArtifactWorkspaceBindArguments,
  unboundArtifactWorkspaceStatus,
  type PhysicalWorkspaceSelection,
} from "../artifacts/workspaces";
import { createRunOrchestrationArtifactCallerIssuer, type RunOrchestrationArtifactCallerIssuer } from "../artifacts/internal/caller";
import type { ArtifactActionResultV1, ArtifactEvidenceReferenceV1, ArtifactStatusViewV1, ArtifactWorkspaceBinding, VerifiedArtifactEvidenceV1 } from "../artifacts/types";
import { ARTIFACT_ACTION_VERSION } from "../artifacts/contracts";
import { heartbeatCurrentRuntimeOwnership } from "./ownership";
import { registerLiveWorkflowCancellationAuthority } from "./live-cancellation";
import { resolveContainedPath } from "../core/safe-path";
import {
  CHECKPOINT_APPROVAL_LIMITS,
  CHECKPOINT_REQUEST_ACTION_ID,
  CheckpointApprovalService,
  checkpointRequestProviderContract,
  parseCheckpointRequestActionArguments,
  type CheckpointApprovalRequestRecord,
  type CheckpointApprovalServiceOptions,
} from "../artifacts/approvals";
import { resolveCheckpointDigest, type CheckpointPolicy } from "../artifacts/checkpoints";
import { QuestionService, deriveQuestionRunStatus, type AcceptedQuestionForRoot, type QuestionControlAuthenticationRequest, type QuestionPresenter, type RootQuestionAnswerDelivery } from "./questions";
import { QUESTION_LIMITS } from "./question-validation";
import { utf8Prefix } from "./values";
import { KnowledgeService } from "../knowledge/search";
import { CURATOR_EXECUTION_POLICY, KnowledgeEnrichmentService, restoreKnowledgeEnrichmentState } from "../knowledge/enrichment";
import { DurableKnowledgeQueue } from "../knowledge/queue";
import { KnowledgeCuratorProcessor, type KnowledgeCuratorModelRequest, type KnowledgeCuratorModelResult } from "../knowledge/curator";
import { curatorFitsSnapshotModelContext } from "../knowledge/curator-contract";
import { KnowledgeProposalService, OkfKnowledgeMutator, type KnowledgeMutationQueue, type KnowledgeProposalControlRequest } from "../knowledge/proposals";
import { createKnowledgeReferenceAuthorizer, knowledgeProtectedPathRoots } from "../knowledge/attachments";

export interface RunOrchestrationServiceOptions {
  readonly projectRoot: string; readonly projectId: string; readonly sessionId: string;
  readonly snapshot: ActivationSnapshotFileV1; readonly runtimeOwnerNonce: string; readonly maxParallel: number;
  readonly workerFactory: WorkerSessionFactory;
  /** Runtime-configured secrets and protected roots applied centrally to every project journal writer. */
  readonly journalRedaction?: WorkflowRedactionOptions;
  readonly budgetLimits?: EffectiveRuntimeBudgetLimits;
  readonly nowMs?: () => number;
  /** Required when taking over a run whose previous owner left an active budget clock. */
  readonly recoveredOwnerHeartbeatAt?: string;
  readonly recoveryReconcilers?: UnknownSideEffectRecoveryOptions["reconcilers"];
  readonly changeAccounting?: Pick<ChangeAccountingOptions, "scopes" | "protectedRoots" | "limits">;
  readonly createRunId?: () => string; readonly createTaskId?: () => string; readonly createAttemptId?: () => string;
  readonly now?: () => string; readonly referenceAuthorizer?: DelegationRuntime["options"]["referenceAuthorizer"];
  /** Integration seam backed by Pi's withFileMutationQueue; required before any physical adapter mutation. */
  readonly artifactMutationQueue?: ArtifactMutationQueue;
  /** Pi file-mutation queue for automatic knowledge updates; defaults to the artifact queue seam. */
  readonly knowledgeMutationQueue?: KnowledgeMutationQueue;
  /** Authenticated dashboard control dependency for reviewed knowledge proposals. */
  readonly knowledgeControl?: Readonly<{ authenticateControl: (request: KnowledgeProposalControlRequest) => string | undefined }>;
  /** Package-internal dependency seam used to exercise physical adapters before their built-in implementation ships. */
  readonly artifactRuntime?: ResolvedArtifactProfile;
  /** Package-internal lease construction seam for deterministic lifecycle fault tests. */
  readonly artifactLeaseFactory?: (options: WorkspaceLeaseRuntimeOptions) => WorkspaceLeaseRuntime;
  /** Fault-injection seam for artifact/W13 restart-settlement tests. */
  readonly artifactOperationFault?: ArtifactOperationRuntimeOptions["fault"];
  /** Human control dependencies for the run-owned generic checkpoint authority. Omission denies every decision. */
  readonly checkpointApproval?: Partial<Pick<CheckpointApprovalServiceOptions, "authenticateControl" | "createRequestId" | "createDecisionId" | "fault">>;
  /** Proof may be bound to a persisted runtime-owner nonce when supplied. */
  readonly verifiedTakeover?: (ownerNonce?: string) => boolean | Promise<boolean>;
  readonly completion?: Omit<CompletionValidationHooks, "descendants" | "questions" | "validateQuestionSet" | "validateRootQuestionDelivery">;
  readonly questionControl?: Readonly<{ authenticateControl: (request: QuestionControlAuthenticationRequest) => string | undefined; presentLive?: QuestionPresenter; journalFault?: QuestionService["options"]["journalFault"] }>;
  /** Fault-injection seam for workflow lifecycle crash-recovery tests. */
  readonly journalFault?: WorkflowRunLifecycleOptions["journalFault"];
  readonly pauseAuthority: PauseCoordinator; readonly resumeAuthority: ResumeCoordinator;
  readonly cancellationAuthority: Pick<CancellationCoordinator, "waitForSettlement" | "terminateProcessTrees" | "capturePartialState" | "releaseLeases">;
}
export interface RootModelInvocation {
  readonly promptContext: WorkflowPromptAssembly;
  readonly rootQuestionDelivery?: RootQuestionAnswerDelivery;
  readonly rootQuestionDeliveries?: readonly RootQuestionAnswerDelivery[];
}
interface ModelConsumerReceiptBinding {
  readonly deliveryIds: readonly string[];
  readonly promptHash: string;
  readonly transcriptRef: string;
  /** Pure durable-state snapshot, evaluated after provider dispatch and before result publication. */
  readonly resolveDeliveryIds?: () => readonly string[];
  readonly record: (attemptId: string, binding: AttemptConsumerReceiptBinding) => void;
}
export interface RootModelDispatchRequest {
  readonly correlationId: string; readonly operation: string; readonly input: unknown; readonly finalization?: boolean;
  readonly installCompactionBoundary?: (boundary: Readonly<{ preservation: string; validate(value: string): void }>) => void;
  readonly dispatch: (invocation: RootModelInvocation) => string | WorkerPromptResponse | Promise<string | WorkerPromptResponse>;
  /** Package-internal exact prompt/delivery binding prepared by the root service. */
  readonly promptInvocation?: RootModelInvocation;
  readonly consumerReceipt?: ModelConsumerReceiptBinding;
  /** Package-internal durable replay identity, independent of prompt delivery projection. */
  readonly replayInput?: unknown;
  readonly recoveryAttemptId?: string;
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
  deliverResults(deliveryId: string, options?: { limit?: number }): ResultDeliveryBatch;
  runWithToolRuntime<T>(callback: () => T): T;
}
interface RunResources {
  readonly runId: string; readonly runtime: DelegationRuntime;
  readonly budgets: BudgetRuntime; readonly attempts: AttemptRuntime; readonly changes: ChangeAccountingRuntime;
  readonly knowledge: KnowledgeService;
  readonly enrichment: KnowledgeEnrichmentService;
  readonly recoveryIssues: readonly string[];
  readonly dispatchRuntime: DispatchResources;
  readonly scheduler: DurableDelegationScheduler; readonly workers: WorkerSessionPool; readonly questions: QuestionService;
}
interface DispatchResources extends Pick<RunResources, "budgets" | "attempts" | "changes"> {
  readonly assertAdmission: () => void;
  readonly assertWaitingForHumanAdmission: () => void;
  readonly pauseUnknown: (reason: string) => void;
  readonly blockRunBudget: (nodeId: string, reason: string) => void;
  readonly canTerminalizeRunBudget: () => boolean;
}

function runtimeArtifact(snapshot: ActivationSnapshotFileV1, injected?: ResolvedArtifactProfile): ResolvedArtifactProfile | undefined {
  const workflow = snapshot.payload.workflow as { artifact?: unknown };
  if (!record(workflow.artifact)) return undefined;
  const artifact = workflow.artifact;
  if (typeof artifact.contractVersion !== "string" || typeof artifact.adapter !== "string" || typeof artifact.adapterVersion !== "string"
    || typeof artifact.profile !== "string" || typeof artifact.profileVersion !== "string" || typeof artifact.optionsSchemaVersion !== "string"
    || artifact.viewVersion !== 1 || !Array.isArray(artifact.checkpoints) || !Array.isArray(artifact.actionIds)) throw new Error("Activation snapshot artifact selection is invalid");
  const selection = {
    contractVersion: artifact.contractVersion,
    adapterId: artifact.adapter,
    adapterVersion: artifact.adapterVersion,
    profileId: artifact.profile,
    profileVersion: artifact.profileVersion,
  };
  const resolved = injected ?? BUILTIN_ARTIFACT_REGISTRY.resolveProfile(selection);
  if (resolved.profile.contractVersion !== selection.contractVersion || resolved.profile.adapterId !== selection.adapterId
    || resolved.profile.adapterVersion !== selection.adapterVersion || resolved.profile.id !== selection.profileId
    || resolved.profile.version !== selection.profileVersion || resolved.adapter.contractVersion !== selection.contractVersion
    || resolved.adapter.id !== selection.adapterId || resolved.adapter.version !== selection.adapterVersion
    || !resolved.adapter.profiles.includes(resolved.profile)) throw new Error("Injected artifact adapter/profile identity is incompatible with the activation snapshot");
  if (resolved.profile.optionsSchemaVersion !== artifact.optionsSchemaVersion || resolved.profile.viewVersion !== artifact.viewVersion
    || canonicalJson(resolved.profile.checkpointIds) !== canonicalJson(artifact.checkpoints)
    || canonicalJson(resolved.profile.actions.map((action) => action.id)) !== canonicalJson(artifact.actionIds)) throw new Error("Activation snapshot artifact profile identity is incompatible");
  return resolved;
}

function checkpointPolicies(snapshot: ActivationSnapshotFileV1, selected: ResolvedArtifactProfile): Readonly<Record<string, CheckpointPolicy>> {
  const artifact = (snapshot.payload.workflow as { artifact?: unknown }).artifact;
  if (!record(artifact) || !record(artifact.approvals)) throw new Error("Activation snapshot checkpoint policies are invalid");
  const policies: Record<string, CheckpointPolicy> = {};
  for (const checkpointId of selected.profile.checkpointIds) {
    const policy = artifact.approvals[checkpointId];
    if (policy !== "required" && policy !== "optional" && policy !== "none") throw new Error(`Activation snapshot checkpoint policy is missing or invalid: ${checkpointId}`);
    policies[checkpointId] = policy;
  }
  if (Object.keys(artifact.approvals).some((checkpointId) => !selected.profile.checkpointIds.includes(checkpointId))) throw new Error("Activation snapshot checkpoint policies contain an unknown checkpoint");
  return Object.freeze(policies);
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
      || (usage.costMicroUsd !== undefined && (!Number.isSafeInteger(usage.costMicroUsd) || Number(usage.costMicroUsd) < 0))
      || (usage.precision !== "estimated" && usage.precision !== "provider-confirmed")) {
      throw Object.assign(new Error("Model provider usage is invalid"), { assistantOutputObserved: true, effectNotApplied: true });
    }
    const tokens = { inputTokens: Number(usage.inputTokens), outputTokens: Number(usage.outputTokens) };
    return usage.precision === "provider-confirmed" && usage.costMicroUsd !== undefined
      ? Object.freeze({ ...tokens, costMicroUsd: Number(usage.costMicroUsd), precision: "provider-confirmed" as const })
      : Object.freeze({ ...tokens, ...(usage.costMicroUsd === undefined ? {} : { costMicroUsd: Number(usage.costMicroUsd) }), precision: "estimated" as const });
  }
  return Object.freeze({ inputTokens: estimatedTokens(inputText), outputTokens: estimatedTokens(responseOutput(value)), precision: "estimated" });
}
function budgetError(reason: string, exhausted: readonly string[], scope: "node" | "run"): Error {
  return Object.assign(new Error(reason), { policyDenied: true, effectNotApplied: true, budgetExhausted: [...exhausted], budgetScope: scope });
}
const defaultArtifactMutationQueue: ArtifactMutationQueue = async (canonicalPath, _operationId, callback) => {
  // Keep the Pi dependency lazy so core policy/schema imports remain runtime-neutral.
  const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
  return withFileMutationQueue(canonicalPath, async () => callback());
};
const defaultKnowledgeMutationQueue: KnowledgeMutationQueue = defaultArtifactMutationQueue;

export class RunOrchestrationService {
  readonly lifecycle: WorkflowRunLifecycle;
  private readonly options: RunOrchestrationServiceOptions;
  private readonly selectedArtifact?: ResolvedArtifactProfile;
  private readonly artifactCallerIssuer?: RunOrchestrationArtifactCallerIssuer;
  private readonly nodeToolPolicies: ReadonlyMap<string, SnapshotNodeToolPolicy>;
  /** One authority owns run snapshots, requests, control decisions, and completion. */
  readonly checkpointApprovals?: CheckpointApprovalService;
  private current?: RunResources;
  private artifactAuthority?: Readonly<{ runId: string; authority: ArtifactWorkspaceAuthority }>;
  private preserveCancelledEnrichment = false;
  private readonly cleanup = new Set<Promise<void>>();
  private readonly knowledgeProposalsRuntime: KnowledgeProposalService;
  private readonly knowledgeMutator: OkfKnowledgeMutator;
  private readonly knowledgeProcessor: KnowledgeCuratorProcessor;
  private readonly knowledgeQueue: DurableKnowledgeQueue;
  private readonly curatorHandles = new Map<string, WorkerSessionHandle>();
  private readonly curatorDisposals = new Map<string, Promise<void>>();
  private knowledgeReconciliation?: Promise<void>;
  private knowledgeReconcileImmediate?: ReturnType<typeof setTimeout>;
  private knowledgeRetryTimer?: ReturnType<typeof setTimeout>;
  private knowledgeRetryAttempt = 0;
  private shuttingDown = false;
  private userWorkDepth = 0;
  private unregisterLiveCancellationAuthority: () => void = () => {};

  constructor(options: RunOrchestrationServiceOptions) {
    this.options = options;
    if (options.journalRedaction) configureWorkflowJournalRedaction(options.projectRoot, options.journalRedaction);
    const selectedArtifact = runtimeArtifact(options.snapshot, options.artifactRuntime);
    this.selectedArtifact = selectedArtifact;
    this.artifactCallerIssuer = selectedArtifact ? createRunOrchestrationArtifactCallerIssuer(options.snapshot) : undefined;
    const artifact = record(options.snapshot.payload.workflow.artifact) ? options.snapshot.payload.workflow.artifact as Record<string, unknown> : undefined;
    const compiledToolPolicies = compileSnapshotNodeToolPolicies({
      projectRoot: options.projectRoot,
      snapshot: options.snapshot,
      ...(selectedArtifact ? { artifact: { resolved: selectedArtifact, options: record(artifact?.options) ? artifact.options : {} } } : {}),
    });
    this.nodeToolPolicies = new Map(compiledToolPolicies.map((policy) => [policy.nodeId, policy]));
    this.checkpointApprovals = selectedArtifact ? new CheckpointApprovalService({
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      sessionId: options.sessionId,
      adapterId: selectedArtifact.adapter.id,
      adapterVersion: selectedArtifact.adapter.version,
      profileId: selectedArtifact.profile.id,
      profileVersion: selectedArtifact.profile.version,
      profileSchemaVersion: selectedArtifact.profile.optionsSchemaVersion,
      checkpointPolicies: checkpointPolicies(options.snapshot, selectedArtifact),
      ...(selectedArtifact.adapter.checkpointDescriptor ? {
        resolveDescriptor: ({ checkpointId, binding }) => {
          if (!binding.path) throw new Error("Physical checkpoint descriptor requires a bound workspace path");
          return selectedArtifact.adapter.checkpointDescriptor!({ binding, checkpointId, hashes: hashArtifactWorkspace(binding.path) });
        },
      } : {}),
      authenticateControl: options.checkpointApproval?.authenticateControl ?? (() => undefined),
      ...(options.checkpointApproval?.createRequestId ? { createRequestId: options.checkpointApproval.createRequestId } : {}),
      ...(options.checkpointApproval?.createDecisionId ? { createDecisionId: options.checkpointApproval.createDecisionId } : {}),
      ...(options.checkpointApproval?.fault ? { fault: options.checkpointApproval.fault } : {}),
      now: options.now,
      onRunStatusChanged: (runId, status) => {
        const budgets = this.budgetRuntimeFor(runId);
        if (status === "waiting_for_human") budgets.pauseActive(status); else budgets.resumeActive();
      },
    }) : undefined;
    const completion: CompletionValidationHooks = {
      ...(options.completion ?? {}),
      descendants: () => this.descendantGate(),
      questions: () => {
        const run = this.lifecycle.restore().latestRun;
        return run ? this.questionRuntimeFor(run.runId).completionGate() : Object.freeze({ state: "not-present" as const });
      },
      validateQuestionSet: (events, expectedQuestionIds) => {
        const run = this.lifecycle.restore().latestRun;
        if (!run) throw new Error("Question set validation requires a current run");
        this.questionRuntimeFor(run.runId).assertPendingSet(events, expectedQuestionIds);
      },
      validateRootQuestionDelivery: (events) => {
        const run = this.lifecycle.restore().latestRun;
        if (!run) throw new Error("Root question delivery validation requires a current run");
        this.questionRuntimeFor(run.runId).assertRootMayTerminal(events);
      },
      adapter: async () => {
        const run = this.lifecycle.restore().latestRun;
        const builtin = selectedArtifact?.adapter && run?.artifactWorkspace
          ? await selectedArtifact.adapter.validateCompletion(run.artifactWorkspace)
          : selectedArtifact
            ? Object.freeze({ state: "unsatisfied" as const, issues: Object.freeze([`artifact adapter ${selectedArtifact.profile.adapterId} is unavailable or unbound`]) })
            : Object.freeze({ state: "not-present" as const });
        const upstream = options.completion?.adapter ? await options.completion.adapter() : Object.freeze({ state: "not-present" as const });
        if (builtin.state === "unsatisfied" || upstream.state === "unsatisfied") return Object.freeze({ state: "unsatisfied" as const, issues: Object.freeze([...(("issues" in builtin && builtin.issues) || []), ...(("issues" in upstream && upstream.issues) || [])]) });
        return Object.freeze({ state: builtin.state === "satisfied" || upstream.state === "satisfied" ? "satisfied" as const : "not-present" as const });
      },
      approvals: async () => {
        const run = this.lifecycle.restore().latestRun;
        const binding = run?.artifactWorkspace;
        const expectedWorkspaceHash = binding?.workspace.kind === "physical" && binding.path ? hashArtifactWorkspace(binding.path).workspaceHash : undefined;
        const builtin = this.checkpointApprovals
          ? await this.checkpointApprovals.completionGate({ ...(expectedWorkspaceHash ? { expectedWorkspaceHash } : {}), ...(run ? { runId: run.runId } : {}) })
          : Object.freeze({ state: "not-present" as const });
        const upstream = options.completion?.approvals ? await options.completion.approvals() : Object.freeze({ state: "not-present" as const });
        if (builtin.state === "unsatisfied" || upstream.state === "unsatisfied") return Object.freeze({ state: "unsatisfied" as const, issues: Object.freeze([...(("issues" in builtin && builtin.issues) || []), ...(("issues" in upstream && upstream.issues) || [])]) });
        return Object.freeze({ state: builtin.state === "satisfied" || upstream.state === "satisfied" ? "satisfied" as const : "not-present" as const });
      },
      artifacts: async (references) => {
        const run = this.lifecycle.restore().latestRun;
        const binding = run?.artifactWorkspace;
        const issues: string[] = [];
        if (references.length) {
          if (!selectedArtifact?.adapter.checkpointDescriptor || !binding || binding.workspace.kind !== "physical" || !binding.path) issues.push("artifact references require a bound physical workspace with checkpoint descriptors");
          else {
            const hashes = hashArtifactWorkspace(binding.path);
            for (const reference of references) {
              if (reference.workspaceId !== binding.workspace.id || !binding.checkpointIds.includes(reference.checkpoint)) { issues.push(`artifact reference ${reference.workspaceId}/${reference.checkpoint} does not match the bound workspace`); continue; }
              try {
                const descriptor = selectedArtifact.adapter.checkpointDescriptor({ binding, checkpointId: reference.checkpoint, hashes });
                if (resolveCheckpointDigest(descriptor, hashes).digest !== reference.digest) issues.push(`artifact reference ${reference.workspaceId}/${reference.checkpoint} is stale`);
              } catch (error) { issues.push(`artifact reference ${reference.workspaceId}/${reference.checkpoint} is invalid: ${String(error instanceof Error ? error.message : error).slice(0, 1_024)}`); }
            }
          }
        }
        const builtin = issues.length ? Object.freeze({ state: "unsatisfied" as const, issues: Object.freeze(issues) }) : Object.freeze({ state: references.length ? "satisfied" as const : "not-present" as const });
        const upstream = options.completion?.artifacts ? await options.completion.artifacts(references) : Object.freeze({ state: "not-present" as const });
        if (builtin.state === "unsatisfied" || upstream.state === "unsatisfied") return Object.freeze({ state: "unsatisfied" as const, issues: Object.freeze([...(("issues" in builtin && builtin.issues) || []), ...(("issues" in upstream && upstream.issues) || [])]) });
        return Object.freeze({ state: builtin.state === "satisfied" || upstream.state === "satisfied" ? "satisfied" as const : "not-present" as const });
      },
      projectState: async () => {
        const run = this.lifecycle.restore().latestRun;
        if (!run) return Object.freeze({ state: "unsatisfied" as const, issues: Object.freeze(["project state: no workflow run is active"]) });
        const accounting = this.changeAccountingFor(run.runId);
        const derived = accounting.reconcile();
        const attemptRuntime = this.current?.runId === run.runId
          ? this.current.attempts
          : new AttemptRuntime({ projectRoot: options.projectRoot, projectId: options.projectId, sessionId: options.sessionId, runId: run.runId, now: options.now });
        const attempts = attemptRuntime.restore();
        const unresolvedAttempts = Object.values(attempts.attempts).filter((attempt) => !attempt.result && !attemptRuntime.isDispatching(attempt.attemptId));
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
        this.questionRuntimeFor(settlement.runId).closePending({
          reason: `run ${settlement.status}`,
          operationId: settlement.operationId,
          expectedQuestionIds: settlement.closedQuestionIds,
        });
        await this.settleTerminalResources(settlement.runId);
        this.releaseArtifactLease("finish");
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
      ...(this.checkpointApprovals ? { checkpointSnapshots: this.checkpointApprovals.runSnapshotProvider() } : {}),
      createArtifactWorkspace: selectedArtifact?.profile.adapterId === "none" ? (runId) => BUILTIN_ARTIFACT_REGISTRY.bind(selectedArtifact, {
        runId,
        binding: "none",
        options: (options.snapshot.payload.workflow.artifact as { options?: unknown }).options ?? {},
      }) : undefined,
      onRunStarted: (runId) => { this.changeAccountingFor(runId).captureBaseline(); },
      onUserInputRecorded: () => this.knowledgeQueue?.preemptForUserWork(),
      onRunStatusChanged: (runId, status) => {
        const budgets = this.budgetRuntimeFor(runId);
        if (status === "paused" || status === "waiting_for_human") budgets.pauseActive(status);
        else budgets.resumeActive();
      },
      onTerminalRecorded: (event) => {
        const preserveCancelled = this.preserveCancelledEnrichment;
        this.scheduleKnowledgeReconciliation(event, preserveCancelled);
      },
      journalFault: options.journalFault,
    });
    this.knowledgeProposalsRuntime = new KnowledgeProposalService({
      projectRoot: options.projectRoot, projectId: options.projectId, sessionId: options.sessionId, now: options.now,
      authenticateControl: options.knowledgeControl?.authenticateControl ?? (() => undefined),
    });
    this.knowledgeMutator = new OkfKnowledgeMutator({
      projectRoot: options.projectRoot, snapshot: options.snapshot,
      mutationQueue: options.knowledgeMutationQueue ?? options.artifactMutationQueue ?? defaultKnowledgeMutationQueue,
    });
    this.knowledgeProcessor = new KnowledgeCuratorProcessor({
      projectRoot: options.projectRoot, projectId: options.projectId, sessionId: options.sessionId, snapshot: options.snapshot,
      proposals: this.knowledgeProposalsRuntime, mutator: this.knowledgeMutator, now: options.now,
      runModel: (request) => this.runCuratorModel(request),
    });
    this.knowledgeQueue = new DurableKnowledgeQueue({
      projectRoot: options.projectRoot, projectId: options.projectId, sessionId: options.sessionId, ownerNonce: options.runtimeOwnerNonce,
      hasOwnership: () => heartbeatCurrentRuntimeOwnership(options.projectRoot, options.sessionId, options.runtimeOwnerNonce),
      isIdle: () => this.knowledgeIdle(), process: (job, signal) => this.knowledgeProcessor.process(job, signal),
      verifyOwnerDead: async (ownerNonce) => await options.verifiedTakeover?.(ownerNonce) ?? false,
      disposeActive: (jobId) => this.disposeCuratorHandle(jobId), now: options.now,
    });
    this.scheduleKnowledgeReconciliation();
    this.unregisterLiveCancellationAuthority = registerLiveWorkflowCancellationAuthority({
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      sessionId: options.sessionId,
      snapshotId: options.snapshot.snapshotHash,
      runtimeOwnerNonce: options.runtimeOwnerNonce,
      currentRunId: () => this.lifecycle.restore().latestRun?.runId,
      cancel: (reason) => this.cancel(reason),
    });
  }

  toolPolicyForNode(nodeId: string): SnapshotNodeToolPolicy {
    const policy = this.nodeToolPolicies.get(nodeId);
    if (!policy) throw new Error(`Tool policy node ${nodeId} is absent from immutable authority`);
    return policy;
  }

  private artifactSelection(): Readonly<{ binding: string; options: Readonly<Record<string, JsonValue>> }> {
    const artifact = this.options.snapshot.payload.workflow.artifact as { binding?: unknown; options?: unknown };
    const options = record(artifact.options) ? artifact.options as Readonly<Record<string, JsonValue>> : Object.freeze({});
    return Object.freeze({ binding: String(artifact.binding ?? ""), options });
  }

  private artifactMutationQueue(): ArtifactMutationQueue {
    return this.options.artifactMutationQueue ?? defaultArtifactMutationQueue;
  }

  private artifactCapabilitiesForNode(nodeId: string): readonly string[] {
    const authority = this.options.snapshot.payload.authority.nodes.find((entry) => entry.nodeId === nodeId);
    const capabilities = record(authority?.capabilities) && record(authority.capabilities.effective)
      ? authority.capabilities.effective.artifact
      : record(authority?.capabilities) ? authority.capabilities.artifact : undefined;
    return Array.isArray(capabilities) ? capabilities.filter((entry): entry is string => typeof entry === "string") : Object.freeze([]);
  }

  private workspaceBindResult(attemptId: string, binding: ArtifactWorkspaceBinding): ArtifactActionResultV1 {
    return Object.freeze({
      schemaVersion: ARTIFACT_ACTION_VERSION,
      operationId: attemptId,
      actionId: ARTIFACT_WORKSPACE_BIND_ACTION_ID,
      status: "completed",
      summary: `Bound exact ${binding.selection} artifact workspace ${binding.workspace.id}.`,
      changed: true,
      ...(binding.workspaceHash ? { workspaceHash: binding.workspaceHash } : {}),
      data: Object.freeze({
        configuredBinding: binding.binding,
        selection: binding.selection!,
        workspace: Object.freeze({ id: binding.workspace.id, kind: binding.workspace.kind }),
        next: Object.freeze({ tool: "artifact_status" }),
      }),
      refs: Object.freeze([]),
    });
  }

  private checkpointRequestResult(attemptId: string, request: CheckpointApprovalRequestRecord): ArtifactActionResultV1 {
    return Object.freeze({
      schemaVersion: ARTIFACT_ACTION_VERSION,
      operationId: attemptId,
      actionId: CHECKPOINT_REQUEST_ACTION_ID,
      status: "completed",
      summary: `Human approval request ${request.requestId} is pending for checkpoint ${request.checkpointId}.`,
      changed: true,
      workspaceHash: request.requestWorkspaceHash,
      data: Object.freeze({
        requestId: request.requestId,
        checkpointId: request.checkpointId,
        digest: request.digest,
        requestSequence: request.requestSequence,
        state: "pending",
      }),
      refs: Object.freeze([{ id: request.checkpointId, kind: "checkpoint", digest: request.digest }]),
    });
  }

  private artifactStatusWithHarnessActions(nodeId: string, view: ArtifactStatusViewV1): ArtifactStatusViewV1 & Readonly<{ harnessActions?: readonly unknown[]; checkpointRequests?: unknown }> {
    if (nodeId !== rootNodeId(this.options.snapshot) || view.workspace.kind !== "physical" || !this.checkpointApprovals) return view;
    const run = this.lifecycle.restore().latestRun;
    const binding = run?.artifactWorkspace;
    const snapshot = run?.checkpointSnapshot;
    if (!run || !isOpenRunStatus(run.status) || !binding || binding.workspace.kind !== "physical" || !snapshot) return view;
    const eligible = view.checkpoints.filter((checkpoint) => binding.checkpointIds.includes(checkpoint.id) && snapshot.enabledCheckpointIds.includes(checkpoint.id));
    if (!eligible.length) return view;
    const approvalState = this.checkpointApprovals.restore();
    let remainingIds = CHECKPOINT_APPROVAL_LIMITS.statusPendingIds;
    let totalPending = 0;
    const items = eligible.slice(0, CHECKPOINT_APPROVAL_LIMITS.statusCheckpointItems).map((checkpoint) => {
      const requests = approvalState.requestOrder.map((id) => approvalState.requests[id])
        .filter((request) => request.runId === run.runId && request.checkpointId === checkpoint.id);
      const pending = requests.filter((request) => !request.decision);
      totalPending += pending.length;
      const pendingRequestIds = pending.slice(0, remainingIds).map((request) => request.requestId);
      remainingIds -= pendingRequestIds.length;
      const exact = "digest" in checkpoint ? requests.find((request) => request.digest === checkpoint.digest) : undefined;
      const requestable = checkpoint.state === "ready" && !exact?.decision;
      const reason = checkpoint.state !== "ready"
        ? "Checkpoint is not ready for an exact-digest request."
        : exact?.decision?.decision === "approved"
          ? "The exact current digest is already approved."
          : exact?.decision?.decision === "denied"
            ? "The exact current digest was denied; revise the checkpoint before requesting again."
            : undefined;
      return Object.freeze({
        checkpointId: checkpoint.id,
        state: checkpoint.state,
        ...(checkpoint.digest ? { digest: checkpoint.digest } : {}),
        requestable,
        pendingRequestCount: pending.length,
        pendingRequestIds: Object.freeze(pendingRequestIds),
        ...(pendingRequestIds.length < pending.length ? { pendingRequestIdsTruncated: true } : {}),
        ...(reason ? { reason } : {}),
      });
    });
    const requestableCheckpointIds = items.filter((item) => item.requestable).map((item) => item.checkpointId);
    return Object.freeze({
      ...view,
      harnessActions: Object.freeze([Object.freeze({
        id: CHECKPOINT_REQUEST_ACTION_ID,
        label: "Request human checkpoint approval",
        available: requestableCheckpointIds.length > 0,
        ...checkpointRequestProviderContract(requestableCheckpointIds),
        checkpointIds: Object.freeze(requestableCheckpointIds),
      })]),
      checkpointRequests: Object.freeze({
        items: Object.freeze(items),
        total: eligible.length,
        itemsTruncated: items.length < eligible.length,
        pendingRequestCount: totalPending,
        pendingRequestIdsTruncated: totalPending > CHECKPOINT_APPROVAL_LIMITS.statusPendingIds,
      }),
    });
  }

  private async requestCheckpointFromTool(nodeId: string, input: Readonly<{ actionId: string; arguments: Readonly<Record<string, unknown>>; expectedWorkspaceHash?: string }>, attemptId: string, signal?: AbortSignal): Promise<ArtifactActionResultV1> {
    const failNotApplied = (message: string): never => { throw Object.assign(new Error(message), { effectNotApplied: true }); };
    if (nodeId !== rootNodeId(this.options.snapshot)) return failNotApplied("checkpoint-request is root-only harness authority");
    if (input.expectedWorkspaceHash !== undefined) return failNotApplied("checkpoint-request does not accept expectedWorkspaceHash; the harness derives the exact current hash");
    let requestArguments;
    try { requestArguments = parseCheckpointRequestActionArguments(input.arguments); }
    catch (error) { return failNotApplied(String(error instanceof Error ? error.message : error)); }
    const run = this.lifecycle.restore().latestRun;
    const binding = run?.artifactWorkspace;
    if (!run || !isOpenRunStatus(run.status) || !binding || binding.workspace.kind !== "physical" || !binding.path) return failNotApplied("checkpoint-request requires the current open run and a bound physical workspace");
    if (!this.checkpointApprovals || !run.checkpointSnapshot) return failNotApplied("checkpoint-request requires a frozen human checkpoint policy");
    if (!binding.checkpointIds.includes(requestArguments.checkpointId)) return failNotApplied(`Checkpoint ${requestArguments.checkpointId} is not published by the bound adapter profile`);
    if (!run.checkpointSnapshot.enabledCheckpointIds.includes(requestArguments.checkpointId)) return failNotApplied(`Checkpoint ${requestArguments.checkpointId} is disabled for this frozen run and has no human gate`);
    const authority = this.workspaceAuthority(binding, run.runId);
    if (!authority) return failNotApplied("checkpoint-request requires physical workspace authority");
    const facade = new ArtifactFacade({ adapter: this.selectedArtifact!.adapter, profile: this.selectedArtifact!.profile, binding, mutationQueue: this.artifactMutationQueue(), workspaceAuthority: authority });
    const caller = this.artifactCallerIssuer!.issue(nodeId, binding);
    const view = await facade.status(caller, { limit: 1 }, { ...(signal ? { signal } : {}) });
    const checkpoint = view.checkpoints.find((candidate) => candidate.id === requestArguments.checkpointId);
    if (!checkpoint || checkpoint.state !== "ready" || !checkpoint.digest) return failNotApplied(`Checkpoint ${requestArguments.checkpointId} is not ready for an exact-digest approval request`);
    const approvalState = this.checkpointApprovals.restore();
    const prior = approvalState.requestOrder.map((id) => approvalState.requests[id])
      .find((request) => request.runId === run.runId && request.checkpointId === requestArguments.checkpointId && request.digest === checkpoint.digest);
    if (prior?.decision) return failNotApplied(prior.decision.decision === "approved"
      ? `Checkpoint ${requestArguments.checkpointId} exact current digest is already approved`
      : `Checkpoint ${requestArguments.checkpointId} exact current digest was denied; revise it before requesting again`);
    const expectedWorkspaceHash = authority.readHashes().workspaceHash;
    try {
      const request = await this.checkpointApprovals.requestApproval({ operationId: attemptId, checkpointId: requestArguments.checkpointId, expectedWorkspaceHash });
      if (request.digest !== checkpoint.digest || request.requestWorkspaceHash !== expectedWorkspaceHash || request.decision) {
        throw new Error("checkpoint-request publication does not match the exact current pending request identity");
      }
      return this.checkpointRequestResult(attemptId, request);
    } catch (error) {
      const operation = this.checkpointApprovals.restore().operations[attemptId];
      if (!operation && error && (typeof error === "object" || typeof error === "function")) Object.assign(error, { effectNotApplied: true });
      throw error;
    }
  }

  private unboundArtifactStatus(input: Readonly<{ limit?: number; cursor?: string }>) {
    if (!this.selectedArtifact?.adapter || this.selectedArtifact.profile.adapterId === "none") throw new Error("Active artifact profile has no unbound physical workspace discovery");
    const run = this.lifecycle.restore().latestRun;
    if (!run || !isOpenRunStatus(run.status) || run.artifactWorkspace) throw new Error("Unbound artifact discovery requires a current unbound run");
    const handoff = run.handoffPacketHash ? handoffForRun(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), run.runId) : undefined;
    if (run.handoffPacketHash && handoff?.packetHash !== run.handoffPacketHash) throw new Error("Consumed handoff packet is missing or does not match the run marker");
    const configured = this.artifactSelection();
    return unboundArtifactWorkspaceStatus({
      projectRoot: this.options.projectRoot,
      adapter: this.selectedArtifact.adapter,
      profile: this.selectedArtifact.profile,
      configuredBinding: configured.binding as never,
      options: configured.options,
      limit: input.limit ?? 20,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      handoffWorkspaceIds: Object.freeze([...new Set((handoff?.artifactRefs ?? []).map((reference) => reference.workspaceId))].sort()),
    });
  }

  listArtifactWorkspaces(input: Readonly<{ limit: number; cursor?: string }>) {
    if (!this.selectedArtifact?.adapter || this.selectedArtifact.profile.adapterId === "none") throw new Error("Active artifact profile has no physical workspace listing");
    return listPhysicalArtifactWorkspaces({
      projectRoot: this.options.projectRoot, adapter: this.selectedArtifact.adapter, profile: this.selectedArtifact.profile,
      options: this.artifactSelection().options, limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}),
    });
  }

  bindArtifactWorkspace(selection: PhysicalWorkspaceSelection, handoffWorkspaceId?: string, execution?: Readonly<{ attemptId: string; input: unknown }>) {
    if (!this.selectedArtifact?.adapter || this.selectedArtifact.profile.adapterId === "none") throw new Error("Active artifact profile has no physical workspace binding");
    const run = this.lifecycle.restore().latestRun;
    if (!run || !isOpenRunStatus(run.status)) throw new Error("Artifact workspace binding requires a current open run");
    if (run.artifactWorkspace) throw new Error("Artifact workspace is already bound; rebinding is denied");
    const handoff = run.handoffPacketHash ? handoffForRun(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), run.runId) : undefined;
    if (run.handoffPacketHash && handoff?.packetHash !== run.handoffPacketHash) throw new Error("Consumed handoff packet is missing or does not match the run marker");
    let handoffReference: ArtifactReference | undefined;
    if (handoffWorkspaceId !== undefined) {
      if (!handoff || handoffWorkspaceId !== selection.workspaceId) throw new Error("Requested handoff artifact reference is not attached to this run");
      const matches = handoff.artifactRefs.filter((reference) => reference.workspaceId === handoffWorkspaceId);
      if (matches.length !== 1) throw new Error("Handoff artifact reference is missing or ambiguous");
      handoffReference = matches[0];
    }
    const configured = this.artifactSelection();
    const binding = bindPhysicalArtifactWorkspace({
      projectRoot: this.options.projectRoot, adapter: this.selectedArtifact.adapter, profile: this.selectedArtifact.profile,
      runId: run.runId, configuredBinding: configured.binding as never, options: configured.options, selection,
      ...(handoffReference ? { handoffReference } : {}),
    });
    if (selection.mode === "new" && binding.path) {
      const canonicalProject = resolveCanonicalPath(this.options.projectRoot);
      if (!canonicalProject?.exists) throw new Error("Artifact project root became unavailable after binding");
      const workspacePath = relative(canonicalProject.canonicalPath, binding.path).split("\\").join("/");
      const changes = this.changeAccountingFor(run.runId);
      hashArtifactWorkspace(binding.path).entries.filter((entry) => entry.kind === "file").forEach((entry, index) => {
        const prefix = execution?.attemptId ?? `${run.runId}:artifact-bind`;
        changes.recordTrustedCreation(`${prefix}:create:${index + 1}`, `${workspacePath}/${entry.path}`);
      });
    }
    const result = execution ? this.workspaceBindResult(execution.attemptId, binding) : undefined;
    const bound = this.lifecycle.bindArtifactWorkspace(binding, result ? {
      attemptId: execution!.attemptId,
      actionId: ARTIFACT_WORKSPACE_BIND_ACTION_ID,
      attemptInputHash: hashAttemptInput(execution!.input),
      result: result as unknown as JsonValue,
    } : undefined);
    if (selection.mode === "new") {
      const lease = this.workspaceAuthority(bound, run.runId)!.lease.acquire();
      if (!lease.ok) throw new Error(`Artifact writer lease conflict during workspace creation: ${lease.reason}`);
    }
    return bound;
  }

  private async bindArtifactWorkspaceFromTool(nodeId: string, input: Readonly<{ actionId: string; arguments: Readonly<Record<string, unknown>>; expectedWorkspaceHash?: string }>, attemptId: string): Promise<ArtifactActionResultV1> {
    const failNotApplied = (message: string): never => { throw Object.assign(new Error(message), { effectNotApplied: true }); };
    if (input.actionId !== ARTIFACT_WORKSPACE_BIND_ACTION_ID) return failNotApplied(`Artifact action ${input.actionId} is unavailable until a workspace is bound`);
    if (input.expectedWorkspaceHash !== undefined) return failNotApplied("workspace-bind does not accept expectedWorkspaceHash");
    let request;
    try { request = parseArtifactWorkspaceBindArguments(input.arguments); }
    catch (error) { return failNotApplied(String(error instanceof Error ? error.message : error)); }
    const configured = this.artifactSelection();
    if (configured.binding !== "either" && configured.binding !== request.mode) {
      return failNotApplied(`Configured artifact binding ${configured.binding} cannot select ${request.mode} mode`);
    }
    const capabilities = this.artifactCapabilitiesForNode(nodeId);
    if (request.mode === "new" && !capabilities.includes("write")) return failNotApplied("workspace-bind new mode requires artifact write capability");
    if (request.mode === "existing" && !capabilities.some((capability) => capability === "write" || capability === "review")) {
      return failNotApplied("workspace-bind existing mode requires artifact write or review capability");
    }
    const run = this.lifecycle.restore().latestRun;
    if (!run || !isOpenRunStatus(run.status) || run.runId === undefined) return failNotApplied("workspace-bind requires a current open run");
    if (run.artifactWorkspace) return failNotApplied("Artifact workspace is already bound; rebinding is denied");
    let enteredMutationQueue = false;
    try {
      const binding = await this.artifactMutationQueue()(this.options.projectRoot, attemptId, () => {
        enteredMutationQueue = true;
        if (request.mode === "new") {
          try {
            const existing = this.selectedArtifact?.adapter.workspaceLifecycle?.resolve({
              projectRoot: this.options.projectRoot,
              profileId: this.selectedArtifact.profile.id,
              workspaceId: request.workspaceId,
              options: configured.options,
            });
            if (existing) return failNotApplied(`Artifact workspace ${request.workspaceId} already exists; create collision refused`);
          } catch (error) { return failNotApplied(String(error instanceof Error ? error.message : error)); }
        }
        return this.bindArtifactWorkspace(
          { mode: request.mode, workspaceId: request.workspaceId }, request.handoffWorkspaceId, { attemptId, input },
        );
      });
      return this.workspaceBindResult(attemptId, binding);
    } catch (error) {
      if ((!enteredMutationQueue || request.mode === "existing") && !this.lifecycle.restore().latestRun?.artifactWorkspace
        && error && (typeof error === "object" || typeof error === "function")) Object.assign(error, { effectNotApplied: true });
      throw error;
    }
  }

  private workspaceAuthority(binding: ArtifactWorkspaceBinding | undefined, runId: string): ArtifactWorkspaceAuthority | undefined {
    if (!binding || binding.workspace.kind !== "physical" || !binding.path) return undefined;
    if (this.artifactAuthority?.runId === runId) return this.artifactAuthority.authority;
    this.artifactAuthority?.authority.lease.stopHeartbeat();
    const authority: ArtifactWorkspaceAuthority = Object.freeze({
      readHashes: () => hashArtifactWorkspace(binding.path!),
      lease: (this.options.artifactLeaseFactory ?? ((options) => new WorkspaceLeaseRuntime(options)))({
        projectRoot: this.options.projectRoot, adapterId: binding.adapterId, workspaceId: binding.workspace.id,
        sessionId: this.options.sessionId, runId, ownerNonce: this.options.runtimeOwnerNonce,
        onHeartbeatLost: (error) => { void this.pause(`artifact writer lease lost: ${error.message}`).catch(() => undefined); },
      }),
      operations: new ArtifactOperationRuntime({
        projectRoot: this.options.projectRoot, projectId: this.options.projectId, sessionId: this.options.sessionId, runId, now: this.options.now,
        fault: this.options.artifactOperationFault,
      }),
    });
    this.artifactAuthority = Object.freeze({ runId, authority });
    return authority;
  }

  private unresolvedArtifactOperationIds(binding: ArtifactWorkspaceBinding, runId: string): readonly string[] {
    const authority = this.workspaceAuthority(binding, runId);
    if (!authority) return Object.freeze([]);
    return Object.freeze(Object.values(authority.operations.restore().operations)
      .filter((operation) => !operation.result)
      .map((operation) => operation.operationId));
  }

  private verifyArtifactEvidence(resources: RunResources, references: readonly ArtifactEvidenceReferenceV1[]): readonly VerifiedArtifactEvidenceV1[] {
    if (!Array.isArray(references) || !references.length || references.length > 32) throw new Error("Artifact evidence references are invalid or exceed their bound");
    const attempts = resources.attempts.restore().attempts;
    const commands = resources.changes.restore().commandAttempts;
    return Object.freeze(references.map((reference): VerifiedArtifactEvidenceV1 => {
      if (!reference || typeof reference !== "object" || typeof reference.kind !== "string") throw new Error("Artifact evidence reference is invalid");
      if (reference.kind === "tool" || reference.kind === "command") {
        const attemptId = reference.attemptId;
        if (typeof attemptId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(attemptId)) throw new Error("Artifact attempt evidence ID is invalid");
        const attempt = attempts[attemptId];
        if (!attempt?.result?.ok || attempt.status !== "completed") throw new Error(`Artifact ${reference.kind} evidence does not reference a completed successful W13 attempt`);
        const resultHash = createHash("sha256").update("pi-hive-artifact-evidence-result-v1\0").update(canonicalJson(attempt.result)).digest("hex");
        if (reference.kind === "command") {
          if (attempt.descriptor.effect !== "shell" && attempt.descriptor.effect !== "git") throw new Error("Artifact command evidence does not reference a W13 shell/Git attempt");
          if (!attempt.descriptor.readOnly && commands[attempt.attemptId]?.status !== "completed") throw new Error("Artifact mutating command evidence lacks completed repository accounting");
          return Object.freeze({ kind: "command", attemptId: attempt.attemptId, effect: attempt.descriptor.effect, operation: attempt.operation, inputHash: attempt.inputHash, resultHash });
        }
        if (attempt.descriptor.effect === "model" || attempt.descriptor.effect === "shell" || attempt.descriptor.effect === "git") throw new Error("Artifact tool evidence does not reference a trusted non-command W13 tool attempt");
        return Object.freeze({ kind: "tool", attemptId: attempt.attemptId, operation: attempt.operation, inputHash: attempt.inputHash, resultHash });
      }
      if (reference.kind === "repository") {
        const evidencePath = reference.path;
        if (typeof evidencePath !== "string" || !evidencePath || evidencePath.includes("\\") || evidencePath.startsWith("/")
          || evidencePath.split("/").some((part: string) => !part || part === "." || part === "..") || Buffer.byteLength(evidencePath, "utf8") > 4_096) throw new Error("Artifact repository evidence path is invalid");
        const project = resolveCanonicalPath(this.options.projectRoot);
        const candidate = resolveContainedPath(this.options.projectRoot, join(this.options.projectRoot, evidencePath));
        if (!project?.exists || !candidate?.exists || relative(project.canonicalPath, candidate.canonicalPath).split("\\").join("/") !== evidencePath) throw new Error("Artifact repository evidence escapes or is unavailable");
        const stat = lstatSync(candidate.canonicalPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 33_554_432) throw new Error("Artifact repository evidence is not a bounded regular file");
        const digest = `sha256:${createHash("sha256").update(readFileSync(candidate.canonicalPath)).digest("hex")}`;
        if (reference.digest !== digest) throw new Error("Artifact repository evidence expected hash is stale");
        return Object.freeze({ kind: "repository", path: evidencePath, digest, bytes: stat.size });
      }
      throw new Error("Artifact evidence reference kind is unsupported");
    }));
  }

  private reconcileArtifactWorkspaceBindAttempts(attempts: AttemptRuntime): readonly string[] {
    const issues: string[] = [];
    const events = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
    const attemptState = attempts.restore();
    for (const attempt of Object.values(attemptState.attempts)) {
      if (attempt.result || attempt.operation !== "workflow.tool.artifact_action") continue;
      const publication = events.find((event) => event.type === "artifact.recorded" && event.runId === attemptState.runId
        && event.attemptId === attempt.attemptId && event.correlationId === attempt.attemptId
        && record(event.payload) && event.payload.subsystem === "workspace" && event.payload.operation === "bind");
      if (!publication || !record(publication.payload) || !record(publication.payload.toolReceipt)) continue;
      const receipt = publication.payload.toolReceipt;
      const workspace = publication.payload.workspace;
      let binding: ArtifactWorkspaceBinding;
      try {
        if (!record(workspace)) throw new Error("workspace is absent");
        binding = this.lifecycle.restore().latestRun?.artifactWorkspace as ArtifactWorkspaceBinding;
        if (!binding || canonicalJson(binding) !== canonicalJson(workspace)) throw new Error("workspace does not match current run state");
      } catch (error) {
        issues.push(`workspace-bind attempt ${attempt.attemptId} publication is invalid: ${String(error instanceof Error ? error.message : error)}`);
        continue;
      }
      const expected = this.workspaceBindResult(attempt.attemptId, binding);
      if (receipt.attemptId !== attempt.attemptId || receipt.actionId !== ARTIFACT_WORKSPACE_BIND_ACTION_ID
        || receipt.attemptInputHash !== attempt.inputHash || canonicalJson(receipt.result) !== canonicalJson(expected)) {
        issues.push(`workspace-bind attempt ${attempt.attemptId} publication does not match its exact input/result identity`);
        continue;
      }
      try { attempts.reconcile(attempt.attemptId, "applied", { ok: true, value: expected as unknown as JsonValue }); }
      catch (error) { issues.push(`workspace-bind attempt ${attempt.attemptId} reconciliation failed: ${String(error instanceof Error ? error.message : error)}`); }
    }
    return Object.freeze(issues);
  }

  private reconcileCheckpointRequestAttempts(attempts: AttemptRuntime): readonly string[] {
    if (!this.checkpointApprovals) return Object.freeze([]);
    const issues: string[] = [];
    const attemptState = attempts.restore();
    const approvalState = this.checkpointApprovals.restore();
    for (const attempt of Object.values(attemptState.attempts)) {
      if (attempt.result || attempt.operation !== "workflow.tool.artifact_action") continue;
      const request = Object.values(approvalState.requests).find((candidate) => candidate.operationId === attempt.attemptId);
      if (!request) continue;
      const expectedInput = { actionId: CHECKPOINT_REQUEST_ACTION_ID, arguments: { checkpointId: request.checkpointId } };
      const identityMatches = request.runId === attemptState.runId
        && attempt.nodeId === rootNodeId(this.options.snapshot)
        && attempt.descriptor.effect === "artifact" && !attempt.descriptor.readOnly && !attempt.descriptor.idempotent
        && attempt.inputHash === hashAttemptInput(expectedInput);
      if (!identityMatches) {
        issues.push(`checkpoint-request attempt ${attempt.attemptId} does not match its pending request and root W13 identity`);
        continue;
      }
      try {
        attempts.reconcile(attempt.attemptId, "applied", { ok: true, value: this.checkpointRequestResult(attempt.attemptId, request) as unknown as JsonValue });
      } catch (error) {
        issues.push(`checkpoint-request attempt ${attempt.attemptId} reconciliation failed: ${String(error instanceof Error ? error.message : error)}`);
      }
    }
    return Object.freeze(issues);
  }

  private reconcileArtifactAttemptResults(attempts: AttemptRuntime, authority: ArtifactWorkspaceAuthority): readonly string[] {
    const issues: string[] = [];
    const operations = Object.values(authority.operations.restore().operations)
      .filter((operation) => operation.result)
      .sort((a, b) => a.intentSequence - b.intentSequence || a.operationId.localeCompare(b.operationId));
    for (const operation of operations) {
      const attempt = attempts.restore().attempts[operation.operationId];
      if (!attempt) continue;
      const identityMatches = attempt.operation === "workflow.tool.artifact_action"
        && attempt.descriptor.effect === "artifact" && !attempt.descriptor.readOnly && !attempt.descriptor.idempotent
        && operation.attemptInputHash !== undefined && operation.attemptInputHash === attempt.inputHash;
      if (!identityMatches) {
        issues.push(`artifact operation ${operation.operationId} does not match its enclosing W13 attempt identity or input`);
        continue;
      }
      const result = Object.freeze({ ok: true as const, value: operation.result! as unknown as JsonValue });
      try {
        if (attempt.result) {
          if (canonicalJson(attempt.result) !== canonicalJson(result)) issues.push(`artifact operation ${operation.operationId} conflicts with its completed W13 attempt result`);
          continue;
        }
        attempts.reconcile(operation.operationId, operation.reconciliation === "not-applied" ? "not-applied" : "applied", result);
      } catch (error) {
        issues.push(`artifact operation ${operation.operationId} could not settle its enclosing W13 attempt: ${String(error instanceof Error ? error.message : error)}`);
      }
    }
    return Object.freeze(issues);
  }

  private recoverArtifactOperations(binding: ArtifactWorkspaceBinding, runId: string): ArtifactOperationRecoveryReport {
    if (!this.selectedArtifact?.adapter) throw new Error("Physical artifact adapter is unavailable during operation recovery");
    if (!heartbeatCurrentRuntimeOwnership(this.options.projectRoot, this.options.sessionId, this.options.runtimeOwnerNonce)) {
      throw new Error("Current runtime ownership is required during artifact operation recovery");
    }
    const authority = this.workspaceAuthority(binding, runId);
    if (!authority) throw new Error("Physical workspace authority is unavailable during operation recovery");
    authority.lease.assertOwned();
    return new ArtifactFacade({
      adapter: this.selectedArtifact.adapter, profile: this.selectedArtifact.profile, binding,
      mutationQueue: this.artifactMutationQueue(), workspaceAuthority: authority,
    }).recoverUnresolvedOperations();
  }

  private releaseArtifactLease(reason: "pause" | "cancel" | "finish"): Readonly<{ released: boolean; finalWorkspaceHash?: string }> {
    const run = this.lifecycle.restore().latestRun;
    const binding = run?.artifactWorkspace;
    if (!run || !binding || binding.workspace.kind !== "physical") return Object.freeze({ released: false });
    const authority = this.workspaceAuthority(binding, run.runId);
    if (!authority) throw new Error("Bound physical artifact workspace authority is unavailable during lifecycle finalization");
    let leaseOwned = false;
    try { authority.lease.assertOwned(); leaseOwned = true; } catch { /* reader/no-action run */ }
    const finalWorkspaceHash = authority.readHashes().workspaceHash;
    appendWorkflowEvent(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: run.runId, type: "artifact.recorded", producer: "harness",
      payload: { formatVersion: 1, subsystem: "workspace", operation: "final-hash", reason, finalWorkspaceHash, leaseOwned },
      timestamp: this.options.now?.() ?? new Date().toISOString(),
    }));
    const evidence = authority.lease.releaseForLifecycle(reason, finalWorkspaceHash);
    if (!evidence.released && authority.lease.inspect().state !== "available") {
      throw new Error("Artifact writer lease belongs to another run or owner; lifecycle release was denied");
    }
    this.artifactAuthority = undefined;
    return Object.freeze({ released: evidence.released, finalWorkspaceHash });
  }

  private trackCleanup(promise: Promise<void>): void {
    this.cleanup.add(promise);
    void promise.finally(() => { this.cleanup.delete(promise); }).catch(() => undefined);
  }

  private async beginUserWork(): Promise<() => void> {
    this.userWorkDepth++;
    try { await this.knowledgeQueue.preemptForUserWork(); }
    catch (error) { this.userWorkDepth--; throw error; }
    let active = true;
    return () => { if (active) { active = false; this.userWorkDepth--; } };
  }

  private knowledgeIdle(): boolean {
    if (this.userWorkDepth > 0) return false;
    const run = this.lifecycle.restore().latestRun;
    if (!run || !isOpenRunStatus(run.status)) return true;
    if (run.pendingTerminal || this.lifecycle.pendingInputs().length) return false;
    const attempts = this.current?.runId === run.runId ? this.current.attempts
      : new AttemptRuntime({ projectRoot: this.options.projectRoot, projectId: this.options.projectId, sessionId: this.options.sessionId, runId: run.runId, now: this.options.now });
    if (Object.values(attempts.restore().attempts).some((attempt) => !attempt.result)) return false;
    const budgets = this.current?.runId === run.runId ? this.current.budgets : this.budgetRuntimeFor(run.runId);
    if (budgets.restore().activeBatches.length) return false;
    const changes = this.current?.runId === run.runId ? this.current.changes : this.changeAccountingFor(run.runId);
    const changeState = changes.restore();
    const completedMutations = new Set(changeState.mutations.map((mutation) => mutation.attemptId));
    if (Object.values(changeState.intents).some((intent) => !changeState.notApplied[intent.attemptId] && !completedMutations.has(intent.attemptId))
      || Object.values(changeState.commandAttempts).some((attempt) => attempt.status === "pending")) return false;
    const artifactOperations = new ArtifactOperationRuntime({
      projectRoot: this.options.projectRoot, projectId: this.options.projectId, sessionId: this.options.sessionId, runId: run.runId,
    }).restore();
    if (Object.values(artifactOperations.operations).some((operation) => !operation.result)) return false;
    if (this.current?.runId === run.runId && this.current.recoveryIssues.length) return false;
    const delegation = this.current?.runId === run.runId
      ? this.current.runtime.restore()
      : replayWorkflowJournal(
        readWorkflowJournal(this.options.projectRoot, this.options.sessionId),
        createDelegationState(this.options.sessionId, run.runId, this.options.snapshot),
        reduceDelegationState,
      ).state;
    return !Object.values(delegation.tasks).some((task) => task.queueState === "queued" || task.queueState === "active"
      || (task.queueState === "suspended" && (task.suspendedOn ?? []).some((taskId) => {
        const dependency = delegation.tasks[taskId];
        return dependency?.result !== undefined && dependency.resultAcceptedSequence === undefined;
      })));
  }

  private curatorNode(jobId: string, nodeId: string): Readonly<{ agentId: string; modelId: string; thinking: string; transcriptPath: string }> {
    const team = this.options.snapshot.payload.workflow.team as { nodes?: readonly unknown[] };
    const node = Array.isArray(team.nodes) ? team.nodes.find((entry) => record(entry) && entry.id === nodeId) as Record<string, unknown> | undefined : undefined;
    const authority = this.options.snapshot.payload.authority.nodes.find((entry) => entry.nodeId === nodeId);
    if (!node || typeof node.agentId !== "string" || !authority || authority.model === undefined || authority.thinking === undefined) throw new Error("Dedicated curator model node is absent from immutable snapshot authority");
    return Object.freeze({ agentId: node.agentId, modelId: String(authority.model), thinking: String(authority.thinking), transcriptPath: join(this.options.projectRoot, ".pi", "hive", "sessions", this.options.sessionId, "knowledge-curator", `${jobId}.jsonl`) });
  }

  private async settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise.then(() => true, () => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private curatorDisposal(jobId: string): Promise<void> {
    const handle = this.curatorHandles.get(jobId);
    if (!handle) return Promise.resolve();
    let disposal = this.curatorDisposals.get(jobId);
    if (!disposal) {
      disposal = (async () => {
        const abort = Promise.resolve().then(() => handle.abort?.());
        void abort.catch(() => undefined);
        await this.settleWithin(abort, 500);
        try { await Promise.resolve(handle.dispose()); }
        catch {
          // A rejected disposal is not proof that the provider died. Preserve a
          // permanently unsettled quarantine; only verified owner-death takeover
          // may release this durable job in another process.
          await new Promise<void>(() => undefined);
        }
        if (this.curatorHandles.get(jobId) === handle) this.curatorHandles.delete(jobId);
        this.curatorDisposals.delete(jobId);
      })();
      this.curatorDisposals.set(jobId, disposal);
      void disposal.catch(() => undefined);
    }
    return disposal;
  }

  private async disposeCuratorHandle(jobId: string): Promise<void> {
    // Lifecycle callers remain bounded, but the processor awaits the underlying
    // disposal separately so durable ownership cannot settle ahead of real death.
    await this.settleWithin(this.curatorDisposal(jobId), 1_500);
  }

  private async runCuratorModel(request: KnowledgeCuratorModelRequest): Promise<KnowledgeCuratorModelResult> {
    if (request.signal.aborted) throw request.signal.reason;
    if (request.maxInputTokens !== CURATOR_EXECUTION_POLICY.maxInputTokens || request.maxOutputTokens !== CURATOR_EXECUTION_POLICY.maxOutputTokens
      || !Number.isSafeInteger(request.maxInputTokens) || !Number.isSafeInteger(request.maxOutputTokens) || request.maxInputTokens < 1 || request.maxOutputTokens < 1) {
      throw new Error("Curator provider token caps differ from the conservative execution policy");
    }
    // One UTF-8 byte per token is a deliberately conservative pre-dispatch
    // upper bound; provider tokenization/generation remains mechanically capped.
    if (Buffer.byteLength(request.prompt, "utf8") > request.maxInputTokens) throw new Error("Curator input cannot conservatively fit the provider token cap");
    const providerTokenLimits = Object.freeze({ maxInputTokens: request.maxInputTokens, maxOutputTokens: request.maxOutputTokens });
    const durableJob = restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId)).jobs[request.jobId];
    if (!durableJob) throw new Error("Durable curator job is missing");
    const selected = this.curatorNode(request.jobId, durableJob.model.nodeId);
    const frozenModel = this.options.snapshot.payload.models.find((entry) => entry.nodeId === durableJob.model.nodeId);
    if (selected.modelId !== request.modelId || selected.thinking !== request.thinking || !frozenModel
      || frozenModel.modelId !== selected.modelId || frozenModel.thinking !== selected.thinking || !curatorFitsSnapshotModelContext(frozenModel)) throw new Error("Curator model request or fixed input/output plus static context differs from the immutable snapshot selection");
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    let handle: WorkerSessionHandle | undefined;
    const onAbort = (): void => { void Promise.resolve(handle?.abort?.()).catch(() => undefined); rejectAbort(request.signal.reason); };
    request.signal.addEventListener("abort", onAbort, { once: true });
    const handlePromise = Promise.resolve(this.options.workerFactory({
      sessionId: this.options.sessionId, runId: `knowledge-${request.jobId}`, nodeId: durableJob.model.nodeId,
      agentId: selected.agentId, modelId: selected.modelId, thinking: selected.thinking, transcriptPath: selected.transcriptPath, tools: Object.freeze([]),
      providerTokenLimits,
    }));
    try {
      handle = await Promise.race([handlePromise, aborted]);
      if (this.curatorHandles.has(request.jobId)) {
        await Promise.resolve(handle.dispose());
        handle = undefined;
        throw new Error("Curator model handle is already active for this durable job");
      }
      this.curatorHandles.set(request.jobId, handle);
      if (handle.enforcedTokenLimits?.maxInputTokens !== providerTokenLimits.maxInputTokens
        || handle.enforcedTokenLimits.maxOutputTokens !== providerTokenLimits.maxOutputTokens) {
        throw new Error("Curator provider does not confirm exact input/output token cap enforcement");
      }
      const provider = Promise.resolve(handle.prompt(request.prompt, request.signal, undefined, { providerTokenLimits }));
      void provider.catch(() => undefined);
      const response = await Promise.race([provider, aborted]);
      const usage = responseUsage(response, request.prompt);
      return Object.freeze({
        output: responseOutput(response),
        usage: Object.freeze(usage.costMicroUsd === undefined
          ? { ...usage, precision: "estimated" as const, costMicroUsd: CURATOR_EXECUTION_POLICY.reservedCostMicroUsdPerCall }
          : { ...usage, costMicroUsd: usage.costMicroUsd }),
      });
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      if (handle) {
        await this.curatorDisposal(request.jobId);
      } else if (request.signal.aborted) {
        // An abort can win before factory construction. That construction may
        // still create an effectful provider, so keep the processor active and
        // durably owned until the late handle is obtained and truly disposed.
        const lateHandle = await handlePromise.catch(() => undefined);
        if (lateHandle) {
          const existing = this.curatorHandles.get(request.jobId);
          if (existing && existing !== lateHandle) await Promise.resolve(lateHandle.dispose());
          else {
            if (!existing) this.curatorHandles.set(request.jobId, lateHandle);
            await this.curatorDisposal(request.jobId);
          }
        }
      }
    }
  }

  private wakeKnowledgeQueue(): void {
    if (!this.shuttingDown) void this.knowledgeQueue.wake().catch(() => undefined);
  }

  private executeKnowledgeReconciliation(): Promise<void> {
    if (this.knowledgeReconciliation) return this.knowledgeReconciliation;
    const work = (async () => {
      await this.reconcileTerminalEnrichment();
      this.wakeKnowledgeQueue();
    })();
    this.knowledgeReconciliation = work;
    void work.then(() => { this.knowledgeRetryAttempt = 0; }, () => {
      if (this.shuttingDown || this.knowledgeRetryTimer) return;
      const delay = Math.min(30_000, 250 * (2 ** Math.min(this.knowledgeRetryAttempt++, 7)));
      this.knowledgeRetryTimer = setTimeout(() => {
        this.knowledgeRetryTimer = undefined;
        this.scheduleKnowledgeReconciliation();
      }, delay);
      this.knowledgeRetryTimer.unref?.();
    }).finally(() => {
      if (this.knowledgeReconciliation === work) this.knowledgeReconciliation = undefined;
    }).catch(() => undefined);
    return work;
  }

  private scheduleKnowledgeReconciliation(_terminal?: import("./events").WorkflowEventEnvelope, _preserveCancelled = false): void {
    if (this.shuttingDown || this.knowledgeReconcileImmediate !== undefined) return;
    this.knowledgeReconcileImmediate = setTimeout(() => {
      this.knowledgeReconcileImmediate = undefined;
      const active = this.knowledgeReconciliation;
      if (active) void active.finally(() => this.scheduleKnowledgeReconciliation()).catch(() => undefined);
      else void this.executeKnowledgeReconciliation().catch(() => undefined);
    });
  }

  private async reconcileTerminalEnrichment(terminal?: import("./events").WorkflowEventEnvelope, preserveCancelled = false): Promise<void> {
    await Promise.resolve();
    const events = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
    const terminals = terminal ? [terminal] : events.filter((event) => event.type === "terminal.recorded");
    let state = restoreKnowledgeEnrichmentState(events);
    for (const event of terminals) {
      if (!event.runId || state.terminalEnqueueCompleted[event.eventHash]) continue;
      const preserveThisCancellation = terminal?.eventHash === event.eventHash && preserveCancelled;
      new KnowledgeEnrichmentService({
        projectRoot: this.options.projectRoot, projectId: this.options.projectId, sessionId: this.options.sessionId,
        runId: event.runId, snapshot: this.options.snapshot, now: this.options.now,
      }).enqueueTerminal(event, { preserveCancelled: preserveThisCancellation });
      state = restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId));
    }
  }

  async runKnowledgeEnrichment(): Promise<void> {
    if (this.knowledgeReconcileImmediate !== undefined) {
      clearTimeout(this.knowledgeReconcileImmediate);
      this.knowledgeReconcileImmediate = undefined;
    }
    await this.executeKnowledgeReconciliation();
    if (this.shuttingDown) return;
    await this.reconcileTerminalEnrichment();
    if (!this.shuttingDown) await this.knowledgeQueue.wake();
  }

  knowledgeProposals(): KnowledgeProposalService { return this.knowledgeProposalsRuntime; }

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

  private artifactProtectedWorkspaceRoots() {
    if (!this.selectedArtifact) return Object.freeze([]);
    const configured = this.artifactSelection();
    return this.selectedArtifact.adapter.protectedWorkspaceRoots?.({
      projectRoot: this.options.projectRoot,
      profile: this.selectedArtifact.profile,
      options: configured.options,
    }) ?? Object.freeze([]);
  }

  private changeAccountingFor(runId: string): ChangeAccountingRuntime {
    const configured = this.options.changeAccounting;
    return new ChangeAccountingRuntime({
      projectRoot: this.options.projectRoot, projectId: this.options.projectId, sessionId: this.options.sessionId, runId,
      now: this.options.now, ...configured,
      protectedRoots: Object.freeze([...(configured?.protectedRoots ?? []), ...this.artifactProtectedWorkspaceRoots(), ...knowledgeProtectedPathRoots(this.options.snapshot)]),
    });
  }

  private knowledgeService(runId: string): KnowledgeService {
    if (this.current?.runId === runId) return this.current.knowledge;
    return new KnowledgeService({ projectRoot: this.options.projectRoot, projectId: this.options.projectId, sessionId: this.options.sessionId, runId, snapshot: this.options.snapshot, now: this.options.now });
  }

  private rootPromptAssembly(runId?: string, acceptedAnswers: readonly AcceptedQuestionForRoot[] = []): WorkflowPromptAssembly {
    const run = this.lifecycle.restore().latestRun;
    if (!run || (runId !== undefined && run.runId !== runId)) throw new Error("Root prompt requires the current workflow run");
    const handoff = run.handoffPacketHash ? handoffForRun(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), run.runId) : undefined;
    if (run.handoffPacketHash && handoff?.packetHash !== run.handoffPacketHash) throw new Error("Consumed handoff packet is missing or does not match the run marker");
    const answerPromptInputs = acceptedAnswers.flatMap((accepted) => losslessDynamicPromptInputs({
      provenance: `human-answer:${accepted.questionId}:${accepted.answer.channel}:${accepted.answer.identity}`,
      content: { questionId: accepted.questionId, definition: accepted.definition, answer: accepted.answer },
      ref: accepted.transcriptRef,
    }));
    const assembly = assembleRootWorkflowPrompt({
      snapshot: this.options.snapshot,
      nodeId: rootNodeId(this.options.snapshot),
      sessionId: this.options.sessionId,
      runId: run.runId,
      ...(handoff ? { handoff: handoffPromptInput(handoff) } : {}),
      knowledgeIndex: this.knowledgeService(run.runId).promptSummaries(rootNodeId(this.options.snapshot)),
      runInputs: [
        ...run.inputs.map((entry) => ({
          source: "user" as const,
          provenance: `run-input:${entry.sequence}:${entry.source}`,
          content: entry.text,
          ref: `run:${run.runId}/input:${entry.sequence}`,
        })),
        ...answerPromptInputs,
      ],
    });
    assertLosslessDynamicPromptInputs(assembly, answerPromptInputs);
    return assembly;
  }

  private rootAnswerPromptPage(runId: string, prepared: readonly RootQuestionAnswerDelivery[]): Readonly<{
    deliveries: readonly RootQuestionAnswerDelivery[];
    promptContext: WorkflowPromptAssembly;
  }> {
    const selected: RootQuestionAnswerDelivery[] = [];
    let promptContext = this.rootPromptAssembly(runId);
    for (const delivery of prepared) {
      try {
        const candidate = [...selected, delivery];
        promptContext = this.rootPromptAssembly(runId, candidate.flatMap((entry) => entry.answers));
        selected.push(delivery);
      } catch (error) {
        if (!selected.length || !String(error instanceof Error ? error.message : error).includes("Authority-relevant prompt data was omitted or truncated")) throw error;
        break;
      }
    }
    return Object.freeze({ deliveries: Object.freeze(selected), promptContext });
  }

  private rootCompactionBoundary(runId?: string): Readonly<{ preservation: string; validate(value: string): void }> {
    const prompt = this.rootPromptAssembly(runId);
    return Object.freeze({
      preservation: buildCompactionPreservationBlock(prompt),
      validate: (value: string) => assertCompactionPreservation(value, prompt),
    });
  }

  private modelInputText(input: unknown): string {
    try { return JSON.stringify(input) ?? String(input); } catch { return String(input); }
  }

  private blockRunForBudget(resources: RunResources, nodeId: string, reason: string): void {
    const bounded = `budget_exhausted: ${reason}`.slice(0, 2_048);
    resources.scheduler.closeAdmission(bounded);
    // Descendants remain journal-live until terminal preparation freezes and
    // closes the exact pending question set. Cancelling them here can make the
    // question terminal guard reject before budget failure is prepared.
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
    const finishUserWork = await this.beginUserWork();
    try {
      resources.assertAdmission();
      const rootPrompt = nodeId === rootNodeId(this.options.snapshot) ? request.promptInvocation?.promptContext ?? this.rootPromptAssembly() : undefined;
      const rootBoundary = rootPrompt ? Object.freeze({
        preservation: buildCompactionPreservationBlock(rootPrompt),
        validate: (value: string) => assertCompactionPreservation(value, rootPrompt),
      }) : undefined;
      if (rootBoundary) request.installCompactionBoundary?.(rootBoundary);
      const attemptInput = request.consumerReceipt ? {
        requestInput: request.input,
        consumerReceipt: { deliveryIds: [...request.consumerReceipt.deliveryIds], promptHash: request.consumerReceipt.promptHash, transcriptRef: request.consumerReceipt.transcriptRef },
      } : request.input;
      const recoveredBinding = request.recoveryAttemptId
        ? resources.attempts.restore().attempts[request.recoveryAttemptId]?.consumerReceipt
        : undefined;
      const value = await executeWithConservativeRetry(resources.attempts, {
        correlationId: request.correlationId, nodeId, operation: request.operation, input: attemptInput,
        replayInput: request.replayInput ?? request.input,
        ...(request.recoveryAttemptId ? { recoveryAttemptId: request.recoveryAttemptId, ...(recoveredBinding ? { recoveryConsumerReceipt: recoveredBinding } : {}) } : {}),
        descriptor: attemptDescriptorForModel(),
        ...(request.consumerReceipt ? {
          consumerReceipt: { deliveryIds: [...request.consumerReceipt.deliveryIds], promptHash: request.consumerReceipt.promptHash, transcriptRef: request.consumerReceipt.transcriptRef },
          consumerReceiptAfterDispatch: () => ({
            deliveryIds: [...new Set(request.consumerReceipt!.resolveDeliveryIds?.() ?? request.consumerReceipt!.deliveryIds)],
            promptHash: request.consumerReceipt!.promptHash,
            transcriptRef: request.consumerReceipt!.transcriptRef,
          }),
          onConsumerCompleted: (attemptId: string, binding: AttemptConsumerReceiptBinding) => request.consumerReceipt!.record(attemptId, binding),
        } : {}),
        dispatch: async ({ attemptId, ordinal }) => {
          resources.assertAdmission();
          const admitted = resources.budgets.startModelAttempt(nodeId, `${request.correlationId}-provider-${ordinal}`, { finalization: request.finalization });
          if (!admitted.ok) this.throwBudgetAdmission(resources, nodeId, admitted);
          const activityId = `${attemptId}-active`;
          const active = resources.budgets.beginActive(nodeId, activityId);
          if (!active.ok) this.throwBudgetAdmission(resources, nodeId, active);
          let response: string | WorkerPromptResponse;
          try {
            response = await request.dispatch(request.promptInvocation ?? Object.freeze({ promptContext: rootPrompt! }));
            if (rootBoundary && record(response) && response.compactionSummary !== undefined) {
              if (typeof response.compactionSummary !== "string") throw Object.assign(new Error("Root compaction summary is invalid"), { assistantOutputObserved: true, effectNotApplied: true });
              rootBoundary.validate(response.compactionSummary);
            }
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
    } finally {
      finishUserWork();
      if (this.knowledgeIdle()) this.scheduleKnowledgeReconciliation();
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
    allowWaitingForHuman = false,
  ): Promise<T> {
    const assertDispatchAdmission = (): void => {
      if (!allowWaitingForHuman) return resources.assertAdmission();
      resources.assertWaitingForHumanAdmission();
    };
    const finishUserWork = await this.beginUserWork();
    try {
      assertDispatchAdmission();
      const descriptor = this.toolDescriptor(request.toolName, request.commandMetadata);
      const tool = classifyTrustedTool(request.toolName)!;
      const authority = this.options.snapshot.payload.authority.nodes.find((entry) => entry.nodeId === nodeId);
      if (request.policyOutcome === "allowed" && (!authority || !Array.isArray(authority.tools) || !authority.tools.includes(request.toolName))) throw new Error(`Tool ${request.toolName} is not enabled for node ${nodeId}`);
      const value = await executeWithConservativeRetry(resources.attempts, {
        correlationId: request.correlationId, nodeId, operation: request.operation, input: request.input, descriptor,
        dispatch: async ({ attemptId, ordinal }) => {
          assertDispatchAdmission();
          const admitted = resources.budgets.recordToolAttempt(nodeId, `${request.correlationId}-tool-${ordinal}`, {
            toolName: request.toolName, policyOutcome: request.policyOutcome, finalization: request.finalization,
          });
          if (!admitted.ok) this.throwBudgetAdmission(resources, nodeId, admitted);
          if (request.policyOutcome === "denied") {
            throw Object.assign(new Error(request.denialReason?.slice(0, 2_048) || `Policy denied ${request.toolName}`), { policyDenied: true, effectNotApplied: true });
          }
          const activityId = `${attemptId}-active`;
          const ownsActivity = !allowWaitingForHuman && !resources.budgets.restore().activeBatches.some((activity) => activity.nodeId === nodeId);
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
            // A durable human-wait transition pauses and closes active clocks
            // before this dispatch unwinds. Do not publish a stale second stop.
            if (ownsActivity && resources.budgets.restore().activeBatches.some((activity) => activity.activityId === activityId)) resources.budgets.endActive(activityId);
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
    } finally {
      finishUserWork();
      if (this.knowledgeIdle()) this.scheduleKnowledgeReconciliation();
    }
  }

  private questionRuntimeFor(runId: string): QuestionService {
    if (this.current?.runId === runId) return this.current.questions;
    return new QuestionService({
      projectRoot: this.options.projectRoot, projectId: this.options.projectId, sessionId: this.options.sessionId, runId,
      snapshot: this.options.snapshot, now: this.options.now,
      authenticateControl: this.options.questionControl?.authenticateControl ?? (() => undefined),
      journalFault: this.options.questionControl?.journalFault,
    });
  }

  private reconcileKnowledgeProposalAttempts(attempts: AttemptRuntime): readonly string[] {
    const issues: string[] = [];
    const events = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
    let state: ReturnType<typeof restoreKnowledgeEnrichmentState>;
    try { state = restoreKnowledgeEnrichmentState(events); }
    catch (error) { return Object.freeze([`knowledge proposal reconciliation failed closed: ${String(error instanceof Error ? error.message : error)}`]); }
    const attemptState = attempts.restore();
    for (const attempt of Object.values(attemptState.attempts)) {
      if (attempt.result || attempt.operation !== "workflow.tool.knowledge_propose") continue;
      const publication = events.find((event) => event.type === "knowledge.transition" && event.runId === attemptState.runId
        && event.attemptId === attempt.attemptId && record(event.payload) && event.payload.operation === "candidate-recorded");
      const candidate = publication && record(publication.payload) ? state.candidates[String((publication.payload.candidate as { candidateId?: unknown } | undefined)?.candidateId ?? "")] : undefined;
      if (!candidate) continue;
      if (candidate.runId !== attemptState.runId || candidate.nodeId !== attempt.nodeId || publication?.correlationId !== attempt.attemptId || candidate.requestHash !== attempt.inputHash) {
        issues.push(`knowledge proposal attempt ${attempt.attemptId} publication does not match its exact input/node identity`);
        continue;
      }
      try { attempts.reconcile(attempt.attemptId, "applied", { ok: true, value: candidate as unknown as JsonValue }); }
      catch (error) { issues.push(`knowledge proposal attempt ${attempt.attemptId} reconciliation failed: ${String(error instanceof Error ? error.message : error)}`); }
    }
    return Object.freeze(issues);
  }

  private createResources(runId: string): RunResources {
    const budgets = this.budgetRuntimeFor(runId);
    const changes = this.changeAccountingFor(runId);
    const attempts = new AttemptRuntime({ projectRoot: this.options.projectRoot, projectId: this.options.projectId, sessionId: this.options.sessionId, runId, now: this.options.now });
    const recoveryIssues: string[] = [];
    if (budgets.restore().activeBatches.length) {
      const boundary = this.options.recoveredOwnerHeartbeatAt === undefined ? Number.NaN : Date.parse(this.options.recoveredOwnerHeartbeatAt);
      if (!Number.isFinite(boundary)) recoveryIssues.push("abandoned active budget clock has no verified previous-owner heartbeat boundary");
      else {
        budgets.reconcileAbandonedActiveTime(boundary, "reconciled at verified previous-owner heartbeat");
        budgets.resumeActive();
      }
    }
    const recoveryRun = this.lifecycle.restore().latestRun;
    if (recoveryRun?.runId === runId && recoveryRun.artifactWorkspace?.workspace.kind === "physical") {
      recoveryIssues.push(...this.reconcileArtifactWorkspaceBindAttempts(attempts));
      recoveryIssues.push(...this.reconcileCheckpointRequestAttempts(attempts));
    }
    if (recoveryRun?.runId === runId && recoveryRun.artifactWorkspace?.workspace.kind === "physical" && this.selectedArtifact?.adapter) {
      try {
        const authority = this.workspaceAuthority(recoveryRun.artifactWorkspace, runId)!;
        if (this.unresolvedArtifactOperationIds(recoveryRun.artifactWorkspace, runId).length) {
          if (!heartbeatCurrentRuntimeOwnership(this.options.projectRoot, this.options.sessionId, this.options.runtimeOwnerNonce)) {
            throw new Error("current runtime ownership is required before artifact operation recovery");
          }
          const acquired = authority.lease.acquire();
          if (!acquired.ok) throw new Error(`artifact writer lease conflict during recovery: ${acquired.reason}`);
          const report = this.recoverArtifactOperations(recoveryRun.artifactWorkspace, runId);
          if (report.unknown.length) recoveryIssues.push(`artifact operations paused unknown_side_effect: ${report.diagnostics.join("; ")}`);
        }
        recoveryIssues.push(...this.reconcileArtifactAttemptResults(attempts, authority));
      } catch (error) {
        recoveryIssues.push(`artifact operation restart recovery failed closed: ${String(error instanceof Error ? error.message : error)}`);
      }
    }
    recoveryIssues.push(...this.reconcileKnowledgeProposalAttempts(attempts));
    for (const attempt of Object.values(attempts.restore().attempts)) {
      if (!attempt.result && attempt.recovery === "reconcile-required" && attempt.status === "pending") {
        attempts.markUnknown(attempt.attemptId, "interrupted non-idempotent dispatch requires trusted reconciliation before admission");
      }
    }
    const questions = this.questionRuntimeFor(runId);
    const knowledge = this.knowledgeService(runId);
    const enrichment = new KnowledgeEnrichmentService({
      projectRoot: this.options.projectRoot, projectId: this.options.projectId, sessionId: this.options.sessionId,
      runId, snapshot: this.options.snapshot, now: this.options.now,
    });
    const runtime = new DelegationRuntime({
      projectRoot: this.options.projectRoot,
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      runId,
      snapshot: this.options.snapshot,
      createTaskId: this.options.createTaskId,
      now: this.options.now,
      referenceAuthorizer: createKnowledgeReferenceAuthorizer(this.options.snapshot, knowledge, this.options.referenceAuthorizer),
      acceptanceAuthority: { admit: (events, parentNodeId) => budgets.admitDelegationAgainst(events, parentNodeId) },
      startAuthority: { admit: (events) => {
        const locked = replayWorkflowJournal(events, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
        if (!locked || locked.runId !== runId || locked.status !== "running" || locked.cancellationRequested || locked.pendingTerminal
          || locked.waitCauses?.includes("approval")) return Object.freeze({ ok: false as const, reason: "Task start admission lost to run lifecycle, cancellation, finalization, or approval state" });
        return Object.freeze({ ok: true as const });
      } },
      terminalAuthority: { assertTaskMayTerminal: (events, taskId, status) => questions.assertTaskMayTerminal(events, taskId, status) },
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
      assertWaitingForHumanAdmission: () => {
        const run = this.lifecycle.restore().latestRun;
        const delegation = resources.runtime.restore();
        if (!run || run.runId !== runId || run.status !== "waiting_for_human" || run.cancellationRequested || run.pendingTerminal || !delegation.admissionOpen) {
          throw new Error("Human-wait artifact control requires the current waiting recovered workflow run");
        }
        this.assertRecoveredForAdmission(resources);
      },
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
      toolPolicyForNode: (nodeId) => this.toolPolicyForNode(nodeId),
      dispatchModel: ({ task, text, invoke, questionDeliveryIds, resolveQuestionDeliveryIds, promptHash, transcriptRef, onConsumerSuccess, questionContinuationReady }) => this.dispatchModel(dispatchResources, task.targetNodeId, {
        correlationId: `worker-model-${task.taskId}-${promptHash.slice(0, 24)}-turn-${task.questionContinuationTurn ?? 0}`,
        operation: "worker.provider.prompt", input: { taskId: task.taskId, promptHash, questionContinuationTurn: task.questionContinuationTurn ?? 0 }, replayInput: { taskId: task.taskId },
        ...(questions.containingAttemptForTaskContinuation(task.taskId, task.resumedByQuestionSequence) ? { recoveryAttemptId: questions.containingAttemptForTaskContinuation(task.taskId, task.resumedByQuestionSequence) } : {}),
        dispatch: async () => {
          try { return await invoke(); }
          catch (error) {
            if (questionContinuationReady() && error && typeof error === "object") Object.assign(error, { effectNotApplied: true });
            throw error;
          }
        },
        consumerReceipt: { deliveryIds: questionDeliveryIds, promptHash, transcriptRef, resolveDeliveryIds: resolveQuestionDeliveryIds, record: onConsumerSuccess },
      }, text),
      dispatchTool: (task, input) => this.dispatchTool(dispatchResources, task.targetNodeId, input),
      questions,
      knowledgeIndex: (nodeId) => knowledge.promptSummaries(nodeId),
    });
    workers.rebuildBoundaries(Object.values(runtime.restore().tasks));
    const scheduler = new DurableDelegationScheduler({
      runtime,
      maxParallel: Math.min(this.options.maxParallel, budgets.restore().limits.run.maxParallel),
      createAttemptId: this.options.createAttemptId,
      verifiedTakeover: this.options.verifiedTakeover,
      onRecoveryReconciled: () => {
        // Receipt-to-acceptance publication is retryable control settlement.
        // It runs before task.started, so a fault cannot become a worker result
        // or consume the durable same-attempt resume marker.
        questions.reconcileAnswerDeliveryReceipts();
        this.reconcileDurableNestedDeliveries(runtime);
      },
      canLaunch: () => {
        const currentRun = this.lifecycle.restore().latestRun;
        return currentRun?.runId === runId && currentRun.status === "running" && !(currentRun.waitCauses?.includes("approval") ?? false) && !currentRun.cancellationRequested && !currentRun.pendingTerminal;
      },
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
    const resources: RunResources = { runId, runtime, budgets, attempts, changes, knowledge, enrichment, recoveryIssues: Object.freeze(recoveryIssues), dispatchRuntime: dispatchResources, scheduler, workers, questions };
    const run = this.lifecycle.restore().latestRun;
    if (run?.runId === runId && run.pendingTerminal) this.failClosedForTerminal(resources);
    else this.reconcileDurableNestedDeliveries(runtime);
    return resources;
  }

  private failClosedForTerminal(resources: RunResources): void {
    const run = this.lifecycle.restore().latestRun;
    if (run?.runId === resources.runId && run.pendingTerminal) {
      resources.questions.closePending({
        reason: `run ${run.pendingTerminal.status}`,
        operationId: run.pendingTerminal.operationId,
        expectedQuestionIds: run.pendingTerminal.closedQuestionIds,
      });
    }
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
    const undelivered = tasks.filter((task) => task.result && task.resultAcceptedSequence === undefined);
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
    const isRootContext = context.nodeId === rootNodeId(this.options.snapshot);
    const assertRootQuestionAdmission = (): void => {
      if (!isRootContext) return;
      const pending = Object.values(resources.questions.restore().questions)
        .filter((question) => question.nodeId === context.nodeId && question.taskId === undefined && question.state === "pending");
      if (pending.length) throw new Error(`Root dispatch is blocked by ${pending.length} pending durable human question(s)`);
    };
    const assertQuestionBatchAdmission = (toolCallId: string, batchCallIds: readonly string[]): void => {
      if (!batchCallIds.includes(toolCallId) || new Set(batchCallIds).size !== batchCallIds.length) throw new Error("Human question call is not bound to its exact trusted assistant batch");
      const prior = Object.values(resources.questions.restore().questions).some((question) => question.nodeId === context.nodeId
        && question.taskId === context.taskId && question.taskAttemptId === context.attemptId
        && question.provenance.toolCallId !== toolCallId && batchCallIds.includes(question.provenance.toolCallId));
      if (!prior) {
        assertAdmission();
        assertRootQuestionAdmission();
        return;
      }
      const run = this.lifecycle.restore().latestRun;
      const delegation = resources.runtime.restore();
      if (!run || run.runId !== resources.runId || run.status !== "running" || run.cancellationRequested || run.pendingTerminal
        || this.current?.runId !== resources.runId || !delegation.admissionOpen || delegation.schedulerStatus !== "running") {
        throw new Error("Same-batch human question admission requires the current running workflow attempt");
      }
      if (!isRootContext) resources.runtime.assertQuestionBatchExecutionContext(context);
      this.assertRecoveredForAdmission(resources);
    };
    const dispatch: TrustedWorkflowDispatch = Object.freeze({
      schemaVersion: 1 as const,
      model: async (input: RootModelDispatchRequest) => {
        assertAdmission();
        assertRootQuestionAdmission();
        if (isRootContext) resources.questions.reconcileAnswerDeliveryReceipts();
        const preparedRootQuestionDeliveries = isRootContext ? resources.questions.prepareRootAnswerDeliveries(context.nodeId) : [];
        const rootAnswerPage = isRootContext ? this.rootAnswerPromptPage(resources.runId, preparedRootQuestionDeliveries) : undefined;
        const rootQuestionDeliveries = rootAnswerPage?.deliveries ?? [];
        const rootQuestionDelivery = rootQuestionDeliveries.length === 1 ? rootQuestionDeliveries[0] : undefined;
        const promptContext = rootAnswerPage?.promptContext;
        const promptHash = promptContext ? createHash("sha256").update(promptContext.text).digest("hex") : undefined;
        const transcriptRef = isRootContext ? `run:${resources.runId}/node:${context.nodeId}/transcript` : undefined;
        const { recoveryAttemptId: _untrustedRecoveryAttempt, replayInput: _untrustedReplayInput, ...publicInput } = input;
        const recoveredRootAttempt = isRootContext && transcriptRef
          ? Object.values(resources.attempts.restore().attempts).find((attempt) => attempt.correlationId === input.correlationId && attempt.nodeId === context.nodeId
            && attempt.operation === input.operation && attempt.status === "completed" && attempt.result?.ok && attempt.consumerReceipt?.transcriptRef === transcriptRef)
          : undefined;
        const value = await this.dispatchModel(resources.dispatchRuntime, context.nodeId, {
          ...publicInput,
          replayInput: input.input,
          ...(recoveredRootAttempt ? { recoveryAttemptId: recoveredRootAttempt.attemptId } : {}),
          ...(promptContext ? { promptInvocation: Object.freeze({ promptContext, ...(rootQuestionDelivery ? { rootQuestionDelivery } : {}), ...(rootQuestionDeliveries.length ? { rootQuestionDeliveries } : {}) }) } : {}),
          ...(promptHash && transcriptRef ? { consumerReceipt: {
            deliveryIds: rootQuestionDeliveries.map((delivery) => delivery.deliveryId), promptHash, transcriptRef,
            resolveDeliveryIds: () => {
              const deliveries = resources.questions.preparedRootAnswerDeliveries(context.nodeId);
              return [...new Set(deliveries.filter((delivery) => rootQuestionDeliveries.some((candidate) => candidate.deliveryId === delivery.deliveryId)
                || resources.questions.rootAnswerDeliveryReturnedByTool(delivery)).map((delivery) => delivery.deliveryId))];
            },
            record: (attemptId: string, binding: AttemptConsumerReceiptBinding) => {
              if (binding.transcriptRef !== transcriptRef) throw new Error("Root consumer settlement transcript does not match the root transcript");
              const boundDeliveryIds = new Set(binding.deliveryIds);
              for (const delivery of resources.questions.preparedRootAnswerDeliveries(context.nodeId)) {
                if (boundDeliveryIds.has(delivery.deliveryId)) {
                  resources.questions.recordRootAnswerDeliveryReceipt(delivery, { promptHash: binding.promptHash, attemptId, transcriptRef: binding.transcriptRef });
                }
              }
            },
          } } : {}),
        });
        if (isRootContext) {
          resources.questions.reconcileAnswerDeliveryReceipts();
          this.reconcileQuestionWait(resources);
        }
        return value;
      },
      tool: <T>(input: WorkerTrustedToolDispatchRequest<T>) => {
        const actionInput = record(input.input) ? input.input : undefined;
        const humanWaitArtifactControl = isRootContext && this.lifecycle.restore().latestRun?.status === "waiting_for_human"
          && (input.toolName === "artifact_status" || (input.toolName === "artifact_action" && actionInput?.actionId === CHECKPOINT_REQUEST_ACTION_ID));
        if (input.toolName === "human_question" && input.questionBatchCallIds && input.questionBatchCurrentCallId) assertQuestionBatchAdmission(input.questionBatchCurrentCallId, input.questionBatchCallIds);
        else if (humanWaitArtifactControl) {
          assertCurrent();
          this.assertRecoveredForAdmission(resources);
        } else {
          assertAdmission();
          assertRootQuestionAdmission();
        }
        return this.dispatchTool(resources.dispatchRuntime, context.nodeId, input, humanWaitArtifactControl);
      },
    });
    const bound: BoundDelegationServices = Object.freeze({
      context,
      dispatch,
      route: (input: RouteDirectMembersInput) => { assertCurrent(); return routeDirectMembers(this.options.snapshot, context.nodeId, input); },
      delegate: (input: AcceptDelegationInput) => {
        assertAdmission();
        try { return resources.runtime.accept(context, input); }
        catch (error) {
          const detail = record(error) ? error : {};
          if (detail.budgetScope === "run" && Array.isArray(detail.budgetExhausted)) {
            const reason = String(error instanceof Error ? error.message : error);
            this.blockRunForBudget(resources, context.nodeId, reason);
            // Delegation admission is synchronous, so finish its fatal run-wide
            // settlement on the owned cleanup lane after this call unwinds.
            this.trackCleanup(Promise.resolve().then(async () => {
              const terminal = await this.lifecycle.failBudgetExhaustion(reason);
              if (!terminal.ok) throw new Error(`Run-wide delegation budget exhaustion failed to settle: ${terminal.issues.join("; ")}`);
            }));
          }
          throw error;
        }
      },
      status: (options: { limit?: number; cursor?: string } = {}) => { assertCurrent(); return resources.runtime.status(context, options); },
      preparedResultDelivery: () => { assertCurrent(); return resources.runtime.preparedResultDelivery(context); },
      prepareResultDelivery: (deliveryId: string, options: { limit?: number } = {}) => { assertCurrent(); return resources.runtime.prepareResultDelivery(context, deliveryId, options); },
      acceptResultDelivery: (deliveryId: string) => { assertCurrent(); resources.runtime.acceptResultDelivery(context, deliveryId); },
      deliverResults: (deliveryId: string, options: { limit?: number } = {}) => { assertCurrent(); return resources.runtime.deliverResultDelivery(context, deliveryId, options); },
      runWithToolRuntime: <T>(callback: () => T): T => {
        assertCurrent();
        const binding = issueWorkflowToolRuntimeBinding({
          snapshot: this.options.snapshot,
          nodeId: context.nodeId,
          dispatch,
          team: bound,
          workflowStatus: (input) => {
            assertCurrent();
            const lifecycle = this.lifecycle.restore();
            const run = lifecycle.latestRun;
            const handoff = run?.handoffPacketHash ? handoffForRun(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), run.runId) : undefined;
            if (run?.handoffPacketHash && handoff?.packetHash !== run.handoffPacketHash) throw new Error("Consumed handoff packet is missing or does not match the run marker");
            return buildWorkflowStatusPage({
              snapshot: this.options.snapshot,
              lifecycle,
              budget: resources.budgets.restore(),
              delegation: resources.runtime.restore(),
              ...(handoff ? { handoff } : {}),
            }, input);
          },
          artifactStatus: this.selectedArtifact?.adapter ? async (input, signal) => {
            assertCurrent();
            const workspace = this.lifecycle.restore().latestRun?.artifactWorkspace;
            if (!workspace) return this.unboundArtifactStatus(input);
            const workspaceAuthority = this.workspaceAuthority(workspace, resources.runId);
            const facade = new ArtifactFacade({ adapter: this.selectedArtifact!.adapter!, profile: this.selectedArtifact!.profile, binding: workspace, mutationQueue: this.artifactMutationQueue(), ...(workspaceAuthority ? { workspaceAuthority } : {}) });
            const caller = this.artifactCallerIssuer!.issue(context.nodeId, workspace);
            const view = await facade.status(caller, input, { ...(signal ? { signal } : {}) });
            return this.artifactStatusWithHarnessActions(context.nodeId, view);
          } : undefined,
          artifactAction: this.selectedArtifact?.adapter ? async (input, attemptId, signal) => {
            assertCurrent();
            const workspace = this.lifecycle.restore().latestRun?.artifactWorkspace;
            if (!workspace) return this.bindArtifactWorkspaceFromTool(context.nodeId, input, attemptId);
            if (input.actionId === ARTIFACT_WORKSPACE_BIND_ACTION_ID) throw Object.assign(new Error("Artifact workspace is already bound; workspace-bind rebinding is denied"), { effectNotApplied: true });
            if (input.actionId === CHECKPOINT_REQUEST_ACTION_ID) return this.requestCheckpointFromTool(context.nodeId, input, attemptId, signal);
            const workspaceAuthority = this.workspaceAuthority(workspace, resources.runId);
            let mutationOrdinal = 0;
            const baseMutationQueue = this.artifactMutationQueue();
            const mutationQueue: ArtifactMutationQueue = async (target, operationId, callback) => {
              const project = resolveCanonicalPath(this.options.projectRoot);
              const relativeTarget = project?.exists ? relative(project.canonicalPath, target).split("\\").join("/") : "";
              if (!relativeTarget || relativeTarget.startsWith("../") || relativeTarget === "..") throw new Error("Artifact mutation accounting target escaped the project");
              const accountingId = `${operationId}:artifact:${++mutationOrdinal}`;
              const recorder = resources.changes.mutationRecorder();
              const intent = recorder.begin(accountingId, relativeTarget);
              try {
                const result = await baseMutationQueue(target, operationId, callback);
                recorder.complete(intent, relativeTarget);
                return result;
              } catch (error) {
                try { recorder.complete(intent, relativeTarget); }
                catch { recorder.notApplied?.(accountingId, relativeTarget, String(error instanceof Error ? error.message : error)); }
                throw error;
              }
            };
            const facade = new ArtifactFacade({ adapter: this.selectedArtifact!.adapter!, profile: this.selectedArtifact!.profile, binding: workspace, mutationQueue, ...(workspaceAuthority ? { workspaceAuthority } : {}) });
            const caller = this.artifactCallerIssuer!.issue(context.nodeId, workspace);
            return facade.action(caller, input, {
              attemptId,
              ...(signal ? { signal } : {}),
              verifyEvidence: (references) => this.verifyArtifactEvidence(resources, references),
            });
          } : undefined,
          knowledgeSearch: (input, attemptId) => {
            assertCurrent();
            return resources.knowledge.search(context.nodeId, input, attemptId);
          },
          knowledgeRead: (input, attemptId) => {
            assertCurrent();
            return resources.knowledge.read(context.nodeId, input, attemptId);
          },
          knowledgePropose: (input, attemptId) => {
            assertCurrent();
            return resources.enrichment.propose(context.nodeId, attemptId, input);
          },
          question: async (input, toolCallId, signal, batchCallIds = [toolCallId]) => {
            assertQuestionBatchAdmission(toolCallId, batchCallIds);
            const request = { nodeId: context.nodeId, ...(context.taskId ? { taskId: context.taskId } : {}), definition: input, provenance: { source: "human_question" as const, toolCallId } };
            const question = this.options.questionControl?.presentLive
              ? await resources.questions.createAndPresent(request, this.options.questionControl.presentLive, signal)
              : resources.questions.create(request);
            return Object.freeze({ questionId: question.questionId, state: question.state, suspendTurn: question.state === "pending", ...(question.answer ? { answer: question.answer } : {}) });
          },
          finish: (input, batch) => this.lifecycle.finish(input, { callerNodeId: context.nodeId, toolBatch: batch }),
        });
        return runWithWorkflowToolRuntime(binding, callback);
      },
    });
    return bound;
  }

  rootServices(): BoundDelegationServices {
    const resources = this.resources();
    // Root admission, like scheduler recovery, retries durable receipt control
    // settlement without turning a transient publication fault into a provider
    // attempt or a permanent recovery diagnosis.
    resources.questions.reconcileAnswerDeliveryReceipts();
    this.reconcileQuestionWait(resources);
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

  private reconcileQuestionWait(resources: RunResources): void {
    const beforeRun = this.lifecycle.restore().latestRun;
    if (!beforeRun || (beforeRun.status !== "running" && beforeRun.status !== "waiting_for_human") || beforeRun.cancellationRequested || beforeRun.pendingTerminal) return;
    const delegation = resources.runtime.restore();
    const questions = Object.values(resources.questions.restore().questions);
    const pendingQuestions = questions.filter((question) => question.state === "pending").length;
    const rootId = rootNodeId(this.options.snapshot);
    const rootQuestionSuspended = questions.some((question) => question.state === "pending" && question.nodeId === rootId && question.taskId === undefined);
    const runnableTasks = Object.values(delegation.tasks).filter((task) => task.queueState === "queued" || (task.queueState === "active" && (task.resumedByQuestionSequence !== undefined || task.resumedByResultSequence !== undefined))).length;
    const derived = deriveQuestionRunStatus({ pendingQuestions, activeExecutions: resources.scheduler.activeCount, runnableTasks, pendingRootInputs: this.lifecycle.pendingInputs().length, rootQuestionSuspended });
    const hasQuestionCause = beforeRun.waitCauses?.includes("question") ?? false;
    if (derived === "waiting_for_human" && !hasQuestionCause) {
      this.lifecycle.transitionToWaitingForHuman("all runnable progress is suspended on durable human questions");
    } else if (derived === "running" && beforeRun.status === "waiting_for_human" && hasQuestionCause) {
      this.lifecycle.transitionFromWaitingForHuman("a durable human answer is ready for owner-controlled resume");
    }
  }

  async runWorkers(): Promise<void> {
    const resources = this.resources();
    this.reconcileQuestionWait(resources);
    if (Object.values(resources.attempts.restore().attempts).some((attempt) => !attempt.result && attempt.recovery === "reconcile-required")) {
      const report = await recoverUnknownSideEffects(resources.attempts, {
        reconcilers: this.options.recoveryReconcilers,
        pauseUnknownSideEffect: async (diagnostics) => { await this.pause(`unknown_side_effect: ${diagnostics.join("; ").slice(0, 2_048)}`); },
      });
      this.reconcileRecoveredCommandAccounting(resources.attempts, resources.changes);
      if (report.paused) throw new Error(`Worker admission paused for unresolved unknown side effects: ${report.diagnostics.join("; ")}`);
    }
    const admissionIssues = this.recoveryAdmissionIssues(resources);
    if (admissionIssues.length) {
      if (this.lifecycle.restore().latestRun?.status === "running") await this.pause(`unknown_side_effect: ${admissionIssues.join("; ").slice(0, 2_048)}`);
      throw new Error(`Worker admission paused for unresolved unknown side effects: ${admissionIssues.join("; ")}`);
    }
    const run = this.lifecycle.restore().latestRun;
    if (!run || run.runId !== resources.runId || run.status !== "running" || run.waitCauses?.includes("approval") || run.cancellationRequested) {
      throw new Error("Workers can run only for the current running workflow run without a pending approval wait");
    }
    resources.budgets.resumeActive();
    await resources.scheduler.runUntilSettled();
    if (!resources.questions.isShutdown()) this.reconcileQuestionWait(resources);
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
    if (this.knowledgeIdle()) this.scheduleKnowledgeReconciliation();
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
    await this.knowledgeQueue.preemptForUserWork();
    const boundary = this.rootCompactionBoundary();
    return this.lifecycle.pause(reason, {
      ...this.options.pauseAuthority,
      captureState: async () => {
        const base = await this.options.pauseAuthority.captureState?.() ?? {};
        const run = this.lifecycle.restore().latestRun;
        const binding = run?.artifactWorkspace;
        const authority = run && binding ? this.workspaceAuthority(binding, run.runId) : undefined;
        let artifactLeaseOwned = false;
        if (authority) { try { authority.lease.assertOwned(); artifactLeaseOwned = true; } catch { /* reader-only run */ } }
        return {
          ...base,
          rootPromptCompactionPreservation: boundary.preservation,
          ...(authority ? { artifactWorkspaceHash: authority.readHashes().workspaceHash, artifactLeaseOwned } : {}),
        } as Readonly<Record<string, JsonValue>>;
      },
      suspendOwnedWork: async () => {
        await this.suspendResources(reason);
        await this.options.pauseAuthority.suspendOwnedWork?.();
      },
      releaseLeases: async () => {
        this.releaseArtifactLease("pause");
        await this.options.pauseAuthority.releaseLeases?.();
      },
    });
  }

  async resume(): Promise<boolean> {
    const paused = this.lifecycle.restore().latestRun;
    const preservation = paused?.pauseState?.rootPromptCompactionPreservation;
    if (!paused || typeof preservation !== "string") throw new Error("Resume rejected: root immutable prompt preservation markers are missing");
    this.rootCompactionBoundary(paused.runId).validate(preservation);
    const physicalBinding = paused.artifactWorkspace?.workspace.kind === "physical" ? paused.artifactWorkspace : undefined;
    const unresolvedArtifactOperations = physicalBinding ? this.unresolvedArtifactOperationIds(physicalBinding, paused.runId) : Object.freeze([]);
    const resumeAuthority: ResumeCoordinator = {
      acquireOwnership: this.options.resumeAuthority.acquireOwnership,
      acquireLeases: async () => {
        const run = this.lifecycle.restore().latestRun;
        if (run?.artifactWorkspace && (run.pauseState?.artifactLeaseOwned === true || unresolvedArtifactOperations.length > 0)) {
          const authority = this.workspaceAuthority(run.artifactWorkspace, run.runId)!;
          const acquired = authority.lease.acquire();
          if (!acquired.ok) throw new Error(`Artifact writer lease conflict on resume: ${acquired.reason}`);
        }
        await this.options.resumeAuthority.acquireLeases();
      },
      revalidateHashes: async (pauseState) => {
        const run = this.lifecycle.restore().latestRun;
        if (run?.artifactWorkspace?.workspace.kind === "physical") {
          const expected = pauseState.artifactWorkspaceHash;
          if (typeof expected !== "string" || this.workspaceAuthority(run.artifactWorkspace, run.runId)!.readHashes().workspaceHash !== expected) return false;
          if (!await this.options.resumeAuthority.revalidateHashes(pauseState)) return false;
          if (unresolvedArtifactOperations.length) {
            const report = this.recoverArtifactOperations(run.artifactWorkspace, run.runId);
            if (report.unknown.length) throw new Error(`Resume remains paused for unknown_side_effect artifact operations: ${report.diagnostics.join("; ")}`);
          }
          return true;
        }
        return this.options.resumeAuthority.revalidateHashes(pauseState);
      },
      rollbackAuthority: async () => {
        this.artifactAuthority?.authority.lease.stopHeartbeat();
        this.artifactAuthority?.authority.lease.release();
        this.artifactAuthority = undefined;
        await this.options.resumeAuthority.rollbackAuthority();
      },
    };
    const resumed = await this.lifecycle.resume(resumeAuthority);
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
    const closeFrozenQuestions = (): void => {
      const frozenRun = this.lifecycle.restore().latestRun;
      if (!frozenRun || frozenRun.runId !== resources.runId || !frozenRun.cancellationRequested || !frozenRun.cancellationReason) {
        throw new Error("Cancellation question closure requires the frozen durable cancellation request");
      }
      const frozenQuestionIds = frozenRun.cancellationQuestionIds ?? [];
      const closureHash = createHash("sha256")
        .update("pi-hive-cancellation-question-closure-v1\0")
        .update(canonicalJson({ projectId: this.options.projectId, sessionId: this.options.sessionId, runId: frozenRun.runId }))
        .digest("hex");
      resources.questions.closePending({
        reason: utf8Prefix(frozenRun.cancellationReason, QUESTION_LIMITS.reasonBytes),
        operationId: `cancel-question-closure-sha256-${closureHash}`,
        expectedQuestionIds: frozenQuestionIds,
      });
    };
    return {
      rejectNewWork: () => { resources.scheduler.closeAdmission(reason); },
      cancelQueuedWork: () => {
        // Explicit run cancellation closes the frozen pending set before task
        // cancellation so ordinary task terminal CAS never strands a question.
        closeFrozenQuestions();
        resources.scheduler.cancelPending(reason);
      },
      abortOwnedWork: async () => {
        resources.scheduler.abortOwnedWork(reason);
        await resources.workers.closeSessions();
      },
      waitForSettlement: async (timeoutMs) => {
        const [schedulerSettled, workersSettled, processTreesSettled] = await Promise.all([
          resources.scheduler.waitForSettlement(timeoutMs),
          resources.workers.waitForSettlement(timeoutMs),
          this.options.cancellationAuthority.waitForSettlement?.(timeoutMs) ?? true,
        ]);
        return schedulerSettled && workersSettled && processTreesSettled;
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
      releaseLeases: async () => {
        closeFrozenQuestions();
        this.releaseArtifactLease("cancel");
        await this.options.cancellationAuthority.releaseLeases?.();
      },
    };
  }

  async cancel(reason: string, options: { readonly preserveKnowledge?: boolean } = {}): Promise<CancellationResult> {
    await this.knowledgeQueue.preemptForUserWork();
    this.preserveCancelledEnrichment = options.preserveKnowledge === true;
    if (this.preserveCancelledEnrichment) {
      const run = this.lifecycle.restore().latestRun;
      if (!run || !isOpenRunStatus(run.status)) throw new Error("Cancelled-run knowledge preservation requires a current open run");
      new KnowledgeEnrichmentService({ projectRoot: this.options.projectRoot, projectId: this.options.projectId, sessionId: this.options.sessionId, runId: run.runId, snapshot: this.options.snapshot, now: this.options.now }).requestCancelledPreservation();
    }
    try {
      const result = await this.lifecycle.cancel(reason, this.cancellationCoordinator(reason));
      this.artifactCallerIssuer?.revoke();
      if (this.current) await this.current.workers.closeSessions();
      return result;
    } finally { this.preserveCancelledEnrichment = false; }
  }

  questionControls(): QuestionService {
    const run = this.lifecycle.restore().latestRun;
    if (!run || !isOpenRunStatus(run.status)) throw new Error("Question controls require a current open workflow run");
    return this.questionRuntimeFor(run.runId);
  }

  activeWorkerCount(): number { return this.current?.scheduler.activeCount ?? 0; }

  async shutdown(reason = "process shutdown"): Promise<void> {
    this.shuttingDown = true;
    this.unregisterLiveCancellationAuthority();
    if (this.knowledgeReconcileImmediate !== undefined) { clearTimeout(this.knowledgeReconcileImmediate); this.knowledgeReconcileImmediate = undefined; }
    if (this.knowledgeRetryTimer !== undefined) { clearTimeout(this.knowledgeRetryTimer); this.knowledgeRetryTimer = undefined; }
    this.artifactCallerIssuer?.revoke();
    await this.knowledgeQueue.shutdown();
    const reconciliation = this.knowledgeReconciliation;
    if (reconciliation) await this.settleWithin(reconciliation, 100);
    if (this.curatorHandles.size) await Promise.allSettled([...this.curatorHandles.keys()].map((jobId) => this.disposeCuratorHandle(jobId)));
    // Question tools may be the promise preventing a worker from reaching its
    // pause boundary, so abort and await their wrappers before worker settlement.
    if (this.current) await this.current.questions.shutdown();
    const run = this.lifecycle.restore().latestRun;
    if (run && isOpenRunStatus(run.status)) await this.pause(reason);
    if (this.current) await this.current.workers.closeSessions();
    if (this.cleanup.size) await Promise.allSettled([...this.cleanup]);
  }

  hasLiveHandles(): boolean {
    return Boolean(this.knowledgeReconciliation || this.knowledgeQueue.hasLiveWork() || this.curatorHandles.size || this.current?.questions.hasLiveHandles() || this.current?.scheduler.hasLiveHandles() || this.current?.workers.hasLiveHandles() || this.cleanup.size);
  }
}
