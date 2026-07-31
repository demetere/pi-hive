import { readFileSync } from "node:fs";
import { loadAgentCatalog, type AgentLoadOperations } from "./agents";
import { CatalogAggregateLimitError } from "./catalog-budget";
import { CONFIG_CATALOG_LIMITS, type AgentCatalogNode, type CatalogDependencyEdge } from "./catalog-types";
import { createDiagnosticCollector, sourceRange, type ConfigDiagnostic, type ConfigDiagnosticCode } from "./diagnostics";
import { loadKnowledgeCatalog, type KnowledgeCatalogNode, type KnowledgeLoadOperations } from "./knowledge";
import { createBuiltInKnowledgeProviderRegistry, type KnowledgeProviderRegistry } from "../knowledge/provider";
import type { ConfiguredProject } from "./manifest";
import { loadSkillCatalog, type SkillCatalogNode, type SkillLoadOperations } from "./skills";

export type CatalogSummaryItem = {
  kind: "agent" | "skill" | "knowledge";
  id: string;
  status: "available" | "failed";
  diagnosticCodes: readonly ConfigDiagnosticCode[];
  name?: string;
  tags?: readonly string[];
  hashes?: readonly string[];
  files?: number;
  bytes?: number;
  updates?: string;
};
export interface CatalogSummary { items: CatalogSummaryItem[]; truncated: boolean; bytes: number }
export interface ConfigCatalogResult {
  status: "available";
  projectRoot: string;
  agents: AgentCatalogNode[];
  skills: SkillCatalogNode[];
  knowledge: KnowledgeCatalogNode[];
  edges: CatalogDependencyEdge[];
  diagnostics: ConfigDiagnostic[];
  truncated: boolean;
  summary: CatalogSummary;
}
export interface CatalogLoadOperations {
  agents?: AgentLoadOperations;
  skills?: SkillLoadOperations;
  knowledge?: KnowledgeLoadOperations;
  knowledgeProviders?: KnowledgeProviderRegistry;
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function dependencyDiagnostic(code: "CATALOG_DEPENDENCY_MISSING" | "CATALOG_DEPENDENCY_FAILED", edge: CatalogDependencyEdge): ConfigDiagnostic {
  return { code, severity: "error", message: "A catalog attachment dependency is unavailable.", source: edge.source, range: edge.range, resourceId: edge.from.slice(edge.from.indexOf(":") + 1), dependencyChain: [edge.from, edge.target] };
}
function failedAgent(agent: AgentCatalogNode, code: ConfigDiagnosticCode): AgentCatalogNode {
  return { kind: "agent", id: agent.id, status: "failed", diagnosticCodes: [...agent.diagnosticCodes, code] };
}
function summaryFor(agent: AgentCatalogNode): CatalogSummaryItem;
function summaryFor(skill: SkillCatalogNode): CatalogSummaryItem;
function summaryFor(knowledge: KnowledgeCatalogNode): CatalogSummaryItem;
function summaryFor(node: AgentCatalogNode | SkillCatalogNode | KnowledgeCatalogNode): CatalogSummaryItem {
  if (node.kind === "agent") return node.status === "available"
    ? { kind: "agent", id: node.id, status: node.status, diagnosticCodes: [], name: node.name, tags: node.tags, hashes: [node.sourceHash, node.canonicalSourceHash, node.promptHash], bytes: node.sourceBytes }
    : { kind: "agent", id: node.id, status: node.status, diagnosticCodes: node.diagnosticCodes };
  if (node.kind === "skill") return node.status === "available"
    ? { kind: "skill", id: node.id, status: node.status, diagnosticCodes: [], hashes: [node.treeHash], files: node.fileCount, bytes: node.totalBytes }
    : { kind: "skill", id: node.id, status: node.status, diagnosticCodes: node.diagnosticCodes };
  return node.status === "available"
    ? { kind: "knowledge", id: node.id, status: node.status, diagnosticCodes: [], hashes: [node.fingerprint], files: node.entryCount, bytes: node.metadataBytes, updates: node.updates }
    : { kind: "knowledge", id: node.id, status: node.status, diagnosticCodes: node.diagnosticCodes, updates: node.updates };
}
export function buildCatalogSummary(nodes: readonly (AgentCatalogNode | SkillCatalogNode | KnowledgeCatalogNode)[]): CatalogSummary {
  const sorted = [...nodes].sort((a, b) => compare(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`));
  const items: CatalogSummaryItem[] = [];
  let bytes = 2;
  let truncated = false;
  for (const node of sorted) {
    if (items.length >= CONFIG_CATALOG_LIMITS.summaryItems) { truncated = true; break; }
    const item = summaryFor(node as never);
    while (item.tags && Buffer.byteLength(JSON.stringify(item), "utf8") > CONFIG_CATALOG_LIMITS.summaryEntryBytes && item.tags.length > 0)
      item.tags = item.tags.slice(0, -1);
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (itemBytes > CONFIG_CATALOG_LIMITS.summaryEntryBytes || bytes + itemBytes + (items.length ? 1 : 0) > CONFIG_CATALOG_LIMITS.summaryBytes) { truncated = true; break; }
    items.push(item); bytes += itemBytes + (items.length > 1 ? 1 : 0);
  }
  return { items, truncated, bytes };
}

export function loadConfigCatalogs(project: ConfiguredProject, operations: CatalogLoadOperations = {}): ConfigCatalogResult {
  let consumed = 0;
  let exhausted = false;
  const reserveContentBytes = (bytes: number): void => {
    if (exhausted || !Number.isSafeInteger(bytes) || bytes < 0 || consumed + bytes > CONFIG_CATALOG_LIMITS.aggregateContentBytes) {
      exhausted = true;
      throw new CatalogAggregateLimitError();
    }
    consumed += bytes;
  };
  const budgetedRead = (read: ((path: string) => Uint8Array) | undefined, path: string): Uint8Array => {
    if (exhausted) throw new CatalogAggregateLimitError();
    const value = read?.(path) ?? readFileSync(path);
    reserveContentBytes(value.byteLength);
    return value;
  };
  const agentResult = loadAgentCatalog(project, {
    ...operations.agents,
    readFile: (path) => budgetedRead(operations.agents?.readFile, path),
  });
  const skillResult = loadSkillCatalog(project, {
    ...operations.skills,
    readFile: (path) => budgetedRead(operations.skills?.readFile, path),
  });
  const knowledgeResult = loadKnowledgeCatalog(project, agentResult.agents, operations.knowledge);
  let agents = [...agentResult.agents];
  const skills = skillResult.skills;
  const collector = createDiagnosticCollector();
  const knowledgeProviders = operations.knowledgeProviders ?? createBuiltInKnowledgeProviderRegistry();
  for (const diagnostic of [...agentResult.diagnostics, ...skillResult.diagnostics, ...knowledgeResult.diagnostics]) collector.add(diagnostic);
  let knowledge = knowledgeResult.knowledge.map((node): KnowledgeCatalogNode => {
    if (node.status !== "available") return node;
    const registry = project.registries.knowledge.find((entry) => entry.id === node.id);
    if (!registry?.projectPath) return { kind: "knowledge", id: node.id, status: "failed", diagnosticCodes: ["KNOWLEDGE_BUNDLE_INVALID"], updates: node.updates, ...(node.owner ? { owner: node.owner } : {}) };
    const loaded = knowledgeProviders.load({
      projectRoot: project.projectRoot,
      declaration: { id: node.id, providerId: registry.declaredData.provider, path: registry.projectPath, updatePolicy: node.updates, ...(node.owner ? { ownerAgentId: node.owner } : {}) },
      reserveContentBytes,
    });
    if (!loaded.ok || !loaded.bundle) {
      collector.add({
        code: "KNOWLEDGE_BUNDLE_INVALID", severity: "error",
        message: `The knowledge bundle is invalid (${loaded.diagnostics.slice(0, 8).map((item) => item.code).join(",") || "validation failed"}).`,
        source: project.manifestSource, range: registry.sourceRange, resourceId: node.id,
      });
      return { kind: "knowledge", id: node.id, status: "failed", diagnosticCodes: ["KNOWLEDGE_BUNDLE_INVALID"], updates: node.updates, ...(node.owner ? { owner: node.owner } : {}) };
    }
    return { ...node, fingerprint: loaded.bundle.contentHash, entryCount: loaded.bundle.documents.length, metadataBytes: loaded.bundle.totalBytes };
  });
  const edges = [...agentResult.edges, ...knowledgeResult.edges].sort((a, b) => compare(`${a.from}\0${a.target}`, `${b.from}\0${b.target}`));
  const statusByNode = new Map<string, "available" | "failed">();
  for (const node of agents) statusByNode.set(`agent:${node.id}`, node.status);
  for (const node of skills) statusByNode.set(`skill:${node.id}`, node.status);
  for (const node of knowledge) statusByNode.set(`knowledge:${node.id}`, node.status);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges.filter((item) => item.kind === "attachment")) {
      if (statusByNode.get(edge.from) !== "available") continue;
      const target = statusByNode.get(edge.target);
      if (target === "available") continue;
      const code = target === undefined ? "CATALOG_DEPENDENCY_MISSING" : "CATALOG_DEPENDENCY_FAILED";
      collector.add(dependencyDiagnostic(code, edge));
      const id = edge.from.slice("agent:".length);
      agents = agents.map((agent) => agent.id === id ? failedAgent(agent, code) : agent);
      statusByNode.set(edge.from, "failed");
      changed = true;
    }
    for (const edge of edges.filter((item) => item.kind === "ownership")) {
      if (statusByNode.get(edge.from) !== "available" || statusByNode.get(edge.target) !== "failed") continue;
      const id = edge.from.slice("knowledge:".length);
      knowledge = knowledge.map((node) => node.id === id
        ? { kind: "knowledge", id: node.id, status: "failed", diagnosticCodes: [...node.diagnosticCodes, "KNOWLEDGE_OWNER_FAILED"], updates: node.updates, ...(node.owner ? { owner: node.owner } : {}) }
        : node);
      statusByNode.set(edge.from, "failed");
      collector.add({
        code: "KNOWLEDGE_OWNER_FAILED",
        severity: "error",
        message: "The knowledge owner is unavailable after catalog dependency validation.",
        source: edge.source,
        range: edge.range,
        resourceId: id,
        dependencyChain: [edge.from, edge.target],
      });
      changed = true;
    }
  }
  const nodes = [...agents, ...skills, ...knowledge];
  const summary = buildCatalogSummary(nodes);
  if (summary.truncated) collector.add({ code: "CATALOG_SUMMARY_LIMIT_EXCEEDED", severity: "error", message: "Catalog summary exceeds its safety limit.", source: project.manifestSource, range: project.sourceMap[""]?.value ?? sourceRange(0, 1, 1, 0, 1, 1) });
  const result = collector.result();
  return { status: "available", projectRoot: project.projectRoot, agents, skills, knowledge, edges, diagnostics: result.diagnostics, truncated: result.truncated || summary.truncated, summary };
}
