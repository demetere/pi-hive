import { createHash } from "node:crypto";
import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";
import { createWorkflowEvent } from "../workflows/events";
import { appendWorkflowEventChecked, readWorkflowJournal } from "../workflows/journal";
import { createBuiltInKnowledgeProviderRegistry, type KnowledgeProviderRegistry } from "./provider";
import {
  CURATOR_EXECUTION_POLICY,
  createCuratorPlan,
  deriveCuratorBudgetDenialReason,
  restoreKnowledgeEnrichmentState,
  type DurableKnowledgeCandidate,
  type DurableCuratorPlan,
  type DurableCuratorPlanAction,
  type DurableKnowledgeJob,
  type KnowledgeJobTarget,
} from "./enrichment";
import {
  KNOWLEDGE_PROPOSAL_LIMITS,
  KnowledgeMutationError,
  type DurableKnowledgeUpdate,
  type KnowledgeProposalService,
  type OkfKnowledgeMutator,
} from "./proposals";
import {
  KNOWLEDGE_CURATOR_LIMITS,
  boundCuratorTargetContext,
  buildCuratorPrompt,
  type CuratorCandidateView,
} from "./curator-contract";
export { KNOWLEDGE_CURATOR_INPUT_BYTES, KNOWLEDGE_CURATOR_LIMITS, boundCuratorTargetContext, buildCuratorPrompt } from "./curator-contract";
export type { BoundedCuratorTargetContext, CuratorCandidateView, CuratorPromptInput, CuratorTargetContextInput } from "./curator-contract";

export const KNOWLEDGE_CURATOR_SCHEMA_VERSION = 1 as const;
export interface CuratedConclusion {
  readonly text: string;
  readonly citationIds: readonly string[];
}
export interface CuratorOutput {
  readonly formatVersion: 1;
  readonly conclusions: readonly CuratedConclusion[];
  readonly outputHash: string;
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value)) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} has an unknown or missing schema field`);
}
function containsControl(value: string): boolean { for (const character of value) { const code = character.codePointAt(0)!; if (code <= 0x1f || code === 0x7f) return true; } return false; }
function boundedSingleLine(value: unknown): string {
  if (typeof value !== "string") throw new Error("Curator conclusion must be a string");
  const text = value.normalize("NFC").trim();
  if (Buffer.byteLength(text, "utf8") < 8 || Buffer.byteLength(text, "utf8") > KNOWLEDGE_CURATOR_LIMITS.conclusionBytes
    || containsControl(text)) throw new Error("Curator conclusion must be a bounded single-line stable conclusion");
  return text;
}
function identity(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US"); }

export function parseCuratorOutput(raw: string, candidates: readonly CuratorCandidateView[]): CuratorOutput {
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw, "utf8") > KNOWLEDGE_CURATOR_LIMITS.outputBytes) throw new Error("Curator output is not bounded JSON");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Curator output must be valid JSON"); }
  if (!record(parsed)) throw new Error("Curator output JSON schema is invalid");
  exactKeys(parsed, ["formatVersion", "conclusions"], "Curator output");
  if (parsed.formatVersion !== KNOWLEDGE_CURATOR_SCHEMA_VERSION || !Array.isArray(parsed.conclusions)
    || parsed.conclusions.length > KNOWLEDGE_CURATOR_LIMITS.conclusions) throw new Error("Curator output JSON schema or conclusion limit is invalid");
  const known = new Set(candidates.map((candidate) => candidate.candidateId));
  if (known.size !== candidates.length || !known.size) throw new Error("Curator candidate citation set is invalid");
  const consolidated = new Map<string, { text: string; citations: Set<string> }>();
  for (const rawConclusion of parsed.conclusions) {
    if (!record(rawConclusion)) throw new Error("Curator conclusion schema is invalid");
    exactKeys(rawConclusion, ["text", "citationIds"], "Curator conclusion");
    const text = boundedSingleLine(rawConclusion.text);
    if (!Array.isArray(rawConclusion.citationIds) || rawConclusion.citationIds.length < 1
      || rawConclusion.citationIds.length > KNOWLEDGE_CURATOR_LIMITS.citationIds
      || new Set(rawConclusion.citationIds).size !== rawConclusion.citationIds.length
      || rawConclusion.citationIds.some((id) => typeof id !== "string" || !known.has(id))) throw new Error("Curator conclusion citation is missing, duplicated, or unknown");
    const key = identity(text);
    const current = consolidated.get(key) ?? { text, citations: new Set<string>() };
    for (const citation of rawConclusion.citationIds as string[]) current.citations.add(citation);
    consolidated.set(key, current);
  }
  const conclusions = Object.freeze([...consolidated.values()].sort((left, right) => compare(identity(left.text), identity(right.text))).map((entry) => {
    const citationIds = Object.freeze([...entry.citations].sort(compare));
    if (citationIds.length > KNOWLEDGE_CURATOR_LIMITS.citationIds) throw new Error("Curator conclusion citations exceed the post-deduplication bound");
    return Object.freeze({ text: entry.text, citationIds });
  }));
  const identityValue = { formatVersion: KNOWLEDGE_CURATOR_SCHEMA_VERSION, conclusions };
  if (Buffer.byteLength(canonicalJson(identityValue), "utf8") > KNOWLEDGE_CURATOR_LIMITS.outputBytes) throw new Error("Curator consolidated output exceeds its serialized byte bound");
  const outputHash = `sha256:${createHash("sha256").update("pi-hive-curator-output-v1\0").update(canonicalJson(identityValue)).digest("hex")}`;
  return Object.freeze({ ...identityValue, outputHash });
}

export interface KnowledgeCuratorModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicroUsd: number;
  readonly precision: "estimated" | "provider-confirmed";
}
export interface KnowledgeCuratorModelResult { readonly output: string; readonly usage: KnowledgeCuratorModelUsage }
export interface KnowledgeCuratorModelRequest {
  readonly jobId: string;
  readonly modelId: string;
  readonly thinking: string;
  readonly prompt: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly evaluation: 0 | 1;
  readonly signal: AbortSignal;
}
export interface KnowledgeCuratorProcessorOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly snapshot: import("../config/snapshot").ActivationSnapshotFileV1;
  readonly runModel: (request: KnowledgeCuratorModelRequest) => string | KnowledgeCuratorModelResult | Promise<string | KnowledgeCuratorModelResult>;
  readonly mutator: OkfKnowledgeMutator;
  readonly proposals: KnowledgeProposalService;
  readonly providers?: KnowledgeProviderRegistry;
  readonly now?: () => string;
  readonly fault?: (stage: "after-invalidation-fallback" | "after-base-refresh-fallback") => void;
}

function estimatedTokens(value: string): number { return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4)); }
function modelResult(value: string | KnowledgeCuratorModelResult, prompt: string): KnowledgeCuratorModelResult {
  if (typeof value === "string") return Object.freeze({ output: value, usage: Object.freeze({ inputTokens: estimatedTokens(prompt), outputTokens: estimatedTokens(value), costMicroUsd: 0, precision: "estimated" as const }) });
  if (!record(value) || !exactModelResult(value)) throw new Error("Knowledge curator model result schema is invalid");
  const usage = value.usage;
  if (!record(usage) || Object.keys(usage).sort().join(",") !== "costMicroUsd,inputTokens,outputTokens,precision" || !Number.isSafeInteger(usage.inputTokens) || Number(usage.inputTokens) < 0
    || !Number.isSafeInteger(usage.outputTokens) || Number(usage.outputTokens) < 0 || !Number.isSafeInteger(usage.costMicroUsd) || Number(usage.costMicroUsd) < 0
    || (usage.precision !== "estimated" && usage.precision !== "provider-confirmed") || typeof value.output !== "string") throw new Error("Knowledge curator model usage is invalid");
  return Object.freeze({ output: value.output, usage: Object.freeze({ inputTokens: Number(usage.inputTokens), outputTokens: Number(usage.outputTokens), costMicroUsd: Number(usage.costMicroUsd), precision: usage.precision }) });
}
function exactModelResult(value: Record<string, unknown>): value is Record<string, unknown> & { output: string; usage: Record<string, unknown> } {
  return Object.keys(value).length === 2 && "output" in value && "usage" in value;
}
interface CuratorAccounting { admissions: Set<string>; usedAdmissions: Set<string>; reservedInputTokens: number; reservedOutputTokens: number; reservedCostMicroUsd: number; modelCalls: number }
function curatorAccounting(events: readonly import("../workflows/events").WorkflowEventEnvelope[], projectId: string, sessionId: string): CuratorAccounting {
  const restored = restoreKnowledgeEnrichmentState(events);
  for (const job of Object.values(restored.jobs)) if (job.projectId !== projectId || job.sessionId !== sessionId) throw new Error("Curator accounting journal identity is invalid");
  const admissions = new Set(Object.keys(restored.curatorAdmissions));
  const usedAdmissions = new Set(Object.values(restored.curatorAdmissions).filter((admission) => admission.usage !== undefined).map((admission) => admission.admissionId));
  return { admissions, usedAdmissions, ...restored.curatorAccounting };
}
function updateCitation(candidate: DurableKnowledgeCandidate): readonly import("./proposals").KnowledgeUpdateCitation[] {
  return Object.freeze(candidate.citations.map((citation) => Object.freeze({
    candidateId: candidate.candidateId,
    eventId: citation.eventId,
    eventHash: citation.eventHash,
    payloadHash: citation.payloadHash,
    sourceHashes: candidate.sourceHashes,
  })));
}
function targetDeclaration(snapshot: KnowledgeCuratorProcessorOptions["snapshot"], target: KnowledgeJobTarget) {
  const raw = snapshot.payload.knowledge.find((entry) => entry.id === target.bundleId);
  if (!raw || raw.provider !== target.providerId || raw.path !== target.path || raw.updates !== target.policy) throw new Error("Knowledge curator target diverges from the immutable snapshot");
  return Object.freeze({ id: target.bundleId, providerId: target.providerId, path: target.path, ...(typeof raw.owner === "string" ? { ownerAgentId: raw.owner } : {}), updatePolicy: target.policy });
}

export class KnowledgeCuratorProcessor {
  readonly options: KnowledgeCuratorProcessorOptions;
  private readonly providers: KnowledgeProviderRegistry;
  constructor(options: KnowledgeCuratorProcessorOptions) { this.options = options; this.providers = options.providers ?? createBuiltInKnowledgeProviderRegistry(); }

  private append(job: DurableKnowledgeJob, operation: string, payload: Record<string, JsonValue>): void {
    const expected = { formatVersion: 1, operation, jobId: job.jobId, ownerNonce: job.activeOwnerNonce!, ...payload } as Record<string, unknown>;
    const sameEffect = (events: readonly import("../workflows/events").WorkflowEventEnvelope[]): boolean => {
      restoreKnowledgeEnrichmentState(events, { recoverActive: false });
      const candidate = events.find((event) => event.type === "knowledge.transition" && record(event.payload) && event.payload.operation === operation
        && event.payload.jobId === job.jobId && (payload.bundleId === undefined || event.payload.bundleId === payload.bundleId)
        && (payload.updateId === undefined || event.payload.updateId === payload.updateId));
      if (!candidate || !record(candidate.payload)) return false;
      const { ownerNonce: _priorOwner, ...prior } = candidate.payload;
      const { ownerNonce: _currentOwner, ...wanted } = expected;
      if (canonicalJson(prior) !== canonicalJson(wanted)) throw new Error("Knowledge curator effect replay conflicts with its exact durable plan");
      return true;
    };
    if (sameEffect(readWorkflowJournal(this.options.projectRoot, this.options.sessionId))) return;
    try {
      appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
        projectId: this.options.projectId, sessionId: this.options.sessionId, runId: job.runId,
        type: "knowledge.transition", producer: "harness", correlationId: `curator-${job.jobId}`,
        payload: expected as JsonValue, timestamp: this.options.now?.(),
      }), (events) => {
        if (sameEffect(events)) throw new Error("Knowledge curator effect is already durable");
        const current = restoreKnowledgeEnrichmentState(events, { recoverActive: false }).jobs[job.jobId];
        if (!current || current.state !== "active" || current.activeOwnerNonce !== job.activeOwnerNonce) throw new Error("Knowledge curator event requires the exact active durable job");
      });
    } catch (error) {
      if (!sameEffect(readWorkflowJournal(this.options.projectRoot, this.options.sessionId))) throw error;
    }
  }

  private denyModelIfIneligible(job: DurableKnowledgeJob, evaluation: 0 | 1): void {
    const before = restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), { recoverActive: false });
    const currentJob = before.jobs[job.jobId];
    if (!currentJob || currentJob.state !== "active" || currentJob.activeOwnerNonce !== job.activeOwnerNonce || currentJob.staleReevaluations !== evaluation) throw new Error("Curator model eligibility requires the exact current owned evaluation");
    const prior = before.curatorBudgetDenials[job.jobId];
    if (prior) throw new Error(prior.reason);
    const reason = deriveCuratorBudgetDenialReason(before, job.jobId);
    if (!reason) return;
    const denialId = `curator-denial-${createHash("sha256").update(`pi-hive-curator-budget-denial-v1\0${job.jobId}\0${job.attemptCount}\0${evaluation}\0${reason}`).digest("hex").slice(0, 40)}`;
    appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness", correlationId: denialId,
      payload: { formatVersion: 1, operation: "curator-model-denied", jobId: job.jobId, ownerNonce: job.activeOwnerNonce!, denialId, evaluation, reason } as unknown as JsonValue,
      timestamp: this.options.now?.(),
    }), (events) => {
      const current = restoreKnowledgeEnrichmentState(events, { recoverActive: false });
      if (current.jobs[job.jobId]?.state !== "active" || current.jobs[job.jobId]?.activeOwnerNonce !== job.activeOwnerNonce
        || current.jobs[job.jobId]?.staleReevaluations !== evaluation || deriveCuratorBudgetDenialReason(current, job.jobId) !== reason
        || current.curatorBudgetDenials[job.jobId]) throw new Error("Curator model denial lost its exact durable budget CAS");
    });
    throw new Error(reason);
  }

  private admitModel(job: DurableKnowledgeJob, evaluation: 0 | 1): string {
    this.denyModelIfIneligible(job, evaluation);
    const admissionId = `curator-${createHash("sha256").update(`pi-hive-curator-admission-v1\0${job.jobId}\0${job.attemptCount}\0${evaluation}`).digest("hex").slice(0, 48)}`;
    const limits = Object.freeze({
      maxSessionInputTokens: CURATOR_EXECUTION_POLICY.maxSessionInputTokens,
      maxSessionOutputTokens: CURATOR_EXECUTION_POLICY.maxSessionOutputTokens,
      maxSessionCostMicroUsd: CURATOR_EXECUTION_POLICY.maxSessionCostMicroUsd,
      maxSessionModelCalls: CURATOR_EXECUTION_POLICY.maxSessionModelCalls,
    });
    appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness", correlationId: admissionId,
      payload: { formatVersion: 1, operation: "curator-model-admitted", jobId: job.jobId, ownerNonce: job.activeOwnerNonce!, admissionId, evaluation,
        reservedInputTokens: CURATOR_EXECUTION_POLICY.maxInputTokens, reservedOutputTokens: CURATOR_EXECUTION_POLICY.maxOutputTokens,
        reservedCostMicroUsd: CURATOR_EXECUTION_POLICY.reservedCostMicroUsdPerCall, limits } as unknown as JsonValue,
      timestamp: this.options.now?.(),
    }), (events) => {
      const state = restoreKnowledgeEnrichmentState(events, { recoverActive: false });
      const current = state.jobs[job.jobId];
      if (!current || current.state !== "active" || current.activeOwnerNonce !== job.activeOwnerNonce || current.staleReevaluations !== evaluation
        || state.curatorAdmissions[admissionId] || deriveCuratorBudgetDenialReason(state, job.jobId) !== undefined) throw new Error("Curator model admission requires the exact eligible current owned evaluation");
    });
    return admissionId;
  }

  private recordModelUsage(job: DurableKnowledgeJob, admissionId: string, usage: KnowledgeCuratorModelUsage): void {
    appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness", correlationId: admissionId,
      payload: { formatVersion: 1, operation: "curator-model-usage", jobId: job.jobId, ownerNonce: job.activeOwnerNonce!, admissionId, usage } as unknown as JsonValue, timestamp: this.options.now?.(),
    }), (events) => {
      const accounting = curatorAccounting(events, this.options.projectId, this.options.sessionId);
      if (!accounting.admissions.has(admissionId) || accounting.usedAdmissions.has(admissionId)) throw new Error("Curator model usage lost its exact admission CAS");
    });
    if (usage.inputTokens > CURATOR_EXECUTION_POLICY.maxInputTokens || usage.outputTokens > CURATOR_EXECUTION_POLICY.maxOutputTokens) throw new Error("Curator provider usage exceeded the admitted per-call token limit");
    const charged = curatorAccounting(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), this.options.projectId, this.options.sessionId);
    if (charged.reservedInputTokens > CURATOR_EXECUTION_POLICY.maxSessionInputTokens || charged.reservedOutputTokens > CURATOR_EXECUTION_POLICY.maxSessionOutputTokens
      || charged.reservedCostMicroUsd > CURATOR_EXECUTION_POLICY.maxSessionCostMicroUsd) throw new Error("Curator provider usage exceeded the durable session token/cost budget");
  }

  private reloadTargets(targets: readonly KnowledgeJobTarget[]): readonly KnowledgeJobTarget[] {
    return Object.freeze(targets.map((target) => {
      const declaration = targetDeclaration(this.options.snapshot, target);
      const loaded = this.providers.load({ projectRoot: this.options.projectRoot, declaration });
      if (!loaded.ok || !loaded.bundle) throw new Error(`Knowledge curator target ${target.bundleId} failed provider validation`);
      return Object.freeze({ ...target, expectedContentHash: `sha256:${loaded.bundle.contentHash}` });
    }));
  }

  private targetsAreCurrent(targets: readonly KnowledgeJobTarget[]): Readonly<{ current: readonly KnowledgeJobTarget[]; exact: boolean }> {
    const current = this.reloadTargets(targets);
    const expected = new Map(targets.map((target) => [target.bundleId, target.expectedContentHash]));
    return Object.freeze({ current, exact: current.length === targets.length && current.every((target) => expected.get(target.bundleId) === target.expectedContentHash) });
  }

  private promptTargets(targets: readonly KnowledgeJobTarget[]) {
    return boundCuratorTargetContext(targets.map((target) => {
      const declaration = targetDeclaration(this.options.snapshot, target);
      const loaded = this.providers.load({ projectRoot: this.options.projectRoot, declaration });
      if (!loaded.ok || !loaded.bundle) throw new Error(`Knowledge curator target ${target.bundleId} failed provider validation`);
      return Object.freeze({
        bundleId: target.bundleId, policy: target.policy, expectedContentHash: target.expectedContentHash,
        currentSummary: loaded.bundle.summary, documentCount: loaded.bundle.documents.length,
      });
    }));
  }

  private update(job: DurableKnowledgeJob, target: KnowledgeJobTarget, output: CuratorOutput, candidates: readonly DurableKnowledgeCandidate[], evaluation: 0 | 1): DurableKnowledgeUpdate {
    const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
    const conclusions = output.conclusions.map((conclusion) => {
      const citations = Object.freeze(conclusion.citationIds.flatMap((id) => updateCitation(byId.get(id)!))
        .sort((left, right) => compare(left.candidateId, right.candidateId) || compare(left.eventId, right.eventId)));
      if (citations.length > KNOWLEDGE_PROPOSAL_LIMITS.citationsPerConclusion) throw new Error("Curator conclusion citations exceed the post-expansion bound");
      return Object.freeze({ text: conclusion.text, citations });
    });
    const updateId = `ku-${createHash("sha256").update(`${job.jobId}\0${target.bundleId}\0${target.expectedContentHash}\0${output.outputHash}\0${evaluation}`).digest("hex").slice(0, 48)}`;
    const update = Object.freeze({
      formatVersion: 1 as const, updateId, jobId: job.jobId, projectId: job.projectId, sessionId: job.sessionId, runId: job.runId,
      bundleId: target.bundleId, providerId: target.providerId, expectedContentHash: target.expectedContentHash,
      curatorOutputHash: output.outputHash, conclusions: Object.freeze(conclusions), createdAt: this.options.now?.() ?? new Date().toISOString(),
    });
    if (Buffer.byteLength(canonicalJson(update), "utf8") > KNOWLEDGE_PROPOSAL_LIMITS.updateBytes) throw new Error("Curator update exceeds its post-expansion serialized byte bound");
    return update;
  }

  private sameTargets(left: readonly KnowledgeJobTarget[], right: readonly KnowledgeJobTarget[]): boolean {
    return canonicalJson(left) === canonicalJson(right);
  }

  private refreshTargetBase(job: DurableKnowledgeJob, fromTargets: readonly KnowledgeJobTarget[], targets: readonly KnowledgeJobTarget[], forceFallback = false, replacementPlan?: DurableCuratorPlan): void {
    if (this.sameTargets(fromTargets, targets) && !forceFallback) return;
    appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: job.runId,
      type: "knowledge.transition", producer: "harness", correlationId: `curator-${job.jobId}`,
      payload: { formatVersion: 1, operation: "job-target-base-refreshed", jobId: job.jobId, ownerNonce: job.activeOwnerNonce, fromTargets, targets,
        ...(replacementPlan ? { replacementPlan } : {}) } as unknown as JsonValue,
      timestamp: this.options.now?.(),
    }), (events) => {
      const current = restoreKnowledgeEnrichmentState(events, { recoverActive: false }).jobs[job.jobId];
      if (!current || current.state !== "active" || current.activeOwnerNonce !== job.activeOwnerNonce || current.staleReevaluations !== CURATOR_EXECUTION_POLICY.maxStaleReevaluations
        || !this.sameTargets(current.targets, fromTargets) || (current.staleFallbackRequired === true && this.sameTargets(fromTargets, targets))) throw new Error("Knowledge target-base refresh lost its exact owned durable CAS");
    });
  }

  private markStaleReload(job: DurableKnowledgeJob, from: number, targets: readonly KnowledgeJobTarget[]): void {
    appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: job.runId,
      type: "knowledge.transition", producer: "harness", correlationId: `curator-${job.jobId}`,
      payload: { formatVersion: 1, operation: "job-stale-reloaded", jobId: job.jobId, from, to: from + 1, ownerNonce: job.activeOwnerNonce, targets } as unknown as JsonValue,
      timestamp: this.options.now?.(),
    }), (events) => {
      const current = restoreKnowledgeEnrichmentState(events, { recoverActive: false }).jobs[job.jobId];
      if (!current || current.state !== "active" || current.activeOwnerNonce !== job.activeOwnerNonce || current.staleReevaluations !== from) throw new Error("Knowledge stale reload lost its exact durable CAS");
    });
  }

  private invalidateStalePlan(job: DurableKnowledgeJob, plan: DurableCuratorPlan, targets: readonly KnowledgeJobTarget[], candidates: readonly DurableKnowledgeCandidate[]): DurableKnowledgeJob {
    const replacementPlan = plan.evaluation === 1 ? this.buildPlan(job, targets, plan.output, candidates, 1, true) : undefined;
    appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: job.runId,
      type: "knowledge.transition", producer: "harness", correlationId: `curator-plan-invalidate-${job.jobId}`,
      payload: { formatVersion: 1, operation: "curator-plan-invalidated", jobId: job.jobId, ownerNonce: job.activeOwnerNonce!, planId: plan.planId,
        fromTargets: plan.targets, targets, reason: "stale-unexecuted-automatic-plan", ...(replacementPlan ? { replacementPlan } : {}) } as unknown as JsonValue,
      timestamp: this.options.now?.(),
    }), (events) => {
      const state = restoreKnowledgeEnrichmentState(events, { recoverActive: false });
      const current = state.jobs[job.jobId];
      if (!current || current.state !== "active" || current.activeOwnerNonce !== job.activeOwnerNonce || state.curatorPlans[job.jobId]?.planId !== plan.planId
        || current.staleReevaluations !== plan.evaluation || this.sameTargets(plan.targets, targets)) throw new Error("Curator stale plan invalidation lost its exact owner and plan CAS");
    });
    const restored = restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), { recoverActive: false });
    const current = restored.jobs[job.jobId];
    if (!current || current.staleReevaluations !== 1 || current.staleFallbackRequired !== true
      || (plan.evaluation === 1 && !restored.curatorPlans[job.jobId])) throw new Error("Curator stale plan invalidation and fallback were not durable");
    if (replacementPlan) this.options.fault?.("after-invalidation-fallback");
    return current;
  }

  private buildPlan(job: DurableKnowledgeJob, targets: readonly KnowledgeJobTarget[], output: CuratorOutput, candidates: readonly DurableKnowledgeCandidate[], evaluation: 0 | 1, fallbackRequired: boolean): DurableCuratorPlan {
    const ordered = [...targets].sort((left, right) => compare(left.bundleId, right.bundleId));
    const multiTargetConsistency = targets.length > 1 && targets.some((target) => target.policy === "automatic");
    const actions: DurableCuratorPlanAction[] = ordered.map((target) => {
      if (target.policy === "read-only") return Object.freeze({ kind: "skip" as const, bundleId: target.bundleId, policy: target.policy, reason: "read-only-policy" as const });
      if (!output.conclusions.length) return Object.freeze({ kind: "skip" as const, bundleId: target.bundleId, policy: target.policy, reason: "no-stable-conclusions" as const });
      const update = this.update(job, target, output, candidates, evaluation);
      if (fallbackRequired) return Object.freeze({ kind: "proposal" as const, bundleId: target.bundleId, reason: "stale-after-one-reevaluation" as const, update });
      if (multiTargetConsistency) return Object.freeze({ kind: "proposal" as const, bundleId: target.bundleId, reason: "multi-target-consistency" as const, update });
      if (target.policy === "reviewed") return Object.freeze({ kind: "proposal" as const, bundleId: target.bundleId, reason: "reviewed-policy" as const, update });
      return Object.freeze({ kind: "automatic" as const, bundleId: target.bundleId, update });
    });
    return createCuratorPlan({ jobId: job.jobId, evaluation, targets: Object.freeze([...targets]), output, actions: Object.freeze(actions), createdAt: this.options.now?.() ?? new Date().toISOString() });
  }

  private recordPlan(job: DurableKnowledgeJob, plan: DurableCuratorPlan): DurableCuratorPlan {
    appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness",
      correlationId: `curator-plan-${job.jobId}`, payload: { formatVersion: 1, operation: "curator-plan-recorded", jobId: job.jobId, ownerNonce: job.activeOwnerNonce!, plan } as unknown as JsonValue,
      timestamp: plan.createdAt,
    }), (events) => {
      const state = restoreKnowledgeEnrichmentState(events, { recoverActive: false });
      const current = state.jobs[job.jobId];
      if (state.curatorPlans[job.jobId] || !current || current.state !== "active" || current.activeOwnerNonce !== job.activeOwnerNonce) throw new Error("Curator plan publication lost its exact active owner CAS");
    });
    return restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), { recoverActive: false }).curatorPlans[job.jobId];
  }

  private async executePlan(job: DurableKnowledgeJob, plan: DurableCuratorPlan, signal: AbortSignal): Promise<void> {
    for (const action of plan.actions) {
      if (signal.aborted) throw signal.reason;
      if (action.kind === "skip") {
        this.append(job, "target-skipped", { bundleId: action.bundleId, policy: action.policy, reason: action.reason, curatorOutputHash: plan.output.outputHash });
        continue;
      }
      if (action.kind === "proposal") {
        const proposal = this.options.proposals.create(action.update);
        if (action.reason === "stale-after-one-reevaluation") this.append(job, "stale-reviewed-fallback", { updateId: action.update.updateId, bundleId: action.bundleId, proposalId: proposal.proposalId, reason: action.reason });
        continue;
      }
      await this.options.mutator.apply(action.update);
      const result = this.options.mutator.authoritativeResult(action.update);
      if (!result) throw new Error("Automatic curator audit lacks its authoritative durable mutation commit");
      this.append(job, "update-applied", { updateId: action.update.updateId, bundleId: action.bundleId, expectedContentHash: action.update.expectedContentHash, curatorOutputHash: plan.output.outputHash, result: result as unknown as JsonValue });
    }
  }

  async process(initialJob: DurableKnowledgeJob, signal: AbortSignal): Promise<void> {
    const state = restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), { recoverActive: false });
    let current = state.jobs[initialJob.jobId];
    if (!current || current.state !== "active") throw new Error("Knowledge curator requires the exact active queue job");
    const candidates = current.candidateIds.map((candidateId) => state.candidates[candidateId]);
    if (candidates.some((candidate) => !candidate || candidate.runId !== current.runId)) throw new Error("Knowledge curator job references missing or foreign durable candidates");
    const candidateViews = candidates.map((candidate) => Object.freeze({ candidateId: candidate.candidateId, conclusion: candidate.conclusion, citations: candidate.citations, sourceHashes: candidate.sourceHashes }));
    const recoveredPlan = state.curatorPlans[current.jobId];
    if (recoveredPlan) {
      const automaticActions = recoveredPlan.actions.filter((action): action is Extract<DurableCuratorPlanAction, { kind: "automatic" }> => action.kind === "automatic");
      if (!automaticActions.length || automaticActions.every((action) => this.options.mutator.authoritativeResult(action.update) !== undefined)) {
        await this.executePlan(current, recoveredPlan, signal);
        return;
      }
      try {
        await this.executePlan(current, recoveredPlan, signal);
        return;
      } catch (error) {
        if (!(error instanceof KnowledgeMutationError) || error.code !== "STALE_HASH") throw error;
      }
      const preflight = this.targetsAreCurrent(recoveredPlan.targets);
      if (preflight.exact) throw new KnowledgeMutationError("STALE_HASH", "Recovered automatic plan failed its exact mutation reconciliation without observable target drift");
      current = this.invalidateStalePlan(current, recoveredPlan, preflight.current, candidates);
      if (recoveredPlan.evaluation === 1) {
        const fallback = restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), { recoverActive: false }).curatorPlans[current.jobId];
        if (!fallback) throw new Error("Atomic stale invalidation lost its reviewed fallback plan");
        await this.executePlan(current, fallback, signal);
        return;
      }
    }
    let evaluation: 0 | 1 = current.staleReevaluations > 0 ? 1 : 0;
    let targets = current.targets;
    let fallbackRequired = current.staleFallbackRequired === true;
    if (evaluation === 1) {
      const refreshed = this.reloadTargets(targets);
      if (!this.sameTargets(targets, refreshed)) {
        this.refreshTargetBase(current, targets, refreshed);
        targets = refreshed;
        fallbackRequired = true;
      }
    }
    if (targets.every((target) => target.policy === "read-only")) {
      const output = parseCuratorOutput(JSON.stringify({ formatVersion: 1, conclusions: [] }), candidateViews);
      await this.executePlan(current, this.recordPlan(current, this.buildPlan(current, targets, output, candidates, evaluation, fallbackRequired)), signal);
      return;
    }
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const prompt = buildCuratorPrompt({ jobId: current.jobId, scope: current.scope, targets: this.promptTargets(targets), candidates: candidateViews });
      const admissionId = this.admitModel(current, evaluation);
      const response = modelResult(await this.options.runModel({
        jobId: current.jobId, modelId: current.model.modelId, thinking: current.model.thinking, prompt,
        maxInputTokens: CURATOR_EXECUTION_POLICY.maxInputTokens, maxOutputTokens: CURATOR_EXECUTION_POLICY.maxOutputTokens,
        timeoutMs: CURATOR_EXECUTION_POLICY.timeoutMs, evaluation, signal,
      }), prompt);
      if (signal.aborted) throw signal.reason;
      this.recordModelUsage(current, admissionId, response.usage);
      const output = parseCuratorOutput(response.output, candidateViews);
      const preflight = this.targetsAreCurrent(targets);
      if (!preflight.exact) {
        if (evaluation === 0 && current.staleReevaluations < CURATOR_EXECUTION_POLICY.maxStaleReevaluations) {
          this.markStaleReload(current, 0, preflight.current);
          evaluation = 1;
          targets = preflight.current;
          continue;
        }
        const replacementPlan = this.buildPlan(current, preflight.current, output, candidates, evaluation, true);
        this.refreshTargetBase(current, targets, preflight.current, false, replacementPlan);
        this.options.fault?.("after-base-refresh-fallback");
        const durableReplacement = restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), { recoverActive: false }).curatorPlans[current.jobId];
        if (!durableReplacement) throw new Error("Atomic target-base refresh lost its reviewed fallback plan");
        await this.executePlan(current, durableReplacement, signal);
        return;
      }
      const plan = this.recordPlan(current, this.buildPlan(current, targets, output, candidates, evaluation, fallbackRequired));
      try {
        await this.executePlan(current, plan, signal);
        return;
      } catch (error) {
        if (!(error instanceof KnowledgeMutationError) || error.code !== "STALE_HASH" || !plan.actions.some((action) => action.kind === "automatic")) throw error;
        const fresh = this.targetsAreCurrent(plan.targets);
        if (fresh.exact) throw error;
        current = this.invalidateStalePlan(current, plan, fresh.current, candidates);
        evaluation = 1;
        targets = current.targets;
        fallbackRequired = true;
        if (plan.evaluation === 1) {
          const fallback = restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), { recoverActive: false }).curatorPlans[current.jobId];
          if (!fallback) throw new Error("Atomic stale invalidation lost its reviewed fallback plan");
          await this.executePlan(current, fallback, signal);
          return;
        }
      }
    }
  }
}
