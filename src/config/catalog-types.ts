import type { ConfigDiagnostic, SourceRange } from "./diagnostics";
import type { RawAgentFrontmatterV1 } from "./types";

export const CONFIG_CATALOG_LIMITS = Object.freeze({
  agentFileBytes: 262_144,
  frontmatterBytes: 65_536,
  promptBodyBytes: 196_608,
  agentNameBytes: 512,
  agentDescriptionBytes: 2_048,
  agentModelBytes: 256,
  agentTags: 128,
  agentSkills: 128,
  agentKnowledge: 128,
  agentAttachments: 256,
  aggregateContentBytes: 16_777_216,
  skillDepth: 32,
  skillFiles: 1_024,
  skillFileBytes: 262_144,
  skillAggregateBytes: 8_388_608,
  skillPathBytes: 262_144,
  knowledgeEntries: 1_024,
  knowledgeFingerprintNameBytes: 262_144,
  summaryItems: 4_096,
  summaryBytes: 262_144,
  summaryEntryBytes: 2_048,
});

export type CatalogNodeStatus = "available" | "failed";
export type CatalogKind = "agent" | "skill" | "knowledge";

export interface CatalogDependencyEdge {
  from: string;
  target: string;
  source: string;
  range: SourceRange;
  kind: "attachment" | "ownership";
}

export interface AgentFileRanges {
  source: SourceRange;
  frontmatter: SourceRange;
  openingDelimiter: SourceRange;
  closingDelimiter: SourceRange;
  body: SourceRange;
}

interface AgentNodeBase {
  kind: "agent";
  id: string;
  status: CatalogNodeStatus;
  diagnosticCodes: readonly ConfigDiagnostic["code"][];
}

export interface AvailableAgentCatalogNode extends AgentNodeBase {
  status: "available";
  name: string;
  tags: readonly string[];
  frontmatter: RawAgentFrontmatterV1;
  prompt: string;
  ranges: AgentFileRanges;
  sourceHash: string;
  canonicalSourceHash: string;
  promptHash: string;
  sourceBytes: number;
}

export interface FailedAgentCatalogNode extends AgentNodeBase {
  status: "failed";
}

export type AgentCatalogNode = AvailableAgentCatalogNode | FailedAgentCatalogNode;

export interface AgentCatalogResult {
  agents: AgentCatalogNode[];
  edges: CatalogDependencyEdge[];
  diagnostics: ConfigDiagnostic[];
  truncated: boolean;
  loadedBytes: number;
}
