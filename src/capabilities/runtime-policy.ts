import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import { knowledgeProtectedPathRoots } from "../knowledge/attachments";
import { createCommandPolicyHook } from "./command";
import {
  compileFilesystemPolicy,
  createFilesystemPolicyHook,
  type CompileFilesystemPolicyInput,
  type CompiledFilesystemPolicy,
} from "./filesystem";
import type {
  ArtifactCapability,
  EffectiveNodePolicy,
  FilesystemOperation,
  KnowledgeCapability,
  NormalizedCapabilities,
  ShellCapability,
} from "./types";

export interface SnapshotNodeToolPolicy {
  readonly nodeId: string;
  readonly capabilities: NormalizedCapabilities;
  readonly filesystem: CompiledFilesystemPolicy;
  readonly hook: (event: { readonly toolName?: unknown; readonly input?: unknown }) => Promise<{ block: true; reason: string } | undefined>;
}

export interface CompileSnapshotNodeToolPoliciesInput {
  readonly projectRoot: string;
  readonly snapshot: ActivationSnapshotFileV1;
  readonly secretPaths?: readonly string[];
  readonly artifact?: CompileFilesystemPolicyInput["artifact"];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringArray<T extends string>(value: unknown, allowed: readonly T[], label: string): readonly T[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !allowed.includes(entry as T)) || new Set(value).size !== value.length) {
    throw new Error(`Snapshot node ${label} capability is invalid`);
  }
  return Object.freeze([...value] as T[]);
}

function patterns(value: unknown, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string") || new Set(value).size !== value.length) throw new Error(`Snapshot node ${label} is invalid`);
  return Object.freeze([...value]);
}

function capabilitiesFromAuthority(value: unknown): NormalizedCapabilities {
  const authority = record(value);
  const effective = record(authority?.effective) ?? {};
  const rawFilesystem = effective.filesystem;
  const filesystem = rawFilesystem === undefined
    ? Object.freeze([])
    : Object.freeze((rawFilesystem as unknown[]).map((entry) => {
      const grant = record(entry);
      if (!grant || typeof grant.path !== "string" || !Number.isSafeInteger(grant.ceilingClause)) throw new Error("Snapshot node filesystem capability is invalid");
      const operations = stringArray(grant.operations, ["read", "create", "update", "delete"] as const, "filesystem operation") as readonly FilesystemOperation[];
      if (!operations.length) throw new Error("Snapshot node filesystem capability is invalid");
      return Object.freeze({
        path: grant.path,
        operations,
        include: patterns(grant.include, "filesystem include"),
        exclude: patterns(grant.exclude, "filesystem exclude"),
        ceilingClause: Number(grant.ceilingClause),
      });
    }));
  if (rawFilesystem !== undefined && !Array.isArray(rawFilesystem)) throw new Error("Snapshot node filesystem capability is invalid");
  const boolean = (key: string): boolean => {
    const item = effective[key];
    if (item === undefined) return false;
    if (typeof item !== "boolean") throw new Error(`Snapshot node ${key} capability is invalid`);
    return item;
  };
  return Object.freeze({
    filesystem,
    shell: stringArray(effective.shell, ["inspect", "test", "build", "package", "mutate", "execute-code"] as const, "shell") as readonly ShellCapability[],
    git: boolean("git"),
    externalNetwork: boolean("external-network"),
    humanInput: boolean("human-input"),
    artifact: stringArray(effective.artifact, ["read", "write", "review"] as const, "artifact") as readonly ArtifactCapability[],
    knowledge: stringArray(effective.knowledge, ["read", "propose", "curate"] as const, "knowledge") as readonly KnowledgeCapability[],
  });
}

function workflowAgentId(snapshot: ActivationSnapshotFileV1, nodeId: string): string {
  const team = record(snapshot.payload.workflow.team);
  const nodes = Array.isArray(team?.nodes) ? team.nodes : [];
  const node = nodes.find((entry) => record(entry)?.id === nodeId);
  const agentId = record(node)?.agentId;
  return typeof agentId === "string" && agentId ? agentId : nodeId;
}

function effectivePolicy(snapshot: ActivationSnapshotFileV1, nodeId: string, capabilities: NormalizedCapabilities): EffectiveNodePolicy {
  const authority = snapshot.payload.authority.nodes.find((entry) => entry.nodeId === nodeId);
  const attachmentRecord = record(record(authority?.capabilities)?.attachments);
  const directMemberIds = record(authority?.capabilities)?.directMemberIds;
  return {
    workflowId: String(snapshot.payload.workflow.id ?? ""),
    nodeId,
    agentId: workflowAgentId(snapshot, nodeId),
    capabilities,
    provenance: {} as EffectiveNodePolicy["provenance"],
    tools: Object.freeze(Array.isArray(authority?.tools) ? [...authority.tools] : []),
    budgets: Object.freeze({}),
    skills: Object.freeze(Array.isArray(attachmentRecord?.skills) ? attachmentRecord.skills.filter((entry): entry is string => typeof entry === "string") : []),
    knowledge: Object.freeze(Array.isArray(attachmentRecord?.knowledge) ? attachmentRecord.knowledge.filter((entry): entry is string => typeof entry === "string") : []),
    directMemberIds: Object.freeze(Array.isArray(directMemberIds) ? directMemberIds.filter((entry): entry is string => typeof entry === "string") : []),
  };
}

/** Compile one immutable generic file/command policy for every frozen authority node. */
export function compileSnapshotNodeToolPolicies(input: CompileSnapshotNodeToolPoliciesInput): readonly SnapshotNodeToolPolicy[] {
  const knowledgeRoots = knowledgeProtectedPathRoots(input.snapshot);
  const ids = input.snapshot.payload.authority.nodes.map((entry) => {
    if (typeof entry.nodeId !== "string" || !entry.nodeId) throw new Error("Snapshot authority contains an invalid node policy");
    return entry.nodeId;
  });
  if (new Set(ids).size !== ids.length) throw new Error("Snapshot authority contains duplicate node policies");
  return Object.freeze([...ids].sort().map((nodeId) => {
    const authority = input.snapshot.payload.authority.nodes.find((entry) => entry.nodeId === nodeId)!;
    const capabilities = capabilitiesFromAuthority(authority.capabilities);
    const filesystem = compileFilesystemPolicy({
      projectRoot: input.projectRoot,
      effectivePolicy: effectivePolicy(input.snapshot, nodeId, capabilities),
      ...(input.secretPaths ? { secretPaths: input.secretPaths } : {}),
      additionalProtectedRoots: knowledgeRoots,
      ...(input.artifact ? { artifact: input.artifact } : {}),
    });
    const filesystemHook = createFilesystemPolicyHook(filesystem);
    const commandHook = createCommandPolicyHook(capabilities, filesystem);
    return Object.freeze({
      nodeId,
      capabilities,
      filesystem,
      hook: async (event: { readonly toolName?: unknown; readonly input?: unknown }) => event.toolName === "bash"
        ? commandHook(event)
        : filesystemHook(event),
    });
  }));
}
