import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import { canonicalJson } from "../config/snapshot-canonical";
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
  type ArtifactReference,
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
import {
  assertCompactionPreservation,
  assembleRootWorkflowPrompt,
  buildCompactionPreservationBlock,
  type WorkflowPromptAssembly,
} from "./prompts";
import { appendWorkflowEvent, readWorkflowJournal } from "./journal";
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
import { bindPhysicalArtifactWorkspace, listPhysicalArtifactWorkspaces, type PhysicalWorkspaceSelection } from "../artifacts/workspaces";
import { createRunOrchestrationArtifactCallerIssuer, type RunOrchestrationArtifactCallerIssuer } from "../artifacts/internal/caller";
import type { ArtifactEvidenceReferenceV1, ArtifactWorkspaceBinding, VerifiedArtifactEvidenceV1 } from "../artifacts/types";
import { heartbeatCurrentRuntimeOwnership } from "./ownership";
import { resolveContainedPath } from "../core/safe-path";
import { CheckpointApprovalService, type CheckpointApprovalServiceOptions } from "../artifacts/approvals";
import type { CheckpointPolicy } from "../artifacts/checkpoints";

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
  /** Integration seam backed by Pi's withFileMutationQueue; required before any physical adapter mutation. */
  readonly artifactMutationQueue?: ArtifactMutationQueue;
  /** Package-internal dependency seam used to exercise physical adapters before their built-in implementation ships. */
  readonly artifactRuntime?: ResolvedArtifactProfile;
  /** Package-internal lease construction seam for deterministic lifecycle fault tests. */
  readonly artifactLeaseFactory?: (options: WorkspaceLeaseRuntimeOptions) => WorkspaceLeaseRuntime;
  /** Fault-injection seam for artifact/W13 restart-settlement tests. */
  readonly artifactOperationFault?: ArtifactOperationRuntimeOptions["fault"];
  /** Human control dependencies for the run-owned generic checkpoint authority. Omission denies every decision. */
  readonly checkpointApproval?: Partial<Pick<CheckpointApprovalServiceOptions, "authenticateControl" | "createRequestId" | "createDecisionId" | "fault">>;
  readonly verifiedTakeover?: () => boolean | Promise<boolean>;
  readonly completion?: Omit<CompletionValidationHooks, "descendants">;
  /** Fault-injection seam for workflow lifecycle crash-recovery tests. */
  readonly journalFault?: WorkflowRunLifecycleOptions["journalFault"];
  readonly pauseAuthority: PauseCoordinator; readonly resumeAuthority: ResumeCoordinator;
  readonly cancellationAuthority: Pick<CancellationCoordinator, "terminateProcessTrees" | "capturePartialState" | "releaseLeases">;
}
export interface RootModelDispatchRequest {
  readonly correlationId: string; readonly operation: string; readonly input: unknown; readonly finalization?: boolean;
  readonly installCompactionBoundary?: (boundary: Readonly<{ preservation: string; validate(value: string): void }>) => void;
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
  deliverResults(deliveryId: string, options?: { limit?: number }): ResultDeliveryBatch;
  runWithToolRuntime<T>(callback: () => T): T;
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
  private readonly selectedArtifact?: ResolvedArtifactProfile;
  private readonly artifactCallerIssuer?: RunOrchestrationArtifactCallerIssuer;
  /** One authority owns run snapshots, requests, control decisions, and completion. */
  readonly checkpointApprovals?: CheckpointApprovalService;
  private current?: RunResources;
  private artifactAuthority?: Readonly<{ runId: string; authority: ArtifactWorkspaceAuthority }>;
  private readonly cleanup = new Set<Promise<void>>();

  constructor(options: RunOrchestrationServiceOptions) {
    this.options = options;
    const selectedArtifact = runtimeArtifact(options.snapshot, options.artifactRuntime);
    this.selectedArtifact = selectedArtifact;
    this.artifactCallerIssuer = selectedArtifact ? createRunOrchestrationArtifactCallerIssuer(options.snapshot) : undefined;
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
      onRunStatusChanged: (runId, status) => {
        const budgets = this.budgetRuntimeFor(runId);
        if (status === "paused" || status === "waiting_for_human") budgets.pauseActive(status);
        else budgets.resumeActive();
      },
      journalFault: options.journalFault,
    });
  }

  private artifactSelection(): Readonly<{ binding: string; options: Readonly<Record<string, JsonValue>> }> {
    const artifact = this.options.snapshot.payload.workflow.artifact as { binding?: unknown; options?: unknown };
    const options = record(artifact.options) ? artifact.options as Readonly<Record<string, JsonValue>> : Object.freeze({});
    return Object.freeze({ binding: String(artifact.binding ?? ""), options });
  }

  listArtifactWorkspaces(input: Readonly<{ limit: number; cursor?: string }>) {
    if (!this.selectedArtifact?.adapter || this.selectedArtifact.profile.adapterId === "none") throw new Error("Active artifact profile has no physical workspace listing");
    return listPhysicalArtifactWorkspaces({
      projectRoot: this.options.projectRoot, adapter: this.selectedArtifact.adapter, profile: this.selectedArtifact.profile,
      options: this.artifactSelection().options, limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}),
    });
  }

  bindArtifactWorkspace(selection: PhysicalWorkspaceSelection, handoffWorkspaceId?: string) {
    if (!this.selectedArtifact?.adapter || this.selectedArtifact.profile.adapterId === "none") throw new Error("Active artifact profile has no physical workspace binding");
    const run = this.lifecycle.restore().latestRun;
    if (!run || !isOpenRunStatus(run.status)) throw new Error("Artifact workspace binding requires a current open run");
    if (run.artifactWorkspace) throw new Error("Artifact workspace is already bound; rebinding is denied");
    const handoff = run.handoffPacketHash ? handoffForRun(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), run.runId) : undefined;
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
    return this.lifecycle.bindArtifactWorkspace(binding);
  }

  private workspaceAuthority(binding: ArtifactWorkspaceBinding | undefined, runId: string): ArtifactWorkspaceAuthority | undefined {
    if (!binding || binding.workspace.kind !== "physical" || !binding.path) return undefined;
    if (this.artifactAuthority?.runId === runId) return this.artifactAuthority.authority;
    this.artifactAuthority?.authority.lease.stopHeartbeat();
    const authority: ArtifactWorkspaceAuthority = Object.freeze({
      readHashes: () => hashArtifactWorkspace(binding.path!),
      lease: (this.options.artifactLeaseFactory ?? ((options) => new WorkspaceLeaseRuntime(options)))({
        projectRoot: this.options.projectRoot, adapterId: binding.adapterId, workspaceId: binding.workspace.id,
        sessionId: this.options.sessionId, runId,
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
        const candidate = resolveContainedPath(this.options.projectRoot, join(this.options.projectRoot, evidencePath));
        if (!candidate?.exists || relative(this.options.projectRoot, candidate.canonicalPath).split("\\").join("/") !== evidencePath) throw new Error("Artifact repository evidence escapes or is unavailable");
        const stat = lstatSync(candidate.canonicalPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 33_554_432) throw new Error("Artifact repository evidence is not a bounded regular file");
        const digest = `sha256:${createHash("sha256").update(readFileSync(candidate.canonicalPath)).digest("hex")}`;
        if (reference.digest !== digest) throw new Error("Artifact repository evidence expected hash is stale");
        return Object.freeze({ kind: "repository", path: evidencePath, digest, bytes: stat.size });
      }
      throw new Error("Artifact evidence reference kind is unsupported");
    }));
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
      mutationQueue: this.options.artifactMutationQueue, workspaceAuthority: authority,
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
    this.artifactAuthority = undefined;
    return Object.freeze({ released: evidence.released, finalWorkspaceHash });
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
      protectedRoots: Object.freeze([...(configured?.protectedRoots ?? []), ...this.artifactProtectedWorkspaceRoots()]),
    });
  }

  private rootPromptAssembly(runId?: string): WorkflowPromptAssembly {
    const run = this.lifecycle.restore().latestRun;
    if (!run || (runId !== undefined && run.runId !== runId)) throw new Error("Root prompt requires the current workflow run");
    const handoff = run.handoffPacketHash ? handoffForRun(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), run.runId) : undefined;
    if (run.handoffPacketHash && handoff?.packetHash !== run.handoffPacketHash) throw new Error("Consumed handoff packet is missing or does not match the run marker");
    return assembleRootWorkflowPrompt({
      snapshot: this.options.snapshot,
      nodeId: rootNodeId(this.options.snapshot),
      sessionId: this.options.sessionId,
      runId: run.runId,
      ...(handoff ? { handoff: handoffPromptInput(handoff) } : {}),
      runInputs: run.inputs.map((entry) => ({
        source: "user" as const,
        provenance: `run-input:${entry.sequence}:${entry.source}`,
        content: entry.text,
        ref: `run:${run.runId}/input:${entry.sequence}`,
      })),
    });
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
    const rootBoundary = nodeId === rootNodeId(this.options.snapshot) ? this.rootCompactionBoundary() : undefined;
    if (rootBoundary) request.installCompactionBoundary?.(rootBoundary);
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
    if (budgets.restore().activeBatches.length) {
      const boundary = this.options.recoveredOwnerHeartbeatAt === undefined ? Number.NaN : Date.parse(this.options.recoveredOwnerHeartbeatAt);
      if (!Number.isFinite(boundary)) recoveryIssues.push("abandoned active budget clock has no verified previous-owner heartbeat boundary");
      else {
        budgets.reconcileAbandonedActiveTime(boundary, "reconciled at verified previous-owner heartbeat");
        budgets.resumeActive();
      }
    }
    const recoveryRun = this.lifecycle.restore().latestRun;
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
    for (const attempt of Object.values(attempts.restore().attempts)) {
      if (!attempt.result && attempt.recovery === "reconcile-required" && attempt.status === "pending") {
        attempts.markUnknown(attempt.attemptId, "interrupted non-idempotent dispatch requires trusted reconciliation before admission");
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
    const bound: BoundDelegationServices = Object.freeze({
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
            if (!workspace) throw new Error("Artifact status requires a trusted run workspace binding");
            const workspaceAuthority = this.workspaceAuthority(workspace, resources.runId);
            const facade = new ArtifactFacade({ adapter: this.selectedArtifact!.adapter!, profile: this.selectedArtifact!.profile, binding: workspace, mutationQueue: this.options.artifactMutationQueue, ...(workspaceAuthority ? { workspaceAuthority } : {}) });
            const caller = this.artifactCallerIssuer!.issue(context.nodeId, workspace);
            return facade.status(caller, input, { ...(signal ? { signal } : {}) });
          } : undefined,
          artifactAction: this.selectedArtifact?.adapter ? async (input, attemptId, signal) => {
            assertCurrent();
            const workspace = this.lifecycle.restore().latestRun?.artifactWorkspace;
            if (!workspace) throw new Error("Artifact action requires a trusted run workspace binding");
            const workspaceAuthority = this.workspaceAuthority(workspace, resources.runId);
            const facade = new ArtifactFacade({ adapter: this.selectedArtifact!.adapter!, profile: this.selectedArtifact!.profile, binding: workspace, mutationQueue: this.options.artifactMutationQueue, ...(workspaceAuthority ? { workspaceAuthority } : {}) });
            const caller = this.artifactCallerIssuer!.issue(context.nodeId, workspace);
            return facade.action(caller, input, {
              attemptId,
              ...(signal ? { signal } : {}),
              verifyEvidence: (references) => this.verifyArtifactEvidence(resources, references),
            });
          } : undefined,
          finish: (input, batch) => this.lifecycle.finish(input, { callerNodeId: context.nodeId, toolBatch: batch }),
        });
        return runWithWorkflowToolRuntime(binding, callback);
      },
    });
    return bound;
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
    const admissionIssues = this.recoveryAdmissionIssues(resources);
    if (admissionIssues.length) {
      if (this.lifecycle.restore().latestRun?.status === "running") await this.pause(`unknown_side_effect: ${admissionIssues.join("; ").slice(0, 2_048)}`);
      throw new Error(`Worker admission paused for unresolved unknown side effects: ${admissionIssues.join("; ")}`);
    }
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
      releaseLeases: async () => {
        this.releaseArtifactLease("cancel");
        await this.options.cancellationAuthority.releaseLeases?.();
      },
    };
  }

  async cancel(reason: string): Promise<CancellationResult> {
    const result = await this.lifecycle.cancel(reason, this.cancellationCoordinator(reason));
    this.artifactCallerIssuer?.revoke();
    if (this.current) await this.current.workers.closeSessions();
    return result;
  }

  async shutdown(reason = "process shutdown"): Promise<void> {
    this.artifactCallerIssuer?.revoke();
    const run = this.lifecycle.restore().latestRun;
    if (run && isOpenRunStatus(run.status)) await this.pause(reason);
    if (this.current) await this.current.workers.closeSessions();
    if (this.cleanup.size) await Promise.allSettled([...this.cleanup]);
  }

  hasLiveHandles(): boolean {
    return Boolean(this.current?.scheduler.hasLiveHandles() || this.current?.workers.hasLiveHandles() || this.cleanup.size);
  }
}
