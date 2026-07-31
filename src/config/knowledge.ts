import { lstatSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { join, relative } from "node:path";
import { isPathInside } from "../core/safe-path";
import { hashCatalogFrames } from "./catalog-hash";
import { CONFIG_CATALOG_LIMITS, type AgentCatalogNode, type CatalogDependencyEdge } from "./catalog-types";
import { createDiagnosticCollector, type ConfigDiagnostic, type ConfigDiagnosticCode } from "./diagnostics";
import type { ConfiguredProject } from "./manifest";

export type KnowledgeUpdatePolicy = "automatic" | "reviewed" | "read-only";
interface KnowledgeBase { kind: "knowledge"; id: string; status: "available" | "failed"; diagnosticCodes: readonly ConfigDiagnosticCode[]; updates?: KnowledgeUpdatePolicy; owner?: string }
export interface AvailableKnowledgeCatalogNode extends KnowledgeBase {
  status: "available";
  updates: KnowledgeUpdatePolicy;
  canonicalPath: string;
  fingerprint: string;
  entryCount: number;
  metadataBytes: number;
}
export interface FailedKnowledgeCatalogNode extends KnowledgeBase { status: "failed" }
export type KnowledgeCatalogNode = AvailableKnowledgeCatalogNode | FailedKnowledgeCatalogNode;
export interface KnowledgeCatalogResult {
  knowledge: KnowledgeCatalogNode[];
  edges: CatalogDependencyEdge[];
  diagnostics: ConfigDiagnostic[];
  truncated: boolean;
}
export interface KnowledgeLoadOperations {
  readdir?(path: string): string[];
  lstat?(path: string): Stats;
  stat?(path: string): Stats;
  realpath?(path: string): string;
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function pointer(value: string): string { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }

export function loadKnowledgeCatalog(
  project: ConfiguredProject,
  agents: readonly AgentCatalogNode[],
  operations: KnowledgeLoadOperations = {},
): KnowledgeCatalogResult {
  const collector = createDiagnosticCollector();
  const knowledge: KnowledgeCatalogNode[] = [];
  const edges: CatalogDependencyEdge[] = [];
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const readdir = operations.readdir ?? ((path: string) => readdirSync(path));
  const lstat = operations.lstat ?? lstatSync;
  const stat = operations.stat ?? statSync;
  const realpath = operations.realpath ?? realpathSync.native;

  for (const entry of project.registries.knowledge) {
    const declaration = entry.declaredData;
    const owner = declaration.owner;
    const updates = declaration.updates ?? (owner ? "automatic" : "reviewed");
    if (entry.status === "failed" || !entry.canonicalPath) {
      knowledge.push({ kind: "knowledge", id: entry.id, status: "failed", diagnosticCodes: entry.diagnosticCodes, updates, ...(owner ? { owner } : {}) });
      continue;
    }
    const source = project.manifestSource;
    const codes: ConfigDiagnosticCode[] = [];
    const add = (code: ConfigDiagnosticCode, range = entry.sourceRange): void => {
      if (!codes.includes(code)) codes.push(code);
      collector.add({ code, severity: "error", message: "The knowledge catalog entry is invalid.", source, range, resourceId: entry.id });
    };
    if (owner) {
      const mapRange = project.sourceMap[`/knowledge/${pointer(entry.id)}/owner`]?.value ?? entry.sourceRange;
      const agent = agentById.get(owner);
      if (!agent) add("KNOWLEDGE_OWNER_UNKNOWN", mapRange);
      else if (agent.status === "failed") add("KNOWLEDGE_OWNER_FAILED", mapRange);
      edges.push({ from: `knowledge:${entry.id}`, target: `agent:${owner}`, source: project.manifestSource, range: mapRange, kind: "ownership" });
    }
    let root = entry.canonicalPath;
    const frames: string[] = ["metadata-shallow-v1", entry.projectPath ?? entry.declaredPath];
    let nameBytes = 0;
    let entryCount = 0;
    try {
      root = realpath(entry.canonicalPath);
      if (!isPathInside(project.projectRoot, root)) add("RESOURCE_PATH_ESCAPE");
      const names = [...readdir(entry.canonicalPath)].sort(compare);
      if (names.length > CONFIG_CATALOG_LIMITS.knowledgeEntries) add("KNOWLEDGE_FINGERPRINT_LIMIT_EXCEEDED");
      nameBytes = names.reduce((total, name) => total + Buffer.byteLength(name, "utf8"), 0);
      if (nameBytes > CONFIG_CATALOG_LIMITS.knowledgeFingerprintNameBytes) add("KNOWLEDGE_FINGERPRINT_LIMIT_EXCEEDED");
      for (const name of codes.length === 0 ? names : []) {
        const lexical = join(entry.canonicalPath, name);
        lstat(lexical);
        const target = realpath(lexical);
        if (!isPathInside(project.projectRoot, target) || !isPathInside(root, target)) { add("RESOURCE_PATH_ESCAPE"); break; }
        const targetStats = stat(lexical);
        const type = targetStats.isFile() ? "file" : targetStats.isDirectory() ? "directory" : "irregular";
        if (type === "irregular") { add("RESOURCE_TYPE_MISMATCH"); break; }
        frames.push(name, type, relative(project.projectRoot, target).split("\\").join("/"));
        entryCount++;
      }
    } catch {
      add("RESOURCE_ACCESS_FAILED");
    }
    if (codes.length > 0) {
      knowledge.push({ kind: "knowledge", id: entry.id, status: "failed", diagnosticCodes: codes, updates, ...(owner ? { owner } : {}) });
      continue;
    }
    knowledge.push({
      kind: "knowledge", id: entry.id, status: "available", diagnosticCodes: [], updates,
      ...(owner ? { owner } : {}), canonicalPath: root,
      fingerprint: hashCatalogFrames("knowledge-root-metadata", frames), entryCount, metadataBytes: nameBytes,
    });
  }
  const result = collector.result();
  return { knowledge, edges, diagnostics: result.diagnostics, truncated: result.truncated };
}
