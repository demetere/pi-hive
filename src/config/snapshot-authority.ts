import type { JsonValue } from "./types";
import { CAPABILITY_CONTRACT_VERSION } from "./versions";

const EFFECTIVE_AUTHORITY_BRAND: unique symbol = Symbol("pi-hive-effective-authority-v1");

export interface EffectiveAuthorityNodeSnapshotV1 {
  readonly nodeId: string;
  readonly capabilities: Readonly<Record<string, JsonValue>>;
  readonly tools: readonly string[];
}

export interface EffectiveAuthoritySnapshotV1 {
  readonly workflowId: string;
  readonly capabilityContractVersion: typeof CAPABILITY_CONTRACT_VERSION;
  readonly nodes: readonly EffectiveAuthorityNodeSnapshotV1[];
  readonly [EFFECTIVE_AUTHORITY_BRAND]: true;
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function cloneJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneJson));
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.freeze(Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, item]) => [key, cloneJson(item)])));
  }
  throw new TypeError("Effective authority must contain plain JSON values.");
}

export function issueEffectiveAuthoritySnapshotV1(workflowId: string, input: readonly { nodeId: string; capabilities: Record<string, JsonValue>; tools: readonly string[] }[]): EffectiveAuthoritySnapshotV1 {
  const ids = new Set<string>();
  const nodes = input.map((node) => {
    if (ids.has(node.nodeId)) throw new Error(`Effective authority contains duplicate node ID ${node.nodeId}.`);
    ids.add(node.nodeId);
    return Object.freeze({ nodeId: node.nodeId, capabilities: cloneJson(node.capabilities) as Readonly<Record<string, JsonValue>>, tools: Object.freeze([...new Set(node.tools)].sort(compare)) });
  }).sort((a, b) => compare(a.nodeId, b.nodeId));
  return Object.freeze({ workflowId, capabilityContractVersion: CAPABILITY_CONTRACT_VERSION, nodes: Object.freeze(nodes), [EFFECTIVE_AUTHORITY_BRAND]: true as const });
}

export function isEffectiveAuthoritySnapshotV1(value: unknown): value is EffectiveAuthoritySnapshotV1 {
  return typeof value === "object" && value !== null && (value as Partial<EffectiveAuthoritySnapshotV1>)[EFFECTIVE_AUTHORITY_BRAND] === true;
}
