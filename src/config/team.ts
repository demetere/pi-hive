import type { RawAgentBudgets, RawCapabilities, RawTeamNodeV1, RawWorkflowBudgets } from "./types";
import type { ConfigCatalogResult } from "./catalogs";
import type { AvailableAgentCatalogNode, CatalogDependencyEdge } from "./catalog-types";
import { createDiagnosticCollector, sourceRange, type ConfigDiagnostic, type ConfigDiagnosticCode, type SourceRange } from "./diagnostics";
import type { YamlSourceMap } from "./yaml";
import { parseDurationV1, resolveBudgetDeclarations, validateBudgetDeclarations, type ResolvedBudgetDeclarations } from "./budgets";

export const WORKFLOW_LIMITS = Object.freeze({
  fileBytes: 524_288, teamDepth: 32, teamNodes: 1_024,
  nameBytes: 512, descriptionBytes: 2_048, useWhenBytes: 4_096, avoidWhenBytes: 4_096,
  roleBytes: 2_048, consultWhenBytes: 2_048, responsibilities: 128, responsibilityBytes: 2_048,
  tags: 128, examples: 64, exampleBytes: 4_096, suggestedNext: 128,
  instructionBytes: 196_608, instructionCombinedBytes: 262_144,
  selectorItems: 4_096, selectorEntryBytes: 4_096, selectorBytes: 262_144,
});
export interface ResolvedAttachmentDelta { base: readonly string[]; add: readonly string[]; remove: readonly string[]; resolved: readonly string[] }
export interface ResolvedTeamNode {
  id: string; agentId: string; parentId?: string; memberIds: readonly string[];
  depth: number; role?: string; responsibilities: readonly string[]; consultWhen?: string;
  model?: string; thinking?: string; capabilities?: RawCapabilities;
  capabilityStatus: "none" | "requires-w06-subset-validation";
  skills: ResolvedAttachmentDelta; knowledge: ResolvedAttachmentDelta;
  budgets: ResolvedBudgetDeclarations; range: SourceRange;
}
export interface ResolvedTeam { rootId: string; nodes: ResolvedTeamNode[] }
export interface TeamResolution { team?: ResolvedTeam; diagnostics: ConfigDiagnostic[]; edges: CatalogDependencyEdge[]; truncated: boolean; encounteredNodes: number }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function rangeFor(map: YamlSourceMap, pointer: string): SourceRange { return map[pointer]?.value ?? map[pointer]?.key ?? map[""]?.value ?? sourceRange(0, 1, 1, 0, 1, 1); }
function diagnostic(code: ConfigDiagnosticCode, source: string, workflowId: string, range: SourceRange, chain?: string[]): ConfigDiagnostic {
  return { code, severity: "error", message: "Workflow team validation failed.", source, range, resourceId: workflowId, ...(chain ? { dependencyChain: chain } : {}) };
}
function preflight(root: RawTeamNodeV1): { count: number; overLimit?: "depth" | "nodes" } {
  let count = 0;
  const expanded = new WeakSet<object>();
  const stack: Array<{ node: RawTeamNodeV1; depth: number }> = [{ node: root, depth: 1 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    count++;
    if (count > WORKFLOW_LIMITS.teamNodes) return { count, overLimit: "nodes" };
    if (depth > WORKFLOW_LIMITS.teamDepth) return { count, overLimit: "depth" };
    if (expanded.has(node as object)) continue;
    expanded.add(node as object);
    const members = node.members ?? [];
    for (let index = members.length - 1; index >= 0; index--) stack.push({ node: members[index], depth: depth + 1 });
  }
  return { count };
}
function resolveDelta(kind: "skill" | "knowledge", raw: { add?: string[]; remove?: string[] } | undefined, agent: AvailableAgentCatalogNode, catalogs: ConfigCatalogResult, source: string, workflowId: string, pointer: string, map: YamlSourceMap, collector: ReturnType<typeof createDiagnosticCollector>, edges: CatalogDependencyEdge[]): ResolvedAttachmentDelta {
  const base = [...(agent.frontmatter[kind === "skill" ? "skills" : "knowledge"] ?? [])].sort(compare);
  const add = [...(raw?.add ?? [])].sort(compare), remove = [...(raw?.remove ?? [])].sort(compare);
  const originalAdd = raw?.add ?? [], originalRemove = raw?.remove ?? [];
  const baseSet = new Set(base), removeSet = new Set(remove);
  const nodes = kind === "skill" ? catalogs.skills : catalogs.knowledge;
  const byId = new Map(nodes.map((node) => [node.id, node.status]));
  for (const id of add) {
    const target = `${kind}:${id}`, index = originalAdd.indexOf(id), itemRange = rangeFor(map, `${pointer}/add/${index}`);
    edges.push({ from: `workflow:${workflowId}`, target, source, range: itemRange, kind: "attachment" });
    if (removeSet.has(id)) collector.add(diagnostic("WORKFLOW_ATTACHMENT_CONFLICT", source, workflowId, itemRange));
    else if (baseSet.has(id)) collector.add(diagnostic("WORKFLOW_ATTACHMENT_ADD_EXISTING", source, workflowId, itemRange));
    else if (!byId.has(id)) collector.add(diagnostic("WORKFLOW_ATTACHMENT_UNKNOWN", source, workflowId, itemRange, [`workflow:${workflowId}`, target]));
    else if (byId.get(id) === "failed") collector.add(diagnostic("WORKFLOW_ATTACHMENT_FAILED", source, workflowId, itemRange, [`workflow:${workflowId}`, target]));
  }
  for (const id of remove) {
    const index = originalRemove.indexOf(id), itemRange = rangeFor(map, `${pointer}/remove/${index}`);
    if (!baseSet.has(id)) collector.add(diagnostic("WORKFLOW_ATTACHMENT_REMOVE_MISSING", source, workflowId, itemRange));
  }
  return { base, add, remove, resolved: [...base.filter((id) => !removeSet.has(id)), ...add.filter((id) => !baseSet.has(id) && !removeSet.has(id))].sort(compare) };
}
function budgetValue(raw: RawAgentBudgets, field: keyof RawAgentBudgets): number | undefined {
  const value = raw[field];
  return typeof value === "number" ? value : typeof value === "string" ? parseDurationV1(value) : undefined;
}
function wideningFields(node: RawAgentBudgets | undefined, agent: RawAgentBudgets | undefined): Array<keyof RawAgentBudgets> {
  if (!node || !agent) return [];
  return (["max-agent-turns", "max-tool-calls", "token-budget", "active-wall-time"] as const).filter((field) => {
    const nodeValue = budgetValue(node, field), agentValue = budgetValue(agent, field);
    return nodeValue !== undefined && agentValue !== undefined && nodeValue > agentValue;
  });
}
function metadataDiagnostics(node: RawTeamNodeV1, pointer: string, map: YamlSourceMap, source: string, workflowId: string, collector: ReturnType<typeof createDiagnosticCollector>): void {
  const add = (itemPointer: string) => collector.add(diagnostic("TEAM_METADATA_LIMIT_EXCEEDED", source, workflowId, rangeFor(map, itemPointer)));
  if (node.role && Buffer.byteLength(node.role, "utf8") > WORKFLOW_LIMITS.roleBytes) add(`${pointer}/role`);
  if (node["consult-when"] && Buffer.byteLength(node["consult-when"], "utf8") > WORKFLOW_LIMITS.consultWhenBytes) add(`${pointer}/consult-when`);
  if ((node.responsibilities?.length ?? 0) > WORKFLOW_LIMITS.responsibilities) add(`${pointer}/responsibilities`);
  node.responsibilities?.forEach((value, index) => { if (Buffer.byteLength(value, "utf8") > WORKFLOW_LIMITS.responsibilityBytes) add(`${pointer}/responsibilities/${index}`); });
}
export function resolveTeam(raw: RawTeamNodeV1, sourceMap: YamlSourceMap, source: string, workflowId: string, catalogs: ConfigCatalogResult, projectBudgets?: RawWorkflowBudgets, workflowBudgets?: RawWorkflowBudgets): TeamResolution {
  const preliminary = preflight(raw);
  if (preliminary.overLimit) {
    const code = preliminary.overLimit === "depth" ? "TEAM_DEPTH_EXCEEDED" : "TEAM_NODE_LIMIT_EXCEEDED";
    return { diagnostics: [diagnostic(code, source, workflowId, rangeFor(sourceMap, "/team"))], edges: [], truncated: false, encounteredNodes: preliminary.count };
  }
  const collector = createDiagnosticCollector(), edges: CatalogDependencyEdge[] = [], nodes: ResolvedTeamNode[] = [];
  const agents = new Map(catalogs.agents.map((agent) => [agent.id, agent]));
  const ids = new Set<string>(), objects = new WeakSet<object>();
  const stack: Array<{ raw: RawTeamNodeV1; depth: number; parentId?: string; pointer: string }> = [{ raw, depth: 1, pointer: "/team" }];
  while (stack.length) {
    const entry = stack.pop()!, nodeRaw = entry.raw, nodeRange = rangeFor(sourceMap, entry.pointer);
    if (objects.has(nodeRaw as object)) { collector.add(diagnostic("TEAM_OBJECT_REUSED", source, workflowId, nodeRange)); continue; }
    objects.add(nodeRaw as object);
    if (ids.has(nodeRaw.id)) { collector.add(diagnostic("TEAM_NODE_ID_DUPLICATE", source, workflowId, rangeFor(sourceMap, `${entry.pointer}/id`))); continue; }
    ids.add(nodeRaw.id);
    metadataDiagnostics(nodeRaw, entry.pointer, sourceMap, source, workflowId, collector);
    const catalogAgent = agents.get(nodeRaw.agent);
    const agentRange = rangeFor(sourceMap, `${entry.pointer}/agent`);
    edges.push({ from: `workflow:${workflowId}`, target: `agent:${nodeRaw.agent}`, source, range: agentRange, kind: "attachment" });
    if (!catalogAgent) collector.add(diagnostic("WORKFLOW_AGENT_UNKNOWN", source, workflowId, agentRange, [`workflow:${workflowId}`, `agent:${nodeRaw.agent}`]));
    else if (catalogAgent.status === "failed") collector.add(diagnostic("WORKFLOW_AGENT_FAILED", source, workflowId, agentRange, [`workflow:${workflowId}`, `agent:${nodeRaw.agent}`]));
    const available = catalogAgent?.status === "available" ? catalogAgent : undefined;
    const override = nodeRaw.overrides;
    const invalidBudgetFields = validateBudgetDeclarations(override?.budgets);
    for (const field of invalidBudgetFields) collector.add(diagnostic("WORKFLOW_BUDGET_INVALID", source, workflowId, rangeFor(sourceMap, `${entry.pointer}/overrides/budgets/${field}`)));
    for (const _field of validateBudgetDeclarations(available?.frontmatter.budgets)) collector.add(diagnostic("WORKFLOW_BUDGET_INVALID", source, workflowId, agentRange, [`workflow:${workflowId}`, `agent:${nodeRaw.agent}`]));
    for (const field of wideningFields(override?.budgets, available?.frontmatter.budgets)) collector.add(diagnostic("WORKFLOW_BUDGET_WIDENING", source, workflowId, rangeFor(sourceMap, `${entry.pointer}/overrides/budgets/${field}`)));
    const skills = available ? resolveDelta("skill", override?.skills, available, catalogs, source, workflowId, `${entry.pointer}/overrides/skills`, sourceMap, collector, edges) : { base: [], add: [], remove: [], resolved: [] };
    const knowledge = available ? resolveDelta("knowledge", override?.knowledge, available, catalogs, source, workflowId, `${entry.pointer}/overrides/knowledge`, sourceMap, collector, edges) : { base: [], add: [], remove: [], resolved: [] };
    nodes.push({ id: nodeRaw.id, agentId: nodeRaw.agent, ...(entry.parentId ? { parentId: entry.parentId } : {}), memberIds: (nodeRaw.members ?? []).map((x) => x.id), depth: entry.depth, ...(nodeRaw.role ? { role: nodeRaw.role } : {}), responsibilities: nodeRaw.responsibilities ?? [], ...(nodeRaw["consult-when"] ? { consultWhen: nodeRaw["consult-when"] } : {}), ...(override?.model ? { model: override.model } : {}), ...(override?.thinking ? { thinking: override.thinking } : {}), ...(override?.capabilities ? { capabilities: override.capabilities } : {}), capabilityStatus: override?.capabilities ? "requires-w06-subset-validation" : "none", skills, knowledge, budgets: resolveBudgetDeclarations({ project: projectBudgets, workflow: workflowBudgets, agent: available?.frontmatter.budgets, node: override?.budgets }), range: nodeRange });
    const members = nodeRaw.members ?? [];
    for (let index = members.length - 1; index >= 0; index--) stack.push({ raw: members[index], depth: entry.depth + 1, parentId: nodeRaw.id, pointer: `${entry.pointer}/members/${index}` });
  }
  const result = collector.result();
  return { ...(result.diagnostics.length === 0 ? { team: { rootId: raw.id, nodes } } : {}), diagnostics: result.diagnostics, edges, truncated: result.truncated, encounteredNodes: preliminary.count };
}
