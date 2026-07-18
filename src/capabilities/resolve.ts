import type { ConfigCatalogResult } from "../config/catalogs";
import type { AvailableAgentCatalogNode } from "../config/catalog-types";
import type { ResolvedTeam } from "../config/team";
import type { JsonValue } from "../config/types";
import { issueEffectiveAuthorityFromResolvedPolicies, type EffectiveAuthoritySnapshotV1 } from "../config/snapshot-authority";
import { resolveCapabilityOverlay } from "./policy";
import { deriveNodeTools } from "./tools";
import type { CapabilityDeclaration, CapabilityIssue, EffectiveNodePolicy } from "./types";

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function explicit(...values: Array<string | undefined>): string | undefined { return values.find((value) => value !== undefined && value !== "inherit"); }
function frozenSorted(values: readonly string[]): readonly string[] { return Object.freeze([...new Set(values)].sort(compare)); }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface ResolveEffectiveNodePolicyInput {
  workflowId: string;
  nodeId: string;
  agentId: string;
  root: boolean;
  directMembers: readonly string[];
  ceiling: CapabilityDeclaration;
  overlay?: CapabilityDeclaration;
  budgets: Readonly<Record<string, JsonValue>>;
  skills: readonly string[];
  knowledge: readonly string[];
  artifactAvailable?: boolean;
  knowledgeAvailable?: boolean;
  questionsAvailable?: boolean;
  projectModel?: string;
  projectThinking?: string;
  agentModel?: string;
  agentThinking?: string;
  nodeModel?: string;
  nodeThinking?: string;
  persistedRootModel?: string;
  persistedRootThinking?: string;
}
export interface ResolveEffectiveNodePolicyResult { readonly ok: boolean; readonly policy?: EffectiveNodePolicy; readonly issues: readonly CapabilityIssue[] }

export function resolveEffectiveNodePolicy(input: ResolveEffectiveNodePolicyInput): ResolveEffectiveNodePolicyResult {
  const resolved = resolveCapabilityOverlay(input.ceiling, input.overlay);
  if (!resolved.ok || !resolved.policy || !resolved.provenance) return Object.freeze({ ok: false, issues: resolved.issues });
  const directMemberIds = frozenSorted(input.directMembers);
  const skills = frozenSorted(input.skills), knowledge = frozenSorted(input.knowledge);
  const tools = deriveNodeTools({ capabilities: resolved.policy, root: input.root, directMemberIds, artifactAvailable: input.artifactAvailable ?? false, knowledgeAvailable: input.knowledgeAvailable ?? false, knowledgeAttached: knowledge.length > 0, questionsAvailable: input.questionsAvailable ?? false });
  const model = explicit(input.root ? input.persistedRootModel : undefined, input.nodeModel, input.agentModel, input.projectModel);
  const thinking = explicit(input.root ? input.persistedRootThinking : undefined, input.nodeThinking, input.agentThinking, input.projectThinking);
  return Object.freeze({
    ok: true,
    issues: Object.freeze([]),
    policy: Object.freeze({
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      agentId: input.agentId,
      capabilities: resolved.policy,
      provenance: resolved.provenance,
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      tools,
      budgets: deepFreeze(structuredClone(input.budgets)),
      skills,
      knowledge,
      directMemberIds,
    }),
  });
}

export interface WorkflowCapabilityIssue { readonly nodeId: string; readonly issue: CapabilityIssue }
export interface WorkflowCapabilityResolution {
  readonly ok: boolean;
  readonly policies: readonly EffectiveNodePolicy[];
  readonly authority?: EffectiveAuthoritySnapshotV1;
  readonly issues: readonly WorkflowCapabilityIssue[];
}
export function resolveWorkflowCapabilities(input: {
  workflowId: string;
  team: ResolvedTeam;
  catalogs: ConfigCatalogResult;
  artifactAvailable: boolean;
  knowledgeAvailable: boolean;
  questionsAvailable: boolean;
  projectModel?: string;
  projectThinking?: string;
  persistedRootModel?: string;
  persistedRootThinking?: string;
}): WorkflowCapabilityResolution {
  const agents = new Map(input.catalogs.agents.filter((node): node is AvailableAgentCatalogNode => node.status === "available").map((node) => [node.id, node]));
  const policies: EffectiveNodePolicy[] = [], issues: WorkflowCapabilityIssue[] = [];
  for (const node of input.team.nodes) {
    const agent = agents.get(node.agentId);
    if (!agent) {
      issues.push(Object.freeze({ nodeId: node.id, issue: Object.freeze({ code: "CAPABILITY_VALUE_INVALID", group: "filesystem", message: `Cannot resolve authority for unavailable catalog agent ${node.agentId}.` }) }));
      continue;
    }
    const result = resolveEffectiveNodePolicy({
      workflowId: input.workflowId,
      nodeId: node.id,
      agentId: node.agentId,
      root: node.id === input.team.rootId,
      directMembers: node.memberIds,
      ceiling: agent.frontmatter.capabilities,
      overlay: node.capabilities,
      budgets: node.budgets as unknown as Record<string, JsonValue>,
      skills: node.skills.resolved,
      knowledge: node.knowledge.resolved,
      artifactAvailable: input.artifactAvailable,
      knowledgeAvailable: input.knowledgeAvailable,
      questionsAvailable: input.questionsAvailable,
      projectModel: input.projectModel,
      projectThinking: input.projectThinking,
      agentModel: agent.frontmatter.model,
      agentThinking: agent.frontmatter.thinking,
      nodeModel: node.model,
      nodeThinking: node.thinking,
      persistedRootModel: input.persistedRootModel,
      persistedRootThinking: input.persistedRootThinking,
    });
    if (!result.ok || !result.policy) {
      for (const issue of result.issues) issues.push(Object.freeze({ nodeId: node.id, issue }));
    } else policies.push(result.policy);
  }
  policies.sort((a, b) => compare(a.nodeId, b.nodeId));
  if (issues.length) return Object.freeze({ ok: false, policies: Object.freeze(policies), issues: Object.freeze(issues) });
  const authority = issueEffectiveAuthorityFromResolvedPolicies({
    workflowId: input.workflowId,
    rootNodeId: input.team.rootId,
    policies,
    artifactAvailable: input.artifactAvailable,
    knowledgeAvailable: input.knowledgeAvailable,
    questionsAvailable: input.questionsAvailable,
  });
  return Object.freeze({ ok: true, policies: Object.freeze(policies), authority, issues: Object.freeze([]) });
}
