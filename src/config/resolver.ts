import { validateArtifactDeclaration, ARTIFACT_CONTRACT_VERSION, ARTIFACT_PROFILE_VERSION, type ArtifactProfileContract } from "../artifacts/contracts";
import { ArtifactRegistryError, BUILTIN_ARTIFACT_REGISTRY, type ResolvedArtifactProfile } from "../artifacts/registry";
import { resolveWorkflowCapabilities } from "../capabilities/resolve";
import type { EffectiveNodePolicy } from "../capabilities/types";
import type { EffectiveAuthoritySnapshotV1 } from "./snapshot-authority";
import type { ConfigCatalogResult } from "./catalogs";
import type { CatalogDependencyEdge } from "./catalog-types";
import { createDiagnosticCollector, sourceRange, type ConfigDiagnostic, type ConfigDiagnosticCode } from "./diagnostics";
import type { ConfiguredProject } from "./manifest";
import { resolveTeam, WORKFLOW_LIMITS, type ResolvedTeam } from "./team";
import type { RawWorkflowV1 } from "./types";
import { loadWorkflowResources, type WorkflowLoadOperations } from "./workflows";
import type { YamlSourceMap } from "./yaml";
import { PACKAGE_BUDGET_CAPS, parseDurationV1, resolveBudgetDeclarations, validateBudgetDeclarations, type BudgetField, type ResolvedBudgetDeclarations } from "./budgets";

interface WorkflowBase { id: string; status: "valid" | "invalid"; diagnosticCodes: ConfigDiagnosticCode[]; diagnostics: ConfigDiagnostic[] }
interface SafeWorkflowMetadata { name?: string; description?: string; useWhen?: string; avoidWhen?: string; tags?: readonly string[]; examples?: readonly string[]; suggestedNext?: readonly string[]; adapter?: string; profile?: string }
export interface ValidWorkflowDefinition extends WorkflowBase, Required<Pick<SafeWorkflowMetadata, "name" | "description" | "useWhen" | "tags" | "examples" | "suggestedNext" | "adapter" | "profile">> {
  status: "valid"; avoidWhen?: string;
  artifact: RawWorkflowV1["artifact"] & { contractVersion: typeof ARTIFACT_CONTRACT_VERSION; contract: ArtifactProfileContract };
  approvals: Readonly<Record<string, "required" | "optional" | "none">>;
  instructions: RawWorkflowV1["instructions"]; team: ResolvedTeam;
  budgets: ResolvedBudgetDeclarations; authority: EffectiveAuthoritySnapshotV1; policies: readonly EffectiveNodePolicy[]; source: string; sourceMap: YamlSourceMap; rawSource: string;
}
export interface InvalidWorkflowDefinition extends WorkflowBase, SafeWorkflowMetadata { status: "invalid" }
export type WorkflowDefinition = ValidWorkflowDefinition | InvalidWorkflowDefinition;
export interface WorkflowSelectorSummaryItem extends SafeWorkflowMetadata { id: string; status: "valid" | "invalid"; diagnosticCodes: readonly ConfigDiagnosticCode[] }
export interface WorkflowSelectorSummaryV1 { version: 1; items: WorkflowSelectorSummaryItem[]; truncated: boolean; bytes: number }
export interface ConfigWorkflowResolution { workflows: WorkflowDefinition[]; edges: CatalogDependencyEdge[]; diagnostics: ConfigDiagnostic[]; truncated: boolean; summary: WorkflowSelectorSummaryV1; artifactContractVersion: typeof ARTIFACT_CONTRACT_VERSION }
export interface PersistedRootSelection { readonly workflowId: string; readonly model?: string; readonly thinking?: string }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function range(map: YamlSourceMap, pointer: string) { return map[pointer]?.value ?? map[pointer]?.key ?? map[""]?.value ?? sourceRange(0, 1, 1, 0, 1, 1); }
function issue(code: ConfigDiagnosticCode, id: string, source: string, map: YamlSourceMap, pointer: string, chain?: string[]): ConfigDiagnostic { return { code, severity: "error", message: "Workflow resolution failed.", source, range: range(map, pointer), resourceId: id, ...(chain ? { dependencyChain: chain } : {}) }; }
function safeMetadata(raw: RawWorkflowV1): SafeWorkflowMetadata {
  return { name: raw.name, description: raw.description, useWhen: raw["use-when"], ...(raw["avoid-when"] ? { avoidWhen: raw["avoid-when"] } : {}), tags: raw.tags ?? [], examples: raw.examples ?? [], suggestedNext: raw["suggested-next"] ?? [], adapter: raw.artifact.adapter, profile: raw.artifact.profile };
}
function truncateUtf8(value: string, maximum: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(`${output}${character}…`, "utf8") > maximum) break;
    output += character;
  }
  return `${output}…`;
}
function itemBytes(item: WorkflowSelectorSummaryItem): number { return Buffer.byteLength(JSON.stringify(item), "utf8"); }
function reduceItem(original: WorkflowSelectorSummaryItem): { item: WorkflowSelectorSummaryItem; truncated: boolean } {
  const item: WorkflowSelectorSummaryItem = { ...original, tags: original.tags ? [...original.tags] : undefined, examples: original.examples ? [...original.examples] : undefined, suggestedNext: original.suggestedNext ? [...original.suggestedNext] : undefined };
  let truncated = false;
  for (const key of ["examples", "tags", "suggestedNext"] as const) {
    while (itemBytes(item) > WORKFLOW_LIMITS.selectorEntryBytes && item[key]?.length) { item[key] = item[key]!.slice(0, -1); truncated = true; }
  }
  for (const key of ["description", "useWhen", "avoidWhen", "name"] as const) {
    if (itemBytes(item) <= WORKFLOW_LIMITS.selectorEntryBytes || !item[key]) continue;
    const before = item[key]!;
    item[key] = truncateUtf8(before, Math.max(16, Buffer.byteLength(before, "utf8") - (itemBytes(item) - WORKFLOW_LIMITS.selectorEntryBytes) - 8));
    truncated = true;
  }
  if (itemBytes(item) > WORKFLOW_LIMITS.selectorEntryBytes) {
    const minimal: WorkflowSelectorSummaryItem = { id: truncateUtf8(item.id, 256), status: item.status, diagnosticCodes: item.diagnosticCodes };
    return { item: minimal, truncated: true };
  }
  return { item, truncated };
}
export function buildWorkflowSelectorSummary(definitions: readonly WorkflowDefinition[]): WorkflowSelectorSummaryV1 {
  const items: WorkflowSelectorSummaryItem[] = [], sorted = [...definitions].sort((a, b) => compare(a.id, b.id));
  let truncated = false, bytes = 2;
  for (const definition of sorted) {
    if (items.length >= WORKFLOW_LIMITS.selectorItems) { truncated = true; break; }
    const projected: WorkflowSelectorSummaryItem = { id: definition.id, status: definition.status, diagnosticCodes: definition.diagnosticCodes, ...safeDefinitionMetadata(definition) };
    const reduced = reduceItem(projected);
    if (reduced.truncated) truncated = true;
    const encodedBytes = itemBytes(reduced.item), nextBytes = bytes + encodedBytes + (items.length ? 1 : 0);
    if (nextBytes > WORKFLOW_LIMITS.selectorBytes) { truncated = true; continue; }
    items.push(reduced.item);
    bytes = nextBytes;
  }
  return { version: 1, items, truncated, bytes };
}
function safeDefinitionMetadata(definition: WorkflowDefinition): SafeWorkflowMetadata {
  const keys: Array<keyof SafeWorkflowMetadata> = ["name", "description", "useWhen", "avoidWhen", "tags", "examples", "suggestedNext", "adapter", "profile"];
  const output: SafeWorkflowMetadata = {};
  for (const key of keys) if (definition[key] !== undefined) Object.assign(output, { [key]: definition[key] });
  return output;
}
function budgetCode(raw: RawWorkflowV1["budgets"], field: BudgetField): ConfigDiagnosticCode {
  const declared = raw?.[field as keyof typeof raw];
  const parsed = typeof declared === "string" ? parseDurationV1(declared) : declared;
  return parsed === undefined ? "WORKFLOW_BUDGET_INVALID" : parsed > PACKAGE_BUDGET_CAPS[field] ? "WORKFLOW_BUDGET_WIDENING" : "WORKFLOW_BUDGET_INVALID";
}
export function resolveConfigWorkflows(project: ConfiguredProject, catalogs: ConfigCatalogResult, operations: WorkflowLoadOperations = {}, persistedRootSelection?: PersistedRootSelection): ConfigWorkflowResolution {
  const resources = loadWorkflowResources(project, operations), definitions: WorkflowDefinition[] = [], edges: CatalogDependencyEdge[] = [];
  const collector = createDiagnosticCollector(), registered = new Set(project.registries.workflows.map((x) => x.id));
  const projectBudgets = project.manifest.settings?.defaults?.workflow?.budgets;
  for (const resource of resources) {
    if (resource.status === "failed") {
      for (const diagnostic of resource.diagnostics) collector.add(diagnostic);
      definitions.push({ id: resource.id, status: "invalid", diagnostics: resource.diagnostics, diagnosticCodes: resource.diagnostics.map((x) => x.code) });
      continue;
    }
    const local = createDiagnosticCollector(), raw = resource.value, metadata = safeMetadata(raw);
    for (const field of validateBudgetDeclarations(projectBudgets)) {
      local.add({
        code: budgetCode(projectBudgets, field),
        severity: "error",
        message: "Project workflow budget default is invalid.",
        source: project.manifestSource,
        range: range(project.sourceMap, `/settings/defaults/workflow/budgets/${field}`),
        resourceId: resource.id,
      });
    }
    const artifact = validateArtifactDeclaration(raw.artifact, raw.approvals);
    let resolvedArtifact: ResolvedArtifactProfile | undefined;
    if (artifact.contract) {
      try {
        resolvedArtifact = BUILTIN_ARTIFACT_REGISTRY.resolveProfile({
          contractVersion: ARTIFACT_CONTRACT_VERSION,
          adapterId: artifact.contract.adapter,
          adapterVersion: artifact.contract.adapterVersion ?? ARTIFACT_PROFILE_VERSION,
          profileId: artifact.contract.profile,
          profileVersion: artifact.contract.profileVersion ?? ARTIFACT_PROFILE_VERSION,
        });
      } catch (error) {
        if (!(error instanceof ArtifactRegistryError) || error.code !== "ADAPTER_UNAVAILABLE") throw error;
        local.add(issue("ARTIFACT_ADAPTER_UNAVAILABLE", resource.id, resource.source, resource.sourceMap, "/artifact/adapter"));
      }
    }
    const unknownCheckpoints = Object.keys(raw.approvals ?? {}).filter((id) => !artifact.contract?.checkpoints.includes(id));
    for (const code of artifact.codes) {
      const pointer = code === "ARTIFACT_BINDING_INVALID" ? "/artifact/binding"
        : code === "ARTIFACT_OPTIONS_UNKNOWN" ? "/artifact/options"
        : code === "ARTIFACT_PROFILE_UNKNOWN" ? "/artifact/profile"
        : code === "WORKFLOW_CHECKPOINT_UNKNOWN" && unknownCheckpoints.length ? `/approvals/${unknownCheckpoints.shift()}`
        : "/approvals";
      local.add(issue(code, resource.id, resource.source, resource.sourceMap, pointer));
    }
    for (const field of validateBudgetDeclarations(raw.budgets)) local.add(issue(budgetCode(raw.budgets, field), resource.id, resource.source, resource.sourceMap, `/budgets/${field}`));
    const team = resolveTeam(raw.team, resource.sourceMap, resource.source, resource.id, catalogs, projectBudgets, raw.budgets);
    for (const diagnostic of team.diagnostics) local.add(diagnostic);
    edges.push(...team.edges);
    const capabilities = team.team ? resolveWorkflowCapabilities({
      workflowId: resource.id,
      team: team.team,
      catalogs,
      artifactAvailable: resolvedArtifact !== undefined,
      artifactActionsAvailable: Boolean(resolvedArtifact?.adapter.executeAction && resolvedArtifact.profile.actions.length),
      knowledgeAvailable: false,
      questionsAvailable: false,
      projectModel: project.manifest.settings?.defaults?.agent?.model,
      projectThinking: project.manifest.settings?.defaults?.agent?.thinking,
      ...(persistedRootSelection?.workflowId === resource.id ? {
        persistedRootModel: persistedRootSelection.model,
        persistedRootThinking: persistedRootSelection.thinking,
      } : {}),
    }) : undefined;
    for (const finding of capabilities?.issues ?? []) local.add({
      code: finding.issue.code === "CAPABILITY_CLAUSE_LIMIT_EXCEEDED" ? "WORKFLOW_CAPABILITY_LIMIT_EXCEEDED" : "WORKFLOW_CAPABILITY_WIDENING",
      severity: "error",
      message: finding.issue.message,
      source: resource.source,
      range: team.team?.nodes.find((node) => node.id === finding.nodeId)?.range ?? range(resource.sourceMap, "/team"),
      resourceId: resource.id,
      dependencyChain: [`workflow:${resource.id}`, `node:${finding.nodeId}`],
    });
    if (resolvedArtifact && capabilities) {
      for (const action of resolvedArtifact.profile.actions.filter((candidate) => candidate.completion === "mandatory")) {
        const reachable = capabilities.policies.some((policy) => action.requiredCapabilities.every((required) => policy.capabilities.artifact.includes(required)));
        if (!reachable) local.add({
          code: "ARTIFACT_ACTION_UNREACHABLE",
          severity: "error",
          message: `Artifact action ${action.id} has no reachable node with its complete required capability set.`,
          source: resource.source,
          range: range(resource.sourceMap, "/artifact/profile"),
          resourceId: resource.id,
          dependencyChain: [`workflow:${resource.id}`, `artifact-action:${action.id}`],
        });
      }
    }
    (raw["suggested-next"] ?? []).forEach((target, index) => { if (!registered.has(target)) local.add(issue("WORKFLOW_SUGGESTED_NEXT_UNKNOWN", resource.id, resource.source, resource.sourceMap, `/suggested-next/${index}`, [`workflow:${resource.id}`, `workflow:${target}`])); });
    const result = local.result();
    for (const diagnostic of result.diagnostics) collector.add(diagnostic);
    if (result.diagnostics.length || !team.team || !artifact.contract || !capabilities?.authority) {
      definitions.push({ id: resource.id, status: "invalid", diagnostics: result.diagnostics, diagnosticCodes: result.diagnostics.map((x) => x.code), ...metadata });
    } else {
      definitions.push({ id: resource.id, status: "valid", diagnostics: [], diagnosticCodes: [], ...metadata as Required<Pick<SafeWorkflowMetadata, "name" | "description" | "useWhen" | "tags" | "examples" | "suggestedNext" | "adapter" | "profile">>, artifact: { ...raw.artifact, contractVersion: ARTIFACT_CONTRACT_VERSION, contract: artifact.contract }, approvals: raw.approvals ?? {}, instructions: raw.instructions, team: team.team, budgets: resolveBudgetDeclarations({ project: projectBudgets, workflow: raw.budgets }), authority: capabilities.authority, policies: capabilities.policies, source: resource.source, sourceMap: resource.sourceMap, rawSource: resource.rawSource });
    }
  }
  definitions.sort((a, b) => compare(a.id, b.id));
  const projected = buildWorkflowSelectorSummary(definitions);
  if (projected.truncated) collector.add({ code: "WORKFLOW_SUMMARY_LIMIT_EXCEEDED", severity: "error", message: "Workflow summary exceeds its safety limit.", source: project.manifestSource, range: project.sourceMap[""]?.value ?? sourceRange(0, 1, 1, 0, 1, 1) });
  const result = collector.result();
  edges.sort((a, b) => compare(`${a.from}\0${a.target}`, `${b.from}\0${b.target}`));
  return { workflows: definitions, edges, diagnostics: result.diagnostics, truncated: result.truncated || projected.truncated, summary: projected, artifactContractVersion: ARTIFACT_CONTRACT_VERSION };
}
