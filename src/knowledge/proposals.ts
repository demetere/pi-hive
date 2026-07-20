import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";
import { withCrossProcessFileLockAsync } from "../core/file-lock";
import { resolveContainedPath } from "../core/safe-path";
import { createWorkflowEvent, type WorkflowEventEnvelope } from "../workflows/events";
import { appendWorkflowEventChecked, readWorkflowJournal } from "../workflows/journal";
import { restoreKnowledgeEnrichmentState } from "./enrichment";
import { createBuiltInKnowledgeProviderRegistry, type KnowledgeProviderRegistry } from "./provider";

export const KNOWLEDGE_PROPOSAL_FORMAT_VERSION = 1 as const;
export const KNOWLEDGE_PROPOSAL_LIMITS = Object.freeze({
  conclusions: 64,
  conclusionBytes: 4_096,
  citationsPerConclusion: 32,
  sourceHashesPerCitation: 128,
  updateBytes: 131_072,
  proposalBytes: 196_608,
  managedDocumentBytes: 262_144,
  controlRequestBytes: 16_384,
  pageSize: 100,
  cursorBytes: 2_048,
});
export interface KnowledgeUpdateCitation {
  readonly candidateId: string;
  readonly eventId: string;
  readonly eventHash: string;
  readonly payloadHash: string;
  readonly sourceHashes: readonly string[];
}
export interface DurableKnowledgeUpdate {
  readonly formatVersion: 1;
  readonly updateId: string;
  readonly jobId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly bundleId: string;
  readonly providerId: string;
  readonly expectedContentHash: string;
  readonly curatorOutputHash: string;
  readonly conclusions: readonly Readonly<{ text: string; citations: readonly KnowledgeUpdateCitation[] }>[];
  readonly createdAt: string;
}
export interface KnowledgeMutationResult {
  readonly updateId: string;
  readonly bundleId: string;
  readonly changed: boolean;
  readonly contentHash: string;
  readonly documentId: "curated";
  readonly conclusionCount: number;
}
export type KnowledgeMutationQueue = <T>(canonicalPath: string, operationId: string, callback: () => T | Promise<T>) => Promise<T>;
export type KnowledgeMutationErrorCode = "STALE_HASH" | "READ_ONLY" | "TARGET_UNMANAGED" | "VALIDATION_FAILED" | "MUTATION_QUEUE_REQUIRED" | "BUNDLE_UNAVAILABLE";
export class KnowledgeMutationError extends Error {
  readonly code: KnowledgeMutationErrorCode;
  constructor(code: KnowledgeMutationErrorCode, message: string) { super(message); this.name = "KnowledgeMutationError"; this.code = code; }
}
export interface OkfKnowledgeMutatorOptions {
  readonly projectRoot: string;
  readonly snapshot: ActivationSnapshotFileV1;
  readonly mutationQueue?: KnowledgeMutationQueue;
  readonly providers?: KnowledgeProviderRegistry;
  readonly fault?: (stage: "after-intent" | "after-stage" | "after-validation" | "after-publication" | "after-commit") => void;
}
export interface KnowledgeProposalDecision {
  readonly decision: "approve" | "deny";
  readonly identity: string;
  readonly operationId: string;
  readonly requestHash: string;
  readonly decidedAt: string;
}
export interface DurableKnowledgeProposal {
  readonly formatVersion: 1;
  readonly proposalId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly update: DurableKnowledgeUpdate;
  readonly updateHash: string;
  readonly state: "pending" | "approved" | "denied" | "applied";
  readonly createdAt: string;
  readonly decision?: KnowledgeProposalDecision;
  readonly applied?: KnowledgeMutationResult;
}
export interface KnowledgeProposalState { readonly proposals: Readonly<Record<string, DurableKnowledgeProposal>> }
export interface KnowledgeProposalControlRequest {
  readonly projectId: string;
  readonly sessionId: string;
  readonly proposalId: string;
  readonly expectedState: "pending";
  readonly decision: "approve" | "deny";
  readonly operationId: string;
  readonly channel: "dashboard";
  readonly claimedIdentity: string;
  readonly credential: string;
}
export interface KnowledgeProposalStatusRequest {
  readonly projectId: string;
  readonly sessionId: string;
  readonly state?: DurableKnowledgeProposal["state"];
  readonly limit?: number;
  readonly cursor?: string;
}
export interface KnowledgeProposalDetailRequest { readonly projectId: string; readonly sessionId: string; readonly proposalId: string }
export interface KnowledgeProposalSummary {
  readonly proposalId: string; readonly runId: string; readonly updateId: string; readonly bundleId: string;
  readonly state: DurableKnowledgeProposal["state"]; readonly createdAt: string; readonly updateHash: string;
}
export interface KnowledgeProposalStatusPage { readonly total: number; readonly items: readonly KnowledgeProposalSummary[]; readonly nextCursor?: string }
export interface KnowledgeProposalServiceOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly authenticateControl: (request: KnowledgeProposalControlRequest) => string | undefined;
  readonly createProposalId?: () => string;
  readonly now?: () => string;
}
export interface KnowledgeMutationPrecondition {
  readonly bundleId: string;
  readonly providerId: string;
  readonly path: string;
  readonly policy: "automatic" | "reviewed" | "read-only";
  readonly expectedContentHash: string;
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean { const allowed = new Set([...required, ...optional]); return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key)); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sha256(domain: string, value: unknown): string { return `sha256:${createHash("sha256").update(`${domain}\0`).update(canonicalJson(value)).digest("hex")}`; }
function stableUpdateHash(update: DurableKnowledgeUpdate): string {
  const { createdAt: _createdAt, ...identity } = update;
  return sha256("pi-hive-knowledge-update-identity-v1", identity);
}
function tagged(value: string): string { return value.startsWith("sha256:") ? value : `sha256:${value}`; }
function validId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function validHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function containsControl(value: string): boolean { for (const character of value) { const code = character.codePointAt(0)!; if (code <= 0x1f || code === 0x7f) return true; } return false; }
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Knowledge update conclusion is invalid");
  const normalized = value.normalize("NFC").trim();
  if (Buffer.byteLength(normalized, "utf8") < 8 || Buffer.byteLength(normalized, "utf8") > KNOWLEDGE_PROPOSAL_LIMITS.conclusionBytes || containsControl(normalized)) throw new Error("Knowledge update conclusion is invalid or not single-line");
  return normalized;
}
function identity(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US"); }
function validateCitation(value: unknown): KnowledgeUpdateCitation {
  if (!record(value) || !exact(value, ["candidateId", "eventId", "eventHash", "payloadHash", "sourceHashes"]) || !Array.isArray(value.sourceHashes)
    || value.sourceHashes.length > KNOWLEDGE_PROPOSAL_LIMITS.sourceHashesPerCitation) throw new Error("Knowledge update citation schema is invalid");
  const candidateId = validId(value.candidateId, "Knowledge candidate ID");
  const eventId = validId(value.eventId, "Knowledge evidence event ID");
  const eventHash = typeof value.eventHash === "string" && /^[0-9a-f]{64}$/u.test(value.eventHash) ? value.eventHash : undefined;
  const payloadHash = typeof value.payloadHash === "string" && /^[0-9a-f]{64}$/u.test(value.payloadHash) ? value.payloadHash : undefined;
  if (!eventHash || !payloadHash || value.sourceHashes.some((hash) => typeof hash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(hash))) throw new Error("Knowledge update citation hashes are invalid");
  return Object.freeze({ candidateId, eventId, eventHash, payloadHash, sourceHashes: Object.freeze([...(value.sourceHashes as string[])].sort(compare)) });
}
function validateUpdate(value: DurableKnowledgeUpdate): DurableKnowledgeUpdate {
  if (!record(value) || !exact(value, ["formatVersion", "updateId", "jobId", "projectId", "sessionId", "runId", "bundleId", "providerId", "expectedContentHash", "curatorOutputHash", "conclusions", "createdAt"]) || value.formatVersion !== 1) throw new Error("Knowledge update schema has an unknown or missing field");
  for (const [label, item] of [["update ID", value.updateId], ["job ID", value.jobId], ["project ID", value.projectId], ["session ID", value.sessionId], ["run ID", value.runId], ["bundle ID", value.bundleId]] as const) validId(item, `Knowledge ${label}`);
  if (value.providerId !== "okf") throw new Error("Knowledge update provider is unsupported");
  validHash(value.expectedContentHash, "Knowledge expected content hash"); validHash(value.curatorOutputHash, "Knowledge curator output hash");
  if (!Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.conclusions) || value.conclusions.length < 1 || value.conclusions.length > KNOWLEDGE_PROPOSAL_LIMITS.conclusions) throw new Error("Knowledge update conclusions are invalid");
  const conclusions = value.conclusions.map((entry) => {
    if (!record(entry) || !exact(entry, ["text", "citations"]) || !Array.isArray(entry.citations)
      || entry.citations.length < 1 || entry.citations.length > KNOWLEDGE_PROPOSAL_LIMITS.citationsPerConclusion) throw new Error("Knowledge update conclusion provenance is invalid");
    const citations = entry.citations.map(validateCitation)
      .sort((left, right) => compare(left.candidateId, right.candidateId) || compare(left.eventId, right.eventId));
    return Object.freeze({ text: text(entry.text), citations: Object.freeze(citations) });
  });
  const normalized = Object.freeze({ ...value, conclusions: Object.freeze(conclusions) });
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > KNOWLEDGE_PROPOSAL_LIMITS.updateBytes) throw new Error("Knowledge update exceeds its byte bound");
  return normalized;
}
function declaration(snapshot: ActivationSnapshotFileV1, bundleId: string) {
  const raw = snapshot.payload.knowledge.find((entry) => entry.id === bundleId);
  if (!raw || raw.provider !== "okf" || typeof raw.path !== "string" || (raw.updates !== "automatic" && raw.updates !== "reviewed" && raw.updates !== "read-only") || (raw.owner !== undefined && typeof raw.owner !== "string")) throw new KnowledgeMutationError("BUNDLE_UNAVAILABLE", "Knowledge update bundle is unavailable in the immutable snapshot");
  return Object.freeze({ id: bundleId, providerId: "okf", path: raw.path, ...(raw.owner ? { ownerAgentId: raw.owner as string } : {}), updatePolicy: raw.updates });
}
interface ManagedSource { readonly planId: string; readonly updateId: string }
interface ManagedEntry { text: string; citations: KnowledgeUpdateCitation[]; sources: ManagedSource[] }
const CITATION_PREFIX = "  <!-- pi-hive-citations:";
function parseManaged(content: string): ManagedEntry[] | undefined {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(content)?.[1];
  if (!frontmatter || !frontmatter.split("\n").includes("pi_hive_enrichment: 1")) return undefined;
  const lines = content.split("\n");
  const entries: ManagedEntry[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^\* (.+)$/u.exec(lines[index]);
    if (!match) continue;
    const citation = lines[index + 1];
    if (!citation?.startsWith(CITATION_PREFIX) || !citation.endsWith(" -->")) return undefined;
    try {
      const encoded = citation.slice(CITATION_PREFIX.length, -4);
      const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      if (!record(parsed) || !exact(parsed, ["citations", "sources"]) || !Array.isArray(parsed.citations) || !Array.isArray(parsed.sources)
        || parsed.citations.length < 1 || parsed.citations.length > KNOWLEDGE_PROPOSAL_LIMITS.citationsPerConclusion || parsed.sources.length < 1
        || parsed.sources.length > KNOWLEDGE_PROPOSAL_LIMITS.citationsPerConclusion || entries.length >= KNOWLEDGE_PROPOSAL_LIMITS.conclusions) return undefined;
      const sources = parsed.sources.map((source) => {
        if (!record(source) || !exact(source, ["planId", "updateId"])) throw new Error("Managed source is invalid");
        return Object.freeze({ planId: validId(source.planId, "Managed curator plan ID"), updateId: validId(source.updateId, "Managed update ID") });
      });
      if (new Set(sources.map((source) => `${source.planId}\0${source.updateId}`)).size !== sources.length) return undefined;
      entries.push({ text: text(match[1]), citations: parsed.citations.map(validateCitation), sources });
      index++;
    } catch { return undefined; }
  }
  return entries.length ? entries : undefined;
}
function citationKey(citation: KnowledgeUpdateCitation): string { return `${citation.candidateId}\0${citation.eventId}\0${citation.eventHash}\0${citation.payloadHash}`; }
function sourceKey(source: ManagedSource): string { return `${source.planId}\0${source.updateId}`; }
function authoritativeUpdateSource(events: readonly WorkflowEventEnvelope[], update: DurableKnowledgeUpdate): ManagedSource {
  const state = restoreKnowledgeEnrichmentState(events);
  const plans = Object.values(state.curatorPlanHistory ?? state.curatorPlans);
  const plan = plans.find((entry) => entry.jobId === update.jobId && entry.actions.some((action) => action.kind !== "skip" && canonicalJson(action.update) === canonicalJson(update)));
  if (!plan) throw new Error("Knowledge update lacks exact authoritative durable curator plan provenance");
  return Object.freeze({ planId: plan.planId, updateId: update.updateId });
}
function managedEntriesAreAuthoritative(projectRoot: string, entries: readonly ManagedEntry[]): boolean {
  const sessionsRoot = join(projectRoot, ".pi/hive/sessions");
  if (!existsSync(sessionsRoot)) return false;
  const plans = new Map<string, import("./enrichment").DurableCuratorPlan>();
  for (const sessionId of readdirSync(sessionsRoot).sort(compare)) {
    const path = join(sessionsRoot, sessionId);
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const state = restoreKnowledgeEnrichmentState(readWorkflowJournal(projectRoot, sessionId));
    for (const plan of Object.values(state.curatorPlanHistory ?? state.curatorPlans)) plans.set(plan.planId, plan);
  }
  return entries.every((entry) => {
    const contributions: KnowledgeUpdateCitation[] = [];
    for (const source of entry.sources) {
      const action = plans.get(source.planId)?.actions.find((candidate) => candidate.kind !== "skip" && candidate.update.updateId === source.updateId);
      const conclusion = action && action.kind !== "skip" ? action.update.conclusions.find((candidate) => candidate.text === entry.text) : undefined;
      if (!conclusion) return false;
      contributions.push(...conclusion.citations);
    }
    const exactCitations = [...new Map(contributions.map((citation) => [citationKey(citation), citation])).values()]
      .sort((left, right) => compare(citationKey(left), citationKey(right)));
    return canonicalJson(exactCitations) === canonicalJson(entry.citations);
  });
}
function mergeEntries(existing: readonly ManagedEntry[], update: DurableKnowledgeUpdate, source: ManagedSource): ManagedEntry[] {
  const merged = new Map<string, ManagedEntry>();
  for (const entry of [...existing, ...update.conclusions.map((conclusion) => ({ text: conclusion.text, citations: [...conclusion.citations], sources: [source] }))]) {
    const key = identity(entry.text);
    const current = merged.get(key) ?? { text: entry.text, citations: [], sources: [] };
    if (current.text !== entry.text) throw new KnowledgeMutationError("VALIDATION_FAILED", "Managed conclusion identity cannot merge distinct exact curator text");
    const citations = new Map(current.citations.map((citation) => [citationKey(citation), citation]));
    for (const citation of entry.citations) citations.set(citationKey(citation), citation);
    const sources = new Map(current.sources.map((item) => [sourceKey(item), item]));
    for (const item of entry.sources) sources.set(sourceKey(item), item);
    current.citations = [...citations.values()].sort((left, right) => compare(citationKey(left), citationKey(right)));
    current.sources = [...sources.values()].sort((left, right) => compare(sourceKey(left), sourceKey(right)));
    if (current.citations.length > KNOWLEDGE_PROPOSAL_LIMITS.citationsPerConclusion || current.sources.length > KNOWLEDGE_PROPOSAL_LIMITS.citationsPerConclusion) {
      throw new KnowledgeMutationError("VALIDATION_FAILED", "Managed conclusion exceeds its post-merge provenance bound");
    }
    merged.set(key, current);
  }
  if (merged.size > KNOWLEDGE_PROPOSAL_LIMITS.conclusions) throw new KnowledgeMutationError("VALIDATION_FAILED", "Curated OKF document exceeds its post-merge conclusion count bound");
  return [...merged.values()].sort((left, right) => compare(identity(left.text), identity(right.text)));
}
function renderManaged(entries: readonly ManagedEntry[]): string {
  const body = entries.map((entry) => `* ${entry.text}\n${CITATION_PREFIX}${Buffer.from(canonicalJson({ citations: entry.citations, sources: entry.sources }), "utf8").toString("base64url")} -->`).join("\n\n");
  const output = `---\ntype: Knowledge\ntitle: Curated durable knowledge\ndescription: Stable conclusions curated by pi-hive with exact provenance.\ntags:\n  - curated\npi_hive_enrichment: 1\n---\n\n# Curated durable knowledge\n\n${body}\n`;
  if (Buffer.byteLength(output, "utf8") > KNOWLEDGE_PROPOSAL_LIMITS.managedDocumentBytes) throw new KnowledgeMutationError("VALIDATION_FAILED", "Curated OKF document exceeds its byte bound");
  return output;
}
function descriptorPath(directoryDescriptor: number, name?: string): string {
  const root = `/proc/self/fd/${directoryDescriptor}`;
  return name === undefined ? root : `${root}/${name}`;
}
function safePathComponent(value: string): string {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new KnowledgeMutationError("VALIDATION_FAILED", "Knowledge mutation path component is invalid");
  }
  return value;
}
function openDirectoryAt(directoryDescriptor: number, name: string, create: boolean): number {
  const path = descriptorPath(directoryDescriptor, safePathComponent(name));
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const named = lstatSync(path, { bigint: true });
  if (!named.isDirectory() || named.isSymbolicLink()) throw new Error("not a regular directory");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const pinned = fstatSync(descriptor, { bigint: true });
  if (!pinned.isDirectory() || named.dev !== pinned.dev || named.ino !== pinned.ino) {
    closeSync(descriptor);
    throw new Error("directory identity changed while opening");
  }
  return descriptor;
}
interface PinnedMutationDirectories {
  readonly projectPhysical: string;
  readonly segments: readonly string[];
  readonly descriptors: readonly number[];
  readonly stagingDescriptor: number;
  readonly validationDescriptor: number;
}
function mutationStagingRelative(sessionId: string, updateId: string): string {
  return `.pi/hive/sessions/${sessionId}/knowledge-mutations/${updateId}`;
}
function openMutationDirectories(projectRoot: string, sessionId: string, updateId: string, create: boolean, includeValidation = true): PinnedMutationDirectories {
  const projectPhysical = realpathSync.native(projectRoot);
  const descriptors: number[] = [];
  const stagingSegments = [".pi", "hive", "sessions", safePathComponent(sessionId), "knowledge-mutations", safePathComponent(updateId)];
  const segments = includeValidation ? [...stagingSegments, "validation"] : stagingSegments;
  try {
    descriptors.push(openSync(projectPhysical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    if (!fstatSync(descriptors[0]).isDirectory()) throw new Error("project root is not a directory");
    for (const segment of segments) descriptors.push(openDirectoryAt(descriptors.at(-1)!, segment, create));
    const result = Object.freeze({ projectPhysical, segments: Object.freeze(segments), descriptors: Object.freeze(descriptors),
      stagingDescriptor: descriptors[stagingSegments.length], validationDescriptor: includeValidation ? descriptors.at(-1)! : -1 });
    assertMutationDirectoriesPinned(result);
    return result;
  } catch (error) {
    for (const descriptor of descriptors.reverse()) try { closeSync(descriptor); } catch { /* best effort */ }
    if (error instanceof KnowledgeMutationError) throw error;
    throw new KnowledgeMutationError("VALIDATION_FAILED", `Knowledge mutation directories could not be securely pinned inside the project: ${String(error instanceof Error ? error.message : error)}`);
  }
}
function assertMutationDirectoriesPinned(directories: PinnedMutationDirectories): void {
  try {
    const projectNamed = lstatSync(directories.projectPhysical, { bigint: true });
    const projectPinned = fstatSync(directories.descriptors[0], { bigint: true });
    if (!projectNamed.isDirectory() || projectNamed.isSymbolicLink() || projectNamed.dev !== projectPinned.dev || projectNamed.ino !== projectPinned.ino) throw new Error("project identity changed");
    for (let index = 0; index < directories.segments.length; index++) {
      const named = lstatSync(descriptorPath(directories.descriptors[index], directories.segments[index]), { bigint: true });
      const pinned = fstatSync(directories.descriptors[index + 1], { bigint: true });
      if (!named.isDirectory() || named.isSymbolicLink() || !pinned.isDirectory() || named.dev !== pinned.dev || named.ino !== pinned.ino) throw new Error("component identity changed");
    }
  } catch (error) {
    throw new KnowledgeMutationError("VALIDATION_FAILED", `Knowledge mutation directory identity changed after secure pinning: ${String(error instanceof Error ? error.message : error)}`);
  }
}
function closeMutationDirectories(directories: PinnedMutationDirectories): void {
  for (const descriptor of [...directories.descriptors].reverse()) try { closeSync(descriptor); } catch { /* best effort */ }
}
function atomicWriteAt(directoryDescriptor: number, name: string, content: string): void {
  const target = descriptorPath(directoryDescriptor, safePathComponent(name));
  const temporaryName = `.${randomUUID()}.tmp`;
  const temporary = descriptorPath(directoryDescriptor, temporaryName);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, content); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, target); fsyncSync(directoryDescriptor);
  } finally {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* best effort */ }
    try { unlinkSync(temporary); } catch { /* published or absent */ }
  }
}
function atomicWriteRelative(directoryDescriptor: number, path: string, content: string): void {
  const components = path.split("/").map(safePathComponent);
  if (!components.length) throw new KnowledgeMutationError("VALIDATION_FAILED", "Knowledge mutation relative file path is empty");
  const opened: number[] = [];
  let parent = directoryDescriptor;
  try {
    for (const component of components.slice(0, -1)) { parent = openDirectoryAt(parent, component, true); opened.push(parent); }
    atomicWriteAt(parent, components.at(-1)!, content);
  } catch (error) {
    if (error instanceof KnowledgeMutationError) throw error;
    throw new KnowledgeMutationError("VALIDATION_FAILED", `Knowledge validation path could not be securely created: ${String(error instanceof Error ? error.message : error)}`);
  } finally { for (const descriptor of opened.reverse()) closeSync(descriptor); }
}
function entryExistsAt(directoryDescriptor: number, name: string): boolean {
  try { lstatSync(descriptorPath(directoryDescriptor, safePathComponent(name))); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function descriptorBundleHash(rootDescriptor: number, override?: Readonly<{ path: string; content: string }>): string {
  const files: Array<{ path: string; hash: string }> = [];
  let aggregateBytes = 0;
  const visit = (directoryDescriptor: number, prefix: string, closeDirectory: boolean): void => {
    try {
      const entries = readdirSync(`/proc/self/fd/${directoryDescriptor}`, { withFileTypes: true }).sort((left, right) => compare(left.name, right.name));
      for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const path = `/proc/self/fd/${directoryDescriptor}/${entry.name}`;
        const named = lstatSync(path, { bigint: true });
        if (named.isSymbolicLink() || (!named.isDirectory() && !named.isFile())) throw new KnowledgeMutationError("STALE_HASH", "Knowledge bundle entry identity changed during commit CAS");
        if (named.isDirectory()) {
          const child = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          visit(child, relativePath, true);
          continue;
        }
        if (!entry.name.endsWith(".md")) continue;
        if (files.length >= 1_024 || named.size > 262_144n) throw new KnowledgeMutationError("STALE_HASH", "Knowledge bundle exceeds its commit CAS bound");
        const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = fstatSync(file, { bigint: true });
          const bytes = readFileSync(file);
          const after = fstatSync(file, { bigint: true });
          aggregateBytes += bytes.length;
          if (!before.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
            || BigInt(bytes.length) !== after.size || aggregateBytes > 8_388_608) throw new KnowledgeMutationError("STALE_HASH", "Knowledge bundle bytes changed during commit CAS");
          files.push({ path: relativePath, hash: createHash("sha256").update(relativePath === override?.path ? override.content : bytes).digest("hex") });
        } finally { closeSync(file); }
      }
    } finally { if (closeDirectory) closeSync(directoryDescriptor); }
  };
  visit(rootDescriptor, "", false);
  if (override && !files.some((file) => file.path === override.path)) files.push({ path: override.path, hash: createHash("sha256").update(override.content).digest("hex") });
  const hash = createHash("sha256").update("pi-hive-knowledge-bundle-v1\0");
  for (const file of files.sort((left, right) => compare(left.path, right.path))) hash.update(file.path).update("\0").update(file.hash).update("\0");
  return `sha256:${hash.digest("hex")}`;
}
function sameMutationPublication(left: KnowledgeMutationResult | undefined, right: KnowledgeMutationResult): boolean {
  return Boolean(left) && left!.updateId === right.updateId && left!.bundleId === right.bundleId && left!.changed === right.changed && left!.contentHash === right.contentHash
    && left!.documentId === right.documentId && left!.conclusionCount === right.conclusionCount;
}
function updateAlreadyPresent(entries: readonly ManagedEntry[], update: DurableKnowledgeUpdate): boolean {
  return update.conclusions.every((conclusion) => {
    const existing = entries.find((entry) => identity(entry.text) === identity(conclusion.text));
    if (!existing) return false;
    const keys = new Set(existing.citations.map(citationKey));
    return conclusion.citations.every((citation) => keys.has(citationKey(citation)));
  });
}
interface StagingIdentity { readonly device: string; readonly inode: string; readonly size: number }
type MutationRollback = Readonly<{ existed: false }> | Readonly<{ existed: true; path: string; contentHash: string; identity: StagingIdentity }>;
interface MutationProgress {
  intent?: Readonly<{
    updateIdentityHash: string; renderedHash: string; targetPath: string;
    baseBundleHash: string; expectedPublishedBundleHash: string; expectedResult: KnowledgeMutationResult; rollback: MutationRollback;
  }>;
  staged?: StagingIdentity;
  validated?: StagingIdentity;
  committed?: KnowledgeMutationResult;
}
function stagingIdentity(value: unknown): StagingIdentity {
  if (!record(value) || !exact(value, ["device", "inode", "size"]) || typeof value.device !== "string" || !/^[0-9]+$/u.test(value.device)
    || typeof value.inode !== "string" || !/^[0-9]+$/u.test(value.inode) || !Number.isSafeInteger(value.size) || Number(value.size) < 0
    || Number(value.size) > KNOWLEDGE_PROPOSAL_LIMITS.managedDocumentBytes) throw new Error("Knowledge mutation staging file identity is invalid");
  return Object.freeze({ device: value.device, inode: value.inode, size: Number(value.size) });
}
function sameStagingIdentity(left: StagingIdentity, right: StagingIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size;
}
function rollbackMaterial(value: unknown, expectedPath: string): MutationRollback {
  if (!record(value) || typeof value.existed !== "boolean") throw new Error("Knowledge mutation rollback material is invalid");
  if (!value.existed) {
    if (!exact(value, ["existed"])) throw new Error("Knowledge mutation rollback absence identity is invalid");
    return Object.freeze({ existed: false });
  }
  if (!exact(value, ["existed", "path", "contentHash", "identity"]) || value.path !== expectedPath
    || typeof value.contentHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value.contentHash)) throw new Error("Knowledge mutation rollback identity is invalid");
  return Object.freeze({ existed: true, path: expectedPath, contentHash: value.contentHash, identity: stagingIdentity(value.identity) });
}
function inspectStagingAt(directoryDescriptor: number, name: string, expectedHash: string, expectedContent: string | undefined, expectedIdentity?: StagingIdentity): Readonly<{ content: string; identity: StagingIdentity }> {
  let descriptor: number | undefined;
  try {
    const path = descriptorPath(directoryDescriptor, safePathComponent(name));
    const named = lstatSync(path, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink()) throw new KnowledgeMutationError("VALIDATION_FAILED", "Knowledge mutation staging is not a regular non-link file");
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(KNOWLEDGE_PROPOSAL_LIMITS.managedDocumentBytes) || named.dev !== before.dev || named.ino !== before.ino) throw new KnowledgeMutationError("VALIDATION_FAILED", "Knowledge mutation staging is not a bounded regular file with stable identity");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const identity = Object.freeze({ device: String(after.dev), inode: String(after.ino), size: Number(after.size) });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || BigInt(bytes.length) !== after.size
      || (expectedIdentity && !sameStagingIdentity(identity, expectedIdentity))
      || sha256("pi-hive-knowledge-staged-bytes-v1", bytes.toString("utf8")) !== expectedHash || (expectedContent !== undefined && bytes.toString("utf8") !== expectedContent)) {
      throw new KnowledgeMutationError("VALIDATION_FAILED", "Knowledge mutation staging bytes or file identity changed before publication");
    }
    return Object.freeze({ content: bytes.toString("utf8"), identity });
  } catch (error) {
    if (error instanceof KnowledgeMutationError) throw error;
    throw new KnowledgeMutationError("VALIDATION_FAILED", `Knowledge mutation staging could not be opened without following links: ${String(error instanceof Error ? error.message : error)}`);
  } finally { if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* best effort */ } }
}
function restoreMutationProgress(events: readonly WorkflowEventEnvelope[], update: DurableKnowledgeUpdate): MutationProgress {
  const progress: MutationProgress = {};
  const stagingRoot = mutationStagingRelative(update.sessionId, update.updateId);
  for (const event of events) {
    if (event.type !== "knowledge.transition" || !record(event.payload) || !String(event.payload.operation).startsWith("mutation-")) continue;
    if (event.payload.updateId !== update.updateId) continue;
    if (event.projectId !== update.projectId || event.sessionId !== update.sessionId || event.runId !== update.runId || event.producer !== "harness" || event.payload.formatVersion !== 1) throw new Error("Knowledge mutation event envelope identity is invalid");
    if (event.payload.operation === "mutation-intent") {
      if (!exact(event.payload, ["formatVersion", "operation", "updateId", "updateIdentityHash", "bundleId", "targetPath", "renderedHash", "expectedContentHash", "baseBundleHash", "expectedPublishedBundleHash", "expectedResult", "rollback"]) || progress.intent
        || event.payload.updateIdentityHash !== stableUpdateHash(update) || event.payload.bundleId !== update.bundleId || event.payload.expectedContentHash !== update.expectedContentHash
        || event.payload.baseBundleHash !== update.expectedContentHash || typeof event.payload.targetPath !== "string"
        || typeof event.payload.renderedHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(event.payload.renderedHash)
        || typeof event.payload.expectedPublishedBundleHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(event.payload.expectedPublishedBundleHash)
        || !record(event.payload.expectedResult) || !exact(event.payload.expectedResult, ["updateId", "bundleId", "changed", "contentHash", "documentId", "conclusionCount"])
        || event.payload.expectedResult.updateId !== update.updateId || event.payload.expectedResult.bundleId !== update.bundleId || event.payload.expectedResult.changed !== true
        || event.payload.expectedResult.contentHash !== event.payload.expectedPublishedBundleHash || event.payload.expectedResult.documentId !== "curated"
        || !Number.isSafeInteger(event.payload.expectedResult.conclusionCount) || Number(event.payload.expectedResult.conclusionCount) < 1
        || Number(event.payload.expectedResult.conclusionCount) > KNOWLEDGE_PROPOSAL_LIMITS.conclusions) throw new Error("Knowledge mutation intent identity is invalid");
      progress.intent = Object.freeze({
        updateIdentityHash: event.payload.updateIdentityHash as string, renderedHash: event.payload.renderedHash as string, targetPath: event.payload.targetPath,
        baseBundleHash: event.payload.baseBundleHash, expectedPublishedBundleHash: event.payload.expectedPublishedBundleHash,
        expectedResult: Object.freeze(structuredClone(event.payload.expectedResult)) as unknown as KnowledgeMutationResult,
        rollback: rollbackMaterial(event.payload.rollback, `${stagingRoot}/rollback.md`),
      });
    } else if (event.payload.operation === "mutation-staged") {
      if (!exact(event.payload, ["formatVersion", "operation", "updateId", "renderedHash", "stagingPath", "stagingIdentity"]) || !progress.intent || progress.staged || event.payload.renderedHash !== progress.intent.renderedHash || event.payload.stagingPath !== `${stagingRoot}/curated.md`) throw new Error("Knowledge mutation staging identity is invalid");
      progress.staged = stagingIdentity(event.payload.stagingIdentity);
    } else if (event.payload.operation === "mutation-validated") {
      if (!exact(event.payload, ["formatVersion", "operation", "updateId", "renderedHash", "stagingIdentity"]) || !progress.staged || progress.validated || event.payload.renderedHash !== progress.intent?.renderedHash) throw new Error("Knowledge mutation validation identity is invalid");
      const validatedIdentity = stagingIdentity(event.payload.stagingIdentity);
      if (!sameStagingIdentity(validatedIdentity, progress.staged)) throw new Error("Knowledge mutation validated a different staging file identity");
      progress.validated = validatedIdentity;
    } else if (event.payload.operation === "mutation-committed") {
      if (!exact(event.payload, ["formatVersion", "operation", "updateId", "renderedHash", "result"]) || !progress.validated || progress.committed || event.payload.renderedHash !== progress.intent?.renderedHash || !record(event.payload.result)) throw new Error("Knowledge mutation commit identity is invalid");
      const result = event.payload.result as unknown as KnowledgeMutationResult;
      if (!progress.intent || canonicalJson(result) !== canonicalJson(progress.intent.expectedResult)) throw new Error("Knowledge mutation committed result is not exactly derived from its durable intent");
      progress.committed = Object.freeze(structuredClone(result));
    } else throw new Error("Unknown knowledge mutation operation");
  }
  return progress;
}

interface PreparedKnowledgeMutation {
  readonly update: DurableKnowledgeUpdate;
  readonly declared: ReturnType<typeof declaration>;
  readonly initialCanonicalRoot: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly target: string;
}
interface PreparedKnowledgePrecondition {
  readonly input: KnowledgeMutationPrecondition;
  readonly declared: ReturnType<typeof declaration>;
  readonly initialCanonicalRoot: string;
  readonly target: string;
}

export class OkfKnowledgeMutator {
  readonly options: OkfKnowledgeMutatorOptions;
  private readonly providers: KnowledgeProviderRegistry;
  constructor(options: OkfKnowledgeMutatorOptions) { this.options = options; this.providers = options.providers ?? createBuiltInKnowledgeProviderRegistry(); }

  private prepare(rawUpdate: DurableKnowledgeUpdate): PreparedKnowledgeMutation {
    const update = validateUpdate(rawUpdate);
    if (this.options.snapshot.payload.project.projectId !== update.projectId) throw new KnowledgeMutationError("BUNDLE_UNAVAILABLE", "Knowledge update project identity differs from the immutable snapshot");
    const declared = declaration(this.options.snapshot, update.bundleId);
    if (declared.updatePolicy === "read-only") throw new KnowledgeMutationError("READ_ONLY", "Read-only knowledge bundle records an audit skip and cannot be mutated");
    if (!this.options.mutationQueue) throw new KnowledgeMutationError("MUTATION_QUEUE_REQUIRED", "Knowledge mutation requires Pi's file mutation queue");
    const initial = this.providers.load({ projectRoot: this.options.projectRoot, declaration: declared });
    if (!initial.ok || !initial.bundle) throw new KnowledgeMutationError("BUNDLE_UNAVAILABLE", "Knowledge bundle failed provider validation before mutation");
    if (initial.bundle.providerId !== update.providerId) throw new KnowledgeMutationError("BUNDLE_UNAVAILABLE", "Knowledge update provider identity changed");
    const root = lstatSync(initial.bundle.canonicalRoot, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink()) throw new KnowledgeMutationError("BUNDLE_UNAVAILABLE", "Knowledge bundle root identity is not a regular directory");
    return Object.freeze({ update, declared, initialCanonicalRoot: initial.bundle.canonicalRoot, rootDevice: String(root.dev), rootInode: String(root.ino), target: join(initial.bundle.canonicalRoot, "curated.md") });
  }

  async apply(rawUpdate: DurableKnowledgeUpdate): Promise<KnowledgeMutationResult> {
    let prepared: PreparedKnowledgeMutation;
    try { prepared = this.prepare(rawUpdate); }
    catch (error) {
      if (!(error instanceof KnowledgeMutationError) || error.code !== "BUNDLE_UNAVAILABLE") throw error;
      const update = validateUpdate(rawUpdate);
      const declared = declaration(this.options.snapshot, update.bundleId);
      if (!this.options.mutationQueue) throw error;
      const root = resolveContainedPath(this.options.projectRoot, join(this.options.projectRoot, declared.path));
      const target = root ? join(root.canonicalPath, "curated.md") : undefined;
      const progress = restoreMutationProgress(readWorkflowJournal(this.options.projectRoot, update.sessionId), update);
      if (!root || !target || !progress.intent || !progress.validated || progress.committed) throw error;
      const rootPath = root.canonicalPath;
      return this.options.mutationQueue(target, update.updateId, () => withCrossProcessFileLockAsync(target, () => {
        let directory: number | undefined;
        let mutationDirectories: PinnedMutationDirectories | undefined;
        try {
          mutationDirectories = openMutationDirectories(this.options.projectRoot, update.sessionId, update.updateId, false, false);
          directory = openSync(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          assertMutationDirectoriesPinned(mutationDirectories);
          inspectStagingAt(directory, "curated.md", progress.intent!.renderedHash, undefined, progress.validated);
          if (!progress.intent!.rollback.existed) unlinkSync(descriptorPath(directory, "curated.md"));
          else {
            try {
              const material = inspectStagingAt(mutationDirectories.stagingDescriptor, "rollback.md", progress.intent!.rollback.contentHash, undefined, progress.intent!.rollback.identity);
              assertMutationDirectoriesPinned(mutationDirectories);
              atomicWriteAt(directory, "curated.md", material.content);
            } catch (rollbackError) {
              try { unlinkSync(descriptorPath(directory, "curated.md")); } catch { /* already absent */ }
              fsyncSync(directory);
              throw new KnowledgeMutationError("VALIDATION_FAILED", `Unavailable bundle rollback material failed closed: ${String(rollbackError instanceof Error ? rollbackError.message : rollbackError)}`);
            }
          }
          fsyncSync(directory);
          throw new KnowledgeMutationError("STALE_HASH", "Unavailable post-publication bundle was rolled back before curator plan recovery");
        } finally {
          if (directory !== undefined) closeSync(directory);
          if (mutationDirectories !== undefined) closeMutationDirectories(mutationDirectories);
        }
      }, { timeoutMs: 5_000, staleMs: 30_000 }));
    }
    return this.options.mutationQueue!(prepared.target, prepared.update.updateId, () => withCrossProcessFileLockAsync(
      prepared.target, () => this.applyPrepared(prepared), { timeoutMs: 5_000, staleMs: 30_000 },
    ));
  }

  authoritativeResult(rawUpdate: DurableKnowledgeUpdate): KnowledgeMutationResult | undefined {
    const update = validateUpdate(rawUpdate);
    return restoreMutationProgress(readWorkflowJournal(this.options.projectRoot, update.sessionId), update).committed;
  }

  async applyConsistent(updates: readonly DurableKnowledgeUpdate[], preconditions: readonly KnowledgeMutationPrecondition[]): Promise<readonly KnowledgeMutationResult[]> {
    if (!updates.length || !preconditions.length || !this.options.mutationQueue) throw new KnowledgeMutationError("MUTATION_QUEUE_REQUIRED", "Consistent knowledge mutation requires at least one update and Pi's file mutation queue");
    if (updates.length > 1 || preconditions.length > 1) throw new KnowledgeMutationError("VALIDATION_FAILED", "Multi-target automatic publication is prohibited; persist one exact reviewed curator plan instead");
    const preparedUpdates = updates.map((update) => this.prepare(update));
    const preparedTargets: PreparedKnowledgePrecondition[] = preconditions.map((input) => {
      validId(input.bundleId, "Knowledge precondition bundle ID"); validHash(input.expectedContentHash, "Knowledge precondition content hash");
      const declared = declaration(this.options.snapshot, input.bundleId);
      if (declared.providerId !== input.providerId || declared.path !== input.path || declared.updatePolicy !== input.policy) throw new KnowledgeMutationError("BUNDLE_UNAVAILABLE", "Knowledge target-set precondition diverges from the immutable snapshot");
      const loaded = this.providers.load({ projectRoot: this.options.projectRoot, declaration: declared });
      if (!loaded.ok || !loaded.bundle || loaded.bundle.providerId !== input.providerId) throw new KnowledgeMutationError("BUNDLE_UNAVAILABLE", "Knowledge target-set precondition failed provider validation");
      return Object.freeze({ input, declared, initialCanonicalRoot: loaded.bundle.canonicalRoot, target: join(loaded.bundle.canonicalRoot, "curated.md") });
    }).sort((left, right) => compare(left.target, right.target));
    if (new Set(preparedTargets.map((entry) => entry.target)).size !== preparedTargets.length
      || preparedUpdates.some((update) => !preparedTargets.some((target) => target.input.bundleId === update.update.bundleId && target.input.expectedContentHash === update.update.expectedContentHash))) {
      throw new KnowledgeMutationError("BUNDLE_UNAVAILABLE", "Knowledge target-set preconditions are duplicated or incomplete");
    }
    const operationId = `knowledge-target-set-${createHash("sha256").update(preparedUpdates.map((entry) => entry.update.updateId).sort(compare).join("\0")).digest("hex").slice(0, 48)}`;
    const execute = async (): Promise<readonly KnowledgeMutationResult[]> => {
      for (const target of preparedTargets) {
        const loaded = this.providers.load({ projectRoot: this.options.projectRoot, declaration: target.declared });
        if (!loaded.ok || !loaded.bundle || realpathSync.native(loaded.bundle.canonicalRoot) !== realpathSync.native(target.initialCanonicalRoot)
          || tagged(loaded.bundle.contentHash) !== target.input.expectedContentHash) throw new KnowledgeMutationError("STALE_HASH", "Knowledge target set changed before any automatic effect; reload and re-evaluate");
      }
      const results: KnowledgeMutationResult[] = [];
      for (const update of preparedUpdates) results.push(await this.applyPrepared(update));
      return Object.freeze(results);
    };
    const withLocks = (index: number): Promise<readonly KnowledgeMutationResult[]> => index >= preparedTargets.length ? execute()
      : withCrossProcessFileLockAsync(preparedTargets[index].target, () => withLocks(index + 1), { timeoutMs: 5_000, staleMs: 30_000 });
    const withQueues = (index: number): Promise<readonly KnowledgeMutationResult[]> => index >= preparedTargets.length ? withLocks(0)
      : this.options.mutationQueue!(preparedTargets[index].target, operationId, () => withQueues(index + 1));
    return withQueues(0);
  }

  private async applyPrepared(prepared: PreparedKnowledgeMutation): Promise<KnowledgeMutationResult> {
      const { update, declared, initialCanonicalRoot, rootDevice, rootInode, target } = prepared;
      const current = this.providers.load({ projectRoot: this.options.projectRoot, declaration: declared });
      if (!current.ok || !current.bundle || realpathSync.native(current.bundle.canonicalRoot) !== realpathSync.native(initialCanonicalRoot)) throw new KnowledgeMutationError("BUNDLE_UNAVAILABLE", "Knowledge bundle identity changed before mutation");
      const existingContent = existsSync(target) ? (() => { const stat = lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > KNOWLEDGE_PROPOSAL_LIMITS.managedDocumentBytes) throw new KnowledgeMutationError("TARGET_UNMANAGED", "Curated knowledge target is not a bounded regular file"); return readFileSync(target, "utf8"); })() : undefined;
      const existingEntries = existingContent === undefined ? [] : parseManaged(existingContent);
      if (existingContent !== undefined && (!existingEntries || !managedEntriesAreAuthoritative(this.options.projectRoot, existingEntries))) {
        throw new KnowledgeMutationError("TARGET_UNMANAGED", "Existing curated knowledge target lacks exact authoritative managed text, citation, plan, and update provenance");
      }
      const journal = readWorkflowJournal(this.options.projectRoot, update.sessionId);
      const source = authoritativeUpdateSource(journal, update);
      const priorProgress = restoreMutationProgress(journal, update);
      if (priorProgress.committed) return Object.freeze({ ...priorProgress.committed, changed: false });
      if (tagged(current.bundle.contentHash) !== update.expectedContentHash) {
        if (!priorProgress.intent && existingEntries && updateAlreadyPresent(existingEntries, update)) return Object.freeze({ updateId: update.updateId, bundleId: update.bundleId, changed: false, contentHash: tagged(current.bundle.contentHash), documentId: "curated" as const, conclusionCount: existingEntries.length });
        const exactPublishedIntent = priorProgress.intent !== undefined && existingContent !== undefined && existingEntries !== undefined
          && updateAlreadyPresent(existingEntries, update)
          && sha256("pi-hive-knowledge-staged-bytes-v1", existingContent) === priorProgress.intent.renderedHash;
        if (!exactPublishedIntent) throw new KnowledgeMutationError("STALE_HASH", "Knowledge bundle input hash changed after durable intent; reload and re-evaluate before publication");
      }
      const merged = mergeEntries(existingEntries ?? [], update, source);
      if (!priorProgress.intent && existingEntries && updateAlreadyPresent(existingEntries, update)) return Object.freeze({ updateId: update.updateId, bundleId: update.bundleId, changed: false, contentHash: tagged(current.bundle.contentHash), documentId: "curated" as const, conclusionCount: existingEntries.length });
      const rendered = renderManaged(merged);
      const renderedHash = sha256("pi-hive-knowledge-staged-bytes-v1", rendered);
      const targetPath = `${declared.path}/curated.md`;
      const contained = resolveContainedPath(current.bundle.canonicalRoot, target, { allowMissing: true });
      if (!contained || contained.canonicalPath !== target) throw new KnowledgeMutationError("BUNDLE_UNAVAILABLE", "Knowledge mutation target escaped its provider root");
      const stagingRelative = mutationStagingRelative(update.sessionId, update.updateId);
      const validationRelative = `${stagingRelative}/validation`;
      const mutationDirectories = openMutationDirectories(this.options.projectRoot, update.sessionId, update.updateId, true);
      try {
      let progress = priorProgress;
      const append = (operation: string, payload: Record<string, JsonValue>): void => {
        assertMutationDirectoriesPinned(mutationDirectories);
        appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
          projectId: update.projectId, sessionId: update.sessionId, runId: update.runId, type: "knowledge.transition", producer: "harness", correlationId: update.updateId,
          payload: { formatVersion: 1, operation, updateId: update.updateId, ...payload } as JsonValue,
        }), (events) => {
          const locked = restoreMutationProgress(events, update);
          if (operation === "mutation-intent" ? Boolean(locked.intent) : operation === "mutation-staged" ? Boolean(locked.staged) : operation === "mutation-validated" ? Boolean(locked.validated) : Boolean(locked.committed)) throw new Error(`Knowledge ${operation} is already durable`);
        });
      };
      if (!progress.intent) {
        let rollbackIntent: MutationRollback = Object.freeze({ existed: false });
        if (existingContent !== undefined) {
          assertMutationDirectoriesPinned(mutationDirectories);
          atomicWriteAt(mutationDirectories.stagingDescriptor, "rollback.md", existingContent);
          const rollbackHash = sha256("pi-hive-knowledge-staged-bytes-v1", existingContent);
          const sealedRollback = inspectStagingAt(mutationDirectories.stagingDescriptor, "rollback.md", rollbackHash, existingContent);
          rollbackIntent = Object.freeze({ existed: true, path: `${stagingRelative}/rollback.md`, contentHash: rollbackHash, identity: sealedRollback.identity });
        }
        let descriptor: number | undefined;
        let expectedPublishedBundleHash: string;
        try {
          descriptor = openSync(initialCanonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          const stat = fstatSync(descriptor, { bigint: true });
          if (!stat.isDirectory() || String(stat.dev) !== rootDevice || String(stat.ino) !== rootInode
            || descriptorBundleHash(descriptor) !== update.expectedContentHash) throw new KnowledgeMutationError("STALE_HASH", "Knowledge complete bundle changed before durable mutation intent");
          expectedPublishedBundleHash = descriptorBundleHash(descriptor, { path: "curated.md", content: rendered });
        } finally { if (descriptor !== undefined) closeSync(descriptor); }
        const expectedResult: KnowledgeMutationResult = Object.freeze({ updateId: update.updateId, bundleId: update.bundleId, changed: true,
          contentHash: expectedPublishedBundleHash, documentId: "curated", conclusionCount: merged.length });
        append("mutation-intent", {
          updateIdentityHash: stableUpdateHash(update), bundleId: update.bundleId, targetPath, renderedHash,
          expectedContentHash: update.expectedContentHash, baseBundleHash: update.expectedContentHash, expectedPublishedBundleHash,
          expectedResult: expectedResult as unknown as JsonValue, rollback: rollbackIntent as unknown as JsonValue,
        });
        this.options.fault?.("after-intent");
        progress = restoreMutationProgress(readWorkflowJournal(this.options.projectRoot, update.sessionId), update);
      } else if (progress.intent.targetPath !== targetPath || progress.intent.updateIdentityHash !== stableUpdateHash(update)
        || (progress.intent.rollback.existed && progress.intent.rollback.path !== `${stagingRelative}/rollback.md`)) {
        throw new KnowledgeMutationError("VALIDATION_FAILED", "Knowledge mutation recovery identity differs from its durable intent");
      } else if (progress.intent.renderedHash !== renderedHash) {
        throw new KnowledgeMutationError("STALE_HASH", "Knowledge target changed after durable mutation intent; reload and re-evaluate without overwriting");
      }
      if (!progress.staged) {
        assertMutationDirectoriesPinned(mutationDirectories);
        atomicWriteAt(mutationDirectories.stagingDescriptor, "curated.md", rendered);
        const stagedFile = inspectStagingAt(mutationDirectories.stagingDescriptor, "curated.md", renderedHash, rendered);
        append("mutation-staged", { renderedHash, stagingPath: `${stagingRelative}/curated.md`, stagingIdentity: stagedFile.identity as unknown as JsonValue });
        this.options.fault?.("after-stage");
        progress = restoreMutationProgress(readWorkflowJournal(this.options.projectRoot, update.sessionId), update);
      }
      let targetDirectory: number | undefined;
      try {
        targetDirectory = openSync(initialCanonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const directoryStat = fstatSync(targetDirectory, { bigint: true });
        const targetDescriptorPath = descriptorPath(targetDirectory);
        assertMutationDirectoriesPinned(mutationDirectories);
        if (!directoryStat.isDirectory() || String(directoryStat.dev) !== rootDevice || String(directoryStat.ino) !== rootInode || realpathSync.native(targetDescriptorPath) !== realpathSync.native(initialCanonicalRoot)) {
          throw new KnowledgeMutationError("BUNDLE_UNAVAILABLE", "Knowledge mutation bundle directory identity changed before validation");
        }
        const completeBundleBaseHash = progress.intent!.baseBundleHash;
        const expectedPublishedBundleHash = progress.intent!.expectedPublishedBundleHash;
        const descriptorTarget = descriptorPath(targetDirectory, "curated.md");
        const rollbackPublication = (): boolean => {
          try { inspectStagingAt(targetDirectory!, "curated.md", renderedHash, rendered, progress.validated); } catch { return false; }
          if (!progress.intent!.rollback.existed) {
            unlinkSync(descriptorTarget);
          } else {
            try {
              assertMutationDirectoriesPinned(mutationDirectories);
              const material = inspectStagingAt(mutationDirectories.stagingDescriptor, "rollback.md", progress.intent!.rollback.contentHash, undefined, progress.intent!.rollback.identity);
              atomicWriteAt(targetDirectory!, "curated.md", material.content);
            } catch (error) {
              try { unlinkSync(descriptorTarget); } catch { /* already absent */ }
              fsyncSync(targetDirectory!);
              throw new KnowledgeMutationError("VALIDATION_FAILED", `Knowledge rollback material failed closed after publication: ${String(error instanceof Error ? error.message : error)}`);
            }
          }
          fsyncSync(targetDirectory!);
          return true;
        };
        let completeBundleHash = descriptorBundleHash(targetDirectory);
        let publicationAlreadyLive = false;
        if (completeBundleHash === expectedPublishedBundleHash && progress.validated) {
          try {
            inspectStagingAt(targetDirectory, "curated.md", renderedHash, rendered, progress.validated);
            publicationAlreadyLive = true;
          } catch { /* same aggregate hash is not sufficient without the exact validated inode */ }
        }
        if (completeBundleHash !== completeBundleBaseHash && !publicationAlreadyLive) {
          if (progress.validated && rollbackPublication()) completeBundleHash = descriptorBundleHash(targetDirectory);
          throw new KnowledgeMutationError("STALE_HASH", completeBundleHash === completeBundleBaseHash
            ? "Knowledge post-publication bundle drift was rolled back before durable accounting"
            : "Knowledge complete bundle changed after durable intent; stale publication was not committed");
        }
        if (!progress.validated) {
          if (!progress.staged) throw new KnowledgeMutationError("VALIDATION_FAILED", "Knowledge mutation staging identity is not durable");
          assertMutationDirectoriesPinned(mutationDirectories);
          const stagedFile = inspectStagingAt(mutationDirectories.stagingDescriptor, "curated.md", renderedHash, rendered, progress.staged);
          for (const document of current.bundle.documents) {
            atomicWriteRelative(mutationDirectories.validationDescriptor, `${document.id}.md`, document.id === "curated" ? stagedFile.content : document.content);
          }
          if (!current.bundle.documents.some((document) => document.id === "curated")) atomicWriteAt(mutationDirectories.validationDescriptor, "curated.md", stagedFile.content);
          assertMutationDirectoriesPinned(mutationDirectories);
          const staged = this.providers.load({ projectRoot: this.options.projectRoot, declaration: { ...declared, path: validationRelative } });
          assertMutationDirectoriesPinned(mutationDirectories);
          if (!staged.ok || !staged.bundle || staged.bundle.documents.length !== current.bundle.documents.length + (current.bundle.documents.some((document) => document.id === "curated") ? 0 : 1)
            || !staged.bundle.documents.some((document) => document.id === "curated" && document.content === stagedFile.content)) throw new KnowledgeMutationError("VALIDATION_FAILED", "Complete staged bundle bytes failed provider validation before publication");
          append("mutation-validated", { renderedHash, stagingIdentity: stagedFile.identity as unknown as JsonValue });
          this.options.fault?.("after-validation");
          progress = restoreMutationProgress(readWorkflowJournal(this.options.projectRoot, update.sessionId), update);
        }
        if (!publicationAlreadyLive && descriptorBundleHash(targetDirectory) !== completeBundleBaseHash) {
          throw new KnowledgeMutationError("STALE_HASH", "Knowledge complete bundle changed after validation; automatic publication was not committed");
        }
        if (!progress.committed) {
          if (!progress.validated) throw new KnowledgeMutationError("VALIDATION_FAILED", "Knowledge mutation validation identity is not durable");
          assertMutationDirectoriesPinned(mutationDirectories);
          if (entryExistsAt(mutationDirectories.stagingDescriptor, "publication.md")) {
            inspectStagingAt(mutationDirectories.stagingDescriptor, "publication.md", renderedHash, rendered, progress.validated);
          } else if (entryExistsAt(mutationDirectories.stagingDescriptor, "curated.md")) {
            inspectStagingAt(mutationDirectories.stagingDescriptor, "curated.md", renderedHash, rendered, progress.validated);
            try { linkSync(descriptorPath(mutationDirectories.stagingDescriptor, "curated.md"), descriptorPath(mutationDirectories.stagingDescriptor, "publication.md")); }
            catch (error) { throw new KnowledgeMutationError("VALIDATION_FAILED", `Validated staging identity could not be sealed for publication: ${String(error instanceof Error ? error.message : error)}`); }
            inspectStagingAt(mutationDirectories.stagingDescriptor, "publication.md", renderedHash, rendered, progress.validated);
          } else if (!(existingEntries && updateAlreadyPresent(existingEntries, update))) {
            throw new KnowledgeMutationError("VALIDATION_FAILED", "Validated staging bytes are missing during recovery");
          }
          if (entryExistsAt(mutationDirectories.stagingDescriptor, "publication.md")) {
            try { unlinkSync(descriptorPath(mutationDirectories.stagingDescriptor, "curated.md")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            fsyncSync(mutationDirectories.stagingDescriptor);
            inspectStagingAt(mutationDirectories.stagingDescriptor, "publication.md", renderedHash, rendered, progress.validated);
            assertMutationDirectoriesPinned(mutationDirectories);
            if (descriptorBundleHash(targetDirectory) !== completeBundleBaseHash) throw new KnowledgeMutationError("STALE_HASH", "Knowledge complete-bundle commit CAS was lost before publication");
            renameSync(descriptorPath(mutationDirectories.stagingDescriptor, "publication.md"), descriptorPath(targetDirectory, "curated.md"));
            fsyncSync(targetDirectory);
            this.options.fault?.("after-publication");
            if (descriptorBundleHash(targetDirectory) !== expectedPublishedBundleHash) {
              rollbackPublication();
              throw new KnowledgeMutationError("STALE_HASH", "Knowledge complete bundle changed across publication; stale bytes were rolled back before durable commit");
            }
          }
          const validated = this.providers.load({ projectRoot: this.options.projectRoot, declaration: declared });
          if (!validated.ok || !validated.bundle || tagged(validated.bundle.contentHash) !== expectedPublishedBundleHash
            || !validated.bundle.documents.some((document) => document.id === "curated" && document.content === rendered)) {
            if (descriptorBundleHash(targetDirectory) !== expectedPublishedBundleHash) {
              rollbackPublication();
              throw new KnowledgeMutationError("STALE_HASH", "Knowledge complete bundle changed during commit reload; stale bytes were rolled back");
            }
            throw new KnowledgeMutationError("VALIDATION_FAILED", "Atomically published validated complete-bundle bytes could not be reloaded");
          }
          const result = progress.intent!.expectedResult;
          if (tagged(validated.bundle.contentHash) !== result.contentHash || merged.length !== result.conclusionCount
            || descriptorBundleHash(targetDirectory) !== expectedPublishedBundleHash) {
            rollbackPublication();
            throw new KnowledgeMutationError("STALE_HASH", "Knowledge complete-bundle commit identity changed before durable publication");
          }
          append("mutation-committed", { renderedHash, result: result as unknown as JsonValue });
          this.options.fault?.("after-commit");
          return result;
        }
        return progress.committed;
      } finally {
        if (targetDirectory !== undefined) closeSync(targetDirectory);
      }
      } finally { closeMutationDirectories(mutationDirectories); }
  }
}

function assertAuthoritativeProposalUpdate(events: readonly WorkflowEventEnvelope[], update: DurableKnowledgeUpdate): void {
  const state = restoreKnowledgeEnrichmentState(events);
  const job = state.jobs[update.jobId];
  const plan = state.curatorPlans[update.jobId];
  const action = plan?.actions.find((entry) => entry.kind === "proposal" && entry.bundleId === update.bundleId);
  if (!job || !plan || !action || action.kind !== "proposal" || job.projectId !== update.projectId || job.sessionId !== update.sessionId || job.runId !== update.runId
    || canonicalJson(action.update) !== canonicalJson(update)) throw new Error("Knowledge proposal update lacks exact authoritative job, target, plan, candidate, or citation provenance");
}
function proposalFrom(value: unknown): DurableKnowledgeProposal {
  if (!record(value) || !exact(value, ["formatVersion", "proposalId", "projectId", "sessionId", "runId", "update", "updateHash", "state", "createdAt"])
    || value.formatVersion !== 1 || value.state !== "pending" || !Number.isFinite(Date.parse(String(value.createdAt)))) throw new Error("Knowledge proposal schema or field is invalid");
  validId(value.proposalId, "Knowledge proposal ID"); validId(value.projectId, "Knowledge proposal project ID"); validId(value.sessionId, "Knowledge proposal session ID"); validId(value.runId, "Knowledge proposal run ID");
  const update = validateUpdate(value.update as DurableKnowledgeUpdate);
  const updateHash = validHash(value.updateHash, "Knowledge proposal update hash");
  if (updateHash !== stableUpdateHash(update) || update.projectId !== value.projectId || update.sessionId !== value.sessionId || update.runId !== value.runId) throw new Error("Knowledge proposal update provenance is invalid");
  if (Buffer.byteLength(canonicalJson(value), "utf8") > KNOWLEDGE_PROPOSAL_LIMITS.proposalBytes) throw new Error("Knowledge proposal exceeds its bound");
  return Object.freeze(structuredClone(value)) as unknown as DurableKnowledgeProposal;
}
export function restoreKnowledgeProposalState(events: readonly WorkflowEventEnvelope[]): KnowledgeProposalState {
  const proposals: Record<string, DurableKnowledgeProposal> = {};
  for (const event of events) {
    if (event.type !== "knowledge.transition" || !record(event.payload)) continue;
    if (event.payload.operation === "proposal-created") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "proposal"]) || event.payload.formatVersion !== 1) throw new Error("Knowledge proposal producer lacks harness authority or has unknown fields");
      const proposal = proposalFrom(event.payload.proposal);
      assertAuthoritativeProposalUpdate(events.slice(0, event.sequence - 1), proposal.update);
      if (event.projectId !== proposal.projectId || event.sessionId !== proposal.sessionId || event.runId !== proposal.runId || event.correlationId !== proposal.update.updateId) throw new Error("Knowledge proposal event envelope identity is invalid");
      if (proposals[proposal.proposalId] || Object.values(proposals).some((entry) => entry.update.updateId === proposal.update.updateId)) throw new Error("Knowledge proposal or stable update identity is duplicated");
      proposals[proposal.proposalId] = proposal;
    } else if (event.payload.operation === "proposal-decided") {
      if (event.producer !== "dashboard" || !exact(event.payload, ["formatVersion", "operation", "proposalId", "expectedState", "decision"]) || event.payload.formatVersion !== 1 || event.payload.expectedState !== "pending") throw new Error("Knowledge proposal decision producer or schema is invalid");
      const proposalId = validId(event.payload.proposalId, "Knowledge proposal ID"); const current = proposals[proposalId];
      if (!current || current.state !== "pending" || !record(event.payload.decision) || !exact(event.payload.decision, ["decision", "identity", "operationId", "requestHash", "decidedAt"])) throw new Error("Knowledge proposal decision violates pending CAS");
      const raw = event.payload.decision;
      if ((raw.decision !== "approve" && raw.decision !== "deny") || typeof raw.identity !== "string" || !raw.identity || Buffer.byteLength(raw.identity, "utf8") > 512
        || typeof raw.operationId !== "string" || typeof raw.requestHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(raw.requestHash) || typeof raw.decidedAt !== "string" || !Number.isFinite(Date.parse(raw.decidedAt))) throw new Error("Knowledge proposal decision provenance is invalid");
      validId(raw.operationId, "Knowledge proposal decision operation ID");
      const expectedRequestHash = sha256("pi-hive-knowledge-proposal-control-v1", {
        projectId: current.projectId, sessionId: current.sessionId, proposalId, expectedState: "pending",
        decision: raw.decision, operationId: raw.operationId, channel: "dashboard", identity: raw.identity,
      });
      if (event.projectId !== current.projectId || event.sessionId !== current.sessionId || event.runId !== current.runId || event.correlationId !== raw.operationId
        || raw.requestHash !== expectedRequestHash || Object.values(proposals).some((proposal) => proposal.decision?.operationId === raw.operationId)) throw new Error("Knowledge proposal decision event, authenticated request hash, or session-wide operation identity is invalid");
      const decision = raw as unknown as KnowledgeProposalDecision;
      proposals[proposalId] = Object.freeze({ ...current, state: decision.decision === "approve" ? "approved" : "denied", decision });
    } else if (event.payload.operation === "proposal-applied") {
      if (event.producer !== "harness" || !exact(event.payload, ["formatVersion", "operation", "proposalId", "updateHash", "decisionOperationId", "result"]) || event.payload.formatVersion !== 1) throw new Error("Knowledge proposal application producer or schema is invalid");
      const proposalId = validId(event.payload.proposalId, "Knowledge proposal ID"); const current = proposals[proposalId];
      if (!current || current.state !== "approved" || current.updateHash !== event.payload.updateHash || current.decision?.operationId !== event.payload.decisionOperationId || !record(event.payload.result)) throw new Error("Knowledge proposal application violates approved CAS");
      const applied = event.payload.result as unknown as KnowledgeMutationResult;
      if (event.projectId !== current.projectId || event.sessionId !== current.sessionId || event.runId !== current.runId || event.correlationId !== current.update.updateId) throw new Error("Knowledge proposal application event envelope identity is invalid");
      if (applied.updateId !== current.update.updateId || applied.bundleId !== current.update.bundleId || typeof applied.changed !== "boolean" || !/^sha256:[0-9a-f]{64}$/u.test(applied.contentHash) || applied.documentId !== "curated" || !Number.isSafeInteger(applied.conclusionCount)) throw new Error("Knowledge proposal application result is invalid");
      const committed = restoreMutationProgress(events.slice(0, event.sequence - 1), current.update).committed;
      if (!committed || !sameMutationPublication(committed, applied) || committed.changed !== applied.changed) throw new Error("Knowledge proposal application lacks the exact prior authoritative mutation commit result");
      proposals[proposalId] = Object.freeze({ ...current, state: "applied", applied });
    } else if (typeof event.payload.operation === "string" && event.payload.operation.startsWith("proposal-")) {
      throw new Error(`Unknown knowledge proposal transition: ${event.payload.operation}`);
    }
  }
  return Object.freeze({ proposals: Object.freeze(proposals) });
}

export class KnowledgeProposalService {
  readonly options: KnowledgeProposalServiceOptions;
  constructor(options: KnowledgeProposalServiceOptions) { this.options = options; }
  create(rawUpdate: DurableKnowledgeUpdate): DurableKnowledgeProposal {
    const update = validateUpdate(rawUpdate);
    if (update.projectId !== this.options.projectId || update.sessionId !== this.options.sessionId) throw new Error("Knowledge proposal update differs from exact service identity");
    const updateHash = stableUpdateHash(update);
    const events = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
    const before = restoreKnowledgeProposalState(events);
    const replay = Object.values(before.proposals).find((proposal) => proposal.update.updateId === update.updateId);
    if (replay) {
      if (replay.updateHash !== updateHash) throw new Error("Knowledge proposal update identity reuse conflicts with durable content");
      return replay;
    }
    assertAuthoritativeProposalUpdate(events, update);
    const proposal: DurableKnowledgeProposal = Object.freeze({
      formatVersion: 1, proposalId: validId(this.options.createProposalId?.() ?? randomUUID(), "Knowledge proposal ID"), projectId: this.options.projectId,
      sessionId: this.options.sessionId, runId: update.runId, update, updateHash, state: "pending", createdAt: this.options.now?.() ?? new Date().toISOString(),
    });
    try {
      appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
        projectId: this.options.projectId, sessionId: this.options.sessionId, runId: update.runId, type: "knowledge.transition", producer: "harness",
        correlationId: update.updateId, payload: { formatVersion: 1, operation: "proposal-created", proposal } as unknown as JsonValue, timestamp: proposal.createdAt,
      }), (events) => {
        const existing = Object.values(restoreKnowledgeProposalState(events).proposals).find((entry) => entry.update.updateId === update.updateId || entry.proposalId === proposal.proposalId);
        if (existing) throw new Error("Knowledge proposal update identity or proposal ID is already recorded");
      });
    } catch (error) {
      const raced = Object.values(restoreKnowledgeProposalState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId)).proposals).find((entry) => entry.update.updateId === update.updateId);
      if (raced?.updateHash === updateHash) return raced;
      throw error;
    }
    return proposal;
  }
  decide(request: KnowledgeProposalControlRequest): DurableKnowledgeProposal {
    if (!record(request) || !exact(request, ["projectId", "sessionId", "proposalId", "expectedState", "decision", "operationId", "channel", "claimedIdentity", "credential"]) || request.channel !== "dashboard") throw new Error("Knowledge proposal decision request schema requires the exact authenticated dashboard human-control DTO");
    if (Buffer.byteLength(canonicalJson(request), "utf8") > KNOWLEDGE_PROPOSAL_LIMITS.controlRequestBytes || typeof request.claimedIdentity !== "string" || Buffer.byteLength(request.claimedIdentity, "utf8") > 512
      || typeof request.credential !== "string" || Buffer.byteLength(request.credential, "utf8") > 8_192) throw new Error("Knowledge proposal control request exceeds its aggregate byte bound");
    if (request.projectId !== this.options.projectId || request.sessionId !== this.options.sessionId || request.expectedState !== "pending" || (request.decision !== "approve" && request.decision !== "deny")) throw new Error("Knowledge proposal control identity or expected CAS state is invalid");
    validId(request.proposalId, "Knowledge proposal ID"); validId(request.operationId, "Knowledge proposal operation ID");
    const identity = this.options.authenticateControl(request);
    if (!identity || typeof identity !== "string" || Buffer.byteLength(identity, "utf8") > 512) throw new Error("Knowledge proposal control authentication failed");
    const requestHash = sha256("pi-hive-knowledge-proposal-control-v1", { projectId: request.projectId, sessionId: request.sessionId, proposalId: request.proposalId, expectedState: request.expectedState, decision: request.decision, operationId: request.operationId, channel: request.channel, identity });
    const before = restoreKnowledgeProposalState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId));
    const operationReplay = Object.values(before.proposals).find((proposal) => proposal.decision?.operationId === request.operationId);
    if (operationReplay) {
      if (operationReplay.proposalId !== request.proposalId || operationReplay.decision?.requestHash !== requestHash) throw new Error("Knowledge proposal decision operation replay conflicts session-wide");
      return operationReplay;
    }
    const existing = before.proposals[request.proposalId];
    if (!existing) throw new Error("Knowledge proposal is missing");
    if (existing.state !== "pending") throw new Error("Knowledge proposal exact pending CAS was already decided");
    const decision: KnowledgeProposalDecision = Object.freeze({ decision: request.decision, identity, operationId: request.operationId, requestHash, decidedAt: this.options.now?.() ?? new Date().toISOString() });
    try {
      appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
        projectId: this.options.projectId, sessionId: this.options.sessionId, runId: existing.runId, type: "knowledge.transition", producer: "dashboard", correlationId: request.operationId,
        payload: { formatVersion: 1, operation: "proposal-decided", proposalId: request.proposalId, expectedState: "pending", decision } as unknown as JsonValue,
        timestamp: decision.decidedAt,
      }), (events) => {
        const state = restoreKnowledgeProposalState(events);
        const reused = Object.values(state.proposals).find((proposal) => proposal.decision?.operationId === request.operationId);
        if (reused) throw new Error("Knowledge proposal decision operation ID is already used session-wide");
        const current = state.proposals[request.proposalId];
        if (!current || current.state !== "pending") throw new Error("Knowledge proposal exact pending CAS was already decided");
      });
    } catch (error) {
      const raced = restoreKnowledgeProposalState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId)).proposals[request.proposalId];
      if (raced?.decision?.operationId === request.operationId && raced.decision.requestHash === requestHash) return raced;
      throw error;
    }
    return Object.freeze({ ...existing, state: request.decision === "approve" ? "approved" : "denied", decision });
  }

  status(request: KnowledgeProposalStatusRequest): KnowledgeProposalStatusPage {
    if (!record(request) || !exact(request, ["projectId", "sessionId"], ["state", "limit", "cursor"]) || request.projectId !== this.options.projectId || request.sessionId !== this.options.sessionId) throw new Error("Knowledge proposal status request has an unknown field or wrong service identity");
    if (request.state !== undefined && request.state !== "pending" && request.state !== "approved" && request.state !== "denied" && request.state !== "applied") throw new Error("Knowledge proposal status state is invalid");
    const limit = request.limit === undefined ? 20 : Number(request.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > KNOWLEDGE_PROPOSAL_LIMITS.pageSize) throw new Error("Knowledge proposal status limit is invalid");
    if (request.cursor !== undefined && (typeof request.cursor !== "string" || !/^[0-9]+$/u.test(request.cursor) || Buffer.byteLength(request.cursor, "utf8") > KNOWLEDGE_PROPOSAL_LIMITS.cursorBytes)) throw new Error("Knowledge proposal status cursor is invalid");
    const offset = request.cursor === undefined ? 0 : Number(request.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Knowledge proposal status cursor is invalid");
    const proposals = Object.values(restoreKnowledgeProposalState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId)).proposals)
      .filter((proposal) => request.state === undefined || proposal.state === request.state)
      .sort((left, right) => compare(left.createdAt, right.createdAt) || compare(left.proposalId, right.proposalId));
    const items = Object.freeze(proposals.slice(offset, offset + limit).map((proposal) => Object.freeze({
      proposalId: proposal.proposalId, runId: proposal.runId, updateId: proposal.update.updateId, bundleId: proposal.update.bundleId,
      state: proposal.state, createdAt: proposal.createdAt, updateHash: proposal.updateHash,
    })));
    return Object.freeze({ total: proposals.length, items, ...(offset + items.length < proposals.length ? { nextCursor: String(offset + items.length) } : {}) });
  }

  detail(request: KnowledgeProposalDetailRequest): DurableKnowledgeProposal {
    if (!record(request) || !exact(request, ["projectId", "sessionId", "proposalId"]) || request.projectId !== this.options.projectId || request.sessionId !== this.options.sessionId) throw new Error("Knowledge proposal detail request has an unknown field or wrong service identity");
    const proposalId = validId(request.proposalId, "Knowledge proposal ID");
    const proposal = restoreKnowledgeProposalState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId)).proposals[proposalId];
    if (!proposal) throw new Error("Knowledge proposal is missing");
    return proposal;
  }

  async applyApproved(proposalId: string, mutator: OkfKnowledgeMutator): Promise<DurableKnowledgeProposal> {
    validId(proposalId, "Knowledge proposal ID");
    const before = restoreKnowledgeProposalState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId)).proposals[proposalId];
    if (!before) throw new Error("Knowledge proposal is missing");
    if (before.state === "applied") return before;
    if (before.state !== "approved" || before.decision?.decision !== "approve") throw new Error("Knowledge proposal application requires an exact approved decision");
    await mutator.apply(before.update);
    const result = restoreMutationProgress(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), before.update).committed;
    if (!result) throw new Error("Knowledge proposal application lacks its authoritative durable mutation commit");
    try {
      appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
        projectId: this.options.projectId, sessionId: this.options.sessionId, runId: before.runId,
        type: "knowledge.transition", producer: "harness", correlationId: before.update.updateId,
        payload: { formatVersion: 1, operation: "proposal-applied", proposalId, updateHash: before.updateHash, decisionOperationId: before.decision.operationId, result } as unknown as JsonValue,
        timestamp: this.options.now?.(),
      }), (events) => {
        const current = restoreKnowledgeProposalState(events).proposals[proposalId];
        if (!current || current.state !== "approved" || current.updateHash !== before.updateHash || current.decision?.operationId !== before.decision?.operationId) throw new Error("Knowledge proposal approved CAS changed before application publication");
      });
    } catch (error) {
      const raced = restoreKnowledgeProposalState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId)).proposals[proposalId];
      if (raced?.state === "applied" && raced.updateHash === before.updateHash && raced.decision?.operationId === before.decision.operationId
        && sameMutationPublication(raced.applied, result)) return raced;
      throw error;
    }
    return Object.freeze({ ...before, state: "applied", applied: result });
  }
}
