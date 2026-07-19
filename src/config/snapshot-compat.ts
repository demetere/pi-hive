import { ARTIFACT_CONTRACT_VERSION, ARTIFACT_CONTRACT_LIMITS, ARTIFACT_VIEW_VERSION } from "../artifacts/contracts";
import { BUILTIN_ARTIFACT_REGISTRY } from "../artifacts/registry";
import { CAPABILITY_CONTRACT_VERSION, SCHEMA_VERSION } from "./versions";
import { SNAPSHOT_CATALOG_HASH_VERSION, SNAPSHOT_FORMAT_VERSION, SNAPSHOT_PACKAGE_CONTRACT_VERSION, verifyActivationSnapshotHash, type ActivationSnapshotFileV1, type SnapshotSourceV1 } from "./snapshot";
import { SNAPSHOT_CONTEXT_POLICY, type SnapshotModelAdapter } from "./snapshot-model";

export type SnapshotSourceState = "current" | "stale" | "missing" | "invalid";
export type SnapshotSourceProbeResult = { status: "current"; hash: string; canonicalHash: string } | { status: "missing" | "invalid" };
export interface SnapshotSourceComparison { state: SnapshotSourceState; reasons: Array<{ path: string; state: Exclude<SnapshotSourceState, "current"> }> }
export function compareSnapshotSources(snapshot: ActivationSnapshotFileV1, probe: (source: SnapshotSourceV1) => SnapshotSourceProbeResult): SnapshotSourceComparison {
  const reasons: SnapshotSourceComparison["reasons"] = [];
  for (const source of snapshot.payload.sources) {
    try {
      const current = probe(source);
      if (current.status !== "current") reasons.push({ path: source.path, state: current.status });
      else if (current.hash !== source.hash || current.canonicalHash !== source.canonicalHash) reasons.push({ path: source.path, state: "stale" });
    } catch {
      reasons.push({ path: source.path, state: "invalid" });
    }
  }
  const priority: SnapshotSourceState[] = ["invalid", "missing", "stale"];
  return { state: priority.find((state) => reasons.some((reason) => reason.state === state)) ?? "current", reasons };
}
export interface SnapshotArtifactCompatibilityIdentity {
  readonly contractVersion: string;
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly profile: string;
  readonly profileVersion: string;
  readonly optionsSchemaVersion: string;
  readonly viewVersion: number;
  readonly checkpointIds: readonly string[];
  readonly actionIds: readonly string[];
}
export interface SnapshotCompatibilityRuntime {
  sourceState: SnapshotSourceState;
  model: SnapshotModelAdapter;
  knowledgeAvailable(dependency: Record<string, unknown>): boolean;
  workspaceAvailable(workflow: Record<string, unknown>): boolean;
  artifactProfileAvailable(adapter: string, profile: string, identity: SnapshotArtifactCompatibilityIdentity): boolean;
}
export interface SnapshotCompatibilityResult { resumable: boolean; freshEnabled: boolean; codes: string[]; sourceState: SnapshotSourceState }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value);
}
function identifierList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= ARTIFACT_CONTRACT_LIMITS.viewItems && new Set(value).size === value.length
    && value.every((item) => typeof item === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(item) && Buffer.byteLength(item, "utf8") <= ARTIFACT_CONTRACT_LIMITS.idBytes);
}
function snapshotArtifactIdentity(value: unknown): SnapshotArtifactCompatibilityIdentity | undefined {
  if (!record(value) || !exactKeys(value, ["adapter", "adapterVersion", "profile", "profileVersion", "binding", "options", "optionsSchemaVersion", "contractVersion", "checkpoints", "actionIds", "viewVersion", "approvals"])) return undefined;
  if (typeof value.adapter !== "string" || typeof value.adapterVersion !== "string" || typeof value.profile !== "string" || typeof value.profileVersion !== "string"
    || typeof value.optionsSchemaVersion !== "string" || typeof value.contractVersion !== "string" || value.viewVersion !== ARTIFACT_VIEW_VERSION
    || typeof value.binding !== "string" || !record(value.options) || !record(value.approvals) || !identifierList(value.checkpoints) || !identifierList(value.actionIds)) return undefined;
  try {
    const resolved = BUILTIN_ARTIFACT_REGISTRY.resolveProfile({
      contractVersion: value.contractVersion,
      adapterId: value.adapter,
      adapterVersion: value.adapterVersion,
      profileId: value.profile,
      profileVersion: value.profileVersion,
    });
    if (resolved.profile.optionsSchemaVersion !== value.optionsSchemaVersion || resolved.profile.viewVersion !== value.viewVersion
      || !resolved.profile.bindings.some((binding) => binding === value.binding)
      || JSON.stringify(resolved.profile.checkpointIds) !== JSON.stringify(value.checkpoints)
      || JSON.stringify(resolved.profile.actions.map((action) => action.id)) !== JSON.stringify(value.actionIds)) return undefined;
    BUILTIN_ARTIFACT_REGISTRY.validateOptions(resolved.profile, value.options);
    return Object.freeze({
      contractVersion: value.contractVersion,
      adapter: value.adapter,
      adapterVersion: value.adapterVersion,
      profile: value.profile,
      profileVersion: value.profileVersion,
      optionsSchemaVersion: value.optionsSchemaVersion,
      viewVersion: value.viewVersion,
      checkpointIds: Object.freeze([...value.checkpoints]),
      actionIds: Object.freeze([...value.actionIds]),
    });
  } catch { return undefined; }
}
export function validateSnapshotResumeCompatibility(snapshot: ActivationSnapshotFileV1, runtime: SnapshotCompatibilityRuntime): SnapshotCompatibilityResult {
  const codes: string[] = [];
  if (!verifyActivationSnapshotHash(snapshot)) codes.push("SNAPSHOT_INTEGRITY_INVALID");
  const versions = snapshot.payload.versions;
  if (versions.snapshot !== SNAPSHOT_FORMAT_VERSION) codes.push("SNAPSHOT_FORMAT_UNSUPPORTED");
  if (versions.packageContract !== SNAPSHOT_PACKAGE_CONTRACT_VERSION) codes.push("SNAPSHOT_PACKAGE_CONTRACT_UNSUPPORTED");
  if (versions.schema !== SCHEMA_VERSION) codes.push("SNAPSHOT_SCHEMA_UNSUPPORTED");
  if (versions.capability !== CAPABILITY_CONTRACT_VERSION) codes.push("SNAPSHOT_CAPABILITY_CONTRACT_UNSUPPORTED");
  if (versions.catalogHash !== SNAPSHOT_CATALOG_HASH_VERSION) codes.push("SNAPSHOT_CATALOG_HASH_UNSUPPORTED");
  if (versions.artifact !== ARTIFACT_CONTRACT_VERSION) codes.push("SNAPSHOT_ARTIFACT_CONTRACT_UNSUPPORTED");
  if (versions.contextPolicy !== SNAPSHOT_CONTEXT_POLICY.version) codes.push("SNAPSHOT_CONTEXT_POLICY_UNSUPPORTED");
  if (snapshot.payload.authority.capabilityContractVersion !== versions.capability) codes.push("SNAPSHOT_CAPABILITY_CONTRACT_UNSUPPORTED");
  for (const modelRecord of snapshot.payload.models) {
    const storedContextValid = Number.isSafeInteger(modelRecord.staticTokens) && modelRecord.staticTokens >= 0
      && Number.isSafeInteger(modelRecord.dynamicReserve) && modelRecord.dynamicReserve >= 0
      && Number.isSafeInteger(modelRecord.contextWindow) && modelRecord.contextWindow > 0;
    if (!storedContextValid) { codes.push("SNAPSHOT_CONTEXT_INVALID"); continue; }
    let model;
    let activatable: boolean;
    try {
      model = runtime.model.find(modelRecord.modelId);
      activatable = model ? runtime.model.canActivate(modelRecord.modelId) : false;
    } catch {
      codes.push("SNAPSHOT_MODEL_PROBE_FAILED");
      continue;
    }
    if (!model || !activatable) { codes.push("SNAPSHOT_MODEL_UNAVAILABLE"); continue; }
    try {
      if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0 || (model.maxTokens !== undefined && (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 0))) { codes.push("SNAPSHOT_CONTEXT_INVALID"); continue; }
      if (!model.thinking.includes(modelRecord.thinking)) codes.push("SNAPSHOT_THINKING_UNSUPPORTED");
      if (modelRecord.staticTokens + modelRecord.dynamicReserve > model.contextWindow) codes.push("SNAPSHOT_CONTEXT_INSUFFICIENT");
    } catch {
      codes.push("SNAPSHOT_MODEL_PROBE_FAILED");
    }
  }
  for (const dependency of snapshot.payload.knowledge) {
    try { if (!runtime.knowledgeAvailable(dependency)) codes.push("SNAPSHOT_KNOWLEDGE_UNAVAILABLE"); }
    catch { codes.push("SNAPSHOT_KNOWLEDGE_PROBE_FAILED"); }
  }
  const artifact = snapshotArtifactIdentity(snapshot.payload.workflow.artifact);
  if (!artifact || artifact.contractVersion !== versions.artifact) codes.push("SNAPSHOT_ARTIFACT_CONTRACT_UNSUPPORTED");
  else {
    try { if (!runtime.artifactProfileAvailable(artifact.adapter, artifact.profile, artifact)) codes.push("SNAPSHOT_ARTIFACT_CONTRACT_UNSUPPORTED"); }
    catch { codes.push("SNAPSHOT_ARTIFACT_PROBE_FAILED"); }
  }
  try { if (!runtime.workspaceAvailable(snapshot.payload.workflow)) codes.push("SNAPSHOT_WORKSPACE_UNAVAILABLE"); }
  catch { codes.push("SNAPSHOT_WORKSPACE_PROBE_FAILED"); }
  const unique = [...new Set(codes)].sort(compare);
  const resumable = unique.length === 0;
  return { resumable, freshEnabled: runtime.sourceState === "current", codes: unique, sourceState: runtime.sourceState };
}
