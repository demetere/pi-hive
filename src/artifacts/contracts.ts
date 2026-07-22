import type { ConfigDiagnosticCode } from "../config/diagnostics";
import type { ArtifactWorkspaceBinding } from "./types";

export const ARTIFACT_CONTRACT_VERSION = "pi-hive-artifact-contract-v1" as const;
export const ARTIFACT_PROFILE_VERSION = "1" as const;
export const ARTIFACT_ACTION_VERSION = 1 as const;
export const ARTIFACT_VIEW_VERSION = 1 as const;
export const ARTIFACT_CONTRACT_LIMITS = Object.freeze({
  idCharacters: 256,
  idBytes: 256,
  optionsBytes: 65_536,
  argumentsBytes: 65_536,
  argumentSchemaBytes: 16_384,
  argumentSchemaDepth: 12,
  argumentSchemaNodes: 512,
  argumentSchemaItems: 64,
  argumentSchemaProperties: 64,
  argumentSchemaVariants: 16,
  argumentSchemaStringBytes: 1_024,
  jsonDepth: 16,
  jsonNodes: 4_096,
  pageSize: 40,
  cursorCharacters: 512,
  cursorBytes: 512,
  viewItems: 256,
  refs: 256,
  viewBytes: 65_536,
  resultBytes: 65_536,
  summaryBytes: 8_192,
});

export type ArtifactBinding = "none" | "new" | "existing" | "either";
export interface ArtifactProfileContract {
  readonly contractVersion: typeof ARTIFACT_CONTRACT_VERSION;
  readonly adapter: string;
  readonly adapterVersion: typeof ARTIFACT_PROFILE_VERSION;
  readonly profile: string;
  readonly profileVersion: typeof ARTIFACT_PROFILE_VERSION;
  readonly optionsSchemaVersion: typeof ARTIFACT_PROFILE_VERSION;
  readonly bindings: readonly ArtifactBinding[];
  readonly checkpoints: readonly string[];
  /** Adapter-defined actions are introduced with their owning adapter task. */
  readonly actionIds: readonly string[];
  readonly viewVersion: typeof ARTIFACT_VIEW_VERSION;
}
const author = Object.freeze(["new", "existing", "either"] as const);
const existing = Object.freeze(["existing"] as const);
const contract = (adapter: string, profile: string, bindings: readonly ArtifactBinding[], checkpoints: readonly string[], actionIds: readonly string[] = []): ArtifactProfileContract => Object.freeze({
  contractVersion: ARTIFACT_CONTRACT_VERSION,
  adapter,
  adapterVersion: ARTIFACT_PROFILE_VERSION,
  profile,
  profileVersion: ARTIFACT_PROFILE_VERSION,
  optionsSchemaVersion: ARTIFACT_PROFILE_VERSION,
  bindings: Object.freeze([...bindings]),
  checkpoints: Object.freeze([...checkpoints]),
  actionIds: Object.freeze([...actionIds]),
  viewVersion: ARTIFACT_VIEW_VERSION,
});
const markdownRead = "markdown-plan.plan.read", markdownAuthor = "markdown-plan.plan.author", markdownUpdate = "markdown-plan.plan.update", markdownValidate = "markdown-plan.validate";
const markdownTaskList = "markdown-plan.tasks.list", markdownTaskComplete = "markdown-plan.tasks.complete", markdownReviewInspect = "markdown-plan.review.inspect";
const openspecRead = "openspec.artifact.read", openspecWrite = "openspec.artifact.write", openspecValidate = "openspec.validate";
const openspecTaskList = "openspec.tasks.list", openspecTaskComplete = "openspec.tasks.complete", openspecReviewInspect = "openspec.review.inspect";
export const BUILTIN_ARTIFACT_PROFILES: readonly ArtifactProfileContract[] = Object.freeze([
  contract("none", "default", ["none"], []),
  contract("markdown-plan", "author", author, ["plan"], [markdownRead, markdownAuthor, markdownUpdate, markdownValidate]),
  contract("markdown-plan", "execute", existing, ["plan", "execution"], [markdownRead, markdownValidate, markdownTaskList, markdownTaskComplete]),
  contract("markdown-plan", "review", existing, ["execution", "review"], [markdownRead, markdownValidate, markdownTaskList, markdownReviewInspect]),
  contract("markdown-plan", "lifecycle", author, ["plan", "execution", "review"], [markdownRead, markdownAuthor, markdownUpdate, markdownValidate, markdownTaskList, markdownTaskComplete, markdownReviewInspect]),
  contract("openspec", "author", author, ["proposal", "design", "specs", "tasks"], [openspecRead, openspecWrite, openspecValidate]),
  contract("openspec", "execute", existing, ["tasks", "implementation"], [openspecRead, openspecValidate, openspecTaskList, openspecTaskComplete]),
  contract("openspec", "review", existing, ["implementation", "review"], [openspecRead, openspecValidate, openspecTaskList, openspecReviewInspect]),
  contract("openspec", "lifecycle", author, ["proposal", "design", "specs", "tasks", "implementation", "review"], [openspecRead, openspecWrite, openspecValidate, openspecTaskList, openspecTaskComplete, openspecReviewInspect]),
]);
export function artifactProfileContract(adapter: string, profile: string): ArtifactProfileContract | undefined {
  return BUILTIN_ARTIFACT_PROFILES.find((item) => item.adapter === adapter && item.profile === profile);
}
function validContractId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) && Buffer.byteLength(value, "utf8") <= ARTIFACT_CONTRACT_LIMITS.idBytes;
}
function exactObjectKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Artifact workspace binding contains unknown or missing fields");
}
/** Strict replay validator for the trusted workspace record embedded in run.started. */
export function validateArtifactWorkspaceBinding(value: unknown): ArtifactWorkspaceBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Artifact workspace binding is invalid");
  const raw = value as Record<string, unknown>;
  const required = ["schemaVersion", "contractVersion", "adapterId", "adapterVersion", "profileId", "profileVersion", "binding", "workspace", "checkpointIds", "actionIds"];
  exactObjectKeys(raw, required, ["selection", "path", "workspaceHash", "writerLease"]);
  if (raw.schemaVersion !== 1 || raw.contractVersion !== ARTIFACT_CONTRACT_VERSION || raw.profileVersion !== ARTIFACT_PROFILE_VERSION
    || !validContractId(raw.adapterId) || !validContractId(raw.adapterVersion) || !validContractId(raw.profileId)
    || !(["none", "new", "existing", "either"] as const).includes(raw.binding as ArtifactBinding)) throw new Error("Artifact workspace binding contract identity is invalid");
  if (!raw.workspace || typeof raw.workspace !== "object" || Array.isArray(raw.workspace)) throw new Error("Artifact workspace identity is invalid");
  const workspace = raw.workspace as Record<string, unknown>;
  exactObjectKeys(workspace, ["id", "kind"]);
  if (!validContractId(workspace.id) || (workspace.kind !== "logical-empty" && workspace.kind !== "physical")) throw new Error("Artifact workspace identity is invalid");
  const list = (input: unknown, label: string): readonly string[] => {
    if (!Array.isArray(input) || input.length > ARTIFACT_CONTRACT_LIMITS.viewItems || input.some((item) => !validContractId(item)) || new Set(input).size !== input.length) throw new Error(`${label} is invalid`);
    return Object.freeze([...input] as string[]);
  };
  const checkpointIds = list(raw.checkpointIds, "Artifact checkpoint IDs");
  const actionIds = list(raw.actionIds, "Artifact action IDs");
  if (raw.selection !== undefined && raw.selection !== "new" && raw.selection !== "existing") throw new Error("Artifact workspace selection is invalid");
  if (raw.path !== undefined && (typeof raw.path !== "string" || !raw.path.startsWith("/") || Buffer.byteLength(raw.path, "utf8") > 4_096)) throw new Error("Artifact workspace path is invalid");
  if (raw.workspaceHash !== undefined && (typeof raw.workspaceHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(raw.workspaceHash))) throw new Error("Artifact workspace hash is invalid");
  if (raw.writerLease !== undefined && (!raw.writerLease || typeof raw.writerLease !== "object" || Array.isArray(raw.writerLease) || Object.keys(raw.writerLease as object).length !== 1 || (raw.writerLease as { required?: unknown }).required !== true)) throw new Error("Artifact writer lease contract is invalid");
  if (workspace.kind === "logical-empty" && (raw.selection !== undefined || raw.path !== undefined || raw.workspaceHash !== undefined || raw.writerLease !== undefined || checkpointIds.length || actionIds.length || raw.binding !== "none")) throw new Error("Logical empty artifact workspace cannot carry physical authority");
  if (workspace.kind === "physical" && ((raw.selection !== "new" && raw.selection !== "existing") || raw.binding === "none" || raw.path === undefined || raw.workspaceHash === undefined || raw.writerLease === undefined)) throw new Error("Physical artifact workspace requires explicit selection, path, hash, and writer lease");
  if (raw.selection !== undefined && raw.binding !== "either" && raw.binding !== raw.selection) throw new Error("Artifact workspace selection is incompatible with its configured binding");
  const result: ArtifactWorkspaceBinding = {
    schemaVersion: 1,
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    adapterId: raw.adapterId,
    adapterVersion: raw.adapterVersion,
    profileId: raw.profileId,
    profileVersion: ARTIFACT_PROFILE_VERSION,
    binding: raw.binding as ArtifactBinding,
    ...(raw.selection === undefined ? {} : { selection: raw.selection as "new" | "existing" }),
    workspace: Object.freeze({ id: workspace.id, kind: workspace.kind }),
    ...(raw.path === undefined ? {} : { path: raw.path as string }),
    ...(raw.workspaceHash === undefined ? {} : { workspaceHash: raw.workspaceHash as string }),
    ...(raw.writerLease === undefined ? {} : { writerLease: Object.freeze({ required: true }) }),
    checkpointIds,
    actionIds,
  };
  return Object.freeze(result);
}

export function validateArtifactDeclaration(
  artifact: { adapter: string; profile: string; binding: string; options?: Record<string, unknown> },
  approvals: Record<string, unknown> | undefined,
): { contract?: ArtifactProfileContract; codes: ConfigDiagnosticCode[] } {
  const codes: ConfigDiagnosticCode[] = [];
  const selected = artifactProfileContract(artifact.adapter, artifact.profile);
  if (!selected) return { codes: ["ARTIFACT_PROFILE_UNKNOWN"] };
  if (!selected.bindings.includes(artifact.binding as ArtifactBinding)) codes.push("ARTIFACT_BINDING_INVALID");
  if (artifact.options) {
    const optionsBytes = Buffer.byteLength(JSON.stringify(artifact.options), "utf8");
    const keys = Object.keys(artifact.options);
    const markdownRoot = artifact.options.root;
    const markdownOptionsValid = selected.adapter === "markdown-plan" && keys.every((key) => key === "root")
      && (markdownRoot === undefined || (typeof markdownRoot === "string" && markdownRoot.length <= 512 && /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*){0,15}$/u.test(markdownRoot)
        && !markdownRoot.split("/").some((part) => part === ".git" || part === ".pi" || part === "openspec")));
    if (optionsBytes > ARTIFACT_CONTRACT_LIMITS.optionsBytes || (selected.adapter === "markdown-plan" ? !markdownOptionsValid : keys.length > 0)) codes.push("ARTIFACT_OPTIONS_UNKNOWN");
  }
  const actual = new Set(Object.keys(approvals ?? {}));
  for (const id of selected.checkpoints) if (!actual.has(id)) codes.push("WORKFLOW_CHECKPOINT_MISSING");
  for (const id of actual) if (!selected.checkpoints.includes(id)) codes.push("WORKFLOW_CHECKPOINT_UNKNOWN");
  return { contract: selected, codes };
}
