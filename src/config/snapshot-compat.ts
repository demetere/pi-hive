import { ARTIFACT_CONTRACT_VERSION } from "../artifacts/contracts";
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
export interface SnapshotCompatibilityRuntime {
  sourceState: SnapshotSourceState;
  model: SnapshotModelAdapter;
  knowledgeAvailable(dependency: Record<string, unknown>): boolean;
  workspaceAvailable(workflow: Record<string, unknown>): boolean;
  artifactProfileAvailable(adapter: string, profile: string): boolean;
}
export interface SnapshotCompatibilityResult { resumable: boolean; freshEnabled: boolean; codes: string[]; sourceState: SnapshotSourceState }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
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
  const artifact = snapshot.payload.workflow.artifact as { adapter?: unknown; profile?: unknown; contractVersion?: unknown } | undefined;
  if (!artifact || typeof artifact.adapter !== "string" || typeof artifact.profile !== "string" || artifact.contractVersion !== versions.artifact) codes.push("SNAPSHOT_ARTIFACT_CONTRACT_UNSUPPORTED");
  else {
    try { if (!runtime.artifactProfileAvailable(artifact.adapter, artifact.profile)) codes.push("SNAPSHOT_ARTIFACT_CONTRACT_UNSUPPORTED"); }
    catch { codes.push("SNAPSHOT_ARTIFACT_PROBE_FAILED"); }
  }
  try { if (!runtime.workspaceAvailable(snapshot.payload.workflow)) codes.push("SNAPSHOT_WORKSPACE_UNAVAILABLE"); }
  catch { codes.push("SNAPSHOT_WORKSPACE_PROBE_FAILED"); }
  const unique = [...new Set(codes)].sort(compare);
  const resumable = unique.length === 0;
  return { resumable, freshEnabled: runtime.sourceState === "current", codes: unique, sourceState: runtime.sourceState };
}
