import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import { compareText, plainRecord } from "./values";

export interface RouteCapabilityRequirements {
  filesystem?: boolean;
  shell?: readonly string[];
  git?: boolean;
  externalNetwork?: boolean;
  humanInput?: boolean;
  artifact?: readonly string[];
  knowledge?: readonly string[];
}

export interface RouteDirectMembersInput {
  objective: string;
  requiredCapabilities?: RouteCapabilityRequirements;
  limit?: number;
  includeUnmatched?: boolean;
}

export interface RouteRecommendation {
  nodeId: string;
  agentId: string;
  score: number;
  reasons: readonly string[];
}

type RecordValue = Readonly<Record<string, unknown>>;
const REQUIREMENT_VALUES = {
  shell: new Set(["inspect", "test", "build", "package", "mutate", "execute-code"]),
  artifact: new Set(["read", "write", "review"]),
  knowledge: new Set(["read", "propose", "curate"]),
} as const;
const BOOLEAN_REQUIREMENTS = ["filesystem", "git", "externalNetwork", "humanInput"] as const;
const LIST_REQUIREMENTS = ["shell", "artifact", "knowledge"] as const;
const REQUIREMENT_KEYS: ReadonlySet<string> = new Set([...BOOLEAN_REQUIREMENTS, ...LIST_REQUIREMENTS]);

function record(value: unknown): RecordValue | undefined {
  return plainRecord(value) ? value : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function tokens(value: unknown): readonly string[] {
  if (typeof value !== "string") return [];
  const terms = value.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1);
  return Object.freeze([...new Set(terms)].sort(compareText));
}

function validateRequirements(value: RouteCapabilityRequirements | undefined): void {
  if (value === undefined) return;
  const raw = record(value);
  if (!raw || Object.keys(raw).some((key) => !REQUIREMENT_KEYS.has(key))) {
    throw new Error("Routing capability requirement contains an unknown or invalid capability");
  }
  for (const key of BOOLEAN_REQUIREMENTS) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
      throw new Error(`Routing capability requirement ${key} is invalid`);
    }
  }
  for (const key of LIST_REQUIREMENTS) {
    const list = raw[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 64 || new Set(list).size !== list.length
      || list.some((entry) => typeof entry !== "string" || !REQUIREMENT_VALUES[key].has(entry))) {
      throw new Error(`Routing capability requirement ${key} contains an unknown or invalid capability`);
    }
  }
}

function satisfies(node: RecordValue | undefined, requirement: RouteCapabilityRequirements | undefined): boolean {
  if (!requirement) return true;
  const capabilities = record(record(node?.capabilities)?.effective);
  if (!capabilities) return false;
  if (requirement.filesystem && (!Array.isArray(capabilities.filesystem) || !capabilities.filesystem.length)) return false;
  if (requirement.git && capabilities.git !== true) return false;
  if (requirement.externalNetwork && capabilities["external-network"] !== true) return false;
  if (requirement.humanInput && capabilities["human-input"] !== true) return false;
  for (const key of LIST_REQUIREMENTS) {
    const required = requirement[key];
    if (required?.some((item) => !new Set(stringList(capabilities[key])).has(item))) return false;
  }
  return true;
}

function scoreMember(
  node: RecordValue,
  agent: RecordValue | undefined,
  objectiveTokens: readonly string[],
): Readonly<{ score: number; reasons: readonly string[] }> {
  const frontmatter = record(agent?.frontmatter);
  const fields: Array<readonly [string, string]> = [
    ["role", text(node.role)],
    ...stringList(node.responsibilities).map((item) => ["responsibility", item] as const),
    ["consult-when", text(node.consultWhen)],
    ["description", text(agent?.description) || text(frontmatter?.description)],
    ...stringList(agent?.tags).map((item) => ["tag", item] as const),
  ];
  let score = 0;
  const reasons: string[] = [];
  for (const [label, value] of fields) {
    const metadata = new Set(tokens(value));
    const matches = objectiveTokens.filter((token) => metadata.has(token));
    score += matches.length;
    if (matches.length) reasons.push(`${label}:${matches.join(",")}`);
  }
  return { score, reasons: Object.freeze([...new Set(reasons)].sort(compareText)) };
}

export function routeDirectMembers(
  snapshot: ActivationSnapshotFileV1,
  callerNodeId: string,
  input: RouteDirectMembersInput,
): readonly RouteRecommendation[] {
  validateRequirements(input.requiredCapabilities);
  const team = record(snapshot.payload.workflow.team);
  const nodes = Array.isArray(team?.nodes) ? team.nodes.map(record).filter((node): node is RecordValue => Boolean(node)) : [];
  const caller = nodes.find((node) => node.id === callerNodeId);
  if (!caller) throw new Error(`Unknown node ${callerNodeId}`);
  const memberIds = stringList(caller.memberIds);
  if (!memberIds.length) throw new Error(`Node ${callerNodeId} has no direct members to route`);
  if (typeof input.objective !== "string" || !input.objective.trim()
    || Buffer.byteLength(input.objective, "utf8") > 131_072) throw new Error("Routing objective is empty or too large");

  const agents = new Map((snapshot.payload.agents ?? []).map((agent) => [text(agent.id), agent as RecordValue]));
  const authority = new Map(snapshot.payload.authority.nodes.map((node) => [text(node.nodeId), node as RecordValue]));
  const limit = Number.isSafeInteger(input.limit) && Number(input.limit) > 0 ? Math.min(100, Number(input.limit)) : 10;
  const objectiveTokens = tokens(input.objective);
  const output: RouteRecommendation[] = [];
  for (const nodeId of memberIds) {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.parentId !== callerNodeId || !satisfies(authority.get(nodeId), input.requiredCapabilities)) continue;
    const agentId = text(node.agentId);
    const ranking = scoreMember(node, agents.get(agentId), objectiveTokens);
    if (ranking.score || input.includeUnmatched) output.push(Object.freeze({ nodeId, agentId, ...ranking }));
  }
  output.sort((a, b) => b.score - a.score || compareText(a.nodeId, b.nodeId));
  return Object.freeze(output.slice(0, limit));
}
