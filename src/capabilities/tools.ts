import { CAPABILITY_POLICY_LIMITS, type NormalizedCapabilities, type RouteMemberMetadata, type TrustedToolDescriptor } from "./types";

const OUTPUT = 65_536;
function freezeDescriptor(descriptor: TrustedToolDescriptor): TrustedToolDescriptor {
  if (descriptor.capability && "any" in descriptor.capability) Object.freeze(descriptor.capability.any);
  if (descriptor.capability && "anyOperation" in descriptor.capability) Object.freeze(descriptor.capability.anyOperation);
  if (descriptor.capability && "anyOf" in descriptor.capability) Object.freeze(descriptor.capability.anyOf);
  if (descriptor.capability) Object.freeze(descriptor.capability);
  return Object.freeze(descriptor);
}
export const TRUSTED_TOOL_DESCRIPTORS: readonly TrustedToolDescriptor[] = Object.freeze(([
  { name: "read", capability: { group: "filesystem", anyOperation: ["read"] }, topology: "any", mutability: "read-only", idempotency: "idempotent", maxOutputBytes: OUTPUT, requiresMutationQueue: false },
  { name: "write", capability: { group: "filesystem", anyOperation: ["create", "update", "delete"] }, topology: "any", mutability: "mutating", idempotency: "operation-bound", maxOutputBytes: OUTPUT, requiresMutationQueue: true },
  { name: "bash", capability: { group: "command", anyOf: ["shell", "git"] }, topology: "any", mutability: "mixed", idempotency: "non-idempotent", maxOutputBytes: OUTPUT, requiresMutationQueue: false },
  { name: "route_agent", topology: "members", mutability: "read-only", idempotency: "idempotent", maxOutputBytes: OUTPUT, requiresMutationQueue: false },
  { name: "delegate_agent", topology: "members", mutability: "mutating", idempotency: "operation-bound", maxOutputBytes: OUTPUT, requiresMutationQueue: false },
  { name: "team_status", topology: "members", mutability: "read-only", idempotency: "idempotent", maxOutputBytes: OUTPUT, requiresMutationQueue: false },
  { name: "workflow_status", topology: "root", mutability: "read-only", idempotency: "idempotent", maxOutputBytes: OUTPUT, requiresMutationQueue: false },
  { name: "workflow_finish", topology: "root", mutability: "mutating", idempotency: "operation-bound", maxOutputBytes: OUTPUT, requiresMutationQueue: false },
  { name: "artifact_status", capability: { group: "artifact", any: ["read"] }, topology: "any", subsystem: "artifact", mutability: "read-only", idempotency: "idempotent", maxOutputBytes: OUTPUT, requiresMutationQueue: false },
  { name: "artifact_action", capability: { group: "artifact", any: ["write", "review"] }, topology: "any", subsystem: "artifact", mutability: "mutating", idempotency: "operation-bound", maxOutputBytes: OUTPUT, requiresMutationQueue: true },
  { name: "knowledge_search", capability: { group: "knowledge", any: ["read"] }, topology: "any", subsystem: "knowledge", mutability: "read-only", idempotency: "idempotent", maxOutputBytes: OUTPUT, requiresMutationQueue: false },
  { name: "knowledge_read", capability: { group: "knowledge", any: ["read"] }, topology: "any", subsystem: "knowledge", mutability: "read-only", idempotency: "idempotent", maxOutputBytes: OUTPUT, requiresMutationQueue: false },
  { name: "human_question", capability: { group: "human-input" }, topology: "any", subsystem: "questions", mutability: "mutating", idempotency: "operation-bound", maxOutputBytes: OUTPUT, requiresMutationQueue: true },
] satisfies TrustedToolDescriptor[]).map(freezeDescriptor));

const DESCRIPTORS = new Map(TRUSTED_TOOL_DESCRIPTORS.map((descriptor) => [descriptor.name, descriptor]));
const TRUSTED_DESCRIPTOR_IDENTITIES = new WeakSet<object>(TRUSTED_TOOL_DESCRIPTORS);
export function classifyTrustedTool(name: string): TrustedToolDescriptor | undefined { return DESCRIPTORS.get(name); }
/** Package-owned registration identity is required in addition to a matching public name. */
export function classifyTrustedToolRegistration(name: string, registration: unknown): TrustedToolDescriptor | undefined {
  const descriptor = DESCRIPTORS.get(name);
  return descriptor === registration ? descriptor : undefined;
}
export function isTrustedToolDescriptor(value: unknown): value is TrustedToolDescriptor {
  return typeof value === "object" && value !== null && TRUSTED_DESCRIPTOR_IDENTITIES.has(value);
}

function capabilitySatisfied(descriptor: TrustedToolDescriptor, capabilities: NormalizedCapabilities): boolean {
  const requirement = descriptor.capability;
  if (!requirement) return true;
  if (requirement.group === "filesystem") return capabilities.filesystem.some((grant) => requirement.anyOperation.some((operation) => grant.operations.includes(operation)));
  if (requirement.group === "shell") return capabilities.shell.length > 0;
  if (requirement.group === "git") return capabilities.git;
  if (requirement.group === "command") return requirement.anyOf.some((group) => group === "shell" ? capabilities.shell.length > 0 : capabilities.git);
  if (requirement.group === "human-input") return capabilities.humanInput;
  if (requirement.group === "artifact") return requirement.any.some((operation) => capabilities.artifact.includes(operation));
  return requirement.any.some((operation) => capabilities.knowledge.includes(operation));
}

export interface ToolDerivationInput {
  capabilities: NormalizedCapabilities;
  root: boolean;
  directMemberIds: readonly string[];
  artifactAvailable: boolean;
  artifactActionsAvailable?: boolean;
  knowledgeAvailable: boolean;
  knowledgeAttached: boolean;
  questionsAvailable: boolean;
}
export function deriveNodeTools(input: ToolDerivationInput): readonly string[] {
  const members = input.directMemberIds.length > 0;
  const names = TRUSTED_TOOL_DESCRIPTORS.filter((descriptor) => {
    if (descriptor.topology === "root" && !input.root) return false;
    if (descriptor.topology === "members" && !members) return false;
    if (descriptor.subsystem === "artifact" && !input.artifactAvailable) return false;
    if (descriptor.name === "artifact_action" && !(input.artifactActionsAvailable ?? input.artifactAvailable)) return false;
    if (descriptor.subsystem === "knowledge" && (!input.knowledgeAvailable || !input.knowledgeAttached)) return false;
    if (descriptor.subsystem === "questions" && !input.questionsAvailable) return false;
    return capabilitySatisfied(descriptor, input.capabilities);
  }).map((descriptor) => descriptor.name).sort();
  return Object.freeze(names);
}

export interface RouteNodeInput {
  nodeId: string;
  parentId?: string;
  role?: string;
  responsibilities: readonly string[];
  consultWhen?: string;
  description?: string;
  tags: readonly string[];
  capabilities: NormalizedCapabilities;
}
export function routeMetadataForDirectMembers(parentNodeId: string, nodes: readonly RouteNodeInput[]): readonly RouteMemberMetadata[] {
  const direct = nodes.filter((node) => node.parentId === parentNodeId);
  if (direct.length > CAPABILITY_POLICY_LIMITS.routeMembers) throw new Error("Direct-member route metadata exceeds its safety limit.");
  return Object.freeze(direct.sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0).map((node) => Object.freeze({
    nodeId: node.nodeId,
    ...(node.role ? { role: node.role } : {}),
    responsibilities: Object.freeze([...node.responsibilities]),
    ...(node.consultWhen ? { consultWhen: node.consultWhen } : {}),
    ...(node.description ? { description: node.description } : {}),
    tags: Object.freeze([...node.tags].sort()),
    capabilities: node.capabilities,
  })));
}
