import { createHash, randomUUID } from "node:crypto";
import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";
import { hashAttemptInput } from "../workflows/attempts";
import { createWorkflowEvent, type WorkflowEventEnvelope } from "../workflows/events";
import { appendWorkflowEventChecked, readWorkflowJournal } from "../workflows/journal";
import { createBuiltInKnowledgeProviderRegistry, type KnowledgeProviderRegistry } from "./provider";
import type { DurableKnowledgeUpdate } from "./proposals";
import type { CuratorOutput } from "./curator";
import { KNOWLEDGE_CURATOR_INPUT_BYTES, KNOWLEDGE_CURATOR_OUTPUT_TOKENS, boundCuratorTargetContext, buildCuratorPrompt, curatorFitsSnapshotModelContext, type CuratorCandidateView, type CuratorTargetContextInput } from "./curator-contract";
import type { KnowledgeUpdatePolicy } from "./types";

export const KNOWLEDGE_ENRICHMENT_FORMAT_VERSION = 1 as const;
export const KNOWLEDGE_ENRICHMENT_LIMITS = Object.freeze({
  candidatesPerRun: 512,
  candidatesPerJob: 512,
  candidateBytes: 8_192,
  conclusionBytes: 4_096,
  evidenceRefs: 32,
  sourceHashes: 128,
  jobsPerRun: 513,
  targetsPerJob: 128,
  curatorPromptBytesPerJob: KNOWLEDGE_CURATOR_INPUT_BYTES,
  serializedTargetsBytesPerJob: 20_000,
  skippedIdsPerAuditEvent: 128,
  skipAuditBytes: 65_536,
  curatorPlanBytes: 250_000,
});

export const CURATOR_EXECUTION_POLICY = Object.freeze({
  modelSelection: "agent-lowest-participating-node;shared-workflow-root" as const,
  maxInputTokens: KNOWLEDGE_CURATOR_INPUT_BYTES,
  maxOutputTokens: KNOWLEDGE_CURATOR_OUTPUT_TOKENS,
  timeoutMs: 120_000,
  maxModelAttempts: 2,
  maxStaleReevaluations: 1,
  maxSessionInputTokens: 4_194_304,
  maxSessionOutputTokens: 1_048_576,
  maxSessionCostMicroUsd: 10_000_000,
  maxSessionModelCalls: 128,
  reservedCostMicroUsdPerCall: 100_000,
  preemptSettleMs: 2_000,
  disposeSettleMs: 1_000,
  concurrency: 1,
  priority: "idle-low" as const,
});

export type KnowledgeCandidateScope = "agent" | "shared";
export type KnowledgeJobState = "queued" | "active" | "paused" | "completed" | "failed";
export interface KnowledgeEvidenceCitation {
  readonly eventId: string;
  readonly eventHash: string;
  readonly payloadHash: string;
  readonly sequence: number;
  readonly type: WorkflowEventEnvelope["type"];
}
export interface DurableKnowledgeCandidate {
  readonly formatVersion: 1;
  readonly candidateId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly agentId: string;
  readonly scope: KnowledgeCandidateScope;
  readonly conclusion: string;
  readonly requestHash: string;
  readonly citations: readonly KnowledgeEvidenceCitation[];
  readonly sourceHashes: readonly string[];
  readonly createdAt: string;
}
export interface KnowledgeJobTarget {
  readonly bundleId: string;
  readonly providerId: string;
  readonly path: string;
  readonly policy: KnowledgeUpdatePolicy;
  readonly expectedContentHash: string;
}
export interface KnowledgeCuratorModelSelection {
  readonly nodeId: string;
  readonly modelId: string;
  readonly thinking: string;
  readonly reason: typeof CURATOR_EXECUTION_POLICY.modelSelection;
}
export interface DurableKnowledgeJob {
  readonly formatVersion: 1;
  readonly jobId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly terminalEventHash: string;
  readonly scope: KnowledgeCandidateScope;
  readonly agentId?: string;
  readonly candidateIds: readonly string[];
  readonly targets: readonly KnowledgeJobTarget[];
  readonly model: KnowledgeCuratorModelSelection;
  readonly state: KnowledgeJobState;
  readonly attemptCount: number;
  readonly staleReevaluations: number;
  readonly staleFallbackRequired?: true;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activeOwnerNonce?: string;
  readonly lastReason?: string;
}
export type DurableCuratorPlanAction =
  | Readonly<{ kind: "skip"; bundleId: string; policy: KnowledgeUpdatePolicy; reason: "read-only-policy" | "no-stable-conclusions" }>
  | Readonly<{ kind: "automatic"; bundleId: string; update: DurableKnowledgeUpdate }>
  | Readonly<{ kind: "proposal"; bundleId: string; reason: "reviewed-policy" | "multi-target-consistency" | "stale-after-one-reevaluation"; update: DurableKnowledgeUpdate }>;
export interface DurableCuratorPlan {
  readonly formatVersion: 1;
  readonly planId: string;
  readonly jobId: string;
  readonly evaluation: 0 | 1;
  readonly targets: readonly KnowledgeJobTarget[];
  readonly output: CuratorOutput;
  readonly actions: readonly DurableCuratorPlanAction[];
  readonly createdAt: string;
}
export interface DurableCuratorAdmission {
  readonly admissionId: string;
  readonly jobId: string;
  readonly ownerNonce: string;
  readonly evaluation: 0 | 1;
  readonly usage?: Readonly<{ inputTokens: number; outputTokens: number; costMicroUsd: number; precision: "estimated" | "provider-confirmed" }>;
}
export type CuratorBudgetDenialReason = "curator-per-job-model-budget-denied" | "curator-session-model-budget-denied";
export interface DurableCuratorBudgetDenial {
  readonly denialId: string;
  readonly jobId: string;
  readonly ownerNonce: string;
  readonly evaluation: 0 | 1;
  readonly reason: CuratorBudgetDenialReason;
}
export interface KnowledgeEnrichmentState {
  readonly candidates: Readonly<Record<string, DurableKnowledgeCandidate>>;
  readonly jobs: Readonly<Record<string, DurableKnowledgeJob>>;
  readonly curatorAdmissions: Readonly<Record<string, DurableCuratorAdmission>>;
  readonly curatorBudgetDenials: Readonly<Record<string, DurableCuratorBudgetDenial>>;
  readonly curatorPlans: Readonly<Record<string, DurableCuratorPlan>>;
  readonly curatorPlanHistory: Readonly<Record<string, DurableCuratorPlan>>;
  readonly curatorEffects: Readonly<Record<string, true>>;
  readonly curatorPlanEffectsComplete: Readonly<Record<string, true>>;
  readonly curatorAccounting: Readonly<{ reservedInputTokens: number; reservedOutputTokens: number; reservedCostMicroUsd: number; modelCalls: number }>;
  readonly terminalEvents: Readonly<Record<string, readonly string[]>>;
  readonly terminalSkipped: Readonly<Record<string, number>>;
  readonly preserveCancelledRuns: Readonly<Record<string, true>>;
  readonly terminalEnqueueCompleted: Readonly<Record<string, true>>;
}
export interface KnowledgeProposalInput {
  readonly scope: KnowledgeCandidateScope;
  readonly conclusion: string;
  readonly evidenceEventIds: readonly string[];
}
export interface KnowledgeEnrichmentServiceOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly snapshot: ActivationSnapshotFileV1;
  readonly providers?: KnowledgeProviderRegistry;
  readonly now?: () => string;
  readonly createCandidateId?: () => string;
  readonly createJobId?: () => string;
  readonly fault?: (stage: "after-job" | "after-skip" | "before-completion") => void;
}

const EVIDENCE_EVENT_TYPES = new Set<WorkflowEventEnvelope["type"]>([
  "attempt.result.recorded", "attempt.reconciliation.recorded", "task.result.recorded",
  "change.mutation.recorded", "change.command.recorded", "artifact.recorded", "knowledge.transition",
]);
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}
function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function containsControl(value: string): boolean { for (const character of value) { const code = character.codePointAt(0)!; if (code <= 0x1f || code === 0x7f) return true; } return false; }
function boundedConclusion(value: unknown): string {
  if (typeof value !== "string") throw new Error("Knowledge conclusion is invalid");
  const normalized = value.normalize("NFC").trim();
  if (Buffer.byteLength(normalized, "utf8") < 8 || Buffer.byteLength(normalized, "utf8") > KNOWLEDGE_ENRICHMENT_LIMITS.conclusionBytes
    || containsControl(normalized)) throw new Error("Knowledge conclusion is empty, unsafe, or exceeds its bound");
  return normalized;
}
function participantNodeIds(value: unknown): readonly string[] {
  const ids = new Set<string>();
  const stack: unknown[] = [value];
  let nodes = 0;
  while (stack.length) {
    if (++nodes > 4_096) throw new Error("Knowledge evidence participant-scope traversal exceeds its bound");
    const current = stack.pop();
    if (Array.isArray(current)) stack.push(...current);
    else if (record(current)) for (const [key, child] of Object.entries(current)) {
      if (/(?:^|[A-Z])nodeId$/u.test(key) && typeof child === "string") ids.add(child);
      else stack.push(child);
    }
  }
  return Object.freeze([...ids].sort(compare));
}
function payloadHashes(value: unknown): readonly string[] {
  const hashes = new Set<string>();
  const stack: unknown[] = [value];
  let nodes = 0;
  while (stack.length) {
    if (++nodes > 4_096) throw new Error("Knowledge evidence source-hash traversal exceeds its bound");
    const current = stack.pop();
    if (typeof current === "string" && /^(?:sha256:)?[0-9a-f]{64}$/u.test(current)) {
      hashes.add(current.startsWith("sha256:") ? current : `sha256:${current}`);
      if (hashes.size > KNOWLEDGE_ENRICHMENT_LIMITS.sourceHashes) throw new Error("Knowledge evidence source hashes exceed their bound");
    } else if (Array.isArray(current)) stack.push(...current);
    else if (record(current)) stack.push(...Object.values(current));
  }
  return Object.freeze([...hashes].sort(compare));
}
function snapshotNode(snapshot: ActivationSnapshotFileV1, nodeId: string): { node: Record<string, unknown>; authority: Record<string, unknown>; effective: Record<string, unknown> } {
  const workflow = snapshot.payload.workflow as { team?: { nodes?: unknown[] } };
  const node = Array.isArray(workflow.team?.nodes) ? workflow.team.nodes.find((entry) => record(entry) && entry.id === nodeId) as Record<string, unknown> | undefined : undefined;
  const authority = snapshot.payload.authority.nodes.find((entry) => entry.nodeId === nodeId) as unknown;
  const effective = record(authority) && record(authority.capabilities) && record(authority.capabilities.effective) ? authority.capabilities.effective : undefined;
  if (!node || typeof node.agentId !== "string" || !record(authority) || !record(effective)) throw new Error("Knowledge node is absent from immutable authority");
  return { node, authority, effective };
}
function proposalNodeRecord(snapshot: ActivationSnapshotFileV1, nodeId: string): { agentId: string } {
  const { node, authority, effective } = snapshotNode(snapshot, nodeId);
  if (!Array.isArray(authority.tools) || !authority.tools.includes("knowledge_propose") || !Array.isArray(effective.knowledge) || !effective.knowledge.includes("propose")) throw new Error("Knowledge proposal node lacks immutable authority");
  return { agentId: node.agentId as string };
}
function curatorNodeRecord(snapshot: ActivationSnapshotFileV1, nodeId: string): { agentId: string; modelId: string; thinking: string } {
  const { node, authority, effective } = snapshotNode(snapshot, nodeId);
  if (!Array.isArray(effective.knowledge) || !effective.knowledge.includes("curate")) throw new Error("Knowledge curator capability is denied");
  if (typeof authority.model !== "string" || !authority.model || typeof authority.thinking !== "string" || !authority.thinking) throw new Error("Knowledge curator model selection is unavailable");
  const model = snapshot.payload.models.find((entry) => entry.nodeId === nodeId);
  if (!model || model.modelId !== authority.model || model.thinking !== authority.thinking || !curatorFitsSnapshotModelContext(model)) throw new Error("Knowledge curator fixed input/output and frozen static context do not fit the selected snapshot model");
  return { agentId: node.agentId as string, modelId: authority.model, thinking: authority.thinking };
}
function agentCuratorNodeId(snapshot: ActivationSnapshotFileV1, agentId: string): string {
  const workflow = snapshot.payload.workflow as { team?: { nodes?: unknown[] } };
  const candidates = (Array.isArray(workflow.team?.nodes) ? workflow.team.nodes : [])
    .filter((entry): entry is Record<string, unknown> => record(entry) && entry.agentId === agentId && typeof entry.id === "string")
    .filter((entry) => {
      const authority = snapshot.payload.authority.nodes.find((candidate) => candidate.nodeId === entry.id) as unknown;
      const effective = record(authority) && record(authority.capabilities) && record(authority.capabilities.effective) ? authority.capabilities.effective : undefined;
      return record(effective) && Array.isArray(effective.knowledge) && effective.knowledge.includes("curate");
    })
    .map((entry) => entry.id as string)
    .sort(compare);
  if (!candidates.length) throw new Error(`Catalog agent ${agentId} has no controlled curate-authorized workflow node`);
  return candidates[0];
}
function rawKnowledge(snapshot: ActivationSnapshotFileV1): Array<Record<string, unknown>> {
  return snapshot.payload.knowledge.filter(record);
}
function declaration(raw: Record<string, unknown>) {
  if (typeof raw.id !== "string" || typeof raw.provider !== "string" || typeof raw.path !== "string"
    || (raw.updates !== "automatic" && raw.updates !== "reviewed" && raw.updates !== "read-only")
    || (raw.owner !== undefined && typeof raw.owner !== "string")) throw new Error("Snapshot knowledge declaration is invalid");
  return Object.freeze({ id: raw.id, providerId: raw.provider, path: raw.path, ...(raw.owner ? { ownerAgentId: raw.owner as string } : {}), updatePolicy: raw.updates });
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}
function parseCuratorUsage(value: unknown): DurableCuratorAdmission["usage"] {
  if (!record(value) || !exact(value, ["inputTokens", "outputTokens", "costMicroUsd", "precision"])
    || !Number.isSafeInteger(value.inputTokens) || Number(value.inputTokens) < 0
    || !Number.isSafeInteger(value.outputTokens) || Number(value.outputTokens) < 0
    || !Number.isSafeInteger(value.costMicroUsd) || Number(value.costMicroUsd) < 0
    || (value.precision !== "estimated" && value.precision !== "provider-confirmed")) throw new Error("Curator model usage is invalid");
  return Object.freeze({ inputTokens: Number(value.inputTokens), outputTokens: Number(value.outputTokens), costMicroUsd: Number(value.costMicroUsd), precision: value.precision });
}
function parseJobTargets(value: unknown): readonly KnowledgeJobTarget[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > KNOWLEDGE_ENRICHMENT_LIMITS.targetsPerJob) throw new Error("Durable knowledge job target set is invalid");
  const targets = value.map((target) => {
    if (!record(target) || !exact(target, ["bundleId", "providerId", "path", "policy", "expectedContentHash"]) || typeof target.bundleId !== "string" || typeof target.providerId !== "string"
      || typeof target.path !== "string" || !target.path || target.path.startsWith("/") || target.path.includes("\\") || target.path.split("/").some((part) => !part || part === "." || part === "..")
      || (target.policy !== "automatic" && target.policy !== "reviewed" && target.policy !== "read-only") || typeof target.expectedContentHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(target.expectedContentHash)) throw new Error("Durable knowledge job target is invalid");
    boundedId(target.bundleId, "Knowledge target bundle ID");
    return Object.freeze({ bundleId: target.bundleId, providerId: target.providerId, path: target.path, policy: target.policy, expectedContentHash: target.expectedContentHash });
  });
  if (new Set(targets.map((target) => target.bundleId)).size !== targets.length) throw new Error("Durable knowledge job target identity is duplicated");
  return Object.freeze(targets);
}
type EnrichmentSkip = Readonly<{ scope: KnowledgeCandidateScope; agentId?: string; reason: "no-declared-target" | "target-limit" | "target-payload-byte-limit" | "curator-input-byte-limit" | "cancelled-not-preserved"; bundleIds: readonly string[]; candidateIds: readonly string[] }>;
function skipCorrelation(terminalEventHash: string, skip: EnrichmentSkip): string {
  return `enrichment-skip-${createHash("sha256").update(canonicalJson({ terminal: terminalEventHash, skip })).digest("hex").slice(0, 32)}`;
}
function chunkSkip(skip: EnrichmentSkip): readonly EnrichmentSkip[] {
  const chunks: EnrichmentSkip[] = [];
  const add = (bundleIds: readonly string[], candidateIds: readonly string[]): void => {
    const chunk = Object.freeze({ ...skip, bundleIds: Object.freeze([...bundleIds]), candidateIds: Object.freeze([...candidateIds]) });
    if (Buffer.byteLength(canonicalJson({ formatVersion: 1, operation: "enrichment-skipped", terminalEventHash: "f".repeat(64), ...chunk }), "utf8") > KNOWLEDGE_ENRICHMENT_LIMITS.skipAuditBytes) throw new Error("Knowledge enrichment skip audit exceeds its durable byte bound");
    chunks.push(chunk);
  };
  for (let offset = 0; offset < skip.bundleIds.length; offset += KNOWLEDGE_ENRICHMENT_LIMITS.skippedIdsPerAuditEvent) add(skip.bundleIds.slice(offset, offset + KNOWLEDGE_ENRICHMENT_LIMITS.skippedIdsPerAuditEvent), []);
  for (let offset = 0; offset < skip.candidateIds.length; offset += KNOWLEDGE_ENRICHMENT_LIMITS.skippedIdsPerAuditEvent) add([], skip.candidateIds.slice(offset, offset + KNOWLEDGE_ENRICHMENT_LIMITS.skippedIdsPerAuditEvent));
  if (!chunks.length) add([], []);
  return Object.freeze(chunks);
}
function serializedArrayBytes(values: readonly unknown[]): number {
  return Buffer.byteLength(canonicalJson(values), "utf8");
}
function candidateView(candidate: DurableKnowledgeCandidate): CuratorCandidateView {
  return Object.freeze({ candidateId: candidate.candidateId, conclusion: candidate.conclusion, citations: candidate.citations, sourceHashes: candidate.sourceHashes });
}
function parseCandidate(value: unknown): DurableKnowledgeCandidate {
  if (!record(value) || !exact(value, ["formatVersion", "candidateId", "projectId", "sessionId", "runId", "nodeId", "agentId", "scope", "conclusion", "requestHash", "citations", "sourceHashes", "createdAt"])
    || value.formatVersion !== 1 || (value.scope !== "agent" && value.scope !== "shared") || typeof value.requestHash !== "string" || !/^[0-9a-f]{64}$/u.test(value.requestHash)
    || !Number.isFinite(Date.parse(String(value.createdAt)))) throw new Error("Durable knowledge candidate schema is invalid");
  for (const [label, item] of [["candidate", value.candidateId], ["project", value.projectId], ["session", value.sessionId], ["run", value.runId], ["node", value.nodeId], ["agent", value.agentId]] as const) boundedId(item, `Knowledge ${label} ID`);
  boundedConclusion(value.conclusion);
  if (!Array.isArray(value.citations) || value.citations.length < 1 || value.citations.length > KNOWLEDGE_ENRICHMENT_LIMITS.evidenceRefs
    || !Array.isArray(value.sourceHashes) || value.sourceHashes.length < 1 || value.sourceHashes.length > KNOWLEDGE_ENRICHMENT_LIMITS.sourceHashes
    || value.sourceHashes.some((hash) => typeof hash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(hash))) throw new Error("Durable knowledge candidate provenance is invalid");
  for (const citation of value.citations) {
    if (!record(citation) || !exact(citation, ["eventId", "eventHash", "payloadHash", "sequence", "type"]) || !EVIDENCE_EVENT_TYPES.has(citation.type as WorkflowEventEnvelope["type"])
      || typeof citation.eventHash !== "string" || !/^[0-9a-f]{64}$/u.test(citation.eventHash) || typeof citation.payloadHash !== "string" || !/^[0-9a-f]{64}$/u.test(citation.payloadHash)
      || !Number.isSafeInteger(citation.sequence) || Number(citation.sequence) < 1) throw new Error("Durable knowledge candidate citation is invalid");
    boundedId(citation.eventId, "Knowledge citation event ID");
  }
  if (Buffer.byteLength(canonicalJson(value), "utf8") > KNOWLEDGE_ENRICHMENT_LIMITS.candidateBytes) throw new Error("Durable knowledge candidate exceeds its bound");
  return deepFreeze(structuredClone(value)) as unknown as DurableKnowledgeCandidate;
}
function parseJob(value: unknown): DurableKnowledgeJob {
  if (!record(value) || !exact(value, ["formatVersion", "jobId", "projectId", "sessionId", "runId", "terminalEventHash", "scope", "candidateIds", "targets", "model", "state", "attemptCount", "staleReevaluations", "createdAt", "updatedAt"], ["agentId", "activeOwnerNonce", "lastReason", "staleFallbackRequired"])
    || value.formatVersion !== 1 || (value.scope !== "agent" && value.scope !== "shared") || (value.state !== "queued" && value.state !== "active" && value.state !== "paused" && value.state !== "completed" && value.state !== "failed")
    || typeof value.terminalEventHash !== "string" || !/^[0-9a-f]{64}$/u.test(value.terminalEventHash) || !Number.isSafeInteger(value.attemptCount) || Number(value.attemptCount) < 0
    || !Number.isSafeInteger(value.staleReevaluations) || Number(value.staleReevaluations) < 0 || Number(value.staleReevaluations) > CURATOR_EXECUTION_POLICY.maxStaleReevaluations
    || (value.staleFallbackRequired !== undefined && value.staleFallbackRequired !== true) || (value.staleFallbackRequired === true && Number(value.staleReevaluations) !== CURATOR_EXECUTION_POLICY.maxStaleReevaluations)
    || !Number.isFinite(Date.parse(String(value.createdAt))) || !Number.isFinite(Date.parse(String(value.updatedAt)))) throw new Error("Durable knowledge job schema is invalid");
  for (const [label, item] of [["job", value.jobId], ["project", value.projectId], ["session", value.sessionId], ["run", value.runId]] as const) boundedId(item, `Knowledge ${label} ID`);
  if ((value.scope === "agent") !== (typeof value.agentId === "string") || (typeof value.agentId === "string" && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value.agentId))) throw new Error("Durable agent knowledge job owner is invalid");
  if (!Array.isArray(value.candidateIds) || value.candidateIds.length < 1 || value.candidateIds.length > KNOWLEDGE_ENRICHMENT_LIMITS.candidatesPerJob || new Set(value.candidateIds).size !== value.candidateIds.length) throw new Error("Durable knowledge job candidate set is invalid");
  for (const id of value.candidateIds) boundedId(id, "Knowledge job candidate ID");
  parseJobTargets(value.targets);
  if (!record(value.model) || !exact(value.model, ["nodeId", "modelId", "thinking", "reason"]) || value.model.reason !== CURATOR_EXECUTION_POLICY.modelSelection
    || typeof value.model.modelId !== "string" || !value.model.modelId || typeof value.model.thinking !== "string" || !value.model.thinking) throw new Error("Durable knowledge job curator model is invalid");
  boundedId(value.model.nodeId, "Knowledge curator node ID");
  if ((value.state === "active") !== (typeof value.activeOwnerNonce === "string") || (value.activeOwnerNonce !== undefined && boundedId(value.activeOwnerNonce, "Knowledge active owner nonce") !== value.activeOwnerNonce)) throw new Error("Durable knowledge job active owner identity is invalid");
  if (value.lastReason !== undefined && (typeof value.lastReason !== "string" || Buffer.byteLength(value.lastReason, "utf8") > 2_048)) throw new Error("Durable knowledge job reason is invalid");
  return deepFreeze(structuredClone(value)) as unknown as DurableKnowledgeJob;
}

function curatorPlanIdentity(value: Omit<DurableCuratorPlan, "formatVersion" | "planId" | "createdAt">): string {
  return `cp-${createHash("sha256").update("pi-hive-curator-plan-v1\0").update(canonicalJson(value)).digest("hex").slice(0, 48)}`;
}
export function createCuratorPlan(input: Omit<DurableCuratorPlan, "formatVersion" | "planId">): DurableCuratorPlan {
  const identity = { jobId: input.jobId, evaluation: input.evaluation, targets: input.targets, output: input.output, actions: input.actions };
  return deepFreeze({ formatVersion: 1, planId: curatorPlanIdentity(identity), ...input });
}
function stableKnowledgeUpdateHash(update: DurableKnowledgeUpdate): string {
  const { createdAt: _createdAt, ...identity } = update;
  return `sha256:${createHash("sha256").update("pi-hive-knowledge-update-identity-v1\0").update(canonicalJson(identity)).digest("hex")}`;
}
function validMutationStagingIdentity(value: unknown): boolean {
  return record(value) && exact(value, ["device", "inode", "size"]) && typeof value.device === "string" && /^[0-9]+$/u.test(value.device)
    && typeof value.inode === "string" && /^[0-9]+$/u.test(value.inode) && Number.isSafeInteger(value.size) && Number(value.size) >= 0 && Number(value.size) <= 262_144;
}
function validMutationRollback(value: unknown): boolean {
  return record(value) && (value.existed === false
    ? exact(value, ["existed"])
    : value.existed === true && exact(value, ["existed", "path", "contentHash", "identity"]) && typeof value.path === "string" && value.path.endsWith("/rollback.md")
      && typeof value.contentHash === "string" && /^sha256:[0-9a-f]{64}$/u.test(value.contentHash) && validMutationStagingIdentity(value.identity));
}
function exactPriorMutationCommit(events: readonly WorkflowEventEnvelope[], beforeSequence: number, update: DurableKnowledgeUpdate, expectedResult: Record<string, unknown>): boolean {
  const mutations = events.filter((event) => event.sequence < beforeSequence && event.type === "knowledge.transition" && record(event.payload)
    && event.payload.updateId === update.updateId && typeof event.payload.operation === "string" && event.payload.operation.startsWith("mutation-"));
  if (mutations.length !== 4 || mutations.some((event) => event.producer !== "harness" || event.projectId !== update.projectId || event.sessionId !== update.sessionId || event.runId !== update.runId || event.correlationId !== update.updateId)) return false;
  const [intent, staged, validated, committed] = mutations.map((event) => event.payload as Record<string, unknown>);
  if (!exact(intent, ["formatVersion", "operation", "updateId", "updateIdentityHash", "bundleId", "targetPath", "renderedHash", "expectedContentHash", "baseBundleHash", "expectedPublishedBundleHash", "expectedResult", "rollback"])
    || intent.formatVersion !== 1 || intent.operation !== "mutation-intent" || intent.updateIdentityHash !== stableKnowledgeUpdateHash(update) || intent.bundleId !== update.bundleId
    || intent.expectedContentHash !== update.expectedContentHash || intent.baseBundleHash !== update.expectedContentHash || typeof intent.targetPath !== "string"
    || typeof intent.renderedHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(intent.renderedHash)
    || typeof intent.expectedPublishedBundleHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(intent.expectedPublishedBundleHash) || !record(intent.expectedResult)
    || !exact(intent.expectedResult, ["updateId", "bundleId", "changed", "contentHash", "documentId", "conclusionCount"])
    || intent.expectedResult.updateId !== update.updateId || intent.expectedResult.bundleId !== update.bundleId || intent.expectedResult.changed !== true
    || intent.expectedResult.contentHash !== intent.expectedPublishedBundleHash || intent.expectedResult.documentId !== "curated"
    || !Number.isSafeInteger(intent.expectedResult.conclusionCount) || Number(intent.expectedResult.conclusionCount) < 1
    || Number(intent.expectedResult.conclusionCount) > 64 || !validMutationRollback(intent.rollback)) return false;
  if (!exact(staged, ["formatVersion", "operation", "updateId", "renderedHash", "stagingPath", "stagingIdentity"])
    || staged.formatVersion !== 1 || staged.operation !== "mutation-staged" || staged.renderedHash !== intent.renderedHash || typeof staged.stagingPath !== "string" || !validMutationStagingIdentity(staged.stagingIdentity)) return false;
  if (!exact(validated, ["formatVersion", "operation", "updateId", "renderedHash", "stagingIdentity"])
    || validated.formatVersion !== 1 || validated.operation !== "mutation-validated" || validated.renderedHash !== intent.renderedHash
    || canonicalJson(validated.stagingIdentity) !== canonicalJson(staged.stagingIdentity)) return false;
  return exact(committed, ["formatVersion", "operation", "updateId", "renderedHash", "result"])
    && committed.formatVersion === 1 && committed.operation === "mutation-committed" && committed.renderedHash === intent.renderedHash
    && canonicalJson(committed.result) === canonicalJson(intent.expectedResult) && canonicalJson(expectedResult) === canonicalJson(intent.expectedResult);
}
function parseCuratorPlan(value: unknown, job: DurableKnowledgeJob, candidates: Readonly<Record<string, DurableKnowledgeCandidate>>): DurableCuratorPlan {
  if (!record(value) || !exact(value, ["formatVersion", "planId", "jobId", "evaluation", "targets", "output", "actions", "createdAt"]) || value.formatVersion !== 1
    || value.jobId !== job.jobId || (value.evaluation !== 0 && value.evaluation !== 1) || value.evaluation !== job.staleReevaluations
    || !Number.isFinite(Date.parse(String(value.createdAt))) || !Array.isArray(value.actions) || value.actions.length !== job.targets.length
    || Buffer.byteLength(canonicalJson(value), "utf8") > KNOWLEDGE_ENRICHMENT_LIMITS.curatorPlanBytes) throw new Error("Curator plan schema, bound, or job identity is invalid");
  const targets = parseJobTargets(value.targets);
  if (canonicalJson(targets) !== canonicalJson(job.targets)) throw new Error("Curator plan target set is not the exact authoritative job base");
  const output = value.output;
  if (!record(output) || !exact(output, ["formatVersion", "conclusions", "outputHash"]) || output.formatVersion !== 1 || !Array.isArray(output.conclusions)
    || output.conclusions.length > 64 || typeof output.outputHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(output.outputHash)
    || Buffer.byteLength(canonicalJson(output), "utf8") > 65_536) throw new Error("Curator plan output schema or bound is invalid");
  const normalizedConclusions = output.conclusions.map((conclusion) => {
    if (!record(conclusion) || !exact(conclusion, ["text", "citationIds"]) || typeof conclusion.text !== "string" || conclusion.text !== conclusion.text.normalize("NFC").trim()
      || Buffer.byteLength(conclusion.text, "utf8") < 8 || Buffer.byteLength(conclusion.text, "utf8") > 4_096 || containsControl(conclusion.text) || !Array.isArray(conclusion.citationIds)
      || conclusion.citationIds.length < 1 || conclusion.citationIds.length > 32 || new Set(conclusion.citationIds).size !== conclusion.citationIds.length
      || conclusion.citationIds.some((id) => typeof id !== "string" || !job.candidateIds.includes(id))) throw new Error("Curator plan conclusion or candidate provenance is invalid");
    return Object.freeze({ text: conclusion.text, citationIds: Object.freeze([...(conclusion.citationIds as string[])]) });
  });
  const outputIdentity = { formatVersion: 1, conclusions: normalizedConclusions };
  const expectedOutputHash = `sha256:${createHash("sha256").update("pi-hive-curator-output-v1\0").update(canonicalJson(outputIdentity)).digest("hex")}`;
  if (output.outputHash !== expectedOutputHash) throw new Error("Curator plan output hash is not authoritative");
  const byBundle = new Map(targets.map((target) => [target.bundleId, target]));
  const actions = value.actions.map((action): DurableCuratorPlanAction => {
    if (!record(action) || typeof action.kind !== "string" || typeof action.bundleId !== "string") throw new Error("Curator plan action schema is invalid");
    const target = byBundle.get(action.bundleId);
    if (!target) throw new Error("Curator plan action target is not authoritative");
    if (action.kind === "skip") {
      if (!exact(action, ["kind", "bundleId", "policy", "reason"]) || action.policy !== target.policy
        || (action.reason !== "read-only-policy" && action.reason !== "no-stable-conclusions")
        || (action.reason === "read-only-policy") !== (target.policy === "read-only") || (action.reason === "no-stable-conclusions" && normalizedConclusions.length !== 0)) throw new Error("Curator plan skip is not authoritative");
      return Object.freeze({ kind: "skip", bundleId: target.bundleId, policy: target.policy, reason: action.reason });
    }
    if (action.kind !== "automatic" && action.kind !== "proposal") throw new Error("Curator plan action kind is invalid");
    if (!exact(action, action.kind === "automatic" ? ["kind", "bundleId", "update"] : ["kind", "bundleId", "reason", "update"]) || !record(action.update)) throw new Error("Curator plan update action schema is invalid");
    const update = action.update;
    if (!exact(update, ["formatVersion", "updateId", "jobId", "projectId", "sessionId", "runId", "bundleId", "providerId", "expectedContentHash", "curatorOutputHash", "conclusions", "createdAt"])
      || update.formatVersion !== 1 || update.jobId !== job.jobId || update.projectId !== job.projectId || update.sessionId !== job.sessionId || update.runId !== job.runId
      || update.bundleId !== target.bundleId || update.providerId !== target.providerId || update.expectedContentHash !== target.expectedContentHash || update.curatorOutputHash !== output.outputHash
      || !Array.isArray(update.conclusions) || !Number.isFinite(Date.parse(String(update.createdAt)))) throw new Error("Curator plan update identity is invalid");
    const expectedConclusions = normalizedConclusions.map((conclusion) => ({ text: conclusion.text, citations: conclusion.citationIds.flatMap((candidateId) => {
      const candidate = candidates[candidateId];
      if (!candidate || !job.candidateIds.includes(candidateId) || candidate.projectId !== job.projectId || candidate.sessionId !== job.sessionId || candidate.runId !== job.runId) throw new Error("Curator plan candidate is not exact authoritative job provenance");
      return candidate.citations.map((citation) => ({ candidateId, eventId: citation.eventId, eventHash: citation.eventHash, payloadHash: citation.payloadHash, sourceHashes: candidate.sourceHashes }));
    }).sort((left, right) => compare(left.candidateId, right.candidateId) || compare(left.eventId, right.eventId)) }));
    if (canonicalJson(update.conclusions) !== canonicalJson(expectedConclusions)) throw new Error("Curator plan update citations do not exactly derive from authoritative candidates");
    boundedId(update.updateId, "Curator plan update ID");
    if (action.kind === "automatic") {
      if (target.policy !== "automatic") throw new Error("Curator plan automatic action violates target policy");
      return deepFreeze(structuredClone(action)) as unknown as DurableCuratorPlanAction;
    }
    if (action.reason !== "reviewed-policy" && action.reason !== "multi-target-consistency" && action.reason !== "stale-after-one-reevaluation") throw new Error("Curator plan proposal reason is invalid");
    if (target.policy === "read-only" || (action.reason === "reviewed-policy" && target.policy !== "reviewed")) throw new Error("Curator plan proposal action violates target policy");
    return deepFreeze(structuredClone(action)) as unknown as DurableCuratorPlanAction;
  });
  if (new Set(actions.map((action) => action.bundleId)).size !== targets.length) throw new Error("Curator plan action target is duplicated or incomplete");
  const plan = deepFreeze(structuredClone(value)) as unknown as DurableCuratorPlan;
  const identity = { jobId: plan.jobId, evaluation: plan.evaluation, targets: plan.targets, output: plan.output, actions: plan.actions };
  if (plan.planId !== curatorPlanIdentity(identity)) throw new Error("Curator plan ID is not authoritative");
  return plan;
}

export function deriveCuratorBudgetDenialReason(state: Pick<KnowledgeEnrichmentState, "curatorAdmissions" | "curatorAccounting">, jobId: string): CuratorBudgetDenialReason | undefined {
  const jobAdmissions = Object.values(state.curatorAdmissions).filter((admission) => admission.jobId === jobId).length;
  if (jobAdmissions >= CURATOR_EXECUTION_POLICY.maxModelAttempts) return "curator-per-job-model-budget-denied";
  if (state.curatorAccounting.modelCalls + 1 > CURATOR_EXECUTION_POLICY.maxSessionModelCalls
    || state.curatorAccounting.reservedInputTokens + CURATOR_EXECUTION_POLICY.maxInputTokens > CURATOR_EXECUTION_POLICY.maxSessionInputTokens
    || state.curatorAccounting.reservedOutputTokens + CURATOR_EXECUTION_POLICY.maxOutputTokens > CURATOR_EXECUTION_POLICY.maxSessionOutputTokens
    || state.curatorAccounting.reservedCostMicroUsd + CURATOR_EXECUTION_POLICY.reservedCostMicroUsdPerCall > CURATOR_EXECUTION_POLICY.maxSessionCostMicroUsd) return "curator-session-model-budget-denied";
  return undefined;
}

export function restoreKnowledgeEnrichmentState(events: readonly WorkflowEventEnvelope[], _options: { readonly recoverActive?: boolean } = {}): KnowledgeEnrichmentState {
  const candidates: Record<string, DurableKnowledgeCandidate> = {};
  const jobs: Record<string, DurableKnowledgeJob> = {};
  const terminalEvents: Record<string, string[]> = {};
  const terminalSkipped: Record<string, number> = {};
  const preserveCancelledRuns: Record<string, true> = {};
  const preservationRequests = new Set<string>();
  const terminalEnqueueCompleted: Record<string, true> = {};
  const curatorAdmissions: Record<string, DurableCuratorAdmission> = {};
  const curatorBudgetDenials: Record<string, DurableCuratorBudgetDenial> = {};
  const curatorPlans: Record<string, DurableCuratorPlan> = {};
  const curatorPlanHistory: Record<string, DurableCuratorPlan> = {};
  const curatorEffects: Record<string, true> = {};
  const curatorAccounting = { reservedInputTokens: 0, reservedOutputTokens: 0, reservedCostMicroUsd: 0, modelCalls: 0 };
  const skipCorrelations = new Set<string>();
  const candidateAttemptKeys = new Set<string>();
  const consolidatedJobKeys = new Set<string>();
  const terminalCandidateDispositions: Record<string, Set<string>> = {};
  const eventByHash = new Map(events.map((event) => [event.eventHash, event]));
  const proposalActionPublished = (job: DurableKnowledgeJob, action: Extract<DurableCuratorPlanAction, { kind: "proposal" }>, beforeSequence: number): boolean => events.some((prior) => {
    if (prior.sequence >= beforeSequence || prior.type !== "knowledge.transition" || prior.producer !== "harness" || prior.projectId !== job.projectId
      || prior.sessionId !== job.sessionId || prior.runId !== job.runId || prior.correlationId !== action.update.updateId || !record(prior.payload)
      || prior.payload.operation !== "proposal-created" || !record(prior.payload.proposal)) return false;
    const proposal = prior.payload.proposal;
    return exact(proposal, ["formatVersion", "proposalId", "projectId", "sessionId", "runId", "update", "updateHash", "state", "createdAt"])
      && proposal.formatVersion === 1 && typeof proposal.proposalId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(proposal.proposalId)
      && proposal.projectId === job.projectId && proposal.sessionId === job.sessionId && proposal.runId === job.runId && proposal.state === "pending"
      && typeof proposal.createdAt === "string" && Number.isFinite(Date.parse(proposal.createdAt))
      && proposal.updateHash === stableKnowledgeUpdateHash(action.update) && canonicalJson(proposal.update) === canonicalJson(action.update);
  });
  const planEffectsClosed = (job: DurableKnowledgeJob, beforeSequence: number): boolean => {
    const plan = curatorPlans[job.jobId];
    return Boolean(plan) && plan!.actions.every((action) => {
      if (action.kind === "skip") return curatorEffects[`skip:${plan!.planId}:${action.bundleId}`] === true;
      if (action.kind === "automatic") return curatorEffects[`applied:${action.update.updateId}`] === true;
      return proposalActionPublished(job, action, beforeSequence)
        && (action.reason !== "stale-after-one-reevaluation" || curatorEffects[`fallback:${action.update.updateId}`] === true);
    });
  };
  for (const event of events) {
    if (event.type !== "knowledge.transition" || !record(event.payload)) continue;
    const operation = event.payload.operation;
    if (operation === "cancel-preservation-requested") {
      const runId = String(event.payload.runId ?? ""), identity = `${event.projectId}\0${event.sessionId}\0${runId}`;
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "runId"]) || event.payload.formatVersion !== 1 || event.runId !== runId
        || !runId || preservationRequests.has(identity) || events.slice(0, event.sequence - 1).some((prior) => prior.type === "terminal.recorded" && prior.runId === runId)) throw new Error("Knowledge cancelled-run preservation request identity, ordering, or replay is invalid");
      boundedId(runId, "Knowledge preserved cancelled run ID");
      preserveCancelledRuns[runId] = true;
      preservationRequests.add(identity);
    } else if (operation === "candidate-recorded") {
      if (event.producer !== "runtime" || !exact(event.payload, ["formatVersion", "operation", "candidate"]) || event.payload.formatVersion !== 1) throw new Error("Knowledge candidate event envelope schema or producer is invalid");
      const candidate = parseCandidate(event.payload.candidate);
      if (event.projectId !== candidate.projectId || event.sessionId !== candidate.sessionId || event.runId !== candidate.runId || event.attemptId === undefined || event.correlationId !== event.attemptId) throw new Error("Knowledge candidate event envelope identity is invalid");
      if (events.slice(0, event.sequence - 1).some((prior) => prior.type === "terminal.recorded" && prior.runId === candidate.runId)) throw new Error("Knowledge candidate follows its terminal");
      const attemptKey = `${candidate.projectId}\0${candidate.sessionId}\0${candidate.runId}\0${event.attemptId}`;
      if (candidates[candidate.candidateId] || candidateAttemptKeys.has(attemptKey)) throw new Error("Knowledge candidate ID or exact attempt/input publication is duplicated");
      const derivedHashes = new Set<string>();
      for (const citation of candidate.citations) {
        const cited = events[citation.sequence - 1];
        if (!cited || cited.sequence >= event.sequence || cited.eventId !== citation.eventId || cited.eventHash !== citation.eventHash || cited.payloadHash !== citation.payloadHash || cited.type !== citation.type
          || cited.projectId !== candidate.projectId || cited.sessionId !== candidate.sessionId || cited.runId !== candidate.runId) throw new Error("Knowledge candidate citation is not exact verified same-run evidence");
        for (const hash of payloadHashes(cited.payload)) derivedHashes.add(hash);
      }
      if (canonicalJson([...derivedHashes].sort(compare)) !== canonicalJson(candidate.sourceHashes)) throw new Error("Knowledge candidate source hashes do not exactly bind cited evidence");
      candidates[candidate.candidateId] = candidate;
      candidateAttemptKeys.add(attemptKey);
    } else if (operation === "jobs-enqueued") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "terminalEventHash", "preservedCancelled", "jobs"]) || event.payload.formatVersion !== 1
        || typeof event.payload.preservedCancelled !== "boolean" || !Array.isArray(event.payload.jobs) || event.payload.jobs.length < 1) throw new Error("Knowledge job enqueue event envelope schema or producer is invalid");
      const terminalHash = String(event.payload.terminalEventHash);
      const terminal = eventByHash.get(terminalHash);
      if (!terminal || terminal.type !== "terminal.recorded" || terminal.producer !== "harness" || terminal.projectId !== event.projectId || terminal.sessionId !== event.sessionId || terminal.runId !== event.runId || terminal.sequence >= event.sequence
        || !record(terminal.payload) || terminal.payload.formatVersion !== 1 || !new Set(["completed", "failed", "blocked", "cancelled"]).has(String(terminal.payload.status))
        || (terminal.payload.status === "cancelled") !== (event.payload.preservedCancelled === true)
        || (event.payload.preservedCancelled === true && !preservationRequests.has(`${event.projectId}\0${event.sessionId}\0${event.runId}`))) throw new Error("Knowledge job enqueue terminal or preservation evidence is invalid");
      if (terminalEnqueueCompleted[terminalHash]) throw new Error("Knowledge jobs cannot be appended after terminal enqueue completion");
      const dispositions = terminalCandidateDispositions[terminalHash] ??= new Set<string>();
      for (const raw of event.payload.jobs) {
        const job = parseJob(raw);
        if (job.terminalEventHash !== terminalHash || job.projectId !== event.projectId || job.sessionId !== event.sessionId || job.runId !== event.runId) throw new Error("Knowledge job enqueue envelope identity is invalid");
        const consolidatedKey = `${job.terminalEventHash}\0${job.scope}\0${job.agentId ?? "shared"}`;
        if (jobs[job.jobId] || consolidatedJobKeys.has(consolidatedKey)) throw new Error("Knowledge job ID or terminal/scope/agent consolidation key is duplicated");
        for (const candidateId of job.candidateIds) {
          const candidate = candidates[candidateId];
          if (!candidate || candidate.projectId !== job.projectId || candidate.sessionId !== job.sessionId || candidate.runId !== job.runId || candidate.scope !== job.scope
            || (job.scope === "agent" && candidate.agentId !== job.agentId) || dispositions.has(candidateId)) throw new Error("Knowledge job candidate identity, scope, or exact terminal disposition is invalid");
        }
        for (const candidateId of job.candidateIds) dispositions.add(candidateId);
        jobs[job.jobId] = job;
        consolidatedJobKeys.add(consolidatedKey);
        (terminalEvents[job.terminalEventHash] ??= []).push(job.jobId);
      }
    } else if (operation === "enrichment-skipped") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "terminalEventHash", "scope", "reason", "bundleIds", "candidateIds"], ["agentId"]) || event.payload.formatVersion !== 1
        || (event.payload.scope !== "agent" && event.payload.scope !== "shared")
        || !new Set(["no-declared-target", "target-limit", "target-payload-byte-limit", "curator-input-byte-limit", "cancelled-not-preserved"]).has(String(event.payload.reason))
        || !Array.isArray(event.payload.bundleIds) || !Array.isArray(event.payload.candidateIds)
        || event.payload.bundleIds.length > KNOWLEDGE_ENRICHMENT_LIMITS.skippedIdsPerAuditEvent || event.payload.candidateIds.length > KNOWLEDGE_ENRICHMENT_LIMITS.skippedIdsPerAuditEvent
        || Buffer.byteLength(canonicalJson(event.payload), "utf8") > KNOWLEDGE_ENRICHMENT_LIMITS.skipAuditBytes
        || event.payload.bundleIds.some((id) => typeof id !== "string") || event.payload.candidateIds.some((id) => typeof id !== "string")
        || new Set(event.payload.bundleIds).size !== event.payload.bundleIds.length || new Set(event.payload.candidateIds).size !== event.payload.candidateIds.length
        || (event.payload.scope === "agent") !== (typeof event.payload.agentId === "string")) throw new Error("Knowledge enrichment skip schema is invalid");
      const terminalHash = String(event.payload.terminalEventHash);
      const terminal = eventByHash.get(terminalHash);
      const skip: EnrichmentSkip = Object.freeze({
        scope: event.payload.scope as KnowledgeCandidateScope,
        ...(typeof event.payload.agentId === "string" ? { agentId: event.payload.agentId } : {}),
        reason: event.payload.reason as EnrichmentSkip["reason"],
        bundleIds: Object.freeze([...(event.payload.bundleIds as string[])]),
        candidateIds: Object.freeze([...(event.payload.candidateIds as string[])]),
      });
      const expectedCorrelation = skipCorrelation(terminalHash, skip);
      if (!terminal || terminal.type !== "terminal.recorded" || terminal.producer !== "harness" || terminal.sequence >= event.sequence
        || terminal.projectId !== event.projectId || terminal.sessionId !== event.sessionId || terminal.runId !== event.runId
        || event.correlationId !== expectedCorrelation || skipCorrelations.has(expectedCorrelation) || terminalEnqueueCompleted[terminalHash]) throw new Error("Knowledge enrichment skip envelope or replay identity is invalid");
      const dispositions = terminalCandidateDispositions[terminalHash] ??= new Set<string>();
      for (const id of skip.bundleIds) boundedId(id, "Knowledge skipped bundle ID");
      for (const id of skip.candidateIds) {
        boundedId(id, "Knowledge skipped candidate ID");
        const candidate = candidates[id];
        if (!candidate || candidate.projectId !== terminal.projectId || candidate.sessionId !== terminal.sessionId || candidate.runId !== terminal.runId || candidate.scope !== skip.scope
          || (skip.scope === "agent" && candidate.agentId !== skip.agentId) || dispositions.has(id)) throw new Error("Knowledge skipped candidate scope, terminal identity, or disposition is invalid");
      }
      for (const id of skip.candidateIds) dispositions.add(id);
      skipCorrelations.add(expectedCorrelation);
      terminalSkipped[terminalHash] = (terminalSkipped[terminalHash] ?? 0) + skip.bundleIds.length + skip.candidateIds.length;
    } else if (operation === "jobs-enqueue-completed") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "terminalEventHash", "jobIds", "skipped"]) || event.payload.formatVersion !== 1
        || !Array.isArray(event.payload.jobIds) || event.payload.jobIds.some((id) => typeof id !== "string") || !Number.isSafeInteger(event.payload.skipped) || Number(event.payload.skipped) < 0) throw new Error("Knowledge enqueue completion schema is invalid");
      const terminalHash = String(event.payload.terminalEventHash);
      const terminal = eventByHash.get(terminalHash);
      const expected = [...(terminalEvents[terminalHash] ?? [])].sort(compare);
      const expectedCandidates = Object.values(candidates).filter((candidate) => candidate.projectId === event.projectId && candidate.sessionId === event.sessionId && candidate.runId === event.runId).map((candidate) => candidate.candidateId).sort(compare);
      const disposedCandidates = [...(terminalCandidateDispositions[terminalHash] ?? new Set<string>())].sort(compare);
      if (!terminal || terminal.type !== "terminal.recorded" || terminal.producer !== "harness" || terminal.sequence >= event.sequence || terminal.projectId !== event.projectId || terminal.sessionId !== event.sessionId || terminal.runId !== event.runId
        || canonicalJson([...(event.payload.jobIds as string[])].sort(compare)) !== canonicalJson(expected) || Number(event.payload.skipped) !== (terminalSkipped[terminalHash] ?? 0)
        || canonicalJson(disposedCandidates) !== canonicalJson(expectedCandidates) || terminalEnqueueCompleted[terminalHash]) throw new Error("Knowledge enqueue completion identity or exact candidate disposition is invalid");
      terminalEnqueueCompleted[terminalHash] = true;
    } else if (operation === "job-transition") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "jobId", "from", "to", "attemptCount", "staleReevaluations", "reason", "ownerNonce"]) || event.payload.formatVersion !== 1) throw new Error("Knowledge job transition schema is invalid");
      const jobId = boundedId(event.payload.jobId, "Knowledge job ID");
      const ownerNonce = boundedId(event.payload.ownerNonce, "Knowledge queue owner nonce");
      const current = jobs[jobId];
      if (!current || event.projectId !== current.projectId || event.sessionId !== current.sessionId || event.runId !== current.runId || event.payload.from !== current.state) throw new Error("Knowledge job transition envelope or from-state CAS is invalid");
      const to = event.payload.to;
      if (to !== "active" && to !== "paused" && to !== "completed" && to !== "failed") throw new Error("Knowledge job transition state is invalid");
      const attemptCount = event.payload.attemptCount;
      const staleReevaluations = event.payload.staleReevaluations;
      const starts = to === "active" && (current.state === "queued" || current.state === "paused") && attemptCount === current.attemptCount + 1;
      const settles = current.state === "active" && to !== "active" && current.activeOwnerNonce === ownerNonce && attemptCount === current.attemptCount;
      const denial = curatorBudgetDenials[jobId];
      if ((!starts && !settles) || !Number.isSafeInteger(staleReevaluations) || staleReevaluations !== current.staleReevaluations
        || (to === "completed" && !planEffectsClosed(current, event.sequence))
        || (to === "failed" && (!denial || curatorPlans[jobId] || event.payload.reason !== denial.reason))
        || typeof event.payload.reason !== "string" || Buffer.byteLength(event.payload.reason, "utf8") > 2_048) throw new Error("Knowledge job transition owner, counters, plan-effect closure, budget-denial evidence, or reason are invalid");
      jobs[jobId] = deepFreeze({ ...current, state: to, attemptCount: Number(attemptCount), staleReevaluations: Number(staleReevaluations), updatedAt: event.timestamp,
        ...(to === "active" ? { activeOwnerNonce: ownerNonce } : { activeOwnerNonce: undefined }), lastReason: event.payload.reason });
    } else if (operation === "job-owner-taken-over") {
      if (event.producer !== "recovery" || !exact(event.payload, ["formatVersion", "operation", "jobId", "expectedOwnerNonce", "newOwnerNonce", "reason"]) || event.payload.formatVersion !== 1) throw new Error("Knowledge job takeover schema is invalid");
      const jobId = boundedId(event.payload.jobId, "Knowledge job ID");
      const expectedOwnerNonce = boundedId(event.payload.expectedOwnerNonce, "Knowledge previous owner nonce");
      boundedId(event.payload.newOwnerNonce, "Knowledge new owner nonce");
      const current = jobs[jobId];
      if (!current || current.state !== "active" || current.activeOwnerNonce !== expectedOwnerNonce || event.projectId !== current.projectId || event.sessionId !== current.sessionId || event.runId !== current.runId) throw new Error("Knowledge job verified-dead takeover lost its exact owner CAS");
      jobs[jobId] = deepFreeze({ ...current, state: "paused", activeOwnerNonce: undefined, updatedAt: event.timestamp, lastReason: "verified-dead-owner-takeover" });
    } else if (operation === "job-stale-reloaded") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "jobId", "from", "to", "ownerNonce", "targets"]) || event.payload.formatVersion !== 1) throw new Error("Knowledge stale reload schema is invalid");
      const jobId = boundedId(event.payload.jobId, "Knowledge job ID");
      const ownerNonce = boundedId(event.payload.ownerNonce, "Knowledge queue owner nonce");
      const current = jobs[jobId];
      const targets = parseJobTargets(event.payload.targets);
      if (!current || current.state !== "active" || current.activeOwnerNonce !== ownerNonce || event.projectId !== current.projectId || event.sessionId !== current.sessionId || event.runId !== current.runId
        || event.correlationId !== `curator-${jobId}` || event.payload.from !== current.staleReevaluations
        || event.payload.to !== current.staleReevaluations + 1 || Number(event.payload.to) > CURATOR_EXECUTION_POLICY.maxStaleReevaluations
        || canonicalJson(targets.map(({ expectedContentHash: _hash, ...target }) => target)) !== canonicalJson(current.targets.map(({ expectedContentHash: _hash, ...target }) => target))) throw new Error("Knowledge stale re-evaluation transition is invalid");
      jobs[jobId] = deepFreeze({ ...current, targets, staleReevaluations: Number(event.payload.to), updatedAt: event.timestamp, lastReason: "stale-input-reloaded" });
    } else if (operation === "job-target-base-refreshed") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "jobId", "ownerNonce", "fromTargets", "targets"], ["replacementPlan"]) || event.payload.formatVersion !== 1) throw new Error("Knowledge target-base refresh schema is invalid");
      const jobId = boundedId(event.payload.jobId, "Knowledge job ID");
      const ownerNonce = boundedId(event.payload.ownerNonce, "Knowledge queue owner nonce");
      const current = jobs[jobId];
      const fromTargets = parseJobTargets(event.payload.fromTargets);
      const targets = parseJobTargets(event.payload.targets);
      const topology = (entries: readonly KnowledgeJobTarget[]) => entries.map(({ expectedContentHash: _hash, ...target }) => target);
      if (!current || current.state !== "active" || current.activeOwnerNonce !== ownerNonce || current.staleReevaluations !== CURATOR_EXECUTION_POLICY.maxStaleReevaluations
        || event.projectId !== current.projectId || event.sessionId !== current.sessionId || event.runId !== current.runId || event.correlationId !== `curator-${jobId}`
        || canonicalJson(fromTargets) !== canonicalJson(current.targets)
        || (canonicalJson(targets) === canonicalJson(fromTargets) && current.staleFallbackRequired === true)
        || canonicalJson(topology(targets)) !== canonicalJson(topology(fromTargets))) throw new Error("Knowledge target-base refresh lost its exact owned target CAS");
      const refreshed = deepFreeze({ ...current, targets, staleFallbackRequired: true as const, updatedAt: event.timestamp, lastReason: "stale-after-one-reevaluation" });
      if (event.payload.replacementPlan !== undefined) {
        if (curatorPlans[jobId] || curatorBudgetDenials[jobId]) throw new Error("Knowledge target-base fallback cannot replace an executable plan or canonical budget denial");
        const replacement = parseCuratorPlan(event.payload.replacementPlan, refreshed, candidates);
        if (replacement.evaluation !== 1 || replacement.actions.some((action) => action.kind !== "skip" && (action.kind !== "proposal" || action.reason !== "stale-after-one-reevaluation"))
          || curatorPlanHistory[replacement.planId]) throw new Error("Knowledge target-base refresh replacement is not the exact reviewed fallback plan");
        curatorPlans[jobId] = replacement;
        curatorPlanHistory[replacement.planId] = replacement;
      }
      jobs[jobId] = refreshed;
    } else if (operation === "curator-plan-recorded") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "jobId", "ownerNonce", "plan"]) || event.payload.formatVersion !== 1) throw new Error("Curator plan event schema is invalid");
      const jobId = boundedId(event.payload.jobId, "Curator plan job ID");
      const ownerNonce = boundedId(event.payload.ownerNonce, "Curator plan owner nonce");
      const current = jobs[jobId];
      if (!current || current.state !== "active" || current.activeOwnerNonce !== ownerNonce || event.projectId !== current.projectId || event.sessionId !== current.sessionId || event.runId !== current.runId
        || event.correlationId !== `curator-plan-${jobId}` || curatorPlans[jobId] || curatorBudgetDenials[jobId]) throw new Error("Curator plan event lost its exact active owner or budget-denial CAS");
      const plan = parseCuratorPlan(event.payload.plan, current, candidates);
      if (curatorPlanHistory[plan.planId]) throw new Error("Curator plan identity is already present in immutable history");
      curatorPlans[jobId] = plan;
      curatorPlanHistory[plan.planId] = plan;
    } else if (operation === "curator-plan-invalidated") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "jobId", "ownerNonce", "planId", "fromTargets", "targets", "reason"], ["replacementPlan"])
        || event.payload.formatVersion !== 1 || event.payload.reason !== "stale-unexecuted-automatic-plan") throw new Error("Curator plan invalidation schema is invalid");
      const jobId = boundedId(event.payload.jobId, "Curator invalidated plan job ID");
      const ownerNonce = boundedId(event.payload.ownerNonce, "Curator invalidated plan owner nonce");
      const planId = boundedId(event.payload.planId, "Curator invalidated plan ID");
      const current = jobs[jobId];
      const plan = curatorPlans[jobId];
      const fromTargets = parseJobTargets(event.payload.fromTargets);
      const targets = parseJobTargets(event.payload.targets);
      const topology = (entries: readonly KnowledgeJobTarget[]) => entries.map(({ expectedContentHash: _hash, ...target }) => target);
      const updateIds = plan?.actions.flatMap((action) => action.kind === "automatic" ? [action.update.updateId] : []) ?? [];
      const priorEffect = events.some((prior) => prior.sequence < event.sequence && prior.type === "knowledge.transition" && record(prior.payload)
        && updateIds.includes(String(prior.payload.updateId)) && (prior.payload.operation === "mutation-committed" || prior.payload.operation === "update-applied" || prior.payload.operation === "proposal-created"));
      if (!current || current.state !== "active" || current.activeOwnerNonce !== ownerNonce || !plan || plan.planId !== planId || plan.evaluation !== current.staleReevaluations
        || !updateIds.length || priorEffect || event.projectId !== current.projectId || event.sessionId !== current.sessionId || event.runId !== current.runId
        || event.correlationId !== `curator-plan-invalidate-${jobId}` || canonicalJson(fromTargets) !== canonicalJson(current.targets)
        || canonicalJson(plan.targets) !== canonicalJson(fromTargets) || canonicalJson(topology(targets)) !== canonicalJson(topology(fromTargets))
        || canonicalJson(targets) === canonicalJson(fromTargets)) throw new Error("Curator stale plan invalidation lost its exact owner, plan, unexecuted-effect, or target CAS");
      delete curatorPlans[jobId];
      const invalidated = deepFreeze({ ...current, targets,
        staleReevaluations: Math.min(CURATOR_EXECUTION_POLICY.maxStaleReevaluations, current.staleReevaluations + 1),
        staleFallbackRequired: true as const, updatedAt: event.timestamp, lastReason: "stale-unexecuted-plan-invalidated" });
      if ((plan.evaluation === 1) !== (event.payload.replacementPlan !== undefined)) throw new Error("Evaluation-one stale invalidation requires one atomic reviewed replacement plan");
      if (event.payload.replacementPlan !== undefined) {
        const replacement = parseCuratorPlan(event.payload.replacementPlan, invalidated, candidates);
        if (replacement.evaluation !== 1 || canonicalJson(replacement.output) !== canonicalJson(plan.output)
          || replacement.actions.some((action) => action.kind !== "skip" && (action.kind !== "proposal" || action.reason !== "stale-after-one-reevaluation"))
          || curatorPlanHistory[replacement.planId]) throw new Error("Curator invalidation replacement is not the deterministic reviewed evaluation-one fallback");
        curatorPlans[jobId] = replacement;
        curatorPlanHistory[replacement.planId] = replacement;
      }
      jobs[jobId] = invalidated;
    } else if (operation === "curator-model-denied") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "jobId", "ownerNonce", "denialId", "evaluation", "reason"]) || event.payload.formatVersion !== 1) throw new Error("Curator budget denial event schema is invalid");
      const jobId = boundedId(event.payload.jobId, "Curator denied job ID");
      const ownerNonce = boundedId(event.payload.ownerNonce, "Curator denied owner nonce");
      const denialId = boundedId(event.payload.denialId, "Curator budget denial ID");
      const current = jobs[jobId];
      const evaluation = event.payload.evaluation;
      const derivedReason = deriveCuratorBudgetDenialReason({ curatorAdmissions, curatorAccounting }, jobId);
      const expectedDenialId = `curator-denial-${createHash("sha256").update(`pi-hive-curator-budget-denial-v1\0${jobId}\0${current?.attemptCount}\0${evaluation}\0${derivedReason ?? "eligible"}`).digest("hex").slice(0, 40)}`;
      if (!current || current.state !== "active" || current.activeOwnerNonce !== ownerNonce || event.projectId !== current.projectId || event.sessionId !== current.sessionId || event.runId !== current.runId
        || (evaluation !== 0 && evaluation !== 1) || evaluation !== current.staleReevaluations || event.payload.reason !== derivedReason || denialId !== expectedDenialId
        || event.correlationId !== denialId || curatorPlans[jobId] || curatorBudgetDenials[jobId]) throw new Error("Curator budget denial lacks exact derived per-job/session durable evidence");
      curatorBudgetDenials[jobId] = Object.freeze({ denialId, jobId, ownerNonce, evaluation, reason: derivedReason });
    } else if (operation === "curator-model-admitted") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "jobId", "ownerNonce", "admissionId", "evaluation", "reservedInputTokens", "reservedOutputTokens", "reservedCostMicroUsd", "limits"]) || event.payload.formatVersion !== 1) throw new Error("Curator admission event schema is invalid");
      const jobId = boundedId(event.payload.jobId, "Curator admission job ID");
      const ownerNonce = boundedId(event.payload.ownerNonce, "Curator admission owner nonce");
      const admissionId = boundedId(event.payload.admissionId, "Curator admission ID");
      const current = jobs[jobId];
      const evaluation = event.payload.evaluation;
      const expectedAdmission = `curator-${createHash("sha256").update(`pi-hive-curator-admission-v1\0${jobId}\0${current?.attemptCount}\0${evaluation}`).digest("hex").slice(0, 48)}`;
      const limits = { maxSessionInputTokens: CURATOR_EXECUTION_POLICY.maxSessionInputTokens, maxSessionOutputTokens: CURATOR_EXECUTION_POLICY.maxSessionOutputTokens, maxSessionCostMicroUsd: CURATOR_EXECUTION_POLICY.maxSessionCostMicroUsd, maxSessionModelCalls: CURATOR_EXECUTION_POLICY.maxSessionModelCalls };
      if (!current || current.state !== "active" || current.activeOwnerNonce !== ownerNonce || event.projectId !== current.projectId || event.sessionId !== current.sessionId || event.runId !== current.runId
        || event.correlationId !== admissionId || admissionId !== expectedAdmission || (evaluation !== 0 && evaluation !== 1) || evaluation !== current.staleReevaluations
        || deriveCuratorBudgetDenialReason({ curatorAdmissions, curatorAccounting }, jobId) !== undefined
        || event.payload.reservedInputTokens !== CURATOR_EXECUTION_POLICY.maxInputTokens || event.payload.reservedOutputTokens !== CURATOR_EXECUTION_POLICY.maxOutputTokens
        || event.payload.reservedCostMicroUsd !== CURATOR_EXECUTION_POLICY.reservedCostMicroUsdPerCall || canonicalJson(event.payload.limits) !== canonicalJson(limits)
        || curatorAdmissions[admissionId] || curatorBudgetDenials[jobId]
        || curatorAccounting.modelCalls + 1 > CURATOR_EXECUTION_POLICY.maxSessionModelCalls
        || curatorAccounting.reservedInputTokens + CURATOR_EXECUTION_POLICY.maxInputTokens > CURATOR_EXECUTION_POLICY.maxSessionInputTokens
        || curatorAccounting.reservedOutputTokens + CURATOR_EXECUTION_POLICY.maxOutputTokens > CURATOR_EXECUTION_POLICY.maxSessionOutputTokens
        || curatorAccounting.reservedCostMicroUsd + CURATOR_EXECUTION_POLICY.reservedCostMicroUsdPerCall > CURATOR_EXECUTION_POLICY.maxSessionCostMicroUsd) throw new Error("Curator admission event identity, owner, replay, or durable budget is invalid");
      curatorAdmissions[admissionId] = Object.freeze({ admissionId, jobId, ownerNonce, evaluation });
      curatorAccounting.reservedInputTokens += CURATOR_EXECUTION_POLICY.maxInputTokens;
      curatorAccounting.reservedOutputTokens += CURATOR_EXECUTION_POLICY.maxOutputTokens;
      curatorAccounting.reservedCostMicroUsd += CURATOR_EXECUTION_POLICY.reservedCostMicroUsdPerCall;
      curatorAccounting.modelCalls++;
    } else if (operation === "curator-model-usage") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "jobId", "ownerNonce", "admissionId", "usage"]) || event.payload.formatVersion !== 1) throw new Error("Curator usage event schema is invalid");
      const jobId = boundedId(event.payload.jobId, "Curator usage job ID");
      const ownerNonce = boundedId(event.payload.ownerNonce, "Curator usage owner nonce");
      const admissionId = boundedId(event.payload.admissionId, "Curator usage admission ID");
      const current = jobs[jobId];
      const admission = curatorAdmissions[admissionId];
      const usage = parseCuratorUsage(event.payload.usage)!;
      if (!current || current.state !== "active" || current.activeOwnerNonce !== ownerNonce || event.projectId !== current.projectId || event.sessionId !== current.sessionId || event.runId !== current.runId
        || event.correlationId !== admissionId || !admission || admission.jobId !== jobId || admission.ownerNonce !== ownerNonce || admission.usage) throw new Error("Curator usage event lost its exact owned admission CAS");
      curatorAdmissions[admissionId] = Object.freeze({ ...admission, usage });
      curatorAccounting.reservedInputTokens += Math.max(0, usage.inputTokens - CURATOR_EXECUTION_POLICY.maxInputTokens);
      curatorAccounting.reservedOutputTokens += Math.max(0, usage.outputTokens - CURATOR_EXECUTION_POLICY.maxOutputTokens);
      curatorAccounting.reservedCostMicroUsd += Math.max(0, usage.costMicroUsd - CURATOR_EXECUTION_POLICY.reservedCostMicroUsdPerCall);
    } else if (operation === "target-skipped") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "jobId", "ownerNonce", "bundleId", "policy", "reason", "curatorOutputHash"]) || event.payload.formatVersion !== 1) throw new Error("Curator target skip schema is invalid");
      const jobId = boundedId(event.payload.jobId, "Curator skip job ID");
      const ownerNonce = boundedId(event.payload.ownerNonce, "Curator skip owner nonce");
      const bundleId = boundedId(event.payload.bundleId, "Curator skipped bundle ID");
      const current = jobs[jobId];
      const target = current?.targets.find((entry) => entry.bundleId === bundleId);
      const plan = curatorPlans[jobId];
      const action = plan?.actions.find((entry) => entry.kind === "skip" && entry.bundleId === bundleId);
      const outputHash = event.payload.curatorOutputHash;
      if (!current || current.state !== "active" || current.activeOwnerNonce !== ownerNonce || event.projectId !== current.projectId || event.sessionId !== current.sessionId || event.runId !== current.runId || event.correlationId !== `curator-${jobId}`
        || !target || !plan || !action || action.kind !== "skip" || event.payload.policy !== action.policy || event.payload.reason !== action.reason
        || action.policy !== target.policy || outputHash !== plan.output.outputHash || typeof outputHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(outputHash)) throw new Error("Curator target skip lacks its exact current plan action and output identity");
      const key = `skip:${plan.planId}:${bundleId}`;
      if (curatorEffects[key]) throw new Error("Curator target skip is duplicated");
      curatorEffects[key] = true;
    } else if (operation === "update-applied") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "jobId", "ownerNonce", "updateId", "bundleId", "expectedContentHash", "curatorOutputHash", "result"]) || event.payload.formatVersion !== 1 || !record(event.payload.result)) throw new Error("Curator applied update schema is invalid");
      const jobId = boundedId(event.payload.jobId, "Curator update job ID");
      const ownerNonce = boundedId(event.payload.ownerNonce, "Curator update owner nonce");
      const updateId = boundedId(event.payload.updateId, "Curator update ID");
      const bundleId = boundedId(event.payload.bundleId, "Curator update bundle ID");
      const current = jobs[jobId];
      const target = current?.targets.find((entry) => entry.bundleId === bundleId);
      const plan = curatorPlans[jobId];
      const action = plan?.actions.find((entry) => entry.kind === "automatic" && entry.bundleId === bundleId);
      const result = event.payload.result;
      if (!current || current.state !== "active" || current.activeOwnerNonce !== ownerNonce || event.projectId !== current.projectId || event.sessionId !== current.sessionId || event.runId !== current.runId || event.correlationId !== `curator-${jobId}`
        || !target || target.policy !== "automatic" || !action || action.kind !== "automatic" || action.update.updateId !== updateId
        || action.update.expectedContentHash !== event.payload.expectedContentHash || plan?.output.outputHash !== event.payload.curatorOutputHash
        || !exact(result, ["updateId", "bundleId", "changed", "contentHash", "documentId", "conclusionCount"]) || result.updateId !== updateId || result.bundleId !== bundleId || typeof result.changed !== "boolean"
        || typeof result.contentHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(result.contentHash) || result.documentId !== "curated" || !Number.isSafeInteger(result.conclusionCount) || Number(result.conclusionCount) < 0
        || !exactPriorMutationCommit(events, event.sequence, action.update, result)) throw new Error("Curator applied update lacks exact authoritative plan action and prior mutation commit result");
      const key = `applied:${updateId}`;
      if (curatorEffects[key]) throw new Error("Curator applied update is duplicated");
      curatorEffects[key] = true;
    } else if (operation === "stale-reviewed-fallback") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "jobId", "ownerNonce", "updateId", "bundleId", "proposalId", "reason"]) || event.payload.formatVersion !== 1 || event.payload.reason !== "stale-after-one-reevaluation") throw new Error("Curator stale fallback schema is invalid");
      const jobId = boundedId(event.payload.jobId, "Curator fallback job ID");
      const ownerNonce = boundedId(event.payload.ownerNonce, "Curator fallback owner nonce");
      const updateId = boundedId(event.payload.updateId, "Curator fallback update ID");
      const bundleId = boundedId(event.payload.bundleId, "Curator fallback bundle ID");
      const proposalId = boundedId(event.payload.proposalId, "Curator fallback proposal ID");
      const current = jobs[jobId];
      const target = current?.targets.find((entry) => entry.bundleId === bundleId);
      const plan = curatorPlans[jobId];
      const action = plan?.actions.find((entry) => entry.kind === "proposal" && entry.bundleId === bundleId && entry.reason === "stale-after-one-reevaluation");
      const proposalEvent = events.find((prior) => prior.sequence < event.sequence && prior.type === "knowledge.transition" && record(prior.payload) && prior.payload.operation === "proposal-created"
        && record(prior.payload.proposal) && prior.payload.proposal.proposalId === proposalId && record(prior.payload.proposal.update) && prior.payload.proposal.update.updateId === updateId
        && action?.kind === "proposal" && canonicalJson(prior.payload.proposal.update) === canonicalJson(action.update));
      if (!current || current.state !== "active" || current.activeOwnerNonce !== ownerNonce || event.projectId !== current.projectId || event.sessionId !== current.sessionId || event.runId !== current.runId || event.correlationId !== `curator-${jobId}`
        || !target || target.policy === "read-only" || !plan || !action || action.kind !== "proposal" || action.update.updateId !== updateId
        || !proposalEvent || proposalEvent.projectId !== current.projectId || proposalEvent.sessionId !== current.sessionId || proposalEvent.runId !== current.runId) throw new Error("Curator stale fallback lacks its exact current plan action and proposal identity");
      const key = `fallback:${updateId}`;
      if (curatorEffects[key]) throw new Error("Curator stale fallback is duplicated");
      curatorEffects[key] = true;
    } else if (typeof operation === "string" && (operation.startsWith("curator-") || operation.startsWith("target-") || operation.startsWith("update-") || operation.startsWith("stale-"))) {
      throw new Error(`Unknown curator audit or accounting transition: ${operation}`);
    }
  }
  for (const ids of Object.values(terminalEvents)) ids.sort(compare);
  const curatorPlanEffectsComplete: Record<string, true> = {};
  for (const job of Object.values(jobs)) if (planEffectsClosed(job, Number.POSITIVE_INFINITY)) curatorPlanEffectsComplete[job.jobId] = true;
  return deepFreeze({ candidates, jobs, curatorAdmissions, curatorBudgetDenials, curatorPlans, curatorPlanHistory, curatorEffects, curatorPlanEffectsComplete, curatorAccounting, terminalEvents, terminalSkipped, preserveCancelledRuns, terminalEnqueueCompleted });
}

export class KnowledgeEnrichmentService {
  readonly options: KnowledgeEnrichmentServiceOptions;
  private readonly providers: KnowledgeProviderRegistry;
  constructor(options: KnowledgeEnrichmentServiceOptions) { this.options = options; this.providers = options.providers ?? createBuiltInKnowledgeProviderRegistry(); }

  propose(nodeId: string, attemptId: string, input: KnowledgeProposalInput): DurableKnowledgeCandidate {
    const identity = proposalNodeRecord(this.options.snapshot, boundedId(nodeId, "Knowledge proposal node"));
    boundedId(attemptId, "Knowledge proposal attempt");
    if (!record(input) || !exact(input, ["scope", "conclusion", "evidenceEventIds"]) || (input.scope !== "agent" && input.scope !== "shared") || !Array.isArray(input.evidenceEventIds)
      || input.evidenceEventIds.length < 1 || input.evidenceEventIds.length > KNOWLEDGE_ENRICHMENT_LIMITS.evidenceRefs
      || new Set(input.evidenceEventIds).size !== input.evidenceEventIds.length) throw new Error("Knowledge proposal evidence is invalid");
    const conclusion = boundedConclusion(input.conclusion);
    const events = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
    const state = restoreKnowledgeEnrichmentState(events);
    const requestHash = hashAttemptInput(input);
    const priorAttempt = events.find((event) => event.type === "knowledge.transition" && event.runId === this.options.runId && event.attemptId === attemptId
      && event.correlationId === attemptId && record(event.payload) && event.payload.operation === "candidate-recorded" && record(event.payload.candidate));
    if (priorAttempt) {
      const priorPayload = priorAttempt.payload as Record<string, unknown>;
      const priorCandidate = priorPayload.candidate as Record<string, unknown>;
      const prior = state.candidates[String(priorCandidate.candidateId ?? "")];
      if (!prior || prior.nodeId !== nodeId || prior.agentId !== identity.agentId || prior.scope !== input.scope || prior.requestHash !== requestHash) throw new Error("Knowledge proposal attempt replay conflicts with its exact node and input identity");
      return prior;
    }
    if (Object.values(state.candidates).filter((candidate) => candidate.runId === this.options.runId).length >= KNOWLEDGE_ENRICHMENT_LIMITS.candidatesPerRun) throw new Error("Knowledge candidate limit exceeded");
    const citations = input.evidenceEventIds.map((eventId) => {
      boundedId(eventId, "Knowledge evidence event");
      const event = events.find((entry) => entry.eventId === eventId && entry.runId === this.options.runId && EVIDENCE_EVENT_TYPES.has(entry.type));
      if (!event) throw new Error("Knowledge proposal evidence event is missing, unverified, or outside the run");
      if (input.scope === "agent") {
        const participants = participantNodeIds(event.payload);
        if (!participants.length || participants.some((participant) => snapshotNode(this.options.snapshot, participant).node.agentId !== identity.agentId)) throw new Error("Agent-scoped knowledge evidence belongs to another catalog agent or has no participant scope");
      }
      return Object.freeze({ eventId: event.eventId, eventHash: event.eventHash, payloadHash: event.payloadHash, sequence: event.sequence, type: event.type });
    }).sort((left, right) => left.sequence - right.sequence || compare(left.eventId, right.eventId));
    const sourceHashes = Object.freeze([...new Set(citations.flatMap((citation) => payloadHashes(events[citation.sequence - 1]?.payload)))].sort(compare));
    if (!sourceHashes.length) throw new Error("Knowledge proposal provenance requires at least one exact source hash");
    const candidate: DurableKnowledgeCandidate = deepFreeze({
      formatVersion: 1, candidateId: boundedId(this.options.createCandidateId?.() ?? randomUUID(), "Knowledge candidate ID"),
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId,
      nodeId, agentId: identity.agentId, scope: input.scope, conclusion, requestHash, citations, sourceHashes,
      createdAt: this.options.now?.() ?? new Date().toISOString(),
    });
    if (Buffer.byteLength(canonicalJson(candidate), "utf8") > KNOWLEDGE_ENRICHMENT_LIMITS.candidateBytes) throw new Error("Knowledge candidate exceeds its durable byte bound");
    appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId,
      type: "knowledge.transition", producer: "runtime", correlationId: attemptId, attemptId,
      payload: { formatVersion: 1, operation: "candidate-recorded", candidate } as unknown as JsonValue, timestamp: candidate.createdAt,
    }), (locked) => {
      const latest = restoreKnowledgeEnrichmentState(locked);
      if (latest.candidates[candidate.candidateId] || locked.some((entry) => entry.type === "knowledge.transition" && entry.runId === this.options.runId && entry.attemptId === attemptId
        && record(entry.payload) && entry.payload.operation === "candidate-recorded")) throw new Error("Knowledge candidate ID or exact attempt publication already exists");
      if (Object.values(latest.candidates).filter((entry) => entry.runId === this.options.runId).length >= KNOWLEDGE_ENRICHMENT_LIMITS.candidatesPerRun) throw new Error("Knowledge candidate limit exceeded");
      if (locked.some((entry) => entry.type === "terminal.recorded" && entry.runId === this.options.runId)) throw new Error("Knowledge proposal is late because the run is terminal");
      for (const citation of citations) if (locked[citation.sequence - 1]?.eventHash !== citation.eventHash) throw new Error("Knowledge proposal evidence changed before publication");
    });
    return candidate;
  }

  requestCancelledPreservation(): void {
    const correlationId = `knowledge-preserve-${createHash("sha256").update(`pi-hive-cancel-preservation-v1\0${this.options.projectId}\0${this.options.sessionId}\0${this.options.runId}`).digest("hex").slice(0, 32)}`;
    const existing = restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId));
    if (existing.preserveCancelledRuns[this.options.runId]) return;
    try {
      appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
        projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId, type: "knowledge.transition", producer: "harness", correlationId,
        payload: { formatVersion: 1, operation: "cancel-preservation-requested", runId: this.options.runId }, timestamp: this.options.now?.(),
      }), (events) => {
        if (restoreKnowledgeEnrichmentState(events).preserveCancelledRuns[this.options.runId]) throw new Error("Knowledge cancelled-run preservation is already requested");
        if (events.some((event) => event.type === "terminal.recorded" && event.runId === this.options.runId)) throw new Error("Knowledge cancelled-run preservation request is late");
      });
    } catch (error) {
      if (!restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId)).preserveCancelledRuns[this.options.runId]) throw error;
    }
  }

  private target(raw: Record<string, unknown>): Readonly<{ target: KnowledgeJobTarget; context: CuratorTargetContextInput }> {
    const declared = declaration(raw);
    const loaded = this.providers.load({ projectRoot: this.options.projectRoot, declaration: declared });
    if (!loaded.ok || !loaded.bundle) throw new Error(`Knowledge enrichment target ${declared.id} failed provider validation`);
    const target = deepFreeze({ bundleId: declared.id, providerId: declared.providerId, path: declared.path, policy: declared.updatePolicy, expectedContentHash: `sha256:${loaded.bundle.contentHash}` });
    return deepFreeze({ target, context: { bundleId: target.bundleId, policy: target.policy, expectedContentHash: target.expectedContentHash,
      currentSummary: loaded.bundle.summary, documentCount: loaded.bundle.documents.length } });
  }

  enqueueTerminal(terminal: WorkflowEventEnvelope, options: { readonly preserveCancelled?: boolean } = {}): Readonly<{ enqueued: number; skipped: number; alreadyEnqueued: boolean }> {
    if (terminal.type !== "terminal.recorded" || terminal.producer !== "harness" || terminal.projectId !== this.options.projectId
      || terminal.sessionId !== this.options.sessionId || terminal.runId !== this.options.runId || !record(terminal.payload)
      || !new Set(["completed", "failed", "blocked", "cancelled"]).has(String(terminal.payload.status))) throw new Error("Knowledge enqueue requires the exact authoritative terminal event");
    const terminalStatus = (terminal.payload as Record<string, unknown>).status;
    const events = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
    if (!events.some((event) => event.eventHash === terminal.eventHash)) throw new Error("Knowledge terminal event is not present in the authoritative journal");
    const restored = restoreKnowledgeEnrichmentState(events);
    const preserveCancelled = terminalStatus === "cancelled" && restored.preserveCancelledRuns[this.options.runId] === true;
    if (options.preserveCancelled && !preserveCancelled) throw new Error("Cancelled knowledge preservation lacks prior policy evidence");
    if (restored.terminalEnqueueCompleted[terminal.eventHash]) return Object.freeze({ enqueued: 0, skipped: 0, alreadyEnqueued: true });
    const candidates = Object.values(restored.candidates).filter((candidate) => candidate.runId === this.options.runId);
    const jobs: DurableKnowledgeJob[] = [];
    const skips: EnrichmentSkip[] = [];
    const createdAt = this.options.now?.() ?? new Date().toISOString();
    const build = (scope: KnowledgeCandidateScope, selected: readonly DurableKnowledgeCandidate[], agentId?: string): void => {
      if (!selected.length) return;
      const ordered = [...selected].sort((left, right) => compare(left.candidateId, right.candidateId));
      if (terminalStatus === "cancelled" && !preserveCancelled) {
        skips.push(Object.freeze({ scope, ...(agentId ? { agentId } : {}), reason: "cancelled-not-preserved", bundleIds: Object.freeze([]), candidateIds: Object.freeze(ordered.map((candidate) => candidate.candidateId)) }));
        return;
      }
      const declarations = rawKnowledge(this.options.snapshot).filter((entry) => scope === "agent" ? entry.owner === agentId : entry.owner === undefined).sort((left, right) => compare(String(left.id), String(right.id)));
      if (!declarations.length) {
        skips.push(Object.freeze({ scope, ...(agentId ? { agentId } : {}), reason: "no-declared-target", bundleIds: Object.freeze([]), candidateIds: Object.freeze(ordered.map((candidate) => candidate.candidateId)) }));
        return;
      }
      const includedDeclarations: Record<string, unknown>[] = [];
      const countOmitted: string[] = [];
      const byteOmitted: string[] = [];
      for (const entry of declarations) {
        const estimatedTarget = { bundleId: entry.id, providerId: entry.provider, path: entry.path, policy: entry.updates, expectedContentHash: `sha256:${"0".repeat(64)}` };
        const nextBytes = serializedArrayBytes([...includedDeclarations.map((raw) => ({ bundleId: raw.id, providerId: raw.provider, path: raw.path, policy: raw.updates, expectedContentHash: `sha256:${"0".repeat(64)}` })), estimatedTarget]);
        if (includedDeclarations.length >= KNOWLEDGE_ENRICHMENT_LIMITS.targetsPerJob) countOmitted.push(boundedId(entry.id, "Knowledge omitted bundle ID"));
        else if (nextBytes > KNOWLEDGE_ENRICHMENT_LIMITS.serializedTargetsBytesPerJob) byteOmitted.push(boundedId(entry.id, "Knowledge omitted bundle ID"));
        else includedDeclarations.push(entry);
      }
      if (countOmitted.length) skips.push(Object.freeze({ scope, ...(agentId ? { agentId } : {}), reason: "target-limit", bundleIds: Object.freeze(countOmitted), candidateIds: Object.freeze([]) }));
      if (byteOmitted.length) skips.push(Object.freeze({ scope, ...(agentId ? { agentId } : {}), reason: "target-payload-byte-limit", bundleIds: Object.freeze(byteOmitted), candidateIds: Object.freeze([]) }));
      if (!includedDeclarations.length) throw new Error("No knowledge target can fit the bounded durable job payload");

      const durableExisting = Object.values(restored.jobs).find((entry) => entry.terminalEventHash === terminal.eventHash && entry.scope === scope && entry.agentId === agentId);
      if (durableExisting) {
        jobs.push(durableExisting);
        const candidateIds = new Set(durableExisting.candidateIds);
        const omittedCandidates = ordered.filter((candidate) => !candidateIds.has(candidate.candidateId)).map((candidate) => candidate.candidateId);
        const targetIds = new Set(durableExisting.targets.map((target) => target.bundleId));
        const promptOmittedTargets = includedDeclarations.map((entry) => boundedId(entry.id, "Knowledge omitted bundle ID")).filter((id) => !targetIds.has(id));
        if (omittedCandidates.length || promptOmittedTargets.length) skips.push(Object.freeze({ scope, ...(agentId ? { agentId } : {}), reason: "curator-input-byte-limit",
          bundleIds: Object.freeze(promptOmittedTargets), candidateIds: Object.freeze(omittedCandidates) }));
        return;
      }

      const stableId = `kj-${createHash("sha256").update(`pi-hive-knowledge-job-v1\0${terminal.eventHash}\0${scope}\0${agentId ?? "shared"}`).digest("hex").slice(0, 48)}`;
      const jobId = boundedId(this.options.createJobId?.() ?? stableId, "Knowledge job ID");
      const availableTargets = includedDeclarations.map((entry) => this.target(entry));
      const promptFits = (targetInputs: readonly typeof availableTargets[number][], candidateInputs: readonly DurableKnowledgeCandidate[]): boolean => {
        try {
          const contexts = boundCuratorTargetContext(targetInputs.map((entry) => entry.context));
          const prompt = buildCuratorPrompt({ jobId, scope, targets: contexts, candidates: candidateInputs.map(candidateView) });
          return Buffer.byteLength(prompt, "utf8") <= KNOWLEDGE_ENRICHMENT_LIMITS.curatorPromptBytesPerJob;
        } catch (error) {
          if (error instanceof Error && /bound|prompt|input|target identit/iu.test(error.message)) return false;
          throw error;
        }
      };
      const includedCandidates: DurableKnowledgeCandidate[] = [];
      const omittedCandidates: string[] = [];
      for (const candidate of ordered) {
        if (!includedCandidates.length) {
          if (promptFits([availableTargets[0]], [candidate])) includedCandidates.push(candidate);
          else omittedCandidates.push(candidate.candidateId);
          continue;
        }
        break;
      }
      if (!includedCandidates.length) {
        const omitted = [...new Set([...omittedCandidates, ...ordered.map((candidate) => candidate.candidateId)])];
        skips.push(Object.freeze({ scope, ...(agentId ? { agentId } : {}), reason: "curator-input-byte-limit",
          bundleIds: Object.freeze(availableTargets.map((entry) => entry.target.bundleId)), candidateIds: Object.freeze(omitted) }));
        return;
      }
      const includedTargets = [availableTargets[0]];
      const promptOmittedTargets: string[] = [];
      for (const targetInput of availableTargets.slice(1)) {
        if (promptFits([...includedTargets, targetInput], includedCandidates)) includedTargets.push(targetInput);
        else promptOmittedTargets.push(targetInput.target.bundleId);
      }
      const seedId = includedCandidates[0].candidateId;
      for (const candidate of ordered) {
        if (candidate.candidateId === seedId || omittedCandidates.includes(candidate.candidateId)) continue;
        if (includedCandidates.length < KNOWLEDGE_ENRICHMENT_LIMITS.candidatesPerJob && promptFits(includedTargets, [...includedCandidates, candidate])) includedCandidates.push(candidate);
        else omittedCandidates.push(candidate.candidateId);
      }
      if (omittedCandidates.length || promptOmittedTargets.length) skips.push(Object.freeze({ scope, ...(agentId ? { agentId } : {}), reason: "curator-input-byte-limit",
        bundleIds: Object.freeze(promptOmittedTargets), candidateIds: Object.freeze(omittedCandidates) }));
      if (!promptFits(includedTargets, includedCandidates)) throw new Error("Durable curator job does not fit the exact conservative production prompt contract");
      const modelNodeId = scope === "shared"
        ? String((this.options.snapshot.payload.workflow as { team?: { rootId?: unknown } }).team?.rootId ?? "")
        : agentCuratorNodeId(this.options.snapshot, agentId!);
      const model = curatorNodeRecord(this.options.snapshot, modelNodeId);
      jobs.push(deepFreeze({
        formatVersion: 1, jobId,
        projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId, terminalEventHash: terminal.eventHash,
        scope, ...(agentId ? { agentId } : {}), candidateIds: includedCandidates.map((candidate) => candidate.candidateId), targets: includedTargets.map((entry) => entry.target),
        model: { nodeId: modelNodeId, modelId: model.modelId, thinking: model.thinking, reason: CURATOR_EXECUTION_POLICY.modelSelection },
        state: "queued", attemptCount: 0, staleReevaluations: 0, createdAt, updatedAt: createdAt,
      }));
    };
    const agentIds = [...new Set(candidates.filter((candidate) => candidate.scope === "agent").map((candidate) => candidate.agentId))].sort(compare);
    for (const agentId of agentIds) build("agent", candidates.filter((candidate) => candidate.scope === "agent" && candidate.agentId === agentId), agentId);
    build("shared", candidates.filter((candidate) => candidate.scope === "shared"));
    if (jobs.length > KNOWLEDGE_ENRICHMENT_LIMITS.jobsPerRun) throw new Error("Knowledge job count exceeds its bound");

    let enqueued = 0;
    for (const job of jobs) {
      const existing = Object.values(restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId)).jobs)
        .find((entry) => entry.terminalEventHash === terminal.eventHash && entry.scope === job.scope && entry.agentId === job.agentId);
      if (existing) continue;
      try {
        appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
          projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId,
          type: "knowledge.transition", producer: "harness", correlationId: `enrichment-${createHash("sha256").update(`${terminal.eventHash}\0${job.scope}\0${job.agentId ?? "shared"}`).digest("hex").slice(0, 32)}`,
          payload: { formatVersion: 1, operation: "jobs-enqueued", terminalEventHash: terminal.eventHash, preservedCancelled: preserveCancelled, jobs: [job] } as unknown as JsonValue,
          timestamp: createdAt,
        }), (locked) => {
          const lockedTerminal = locked.find((event) => event.eventHash === terminal.eventHash);
          if (!lockedTerminal || lockedTerminal.type !== "terminal.recorded") throw new Error("Knowledge terminal event changed before enqueue");
          const lockedState = restoreKnowledgeEnrichmentState(locked);
          if (lockedState.terminalEnqueueCompleted[terminal.eventHash] || Object.values(lockedState.jobs).some((entry) => entry.terminalEventHash === terminal.eventHash && entry.scope === job.scope && entry.agentId === job.agentId)) throw new Error("Knowledge consolidated job scope is already enqueued");
        });
        enqueued++;
      } catch (error) {
        const raced = Object.values(restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId)).jobs)
          .some((entry) => entry.terminalEventHash === terminal.eventHash && entry.scope === job.scope && entry.agentId === job.agentId);
        if (!raced) throw error;
      }
    }
    if (jobs.length) this.options.fault?.("after-job");
    const auditedSkips = skips.flatMap(chunkSkip);
    for (const skip of auditedSkips) {
      const correlationId = skipCorrelation(terminal.eventHash, skip);
      const payload = { formatVersion: 1, operation: "enrichment-skipped", terminalEventHash: terminal.eventHash, ...skip } as unknown as JsonValue;
      const existing = readWorkflowJournal(this.options.projectRoot, this.options.sessionId).find((event) => event.correlationId === correlationId);
      if (existing) {
        if (canonicalJson(existing.payload) !== canonicalJson(payload)) throw new Error("Knowledge skip replay conflicts with its exact durable payload");
        continue;
      }
      try {
        appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
          projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId, type: "knowledge.transition", producer: "harness", correlationId,
          payload, timestamp: createdAt,
        }), (locked) => {
          if (!locked.some((event) => event.eventHash === terminal.eventHash && event.type === "terminal.recorded")) throw new Error("Knowledge skip lost terminal identity");
          if (locked.some((event) => event.correlationId === correlationId)) throw new Error("Knowledge skip is already audited");
        });
      } catch (error) {
        const raced = readWorkflowJournal(this.options.projectRoot, this.options.sessionId).find((event) => event.correlationId === correlationId);
        if (!raced || canonicalJson(raced.payload) !== canonicalJson(payload)) throw error;
      }
    }
    if (auditedSkips.length) this.options.fault?.("after-skip");
    const latest = restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId));
    const jobIds = [...(latest.terminalEvents[terminal.eventHash] ?? [])].sort(compare);
    const durableSkipped = latest.terminalSkipped[terminal.eventHash] ?? 0;
    this.options.fault?.("before-completion");
    try {
      appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
        projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId, type: "knowledge.transition", producer: "harness",
        correlationId: `enrichment-complete-${createHash("sha256").update(terminal.eventHash).digest("hex").slice(0, 32)}`,
        payload: { formatVersion: 1, operation: "jobs-enqueue-completed", terminalEventHash: terminal.eventHash, jobIds, skipped: durableSkipped } as unknown as JsonValue,
        timestamp: createdAt,
      }), (locked) => {
        const state = restoreKnowledgeEnrichmentState(locked);
        if (state.terminalEnqueueCompleted[terminal.eventHash] || canonicalJson(state.terminalEvents[terminal.eventHash] ?? []) !== canonicalJson(jobIds)) throw new Error("Knowledge enqueue completion lost its exact durable job set");
      });
    } catch (error) {
      if (!restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId)).terminalEnqueueCompleted[terminal.eventHash]) throw error;
      return Object.freeze({ enqueued: 0, skipped: 0, alreadyEnqueued: true });
    }
    return Object.freeze({ enqueued, skipped: durableSkipped, alreadyEnqueued: false });
  }
}
