import { createHash } from "node:crypto";
import { ARTIFACT_CONTRACT_VERSION } from "../artifacts/contracts";
import { projectIdFromCanonicalRoot } from "../shared/project-identity";
import type { ConfigCatalogResult } from "./catalogs";
import type { AvailableAgentCatalogNode } from "./catalog-types";
import type { ConfiguredProject } from "./manifest";
import type { ValidWorkflowDefinition } from "./resolver";
import { isEffectiveAuthoritySnapshotV1, type EffectiveAuthoritySnapshotV1 } from "./snapshot-authority";
import { canonicalCatalogText } from "./catalog-hash";
import { canonicalJson, hashActivationPayload } from "./snapshot-canonical";
import { SNAPSHOT_CONTEXT_POLICY, validateSnapshotModels, type SnapshotModelAdapter, type SnapshotNodeModelValidation } from "./snapshot-model";
import { CAPABILITY_CONTRACT_VERSION, SCHEMA_VERSION } from "./versions";

export const SNAPSHOT_FORMAT_VERSION = 1 as const;
export const SNAPSHOT_PACKAGE_CONTRACT_VERSION = "pi-hive-package-contract-v1" as const;
export const SNAPSHOT_CATALOG_HASH_VERSION = "pi-hive-catalog-hash-v1" as const;
export const SNAPSHOT_LIMITS = Object.freeze({ fileBytes: 33_554_432, payloadBytes: 33_554_432, sources: 4_096, jsonDepth: 128, jsonItems: 100_000, summaryItems: 4_096, summaryBytes: 262_144 });

export type SnapshotSourceKindV1 = "manifest" | "workflow" | "agent" | "skill";
export interface SnapshotSourceV1 { path: string; kind: SnapshotSourceKindV1; id: string; hash: string; canonicalHash: string }
export interface ActivationSnapshotPayloadV1 {
  versions: { snapshot: 1; packageContract: typeof SNAPSHOT_PACKAGE_CONTRACT_VERSION; schema: typeof SCHEMA_VERSION; capability: typeof CAPABILITY_CONTRACT_VERSION; catalogHash: typeof SNAPSHOT_CATALOG_HASH_VERSION; artifact: typeof ARTIFACT_CONTRACT_VERSION; contextPolicy: typeof SNAPSHOT_CONTEXT_POLICY.version; package: string };
  project: { projectId: string; rootRef: "." };
  workflow: Record<string, unknown>;
  agents: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>>;
  knowledge: Array<Record<string, unknown>>;
  authority: { capabilityContractVersion: number; nodes: Array<Record<string, unknown>> };
  models: SnapshotNodeModelValidation[];
  sources: SnapshotSourceV1[];
}
export interface ActivationSnapshotFileV1 { snapshotHash: string; createdAt: string; payload: ActivationSnapshotPayloadV1 }
export interface BuildActivationSnapshotInput { project: ConfiguredProject; workflow: ValidWorkflowDefinition; catalogs: ConfigCatalogResult; authority: EffectiveAuthoritySnapshotV1; models: SnapshotModelAdapter; packageVersion: string; createdAt?: string }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function sorted(values: readonly string[]): string[] { return [...new Set(values)].sort(compare); }
export function validateSnapshotRelativePath(path: string, label = "Snapshot path"): string {
  if (!path || Buffer.byteLength(path, "utf8") > 4_096 || path.startsWith("/") || path.includes("\\") || path.split("/").length > 128 || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`${label} must be canonical project-relative POSIX.`);
  return path;
}
export function validateSnapshotSha256(hash: string, label = "Snapshot hash"): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label} is invalid.`);
  return hash;
}
function validateSource(source: SnapshotSourceV1): SnapshotSourceV1 {
  validateSnapshotRelativePath(source.path, "Snapshot source path");
  if (!(["manifest", "workflow", "agent", "skill"] as const).includes(source.kind) || !/^(?:root|[a-z][a-z0-9_-]*)$/.test(source.id)) throw new Error("Snapshot source kind or id is invalid.");
  validateSnapshotSha256(source.hash, "Snapshot source hash");
  validateSnapshotSha256(source.canonicalHash, "Snapshot canonical source hash");
  return { ...source };
}
function sourceTextHashes(source: string): Pick<SnapshotSourceV1, "hash" | "canonicalHash"> {
  return {
    hash: createHash("sha256").update(source, "utf8").digest("hex"),
    canonicalHash: createHash("sha256").update(canonicalCatalogText(source), "utf8").digest("hex"),
  };
}
function identityPayload(payload: ActivationSnapshotPayloadV1): unknown {
  return { ...payload, knowledge: payload.knowledge.map(({ metadataFingerprint: _fingerprint, ...entry }) => entry) };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}
function explicitSetting(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value !== "inherit");
}
export function verifyActivationSnapshotHash(snapshot: ActivationSnapshotFileV1): boolean {
  try { return hashActivationPayload(identityPayload(snapshot.payload)) === snapshot.snapshotHash; }
  catch { return false; }
}

export function buildActivationSnapshot(input: BuildActivationSnapshotInput): ActivationSnapshotFileV1 {
  const { workflow, catalogs, project } = input;
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Snapshot creation time is invalid.");
  if (!isEffectiveAuthoritySnapshotV1(input.authority)) throw new Error("Activation snapshot requires branded effective authority.");
  if (input.authority.workflowId !== workflow.id) throw new Error("Effective authority workflow does not match.");
  const expectedNodeIds = workflow.team.nodes.map((node) => node.id).sort(compare);
  const authorityNodeIds = input.authority.nodes.map((node) => node.nodeId).sort(compare);
  if (canonicalJson(expectedNodeIds) !== canonicalJson(authorityNodeIds)) throw new Error("Effective authority node coverage is incomplete or contains extras.");
  const agentById = new Map(catalogs.agents.filter((node): node is AvailableAgentCatalogNode => node.status === "available").map((node) => [node.id, node]));
  const skillById = new Map(catalogs.skills.filter((node) => node.status === "available").map((node) => [node.id, node]));
  const knowledgeById = new Map(catalogs.knowledge.filter((node) => node.status === "available").map((node) => [node.id, node]));
  const agentIds = sorted(workflow.team.nodes.map((node) => node.agentId));
  const skillIds = sorted(workflow.team.nodes.flatMap((node) => node.skills.resolved));
  const knowledgeIds = sorted(workflow.team.nodes.flatMap((node) => node.knowledge.resolved));
  const sources: SnapshotSourceV1[] = [{ path: project.manifestSource, kind: "manifest", id: "root", ...sourceTextHashes(project.rawSource) }];
  const workflowRegistry = project.registries.workflows.find((entry) => entry.id === workflow.id && entry.status === "available");
  if (!workflowRegistry?.projectPath || workflowRegistry.projectPath !== workflow.source) throw new Error(`Snapshot workflow source for ${workflow.id} does not match its registry association.`);
  sources.push({ path: workflowRegistry.projectPath, kind: "workflow", id: workflow.id, ...sourceTextHashes(workflow.rawSource) });
  for (const id of agentIds) {
    const agent = agentById.get(id);
    const registry = project.registries.agents.find((entry) => entry.id === id && entry.status === "available");
    if (!agent || !registry?.projectPath) throw new Error(`Snapshot sources omit agent ${id}.`);
    sources.push({ path: registry.projectPath, kind: "agent", id, hash: agent.sourceHash, canonicalHash: agent.canonicalSourceHash });
  }
  for (const id of skillIds) {
    const skill = skillById.get(id);
    const registry = project.registries.skills.find((entry) => entry.id === id && entry.status === "available");
    if (!skill || skill.status !== "available" || !registry?.projectPath) throw new Error(`Snapshot sources omit skill ${id} files.`);
    // Loaded skill records intentionally retain canonical catalog hashes, not the original
    // byte buffer (which may include an ignored UTF-8 BOM). Kind/id make that hash domain
    // explicit to source probes without an unsafe second filesystem read.
    for (const file of skill.files) sources.push({ path: `${registry.projectPath}/${file.relativePath}`, kind: "skill", id, hash: file.hash, canonicalHash: file.hash });
  }
  if (sources.length > SNAPSHOT_LIMITS.sources) throw new Error("Snapshot source limit exceeded.");
  sources.splice(0, sources.length, ...sources.map(validateSource).sort((a, b) => compare(a.path, b.path)));
  if (new Set(sources.map((source) => source.path)).size !== sources.length) throw new Error("Snapshot sources contain duplicate paths.");
  const agents = agentIds.map((id) => {
    const agent = agentById.get(id); if (!agent) throw new Error(`Snapshot agent ${id} is unavailable.`);
    return { id, name: agent.name, tags: sorted(agent.tags), frontmatter: agent.frontmatter, prompt: agent.prompt, sourceHash: agent.sourceHash, canonicalSourceHash: agent.canonicalSourceHash, promptHash: agent.promptHash };
  });
  const skills = skillIds.map((id) => {
    const skill = skillById.get(id); if (!skill || skill.status !== "available") throw new Error(`Snapshot skill ${id} is unavailable.`);
    return { id, treeHash: skill.treeHash, files: [...skill.files].sort((a, b) => compare(a.relativePath, b.relativePath)).map((file) => ({ ...file })) };
  });
  const knowledge = knowledgeIds.map((id) => {
    const node = knowledgeById.get(id); if (!node || node.status !== "available") throw new Error(`Snapshot knowledge ${id} is unavailable.`);
    const registry = project.registries.knowledge.find((entry) => entry.id === id);
    if (!registry?.projectPath) throw new Error(`Snapshot knowledge ${id} lacks a project-relative path.`);
    return { id, provider: "okf", path: registry.projectPath, ...(node.owner ? { owner: node.owner } : {}), updates: node.updates, metadataFingerprint: node.fingerprint, attachedNodeIds: workflow.team.nodes.filter((teamNode) => teamNode.knowledge.resolved.includes(id)).map((teamNode) => teamNode.id).sort(compare) };
  });
  const staticByNode = workflow.team.nodes.map((node) => {
    const agent = agentById.get(node.agentId); if (!agent) throw new Error(`Snapshot agent ${node.agentId} is unavailable.`);
    const skillText = node.skills.resolved.map((id) => { const skill = skillById.get(id); if (!skill || skill.status !== "available") throw new Error(`Snapshot skill ${id} is unavailable.`); return skill.files.map((file) => file.content).join("\n"); }).join("\n");
    const authority = input.authority.nodes.find((item) => item.nodeId === node.id)!;
    return { nodeId: node.id, model: explicitSetting(node.model, agent.frontmatter.model, project.manifest.settings?.defaults?.agent?.model), thinking: explicitSetting(node.thinking, agent.frontmatter.thinking, project.manifest.settings?.defaults?.agent?.thinking), staticText: [agent.prompt, workflow.instructions.shared ?? "", node.id === workflow.team.rootId ? workflow.instructions.root : "", node.role ?? "", ...node.responsibilities, skillText, canonicalJson({ artifact: workflow.artifact, budgets: node.budgets, capabilities: authority.capabilities, tools: authority.tools })].join("\n") };
  });
  const modelResult = validateSnapshotModels(staticByNode, input.models);
  if (!modelResult.ok) throw new Error(`Snapshot model preflight failed: ${modelResult.codes.join(",")}`);
  const payload: ActivationSnapshotPayloadV1 = {
    versions: { snapshot: SNAPSHOT_FORMAT_VERSION, packageContract: SNAPSHOT_PACKAGE_CONTRACT_VERSION, schema: SCHEMA_VERSION, capability: CAPABILITY_CONTRACT_VERSION, catalogHash: SNAPSHOT_CATALOG_HASH_VERSION, artifact: ARTIFACT_CONTRACT_VERSION, contextPolicy: SNAPSHOT_CONTEXT_POLICY.version, package: input.packageVersion },
    project: { projectId: projectIdFromCanonicalRoot(project.projectRoot), rootRef: "." },
    workflow: { id: workflow.id, name: workflow.name, description: workflow.description, useWhen: workflow.useWhen, ...(workflow.avoidWhen ? { avoidWhen: workflow.avoidWhen } : {}), tags: sorted(workflow.tags), examples: [...workflow.examples], suggestedNext: sorted(workflow.suggestedNext), artifact: { adapter: workflow.artifact.adapter, profile: workflow.artifact.profile, binding: workflow.artifact.binding, options: workflow.artifact.options ?? {}, contractVersion: workflow.artifact.contractVersion, checkpoints: [...workflow.artifact.contract.checkpoints], approvals: workflow.approvals }, instructions: workflow.instructions, budgets: workflow.budgets, team: { rootId: workflow.team.rootId, nodes: workflow.team.nodes.map((node) => ({ id: node.id, agentId: node.agentId, ...(node.parentId ? { parentId: node.parentId } : {}), memberIds: [...node.memberIds], depth: node.depth, ...(node.role ? { role: node.role } : {}), responsibilities: [...node.responsibilities], ...(node.consultWhen ? { consultWhen: node.consultWhen } : {}), ...(node.model ? { model: node.model } : {}), ...(node.thinking ? { thinking: node.thinking } : {}), ...(node.capabilities ? { capabilities: node.capabilities } : {}), skills: node.skills, knowledge: node.knowledge, budgets: node.budgets })) } },
    agents, skills, knowledge,
    authority: { capabilityContractVersion: input.authority.capabilityContractVersion, nodes: input.authority.nodes.map((node) => ({ nodeId: node.nodeId, capabilities: node.capabilities, tools: [...node.tools] })) },
    models: modelResult.nodes,
    sources,
  };
  for (const dependency of knowledge) {
    validateSnapshotRelativePath(dependency.path, "Snapshot knowledge path");
    validateSnapshotSha256(dependency.metadataFingerprint, "Snapshot knowledge metadata fingerprint");
  }
  const encodedPayload = canonicalJson(payload);
  if (Buffer.byteLength(encodedPayload, "utf8") > SNAPSHOT_LIMITS.payloadBytes) throw new Error("Snapshot payload exceeds its byte limit.");
  const immutablePayload = JSON.parse(encodedPayload) as ActivationSnapshotPayloadV1;
  return deepFreeze({ snapshotHash: hashActivationPayload(identityPayload(immutablePayload)), createdAt, payload: immutablePayload });
}

export interface ActivationCompatibilitySummary { state: "current" | "stale" | "missing" | "invalid"; resumable: boolean; codes: readonly string[] }
function boundedSummaryString(value: unknown, bytes: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > bytes) return "[invalid]";
  return value;
}
export function buildActivationSummary(snapshot: ActivationSnapshotFileV1, compatibility: ActivationCompatibilitySummary) {
  const requestedCodes = new Set<string>();
  let inspectedCodes = 0;
  let requestedCodeBytes = 0;
  let codeInputTruncated = false;
  for (const code of compatibility.codes) {
    if (++inspectedCodes > SNAPSHOT_LIMITS.summaryItems) { codeInputTruncated = true; break; }
    if (typeof code !== "string" || code.length > 256 || !/^[A-Z][A-Z0-9_:-]{0,255}$/.test(code)) { codeInputTruncated = true; continue; }
    const bytes = Buffer.byteLength(code, "utf8");
    if (requestedCodeBytes + bytes > Math.floor(SNAPSHOT_LIMITS.summaryBytes / 2)) { codeInputTruncated = true; break; }
    if (!requestedCodes.has(code)) { requestedCodes.add(code); requestedCodeBytes += bytes; }
  }
  const codes = [...requestedCodes].sort(compare);
  const team = snapshot.payload.workflow.team as { nodes?: unknown[] } | undefined;
  const artifact = snapshot.payload.workflow.artifact as { adapter?: unknown; profile?: unknown } | undefined;
  const versions = snapshot.payload.versions;
  const workflowName = boundedSummaryString(snapshot.payload.workflow.name, 512);
  const adapter = boundedSummaryString(artifact?.adapter, 128);
  const profile = boundedSummaryString(artifact?.profile, 128);
  const requestedModelIds = new Set<string>();
  let modelIdBytes = 0;
  let modelInputTruncated = false;
  for (const model of snapshot.payload.models) {
    if (requestedModelIds.size >= SNAPSHOT_LIMITS.summaryItems) { modelInputTruncated = true; break; }
    const modelId = boundedSummaryString(model.modelId, 256);
    const bytes = Buffer.byteLength(modelId, "utf8");
    if (modelId === "[invalid]" || modelIdBytes + bytes > Math.floor(SNAPSHOT_LIMITS.summaryBytes / 4)) { modelInputTruncated = true; break; }
    if (!requestedModelIds.has(modelId)) { requestedModelIds.add(modelId); modelIdBytes += bytes; }
  }
  const modelIds = [...requestedModelIds].sort(compare);
  const summary = {
    version: 1,
    snapshotHash: boundedSummaryString(snapshot.snapshotHash, 64),
    workflowId: boundedSummaryString(snapshot.payload.workflow.id, 512),
    workflowName,
    artifact: { adapter, profile },
    modelIds,
    versions: {
      snapshot: versions.snapshot,
      packageContract: boundedSummaryString(versions.packageContract, 128),
      schema: versions.schema,
      capability: versions.capability,
      catalogHash: boundedSummaryString(versions.catalogHash, 128),
      artifact: boundedSummaryString(versions.artifact, 128),
      contextPolicy: boundedSummaryString(versions.contextPolicy, 128),
      package: boundedSummaryString(versions.package, 128),
    },
    nodeCount: Array.isArray(team?.nodes) ? Math.min(team.nodes.length, 1_024) : 0,
    sourceState: compatibility.state,
    resumable: compatibility.resumable,
    codes,
    createdAt: boundedSummaryString(snapshot.createdAt, 64),
    truncated: codeInputTruncated
      || snapshot.payload.workflow.id !== boundedSummaryString(snapshot.payload.workflow.id, 512)
      || snapshot.payload.workflow.name !== workflowName
      || artifact?.adapter !== adapter
      || artifact?.profile !== profile
      || modelInputTruncated
      || versions.package !== boundedSummaryString(versions.package, 128),
  };
  if (Buffer.byteLength(JSON.stringify(summary), "utf8") > SNAPSHOT_LIMITS.summaryBytes) return { ...summary, codes: [], truncated: true };
  return summary;
}
