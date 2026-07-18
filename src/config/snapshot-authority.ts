import { CAPABILITY_POLICY_LIMITS, type EffectiveNodePolicy, type NormalizedCapabilities } from "../capabilities/types";
import { deriveNodeTools, classifyTrustedTool } from "../capabilities/tools";
import type { JsonValue } from "./types";
import { CAPABILITY_CONTRACT_VERSION } from "./versions";

const EFFECTIVE_AUTHORITY_BRAND: unique symbol = Symbol("pi-hive-effective-authority-v1");
const GROUPS = ["filesystem", "shell", "git", "external-network", "human-input", "artifact", "knowledge"] as const;
const PROVENANCE_DECISIONS = new Set(["workflow-node", "workflow-node-omitted-deny", "inherited"]);
const FILESYSTEM_OPERATIONS = new Set(["read", "create", "update", "delete"]);
const SHELL_VALUES = new Set(["inspect", "test", "build", "package", "mutate", "execute-code"]);
const ARTIFACT_VALUES = new Set(["read", "write", "review"]);
const KNOWLEDGE_VALUES = new Set(["read", "propose", "curate"]);

export interface EffectiveAuthorityNodeSnapshotV1 {
  readonly nodeId: string;
  readonly capabilities: Readonly<Record<string, JsonValue>>;
  readonly tools: readonly string[];
  readonly model?: string;
  readonly thinking?: string;
}

export interface EffectiveAuthoritySnapshotV1 {
  readonly workflowId: string;
  readonly capabilityContractVersion: typeof CAPABILITY_CONTRACT_VERSION;
  readonly nodes: readonly EffectiveAuthorityNodeSnapshotV1[];
  readonly [EFFECTIVE_AUTHORITY_BRAND]: true;
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...expected, ...optional]);
  return expected.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}
function stringList(value: unknown, allowed?: ReadonlySet<string>, limit: number = CAPABILITY_POLICY_LIMITS.valuesPerGroup): value is string[] {
  return Array.isArray(value) && value.length <= limit && new Set(value).size === value.length && value.every((item) => typeof item === "string" && item.length > 0
    && Buffer.byteLength(item, "utf8") <= CAPABILITY_POLICY_LIMITS.authorityStringBytes && (!allowed || allowed.has(item)));
}
function sorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1], value) < 0);
}
function canonicalPath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > CAPABILITY_POLICY_LIMITS.authorityStringBytes
    || value.startsWith("/") || value.includes("\\") || [...value].some((character) => character.charCodeAt(0) <= 31 || ':<>"|?*'.includes(character))) return false;
  return value === "." || value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function canonicalPattern(value: unknown): value is string {
  return typeof value === "string" && value !== "" && Buffer.byteLength(value, "utf8") <= CAPABILITY_POLICY_LIMITS.authorityStringBytes
    && !value.startsWith("/") && !value.startsWith("!") && !value.includes("\\") && !value.includes("\0")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function filesystemKey(grant: Record<string, unknown>): string {
  return `${grant.path as string}\0${(grant.operations as string[]).join(",")}\0${(grant.include as string[]).join(",")}\0${(grant.exclude as string[]).join(",")}`;
}
function validateBoundedJson(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let items = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if (++items > CAPABILITY_POLICY_LIMITS.authorityJsonItems || entry.depth > CAPABILITY_POLICY_LIMITS.authorityJsonDepth) return false;
    if (typeof entry.value === "string" && Buffer.byteLength(entry.value, "utf8") > CAPABILITY_POLICY_LIMITS.authorityStringBytes) return false;
    if (Array.isArray(entry.value)) {
      for (const child of entry.value) stack.push({ value: child, depth: entry.depth + 1 });
    } else if (plainRecord(entry.value)) {
      if (Object.keys(entry.value).length > CAPABILITY_POLICY_LIMITS.valuesPerGroup) return false;
      for (const [key, child] of Object.entries(entry.value)) {
        if (Buffer.byteLength(key, "utf8") > CAPABILITY_POLICY_LIMITS.authorityStringBytes) return false;
        stack.push({ value: child, depth: entry.depth + 1 });
      }
    } else if (entry.value !== null && typeof entry.value !== "string" && typeof entry.value !== "boolean"
      && !(typeof entry.value === "number" && Number.isFinite(entry.value))) return false;
  }
  return true;
}
function cloneJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneJson));
  if (plainRecord(value)) return Object.freeze(Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, item]) => [key, cloneJson(item)])));
  throw new TypeError("Effective authority must contain plain JSON values.");
}
function validateEffective(value: unknown): value is Record<string, JsonValue> {
  if (!plainRecord(value) || !exactKeys(value, [...GROUPS])) return false;
  if (!Array.isArray(value.filesystem) || value.filesystem.length > CAPABILITY_POLICY_LIMITS.filesystemClauses
    || !stringList(value.shell, SHELL_VALUES) || !sorted(value.shell)
    || typeof value.git !== "boolean" || typeof value["external-network"] !== "boolean" || typeof value["human-input"] !== "boolean"
    || !stringList(value.artifact, ARTIFACT_VALUES) || !sorted(value.artifact)
    || !stringList(value.knowledge, KNOWLEDGE_VALUES) || !sorted(value.knowledge)) return false;
  let previousKey: string | undefined;
  for (const grant of value.filesystem) {
    if (!plainRecord(grant) || !exactKeys(grant, ["path", "operations", "include", "exclude", "ceilingClause"])
      || !canonicalPath(grant.path)
      || !stringList(grant.operations, FILESYSTEM_OPERATIONS) || grant.operations.length === 0 || !sorted(grant.operations)
      || !stringList(grant.include) || !sorted(grant.include) || !grant.include.every(canonicalPattern)
      || !stringList(grant.exclude) || !sorted(grant.exclude) || !grant.exclude.every(canonicalPattern)
      || !Number.isSafeInteger(grant.ceilingClause) || (grant.ceilingClause as number) < 0
      || (grant.ceilingClause as number) >= CAPABILITY_POLICY_LIMITS.filesystemClauses) return false;
    const key = filesystemKey(grant);
    if (previousKey !== undefined && compare(previousKey, key) >= 0) return false;
    previousKey = key;
  }
  return true;
}
function validProvenance(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && value[0] === "agent-ceiling" && typeof value[1] === "string" && PROVENANCE_DECISIONS.has(value[1]);
}
function validateAuthorityRecord(value: unknown): asserts value is Record<string, JsonValue> {
  if (!plainRecord(value) || !exactKeys(value, ["effective", "provenance", "budgets", "attachments", "directMemberIds"])) throw new Error("Effective authority policy has an invalid closed shape.");
  if (!validateEffective(value.effective)) throw new Error("Effective authority capabilities are not normalized.");
  const provenance = value.provenance;
  if (!plainRecord(provenance) || !exactKeys(provenance, [...GROUPS])
    || GROUPS.some((group) => !validProvenance(provenance[group]))) throw new Error("Effective authority provenance is invalid.");
  if (!plainRecord(value.budgets) || !validateBoundedJson(value.budgets)) throw new Error("Effective authority budgets exceed their bounded JSON contract.");
  if (!plainRecord(value.attachments) || !exactKeys(value.attachments, ["skills", "knowledge"])
    || !stringList(value.attachments.skills, undefined, CAPABILITY_POLICY_LIMITS.attachmentValues) || !sorted(value.attachments.skills)
    || !stringList(value.attachments.knowledge, undefined, CAPABILITY_POLICY_LIMITS.attachmentValues) || !sorted(value.attachments.knowledge)) throw new Error("Effective authority attachments exceed their normalized limit.");
  if (!stringList(value.directMemberIds, undefined, CAPABILITY_POLICY_LIMITS.routeMembers) || !sorted(value.directMemberIds)) throw new Error("Effective authority direct members exceed their normalized limit.");
  if (!validateBoundedJson(value.provenance)) throw new Error("Effective authority provenance exceeds its bounded JSON contract.");
  cloneJson(value);
}
function normalizedJson(capabilities: NormalizedCapabilities): Record<string, JsonValue> {
  return {
    filesystem: capabilities.filesystem.map((grant) => ({ path: grant.path, operations: [...grant.operations], include: [...grant.include], exclude: [...grant.exclude], ceilingClause: grant.ceilingClause })),
    shell: [...capabilities.shell],
    git: capabilities.git,
    "external-network": capabilities.externalNetwork,
    "human-input": capabilities.humanInput,
    artifact: [...capabilities.artifact],
    knowledge: [...capabilities.knowledge],
  } as Record<string, JsonValue>;
}
function policyRecord(policy: EffectiveNodePolicy): Record<string, JsonValue> {
  return {
    effective: normalizedJson(policy.capabilities),
    provenance: policy.provenance as unknown as JsonValue,
    budgets: policy.budgets as unknown as JsonValue,
    attachments: { skills: [...policy.skills], knowledge: [...policy.knowledge] },
    directMemberIds: [...policy.directMemberIds],
  };
}
export interface SerializedAuthorityValidationContextV1 {
  readonly rootNodeId: string;
  readonly directMemberIds: readonly string[];
  /** Subsystem availability is frozen false for capability contract v1/W06. Later availability requires a versioned contract. */
  readonly subsystems: { readonly artifact: false; readonly knowledge: false; readonly questions: false };
}
function normalizedCapabilitiesFromRecord(value: Record<string, JsonValue>): NormalizedCapabilities {
  return {
    filesystem: (value.filesystem as Array<Record<string, JsonValue>>).map((grant) => ({
      path: grant.path as string,
      operations: grant.operations as NormalizedCapabilities["filesystem"][number]["operations"],
      include: grant.include as readonly string[],
      exclude: grant.exclude as readonly string[],
      ceilingClause: grant.ceilingClause as number,
    })),
    shell: value.shell as NormalizedCapabilities["shell"],
    git: value.git as boolean,
    externalNetwork: value["external-network"] as boolean,
    humanInput: value["human-input"] as boolean,
    artifact: value.artifact as NormalizedCapabilities["artifact"],
    knowledge: value.knowledge as NormalizedCapabilities["knowledge"],
  };
}
export function validateSerializedEffectiveAuthorityNodeV1(value: unknown, context?: SerializedAuthorityValidationContextV1): asserts value is EffectiveAuthorityNodeSnapshotV1 {
  if (!plainRecord(value) || !exactKeys(value, ["nodeId", "capabilities", "tools"], ["model", "thinking"])) throw new Error("Effective authority node has an invalid closed shape.");
  if (typeof value.nodeId !== "string" || value.nodeId.length === 0 || Buffer.byteLength(value.nodeId, "utf8") > CAPABILITY_POLICY_LIMITS.authorityStringBytes) throw new Error("Effective authority node ID is required and bounded.");
  validateAuthorityRecord(value.capabilities);
  if (!stringList(value.tools) || !sorted(value.tools) || value.tools.some((name) => !classifyTrustedTool(name))) throw new Error("Effective authority contains an unknown, duplicate, or non-canonical tool.");
  const tools = value.tools as string[];
  for (const setting of [value.model, value.thinking]) {
    if (setting !== undefined && (typeof setting !== "string" || !setting || setting === "inherit" || Buffer.byteLength(setting, "utf8") > CAPABILITY_POLICY_LIMITS.authorityStringBytes)) throw new Error("Effective authority model/thinking must be resolved and bounded.");
  }
  if (context) {
    const directMemberIds = value.capabilities.directMemberIds as string[];
    if (directMemberIds.length !== context.directMemberIds.length || directMemberIds.some((id, index) => id !== context.directMemberIds[index])) throw new Error("Effective authority direct members diverge from workflow topology.");
    const attachments = value.capabilities.attachments as Record<string, JsonValue>;
    const expected = deriveNodeTools({
      capabilities: normalizedCapabilitiesFromRecord(value.capabilities.effective as Record<string, JsonValue>),
      root: value.nodeId === context.rootNodeId,
      directMemberIds,
      artifactAvailable: context.subsystems.artifact,
      knowledgeAvailable: context.subsystems.knowledge,
      knowledgeAttached: (attachments.knowledge as string[]).length > 0,
      questionsAvailable: context.subsystems.questions,
    });
    if (expected.length !== tools.length || expected.some((name, index) => name !== tools[index])) throw new Error("Effective authority tools do not match trusted derivation.");
  }
}

function buildAuthority(workflowId: string, input: readonly EffectiveAuthorityNodeSnapshotV1[]): EffectiveAuthoritySnapshotV1 {
  if (!workflowId) throw new Error("Effective authority workflow ID is required.");
  const ids = new Set<string>();
  const nodes = input.map((node) => {
    validateSerializedEffectiveAuthorityNodeV1(node);
    if (ids.has(node.nodeId)) throw new Error(`Effective authority contains duplicate or empty node ID ${node.nodeId}.`);
    ids.add(node.nodeId);
    return Object.freeze({
      nodeId: node.nodeId,
      capabilities: cloneJson(node.capabilities) as Readonly<Record<string, JsonValue>>,
      tools: Object.freeze([...node.tools].sort(compare)),
      ...(node.model ? { model: node.model } : {}),
      ...(node.thinking ? { thinking: node.thinking } : {}),
    });
  }).sort((a, b) => compare(a.nodeId, b.nodeId));
  return Object.freeze({ workflowId, capabilityContractVersion: CAPABILITY_CONTRACT_VERSION, nodes: Object.freeze(nodes), [EFFECTIVE_AUTHORITY_BRAND]: true as const });
}

/** Production issuance boundary: only complete resolver policies can be frozen. */
export function issueEffectiveAuthorityFromResolvedPolicies(input: {
  workflowId: string;
  rootNodeId: string;
  policies: readonly EffectiveNodePolicy[];
  artifactAvailable: boolean;
  knowledgeAvailable: boolean;
  questionsAvailable: boolean;
}): EffectiveAuthoritySnapshotV1 {
  const nodes = input.policies.map((policy) => {
    if (policy.workflowId !== input.workflowId) throw new Error("Effective authority policy belongs to another workflow.");
    const expectedTools = deriveNodeTools({
      capabilities: policy.capabilities,
      root: policy.nodeId === input.rootNodeId,
      directMemberIds: policy.directMemberIds,
      artifactAvailable: input.artifactAvailable,
      knowledgeAvailable: input.knowledgeAvailable,
      knowledgeAttached: policy.knowledge.length > 0,
      questionsAvailable: input.questionsAvailable,
    });
    if (expectedTools.length !== policy.tools.length || expectedTools.some((name, index) => name !== policy.tools[index])) throw new Error("Effective authority tools do not match trusted derivation.");
    return { nodeId: policy.nodeId, capabilities: policyRecord(policy), tools: policy.tools, ...(policy.model ? { model: policy.model } : {}), ...(policy.thinking ? { thinking: policy.thinking } : {}) };
  });
  return buildAuthority(input.workflowId, nodes);
}

/** Test-only fixture seam. It enforces the same closed normalized record and trusted tool vocabulary. */
export function issueEffectiveAuthoritySnapshotForTest(workflowId: string, nodes: readonly EffectiveAuthorityNodeSnapshotV1[]): EffectiveAuthoritySnapshotV1 {
  return buildAuthority(workflowId, nodes);
}

export function isEffectiveAuthoritySnapshotV1(value: unknown): value is EffectiveAuthoritySnapshotV1 {
  return typeof value === "object" && value !== null && (value as Partial<EffectiveAuthoritySnapshotV1>)[EFFECTIVE_AUTHORITY_BRAND] === true;
}
