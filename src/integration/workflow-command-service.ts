import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { CheckpointApprovalService, createEmptyCheckpointApprovalState, reduceCheckpointApprovalState, type HumanControlIdentity } from "../artifacts/approvals";
import { hashArtifactWorkspace } from "../artifacts/hashes";
import { WorkspaceLeaseRuntime } from "../artifacts/leases";
import { BUILTIN_ARTIFACT_REGISTRY, type ResolvedArtifactProfile } from "../artifacts/registry";
import type { CheckpointPolicy } from "../artifacts/checkpoints";
import { buildActivationSnapshot, loadConfigCatalogs, loadConfigProject, readActivationSnapshot, resolveConfigWorkflows, writeActivationSnapshot, type ActivationSnapshotFileV1, type SnapshotArtifactCompatibilityIdentity, type SnapshotCompatibilityRuntime, type SnapshotModelAdapter, type ValidWorkflowDefinition } from "../config/index";
import { canonicalJson } from "../config/snapshot-canonical";
import { pruneWorkflowProjection, startWorkflowDashboard, stopWorkflowDashboard, workflowDashboardAvailable } from "./workflow-dashboard-service";
import { createBudgetState, effectiveRuntimeBudgetLimitsFromSnapshot, reduceBudgetState } from "../workflows/budgets";
import { createDelegationState, reduceDelegationState } from "../workflows/delegation";
import { readHandoffState } from "../workflows/handoff";
import { readWorkflowJournal } from "../workflows/journal";
import { resolveLiveWorkflowCancellationAuthority } from "../workflows/live-cancellation";
import { exitWorkflowSession, type SelectableWorkflow } from "../workflows/navigation";
import { createEmptyQuestionState, QuestionService, reduceQuestionState, type QuestionControlAuthenticationRequest } from "../workflows/questions";
import { createEmptyRunLifecycleState, isOpenRunStatus, reduceRunLifecycle, WorkflowRunLifecycle } from "../workflows/runs";
import { listSessionLinks, type WorkflowSessionLink } from "../workflows/sessions";
import { createPiSessionNavigationAdapter } from "./session-links";
import { createWorkflowLifecycleServiceHandlers } from "./workflow-lifecycle-handlers";
import type { WorkflowApprovalAction, WorkflowCheckpointAction, WorkflowCommandServices, WorkflowSelectorItem } from "./workflow-commands";

const PACKAGE_VERSION = "1.0.0";
const MAX_STATUS_BYTES = 8_192;
const MAX_LINKED_STATUS_ROWS = 64;
const ownerNonce = randomUUID();

export interface WorkflowRuntimeCommandAuthority {
  authenticateQuestion(ctx: ExtensionCommandContext, request: QuestionControlAuthenticationRequest): string | undefined;
  authenticateCheckpoint(ctx: ExtensionCommandContext): HumanControlIdentity | undefined;
  dashboardAvailable(ctx: ExtensionCommandContext): Promise<boolean>;
  cancelRun(input: Readonly<{ ctx: ExtensionCommandContext; projectRoot: string; projectId: string; link: WorkflowSessionLink; snapshot: ActivationSnapshotFileV1; reason: string }>): Promise<string>;
}

function requireTrustedContext(ctx: ExtensionCommandContext): void {
  if (!ctx.isProjectTrusted()) throw new Error("Workflow control requires a trusted project command context");
}

/** Pi-owned command authority uses only documented command-context operations. */
export function createPiWorkflowRuntimeCommandAuthority(): WorkflowRuntimeCommandAuthority {
  return Object.freeze({
    authenticateQuestion(ctx: ExtensionCommandContext, request: QuestionControlAuthenticationRequest): string | undefined {
      if (!ctx.isProjectTrusted() || request.channel !== "command" || request.claimedIdentity !== "pi-command-context") return undefined;
      return `pi-user:${ctx.sessionManager.getSessionId()}`;
    },
    authenticateCheckpoint(ctx: ExtensionCommandContext): HumanControlIdentity | undefined {
      if (!ctx.isProjectTrusted() || ctx.mode !== "tui" || !ctx.hasUI) return undefined;
      const sessionId = ctx.sessionManager.getSessionId();
      return Object.freeze({ approverId: `pi-user:${sessionId}`, authenticationId: `pi-tui:${sessionId}`, mechanism: "trusted-project-command-context" });
    },
    async dashboardAvailable(): Promise<boolean> { return workflowDashboardAvailable(); },
    async cancelRun({ ctx, projectRoot, projectId, link, snapshot, reason }: Readonly<{ ctx: ExtensionCommandContext; projectRoot: string; projectId: string; link: WorkflowSessionLink; snapshot: ActivationSnapshotFileV1; reason: string }>): Promise<string> {
      requireTrustedContext(ctx);
      const workflow = snapshot.payload.workflow as { team?: { rootId?: unknown } };
      const rootNodeId = typeof workflow.team?.rootId === "string" ? workflow.team.rootId : "";
      if (!rootNodeId) throw new Error("Workflow cancellation activation has no root node authority");
      const events = readWorkflowJournal(projectRoot, link.workflowSessionId);
      const run = events.reduce(reduceRunLifecycle, createEmptyRunLifecycleState(link.workflowSessionId)).latestRun;
      if (!run || !isOpenRunStatus(run.status)) throw new Error("Workflow cancellation requires an open run");
      if (snapshot.snapshotHash !== link.activationHash) throw new Error("Workflow cancellation snapshot identity does not match the authoritative session link");

      const live = resolveLiveWorkflowCancellationAuthority({
        projectRoot, projectId, sessionId: link.workflowSessionId, snapshotId: link.activationHash, runId: run.runId,
      });
      if (live) {
        const result = await live.cancel(reason);
        return `Cancelled ${result.envelope.runId}`;
      }

      const delegation = events.reduce(reduceDelegationState, createDelegationState(link.workflowSessionId, run.runId, snapshot));
      const unsettled = Object.values(delegation.tasks).filter((task) => task.queueState !== "terminal");
      if (unsettled.length) throw new Error("Live workflow cancellation authority is unavailable; active or queued worker executions cannot be proven settled and the run remains open");

      const questions = new QuestionService({ projectRoot, projectId, sessionId: link.workflowSessionId, runId: run.runId, snapshot, authenticateControl: () => undefined });
      const lifecycle = new WorkflowRunLifecycle({
        projectRoot, projectId, sessionId: link.workflowSessionId, snapshotId: link.activationHash, rootNodeId, runtimeOwnerNonce: ownerNonce,
        completion: { questions: () => questions.completionGate(), validateQuestionSet: (journal, expected) => questions.assertPendingSet(journal, expected) },
      });
      const result = await lifecycle.cancel(reason, {
        abortOwnedWork: async () => { if (!ctx.isIdle()) ctx.abort(); },
        waitForSettlement: async () => { await ctx.waitForIdle(); return ctx.isIdle(); },
        capturePartialState: () => Object.freeze({ commandAuthority: "pi-command-context", workerSettlement: "durably-idle" }),
        releaseLeases: () => {
          questions.closePending({ reason, operationId: `cancel-question-closure-${run.runId}`, expectedQuestionIds: lifecycle.restore().latestRun?.cancellationQuestionIds ?? [] });
          const binding = run.artifactWorkspace;
          if (!binding || binding.workspace.kind !== "physical") return;
          const artifact = selectedArtifact(snapshot);
          if (binding.adapterId !== artifact.adapter.id || binding.profileId !== artifact.profile.id || binding.profileVersion !== artifact.profile.version) {
            throw new Error("Bound artifact workspace identity does not match the authoritative activation snapshot");
          }
          const lease = new WorkspaceLeaseRuntime({
            projectRoot, adapterId: binding.adapterId, workspaceId: binding.workspace.id,
            sessionId: link.workflowSessionId, runId: run.runId, ownerNonce,
          });
          if (!lease.release() && lease.inspect().state !== "available") {
            throw new Error("Artifact writer lease belongs to another run or owner; cancellation release was denied");
          }
        },
      });
      return `Cancelled ${result.envelope.runId}`;
    },
  });
}

interface PreparedWorkflow { readonly item: WorkflowSelectorItem; readonly selectable?: SelectableWorkflow; readonly freshSelectable?: SelectableWorkflow; readonly current?: WorkflowSessionLink; readonly definition?: ValidWorkflowDefinition }
function currentPiSessionId(ctx: ExtensionCommandContext): string { return ctx.sessionManager.getSessionId(); }
function requireContext(ctx: ExtensionCommandContext | undefined): ExtensionCommandContext { if (!ctx) throw new Error("Workflow command requires a command-bound Pi session context"); return ctx; }
function modelId(ctx: ExtensionCommandContext): string { if (!ctx.model) throw new Error("Workflow activation requires a selected Pi model"); return `${ctx.model.provider}/${ctx.model.id}`; }
function splitModel(value: string): readonly [string, string] { const index = value.indexOf("/"); if (index < 1 || index === value.length - 1) throw new Error(`Workflow model ${value} is invalid`); return [value.slice(0, index), value.slice(index + 1)]; }
function modelAdapter(pi: ExtensionAPI, ctx: ExtensionCommandContext): SnapshotModelAdapter {
  const registry = ctx.modelRegistry;
  return {
    defaultModel: modelId(ctx), defaultThinking: String(pi.getThinkingLevel()),
    find(id) { const [provider, selected] = splitModel(id); const model = registry.find(provider, selected); if (!model) return undefined; const mapped = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? Object.keys(model.thinkingLevelMap) : []; return { id, contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinking: [...new Set(["off", ...(model.reasoning ? ["minimal", "low", "medium", "high", "xhigh"] : []), ...mapped])] }; },
    canActivate(id) { const [provider, selected] = splitModel(id); const model = registry.find(provider, selected); return Boolean(model && registry.hasConfiguredAuth(model)); },
    estimateTokens(text) { return Math.ceil(Buffer.byteLength(text, "utf8") / 4); },
  };
}
function workflowRoot(snapshot: ActivationSnapshotFileV1): Readonly<{ id: string; model: string; thinking: string; tools: readonly string[] }> {
  const team = snapshot.payload.workflow.team as { rootId?: unknown } | undefined; const id = typeof team?.rootId === "string" ? team.rootId : "";
  const authority = snapshot.payload.authority.nodes.find((node) => node.nodeId === id); const model = snapshot.payload.models.find((node) => node.nodeId === id);
  if (!id || !authority || !model) throw new Error("Workflow activation root authority is incomplete");
  return { id, model: model.modelId, thinking: model.thinking, tools: Array.isArray(authority.tools) ? authority.tools.filter((tool): tool is string => typeof tool === "string") : [] };
}
function restoredRun(projectRoot: string, link: WorkflowSessionLink) { return readWorkflowJournal(projectRoot, link.workflowSessionId).reduce(reduceRunLifecycle, createEmptyRunLifecycleState(link.workflowSessionId)).latestRun; }
function openRunId(projectRoot: string, link: WorkflowSessionLink): string | undefined { const run = restoredRun(projectRoot, link); return run && isOpenRunStatus(run.status) ? run.runId : undefined; }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function sessionState(link: WorkflowSessionLink): "current" | "archived" | "stale" | "orphaned" { return link.orphaned ? "orphaned" : link.stale ? "stale" : link.status; }
function boundedStatus(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_STATUS_BYTES) return text;
  const suffix = "\n[output truncated]";
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > MAX_STATUS_BYTES - Buffer.byteLength(suffix, "utf8")) end = Math.max(0, end - 128);
  while (end < text.length && Buffer.byteLength(text.slice(0, end + 1), "utf8") <= MAX_STATUS_BYTES - Buffer.byteLength(suffix, "utf8")) end++;
  return `${text.slice(0, end)}${suffix}`;
}
function normalStatus(projectRoot: string, piSessionId: string): string {
  const links = listSessionLinks(projectRoot);
  const normal = links.find((entry) => entry.kind === "normal" && entry.piSessionId === piSessionId);
  const parentId = normal?.piSessionId ?? piSessionId;
  const linked = links.filter((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.normalParentId === parentId);
  const rows = linked.slice(0, MAX_LINKED_STATUS_ROWS).map((link) => {
    const run = restoredRun(projectRoot, link);
    return `${link.workflowId} (${sessionState(link)}, ${run ? `${run.status} run ${run.runId}` : "idle"}, activation ${link.activationHash.slice(0, 12)})`;
  });
  if (linked.length > rows.length) rows.push(`… ${linked.length - rows.length} more linked session(s)`);
  return boundedStatus(`Normal chat ${piSessionId} · Linked workflows: ${rows.join("; ") || "none"}`);
}
function durableStatus(projectRoot: string, link: WorkflowSessionLink): string {
  const snapshot = readActivationSnapshot(projectRoot, link.activationHash);
  const events = readWorkflowJournal(projectRoot, link.workflowSessionId);
  const run = events.reduce(reduceRunLifecycle, createEmptyRunLifecycleState(link.workflowSessionId)).latestRun;
  const handoff = readHandoffState(projectRoot, link.workflowSessionId).staged;
  const parts = [
    `Workflow ${link.workflowId}`,
    `session ${link.workflowSessionId} (${sessionState(link)})`,
    run ? `${run.status} run ${run.runId}` : "idle",
    `activation ${link.activationHash.slice(0, 12)}`,
    handoff ? `handoff ${handoff.packetHash.slice(0, 12)}` : "handoff none",
  ];
  if (!run) return [...parts, "questions 0", "workers 0", "approvals 0", "workspace none", "budget idle"].join(" · ");

  const questions = events.reduce(reduceQuestionState, createEmptyQuestionState(link.workflowSessionId, run.runId));
  const pendingQuestions = Object.values(questions.questions).filter((question) => question.state === "pending").length;
  const delegation = events.reduce(reduceDelegationState, createDelegationState(link.workflowSessionId, run.runId, snapshot));
  const tasks = Object.values(delegation.tasks);
  const workerCounts = {
    queued: tasks.filter((task) => task.queueState === "queued").length,
    active: tasks.filter((task) => task.queueState === "active").length,
    suspended: tasks.filter((task) => task.queueState === "suspended").length,
    terminal: tasks.filter((task) => task.queueState === "terminal").length,
  };
  const approvals = events.reduce(reduceCheckpointApprovalState, createEmptyCheckpointApprovalState());
  const pendingApprovals = approvals.requestOrder.map((id) => approvals.requests[id]).filter((request) => request?.runId === run.runId && !request.decision).length;
  const workflow = snapshot.payload.workflow as { team?: { rootId?: unknown } };
  const rootNodeId = String(workflow.team?.rootId ?? "");
  const limits = effectiveRuntimeBudgetLimitsFromSnapshot(snapshot);
  const budget = events.reduce(reduceBudgetState, createBudgetState(link.workflowSessionId, run.runId, rootNodeId, limits));
  const workers = tasks.length ? `workers ${tasks.length} (queued ${workerCounts.queued}, active ${workerCounts.active}, suspended ${workerCounts.suspended}, terminal ${workerCounts.terminal})` : "workers 0";
  const workspace = run.artifactWorkspace ? `workspace ${run.artifactWorkspace.workspace.id}` : "workspace none";
  const budgetSummary = `budget tokens ${budget.run.tokens}/${budget.limits.run.tokenBudget}, tools ${budget.run.toolCalls}/${budget.limits.run.maxToolCalls}, delegations ${budget.run.delegations}/${budget.limits.run.maxDelegations}, active ${budget.run.activeWallTimeMs}/${budget.limits.run.activeWallTimeMs}ms`;
  return [...parts, `questions ${pendingQuestions}`, workers, `approvals ${pendingApprovals}`, workspace, budgetSummary].join(" · ");
}

function selectedArtifact(snapshot: ActivationSnapshotFileV1): ResolvedArtifactProfile {
  const artifact = (snapshot.payload.workflow as { artifact?: unknown }).artifact;
  if (!record(artifact) || typeof artifact.contractVersion !== "string" || typeof artifact.adapter !== "string" || typeof artifact.adapterVersion !== "string" || typeof artifact.profile !== "string" || typeof artifact.profileVersion !== "string" || typeof artifact.optionsSchemaVersion !== "string" || artifact.viewVersion !== 1 || !Array.isArray(artifact.checkpoints) || !Array.isArray(artifact.actionIds)) throw new Error("Activation snapshot artifact selection is invalid");
  const selected = BUILTIN_ARTIFACT_REGISTRY.resolveProfile({ contractVersion: artifact.contractVersion, adapterId: artifact.adapter, adapterVersion: artifact.adapterVersion, profileId: artifact.profile, profileVersion: artifact.profileVersion });
  if (selected.profile.optionsSchemaVersion !== artifact.optionsSchemaVersion || selected.profile.viewVersion !== artifact.viewVersion || canonicalJson(selected.profile.checkpointIds) !== canonicalJson(artifact.checkpoints) || canonicalJson(selected.profile.actions.map((action) => action.id)) !== canonicalJson(artifact.actionIds)) throw new Error("Activation snapshot artifact profile identity is incompatible");
  return selected;
}
function checkpointPolicies(snapshot: ActivationSnapshotFileV1, selected: ResolvedArtifactProfile): Readonly<Record<string, CheckpointPolicy>> {
  const artifact = (snapshot.payload.workflow as { artifact?: unknown }).artifact;
  if (!record(artifact) || !record(artifact.approvals)) throw new Error("Activation snapshot checkpoint policies are invalid");
  const policies: Record<string, CheckpointPolicy> = {};
  for (const checkpointId of selected.profile.checkpointIds) { const policy = artifact.approvals[checkpointId]; if (policy !== "required" && policy !== "optional" && policy !== "none") throw new Error(`Activation snapshot checkpoint policy is missing or invalid: ${checkpointId}`); policies[checkpointId] = policy; }
  if (Object.keys(artifact.approvals).some((checkpointId) => !selected.profile.checkpointIds.includes(checkpointId))) throw new Error("Activation snapshot checkpoint policy is unknown");
  return Object.freeze(policies);
}

export function createLinkedWorkflowCommandServices(pi: ExtensionAPI, projectRoot: string, projectId: string, authority: WorkflowRuntimeCommandAuthority = createPiWorkflowRuntimeCommandAuthority(), sharedRuntimeOwnerNonce: string = ownerNonce): WorkflowCommandServices {
  const prepare = (ctx: ExtensionCommandContext): readonly PreparedWorkflow[] => {
    const project = loadConfigProject(projectRoot); if (project.status !== "configured") throw new Error("Workflow configuration is unavailable or invalid");
    const catalogs = loadConfigCatalogs(project); const links = listSessionLinks(projectRoot).filter((link): link is WorkflowSessionLink => link.kind === "workflow");
    const persisted = links.find((link) => link.status === "current" && link.piSessionId === currentPiSessionId(ctx));
    const resolution = resolveConfigWorkflows(project, catalogs, {}, persisted ? { workflowId: persisted.workflowId, model: persisted.model, thinking: persisted.thinking } : undefined);
    return resolution.workflows.map((definition): PreparedWorkflow => {
      const current = links.find((link) => link.status === "current" && link.workflowId === definition.id);
      const archived = links.filter((link) => link.status === "archived" && link.workflowId === definition.id).sort((a, b) => a.workflowSessionId.localeCompare(b.workflowSessionId));
      let stored: ActivationSnapshotFileV1 | undefined;
      if (current) { try { stored = readActivationSnapshot(projectRoot, current.activationHash); } catch { stored = undefined; } }
      let freshSnapshot: ActivationSnapshotFileV1 | undefined;
      if (definition.status === "valid") { freshSnapshot = buildActivationSnapshot({ project, catalogs, workflow: definition, authority: definition.authority, models: modelAdapter(pi, ctx), packageVersion: PACKAGE_VERSION }); writeActivationSnapshot(projectRoot, freshSnapshot); }
      const currentFresh = Boolean(current && freshSnapshot && current.activationHash === freshSnapshot.snapshotHash);
      const resumable = Boolean(current && stored && stored.payload.workflow.id === definition.id);
      const source: SelectableWorkflow["source"] = currentFresh || (!current && freshSnapshot) ? "current" : resumable ? "stale" : definition.status === "invalid" ? "invalid" : "missing";
      const selectedSnapshot = !currentFresh && resumable ? stored : freshSnapshot; let selectable: SelectableWorkflow | undefined; let freshSelectable: SelectableWorkflow | undefined;
      if (selectedSnapshot) { const root = workflowRoot(selectedSnapshot); selectable = { workflowId: definition.id, activationHash: selectedSnapshot.snapshotHash, source, resumable, freshEnabled: Boolean(freshSnapshot), model: root.model, thinking: root.thinking, tools: root.tools }; }
      if (freshSnapshot) { const root = workflowRoot(freshSnapshot); freshSelectable = { workflowId: definition.id, activationHash: freshSnapshot.snapshotHash, source: "current", resumable: currentFresh, freshEnabled: true, model: root.model, thinking: root.thinking, tools: root.tools }; }
      const diagnostics = [...definition.diagnosticCodes, ...(current?.orphaned && current.recovery?.state === "blocked" ? current.recovery.codes : [])];
      const state: WorkflowSelectorItem["state"] = current?.orphaned ? "orphaned" : current && source === "current" ? "active" : current?.stale || source === "stale" ? "stale" : !current && archived.length ? "archived" : definition.status === "invalid" ? "invalid" : resumable ? "resumable" : "available";
      return { current, ...(definition.status === "valid" ? { definition } : {}), ...(selectable ? { selectable } : {}), ...(freshSelectable ? { freshSelectable } : {}), item: {
        workflowId: definition.id, name: definition.name ?? definition.id, description: definition.description ?? "Configured workflow", useWhen: definition.useWhen ?? "when selected by the operator", ...(definition.avoidWhen ? { avoidWhen: definition.avoidWhen } : {}), tags: definition.tags ?? [], adapter: definition.adapter ?? "none", profile: definition.profile ?? "default",
        ...(selectedSnapshot ? { activationHash: selectedSnapshot.snapshotHash } : {}), source, archivedLinks: archived.map((link) => ({ workflowSessionId: link.workflowSessionId, piSessionId: link.piSessionId, activationHash: link.activationHash })), state, resumable, selectable: Boolean(freshSnapshot), diagnostics, ...(diagnostics.length ? { diagnostic: diagnostics.join(", ") } : {}),
      } };
    });
  };
  const selectedLink = (ctx: ExtensionCommandContext): WorkflowSessionLink => { const link = listSessionLinks(projectRoot).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.piSessionId === currentPiSessionId(ctx)); if (!link) throw new Error("No workflow session is selected"); return link; };
  const owner = () => ({ pid: process.pid, processMarker: `pi-hive-${process.pid}`, nonce: sharedRuntimeOwnerNonce, verifyDead: () => false });
  const lifecycle = (ctx: ExtensionCommandContext, recoverySessionId?: string) => createWorkflowLifecycleServiceHandlers({
    projectRoot, projectId, currentPiSessionId: () => currentPiSessionId(ctx), adapter: createPiSessionNavigationAdapter(ctx), owner,
    ...(recoverySessionId ? { recovery: { currentPiSessionFile: () => { const file = ctx.sessionManager.getSessionFile(); if (!file) throw new Error("Workflow recovery requires a persisted current Pi session"); return file; }, runtime: () => recoveryRuntime(ctx, recoverySessionId) } } : {}),
  });
  const checkpoint = (ctx: ExtensionCommandContext): Readonly<{ service: CheckpointApprovalService; credential: object }> => {
    requireTrustedContext(ctx); const link = selectedLink(ctx); const snapshot = readActivationSnapshot(projectRoot, link.activationHash); const selected = selectedArtifact(snapshot); const credential = Object.freeze({ nonce: randomUUID() });
    const service = new CheckpointApprovalService({
      projectRoot, projectId, sessionId: link.workflowSessionId, adapterId: selected.adapter.id, adapterVersion: selected.adapter.version, profileId: selected.profile.id, profileVersion: selected.profile.version,
      profileSchemaVersion: selected.profile.optionsSchemaVersion, checkpointPolicies: checkpointPolicies(snapshot, selected),
      ...(selected.adapter.checkpointDescriptor ? { resolveDescriptor: ({ checkpointId, binding }) => { if (!binding.path) throw new Error("Physical checkpoint descriptor requires a bound workspace path"); return selected.adapter.checkpointDescriptor!({ binding, checkpointId, hashes: hashArtifactWorkspace(binding.path) }); } } : {}),
      authenticateControl: ({ credential: supplied }) => supplied === credential ? authority.authenticateCheckpoint(ctx) : undefined,
    });
    return Object.freeze({ service, credential });
  };
  const recoveryRuntime = (ctx: ExtensionCommandContext, workflowSessionId: string): SnapshotCompatibilityRuntime => {
    const target = listSessionLinks(projectRoot).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.workflowSessionId === workflowSessionId);
    if (!target) throw new Error("Orphan workflow session link is missing");
    const candidate = prepare(ctx).find((entry) => entry.item.workflowId === target.workflowId);
    const project = loadConfigProject(projectRoot); if (project.status !== "configured") throw new Error("Workflow recovery configuration is unavailable");
    const catalogs = loadConfigCatalogs(project); const knowledge = new Set(catalogs.knowledge.filter((entry) => entry.status === "available").map((entry) => entry.id));
    return {
      sourceState: candidate?.item.source ?? "missing", model: modelAdapter(pi, ctx),
      knowledgeAvailable(dependency) { return typeof dependency.id === "string" && knowledge.has(dependency.id); },
      workspaceAvailable(workflow) { const artifact = record(workflow.artifact) ? workflow.artifact : undefined; if (artifact?.binding === "none" || artifact?.binding === "new" || artifact?.binding === "either") return true; const binding = restoredRun(projectRoot, target)?.artifactWorkspace; return Boolean(binding?.path && existsSync(binding.path)); },
      artifactProfileAvailable(adapterId: string, profileId: string, identity: SnapshotArtifactCompatibilityIdentity) { try { const selected = BUILTIN_ARTIFACT_REGISTRY.resolveProfile({ contractVersion: identity.contractVersion, adapterId, adapterVersion: identity.adapterVersion, profileId, profileVersion: identity.profileVersion }); return selected.profile.optionsSchemaVersion === identity.optionsSchemaVersion && selected.profile.viewVersion === identity.viewVersion && canonicalJson(selected.profile.checkpointIds) === canonicalJson(identity.checkpointIds) && canonicalJson(selected.profile.actions.map((action) => action.id)) === canonicalJson(identity.actionIds); } catch { return false; } },
    };
  };
  return {
    configured: true,
    async listWorkflows(ctx) { return prepare(requireContext(ctx)).map((entry) => entry.item); },
    async select(input, context) { const ctx = requireContext(context); const candidate = prepare(ctx).find((entry) => entry.item.workflowId === input.workflowId); const selected = input.fresh ? candidate?.freshSelectable : candidate?.selectable; if (!selected) throw new Error(`Workflow ${input.workflowId} is unavailable${input.fresh ? " for fresh activation" : ""}`); const result = await lifecycle(ctx).select({ workflow: selected, ...(input.fresh ? { fresh: true } : {}), ...(input.from ? { from: input.from } : {}) }); return `${result.kind === "resumed" ? "Resumed" : "Selected"} ${input.workflowId}`; },
    async status(context) {
      const ctx = requireContext(context);
      const sessionId = currentPiSessionId(ctx);
      const selected = listSessionLinks(projectRoot).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.piSessionId === sessionId);
      return selected ? durableStatus(projectRoot, selected) : normalStatus(projectRoot, sessionId);
    },
    async exit(context) { const ctx = requireContext(context); await exitWorkflowSession({ projectRoot, currentPiSessionId: currentPiSessionId(ctx), ownerNonce: sharedRuntimeOwnerNonce, adapter: createPiSessionNavigationAdapter(ctx) }); return "Returned to the linked normal chat session"; },
    async cancel(reason, context) { const ctx = requireContext(context); const link = selectedLink(ctx); const snapshot = readActivationSnapshot(projectRoot, link.activationHash); return authority.cancelRun({ ctx, projectRoot, projectId, link, snapshot, reason: reason?.trim() || "Cancelled by operator" }); },
    async reload(context) { const ctx = requireContext(context); const link = selectedLink(ctx); const candidate = prepare(ctx).find((entry) => entry.item.workflowId === link.workflowId); if (!candidate?.freshSelectable) throw new Error("Current workflow cannot be freshly revalidated"); const result = await lifecycle(ctx).reload(() => ({ workflow: candidate.freshSelectable! })); return `Reloaded ${result.link.workflowId}`; },
    async checkpoints(input, context) {
      const ctx = requireContext(context);
      const { service } = checkpoint(ctx);
      const state = service.restore();
      if (state.openRunId) throw new Error("Checkpoint defaults can change or be listed only while the workflow session is idle");
      const defaults = service.nextRunDefaults();
      if (!input) return defaults.length ? `Checkpoints at revision ${state.defaultsRevision}: ${defaults.map((entry) => `${entry.checkpointId}=${entry.enabled ? "on" : "off"} (${entry.policy})`).join(", ")}` : `Checkpoints: none at revision ${state.defaultsRevision}`;
      const current = defaults.find((entry) => entry.checkpointId === input.checkpointId);
      if (!current) throw new Error(`Checkpoint ${input.checkpointId} does not exist`);
      // Headless syntax deliberately has no revision argument. The service reads
      // the current durable revision immediately before the CAS update; the
      // journal-locked validation in setOptionalDefault rejects intervening drift.
      // TUI actions instead carry their hidden selection revision unchanged.
      const expectedDefaultsRevision = input.expectedDefaultsRevision ?? service.restore().defaultsRevision;
      const result = service.setOptionalDefault({ operationId: `command-checkpoint-${randomUUID()}`, checkpointId: input.checkpointId, enabled: input.enabled, expectedDefaultsRevision });
      return `Checkpoint ${result.checkpointId} ${result.enabled ? "on" : "off"} at revision ${result.defaultsRevision}`;
    },
    async checkpointActions(context) { const { service } = checkpoint(requireContext(context)); if (service.restore().openRunId) throw new Error("Checkpoint defaults are available only while idle"); return service.nextRunDefaults().map((entry): WorkflowCheckpointAction => ({ kind: "default", ...entry })); },
    async approvalActions(context) { const { service } = checkpoint(requireContext(context)); const state = service.restore(); const run = restoredRun(projectRoot, selectedLink(requireContext(context))); const binding = run?.artifactWorkspace; const workspaceHash = binding?.path ? hashArtifactWorkspace(binding.path).workspaceHash : undefined; if (!workspaceHash) return []; return state.requestOrder.map((id) => state.requests[id]).filter((request) => request && !request.decision && request.runId === run?.runId).map((request): WorkflowApprovalAction => ({ requestId: request.requestId, checkpointId: request.checkpointId, requestSequence: request.requestSequence, digest: request.digest, workspaceHash })); },
    async decideApproval(input, context) { const ctx = requireContext(context); const { service, credential } = checkpoint(ctx); if (await authority.dashboardAvailable(ctx)) throw new Error("TUI approval fallback is unavailable while the authenticated dashboard is online"); const result = await service.decide({ operationId: `tui-checkpoint-${randomUUID()}`, ...input }, { channel: "tui", mode: "tui", dashboardAvailable: false, credential }); return `${result.decision === "approved" ? "Approved" : "Denied"} ${result.requestId} for ${result.digest}`; },
    async readQuestion(questionId, context) { const ctx = requireContext(context); const link = selectedLink(ctx); const runId = openRunId(projectRoot, link); if (!runId) throw new Error("No open workflow run has pending questions"); const snapshot = readActivationSnapshot(projectRoot, link.activationHash); const service = new QuestionService({ projectRoot, projectId, sessionId: link.workflowSessionId, runId, snapshot, authenticateControl: () => undefined }); const question = service.restore().questions[questionId]; if (!question || question.state !== "pending") throw new Error("Exact pending question is missing"); return { definition: question.definition }; },
    async answer(input, context) { const ctx = requireContext(context); const link = selectedLink(ctx); const runId = openRunId(projectRoot, link); if (!runId) throw new Error("No open workflow run has pending questions"); const snapshot = readActivationSnapshot(projectRoot, link.activationHash); const claimedIdentity = "pi-command-context"; const service = new QuestionService({ projectRoot, projectId, sessionId: link.workflowSessionId, runId, snapshot, authenticateControl: (request) => authority.authenticateQuestion(ctx, request) }); service.answer({ projectId, sessionId: link.workflowSessionId, runId, questionId: input.questionId, expectedState: "pending", value: input.value, channel: "command", operationId: `command-${randomUUID()}`, claimedIdentity }); return `Answered ${input.questionId}`; },
    async clearHandoff(context) { const ctx = requireContext(context); const link = selectedLink(ctx); const staged = readHandoffState(projectRoot, link.workflowSessionId).staged; if (!staged) return "No staged handoff"; lifecycle(ctx).clearHandoff(link.workflowSessionId, staged.packetHash); return "Handoff cleared"; },
    async recover(orphanSessionId, context) { const ctx = requireContext(context); requireTrustedContext(ctx); const result = await lifecycle(ctx, orphanSessionId).recover(orphanSessionId); return `Recovered ${result.workflowSessionId} as Pi session ${result.piSessionId}`; },
    async doctor(json, context) {
      requireContext(context);
      const project = loadConfigProject(projectRoot);
      const result = project.status === "configured"
        ? { ok: true, schemaVersion: 1, projectRoot: project.projectRoot, diagnostics: project.diagnostics }
        : { ok: false, status: project.status, diagnostics: project.status === "invalid" ? project.diagnostics : [{ code: "CONFIG_NOT_FOUND", message: "No .pi/hive/hive-config.yaml manifest was discovered." }] };
      return json ? JSON.stringify(result) : result.ok ? `Workflow configuration valid (schema-version 1) at ${projectRoot}` : `Workflow configuration invalid: ${result.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("; ")}`;
    },
    async observe(context) { return `Workflow dashboard: ${await startWorkflowDashboard(requireContext(context), true)}`; },
    async observeStop() { return await stopWorkflowDashboard() ? "Workflow dashboard stopped" : "Workflow dashboard was not running"; },
    async observePrune(cutoff) { await pruneWorkflowProjection(cutoff); return `Workflow projection pruned before ${cutoff}; authoritative journals were not changed`; },
  };
}
