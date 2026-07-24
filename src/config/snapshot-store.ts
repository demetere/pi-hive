import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ARTIFACT_VIEW_VERSION } from "../artifacts/contracts";
import { BUILTIN_ARTIFACT_REGISTRY } from "../artifacts/registry";
import { resolveCapabilityOverlay } from "../capabilities/policy";
import type { CapabilityDeclaration, NormalizedCapabilities } from "../capabilities/types";
import { resolveContainedPath } from "../core/safe-path";
import { validateSerializedEffectiveAuthorityNodeV1 } from "./snapshot-authority";
import { canonicalJson } from "./snapshot-canonical";
import { SNAPSHOT_CONTEXT_POLICY } from "./snapshot-model";
import { SNAPSHOT_LIMITS, validateSnapshotRelativePath, validateSnapshotSha256, verifyActivationSnapshotHash, type ActivationSnapshotFileV1, type SnapshotSourceV1 } from "./snapshot";

export interface SnapshotStoreOperations {
  /** Test seam retained for fault injection. Production publication never renames over an existing target. */
  rename?(oldPath: string, newPath: string): void;
  publish?(temporaryPath: string, destinationPath: string): void;
}

function assertHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Snapshot hash is invalid.");
}
export function snapshotFilePath(projectRoot: string, hash: string): string {
  assertHash(hash);
  return join(projectRoot, ".pi", "hive", "sessions", "activations", `${hash}.json`);
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`Snapshot ${label} has an invalid shape.`);
  return value;
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length || missing.length) throw new Error(`Snapshot ${label} has unknown or missing fields.`);
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Snapshot ${label} must be a string.`);
  return value;
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`Snapshot ${label} must be a string array.`);
  return value;
}
function safeInteger(value: unknown, label: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (positive ? (value as number) <= 0 : (value as number) < 0)) throw new Error(`Snapshot ${label} must be a ${positive ? "positive" : "non-negative"} safe integer.`);
  return value as number;
}
function validateJsonBudget(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let items = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if (++items > SNAPSHOT_LIMITS.jsonItems) throw new Error("Snapshot JSON item limit exceeded.");
    if (entry.depth > SNAPSHOT_LIMITS.jsonDepth) throw new Error("Snapshot JSON depth limit exceeded.");
    if (entry.value && typeof entry.value === "object") {
      for (const child of Object.values(entry.value)) stack.push({ value: child, depth: entry.depth + 1 });
    }
  }
}
function uniqueIds(values: readonly string[], label: string): Set<string> {
  const result = new Set<string>();
  for (const id of values) {
    if (result.has(id)) throw new Error(`Snapshot ${label} contains duplicate ID ${id}.`);
    result.add(id);
  }
  return result;
}
function sameIds(actual: Set<string>, expected: Set<string>, label: string): void {
  if (actual.size !== expected.size || [...actual].some((id) => !expected.has(id))) throw new Error(`Snapshot ${label} coverage does not match workflow team nodes.`);
}
interface SnapshotWorkflowNodeSource {
  readonly agentId: string;
  readonly parentId?: string;
  readonly memberIds: readonly string[];
  readonly depth?: number;
  readonly capabilities?: CapabilityDeclaration;
  readonly budgets: Readonly<Record<string, unknown>>;
  readonly skills: readonly string[];
  readonly knowledge: readonly string[];
}
interface SnapshotWorkflowCoverage {
  readonly nodeIds: Set<string>;
  readonly agentIds: Set<string>;
  readonly rootNodeId: string;
  readonly directMembers: Map<string, readonly string[]>;
  readonly nodes: Map<string, SnapshotWorkflowNodeSource>;
  readonly artifactAvailable: boolean;
  readonly artifactActionsAvailable: boolean;
}
function validateWorkflow(value: unknown): SnapshotWorkflowCoverage {
  const workflow = record(value, "workflow");
  exactKeys(workflow, ["id", "team"], ["name", "description", "useWhen", "avoidWhen", "tags", "examples", "suggestedNext", "artifact", "instructions", "budgets"], "workflow");
  string(workflow.id, "workflow.id");
  for (const key of ["name", "description", "useWhen", "avoidWhen"] as const) if (key in workflow) string(workflow[key], `workflow.${key}`);
  for (const key of ["tags", "examples", "suggestedNext"] as const) if (key in workflow) stringArray(workflow[key], `workflow.${key}`);
  let artifactAvailable = false;
  let artifactActionsAvailable = false;
  if (workflow.artifact !== undefined) {
    const artifact = record(workflow.artifact, "workflow.artifact");
    exactKeys(artifact, ["adapter", "adapterVersion", "profile", "profileVersion", "binding", "options", "optionsSchemaVersion", "contractVersion", "checkpoints", "actionIds", "viewVersion", "approvals"], [], "workflow.artifact");
    const adapterId = string(artifact.adapter, "workflow.artifact.adapter");
    const adapterVersion = string(artifact.adapterVersion, "workflow.artifact.adapterVersion");
    const profileId = string(artifact.profile, "workflow.artifact.profile");
    const profileVersion = string(artifact.profileVersion, "workflow.artifact.profileVersion");
    const binding = string(artifact.binding, "workflow.artifact.binding");
    const contractVersion = string(artifact.contractVersion, "workflow.artifact.contractVersion");
    const optionsSchemaVersion = string(artifact.optionsSchemaVersion, "workflow.artifact.optionsSchemaVersion");
    const checkpoints = stringArray(artifact.checkpoints, "workflow.artifact.checkpoints");
    const actionIds = stringArray(artifact.actionIds, "workflow.artifact.actionIds");
    if (new Set(checkpoints).size !== checkpoints.length || new Set(actionIds).size !== actionIds.length) throw new Error("Snapshot workflow artifact IDs must be unique.");
    if (artifact.viewVersion !== ARTIFACT_VIEW_VERSION) throw new Error("Snapshot workflow.artifact.viewVersion is invalid.");
    const options = record(artifact.options, "workflow.artifact.options");
    record(artifact.approvals, "workflow.artifact.approvals");
    const resolved = BUILTIN_ARTIFACT_REGISTRY.resolveProfile({ contractVersion, adapterId, adapterVersion, profileId, profileVersion });
    if (resolved.profile.optionsSchemaVersion !== optionsSchemaVersion || resolved.profile.viewVersion !== artifact.viewVersion
      || canonicalJson(resolved.profile.checkpointIds) !== canonicalJson(checkpoints)
      || canonicalJson(resolved.profile.actions.map((action) => action.id)) !== canonicalJson(actionIds)
      || !resolved.profile.bindings.some((candidate) => candidate === binding)) throw new Error("Snapshot workflow artifact profile contract does not match the active package implementation.");
    BUILTIN_ARTIFACT_REGISTRY.validateOptions(resolved.profile, options);
    artifactAvailable = true;
    artifactActionsAvailable = Boolean(resolved.adapter.executeAction && resolved.profile.actions.length);
  }
  if (workflow.instructions !== undefined) {
    const instructions = record(workflow.instructions, "workflow.instructions");
    exactKeys(instructions, [], ["shared", "root"], "workflow.instructions");
    for (const key of Object.keys(instructions)) string(instructions[key], `workflow.instructions.${key}`);
  }
  if (workflow.budgets !== undefined) record(workflow.budgets, "workflow.budgets");
  const team = record(workflow.team, "workflow.team");
  exactKeys(team, ["nodes"], ["rootId"], "workflow.team");
  const declaredRootId = team.rootId !== undefined ? string(team.rootId, "workflow.team.rootId") : undefined;
  if (!Array.isArray(team.nodes)) throw new Error("Snapshot workflow.team.nodes must be an array.");
  const nodeIds: string[] = [];
  const agentIds = new Set<string>();
  const directMembers = new Map<string, readonly string[]>();
  const nodes = new Map<string, SnapshotWorkflowNodeSource>();
  const inferredRoots: string[] = [];
  for (const [index, entry] of team.nodes.entries()) {
    const node = record(entry, `workflow.team.nodes[${index}]`);
    exactKeys(node, ["id", "agentId"], ["parentId", "memberIds", "depth", "role", "responsibilities", "consultWhen", "model", "thinking", "capabilities", "skills", "knowledge", "budgets"], `workflow.team.nodes[${index}]`);
    const nodeId = string(node.id, `workflow.team.nodes[${index}].id`);
    nodeIds.push(nodeId);
    const agentId = string(node.agentId, `workflow.team.nodes[${index}].agentId`);
    agentIds.add(agentId);
    if (!nodeId || !agentId) throw new Error("Snapshot workflow team node and agent IDs must be non-empty.");
    const members = node.memberIds === undefined ? [] : stringArray(node.memberIds, `workflow.team.nodes[${index}].memberIds`);
    if (new Set(members).size !== members.length) throw new Error(`Snapshot workflow.team.nodes[${index}].memberIds contains duplicates.`);
    const sortedMembers = Object.freeze([...members].sort());
    directMembers.set(nodeId, sortedMembers);
    const parentId = node.parentId === undefined ? undefined : string(node.parentId, `workflow.team.nodes[${index}].parentId`);
    if (parentId === "") throw new Error("Snapshot workflow team parent ID must be non-empty.");
    if (parentId === undefined) inferredRoots.push(nodeId);
    for (const key of ["role", "consultWhen", "model", "thinking"] as const) if (key in node) string(node[key], `workflow.team.nodes[${index}].${key}`);
    for (const key of ["memberIds", "responsibilities"] as const) if (key in node) stringArray(node[key], `workflow.team.nodes[${index}].${key}`);
    const depth = node.depth === undefined ? undefined : safeInteger(node.depth, `workflow.team.nodes[${index}].depth`);
    const budgets = node.budgets === undefined ? {} : record(node.budgets, `workflow.team.nodes[${index}].budgets`);
    const skillsRecord = node.skills === undefined ? {} : record(node.skills, `workflow.team.nodes[${index}].skills`);
    const knowledgeRecord = node.knowledge === undefined ? {} : record(node.knowledge, `workflow.team.nodes[${index}].knowledge`);
    const skills = skillsRecord.resolved === undefined ? [] : stringArray(skillsRecord.resolved, `workflow.team.nodes[${index}].skills.resolved`);
    const knowledge = knowledgeRecord.resolved === undefined ? [] : stringArray(knowledgeRecord.resolved, `workflow.team.nodes[${index}].knowledge.resolved`);
    if (new Set(skills).size !== skills.length || new Set(knowledge).size !== knowledge.length) throw new Error("Snapshot workflow team resolved attachments contain duplicates.");
    if (node.capabilities !== undefined) record(node.capabilities, `workflow.team.nodes[${index}].capabilities`);
    nodes.set(nodeId, {
      agentId,
      ...(parentId !== undefined ? { parentId } : {}),
      memberIds: sortedMembers,
      ...(depth !== undefined ? { depth } : {}),
      ...(node.capabilities !== undefined ? { capabilities: node.capabilities as CapabilityDeclaration } : {}),
      budgets,
      skills: Object.freeze([...skills]),
      knowledge: Object.freeze([...knowledge]),
    });
  }
  const uniqueNodeIds = uniqueIds(nodeIds, "workflow team nodes");
  if (nodes.size !== uniqueNodeIds.size) throw new Error("Snapshot workflow team graph contains duplicate nodes.");
  if (uniqueNodeIds.size === 0 || inferredRoots.length !== 1) throw new Error("Snapshot workflow team graph must contain exactly one root.");
  const rootNodeId = declaredRootId ?? inferredRoots[0];
  if (!uniqueNodeIds.has(rootNodeId) || inferredRoots[0] !== rootNodeId) throw new Error("Snapshot workflow team root must exist and have no parent.");

  const childrenByParent = new Map<string, string[]>();
  for (const id of uniqueNodeIds) childrenByParent.set(id, []);
  for (const [nodeId, node] of nodes) {
    if (nodeId === rootNodeId) {
      if (node.parentId !== undefined) throw new Error("Snapshot workflow team root must not have a parent.");
    } else {
      if (node.parentId === undefined || !uniqueNodeIds.has(node.parentId) || node.parentId === nodeId) throw new Error("Snapshot workflow team graph contains a missing or invalid parent.");
      childrenByParent.get(node.parentId)!.push(nodeId);
    }
    for (const memberId of node.memberIds) {
      if (!uniqueNodeIds.has(memberId) || memberId === nodeId) throw new Error("Snapshot workflow team graph contains a missing or invalid member.");
    }
  }
  for (const [nodeId, node] of nodes) {
    const expected = childrenByParent.get(nodeId)!.sort();
    if (expected.length !== node.memberIds.length || expected.some((id, index) => id !== node.memberIds[index])) throw new Error("Snapshot workflow team member lists do not match parent ownership.");
  }

  const seen = new Set<string>();
  const stack: Array<{ nodeId: string; depth: number }> = [{ nodeId: rootNodeId, depth: 1 }];
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current.nodeId)) throw new Error("Snapshot workflow team graph contains a cycle or duplicate parent.");
    seen.add(current.nodeId);
    const node = nodes.get(current.nodeId)!;
    if (node.depth !== undefined && node.depth !== current.depth) throw new Error("Snapshot workflow team depth is inconsistent with its parent graph.");
    for (const child of [...childrenByParent.get(current.nodeId)!].reverse()) stack.push({ nodeId: child, depth: current.depth + 1 });
  }
  if (seen.size !== uniqueNodeIds.size) throw new Error("Snapshot workflow team graph contains a cycle or disconnected nodes.");
  return { nodeIds: uniqueNodeIds, agentIds, rootNodeId, directMembers, nodes, artifactAvailable, artifactActionsAvailable };
}
function serializeNormalizedCapabilities(capabilities: NormalizedCapabilities): Record<string, unknown> {
  return {
    filesystem: capabilities.filesystem.map((grant) => ({
      path: grant.path,
      operations: [...grant.operations],
      include: [...grant.include],
      exclude: [...grant.exclude],
      ceilingClause: grant.ceilingClause,
    })),
    shell: [...capabilities.shell],
    git: capabilities.git,
    "external-network": capabilities.externalNetwork,
    "human-input": capabilities.humanInput,
    artifact: [...capabilities.artifact],
    knowledge: [...capabilities.knowledge],
  };
}
function requireCanonicalEquality(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`Snapshot authority ${label} diverges from its persisted capability source semantics.`);
}
function validatePayload(value: unknown): void {
  const payload = record(value, "payload");
  exactKeys(payload, ["versions", "project", "workflow", "agents", "skills", "knowledge", "authority", "models", "sources"], ["subsystems"], "payload");
  const versions = record(payload.versions, "versions");
  exactKeys(versions, ["snapshot", "packageContract", "schema", "capability", "catalogHash", "artifact", "contextPolicy", "package"], [], "versions");
  safeInteger(versions.snapshot, "versions.snapshot", true); safeInteger(versions.schema, "versions.schema", true); safeInteger(versions.capability, "versions.capability", true);
  for (const key of ["packageContract", "catalogHash", "artifact", "contextPolicy", "package"] as const) string(versions[key], `versions.${key}`);
  const project = record(payload.project, "project");
  exactKeys(project, ["projectId", "rootRef"], [], "project");
  string(project.projectId, "project.projectId");
  if (project.rootRef !== ".") throw new Error("Snapshot project.rootRef is invalid.");
  const workflowCoverage = validateWorkflow(payload.workflow);
  const workflow = payload.workflow as Record<string, unknown>;
  const artifact = (workflow.artifact as Record<string, unknown> | undefined);
  if (!artifact || artifact.contractVersion !== versions.artifact) throw new Error("Snapshot artifact contract invariant is invalid.");

  if (!Array.isArray(payload.agents)) throw new Error("Snapshot agents must be an array.");
  const agentIds: string[] = [];
  const agentCapabilityCeilings = new Map<string, CapabilityDeclaration>();
  for (const [index, entry] of payload.agents.entries()) {
    const agent = record(entry, `agents[${index}]`);
    exactKeys(agent, ["id", "name", "tags", "frontmatter", "prompt", "sourceHash", "canonicalSourceHash", "promptHash"], [], `agents[${index}]`);
    for (const key of ["id", "name", "prompt", "sourceHash", "canonicalSourceHash", "promptHash"] as const) string(agent[key], `agents[${index}].${key}`);
    const agentId = agent.id as string;
    agentIds.push(agentId);
    for (const key of ["sourceHash", "canonicalSourceHash", "promptHash"] as const) validateSnapshotSha256(agent[key] as string, `Snapshot agents[${index}].${key}`);
    stringArray(agent.tags, `agents[${index}].tags`);
    const frontmatter = record(agent.frontmatter, `agents[${index}].frontmatter`);
    const ceiling = frontmatter.capabilities === undefined ? {} : record(frontmatter.capabilities, `agents[${index}].frontmatter.capabilities`);
    agentCapabilityCeilings.set(agentId, ceiling as CapabilityDeclaration);
  }
  sameIds(uniqueIds(agentIds, "agents"), workflowCoverage.agentIds, "agent");
  if (!Array.isArray(payload.skills)) throw new Error("Snapshot skills must be an array.");
  const skillIds: string[] = [];
  for (const [index, entry] of payload.skills.entries()) {
    const skill = record(entry, `skills[${index}]`);
    exactKeys(skill, ["id", "treeHash", "files"], [], `skills[${index}]`);
    skillIds.push(string(skill.id, `skills[${index}].id`)); validateSnapshotSha256(string(skill.treeHash, `skills[${index}].treeHash`), `Snapshot skills[${index}].treeHash`);
    if (!Array.isArray(skill.files)) throw new Error(`Snapshot skills[${index}].files must be an array.`);
    for (const [fileIndex, fileValue] of skill.files.entries()) {
      const file = record(fileValue, `skills[${index}].files[${fileIndex}]`);
      exactKeys(file, ["relativePath", "content", "bytes", "hash"], [], `skills[${index}].files[${fileIndex}]`);
      validateSnapshotRelativePath(string(file.relativePath, "skill file path"), "Snapshot skill file path"); string(file.content, "skill file content"); validateSnapshotSha256(string(file.hash, "skill file hash"), "Snapshot skill file hash"); safeInteger(file.bytes, "skill file bytes");
    }
  }
  uniqueIds(skillIds, "skills");
  if (!Array.isArray(payload.knowledge)) throw new Error("Snapshot knowledge must be an array.");
  const knowledgeIds: string[] = [];
  for (const [index, entry] of payload.knowledge.entries()) {
    const dependency = record(entry, `knowledge[${index}]`);
    exactKeys(dependency, ["id", "provider", "path", "updates", "metadataFingerprint", "attachedNodeIds"], ["owner"], `knowledge[${index}]`);
    for (const key of ["id", "provider", "path", "updates", "metadataFingerprint"] as const) string(dependency[key], `knowledge[${index}].${key}`);
    knowledgeIds.push(dependency.id as string);
    validateSnapshotRelativePath(dependency.path as string, `Snapshot knowledge[${index}].path`);
    validateSnapshotSha256(dependency.metadataFingerprint as string, `Snapshot knowledge[${index}].metadataFingerprint`);
    if (dependency.owner !== undefined) string(dependency.owner, `knowledge[${index}].owner`);
    stringArray(dependency.attachedNodeIds, `knowledge[${index}].attachedNodeIds`);
  }
  uniqueIds(knowledgeIds, "knowledge");
  for (const [index, entry] of payload.knowledge.entries()) {
    const dependency = entry as Record<string, unknown>;
    const expectedAttachedNodeIds = [...workflowCoverage.nodes.entries()]
      .filter(([, node]) => node.knowledge.includes(dependency.id as string))
      .map(([nodeId]) => nodeId)
      .sort();
    const actualAttachedNodeIds = dependency.attachedNodeIds as string[];
    if (new Set(actualAttachedNodeIds).size !== actualAttachedNodeIds.length
      || canonicalJson(actualAttachedNodeIds) !== canonicalJson(expectedAttachedNodeIds)) {
      throw new Error(`Snapshot knowledge[${index}].attachedNodeIds diverges from frozen workflow attachments.`);
    }
  }
  let knowledgeAvailable = false;
  if (payload.subsystems !== undefined) {
    const subsystems = record(payload.subsystems, "subsystems");
    exactKeys(subsystems, ["knowledge"], [], "subsystems");
    if (typeof subsystems.knowledge !== "boolean") throw new Error("Snapshot subsystems.knowledge must be boolean.");
    knowledgeAvailable = subsystems.knowledge;
  }
  const authority = record(payload.authority, "authority");
  exactKeys(authority, ["capabilityContractVersion", "nodes"], [], "authority");
  safeInteger(authority.capabilityContractVersion, "authority.capabilityContractVersion", true);
  if (authority.capabilityContractVersion !== versions.capability) throw new Error("Snapshot capability contract invariant is invalid.");
  if (!Array.isArray(authority.nodes)) throw new Error("Snapshot authority.nodes must be an array.");
  const authorityNodeIds: string[] = [];
  const authoritySettings = new Map<string, { model?: string; thinking?: string }>();
  for (const entry of authority.nodes) {
    const authorityEntry = record(entry, "authority node");
    const nodeIdForContext = string(authorityEntry.nodeId, "authority node.nodeId");
    validateSerializedEffectiveAuthorityNodeV1(entry, {
      rootNodeId: workflowCoverage.rootNodeId,
      directMemberIds: workflowCoverage.directMembers.get(nodeIdForContext) ?? [],
      subsystems: { artifact: workflowCoverage.artifactAvailable, artifactActions: workflowCoverage.artifactActionsAvailable, knowledge: knowledgeAvailable, questions: true },
    });
    const workflowNode = workflowCoverage.nodes.get(nodeIdForContext);
    const ceiling = workflowNode ? agentCapabilityCeilings.get(workflowNode.agentId) : undefined;
    if (!workflowNode || !ceiling) throw new Error("Snapshot authority node has no persisted workflow/agent capability source.");
    const resolved = resolveCapabilityOverlay(ceiling, workflowNode.capabilities);
    if (!resolved.ok || !resolved.policy || !resolved.provenance) throw new Error("Snapshot authority capability source overlay is invalid.");
    const serializedPolicy = record(authorityEntry.capabilities, "authority node.capabilities");
    requireCanonicalEquality(serializedPolicy.effective, serializeNormalizedCapabilities(resolved.policy), "effective capability");
    requireCanonicalEquality(serializedPolicy.provenance, resolved.provenance, "provenance");
    requireCanonicalEquality(serializedPolicy.budgets, workflowNode.budgets, "budgets");
    requireCanonicalEquality(serializedPolicy.attachments, { skills: workflowNode.skills, knowledge: workflowNode.knowledge }, "attachments");
    const nodeId = entry.nodeId;
    authorityNodeIds.push(nodeId);
    authoritySettings.set(nodeId, {
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.thinking !== undefined ? { thinking: entry.thinking } : {}),
    });
  }
  sameIds(uniqueIds(authorityNodeIds, "authority nodes"), workflowCoverage.nodeIds, "authority node");
  if (!Array.isArray(payload.models)) throw new Error("Snapshot models must be an array.");
  const modelNodeIds: string[] = [];
  for (const [index, entry] of payload.models.entries()) {
    const model = record(entry, `models[${index}]`);
    exactKeys(model, ["nodeId", "modelId", "thinking", "staticTokens", "dynamicReserve", "contextWindow"], ["outputReserve"], `models[${index}]`);
    const nodeId = string(model.nodeId, `models[${index}].nodeId`);
    const modelId = string(model.modelId, `models[${index}].modelId`);
    const thinking = string(model.thinking, `models[${index}].thinking`);
    modelNodeIds.push(nodeId);
    const effective = authoritySettings.get(nodeId);
    if (effective?.model !== undefined && effective.model !== modelId) throw new Error(`Snapshot models[${index}] diverges from frozen authority model.`);
    if (effective?.thinking !== undefined && effective.thinking !== thinking) throw new Error(`Snapshot models[${index}] diverges from frozen authority thinking.`);
    const staticTokens = safeInteger(model.staticTokens, `models[${index}].staticTokens`);
    const dynamicReserve = safeInteger(model.dynamicReserve, `models[${index}].dynamicReserve`);
    const outputReserve = model.outputReserve === undefined ? undefined : safeInteger(model.outputReserve, `models[${index}].outputReserve`);
    const contextWindow = safeInteger(model.contextWindow, `models[${index}].contextWindow`, true);
    const minimumReserve = Math.max(SNAPSHOT_CONTEXT_POLICY.minimumDynamicReserve, Math.ceil(contextWindow * SNAPSHOT_CONTEXT_POLICY.contextFraction));
    const requiredDynamicReserve = nodeId === workflowCoverage.rootNodeId ? SNAPSHOT_CONTEXT_POLICY.minimumRootDynamicReserve : SNAPSHOT_CONTEXT_POLICY.minimumWorkerDynamicReserve;
    const currentPolicyInvalid = versions.contextPolicy === SNAPSHOT_CONTEXT_POLICY.version && (outputReserve === undefined || outputReserve < SNAPSHOT_CONTEXT_POLICY.minimumOutputReserve
      || staticTokens < SNAPSHOT_CONTEXT_POLICY.harnessReserve || dynamicReserve < requiredDynamicReserve || staticTokens + dynamicReserve + outputReserve > contextWindow);
    const legacyPolicyInvalid = versions.contextPolicy === "pi-hive-context-policy-v1" && (staticTokens < SNAPSHOT_CONTEXT_POLICY.harnessReserve || dynamicReserve < minimumReserve || staticTokens > contextWindow - dynamicReserve);
    if (currentPolicyInvalid || legacyPolicyInvalid) throw new Error(`Snapshot models[${index}] violates the context policy invariant.`);
  }
  sameIds(uniqueIds(modelNodeIds, "model nodes"), workflowCoverage.nodeIds, "model node");
  if (!Array.isArray(payload.sources)) throw new Error("Snapshot sources must be an array.");
  if (payload.sources.length > SNAPSHOT_LIMITS.sources) throw new Error("Snapshot source limit exceeded.");
  for (const [index, entry] of payload.sources.entries()) {
    const source = record(entry, `sources[${index}]`);
    exactKeys(source, ["path", "kind", "id", "hash", "canonicalHash"], [], `sources[${index}]`);
    for (const key of ["path", "kind", "id", "hash", "canonicalHash"] as const) string(source[key], `sources[${index}].${key}`);
    const typedSource = source as unknown as SnapshotSourceV1;
    validateSnapshotRelativePath(typedSource.path, `Snapshot sources[${index}].path`);
    if (!(["manifest", "workflow", "agent", "skill"] as const).includes(typedSource.kind) || !/^(?:root|[a-z][a-z0-9_-]*)$/.test(typedSource.id)) throw new Error(`Snapshot sources[${index}] kind or id is invalid.`);
    validateSnapshotSha256(typedSource.hash, `Snapshot sources[${index}].hash`);
    validateSnapshotSha256(typedSource.canonicalHash, `Snapshot sources[${index}].canonicalHash`);
  }
  // Reject accessors, non-finite values, unsupported prototypes, and sparse arrays even for flexible nested config records.
  canonicalJson(payload);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}
function validateEnvelope(value: unknown, expectedHash: string): ActivationSnapshotFileV1 {
  validateJsonBudget(value);
  const envelope = record(value, "file envelope");
  exactKeys(envelope, ["snapshotHash", "createdAt", "payload"], [], "file envelope");
  if (envelope.snapshotHash !== expectedHash) throw new Error("Snapshot filename/hash mismatch.");
  if (typeof envelope.createdAt !== "string" || !Number.isFinite(Date.parse(envelope.createdAt))) throw new Error("Snapshot file has invalid fields.");
  validatePayload(envelope.payload);
  const snapshot = envelope as unknown as ActivationSnapshotFileV1;
  if (!verifyActivationSnapshotHash(snapshot)) throw new Error("Snapshot integrity hash mismatch.");
  return snapshot;
}
export function readActivationSnapshot(projectRoot: string, hash: string): ActivationSnapshotFileV1 {
  const path = snapshotFilePath(projectRoot, hash);
  if (!resolveContainedPath(projectRoot, path)) throw new Error("Snapshot path escapes project containment.");
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new Error("Snapshot no-follow reads are unsupported on this platform.");
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | noFollow); }
  catch { throw new Error("Snapshot file is missing, not regular, or is a symlink."); }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error("Snapshot path is not a regular file.");
    if (!resolveContainedPath(projectRoot, path)) throw new Error("Snapshot path escapes project containment.");
    let initiallyLinked;
    try { initiallyLinked = lstatSync(path, { bigint: true }); } catch { throw new Error("Snapshot path changed before read."); }
    if (!initiallyLinked.isFile() || initiallyLinked.isSymbolicLink() || before.dev !== initiallyLinked.dev || before.ino !== initiallyLinked.ino) throw new Error("Snapshot path changed before read.");
    if ((before.mode & 0o777n) !== 0o600n) throw new Error("Snapshot file mode must be private (0600).");
    if (before.size > BigInt(SNAPSHOT_LIMITS.fileBytes)) throw new Error("Snapshot file exceeds its byte limit.");
    const expectedBytes = Number(before.size);
    const buffer = Buffer.allocUnsafe(expectedBytes + 1);
    let total = 0;
    try {
      while (total < buffer.byteLength) {
        const count = readSync(descriptor, buffer, total, buffer.byteLength - total, null);
        if (count === 0) break;
        total += count;
      }
    } catch { throw new Error("Snapshot file is malformed or truncated."); }
    if (total !== expectedBytes) throw new Error("Snapshot path changed during bounded read.");
    const encoded = buffer.subarray(0, total).toString("utf8");
    const after = fstatSync(descriptor, { bigint: true });
    let linked;
    try { linked = lstatSync(path, { bigint: true }); } catch { throw new Error("Snapshot path changed during read."); }
    if (!linked.isFile() || linked.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.dev !== linked.dev || after.ino !== linked.ino) throw new Error("Snapshot path changed during read.");
    if (!resolveContainedPath(projectRoot, path)) throw new Error("Snapshot path escapes project containment.");
    let parsed: unknown;
    try { parsed = JSON.parse(encoded); } catch { throw new Error("Snapshot file is malformed or truncated."); }
    return deepFreeze(validateEnvelope(parsed, hash));
  } finally {
    closeSync(descriptor);
  }
}
function publishWithoutClobber(temporary: string, destination: string): void {
  linkSync(temporary, destination);
  unlinkSync(temporary);
}
export function writeActivationSnapshot(projectRoot: string, snapshot: ActivationSnapshotFileV1, operations: SnapshotStoreOperations = {}): string {
  assertHash(snapshot.snapshotHash);
  validateEnvelope(snapshot, snapshot.snapshotHash);
  const encoded = canonicalJson(snapshot);
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > SNAPSHOT_LIMITS.fileBytes) throw new Error("Snapshot file exceeds its byte limit.");
  const path = snapshotFilePath(projectRoot, snapshot.snapshotHash);
  const directory = dirname(path);
  const projectedDirectory = resolveContainedPath(projectRoot, directory, { allowMissing: true });
  if (!projectedDirectory) throw new Error("Snapshot directory escapes project containment.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const containedDirectory = resolveContainedPath(projectRoot, directory);
  if (!containedDirectory?.exists) throw new Error("Snapshot directory escapes project containment.");
  chmodSync(directory, 0o700);
  if (existsSync(path)) {
    readActivationSnapshot(projectRoot, snapshot.snapshotHash);
    return path;
  }
  const temporary = join(directory, `.${snapshot.snapshotHash}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(fileDescriptor, encoded, "utf8");
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor); fileDescriptor = undefined;
    const publish = operations.publish ?? operations.rename ?? publishWithoutClobber;
    try {
      publish(temporary, path);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      readActivationSnapshot(projectRoot, snapshot.snapshotHash);
    }
    const directoryDescriptor = openSync(directory, "r");
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    readActivationSnapshot(projectRoot, snapshot.snapshotHash);
    return path;
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
