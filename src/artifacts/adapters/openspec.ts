import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
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
  ArtifactEvidenceReferenceV1,
  ArtifactActionResultV1,
  ArtifactAdapter,
  ArtifactCheckpointDescriptorInput,
  ArtifactCompletionResult,
  ArtifactRuntimeProfile,
  ArtifactStatusContext,
  ArtifactStatusPageRequest,
  ArtifactStatusViewV1,
  ArtifactWorkspaceBinding,
  VerifiedArtifactEvidenceV1,
} from "../types";

export const OPEN_SPEC_ADAPTER_VERSION = "1" as const;
export const OPEN_SPEC_PROFILE_SCHEMA_VERSION = "1" as const;
export const OPEN_SPEC_CHECKPOINT_IDS = Object.freeze(["proposal", "design", "specs", "tasks", "implementation", "review"] as const);
export const OPEN_SPEC_ACTION_IDS = Object.freeze([
  "openspec.artifact.read",
  "openspec.artifact.write",
  "openspec.validate",
  "openspec.tasks.list",
  "openspec.tasks.complete",
  "openspec.review.inspect",
] as const);
export const OPEN_SPEC_LIMITS = Object.freeze({
  commandTimeoutMs: 20_000,
  commandOutputBytes: 4_000_000,
  artifactBytes: 48_000,
  aggregateReadBytes: 56_000,
  specFiles: 200,
  evidenceBytes: 8_000,
  evidenceTasks: 256,
  sidecarBytes: 65_536,
  validationIssues: 32,
});

export type OpenSpecAdapterErrorCode = "unavailable" | "not-initialized" | "timeout" | "cancelled" | "output-limit" | "invalid-json" | "failed" | "invalid-state";
export class OpenSpecAdapterError extends Error {
  readonly code: OpenSpecAdapterErrorCode;
  constructor(code: OpenSpecAdapterErrorCode, message: string) {
    super(message.slice(0, 2_048));
    this.name = "OpenSpecAdapterError";
    this.code = code;
  }
}

export interface OpenSpecCliRunOptions { readonly signal?: AbortSignal; readonly allowNonZero?: boolean }
export interface OpenSpecCli {
  available(): boolean;
  runSync(projectRoot: string, args: readonly string[], options?: Readonly<{ allowNonZero?: boolean }>): unknown;
  runJson(projectRoot: string, args: readonly string[], options?: OpenSpecCliRunOptions): Promise<unknown>;
}

function defaultBinary(): string | undefined {
  const override = process.env.HIVE_OPENSPEC_BIN;
  if (override) return override;
  let current: string;
  try { current = dirname(fileURLToPath(import.meta.url)); }
  catch { current = process.cwd(); }
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(current, "node_modules", ".bin", "openspec");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}
function cliEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1", NO_COLOR: "1" };
}
function classifySpawnError(error: unknown, fallback: string): OpenSpecAdapterError {
  const code = String((error as NodeJS.ErrnoException | undefined)?.code ?? "");
  if (code === "ENOENT" || code === "EACCES") return new OpenSpecAdapterError("unavailable", "OpenSpec CLI is unavailable");
  if (code === "ETIMEDOUT") return new OpenSpecAdapterError("timeout", fallback);
  if (code === "ENOBUFS") return new OpenSpecAdapterError("output-limit", "OpenSpec output exceeded its byte limit");
  return new OpenSpecAdapterError("failed", error instanceof Error ? error.message : fallback);
}

/** Bounded, telemetry-disabled OpenSpec process boundary used only by the built-in adapter. */
export function createOpenSpecCli(input: Readonly<{ binary?: string; timeoutMs?: number; maxOutputBytes?: number }> = {}): OpenSpecCli {
  const binary = input.binary ?? defaultBinary();
  const timeoutMs = Math.max(50, Math.min(60_000, Math.floor(input.timeoutMs ?? OPEN_SPEC_LIMITS.commandTimeoutMs)));
  const maxOutputBytes = Math.max(1_024, Math.min(OPEN_SPEC_LIMITS.commandOutputBytes, Math.floor(input.maxOutputBytes ?? OPEN_SPEC_LIMITS.commandOutputBytes)));
  const available = (): boolean => Boolean(binary && existsSync(binary));
  const requireBinary = (): string => {
    if (!available()) throw new OpenSpecAdapterError("unavailable", "OpenSpec CLI is unavailable");
    return binary!;
  };
  return Object.freeze({
    available,
    runSync(projectRoot: string, args: readonly string[], options: Readonly<{ allowNonZero?: boolean }> = {}) {
      const executable = requireBinary();
      const result = spawnSync(executable, [...args], {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        env: cliEnvironment(),
      });
      if (result.error) throw classifySpawnError(result.error, `OpenSpec command timed out after ${timeoutMs}ms`);
      const stdout = String(result.stdout ?? "");
      const stderr = String(result.stderr ?? "");
      if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes || Buffer.byteLength(stderr, "utf8") > maxOutputBytes) throw new OpenSpecAdapterError("output-limit", "OpenSpec output exceeded its byte limit");
      if (result.signal === "SIGTERM" || result.signal === "SIGKILL") throw new OpenSpecAdapterError("timeout", `OpenSpec command timed out after ${timeoutMs}ms`);
      if (result.status && !options.allowNonZero) throw new OpenSpecAdapterError("failed", `OpenSpec command exited with code ${result.status}`);
      return stdout;
    },
    async runJson(projectRoot: string, args: readonly string[], options: OpenSpecCliRunOptions = {}): Promise<unknown> {
      const executable = requireBinary();
      if (options.signal?.aborted) throw new OpenSpecAdapterError("cancelled", "OpenSpec request was cancelled");
      return new Promise<unknown>((resolvePromise, rejectPromise) => {
        const detached = process.platform !== "win32";
        let child;
        try {
          child = spawn(executable, [...args], { cwd: projectRoot, detached, stdio: ["ignore", "pipe", "pipe"], env: cliEnvironment() });
        } catch (error) {
          rejectPromise(classifySpawnError(error, "OpenSpec command failed"));
          return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let failure: OpenSpecAdapterError | undefined;
        let settled = false;
        const finish = (error?: OpenSpecAdapterError, value?: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          if (error) rejectPromise(error); else resolvePromise(value);
        };
        const terminate = (error: OpenSpecAdapterError): void => {
          if (failure) return;
          failure = error;
          try {
            if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch { finish(error); }
        };
        const collect = (target: Buffer[]) => (chunk: Buffer | string): void => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          outputBytes += bytes.byteLength;
          if (outputBytes > maxOutputBytes) terminate(new OpenSpecAdapterError("output-limit", "OpenSpec output exceeded its byte limit"));
          else target.push(bytes);
        };
        const onAbort = (): void => terminate(new OpenSpecAdapterError("cancelled", "OpenSpec request was cancelled"));
        const timer = setTimeout(() => terminate(new OpenSpecAdapterError("timeout", `OpenSpec command timed out after ${timeoutMs}ms`)), timeoutMs);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", collect(stdout));
        child.stderr?.on("data", collect(stderr));
        child.once("error", (error) => finish(classifySpawnError(error, "OpenSpec command failed")));
        child.once("close", (code) => {
          if (failure) { finish(failure); return; }
          if (code && !options.allowNonZero) { finish(new OpenSpecAdapterError("failed", `OpenSpec command exited with code ${code}`)); return; }
          try { finish(undefined, JSON.parse(Buffer.concat(stdout).toString("utf8"))); }
          catch { finish(new OpenSpecAdapterError("invalid-json", "OpenSpec returned invalid JSON")); }
        });
      });
    },
  });
}

const strict = { additionalProperties: false } as const;
const ArtifactId = Type.Union([Type.Literal("proposal"), Type.Literal("design"), Type.Literal("specs"), Type.Literal("tasks")]);
const Content = Type.String({ minLength: 1, maxLength: OPEN_SPEC_LIMITS.artifactBytes });
const READ_ACTION: ArtifactActionContract = Object.freeze({
  version: ARTIFACT_ACTION_VERSION, id: OPEN_SPEC_ACTION_IDS[0], label: "Read OpenSpec artifact", argumentsSchemaVersion: "1",
  argumentsSchema: Type.Object({ artifactId: ArtifactId }, strict), requiredCapabilities: Object.freeze(["read"] as const), completion: "optional", mutability: "read-only", idempotency: "idempotent",
});
const WRITE_ACTION: ArtifactActionContract = Object.freeze({
  version: ARTIFACT_ACTION_VERSION, id: OPEN_SPEC_ACTION_IDS[1], label: "Write OpenSpec artifact", argumentsSchemaVersion: "1",
  argumentsSchema: Type.Union([
    Type.Object({ artifactId: Type.Union([Type.Literal("proposal"), Type.Literal("design"), Type.Literal("tasks")]), content: Content }, strict),
    Type.Object({ artifactId: Type.Literal("specs"), capabilityId: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 128 }), content: Content }, strict),
  ]),
  requiredCapabilities: Object.freeze(["write"] as const), completion: "mandatory", mutability: "mutating", idempotency: "operation-bound",
});
const VALIDATE_ACTION: ArtifactActionContract = Object.freeze({
  version: ARTIFACT_ACTION_VERSION, id: OPEN_SPEC_ACTION_IDS[2], label: "Validate OpenSpec change", argumentsSchemaVersion: "1",
  argumentsSchema: Type.Object({}, strict), requiredCapabilities: Object.freeze(["read"] as const), completion: "optional", mutability: "read-only", idempotency: "idempotent",
});
const TASKS_LIST_ACTION: ArtifactActionContract = Object.freeze({
  version: ARTIFACT_ACTION_VERSION, id: OPEN_SPEC_ACTION_IDS[3], label: "List OpenSpec execution tasks", argumentsSchemaVersion: "1",
  argumentsSchema: Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    cursor: Type.Optional(Type.String({ pattern: "^openspec-tasks-v1:(0|[1-9][0-9]{0,8})$", maxLength: 32 })),
  }, strict), requiredCapabilities: Object.freeze(["read"] as const), completion: "optional", mutability: "read-only", idempotency: "idempotent",
});
const TASK_COMPLETE_ACTION: ArtifactActionContract = Object.freeze({
  version: ARTIFACT_ACTION_VERSION, id: OPEN_SPEC_ACTION_IDS[4], label: "Record OpenSpec task evidence", argumentsSchemaVersion: "1",
  argumentsSchema: Type.Object({
    taskId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", maxLength: 64 }),
    evidenceRefs: Type.Array(Type.Union([
      Type.Object({ kind: Type.Literal("tool"), attemptId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$", maxLength: 256 }) }, strict),
      Type.Object({ kind: Type.Literal("command"), attemptId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$", maxLength: 256 }) }, strict),
      Type.Object({ kind: Type.Literal("repository"), path: Type.String({ minLength: 1, maxLength: 4_096 }), digest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$", maxLength: 71 }) }, strict),
    ]), { minItems: 1, maxItems: 32 }),
  }, strict),
  requiredCapabilities: Object.freeze(["write"] as const), completion: "mandatory", mutability: "mutating", idempotency: "operation-bound",
});
const REVIEW_INSPECT_ACTION: ArtifactActionContract = Object.freeze({
  version: ARTIFACT_ACTION_VERSION, id: OPEN_SPEC_ACTION_IDS[5], label: "Inspect OpenSpec implementation review evidence", argumentsSchemaVersion: "1",
  argumentsSchema: Type.Object({}, strict), requiredCapabilities: Object.freeze(["review"] as const), completion: "optional", mutability: "read-only", idempotency: "idempotent",
});
const VERIFIED_EVIDENCE_SCHEMA = Type.Union([
  Type.Object({ kind: Type.Literal("tool"), attemptId: Type.String({ minLength: 1, maxLength: 256 }), operation: Type.String({ minLength: 1, maxLength: 1_024 }), inputHash: Type.String({ pattern: "^[0-9a-f]{64}$" }), resultHash: Type.String({ pattern: "^[0-9a-f]{64}$" }) }, strict),
  Type.Object({ kind: Type.Literal("command"), attemptId: Type.String({ minLength: 1, maxLength: 256 }), effect: Type.Union([Type.Literal("shell"), Type.Literal("git")]), operation: Type.String({ minLength: 1, maxLength: 1_024 }), inputHash: Type.String({ pattern: "^[0-9a-f]{64}$" }), resultHash: Type.String({ pattern: "^[0-9a-f]{64}$" }) }, strict),
  Type.Object({ kind: Type.Literal("repository"), path: Type.String({ minLength: 1, maxLength: 4_096 }), digest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }), bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, strict),
]);
const EMPTY_OPTIONS = Type.Object({}, strict);
const AUTHOR_ACTIONS = Object.freeze([READ_ACTION, WRITE_ACTION, VALIDATE_ACTION]);
const EXECUTE_ACTIONS = Object.freeze([READ_ACTION, VALIDATE_ACTION, TASKS_LIST_ACTION, TASK_COMPLETE_ACTION]);
const REVIEW_ACTIONS = Object.freeze([READ_ACTION, VALIDATE_ACTION, TASKS_LIST_ACTION, REVIEW_INSPECT_ACTION]);
const LIFECYCLE_ACTIONS = Object.freeze([READ_ACTION, WRITE_ACTION, VALIDATE_ACTION, TASKS_LIST_ACTION, TASK_COMPLETE_ACTION, REVIEW_INSPECT_ACTION]);
function runtimeProfile(id: "author" | "execute" | "review" | "lifecycle", bindings: readonly ("new" | "existing" | "either")[], checkpoints: readonly string[], actions: readonly ArtifactActionContract[]): ArtifactRuntimeProfile {
  return Object.freeze({
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    version: ARTIFACT_PROFILE_VERSION,
    adapterId: "openspec",
    adapterVersion: OPEN_SPEC_ADAPTER_VERSION,
    id,
    optionsSchemaVersion: OPEN_SPEC_PROFILE_SCHEMA_VERSION,
    optionsSchema: EMPTY_OPTIONS,
    bindings: Object.freeze([...bindings]),
    checkpointIds: Object.freeze([...checkpoints]),
    actions,
    viewVersion: ARTIFACT_VIEW_VERSION,
  });
}
export const OPEN_SPEC_PROFILES = Object.freeze({
  author: runtimeProfile("author", ["new", "existing", "either"], OPEN_SPEC_CHECKPOINT_IDS.slice(0, 4), AUTHOR_ACTIONS),
  execute: runtimeProfile("execute", ["existing"], ["tasks", "implementation"], EXECUTE_ACTIONS),
  review: runtimeProfile("review", ["existing"], ["implementation", "review"], REVIEW_ACTIONS),
  lifecycle: runtimeProfile("lifecycle", ["new", "existing", "either"], OPEN_SPEC_CHECKPOINT_IDS, LIFECYCLE_ACTIONS),
});
const PROFILE_LIST = Object.freeze([OPEN_SPEC_PROFILES.author, OPEN_SPEC_PROFILES.execute, OPEN_SPEC_PROFILES.review, OPEN_SPEC_PROFILES.lifecycle]);

const CHANGE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
type OpenSpecArtifactId = "proposal" | "design" | "specs" | "tasks";
const GRAPH = Object.freeze([
  Object.freeze({ id: "proposal" as const, label: "Proposal", dependencies: Object.freeze([] as OpenSpecArtifactId[]) }),
  Object.freeze({ id: "design" as const, label: "Design", dependencies: Object.freeze(["proposal"] as OpenSpecArtifactId[]) }),
  Object.freeze({ id: "specs" as const, label: "Specification deltas", dependencies: Object.freeze(["proposal"] as OpenSpecArtifactId[]) }),
  Object.freeze({ id: "tasks" as const, label: "Tasks", dependencies: Object.freeze(["design", "specs"] as OpenSpecArtifactId[]) }),
]);
const EVIDENCE_PATH = ".pi-hive/evidence-v1.json";

function changeId(value: unknown): string {
  if (typeof value !== "string" || !CHANGE_ID_RE.test(value) || Buffer.byteLength(value, "utf8") > ARTIFACT_CONTRACT_LIMITS.idBytes) throw new OpenSpecAdapterError("invalid-state", "OpenSpec change workspace ID is invalid");
  return value;
}
function projectRoot(value: string): string {
  const canonical = resolveCanonicalPath(value);
  if (!canonical?.exists || !lstatSync(canonical.canonicalPath).isDirectory()) throw new OpenSpecAdapterError("invalid-state", "OpenSpec project root is unavailable");
  return canonical.canonicalPath;
}
function requireReadyProject(rootValue: string, cli: OpenSpecCli): string {
  const root = projectRoot(rootValue);
  if (!cli.available()) throw new OpenSpecAdapterError("unavailable", "OpenSpec CLI is unavailable");
  const hasConfig = ["config.yaml", "config.yml"].some((filename) => {
    const config = resolveContainedPath(root, join(root, "openspec", filename));
    return Boolean(config?.exists && statSync(config.canonicalPath).isFile());
  });
  const changes = resolveContainedPath(root, join(root, "openspec", "changes"));
  if (!hasConfig || !changes?.exists || !statSync(changes.canonicalPath).isDirectory()) {
    throw new OpenSpecAdapterError("not-initialized", "OpenSpec is not initialized in this project");
  }
  return root;
}
function candidateWorkspace(root: string, idValue: string, allowMissing = false): string | undefined {
  const id = changeId(idValue);
  const candidate = join(root, "openspec", "changes", id);
  const contained = resolveContainedPath(root, candidate, { allowMissing });
  if (!contained || relative(join(root, "openspec", "changes"), contained.canonicalPath).split("/").length !== 1) return undefined;
  if (!contained.exists) return allowMissing ? contained.canonicalPath : undefined;
  const stat = lstatSync(contained.canonicalPath);
  return stat.isDirectory() && !stat.isSymbolicLink() ? contained.canonicalPath : undefined;
}
function decodeCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  const match = /^openspec-v1:(0|[1-9][0-9]{0,8})$/u.exec(value);
  if (!match) throw new OpenSpecAdapterError("invalid-state", "OpenSpec workspace cursor is invalid");
  return Number(match[1]);
}
function workspaceRoot(binding: ArtifactWorkspaceBinding): Readonly<{ projectRoot: string; path: string; changeId: string }> {
  if (binding.adapterId !== "openspec" || binding.adapterVersion !== OPEN_SPEC_ADAPTER_VERSION || binding.workspace.kind !== "physical" || !binding.path) throw new OpenSpecAdapterError("invalid-state", "OpenSpec workspace binding is incompatible");
  const path = resolveCanonicalPath(binding.path);
  if (!path?.exists || !lstatSync(path.canonicalPath).isDirectory() || lstatSync(path.canonicalPath).isSymbolicLink()) throw new OpenSpecAdapterError("invalid-state", "OpenSpec workspace is unavailable");
  const changes = dirname(path.canonicalPath);
  if (basename(changes) !== "changes" || basename(dirname(changes)) !== "openspec" || basename(path.canonicalPath) !== binding.workspace.id) throw new OpenSpecAdapterError("invalid-state", "OpenSpec workspace path does not match its exact change ID");
  const root = dirname(dirname(changes));
  if (!resolveContainedPath(root, path.canonicalPath)) throw new OpenSpecAdapterError("invalid-state", "OpenSpec workspace escaped project containment");
  return Object.freeze({ projectRoot: root, path: path.canonicalPath, changeId: changeId(binding.workspace.id) });
}
function safeRead(path: string, maxBytes: number = OPEN_SPEC_LIMITS.artifactBytes): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return undefined;
    const value = readFileSync(path, "utf8");
    return Buffer.byteLength(value, "utf8") <= maxBytes ? value : undefined;
  } catch { return undefined; }
}
function nonEmptyFile(path: string): boolean { return Boolean(safeRead(path)?.trim()); }
function specFiles(path: string): readonly string[] {
  const root = join(path, "specs");
  if (!existsSync(root)) return Object.freeze([]);
  const files: string[] = [];
  const pending = [{ path: root, relative: "specs", depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > 16) throw new OpenSpecAdapterError("output-limit", "OpenSpec specs exceed the traversal depth limit");
    const entries = readdirSync(current.path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      const child = join(current.path, entry.name);
      const rel = `${current.relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new OpenSpecAdapterError("invalid-state", "OpenSpec specs contain a denied symlink");
      if (entry.isDirectory()) pending.push({ path: child, relative: rel, depth: current.depth + 1 });
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(rel);
      if (files.length > OPEN_SPEC_LIMITS.specFiles) throw new OpenSpecAdapterError("output-limit", "OpenSpec specs exceed the file limit");
    }
  }
  return Object.freeze(files.sort());
}
function artifactPaths(path: string, id: OpenSpecArtifactId): readonly string[] {
  if (id === "specs") return specFiles(path);
  return Object.freeze([`${id}.md`]);
}
function artifactPresent(path: string, id: OpenSpecArtifactId): boolean {
  const files = artifactPaths(path, id);
  return files.length > 0 && files.every((entry) => nonEmptyFile(join(path, entry)));
}
function readArtifact(path: string, id: OpenSpecArtifactId): string {
  const files = artifactPaths(path, id);
  let bytes = 0;
  const chunks: string[] = [];
  for (const file of files) {
    const content = safeRead(join(path, file));
    if (!content) continue;
    const chunk = id === "specs" ? `## ${file}\n\n${content.trim()}\n` : content;
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > OPEN_SPEC_LIMITS.aggregateReadBytes) throw new OpenSpecAdapterError("output-limit", "OpenSpec artifact read exceeds its aggregate limit");
    chunks.push(chunk);
  }
  return chunks.join(id === "specs" ? "\n" : "");
}
interface PlannedTask { readonly taskId: string; readonly text: string }
function plannedTasks(path: string): readonly PlannedTask[] {
  const source = safeRead(join(path, "tasks.md")) ?? "";
  const tasks: PlannedTask[] = [];
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*[-*]\s*\[[ xX]\]\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:[.:)]\s+|\s+-\s+|\s+)(.+?)\s*$/u.exec(line);
    if (!match || !TASK_ID_RE.test(match[1]) || tasks.some((entry) => entry.taskId === match[1])) continue;
    tasks.push(Object.freeze({ taskId: match[1], text: boundedText(match[2], "OpenSpec task text", 1_024) }));
    if (tasks.length > OPEN_SPEC_LIMITS.evidenceTasks) throw new OpenSpecAdapterError("output-limit", "OpenSpec tasks exceed the evidence limit");
  }
  return Object.freeze(tasks);
}
interface EvidenceEntry {
  readonly taskId: string;
  readonly taskText: string;
  readonly operationId: string;
  readonly evidenceRefs: readonly VerifiedArtifactEvidenceV1[];
  readonly completedAt: string;
}
interface EvidenceState {
  readonly schemaVersion: 1;
  readonly adapterVersion: "1";
  readonly changeId: string;
  /** Profile-neutral identity of the exact approved tasks.md bytes. */
  readonly tasksContentIdentity: string;
  readonly tasks: Readonly<Record<string, EvidenceEntry>>;
}
function emptyEvidence(changeIdValue: string, tasksContentIdentity = ""): EvidenceState {
  return Object.freeze({ schemaVersion: 1, adapterVersion: OPEN_SPEC_ADAPTER_VERSION, changeId: changeIdValue, tasksContentIdentity, tasks: Object.freeze({}) });
}
function artifactHash(value: unknown): value is string { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value); }
function verifiedEvidenceRef(value: unknown): VerifiedArtifactEvidenceV1 | undefined {
  if (!Value.Check(VERIFIED_EVIDENCE_SCHEMA, value)) return undefined;
  return Object.freeze(structuredClone(value)) as VerifiedArtifactEvidenceV1;
}
function readEvidence(path: string, changeIdValue: string): EvidenceState {
  const source = safeRead(join(path, EVIDENCE_PATH), OPEN_SPEC_LIMITS.sidecarBytes);
  if (!source) return emptyEvidence(changeIdValue);
  try {
    const raw: unknown = JSON.parse(source);
    if (!plainRecord(raw) || Object.keys(raw).sort().join(",") !== "adapterVersion,changeId,schemaVersion,tasks,tasksContentIdentity"
      || raw.schemaVersion !== 1 || raw.adapterVersion !== OPEN_SPEC_ADAPTER_VERSION || raw.changeId !== changeIdValue || !artifactHash(raw.tasksContentIdentity)
      || !plainRecord(raw.tasks) || Object.keys(raw.tasks).length > OPEN_SPEC_LIMITS.evidenceTasks) return emptyEvidence(changeIdValue);
    const tasks: Record<string, EvidenceEntry> = {};
    for (const [id, value] of Object.entries(raw.tasks)) {
      if (!TASK_ID_RE.test(id) || !plainRecord(value) || Object.keys(value).sort().join(",") !== "completedAt,evidenceRefs,operationId,taskId,taskText"
        || value.taskId !== id || typeof value.taskText !== "string" || !value.taskText.trim() || Buffer.byteLength(value.taskText, "utf8") > 2_048
        || typeof value.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.operationId)
        || !Array.isArray(value.evidenceRefs) || !value.evidenceRefs.length || value.evidenceRefs.length > 32
        || typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))) return emptyEvidence(changeIdValue);
      const evidenceRefs = value.evidenceRefs.map(verifiedEvidenceRef);
      if (evidenceRefs.some((entry) => !entry) || !evidenceRefs.some((entry) => entry?.kind === "repository")
        || !evidenceRefs.some((entry) => entry?.kind === "tool" || entry?.kind === "command")) return emptyEvidence(changeIdValue);
      tasks[id] = Object.freeze({ taskId: id, taskText: value.taskText, operationId: value.operationId, evidenceRefs: Object.freeze(evidenceRefs as VerifiedArtifactEvidenceV1[]), completedAt: value.completedAt });
    }
    return Object.freeze({ schemaVersion: 1, adapterVersion: OPEN_SPEC_ADAPTER_VERSION, changeId: changeIdValue, tasksContentIdentity: raw.tasksContentIdentity, tasks: Object.freeze(tasks) });
  } catch { return emptyEvidence(changeIdValue); }
}
function normalizedEvidence(value: EvidenceState): JsonValue {
  return {
    schemaVersion: value.schemaVersion,
    adapterVersion: value.adapterVersion,
    changeId: value.changeId,
    tasksContentIdentity: value.tasksContentIdentity,
    tasks: Object.fromEntries(Object.entries(value.tasks).sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => [id, { ...entry, evidenceRefs: [...entry.evidenceRefs] }])),
  };
}
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}
function descriptor(input: ArtifactCheckpointDescriptorInput): CheckpointDescriptorV1 {
  const workspace = workspaceRoot(input.binding);
  if (!input.binding.checkpointIds.includes(input.checkpointId)) throw new OpenSpecAdapterError("invalid-state", "OpenSpec checkpoint is not published by the bound profile");
  const contributors: CheckpointContributorV1[] = [];
  const addArtifact = (id: OpenSpecArtifactId): void => { for (const path of artifactPaths(workspace.path, id)) contributors.push(Object.freeze({ kind: "file", path })); };
  if (input.checkpointId === "proposal" || input.checkpointId === "design" || input.checkpointId === "specs" || input.checkpointId === "tasks") addArtifact(input.checkpointId);
  else if (input.checkpointId === "implementation" || input.checkpointId === "review") {
    addArtifact("tasks");
    contributors.push(Object.freeze({ kind: "data", id: "execution-evidence-v1", value: normalizedEvidence(readEvidence(workspace.path, workspace.changeId)) }));
    if (input.checkpointId === "review") for (const id of ["proposal", "design", "specs"] as const) addArtifact(id);
  } else throw new OpenSpecAdapterError("invalid-state", "OpenSpec checkpoint is unknown");
  return Object.freeze({
    formatVersion: 1,
    adapterId: "openspec",
    adapterVersion: OPEN_SPEC_ADAPTER_VERSION,
    profileId: input.binding.profileId,
    profileVersion: input.binding.profileVersion,
    profileSchemaVersion: OPEN_SPEC_PROFILE_SCHEMA_VERSION,
    checkpointId: input.checkpointId,
    checkpointVersion: "1",
    contributors: Object.freeze(contributors),
  });
}
/** Content identity deliberately excludes adapter profile/checkpoint identity. */
function currentTasksContentIdentity(hashes: ArtifactWorkspaceHashesV1): string {
  const entry = hashes.entries.find((candidate) => candidate.path === "tasks.md" && candidate.kind === "file");
  if (!entry) throw new OpenSpecAdapterError("invalid-state", "OpenSpec tasks content identity requires tasks.md");
  return `sha256:${createHash("sha256").update("pi-hive-openspec-tasks-content-v1\0").update(JSON.stringify({ path: entry.path, bytes: entry.bytes, digest: entry.hash })).digest("hex")}`;
}
function repositoryEvidenceCurrent(root: string, reference: Extract<VerifiedArtifactEvidenceV1, { kind: "repository" }>): boolean {
  try {
    if (!reference.path || reference.path.includes("\\") || reference.path.startsWith("/") || reference.path.split("/").some((part) => !part || part === "." || part === "..")) return false;
    const candidate = resolveContainedPath(root, join(root, reference.path));
    if (!candidate?.exists || relative(root, candidate.canonicalPath).split("\\").join("/") !== reference.path) return false;
    const stat = lstatSync(candidate.canonicalPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== reference.bytes || stat.size > 33_554_432) return false;
    return `sha256:${createHash("sha256").update(readFileSync(candidate.canonicalPath)).digest("hex")}` === reference.digest;
  } catch { return false; }
}
function evidenceEntryCurrent(workspace: Readonly<{ projectRoot: string }>, entry: EvidenceEntry): boolean {
  return entry.evidenceRefs.length > 0
    && entry.evidenceRefs.some((reference) => reference.kind === "repository")
    && entry.evidenceRefs.some((reference) => reference.kind === "tool" || reference.kind === "command")
    && entry.evidenceRefs.every((reference) => reference.kind !== "repository" || repositoryEvidenceCurrent(workspace.projectRoot, reference));
}
interface ValidationResult { readonly passed: boolean; readonly failed: number; readonly issues: readonly Readonly<{ level: string; path: string; message: string }>[] }
function validationResult(value: unknown): ValidationResult {
  if (!plainRecord(value) || !plainRecord(value.summary) || !plainRecord(value.summary.totals)) throw new OpenSpecAdapterError("invalid-json", "OpenSpec validation response has an invalid shape");
  const rawFailed = Number(value.summary.totals.failed);
  if (!Number.isSafeInteger(rawFailed) || rawFailed < 0) throw new OpenSpecAdapterError("invalid-json", "OpenSpec validation totals are invalid");
  const issues: Array<Readonly<{ level: string; path: string; message: string }>> = [];
  if (value.items !== undefined && !Array.isArray(value.items)) throw new OpenSpecAdapterError("invalid-json", "OpenSpec validation items are invalid");
  for (const item of (value.items ?? []) as unknown[]) {
    if (!plainRecord(item) || (item.issues !== undefined && !Array.isArray(item.issues))) throw new OpenSpecAdapterError("invalid-json", "OpenSpec validation issue collection is invalid");
    for (const issue of (item.issues ?? []) as unknown[]) {
      if (!plainRecord(issue)) throw new OpenSpecAdapterError("invalid-json", "OpenSpec validation issue is invalid");
      issues.push(Object.freeze({
        level: boundedText(String(issue.level ?? "ERROR"), "OpenSpec validation issue level", 64),
        path: utf8Prefix(String(issue.path ?? ""), 256),
        message: utf8Prefix(String(issue.message ?? ""), 1_024),
      }));
      if (issues.length >= OPEN_SPEC_LIMITS.validationIssues) break;
    }
    if (issues.length >= OPEN_SPEC_LIMITS.validationIssues) break;
  }
  return Object.freeze({ passed: rawFailed === 0, failed: rawFailed, issues: Object.freeze(issues) });
}
async function validateChange(cli: OpenSpecCli, root: string, id: string, signal?: AbortSignal): Promise<ValidationResult> {
  return validationResult(await cli.runJson(root, ["validate", id, "--type", "change", "--json"], { allowNonZero: true, ...(signal ? { signal } : {}) }));
}
function actionResult(context: ArtifactActionContext, actionId: string, summary: string, changed: boolean, data: Readonly<Record<string, JsonValue>>, refs: ArtifactActionResultV1["refs"] = Object.freeze([])): ArtifactActionResultV1 {
  const hash = context.binding.path ? hashArtifactWorkspace(context.binding.path).workspaceHash : context.binding.workspaceHash;
  return Object.freeze({
    schemaVersion: ARTIFACT_ACTION_VERSION,
    operationId: context.operationId,
    actionId,
    status: "completed",
    summary,
    changed,
    ...(hash ? { workspaceHash: hash } : {}),
    data: Object.freeze(data),
    refs,
  });
}
function available(action: ArtifactActionContract, capabilities: ArtifactStatusContext["capabilities"]): boolean {
  return action.requiredCapabilities.every((capability) => capabilities.includes(capability));
}
function pageOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^openspec-status-v1:(0|[1-9][0-9]{0,8})$/u.exec(cursor);
  if (!match) throw new OpenSpecAdapterError("invalid-state", "OpenSpec status cursor is invalid");
  return Number(match[1]);
}

export function createOpenSpecAdapter(input: Readonly<{ cli?: OpenSpecCli; now?: () => string }> = {}): ArtifactAdapter & { readonly profiles: typeof PROFILE_LIST } {
  const cli = input.cli ?? createOpenSpecCli();
  const now = input.now ?? (() => new Date().toISOString());
  const adapter: ArtifactAdapter & { readonly profiles: typeof PROFILE_LIST } = {
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    id: "openspec",
    version: OPEN_SPEC_ADAPTER_VERSION,
    profiles: PROFILE_LIST,
    workspaceLifecycle: {
      create(request) {
        const root = requireReadyProject(request.projectRoot, cli);
        const id = changeId(request.workspaceId);
        if (Object.keys(request.options).length) throw new OpenSpecAdapterError("invalid-state", "OpenSpec options contain unknown fields");
        const target = candidateWorkspace(root, id, true)!;
        if (existsSync(target)) throw new OpenSpecAdapterError("invalid-state", `OpenSpec change ${id} already exists`);
        cli.runSync(root, ["new", "change", id]);
        const created = candidateWorkspace(root, id);
        if (!created) throw new OpenSpecAdapterError("invalid-state", `OpenSpec scaffold for ${id} did not produce one contained change workspace`);
        return Object.freeze({ id, path: created });
      },
      resolve(request) {
        const root = requireReadyProject(request.projectRoot, cli);
        if (Object.keys(request.options).length) throw new OpenSpecAdapterError("invalid-state", "OpenSpec options contain unknown fields");
        const id = changeId(request.workspaceId);
        const path = candidateWorkspace(root, id);
        return path ? Object.freeze({ id, path }) : undefined;
      },
      list(request) {
        const root = requireReadyProject(request.projectRoot, cli);
        if (Object.keys(request.options).length) throw new OpenSpecAdapterError("invalid-state", "OpenSpec options contain unknown fields");
        const changesRoot = join(root, "openspec", "changes");
        const ids = readdirSync(changesRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && CHANGE_ID_RE.test(entry.name) && candidateWorkspace(root, entry.name))
          .map((entry) => entry.name)
          .sort();
        const offset = decodeCursor(request.cursor);
        if (offset > ids.length) throw new OpenSpecAdapterError("invalid-state", "OpenSpec workspace cursor is stale");
        const selected = ids.slice(offset, offset + request.limit);
        return Object.freeze({
          items: Object.freeze(selected.map((id) => Object.freeze({ id, label: id, summary: "Exact OpenSpec change workspace" }))),
          ...(offset + selected.length < ids.length ? { nextCursor: `openspec-v1:${offset + selected.length}` } : {}),
        });
      },
      validateHandoffReference(request) {
        try {
          if (request.reference.workspaceId !== request.workspace.id || !OPEN_SPEC_CHECKPOINT_IDS.includes(request.reference.checkpoint as never)) return Object.freeze({ state: "incompatible" as const, reason: "handoff identity/checkpoint is incompatible with OpenSpec" });
          const targetProfile = PROFILE_LIST.find((entry) => entry.id === request.profileId);
          if (!targetProfile?.checkpointIds.includes(request.reference.checkpoint)) return Object.freeze({ state: "incompatible" as const, reason: "target OpenSpec profile does not publish the handoff checkpoint" });
          // A handoff carries source-profile evidence. Recompute every compatible
          // built-in source profile identity; the target profile still creates
          // and approves its own independently versioned checkpoint digest.
          const currentDigests = PROFILE_LIST.filter((entry) => entry.checkpointIds.includes(request.reference.checkpoint)).map((sourceProfile) => {
            const binding: ArtifactWorkspaceBinding = Object.freeze({
              schemaVersion: 1, contractVersion: ARTIFACT_CONTRACT_VERSION, adapterId: "openspec", adapterVersion: OPEN_SPEC_ADAPTER_VERSION,
              profileId: sourceProfile.id, profileVersion: sourceProfile.version, binding: "existing", selection: "existing",
              workspace: Object.freeze({ id: request.workspace.id, kind: "physical" as const }), path: request.workspace.path,
              workspaceHash: request.hashes.workspaceHash, writerLease: Object.freeze({ required: true }), checkpointIds: sourceProfile.checkpointIds,
              actionIds: Object.freeze(sourceProfile.actions.map((action) => action.id)),
            });
            return resolveCheckpointDigest(descriptor({ binding, checkpointId: request.reference.checkpoint, hashes: request.hashes }), request.hashes).digest;
          });
          return currentDigests.includes(request.reference.digest) ? Object.freeze({ state: "valid" as const }) : Object.freeze({ state: "stale" as const, reason: "OpenSpec checkpoint digest changed" });
        } catch (error) {
          return Object.freeze({ state: "stale" as const, reason: String(error instanceof Error ? error.message : error).slice(0, 2_048) });
        }
      },
    },
    bind() { throw new OpenSpecAdapterError("invalid-state", "OpenSpec physical workspaces bind through the common workspace lifecycle"); },
    async status(context: ArtifactStatusContext, page: ArtifactStatusPageRequest): Promise<ArtifactStatusViewV1> {
      const workspace = workspaceRoot(context.binding);
      requireReadyProject(workspace.projectRoot, cli);
      const profile = PROFILE_LIST.find((entry) => entry.id === context.binding.profileId);
      if (!profile || !context.hashes) throw new OpenSpecAdapterError("invalid-state", "OpenSpec status requires its active profile and fresh workspace hash");
      const validation = await validateChange(cli, workspace.projectRoot, workspace.changeId, context.signal);
      const evidence = readEvidence(workspace.path, workspace.changeId);
      const tasks = plannedTasks(workspace.path);
      const taskContentIdentity = artifactPresent(workspace.path, "tasks") ? currentTasksContentIdentity(context.hashes) : undefined;
      const graphItems = GRAPH.map((entry) => {
        const present = artifactPresent(workspace.path, entry.id);
        const dependenciesReady = entry.dependencies.every((dependency) => artifactPresent(workspace.path, dependency));
        return Object.freeze({ id: entry.id, kind: "artifact", label: entry.label, state: present ? "complete" : dependenciesReady ? "ready" : "blocked", summary: present ? "Authored" : dependenciesReady ? "Ready to author" : `Requires ${entry.dependencies.join(", ")}` });
      });
      const taskItems = tasks.map((task) => {
        const entry = evidence.tasks[task.taskId];
        const complete = Boolean(entry && entry.taskText === task.text && evidence.tasksContentIdentity === taskContentIdentity && evidenceEntryCurrent(workspace, entry));
        return Object.freeze({ id: `task:${task.taskId}`, kind: "execution-task", label: utf8Prefix(task.text, 512), state: complete ? "complete" : "pending", summary: complete ? `${entry!.evidenceRefs.length} verified evidence reference(s)` : "Current verified implementation evidence required" });
      });
      const allItems = [...graphItems, ...taskItems];
      const offset = pageOffset(page.cursor);
      if (offset > allItems.length) throw new OpenSpecAdapterError("invalid-state", "OpenSpec status cursor is stale");
      const items = Object.freeze(allItems.slice(offset, offset + page.limit));
      const checkpoints = Object.freeze(profile.checkpointIds.map((checkpointId) => {
        try {
          const resolved = resolveCheckpointDigest(descriptor({ binding: context.binding, checkpointId, hashes: context.hashes! }), context.hashes!);
          return Object.freeze({ id: checkpointId, state: "ready" as const, digest: resolved.digest });
        } catch { return Object.freeze({ id: checkpointId, state: "pending" as const }); }
      }));
      const authorDone = GRAPH.every((entry) => artifactPresent(workspace.path, entry.id)) && validation.passed;
      const executionDone = tasks.length > 0 && tasks.every((task) => {
        const entry = evidence.tasks[task.taskId];
        return evidence.tasksContentIdentity === taskContentIdentity && entry?.taskText === task.text && evidenceEntryCurrent(workspace, entry);
      });
      const profileComplete = profile.id === "author" ? authorDone : profile.id === "lifecycle" ? authorDone && executionDone : executionDone && validation.passed;
      const blocked = !validation.passed || graphItems.some((entry) => entry.state === "blocked");
      return Object.freeze({
        schemaVersion: ARTIFACT_VIEW_VERSION,
        contractVersion: ARTIFACT_CONTRACT_VERSION,
        adapter: Object.freeze({ id: "openspec", version: OPEN_SPEC_ADAPTER_VERSION }),
        profile: Object.freeze({ id: profile.id, version: profile.version }),
        workspace: Object.freeze({ id: workspace.changeId, kind: "physical" as const, binding: context.binding.binding, path: workspace.path, hash: context.hashes.workspaceHash }),
        status: profileComplete ? "complete" as const : blocked ? "blocked" as const : "ready" as const,
        summary: profileComplete ? "OpenSpec profile completion requirements are satisfied." : validation.passed ? "OpenSpec change is current; use the available artifact actions for the exact bound workspace." : `OpenSpec validation reports ${validation.failed} failure(s).`,
        checkpoints,
        actions: Object.freeze(profile.actions.map((action) => Object.freeze({ id: action.id, label: action.label, available: available(action, context.capabilities), ...(!available(action, context.capabilities) ? { reason: `Requires artifact.${action.requiredCapabilities.join("+")}` } : {}) }))),
        items,
        page: Object.freeze({ limit: page.limit, ...(page.cursor ? { cursor: page.cursor } : {}), ...(offset + items.length < allItems.length ? { nextCursor: `openspec-status-v1:${offset + items.length}` } : {}) }),
        refs: Object.freeze(checkpoints.filter((entry): entry is Readonly<{ id: string; state: "ready"; digest: string }> => "digest" in entry).map((entry) => Object.freeze({ id: entry.id, kind: "checkpoint", digest: entry.digest }))),
      });
    },
    async executeAction(context: ArtifactActionContext, action: ArtifactActionContract, argumentsValue: Readonly<Record<string, JsonValue>>): Promise<ArtifactActionResultV1> {
      const workspace = workspaceRoot(context.binding);
      requireReadyProject(workspace.projectRoot, cli);
      const profile = PROFILE_LIST.find((entry) => entry.id === context.binding.profileId);
      if (!profile?.actions.includes(action)) throw new OpenSpecAdapterError("invalid-state", "OpenSpec action is not published by the active profile");
      if (action.id === OPEN_SPEC_ACTION_IDS[0]) {
        const id = argumentsValue.artifactId as OpenSpecArtifactId;
        const content = readArtifact(workspace.path, id);
        return actionResult(context, action.id, content ? `Read ${id}.` : `${id} is not authored.`, false, { artifactId: id, content });
      }
      if (action.id === OPEN_SPEC_ACTION_IDS[1]) {
        const id = argumentsValue.artifactId as OpenSpecArtifactId;
        const definition = GRAPH.find((entry) => entry.id === id)!;
        const missing = definition.dependencies.filter((dependency) => !artifactPresent(workspace.path, dependency));
        if (missing.length) throw new OpenSpecAdapterError("invalid-state", `OpenSpec ${id} is blocked by ${missing.join(", ")}`);
        const relativePath = id === "specs" ? `specs/${String(argumentsValue.capabilityId)}/spec.md` : `${id}.md`;
        const content = boundedText(argumentsValue.content, `OpenSpec ${id} content`, OPEN_SPEC_LIMITS.artifactBytes);
        await context.enqueueMutation(relativePath, () => atomicWrite(join(workspace.path, relativePath), content.endsWith("\n") ? content : `${content}\n`));
        return actionResult(context, action.id, `Wrote ${id} in the exact bound OpenSpec change.`, true, { artifactId: id, path: relativePath });
      }
      if (action.id === OPEN_SPEC_ACTION_IDS[2]) {
        const result = await validateChange(cli, workspace.projectRoot, workspace.changeId, context.signal);
        return actionResult(context, action.id, result.passed ? "OpenSpec validation passed." : `OpenSpec validation found ${result.failed} failure(s).`, false, { passed: result.passed, failed: result.failed, issues: result.issues as unknown as JsonValue });
      }
      if (action.id === OPEN_SPEC_ACTION_IDS[3]) {
        const hashes = hashArtifactWorkspace(workspace.path);
        const contentIdentity = artifactPresent(workspace.path, "tasks") ? currentTasksContentIdentity(hashes) : "";
        const evidence = readEvidence(workspace.path, workspace.changeId);
        const allTasks = plannedTasks(workspace.path);
        const rawCursor = argumentsValue.cursor;
        const cursorMatch = rawCursor === undefined ? undefined : /^openspec-tasks-v1:(0|[1-9][0-9]{0,8})$/u.exec(String(rawCursor));
        if (rawCursor !== undefined && !cursorMatch) throw new OpenSpecAdapterError("invalid-state", "OpenSpec task cursor is invalid");
        const offset = cursorMatch ? Number(cursorMatch[1]) : 0;
        if (offset > allTasks.length) throw new OpenSpecAdapterError("invalid-state", "OpenSpec task cursor is stale");
        const limit = argumentsValue.limit === undefined ? 20 : Number(argumentsValue.limit);
        const tasks = allTasks.slice(offset, offset + limit).map((task) => {
          const entry = evidence.tasks[task.taskId];
          const completed = evidence.tasksContentIdentity === contentIdentity && entry?.taskText === task.text && evidenceEntryCurrent(workspace, entry);
          return { taskId: task.taskId, text: task.text, completed, ...(entry ? { evidenceRefCount: entry.evidenceRefs.length } : {}) };
        });
        const completed = allTasks.filter((task) => {
          const entry = evidence.tasks[task.taskId];
          return evidence.tasksContentIdentity === contentIdentity && entry?.taskText === task.text && evidenceEntryCurrent(workspace, entry);
        }).length;
        return actionResult(context, action.id, `${completed}/${allTasks.length} OpenSpec tasks have current evidence.`, false, { tasks, total: allTasks.length, ...(offset + tasks.length < allTasks.length ? { nextCursor: `openspec-tasks-v1:${offset + tasks.length}` } : {}) });
      }
      if (action.id === OPEN_SPEC_ACTION_IDS[4]) {
        const taskId = String(argumentsValue.taskId);
        const task = plannedTasks(workspace.path).find((entry) => entry.taskId === taskId);
        if (!task) throw new OpenSpecAdapterError("invalid-state", `OpenSpec task ${taskId} does not exist in the exact current tasks artifact`);
        const hashes = hashArtifactWorkspace(workspace.path);
        const tasksContentIdentity = currentTasksContentIdentity(hashes);
        const prior = readEvidence(workspace.path, workspace.changeId);
        const retained = prior.tasksContentIdentity === tasksContentIdentity ? prior.tasks : {};
        if (!context.verifyEvidence) throw new OpenSpecAdapterError("invalid-state", "OpenSpec task completion requires package-issued W13/repository evidence verification");
        if (!Array.isArray(argumentsValue.evidenceRefs)) throw new OpenSpecAdapterError("invalid-state", "OpenSpec task evidence references failed their strict schema");
        const requested = argumentsValue.evidenceRefs as unknown as readonly ArtifactEvidenceReferenceV1[];
        const evidenceRefs = Object.freeze([...context.verifyEvidence(requested)]);
        if (!evidenceRefs.length || !evidenceRefs.some((reference) => reference.kind === "repository")
          || !evidenceRefs.some((reference) => reference.kind === "tool" || reference.kind === "command")
          || evidenceRefs.some((reference) => !verifiedEvidenceRef(reference))) {
          throw new OpenSpecAdapterError("invalid-state", "OpenSpec task completion requires verified W13 tool/command evidence and current repository hashes");
        }
        const next: EvidenceState = Object.freeze({
          schemaVersion: 1, adapterVersion: OPEN_SPEC_ADAPTER_VERSION, changeId: workspace.changeId, tasksContentIdentity,
          tasks: Object.freeze({ ...retained, [taskId]: Object.freeze({ taskId, taskText: task.text, operationId: context.operationId, evidenceRefs, completedAt: now() }) }),
        });
        boundedJson(next as unknown as JsonValue, "OpenSpec execution evidence", { bytes: OPEN_SPEC_LIMITS.sidecarBytes, depth: 12, nodes: 2_048 });
        await context.enqueueMutation(EVIDENCE_PATH, () => atomicWrite(join(workspace.path, EVIDENCE_PATH), `${JSON.stringify(next, null, 2)}\n`));
        return actionResult(context, action.id, `Recorded current verified implementation evidence for OpenSpec task ${taskId}.`, true, { taskId, tasksContentIdentity, evidenceRefCount: evidenceRefs.length });
      }
      if (action.id === OPEN_SPEC_ACTION_IDS[5]) {
        const hashes = hashArtifactWorkspace(workspace.path);
        const validation = await validateChange(cli, workspace.projectRoot, workspace.changeId, context.signal);
        const review = resolveCheckpointDigest(descriptor({ binding: context.binding, checkpointId: "review", hashes }), hashes);
        const evidence = readEvidence(workspace.path, workspace.changeId);
        const tasks = plannedTasks(workspace.path);
        const contentIdentity = currentTasksContentIdentity(hashes);
        const complete = tasks.filter((task) => {
          const entry = evidence.tasks[task.taskId];
          return entry?.taskText === task.text && evidence.tasksContentIdentity === contentIdentity && evidenceEntryCurrent(workspace, entry);
        }).map((task) => task.taskId);
        return actionResult(context, action.id, "Inspected adapter-owned implementation evidence; human checkpoint decisions remain outside this action.", false, {
          reviewDigest: review.digest, validation: { passed: validation.passed, failed: validation.failed }, taskCount: tasks.length, completedTaskIds: complete,
        }, Object.freeze(review.contributors.map((contributor, index) => Object.freeze({ id: `review:${index}`, kind: contributor.kind, digest: contributor.digest, ...(contributor.kind === "file" ? { bytes: contributor.bytes } : {}) }))));
      }
      throw new OpenSpecAdapterError("invalid-state", "OpenSpec action is unsupported");
    },
    checkpointDescriptor: descriptor,
    reconcileAction(context, action) {
      if (action.id === OPEN_SPEC_ACTION_IDS[4]) {
        const workspace = workspaceRoot(context.binding);
        const evidence = readEvidence(workspace.path, workspace.changeId);
        const entry = Object.values(evidence.tasks).find((candidate) => candidate.operationId === context.operation.operationId);
        if (entry) return Object.freeze({ state: "applied" as const, result: actionResult({ ...context, operationId: context.operation.operationId, capabilities: [], enqueueMutation: async () => { throw new Error("recovery does not mutate"); } }, action.id, `Recorded current verified implementation evidence for OpenSpec task ${entry.taskId}.`, true, { taskId: entry.taskId, tasksContentIdentity: evidence.tasksContentIdentity, evidenceRefCount: entry.evidenceRefs.length }) });
      }
      return Object.freeze({ state: "unknown" as const, diagnostic: `OpenSpec cannot prove interrupted ${action.id} from current adapter-owned state` });
    },
    async validateCompletion(binding: ArtifactWorkspaceBinding): Promise<ArtifactCompletionResult> {
      try {
        const workspace = workspaceRoot(binding);
        requireReadyProject(workspace.projectRoot, cli);
        const profile = PROFILE_LIST.find((entry) => entry.id === binding.profileId);
        if (!profile) throw new OpenSpecAdapterError("invalid-state", "OpenSpec completion profile is unknown");
        const validation = await validateChange(cli, workspace.projectRoot, workspace.changeId);
        const issues: string[] = [];
        const missingArtifacts = GRAPH.filter((entry) => !artifactPresent(workspace.path, entry.id)).map((entry) => entry.id);
        if ((profile.id === "author" || profile.id === "lifecycle") && missingArtifacts.length) issues.push(`missing OpenSpec artifacts: ${missingArtifacts.join(", ")}`);
        if (!validation.passed) issues.push(`OpenSpec validation has ${validation.failed} failure(s)`);
        if (profile.id !== "author") {
          const tasks = plannedTasks(workspace.path);
          if (!tasks.length) issues.push("OpenSpec tasks contain no stable executable task IDs");
          else {
            const hashes = hashArtifactWorkspace(workspace.path);
            const contentIdentity = currentTasksContentIdentity(hashes);
            const evidence = readEvidence(workspace.path, workspace.changeId);
            if (evidence.tasksContentIdentity !== contentIdentity) issues.push("OpenSpec implementation evidence is stale because the profile-neutral tasks content identity changed");
            const incomplete = tasks.filter((task) => {
              const entry = evidence.tasks[task.taskId];
              return entry?.taskText !== task.text || !evidenceEntryCurrent(workspace, entry);
            }).map((task) => task.taskId);
            if (incomplete.length) issues.push(`OpenSpec implementation evidence or current repository hashes are missing/stale for tasks: ${incomplete.join(", ")}`);
          }
        }
        return issues.length ? Object.freeze({ state: "unsatisfied" as const, issues: Object.freeze(issues.slice(0, 128)) }) : Object.freeze({ state: "satisfied" as const });
      } catch (error) {
        return Object.freeze({ state: "unsatisfied" as const, issues: Object.freeze([String(error instanceof Error ? error.message : error).slice(0, 2_048)]) });
      }
    },
  };
  return Object.freeze(adapter);
}

export const OPEN_SPEC_ARTIFACT_ADAPTER = createOpenSpecAdapter();
