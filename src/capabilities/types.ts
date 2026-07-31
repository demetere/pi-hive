import type { JsonValue } from "../config/types";

export const CAPABILITY_POLICY_LIMITS = Object.freeze({
  filesystemClauses: 256,
  valuesPerGroup: 64,
  routeMembers: 1_024,
  attachmentValues: 128,
  authorityJsonItems: 1_024,
  authorityJsonDepth: 16,
  authorityStringBytes: 4_096,
  toolOutputBytes: 262_144,
});

export const FILESYSTEM_OPERATIONS = ["read", "create", "update", "delete"] as const;
export const SHELL_CAPABILITIES = ["inspect", "test", "build", "package", "mutate", "execute-code"] as const;
export const ARTIFACT_CAPABILITIES = ["read", "write", "review"] as const;
export const KNOWLEDGE_CAPABILITIES = ["read", "propose", "curate"] as const;

export type FilesystemOperation = typeof FILESYSTEM_OPERATIONS[number];
export type ShellCapability = typeof SHELL_CAPABILITIES[number];
export type ArtifactCapability = typeof ARTIFACT_CAPABILITIES[number];
export type KnowledgeCapability = typeof KNOWLEDGE_CAPABILITIES[number];
export type CapabilityGroup = "filesystem" | "shell" | "git" | "external-network" | "human-input" | "artifact" | "knowledge";

export interface CapabilityDeclaration {
  readonly filesystem?: readonly {
    readonly path: string;
    readonly operations: readonly FilesystemOperation[];
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
  }[];
  readonly shell?: readonly ShellCapability[];
  readonly git?: boolean;
  readonly "external-network"?: boolean;
  readonly "human-input"?: boolean;
  readonly artifact?: readonly ArtifactCapability[];
  readonly knowledge?: readonly KnowledgeCapability[];
}

export interface NormalizedFilesystemGrant {
  readonly path: string;
  readonly operations: readonly FilesystemOperation[];
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** Index of the catalog grant that proves this clause is contained. */
  readonly ceilingClause: number;
}

export interface NormalizedCapabilities {
  readonly filesystem: readonly NormalizedFilesystemGrant[];
  readonly shell: readonly ShellCapability[];
  readonly git: boolean;
  readonly externalNetwork: boolean;
  readonly humanInput: boolean;
  readonly artifact: readonly ArtifactCapability[];
  readonly knowledge: readonly KnowledgeCapability[];
}

export type CapabilityProvenance = Readonly<Record<CapabilityGroup, readonly ("agent-ceiling" | "workflow-node" | "workflow-node-omitted-deny" | "inherited")[]>>;

export interface CapabilityIssue {
  readonly code: "CAPABILITY_WIDENING" | "CAPABILITY_FILESYSTEM_AMBIGUOUS" | "CAPABILITY_CLAUSE_LIMIT_EXCEEDED" | "CAPABILITY_VALUE_INVALID";
  readonly group: CapabilityGroup;
  readonly message: string;
}

export interface EffectiveNodePolicy {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly agentId: string;
  readonly capabilities: NormalizedCapabilities;
  readonly provenance: CapabilityProvenance;
  readonly model?: string;
  readonly thinking?: string;
  readonly tools: readonly string[];
  readonly budgets: Readonly<Record<string, JsonValue>>;
  readonly skills: readonly string[];
  readonly knowledge: readonly string[];
  readonly directMemberIds: readonly string[];
}

export type ToolCapabilityRequirement =
  | { readonly group: "filesystem"; readonly anyOperation: readonly FilesystemOperation[] }
  | { readonly group: "shell" }
  | { readonly group: "git" }
  | { readonly group: "command"; readonly anyOf: readonly ("shell" | "git")[] }
  | { readonly group: "human-input" }
  | { readonly group: "artifact"; readonly any: readonly ArtifactCapability[] }
  | { readonly group: "knowledge"; readonly any: readonly KnowledgeCapability[] };

export interface TrustedToolDescriptor {
  readonly name: string;
  readonly capability?: ToolCapabilityRequirement;
  readonly topology: "any" | "root" | "members";
  readonly subsystem?: "artifact" | "knowledge" | "questions";
  readonly mutability: "read-only" | "mutating" | "mixed";
  readonly idempotency: "idempotent" | "non-idempotent" | "operation-bound";
  readonly maxOutputBytes: number;
  readonly requiresMutationQueue: boolean;
}

export interface RouteMemberMetadata {
  readonly nodeId: string;
  readonly role?: string;
  readonly responsibilities: readonly string[];
  readonly consultWhen?: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly capabilities: NormalizedCapabilities;
}
