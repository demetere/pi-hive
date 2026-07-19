import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ProtectedPathRoot } from "../../capabilities/reserved-paths";
import { canonicalJson } from "../../config/snapshot-canonical";
import type { JsonValue } from "../../config/types";
import { resolveCanonicalPath, resolveContainedPath } from "../../core/safe-path";
import { boundedJson, boundedText, plainRecord, utf8Prefix } from "../../workflows/values";
import {
  ARTIFACT_ACTION_VERSION,
  ARTIFACT_CONTRACT_LIMITS,
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_PROFILE_VERSION,
  ARTIFACT_VIEW_VERSION,
} from "../contracts";
import { resolveCheckpointDigest, type CheckpointContributorV1, type CheckpointDescriptorV1 } from "../checkpoints";
import { hashArtifactWorkspace, type ArtifactWorkspaceHashesV1 } from "../hashes";
import type {
  ArtifactActionContext,
  ArtifactActionContract,
  ArtifactActionResultV1,
  ArtifactAdapter,
  ArtifactCheckpointDescriptorInput,
  ArtifactCompletionResult,
  ArtifactEvidenceReferenceV1,
  ArtifactRuntimeProfile,
  ArtifactStatusContext,
  ArtifactStatusPageRequest,
  ArtifactStatusViewV1,
  ArtifactWorkspaceBinding,
  VerifiedArtifactEvidenceV1,
} from "../types";

export const MARKDOWN_PLAN_ADAPTER_VERSION = "1" as const;
export const MARKDOWN_PLAN_PROFILE_SCHEMA_VERSION = "1" as const;
export const MARKDOWN_PLAN_DEFAULT_ROOT = "plans" as const;
export const MARKDOWN_PLAN_CHECKPOINT_IDS = Object.freeze(["plan", "execution", "review"] as const);
export const MARKDOWN_PLAN_ACTION_IDS = Object.freeze([
  "markdown-plan.plan.read",
  "markdown-plan.plan.author",
  "markdown-plan.plan.update",
  "markdown-plan.validate",
  "markdown-plan.tasks.list",
  "markdown-plan.tasks.complete",
  "markdown-plan.review.inspect",
] as const);
export const MARKDOWN_PLAN_LIMITS = Object.freeze({
  planBytes: 48_000,
  titleBytes: 512,
  summaryBytes: 24_000,
  taskTextBytes: 2_048,
  tasks: 256,
  evidenceRefsPerTask: 32,
  evidencePathBytes: 1_024,
  // Compact JSON at this bound accommodates 256 tasks with 32 worst-case
  // adapter-bounded verified references each, including JSON escaping.
  sidecarBytes: 67_108_864,
  sidecarNodes: 65_536,
  readPageJsonBytes: 48_000,
  rootBytes: 512,
  rootSegments: 16,
  validationIssues: 32,
});

export type MarkdownPlanAdapterErrorCode = "invalid-options" | "invalid-workspace" | "invalid-plan" | "output-limit";
export class MarkdownPlanAdapterError extends Error {
  readonly code: MarkdownPlanAdapterErrorCode;
  constructor(code: MarkdownPlanAdapterErrorCode, message: string) {
    super(message.slice(0, 2_048));
    this.name = "MarkdownPlanAdapterError";
    this.code = code;
  }
}

const strict = { additionalProperties: false } as const;
const ROOT_PATTERN = "^[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*){0,15}$";
const ID_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
const CONTRACT_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$";
const DIGEST_PATTERN = "^sha256:[0-9a-f]{64}$";
const OPTIONS_SCHEMA = Type.Object({ root: Type.Optional(Type.String({ pattern: ROOT_PATTERN, maxLength: MARKDOWN_PLAN_LIMITS.rootBytes })) }, strict);
const TaskInput = Type.Object({
  id: Type.String({ pattern: ID_PATTERN, maxLength: 64 }),
  text: Type.String({ minLength: 1, maxLength: MARKDOWN_PLAN_LIMITS.taskTextBytes }),
}, strict);
const PlanInput = Type.Object({
  title: Type.String({ minLength: 1, maxLength: MARKDOWN_PLAN_LIMITS.titleBytes }),
  summary: Type.String({ minLength: 1, maxLength: MARKDOWN_PLAN_LIMITS.summaryBytes }),
  tasks: Type.Array(TaskInput, { minItems: 1, maxItems: MARKDOWN_PLAN_LIMITS.tasks }),
}, strict);
const EvidenceReference = Type.Union([
  Type.Object({ kind: Type.Literal("tool"), attemptId: Type.String({ pattern: CONTRACT_ID_PATTERN, maxLength: 256 }) }, strict),
  Type.Object({ kind: Type.Literal("command"), attemptId: Type.String({ pattern: CONTRACT_ID_PATTERN, maxLength: 256 }) }, strict),
  Type.Object({ kind: Type.Literal("repository"), path: Type.String({ minLength: 1, maxLength: MARKDOWN_PLAN_LIMITS.evidencePathBytes }), digest: Type.String({ pattern: DIGEST_PATTERN, maxLength: 71 }) }, strict),
]);
const VERIFIED_EVIDENCE_SCHEMA = Type.Union([
  Type.Object({ kind: Type.Literal("tool"), attemptId: Type.String({ minLength: 1, maxLength: 256 }), operation: Type.String({ minLength: 1, maxLength: 1_024 }), inputHash: Type.String({ pattern: "^[0-9a-f]{64}$" }), resultHash: Type.String({ pattern: "^[0-9a-f]{64}$" }) }, strict),
  Type.Object({ kind: Type.Literal("command"), attemptId: Type.String({ minLength: 1, maxLength: 256 }), effect: Type.Union([Type.Literal("shell"), Type.Literal("git")]), operation: Type.String({ minLength: 1, maxLength: 1_024 }), inputHash: Type.String({ pattern: "^[0-9a-f]{64}$" }), resultHash: Type.String({ pattern: "^[0-9a-f]{64}$" }) }, strict),
  Type.Object({ kind: Type.Literal("repository"), path: Type.String({ minLength: 1, maxLength: MARKDOWN_PLAN_LIMITS.evidencePathBytes }), digest: Type.String({ pattern: DIGEST_PATTERN }), bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, strict),
]);

function action(input: Omit<ArtifactActionContract, "version" | "argumentsSchemaVersion">): ArtifactActionContract {
  return Object.freeze({ version: ARTIFACT_ACTION_VERSION, argumentsSchemaVersion: "1", ...input });
}
const READ_ACTION = action({ id: MARKDOWN_PLAN_ACTION_IDS[0], label: "Read Markdown plan", argumentsSchema: Type.Object({ cursor: Type.Optional(Type.String({ pattern: "^markdown-plan-read-v1:(0|[1-9][0-9]{0,8})$", maxLength: 40 })) }, strict), requiredCapabilities: Object.freeze(["read"] as const), completion: "optional", mutability: "read-only", idempotency: "idempotent" });
const AUTHOR_ACTION = action({ id: MARKDOWN_PLAN_ACTION_IDS[1], label: "Author Markdown plan", argumentsSchema: PlanInput, requiredCapabilities: Object.freeze(["write"] as const), completion: "mandatory", mutability: "mutating", idempotency: "operation-bound" });
const UPDATE_ACTION = action({ id: MARKDOWN_PLAN_ACTION_IDS[2], label: "Revise Markdown plan", argumentsSchema: PlanInput, requiredCapabilities: Object.freeze(["write"] as const), completion: "mandatory", mutability: "mutating", idempotency: "operation-bound" });
const VALIDATE_ACTION = action({ id: MARKDOWN_PLAN_ACTION_IDS[3], label: "Validate Markdown plan", argumentsSchema: Type.Object({}, strict), requiredCapabilities: Object.freeze(["read"] as const), completion: "optional", mutability: "read-only", idempotency: "idempotent" });
const TASK_LIST_ACTION = action({ id: MARKDOWN_PLAN_ACTION_IDS[4], label: "List Markdown plan tasks", argumentsSchema: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), cursor: Type.Optional(Type.String({ pattern: "^markdown-plan-tasks-v1:(0|[1-9][0-9]{0,8})$", maxLength: 40 })) }, strict), requiredCapabilities: Object.freeze(["read"] as const), completion: "optional", mutability: "read-only", idempotency: "idempotent" });
const TASK_COMPLETE_ACTION = action({ id: MARKDOWN_PLAN_ACTION_IDS[5], label: "Record Markdown plan task evidence", argumentsSchema: Type.Object({ taskId: Type.String({ pattern: ID_PATTERN, maxLength: 64 }), evidenceRefs: Type.Array(EvidenceReference, { minItems: 1, maxItems: MARKDOWN_PLAN_LIMITS.evidenceRefsPerTask }) }, strict), requiredCapabilities: Object.freeze(["write"] as const), completion: "mandatory", mutability: "mutating", idempotency: "operation-bound" });
const REVIEW_ACTION = action({ id: MARKDOWN_PLAN_ACTION_IDS[6], label: "Inspect Markdown plan review evidence", argumentsSchema: Type.Object({}, strict), requiredCapabilities: Object.freeze(["review"] as const), completion: "optional", mutability: "read-only", idempotency: "idempotent" });
const AUTHOR_ACTIONS = Object.freeze([READ_ACTION, AUTHOR_ACTION, UPDATE_ACTION, VALIDATE_ACTION]);
const EXECUTE_ACTIONS = Object.freeze([READ_ACTION, VALIDATE_ACTION, TASK_LIST_ACTION, TASK_COMPLETE_ACTION]);
const REVIEW_ACTIONS = Object.freeze([READ_ACTION, VALIDATE_ACTION, TASK_LIST_ACTION, REVIEW_ACTION]);
const LIFECYCLE_ACTIONS = Object.freeze([READ_ACTION, AUTHOR_ACTION, UPDATE_ACTION, VALIDATE_ACTION, TASK_LIST_ACTION, TASK_COMPLETE_ACTION, REVIEW_ACTION]);
function runtimeProfile(id: "author" | "execute" | "review" | "lifecycle", bindings: readonly ("new" | "existing" | "either")[], checkpoints: readonly string[], actions: readonly ArtifactActionContract[]): ArtifactRuntimeProfile {
  return Object.freeze({
    contractVersion: ARTIFACT_CONTRACT_VERSION, version: ARTIFACT_PROFILE_VERSION, adapterId: "markdown-plan", adapterVersion: MARKDOWN_PLAN_ADAPTER_VERSION,
    id, optionsSchemaVersion: MARKDOWN_PLAN_PROFILE_SCHEMA_VERSION, optionsSchema: OPTIONS_SCHEMA, bindings: Object.freeze([...bindings]),
    checkpointIds: Object.freeze([...checkpoints]), actions, viewVersion: ARTIFACT_VIEW_VERSION,
  });
}
export const MARKDOWN_PLAN_PROFILES = Object.freeze({
  author: runtimeProfile("author", ["new", "existing", "either"], ["plan"], AUTHOR_ACTIONS),
  execute: runtimeProfile("execute", ["existing"], ["plan", "execution"], EXECUTE_ACTIONS),
  review: runtimeProfile("review", ["existing"], ["execution", "review"], REVIEW_ACTIONS),
  lifecycle: runtimeProfile("lifecycle", ["new", "existing", "either"], MARKDOWN_PLAN_CHECKPOINT_IDS, LIFECYCLE_ACTIONS),
});
const PROFILE_LIST = Object.freeze([MARKDOWN_PLAN_PROFILES.author, MARKDOWN_PLAN_PROFILES.execute, MARKDOWN_PLAN_PROFILES.review, MARKDOWN_PLAN_PROFILES.lifecycle]);

const WORKSPACE_METADATA_PATH = ".pi-hive/workspace-v1.json";
const EVIDENCE_PATH = ".pi-hive/evidence-v1.json";
const PLAN_PATH = "plan.md";
const PLAN_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const ROOT_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*){0,15}$/u;
const TASK_ID_RE = PLAN_ID_RE;

function planRootOptions(options: Readonly<Record<string, JsonValue>>): string {
  if (!Value.Check(OPTIONS_SCHEMA, options)) throw new MarkdownPlanAdapterError("invalid-options", "Markdown plan options contain unknown or invalid fields");
  const value = options.root === undefined ? MARKDOWN_PLAN_DEFAULT_ROOT : String(options.root);
  if (!ROOT_RE.test(value) || value.split("/").length > MARKDOWN_PLAN_LIMITS.rootSegments || Buffer.byteLength(value, "utf8") > MARKDOWN_PLAN_LIMITS.rootBytes
    || value.split("/").some((part) => part === ".git" || part === ".pi" || part === "openspec")) {
    throw new MarkdownPlanAdapterError("invalid-options", "Markdown plan root must be a bounded project-relative POSIX path outside protected subsystem roots");
  }
  return value;
}
export function markdownPlanProtectedRoots(options: Readonly<Record<string, JsonValue>>): readonly ProtectedPathRoot[] {
  return Object.freeze([Object.freeze({ path: planRootOptions(options), kind: "artifact" as const })]);
}
function planId(value: unknown): string {
  if (typeof value !== "string" || !PLAN_ID_RE.test(value) || value.length > 128 || Buffer.byteLength(value, "utf8") > 128) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan workspace ID is invalid");
  return value;
}
function canonicalProjectRoot(value: string): string {
  const root = resolveCanonicalPath(value);
  if (!root?.exists || !lstatSync(root.canonicalPath).isDirectory() || lstatSync(root.canonicalPath).isSymbolicLink()) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan project root is unavailable");
  return root.canonicalPath;
}
function candidateRoot(projectRoot: string, options: Readonly<Record<string, JsonValue>>, allowMissing: boolean): Readonly<{ root: string; planRoot: string }> {
  const root = canonicalProjectRoot(projectRoot);
  const planRoot = planRootOptions(options);
  const candidate = resolveContainedPath(root, join(root, ...planRoot.split("/")), { allowMissing });
  if (!candidate) throw new MarkdownPlanAdapterError("invalid-options", "Markdown plan root escapes project containment");
  if (candidate.exists && (!lstatSync(candidate.canonicalPath).isDirectory() || lstatSync(candidate.canonicalPath).isSymbolicLink())) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan root must be a physical directory");
  return Object.freeze({ root: candidate.canonicalPath, planRoot });
}
function safeRead(path: string, maxBytes: number): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return undefined;
    const value = readFileSync(path, "utf8");
    return Buffer.byteLength(value, "utf8") <= maxBytes ? value : undefined;
  } catch { return undefined; }
}
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path); chmodSync(path, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}
interface WorkspaceMetadata { readonly schemaVersion: 1; readonly adapterVersion: "1"; readonly planId: string; readonly planRoot: string }
function metadata(id: string, root: string): WorkspaceMetadata { return Object.freeze({ schemaVersion: 1, adapterVersion: MARKDOWN_PLAN_ADAPTER_VERSION, planId: id, planRoot: root }); }
function readMetadata(path: string, expectedId: string): WorkspaceMetadata | undefined {
  const source = safeRead(join(path, WORKSPACE_METADATA_PATH), 4_096);
  if (!source) return undefined;
  try {
    const raw: unknown = JSON.parse(source);
    if (!plainRecord(raw) || Object.keys(raw).sort().join(",") !== "adapterVersion,planId,planRoot,schemaVersion" || raw.schemaVersion !== 1
      || raw.adapterVersion !== MARKDOWN_PLAN_ADAPTER_VERSION || raw.planId !== expectedId || !PLAN_ID_RE.test(String(raw.planId)) || !ROOT_RE.test(String(raw.planRoot))) return undefined;
    return metadata(String(raw.planId), String(raw.planRoot));
  } catch { return undefined; }
}
function candidateWorkspace(projectRoot: string, options: Readonly<Record<string, JsonValue>>, idValue: string): string | undefined {
  const id = planId(idValue);
  const resolvedRoot = candidateRoot(projectRoot, options, true);
  const candidate = resolveContainedPath(resolvedRoot.root, join(resolvedRoot.root, id), { allowMissing: true });
  if (!candidate || relative(resolvedRoot.root, candidate.canonicalPath).split("/").length !== 1 || !candidate.exists) return undefined;
  const stat = lstatSync(candidate.canonicalPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
  const meta = readMetadata(candidate.canonicalPath, id);
  return meta?.planRoot === resolvedRoot.planRoot ? candidate.canonicalPath : undefined;
}
interface Workspace { readonly projectRoot: string; readonly path: string; readonly planId: string; readonly planRoot: string }
function workspaceRoot(binding: ArtifactWorkspaceBinding): Workspace {
  if (binding.adapterId !== "markdown-plan" || binding.adapterVersion !== MARKDOWN_PLAN_ADAPTER_VERSION || binding.workspace.kind !== "physical" || !binding.path) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan workspace binding is incompatible");
  const path = resolveCanonicalPath(binding.path);
  if (!path?.exists || !lstatSync(path.canonicalPath).isDirectory() || lstatSync(path.canonicalPath).isSymbolicLink() || basename(path.canonicalPath) !== binding.workspace.id) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan workspace is unavailable or mismatched");
  const id = planId(binding.workspace.id);
  const meta = readMetadata(path.canonicalPath, id);
  if (!meta) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan workspace metadata is invalid");
  let projectRoot = dirname(path.canonicalPath);
  for (const _segment of meta.planRoot.split("/")) projectRoot = dirname(projectRoot);
  const canonicalProject = canonicalProjectRoot(projectRoot);
  const expected = resolveContainedPath(canonicalProject, join(canonicalProject, ...meta.planRoot.split("/"), id));
  if (!expected || expected.canonicalPath !== path.canonicalPath) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan workspace path does not match its metadata mapping");
  return Object.freeze({ projectRoot: canonicalProject, path: path.canonicalPath, planId: id, planRoot: meta.planRoot });
}
function decodeListCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  const match = /^markdown-plan-v1:(0|[1-9][0-9]{0,8})$/u.exec(value);
  if (!match) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan workspace cursor is invalid");
  return Number(match[1]);
}

interface PlanTask { readonly id: string; readonly text: string }
interface ParsedPlan { readonly id: string; readonly title: string; readonly summary: string; readonly revision: number; readonly lastOperationId: string; readonly tasks: readonly PlanTask[]; readonly source: string }
interface PlanValidation { readonly valid: boolean; readonly issues: readonly string[]; readonly plan?: ParsedPlan }
function normalizedBlock(value: unknown, label: string, bytes: number): string {
  const text = boundedText(value, label, bytes).replace(/\r\n?|\r/gu, "\n").trim();
  if (!text || text.includes("\0")) throw new MarkdownPlanAdapterError("invalid-plan", `${label} is empty or invalid`);
  return text;
}
function planInput(value: Readonly<Record<string, JsonValue>>): Readonly<{ title: string; summary: string; tasks: readonly PlanTask[] }> {
  if (!Value.Check(PlanInput, value)) throw new MarkdownPlanAdapterError("invalid-plan", "Markdown plan author/update input is invalid");
  const title = normalizedBlock(value.title, "Markdown plan title", MARKDOWN_PLAN_LIMITS.titleBytes);
  const summary = normalizedBlock(value.summary, "Markdown plan summary", MARKDOWN_PLAN_LIMITS.summaryBytes);
  if (title.includes("\n") || summary.split("\n").some((line) => line === "---" || line === "# Tasks")) throw new MarkdownPlanAdapterError("invalid-plan", "Markdown plan title/summary would make the canonical structure ambiguous");
  const rawTasks = value.tasks as unknown as readonly { id: string; text: string }[];
  const tasks = rawTasks.map((entry): PlanTask => {
    const id = String(entry.id); const text = normalizedBlock(entry.text, `Markdown plan task ${id}`, MARKDOWN_PLAN_LIMITS.taskTextBytes);
    if (!TASK_ID_RE.test(id) || id.length > 64 || text.includes("\n")) throw new MarkdownPlanAdapterError("invalid-plan", "Markdown plan tasks require stable lowercase IDs and single-line text");
    return Object.freeze({ id, text });
  });
  if (new Set(tasks.map((entry) => entry.id)).size !== tasks.length) throw new MarkdownPlanAdapterError("invalid-plan", "Markdown plan task IDs must be unique and stable");
  return Object.freeze({ title, summary, tasks: Object.freeze(tasks) });
}
function renderPlan(id: string, input: Readonly<{ title: string; summary: string; tasks: readonly PlanTask[] }>, revision: number, operationId: string): string {
  const value = `---\nschema-version: 1\nplan-id: ${id}\ntitle: ${JSON.stringify(input.title)}\nrevision: ${revision}\nlast-operation-id: ${operationId}\n---\n\n# Summary\n\n${input.summary}\n\n# Tasks\n\n${input.tasks.map((entry) => `- [ ] ${entry.id}: ${entry.text}`).join("\n")}\n`;
  if (Buffer.byteLength(value, "utf8") > MARKDOWN_PLAN_LIMITS.planBytes) throw new MarkdownPlanAdapterError("output-limit", "Canonical Markdown plan exceeds its byte limit");
  return value;
}
function validatePlan(path: string, expectedId: string): PlanValidation {
  const source = safeRead(join(path, PLAN_PATH), MARKDOWN_PLAN_LIMITS.planBytes);
  if (!source) return Object.freeze({ valid: false, issues: Object.freeze(["plan.md is missing, unsupported, or exceeds its byte limit"]) });
  try {
    if (source.includes("\r")) throw new Error("plan.md must use LF line endings");
    const lines = source.split("\n");
    if (lines.length < 15 || lines[0] !== "---" || lines[1] !== "schema-version: 1" || lines[2] !== `plan-id: ${expectedId}` || !lines[3].startsWith("title: ")
      || !/^revision: [1-9][0-9]*$/u.test(lines[4]) || !/^last-operation-id: [A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(lines[5]) || lines[6] !== "---"
      || lines[7] !== "" || lines[8] !== "# Summary" || lines[9] !== "") throw new Error("canonical frontmatter or Summary structure is invalid");
    const titleRaw: unknown = JSON.parse(lines[3].slice("title: ".length));
    if (typeof titleRaw !== "string") throw new Error("title must be a canonical quoted string");
    const tasksHeading = lines.indexOf("# Tasks", 10);
    if (tasksHeading < 12 || lines[tasksHeading - 1] !== "" || lines[tasksHeading + 1] !== "") throw new Error("canonical Tasks structure is invalid");
    const summary = lines.slice(10, tasksHeading - 1).join("\n");
    const taskLines = lines.slice(tasksHeading + 2, lines.at(-1) === "" ? -1 : undefined);
    if (!taskLines.length || taskLines.length > MARKDOWN_PLAN_LIMITS.tasks) throw new Error("plan must contain a bounded non-empty task list");
    const tasks = taskLines.map((line): PlanTask => {
      const match = /^- \[ \] ([a-z][a-z0-9]*(?:-[a-z0-9]+)*): (.+)$/u.exec(line);
      if (!match || match[1].length > 64 || Buffer.byteLength(match[2], "utf8") > MARKDOWN_PLAN_LIMITS.taskTextBytes) throw new Error("task lines must use canonical stable IDs");
      return Object.freeze({ id: match[1], text: match[2] });
    });
    if (new Set(tasks.map((entry) => entry.id)).size !== tasks.length) throw new Error("task IDs are duplicated");
    const parsed: ParsedPlan = Object.freeze({ id: expectedId, title: titleRaw, summary, revision: Number(lines[4].slice("revision: ".length)), lastOperationId: lines[5].slice("last-operation-id: ".length), tasks: Object.freeze(tasks), source });
    const canonicalInput = planInput({ title: parsed.title, summary: parsed.summary, tasks: parsed.tasks as unknown as JsonValue });
    if (renderPlan(expectedId, canonicalInput, parsed.revision, parsed.lastOperationId) !== source) throw new Error("plan.md is not in canonical form");
    return Object.freeze({ valid: true, issues: Object.freeze([]), plan: parsed });
  } catch (error) {
    return Object.freeze({ valid: false, issues: Object.freeze([String(error instanceof Error ? error.message : error).slice(0, 2_048)]) });
  }
}
function requirePlan(workspace: Workspace): ParsedPlan {
  const result = validatePlan(workspace.path, workspace.planId);
  if (!result.valid || !result.plan) throw new MarkdownPlanAdapterError("invalid-plan", `Markdown plan is invalid: ${result.issues.join("; ")}`);
  return result.plan;
}
function planContentIdentity(hashes: ArtifactWorkspaceHashesV1): string {
  const entry = hashes.entries.find((candidate) => candidate.path === PLAN_PATH && candidate.kind === "file");
  if (!entry) throw new MarkdownPlanAdapterError("invalid-plan", "Markdown plan content identity requires plan.md");
  return `sha256:${createHash("sha256").update("pi-hive-markdown-plan-content-v1\0").update(JSON.stringify({ path: entry.path, bytes: entry.bytes, digest: entry.hash })).digest("hex")}`;
}

interface EvidenceEntry { readonly taskId: string; readonly taskText: string; readonly operationId: string; readonly evidenceRefs: readonly VerifiedArtifactEvidenceV1[]; readonly completedAt: string }
interface EvidenceState { readonly schemaVersion: 1; readonly adapterVersion: "1"; readonly planId: string; readonly planRevision: number; readonly planContentIdentity: string; readonly tasks: Readonly<Record<string, EvidenceEntry>> }
function emptyEvidence(planIdValue: string): EvidenceState { return Object.freeze({ schemaVersion: 1, adapterVersion: MARKDOWN_PLAN_ADAPTER_VERSION, planId: planIdValue, planRevision: 0, planContentIdentity: "", tasks: Object.freeze({}) }); }
function artifactHash(value: unknown): value is string { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value); }
function verifiedEvidence(value: unknown): VerifiedArtifactEvidenceV1 | undefined {
  if (!Value.Check(VERIFIED_EVIDENCE_SCHEMA, value) || !plainRecord(value)) return undefined;
  if ((value.kind === "tool" || value.kind === "command") && Buffer.byteLength(value.operation, "utf8") > 1_024) return undefined;
  if (value.kind === "repository" && Buffer.byteLength(value.path, "utf8") > MARKDOWN_PLAN_LIMITS.evidencePathBytes) return undefined;
  return Object.freeze(structuredClone(value)) as VerifiedArtifactEvidenceV1;
}
function invalidEvidence(message: string): never { throw new MarkdownPlanAdapterError("invalid-plan", `Markdown plan execution evidence is invalid: ${message}`); }
function readEvidence(path: string, id: string): EvidenceState {
  const evidencePath = join(path, EVIDENCE_PATH);
  if (!existsSync(evidencePath)) return emptyEvidence(id);
  let source: string;
  try {
    const stat = lstatSync(evidencePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MARKDOWN_PLAN_LIMITS.sidecarBytes) invalidEvidence("sidecar is not a bounded physical file");
    source = readFileSync(evidencePath, "utf8");
    if (Buffer.byteLength(source, "utf8") !== stat.size) invalidEvidence("sidecar encoding or size is inconsistent");
  } catch (error) {
    if (error instanceof MarkdownPlanAdapterError) throw error;
    return invalidEvidence(String(error instanceof Error ? error.message : error));
  }
  try {
    const raw: unknown = JSON.parse(source);
    boundedJson(raw, "Markdown plan execution evidence", { bytes: MARKDOWN_PLAN_LIMITS.sidecarBytes, depth: 12, nodes: MARKDOWN_PLAN_LIMITS.sidecarNodes, rootRecord: true });
    if (!plainRecord(raw) || Object.keys(raw).sort().join(",") !== "adapterVersion,planContentIdentity,planId,planRevision,schemaVersion,tasks" || raw.schemaVersion !== 1
      || raw.adapterVersion !== MARKDOWN_PLAN_ADAPTER_VERSION || raw.planId !== id || !Number.isSafeInteger(raw.planRevision) || Number(raw.planRevision) < 1
      || !artifactHash(raw.planContentIdentity) || !plainRecord(raw.tasks) || Object.keys(raw.tasks).length > MARKDOWN_PLAN_LIMITS.tasks) invalidEvidence("sidecar identity or task collection is inconsistent");
    const tasks: Record<string, EvidenceEntry> = {};
    for (const [taskId, value] of Object.entries(raw.tasks)) {
      if (!TASK_ID_RE.test(taskId) || !plainRecord(value) || Object.keys(value).sort().join(",") !== "completedAt,evidenceRefs,operationId,taskId,taskText" || value.taskId !== taskId
        || typeof value.taskText !== "string" || !value.taskText || Buffer.byteLength(value.taskText, "utf8") > MARKDOWN_PLAN_LIMITS.taskTextBytes
        || typeof value.operationId !== "string" || !new RegExp(CONTRACT_ID_PATTERN, "u").test(value.operationId)
        || !Array.isArray(value.evidenceRefs) || !value.evidenceRefs.length || value.evidenceRefs.length > MARKDOWN_PLAN_LIMITS.evidenceRefsPerTask
        || typeof value.completedAt !== "string" || Buffer.byteLength(value.completedAt, "utf8") > 256 || !Number.isFinite(Date.parse(value.completedAt))) invalidEvidence(`task ${taskId} is inconsistent`);
      const refs = value.evidenceRefs.map(verifiedEvidence);
      if (refs.some((entry) => !entry) || !refs.some((entry) => entry?.kind === "repository") || !refs.some((entry) => entry?.kind === "tool" || entry?.kind === "command")) invalidEvidence(`task ${taskId} has incomplete or malformed verified references`);
      tasks[taskId] = Object.freeze({ taskId, taskText: value.taskText, operationId: value.operationId, evidenceRefs: Object.freeze(refs as VerifiedArtifactEvidenceV1[]), completedAt: value.completedAt });
    }
    return Object.freeze({ schemaVersion: 1, adapterVersion: MARKDOWN_PLAN_ADAPTER_VERSION, planId: id, planRevision: Number(raw.planRevision), planContentIdentity: raw.planContentIdentity, tasks: Object.freeze(tasks) });
  } catch (error) {
    if (error instanceof MarkdownPlanAdapterError) throw error;
    return invalidEvidence(String(error instanceof Error ? error.message : error));
  }
}
function normalizedEvidence(value: EvidenceState): JsonValue {
  return { schemaVersion: value.schemaVersion, adapterVersion: value.adapterVersion, planId: value.planId, planRevision: value.planRevision, planContentIdentity: value.planContentIdentity,
    tasks: Object.fromEntries(Object.entries(value.tasks).sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => [id, { ...entry, evidenceRefs: [...entry.evidenceRefs] }])) };
}
function serializeEvidence(value: EvidenceState): string {
  const normalized = boundedJson(normalizedEvidence(value), "Markdown plan execution evidence", { bytes: MARKDOWN_PLAN_LIMITS.sidecarBytes, depth: 12, nodes: MARKDOWN_PLAN_LIMITS.sidecarNodes, rootRecord: true });
  const serialized = `${JSON.stringify(normalized)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MARKDOWN_PLAN_LIMITS.sidecarBytes) throw new MarkdownPlanAdapterError("output-limit", "Markdown plan execution evidence exceeds its physical sidecar byte limit");
  return serialized;
}
function evidenceDigest(value: EvidenceState): string {
  return `sha256:${createHash("sha256").update("pi-hive-markdown-plan-evidence-v1\0").update(canonicalJson(normalizedEvidence(value))).digest("hex")}`;
}
function repositoryEvidenceCurrent(root: string, reference: Extract<VerifiedArtifactEvidenceV1, { kind: "repository" }>): boolean {
  try {
    if (!reference.path || reference.path.includes("\\") || reference.path.startsWith("/") || reference.path.split("/").some((part) => !part || part === "." || part === "..")) return false;
    const candidate = resolveContainedPath(root, join(root, ...reference.path.split("/")));
    if (!candidate?.exists || relative(root, candidate.canonicalPath).split("\\").join("/") !== reference.path) return false;
    const stat = lstatSync(candidate.canonicalPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== reference.bytes || stat.size > 33_554_432) return false;
    return `sha256:${createHash("sha256").update(readFileSync(candidate.canonicalPath)).digest("hex")}` === reference.digest;
  } catch { return false; }
}
function entryCurrent(workspace: Workspace, entry: EvidenceEntry): boolean {
  return entry.evidenceRefs.some((reference) => reference.kind === "repository") && entry.evidenceRefs.some((reference) => reference.kind === "tool" || reference.kind === "command")
    && entry.evidenceRefs.every((reference) => reference.kind !== "repository" || repositoryEvidenceCurrent(workspace.projectRoot, reference));
}
function completedTaskIds(workspace: Workspace, plan: ParsedPlan, hashes: ArtifactWorkspaceHashesV1, evidence = readEvidence(workspace.path, workspace.planId)): readonly string[] {
  const identity = planContentIdentity(hashes);
  if (evidence.planContentIdentity !== identity || evidence.planRevision !== plan.revision) return Object.freeze([]);
  return Object.freeze(plan.tasks.filter((task) => evidence.tasks[task.id]?.taskText === task.text && entryCurrent(workspace, evidence.tasks[task.id])).map((task) => task.id));
}

function descriptor(input: ArtifactCheckpointDescriptorInput): CheckpointDescriptorV1 {
  const workspace = workspaceRoot(input.binding); requirePlan(workspace);
  if (!input.binding.checkpointIds.includes(input.checkpointId) || !MARKDOWN_PLAN_CHECKPOINT_IDS.includes(input.checkpointId as never)) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan checkpoint is not published by the bound profile");
  const contributors: CheckpointContributorV1[] = [Object.freeze({ kind: "file", path: PLAN_PATH })];
  if (input.checkpointId !== "plan") contributors.push(Object.freeze({ kind: "hash", id: "execution-evidence-v1", digest: evidenceDigest(readEvidence(workspace.path, workspace.planId)) }));
  return Object.freeze({ formatVersion: 1, adapterId: "markdown-plan", adapterVersion: MARKDOWN_PLAN_ADAPTER_VERSION, profileId: input.binding.profileId,
    profileVersion: input.binding.profileVersion, profileSchemaVersion: MARKDOWN_PLAN_PROFILE_SCHEMA_VERSION, checkpointId: input.checkpointId, checkpointVersion: "1", contributors: Object.freeze(contributors) });
}
function actionResult(context: ArtifactActionContext | { binding: ArtifactWorkspaceBinding; operationId: string }, actionId: string, summary: string, changed: boolean, data: Readonly<Record<string, JsonValue>>, refs: ArtifactActionResultV1["refs"] = Object.freeze([])): ArtifactActionResultV1 {
  const hash = context.binding.path ? hashArtifactWorkspace(context.binding.path).workspaceHash : context.binding.workspaceHash;
  return Object.freeze({ schemaVersion: ARTIFACT_ACTION_VERSION, operationId: context.operationId, actionId, status: "completed", summary, changed, ...(hash ? { workspaceHash: hash } : {}), data: Object.freeze(data), refs });
}
function display(value: string, bytes = 512): string { return utf8Prefix(value.replaceAll("<", "‹").replaceAll(">", "›"), bytes); }
function actionAvailable(value: ArtifactActionContract, capabilities: ArtifactStatusContext["capabilities"]): boolean { return value.requiredCapabilities.every((capability) => capabilities.includes(capability)); }
function statusCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  const match = /^markdown-plan-status-v1:(0|[1-9][0-9]{0,8})$/u.exec(value);
  if (!match) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan status cursor is invalid");
  return Number(match[1]);
}
function taskCursor(value: unknown): number {
  if (value === undefined) return 0;
  const match = /^markdown-plan-tasks-v1:(0|[1-9][0-9]{0,8})$/u.exec(String(value));
  if (!match) throw new MarkdownPlanAdapterError("invalid-plan", "Markdown plan task cursor is invalid");
  return Number(match[1]);
}
function readCursor(value: unknown): number {
  if (value === undefined) return 0;
  const match = /^markdown-plan-read-v1:(0|[1-9][0-9]{0,8})$/u.exec(String(value));
  if (!match) throw new MarkdownPlanAdapterError("invalid-plan", "Markdown plan read cursor is invalid");
  return Number(match[1]);
}
function sourcePage(source: string, cursor: unknown): Readonly<{ source: string; offset: number; count: number; total: number; nextCursor?: string }> {
  const characters = Array.from(source);
  const offset = readCursor(cursor);
  if (offset > characters.length) throw new MarkdownPlanAdapterError("invalid-plan", "Markdown plan read cursor is stale");
  let low = offset;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = characters.slice(offset, middle).join("");
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") - 2 <= MARKDOWN_PLAN_LIMITS.readPageJsonBytes) low = middle;
    else high = middle - 1;
  }
  if (offset < characters.length && low === offset) throw new MarkdownPlanAdapterError("output-limit", "One Markdown plan character cannot fit the bounded read DTO");
  const value = characters.slice(offset, low).join("");
  return Object.freeze({ source: value, offset, count: low - offset, total: characters.length, ...(low < characters.length ? { nextCursor: `markdown-plan-read-v1:${low}` } : {}) });
}

export function createMarkdownPlanAdapter(input: Readonly<{ now?: () => string }> = {}): ArtifactAdapter & { readonly profiles: typeof PROFILE_LIST } {
  const now = input.now ?? (() => new Date().toISOString());
  const adapter: ArtifactAdapter & { readonly profiles: typeof PROFILE_LIST } = {
    contractVersion: ARTIFACT_CONTRACT_VERSION, id: "markdown-plan", version: MARKDOWN_PLAN_ADAPTER_VERSION, profiles: PROFILE_LIST,
    protectedWorkspaceRoots(request) {
      canonicalProjectRoot(request.projectRoot);
      if (!PROFILE_LIST.includes(request.profile as never)) throw new MarkdownPlanAdapterError("invalid-options", "Markdown plan protected roots require an active built-in profile");
      return markdownPlanProtectedRoots(request.options);
    },
    workspaceLifecycle: {
      create(request) {
        const root = candidateRoot(request.projectRoot, request.options, true); const id = planId(request.workspaceId);
        mkdirSync(root.root, { recursive: true, mode: 0o700 });
        const verifiedRoot = candidateRoot(request.projectRoot, request.options, false);
        const target = join(verifiedRoot.root, id);
        if (existsSync(target)) throw new MarkdownPlanAdapterError("invalid-workspace", `Markdown plan ${id} already exists`);
        mkdirSync(target, { mode: 0o700 });
        atomicWrite(join(target, WORKSPACE_METADATA_PATH), `${JSON.stringify(metadata(id, verifiedRoot.planRoot), null, 2)}\n`);
        const resolved = candidateWorkspace(request.projectRoot, request.options, id);
        if (!resolved) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan scaffold did not produce one exact contained workspace");
        return Object.freeze({ id, path: resolved });
      },
      resolve(request) {
        const id = planId(request.workspaceId); const path = candidateWorkspace(request.projectRoot, request.options, id);
        return path ? Object.freeze({ id, path }) : undefined;
      },
      list(request) {
        const root = candidateRoot(request.projectRoot, request.options, true);
        if (!existsSync(root.root)) return Object.freeze({ items: Object.freeze([]) });
        const ids = readdirSync(root.root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && PLAN_ID_RE.test(entry.name) && candidateWorkspace(request.projectRoot, request.options, entry.name)).map((entry) => entry.name).sort();
        const offset = decodeListCursor(request.cursor);
        if (offset > ids.length) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan workspace cursor is stale");
        const selected = ids.slice(offset, offset + request.limit);
        return Object.freeze({ items: Object.freeze(selected.map((id) => Object.freeze({ id, label: id, summary: "Exact Markdown plan workspace" }))), ...(offset + selected.length < ids.length ? { nextCursor: `markdown-plan-v1:${offset + selected.length}` } : {}) });
      },
      validateHandoffReference(request) {
        try {
          if (request.reference.workspaceId !== request.workspace.id || !MARKDOWN_PLAN_CHECKPOINT_IDS.includes(request.reference.checkpoint as never)) return Object.freeze({ state: "incompatible" as const, reason: "handoff identity/checkpoint is incompatible with Markdown plan" });
          const target = PROFILE_LIST.find((entry) => entry.id === request.profileId);
          if (!target?.checkpointIds.includes(request.reference.checkpoint)) return Object.freeze({ state: "incompatible" as const, reason: "target Markdown plan profile does not publish the handoff checkpoint" });
          const digests = PROFILE_LIST.filter((entry) => entry.checkpointIds.includes(request.reference.checkpoint)).map((sourceProfile) => {
            const binding: ArtifactWorkspaceBinding = Object.freeze({ schemaVersion: 1, contractVersion: ARTIFACT_CONTRACT_VERSION, adapterId: "markdown-plan", adapterVersion: MARKDOWN_PLAN_ADAPTER_VERSION,
              profileId: sourceProfile.id, profileVersion: sourceProfile.version, binding: "existing", selection: "existing", workspace: Object.freeze({ id: request.workspace.id, kind: "physical" as const }), path: request.workspace.path,
              workspaceHash: request.hashes.workspaceHash, writerLease: Object.freeze({ required: true }), checkpointIds: sourceProfile.checkpointIds, actionIds: Object.freeze(sourceProfile.actions.map((entry) => entry.id)) });
            return resolveCheckpointDigest(descriptor({ binding, checkpointId: request.reference.checkpoint, hashes: request.hashes }), request.hashes).digest;
          });
          return digests.includes(request.reference.digest) ? Object.freeze({ state: "valid" as const }) : Object.freeze({ state: "stale" as const, reason: "Markdown plan checkpoint digest changed" });
        } catch (error) { return Object.freeze({ state: "stale" as const, reason: String(error instanceof Error ? error.message : error).slice(0, 2_048) }); }
      },
    },
    bind() { throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan physical workspaces bind through the common workspace lifecycle"); },
    status(context: ArtifactStatusContext, page: ArtifactStatusPageRequest): ArtifactStatusViewV1 {
      const workspace = workspaceRoot(context.binding); const profile = PROFILE_LIST.find((entry) => entry.id === context.binding.profileId);
      if (!profile || !context.hashes) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan status requires its active profile and fresh workspace hash");
      const validation = validatePlan(workspace.path, workspace.planId); const plan = validation.plan; const evidence = readEvidence(workspace.path, workspace.planId);
      const completed = plan ? new Set(completedTaskIds(workspace, plan, context.hashes, evidence)) : new Set<string>();
      const allItems = plan ? plan.tasks.map((task) => Object.freeze({ id: `task:${task.id}`, kind: "execution-task", label: display(task.text, MARKDOWN_PLAN_LIMITS.taskTextBytes), state: completed.has(task.id) ? "complete" : "pending", summary: completed.has(task.id) ? `${evidence.tasks[task.id].evidenceRefs.length} verified evidence reference(s)` : "Current verified execution evidence required", ref: `markdown-plan-task:${task.id}` }))
        : validation.issues.map((issue, index) => Object.freeze({ id: `validation:${index}`, kind: "validation", label: "Plan validation issue", state: "blocked", summary: display(issue, 2_048), ref: `markdown-plan-validation:${index}` }));
      const offset = statusCursor(page.cursor); if (offset > allItems.length) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan status cursor is stale");
      const checkpoints = Object.freeze(profile.checkpointIds.map((checkpointId) => {
        try { const resolved = resolveCheckpointDigest(descriptor({ binding: context.binding, checkpointId, hashes: context.hashes! }), context.hashes!); return Object.freeze({ id: checkpointId, state: "ready" as const, digest: resolved.digest }); }
        catch { return Object.freeze({ id: checkpointId, state: "pending" as const }); }
      }));
      const authorDone = Boolean(plan); const executionDone = Boolean(plan?.tasks.length && completed.size === plan.tasks.length);
      const complete = profile.id === "author" ? authorDone : profile.id === "lifecycle" ? authorDone && executionDone : executionDone;
      const actions = Object.freeze(profile.actions.map((entry) => Object.freeze({ id: entry.id, label: entry.label, available: actionAvailable(entry, context.capabilities), ...(!actionAvailable(entry, context.capabilities) ? { reason: `Requires artifact.${entry.requiredCapabilities.join("+")}` } : {}) })));
      const refs = Object.freeze(checkpoints.filter((entry): entry is Readonly<{ id: string; state: "ready"; digest: string }> => "digest" in entry).map((entry) => Object.freeze({ id: entry.id, kind: "checkpoint", digest: entry.digest })));
      const selected = allItems.slice(offset, offset + page.limit);
      const build = (items: readonly (typeof allItems)[number][]) => ({ schemaVersion: ARTIFACT_VIEW_VERSION, contractVersion: ARTIFACT_CONTRACT_VERSION, adapter: { id: "markdown-plan", version: MARKDOWN_PLAN_ADAPTER_VERSION },
        profile: { id: profile.id, version: profile.version }, workspace: { id: workspace.planId, kind: "physical" as const, binding: context.binding.binding, path: workspace.path, hash: context.hashes!.workspaceHash },
        status: complete ? "complete" as const : validation.valid ? "ready" as const : "blocked" as const,
        summary: complete ? "Markdown plan profile completion requirements are satisfied." : validation.valid ? `Markdown plan revision ${plan!.revision} is canonical; current evidence is required for incomplete tasks.` : `Markdown plan validation reports ${validation.issues.length} issue(s).`,
        checkpoints, actions, items, page: { limit: page.limit, ...(page.cursor ? { cursor: page.cursor } : {}), ...(offset + items.length < allItems.length ? { nextCursor: `markdown-plan-status-v1:${offset + items.length}` } : {}) }, refs });
      while (selected.length && Buffer.byteLength(JSON.stringify(build(selected)), "utf8") > ARTIFACT_CONTRACT_LIMITS.viewBytes) selected.pop();
      if (!selected.length && offset < allItems.length) throw new MarkdownPlanAdapterError("output-limit", "One Markdown plan status item cannot fit the bounded view DTO");
      return Object.freeze(build(Object.freeze(selected))) as ArtifactStatusViewV1;
    },
    async executeAction(context: ArtifactActionContext, selected: ArtifactActionContract, argumentsValue: Readonly<Record<string, JsonValue>>): Promise<ArtifactActionResultV1> {
      const workspace = workspaceRoot(context.binding); const profile = PROFILE_LIST.find((entry) => entry.id === context.binding.profileId);
      if (!profile?.actions.includes(selected)) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan action is not published by the active profile");
      const validation = validatePlan(workspace.path, workspace.planId);
      if (selected.id === MARKDOWN_PLAN_ACTION_IDS[0]) {
        if (!validation.plan) return actionResult(context, selected.id, "Markdown plan is not yet canonical.", false, { issues: validation.issues as unknown as JsonValue });
        const page = sourcePage(validation.plan.source, argumentsValue.cursor);
        const hashes = hashArtifactWorkspace(workspace.path);
        const planEntry = hashes.entries.find((entry) => entry.path === PLAN_PATH && entry.kind === "file")!;
        const result = actionResult(context, selected.id, `Read canonical Markdown plan revision ${validation.plan.revision}.`, false,
          { title: validation.plan.title, revision: validation.plan.revision, taskCount: validation.plan.tasks.length, source: page.source, page: { offset: page.offset, count: page.count, total: page.total, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) } },
          Object.freeze([Object.freeze({ id: PLAN_PATH, kind: "file", digest: planEntry.hash, bytes: planEntry.bytes })]));
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > ARTIFACT_CONTRACT_LIMITS.resultBytes) throw new MarkdownPlanAdapterError("output-limit", "Markdown plan read page exceeds the artifact facade result limit");
        return result;
      }
      if (selected.id === MARKDOWN_PLAN_ACTION_IDS[1] || selected.id === MARKDOWN_PLAN_ACTION_IDS[2]) {
        if (selected.id === MARKDOWN_PLAN_ACTION_IDS[1] && existsSync(join(workspace.path, PLAN_PATH))) throw new MarkdownPlanAdapterError("invalid-plan", "Markdown plan is already authored; use the update action for an explicit revision");
        if (selected.id === MARKDOWN_PLAN_ACTION_IDS[2] && !validation.plan) throw new MarkdownPlanAdapterError("invalid-plan", "Markdown plan update requires a current canonical plan");
        const next = planInput(argumentsValue); const revision = selected.id === MARKDOWN_PLAN_ACTION_IDS[1] ? 1 : validation.plan!.revision + 1;
        const content = renderPlan(workspace.planId, next, revision, context.operationId);
        await context.enqueueMutation(PLAN_PATH, () => atomicWrite(join(workspace.path, PLAN_PATH), content));
        return actionResult(context, selected.id, `${selected.id === MARKDOWN_PLAN_ACTION_IDS[1] ? "Authored" : "Revised"} canonical Markdown plan revision ${revision}.`, true, { revision, taskCount: next.tasks.length });
      }
      if (selected.id === MARKDOWN_PLAN_ACTION_IDS[3]) {
        return actionResult(context, selected.id, validation.valid ? "Markdown plan validation passed." : `Markdown plan validation found ${validation.issues.length} issue(s).`, false,
          { valid: validation.valid, ...(validation.plan ? { revision: validation.plan.revision, taskCount: validation.plan.tasks.length } : {}), issues: validation.issues as unknown as JsonValue });
      }
      const plan = requirePlan(workspace); const hashes = hashArtifactWorkspace(workspace.path); const evidence = readEvidence(workspace.path, workspace.planId); const completed = new Set(completedTaskIds(workspace, plan, hashes, evidence));
      if (selected.id === MARKDOWN_PLAN_ACTION_IDS[4]) {
        const offset = taskCursor(argumentsValue.cursor); if (offset > plan.tasks.length) throw new MarkdownPlanAdapterError("invalid-plan", "Markdown plan task cursor is stale");
        const limit = argumentsValue.limit === undefined ? 20 : Number(argumentsValue.limit);
        const tasks = plan.tasks.slice(offset, offset + limit).map((task) => ({ taskId: task.id, text: task.text, completed: completed.has(task.id), ...(evidence.tasks[task.id] ? { evidenceRefCount: evidence.tasks[task.id].evidenceRefs.length } : {}) }));
        const build = () => actionResult(context, selected.id, `${completed.size}/${plan.tasks.length} Markdown plan tasks have current evidence.`, false, { tasks, total: plan.tasks.length, ...(offset + tasks.length < plan.tasks.length ? { nextCursor: `markdown-plan-tasks-v1:${offset + tasks.length}` } : {}) });
        let result = build();
        while (tasks.length && Buffer.byteLength(JSON.stringify(result), "utf8") > ARTIFACT_CONTRACT_LIMITS.resultBytes) { tasks.pop(); result = build(); }
        if (!tasks.length && offset < plan.tasks.length) throw new MarkdownPlanAdapterError("output-limit", "One Markdown plan task cannot fit the bounded list DTO");
        return result;
      }
      if (selected.id === MARKDOWN_PLAN_ACTION_IDS[5]) {
        const taskId = String(argumentsValue.taskId); const task = plan.tasks.find((entry) => entry.id === taskId);
        if (!task) throw new MarkdownPlanAdapterError("invalid-plan", `Markdown plan task ${taskId} does not exist in the exact current plan`);
        if (!context.verifyEvidence || !Array.isArray(argumentsValue.evidenceRefs)) throw new MarkdownPlanAdapterError("invalid-plan", "Markdown plan task completion requires package-issued evidence verification");
        const refs = Object.freeze([...context.verifyEvidence(argumentsValue.evidenceRefs as unknown as readonly ArtifactEvidenceReferenceV1[])]);
        if (!refs.length || !refs.some((entry) => entry.kind === "repository") || !refs.some((entry) => entry.kind === "tool" || entry.kind === "command") || refs.some((entry) => !verifiedEvidence(entry))) throw new MarkdownPlanAdapterError("invalid-plan", "Markdown plan task completion requires verified W13 tool/command evidence and current repository hashes");
        const identity = planContentIdentity(hashes); const retained = evidence.planContentIdentity === identity && evidence.planRevision === plan.revision ? evidence.tasks : {};
        const completedAt = boundedText(now(), "Markdown plan evidence completion timestamp", 256);
        if (!Number.isFinite(Date.parse(completedAt))) throw new MarkdownPlanAdapterError("invalid-plan", "Markdown plan evidence completion timestamp is invalid");
        const next: EvidenceState = Object.freeze({ schemaVersion: 1, adapterVersion: MARKDOWN_PLAN_ADAPTER_VERSION, planId: workspace.planId, planRevision: plan.revision, planContentIdentity: identity,
          tasks: Object.freeze({ ...retained, [taskId]: Object.freeze({ taskId, taskText: task.text, operationId: context.operationId, evidenceRefs: refs, completedAt }) }) });
        const serialized = serializeEvidence(next);
        await context.enqueueMutation(EVIDENCE_PATH, () => atomicWrite(join(workspace.path, EVIDENCE_PATH), serialized));
        return actionResult(context, selected.id, `Recorded current verified execution evidence for Markdown plan task ${taskId}.`, true, { taskId, planContentIdentity: identity, evidenceRefCount: refs.length });
      }
      if (selected.id === MARKDOWN_PLAN_ACTION_IDS[6]) {
        const review = resolveCheckpointDigest(descriptor({ binding: context.binding, checkpointId: "review", hashes }), hashes);
        return actionResult(context, selected.id, "Inspected adapter-owned review evidence; human checkpoint decisions remain outside this action.", false,
          { reviewDigest: review.digest, revision: plan.revision, taskCount: plan.tasks.length, completedTaskIds: [...completed] },
          Object.freeze(review.contributors.map((entry, index) => Object.freeze({ id: `review:${index}`, kind: entry.kind, digest: entry.digest, ...(entry.kind === "file" ? { bytes: entry.bytes } : {}) }))));
      }
      throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan action is unsupported");
    },
    checkpointDescriptor: descriptor,
    reconcileAction(context, selected) {
      const workspace = workspaceRoot(context.binding); const validation = validatePlan(workspace.path, workspace.planId);
      if ((selected.id === MARKDOWN_PLAN_ACTION_IDS[1] || selected.id === MARKDOWN_PLAN_ACTION_IDS[2]) && validation.plan?.lastOperationId === context.operation.operationId) {
        return Object.freeze({ state: "applied" as const, result: actionResult({ binding: context.binding, operationId: context.operation.operationId }, selected.id, `${selected.id === MARKDOWN_PLAN_ACTION_IDS[1] ? "Authored" : "Revised"} canonical Markdown plan revision ${validation.plan.revision}.`, true, { revision: validation.plan.revision, taskCount: validation.plan.tasks.length }) });
      }
      if (selected.id === MARKDOWN_PLAN_ACTION_IDS[5]) {
        const entry = Object.values(readEvidence(workspace.path, workspace.planId).tasks).find((candidate) => candidate.operationId === context.operation.operationId);
        if (entry) return Object.freeze({ state: "applied" as const, result: actionResult({ binding: context.binding, operationId: context.operation.operationId }, selected.id, `Recorded current verified execution evidence for Markdown plan task ${entry.taskId}.`, true, { taskId: entry.taskId, evidenceRefCount: entry.evidenceRefs.length }) });
      }
      return Object.freeze({ state: "unknown" as const, diagnostic: `Markdown plan cannot prove interrupted ${selected.id} from current adapter-owned state` });
    },
    validateCompletion(binding: ArtifactWorkspaceBinding): ArtifactCompletionResult {
      try {
        const workspace = workspaceRoot(binding); const profile = PROFILE_LIST.find((entry) => entry.id === binding.profileId);
        if (!profile) throw new MarkdownPlanAdapterError("invalid-workspace", "Markdown plan completion profile is unknown");
        const validation = validatePlan(workspace.path, workspace.planId); const issues = [...validation.issues];
        if (validation.plan && profile.id !== "author") {
          const hashes = hashArtifactWorkspace(workspace.path); const evidence = readEvidence(workspace.path, workspace.planId); const identity = planContentIdentity(hashes);
          if (evidence.planContentIdentity !== identity || evidence.planRevision !== validation.plan.revision) issues.push("Markdown plan execution evidence is stale because the exact plan content/revision changed");
          const completed = new Set(completedTaskIds(workspace, validation.plan, hashes, evidence));
          const incomplete = validation.plan.tasks.filter((entry) => !completed.has(entry.id)).map((entry) => entry.id);
          if (incomplete.length) issues.push(`Markdown plan execution evidence or current repository hashes are missing/stale for tasks: ${incomplete.join(", ")}`);
        }
        return issues.length ? Object.freeze({ state: "unsatisfied" as const, issues: Object.freeze(issues.slice(0, 128)) }) : Object.freeze({ state: "satisfied" as const });
      } catch (error) { return Object.freeze({ state: "unsatisfied" as const, issues: Object.freeze([String(error instanceof Error ? error.message : error).slice(0, 2_048)]) }); }
    },
  };
  return Object.freeze(adapter);
}

export const MARKDOWN_PLAN_ARTIFACT_ADAPTER = createMarkdownPlanAdapter();
