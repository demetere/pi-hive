import {
  CAPABILITY_POLICY_LIMITS,
  type ArtifactCapability,
  type CapabilityDeclaration,
  type CapabilityGroup,
  type CapabilityIssue,
  type CapabilityProvenance,
  type FilesystemOperation,
  type KnowledgeCapability,
  type NormalizedCapabilities,
  type NormalizedFilesystemGrant,
  type ShellCapability,
} from "./types";

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function sortedUnique<T extends string>(values: readonly T[] | undefined): readonly T[] {
  return Object.freeze([...new Set(values ?? [])].sort(compare));
}
function freezeCapabilities(value: NormalizedCapabilities): NormalizedCapabilities {
  for (const grant of value.filesystem) Object.freeze(grant);
  return Object.freeze(value);
}

const CAPABILITY_KEYS = new Set(["filesystem", "shell", "git", "external-network", "human-input", "artifact", "knowledge"]);
const FILESYSTEM_KEYS = new Set(["path", "operations", "include", "exclude"]);
const SHELL_VALUES = new Set<string>(["inspect", "test", "build", "package", "mutate", "execute-code"]);
const FILESYSTEM_VALUES = new Set<string>(["read", "create", "update", "delete"]);
const ARTIFACT_VALUES = new Set<string>(["read", "write", "review"]);
const KNOWLEDGE_VALUES = new Set<string>(["read", "propose", "curate"]);
function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function hasControlCharacter(value: string): boolean {
  for (const character of value) if (character.charCodeAt(0) <= 0x1f) return true;
  return false;
}
function canonicalScopePath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > 4_096 || value.startsWith("/") || value.includes("\\") || /[:<>"|?*]/.test(value) || hasControlCharacter(value)) return false;
  return value === "." || value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function validPattern(value: unknown): value is string {
  return typeof value === "string" && value !== "" && Buffer.byteLength(value, "utf8") <= 4_096
    && !value.startsWith("/") && !value.startsWith("!") && !value.includes("\\") && !value.includes("\0")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function validUniqueList(value: unknown, allowed?: ReadonlySet<string>, requireOne = false, patterns = false): value is string[] {
  if (!Array.isArray(value) || value.length > CAPABILITY_POLICY_LIMITS.valuesPerGroup || (requireOne && value.length === 0)) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || seen.has(item) || (allowed && !allowed.has(item)) || (patterns && !validPattern(item))) return false;
    seen.add(item);
  }
  return true;
}
function validateDeclaration(raw: unknown): CapabilityIssue[] {
  if (!plainRecord(raw)) return [issue("CAPABILITY_VALUE_INVALID", "filesystem", "Capabilities must be a closed plain object.")];
  if (Object.keys(raw).some((key) => !CAPABILITY_KEYS.has(key))) return [issue("CAPABILITY_VALUE_INVALID", "filesystem", "Unknown capability group is not allowed.")];
  const issues: CapabilityIssue[] = [];
  for (const key of ["git", "external-network", "human-input"] as const) if (key in raw && typeof raw[key] !== "boolean") issues.push(issue("CAPABILITY_VALUE_INVALID", key, `Capability ${key} must be boolean.`));
  for (const [key, allowed] of [["shell", SHELL_VALUES], ["artifact", ARTIFACT_VALUES], ["knowledge", KNOWLEDGE_VALUES]] as const) {
    if (key in raw && !validUniqueList(raw[key], allowed)) issues.push(issue("CAPABILITY_VALUE_INVALID", key, `Capability ${key} contains an unknown, duplicate, or excessive value.`));
  }
  if ("filesystem" in raw) {
    if (!Array.isArray(raw.filesystem) || raw.filesystem.length > CAPABILITY_POLICY_LIMITS.filesystemClauses) issues.push(issue("CAPABILITY_CLAUSE_LIMIT_EXCEEDED", "filesystem", "Filesystem capability clause limit exceeded."));
    else for (const grant of raw.filesystem) {
      if (!plainRecord(grant) || Object.keys(grant).some((key) => !FILESYSTEM_KEYS.has(key)) || !canonicalScopePath(grant.path)
        || !validUniqueList(grant.operations, FILESYSTEM_VALUES, true)
        || ("include" in grant && !validUniqueList(grant.include, undefined, false, true))
        || ("exclude" in grant && !validUniqueList(grant.exclude, undefined, false, true))) {
        issues.push(issue("CAPABILITY_VALUE_INVALID", "filesystem", "Filesystem grant is not a canonical closed narrowing clause."));
      }
    }
  }
  return issues;
}

export function normalizeCapabilities(raw: CapabilityDeclaration): NormalizedCapabilities {
  const issues = validateDeclaration(raw);
  if (issues.length) throw new Error(issues[0].code);
  if ((raw.filesystem?.length ?? 0) > CAPABILITY_POLICY_LIMITS.filesystemClauses) throw new Error("CAPABILITY_CLAUSE_LIMIT_EXCEEDED");
  const byIdentity = new Map<string, NormalizedFilesystemGrant>();
  for (const [ceilingClause, grant] of (raw.filesystem ?? []).entries()) {
    const normalized: NormalizedFilesystemGrant = Object.freeze({
      path: grant.path,
      operations: sortedUnique(grant.operations) as readonly FilesystemOperation[],
      include: sortedUnique(grant.include),
      exclude: sortedUnique(grant.exclude),
      ceilingClause,
    });
    const identity = `${normalized.path}\0${normalized.operations.join(",")}\0${normalized.include.join(",")}\0${normalized.exclude.join(",")}`;
    if (!byIdentity.has(identity)) byIdentity.set(identity, normalized);
  }
  const filesystem = [...byIdentity.entries()].sort(([a], [b]) => compare(a, b)).map(([, grant]) => grant);
  return freezeCapabilities({
    filesystem: Object.freeze(filesystem),
    shell: sortedUnique(raw.shell) as readonly ShellCapability[],
    git: raw.git === true,
    externalNetwork: raw["external-network"] === true,
    humanInput: raw["human-input"] === true,
    artifact: sortedUnique(raw.artifact) as readonly ArtifactCapability[],
    knowledge: sortedUnique(raw.knowledge) as readonly KnowledgeCapability[],
  });
}

function setSubset<T>(candidate: readonly T[], ceiling: readonly T[]): boolean {
  const allowed = new Set(ceiling);
  return candidate.every((value) => allowed.has(value));
}
function subtreeContained(candidate: string, ceiling: string): boolean {
  if (!canonicalScopePath(candidate) || !canonicalScopePath(ceiling)) return false;
  if (candidate === ceiling) return true;
  if (ceiling === ".") return candidate !== ".";
  return candidate.startsWith(`${ceiling}/`);
}
function filtersContained(candidate: NormalizedFilesystemGrant, ceiling: NormalizedFilesystemGrant): boolean {
  if (!setSubset(ceiling.exclude, candidate.exclude)) return false;
  if (ceiling.include.length === 0) return true;
  return candidate.include.length > 0 && setSubset(candidate.include, ceiling.include);
}
function grantContained(candidate: NormalizedFilesystemGrant, ceiling: NormalizedFilesystemGrant): boolean {
  return subtreeContained(candidate.path, ceiling.path)
    && setSubset(candidate.operations, ceiling.operations)
    && filtersContained(candidate, ceiling);
}

export function isCapabilitySubset(candidate: NormalizedCapabilities, ceiling: NormalizedCapabilities): boolean {
  return (!candidate.git || ceiling.git)
    && (!candidate.externalNetwork || ceiling.externalNetwork)
    && (!candidate.humanInput || ceiling.humanInput)
    && setSubset(candidate.shell, ceiling.shell)
    && setSubset(candidate.artifact, ceiling.artifact)
    && setSubset(candidate.knowledge, ceiling.knowledge)
    && candidate.filesystem.every((grant) => ceiling.filesystem.some((parent) => grantContained(grant, parent)));
}

function provenance(overlayPresent: boolean, raw: CapabilityDeclaration | undefined): CapabilityProvenance {
  const result = {} as Record<CapabilityGroup, readonly ("agent-ceiling" | "workflow-node" | "workflow-node-omitted-deny" | "inherited")[]>;
  const rawRecord = raw as Record<string, unknown> | undefined;
  for (const [group, key] of [["filesystem", "filesystem"], ["shell", "shell"], ["git", "git"], ["external-network", "external-network"], ["human-input", "human-input"], ["artifact", "artifact"], ["knowledge", "knowledge"]] as const) {
    result[group] = Object.freeze(overlayPresent
      ? ["agent-ceiling", rawRecord && key in rawRecord ? "workflow-node" : "workflow-node-omitted-deny"]
      : ["agent-ceiling", "inherited"]);
  }
  return Object.freeze(result);
}

export interface CapabilityOverlayResult {
  readonly ok: boolean;
  readonly policy?: NormalizedCapabilities;
  readonly provenance?: CapabilityProvenance;
  readonly issues: readonly CapabilityIssue[];
}

function issue(code: CapabilityIssue["code"], group: CapabilityGroup, message: string): CapabilityIssue {
  return Object.freeze({ code, group, message });
}

export function resolveCapabilityOverlay(ceilingRaw: CapabilityDeclaration, overlayRaw: CapabilityDeclaration | undefined): CapabilityOverlayResult {
  const ceilingIssues = validateDeclaration(ceilingRaw);
  if (ceilingIssues.length) return Object.freeze({ ok: false, issues: Object.freeze(ceilingIssues) });
  const ceiling = normalizeCapabilities(ceilingRaw);
  if (overlayRaw === undefined) return Object.freeze({ ok: true, policy: ceiling, provenance: provenance(false, undefined), issues: Object.freeze([]) });
  const overlayIssues = validateDeclaration(overlayRaw);
  if (overlayIssues.length) return Object.freeze({ ok: false, issues: Object.freeze(overlayIssues) });

  const candidate = normalizeCapabilities(overlayRaw);
  const issues: CapabilityIssue[] = [];
  if (candidate.git && !ceiling.git) issues.push(issue("CAPABILITY_WIDENING", "git", "Workflow node cannot grant Git."));
  if (candidate.externalNetwork && !ceiling.externalNetwork) issues.push(issue("CAPABILITY_WIDENING", "external-network", "Workflow node cannot grant external network."));
  if (candidate.humanInput && !ceiling.humanInput) issues.push(issue("CAPABILITY_WIDENING", "human-input", "Workflow node cannot grant human input."));
  if (!setSubset(candidate.shell, ceiling.shell)) issues.push(issue("CAPABILITY_WIDENING", "shell", "Workflow shell classes exceed the catalog ceiling."));
  if (!setSubset(candidate.artifact, ceiling.artifact)) issues.push(issue("CAPABILITY_WIDENING", "artifact", "Workflow artifact operations exceed the catalog ceiling."));
  if (!setSubset(candidate.knowledge, ceiling.knowledge)) issues.push(issue("CAPABILITY_WIDENING", "knowledge", "Workflow knowledge operations exceed the catalog ceiling."));

  const proven: NormalizedFilesystemGrant[] = [];
  for (const grant of candidate.filesystem) {
    const parent = ceiling.filesystem.find((candidateParent) => grantContained(grant, candidateParent));
    if (!parent) {
      issues.push(issue("CAPABILITY_FILESYSTEM_AMBIGUOUS", "filesystem", "Filesystem narrowing is not demonstrably contained by one catalog grant."));
    } else {
      proven.push(Object.freeze({ ...grant, ceilingClause: parent.ceilingClause }));
    }
  }
  if (issues.length) return Object.freeze({ ok: false, issues: Object.freeze(issues) });
  const policy = freezeCapabilities({ ...candidate, filesystem: Object.freeze(proven) });
  return Object.freeze({ ok: true, policy, provenance: provenance(true, overlayRaw), issues: Object.freeze([]) });
}
