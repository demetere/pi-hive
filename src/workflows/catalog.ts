import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfigCatalogs, loadConfigProject, resolveConfigWorkflows, type ConfigCatalogResult, type ValidWorkflowDefinition, type WorkflowDefinition } from "../config/index";
import { canonicalJson } from "../config/snapshot-canonical";
import { withCrossProcessFileLock } from "../core/file-lock";
import type { JsonValue } from "../config/types";
import { createWorkflowEvent, type WorkflowEventEnvelope } from "./events";
import { appendWorkflowEvent, readWorkflowJournal } from "./journal";

export const WORKFLOW_CATALOG_SESSION_ID = "workflow-catalog";
export const WORKFLOW_CATALOG_FORMAT_VERSION = 1 as const;
const CATALOG_PAYLOAD_BYTES = 196_608;
const CATALOG_TOPOLOGY_NODES = 64;

export interface WorkflowCatalogTopologyNode {
  readonly nodeId: string;
  readonly parentNodeId?: string;
  readonly agentId: string;
  readonly agentName?: string;
  readonly role?: string;
  readonly model?: string;
  readonly thinking?: string;
}

export interface WorkflowCatalogEntry {
  readonly formatVersion: 1;
  readonly workflowId: string;
  readonly name: string;
  readonly description: string;
  readonly definitionHash: string;
  readonly definitionVersion: number;
  readonly status: "available" | "invalid" | "retired";
  readonly topology: readonly WorkflowCatalogTopologyNode[];
  readonly topologyTruncated: boolean;
  readonly diagnosticCodes: readonly string[];
}

export interface WorkflowCatalogSyncResult {
  readonly discovered: number;
  readonly cataloged: number;
  readonly retired: number;
  readonly unchanged: number;
}

type CatalogPayload = WorkflowCatalogEntry & { readonly workflowConfigHash: string; readonly workflowConfigVersion: string };

function hash(value: unknown): string {
  return createHash("sha256").update("pi-hive-workflow-definition-v1\0").update(canonicalJson(value)).digest("hex");
}

function availableAgent(catalogs: ConfigCatalogResult, id: string) {
  const agent = catalogs.agents.find((entry) => entry.id === id);
  return agent?.status === "available" ? agent : undefined;
}

function validIdentity(definition: ValidWorkflowDefinition, catalogs: ConfigCatalogResult): unknown {
  const nodes = definition.team.nodes.map((node) => ({
    id: node.id,
    agentId: node.agentId,
    ...(node.parentId ? { parentId: node.parentId } : {}),
    memberIds: [...node.memberIds],
    depth: node.depth,
    ...(node.role ? { role: node.role } : {}),
    responsibilities: [...node.responsibilities],
    ...(node.consultWhen ? { consultWhen: node.consultWhen } : {}),
    ...(node.model ? { model: node.model } : {}),
    ...(node.thinking ? { thinking: node.thinking } : {}),
    ...(node.capabilities ? { capabilities: node.capabilities } : {}),
    skills: [...node.skills.resolved],
    knowledge: [...node.knowledge.resolved],
    budgets: node.budgets,
  }));
  const agentIds = [...new Set(nodes.map((node) => node.agentId))].sort();
  const skillIds = [...new Set(definition.team.nodes.flatMap((node) => node.skills.resolved))].sort();
  const knowledgeIds = [...new Set(definition.team.nodes.flatMap((node) => node.knowledge.resolved))].sort();
  return {
    formatVersion: WORKFLOW_CATALOG_FORMAT_VERSION,
    workflow: {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      useWhen: definition.useWhen,
      ...(definition.avoidWhen ? { avoidWhen: definition.avoidWhen } : {}),
      tags: [...definition.tags],
      examples: [...definition.examples],
      suggestedNext: [...definition.suggestedNext],
      artifact: definition.artifact,
      approvals: definition.approvals,
      instructions: definition.instructions,
      budgets: definition.budgets,
      rootId: definition.team.rootId,
      nodes,
      authority: definition.authority,
      policies: definition.policies,
    },
    dependencies: {
      agents: agentIds.map((id) => {
        const agent = availableAgent(catalogs, id);
        return agent ? { id, canonicalSourceHash: agent.canonicalSourceHash, promptHash: agent.promptHash } : { id, status: "missing" };
      }),
      skills: skillIds.map((id) => {
        const skill = catalogs.skills.find((entry) => entry.id === id);
        return skill?.status === "available" ? { id, treeHash: skill.treeHash } : { id, status: "missing" };
      }),
      knowledge: knowledgeIds.map((id) => {
        const knowledge = catalogs.knowledge.find((entry) => entry.id === id);
        return knowledge?.status === "available" ? { id, fingerprint: knowledge.fingerprint } : { id, status: "missing" };
      }),
    },
  };
}

function definitionIdentity(definition: WorkflowDefinition, catalogs: ConfigCatalogResult): unknown {
  if (definition.status === "valid") return validIdentity(definition, catalogs);
  return {
    formatVersion: WORKFLOW_CATALOG_FORMAT_VERSION,
    workflow: {
      id: definition.id,
      status: definition.status,
      name: definition.name ?? definition.id,
      description: definition.description ?? "Invalid workflow definition",
      diagnosticCodes: [...definition.diagnosticCodes].sort(),
    },
  };
}

function topology(definition: WorkflowDefinition, catalogs: ConfigCatalogResult): WorkflowCatalogTopologyNode[] {
  if (definition.status !== "valid") return [];
  return definition.team.nodes.map((node) => {
    const agent = availableAgent(catalogs, node.agentId); const model = node.model ?? agent?.frontmatter.model; const thinking = node.thinking ?? agent?.frontmatter.thinking;
    return {
      nodeId: node.id,
      ...(node.parentId ? { parentNodeId: node.parentId } : {}),
      agentId: node.agentId,
      ...(agent?.name ? { agentName: agent.name } : {}),
      ...(node.role ? { role: node.role } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
    };
  });
}

function payloadBytes(value: unknown): number { return Buffer.byteLength(canonicalJson(value), "utf8"); }

function boundedEntry(definition: WorkflowDefinition, catalogs: ConfigCatalogResult, definitionHash: string, definitionVersion: number): CatalogPayload {
  const allNodes = topology(definition, catalogs);
  const base = {
    formatVersion: WORKFLOW_CATALOG_FORMAT_VERSION,
    workflowId: definition.id,
    name: definition.name ?? definition.id,
    description: definition.description ?? "Invalid workflow definition",
    definitionHash,
    definitionVersion,
    status: definition.status === "valid" ? "available" as const : "invalid" as const,
    diagnosticCodes: [...definition.diagnosticCodes],
    workflowConfigHash: definitionHash,
    workflowConfigVersion: String(definitionVersion),
  };
  const selected: WorkflowCatalogTopologyNode[] = [];
  for (const node of allNodes) {
    if (selected.length >= CATALOG_TOPOLOGY_NODES) break;
    const candidate = { ...base, topology: [...selected, node], topologyTruncated: false };
    if (payloadBytes(candidate) > CATALOG_PAYLOAD_BYTES) break;
    selected.push(node);
  }
  const topologyTruncated = selected.length !== allNodes.length;
  const result = { ...base, topology: selected, topologyTruncated };
  if (payloadBytes(result) > CATALOG_PAYLOAD_BYTES) throw new Error(`Workflow catalog metadata for ${definition.id} exceeds its safe projection bound`);
  return Object.freeze(result);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function catalogPayload(event: WorkflowEventEnvelope): CatalogPayload | undefined {
  if (event.type !== "workflow.cataloged" && event.type !== "workflow.retired") return undefined;
  const value = record(event.payload);
  if (!value || value.formatVersion !== 1 || typeof value.workflowId !== "string" || typeof value.definitionHash !== "string"
    || !Number.isSafeInteger(value.definitionVersion) || Number(value.definitionVersion) < 1) return undefined;
  return value as unknown as CatalogPayload;
}

function retiredPayload(previous: CatalogPayload): CatalogPayload {
  return Object.freeze({ ...previous, status: "retired", workflowConfigHash: previous.definitionHash, workflowConfigVersion: String(previous.definitionVersion) });
}

function appendCatalogEvent(projectRoot: string, projectId: string, type: "workflow.cataloged" | "workflow.retired", payload: CatalogPayload): void {
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId,
    sessionId: WORKFLOW_CATALOG_SESSION_ID,
    type,
    producer: "runtime",
    payload: payload as unknown as JsonValue,
  }));
}

/**
 * Scans configured workflow definitions into an immutable, event-backed catalog.
 * Identical resolved definitions retain the same hash and append no event.
 */
export function syncWorkflowCatalog(projectRoot: string, projectId: string): WorkflowCatalogSyncResult {
  const sessionsRoot = join(projectRoot, ".pi", "hive", "sessions");
  mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
  return withCrossProcessFileLock(join(sessionsRoot, ".workflow-catalog-sync"), () => {
    const project = loadConfigProject(projectRoot);
    if (project.status !== "configured") throw new Error("Workflow catalog requires a configured project");
    const catalogs = loadConfigCatalogs(project);
    const definitions = resolveConfigWorkflows(project, catalogs).workflows.slice().sort((left, right) => left.id.localeCompare(right.id));
    const events = readWorkflowJournal(projectRoot, WORKFLOW_CATALOG_SESSION_ID);
    const latest = new Map<string, { event: WorkflowEventEnvelope; payload: CatalogPayload }>();
    const versions = new Map<string, number>();
    const versionsByHash = new Map<string, number>();
    for (const event of events) {
      const payload = catalogPayload(event); if (!payload) continue;
      latest.set(payload.workflowId, { event, payload });
      versions.set(payload.workflowId, Math.max(versions.get(payload.workflowId) ?? 0, payload.definitionVersion));
      versionsByHash.set(`${payload.workflowId}\0${payload.definitionHash}`, payload.definitionVersion);
    }

    let cataloged = 0, retired = 0, unchanged = 0;
    const discovered = new Set(definitions.map((definition) => definition.id));
    for (const definition of definitions) {
      const definitionHash = hash(definitionIdentity(definition, catalogs));
      const prior = latest.get(definition.id);
      const desiredStatus = definition.status === "valid" ? "available" : "invalid";
      if (prior?.event.type === "workflow.cataloged" && prior.payload.definitionHash === definitionHash && prior.payload.status === desiredStatus) {
        const refreshed = boundedEntry(definition, catalogs, definitionHash, prior.payload.definitionVersion);
        if (canonicalJson(prior.payload) === canonicalJson(refreshed)) { unchanged++; continue; }
        appendCatalogEvent(projectRoot, projectId, "workflow.cataloged", refreshed); cataloged++; continue;
      }
      const sameVersion = versionsByHash.get(`${definition.id}\0${definitionHash}`);
      const definitionVersion = sameVersion ?? (versions.get(definition.id) ?? 0) + 1;
      const payload = boundedEntry(definition, catalogs, definitionHash, definitionVersion);
      appendCatalogEvent(projectRoot, projectId, "workflow.cataloged", payload);
      versions.set(definition.id, Math.max(versions.get(definition.id) ?? 0, definitionVersion));
      cataloged++;
    }
    for (const [workflowId, prior] of [...latest].sort(([left], [right]) => left.localeCompare(right))) {
      if (discovered.has(workflowId) || prior.event.type === "workflow.retired") continue;
      appendCatalogEvent(projectRoot, projectId, "workflow.retired", retiredPayload(prior.payload));
      retired++;
    }
    return Object.freeze({ discovered: definitions.length, cataloged, retired, unchanged });
  }, { timeoutMs: 5_000, staleMs: 30_000 });
}
