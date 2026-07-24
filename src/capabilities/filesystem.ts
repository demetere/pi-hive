import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { isPathInside, resolveCanonicalPath, resolveProjectPath } from "../core/safe-path";
import { compileFilesystemGlobList, matchFilesystemGlob, normalizeFilesystemRelativePath, type CompiledFilesystemGlob } from "./glob";
import { DEFAULT_PROTECTED_PATHS, checkProtectedPath, type ProtectedPathKind, type ProtectedPathRoot } from "./reserved-paths";
import type { EffectiveNodePolicy, FilesystemOperation, NormalizedFilesystemGrant } from "./types";
import type { MutationAccountingRecorder, MutationIntent } from "../workflows/change-accounting";
import type { AttemptRuntime } from "../workflows/attempts";
import { BUILTIN_ARTIFACT_REGISTRY, type ResolvedArtifactProfile } from "../artifacts/registry";

const MAX_TOOL_PATHS = 32;
const MAX_DIAGNOSTIC_BYTES = 2_048;
const MAX_HASH_BYTES = 32 * 1024 * 1024;

interface CompiledGrant {
  readonly sourcePath: string;
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly operations: ReadonlySet<FilesystemOperation>;
  readonly include: readonly CompiledFilesystemGlob[];
  readonly exclude: readonly CompiledFilesystemGlob[];
  readonly ceilingClause: number;
}
export interface CompiledFilesystemPolicy {
  readonly projectRoot: string;
  readonly lexicalProjectRoot: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly grants: readonly CompiledGrant[];
  readonly secretPaths: readonly string[];
  readonly additionalProtectedRoots: readonly ProtectedPathRoot[];
}
export interface CompileFilesystemPolicyInput {
  readonly projectRoot: string;
  readonly effectivePolicy: EffectiveNodePolicy;
  readonly secretPaths?: readonly string[];
  readonly additionalProtectedRoots?: readonly ProtectedPathRoot[];
  /** Resolved activation/runtime selection; its adapter roots cannot be omitted by callers. */
  readonly artifact?: Readonly<{ resolved: ResolvedArtifactProfile; options: unknown }>;
  readonly platform?: NodeJS.Platform;
}

export type FilesystemDecisionCode = "FILESYSTEM_TARGET_INVALID" | "FILESYSTEM_EXISTENCE_MISMATCH" | "FILESYSTEM_PROTECTED" | "FILESYSTEM_SCOPE_DENIED";
export interface FilesystemAuthorizationRequest { readonly operation: FilesystemOperation; readonly path: string; readonly recursive?: true }
export interface FilesystemAuthorizationDecision {
  readonly ok: boolean;
  readonly code?: FilesystemDecisionCode;
  readonly reason: string;
  /** Harness-only canonical target. Agent-facing adapters must return `reason`, never this field. */
  readonly targetPath?: string;
  /** Harness-only lexical target preserving symlink mutation semantics. */
  readonly mutationPath?: string;
  readonly exists?: boolean;
  readonly ceilingClause?: number;
}

function clipped(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_DIAGNOSTIC_BYTES) return value;
  let result = value;
  while (Buffer.byteLength(`${result}…`, "utf8") > MAX_DIAGNOSTIC_BYTES) result = result.slice(0, -1);
  return `${result}…`;
}
function deny(policy: CompiledFilesystemPolicy, request: FilesystemAuthorizationRequest, code: FilesystemDecisionCode, detail: string): FilesystemAuthorizationDecision {
  return Object.freeze({ ok: false, code, reason: clipped(`Filesystem ${request.operation} denied for ${policy.workflowId}/${policy.nodeId}: ${detail}.`) });
}

function canonicalGrant(projectRoot: string, grant: NormalizedFilesystemGrant): CompiledGrant {
  const sourcePath = grant.path.normalize("NFC");
  const relativePath = sourcePath === "." ? "." : normalizeFilesystemRelativePath(sourcePath);
  const target = resolveProjectPath(projectRoot, relativePath, { allowMissing: true });
  if (!target) throw new Error("FILESYSTEM_SCOPE_INVALID");
  return Object.freeze({
    sourcePath: relativePath,
    lexicalPath: target.lexicalPath,
    canonicalPath: target.canonicalPath,
    operations: Object.freeze(new Set(grant.operations)),
    include: compileFilesystemGlobList(grant.include),
    exclude: compileFilesystemGlobList(grant.exclude),
    ceilingClause: grant.ceilingClause,
  });
}

export function assertFilesystemPlatformSupported(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "linux" && platform !== "darwin") throw new Error(`FILESYSTEM_PLATFORM_UNSUPPORTED: pi-hive workflow runtimes require Linux or macOS (current platform: ${platform})`);
}

export function compileFilesystemPolicy(input: CompileFilesystemPolicyInput): CompiledFilesystemPolicy {
  assertFilesystemPlatformSupported(input.platform);
  const lexicalProjectRoot = resolve(input.projectRoot);
  const canonical = resolveCanonicalPath(lexicalProjectRoot);
  if (!canonical || !canonical.exists || !statSync(canonical.canonicalPath).isDirectory()) throw new Error("FILESYSTEM_PROJECT_ROOT_INVALID");
  const grants = input.effectivePolicy.capabilities.filesystem.map((grant) => canonicalGrant(lexicalProjectRoot, grant));
  const artifactRoots = (() => {
    if (!input.artifact) return Object.freeze([]) as readonly ProtectedPathRoot[];
    const { resolved } = input.artifact;
    const options = BUILTIN_ARTIFACT_REGISTRY.validateOptions(resolved.profile, input.artifact.options);
    return Object.freeze([...(resolved.adapter.protectedWorkspaceRoots?.({ projectRoot: canonical.canonicalPath, profile: resolved.profile, options }) ?? [])]);
  })();
  return Object.freeze({
    projectRoot: canonical.canonicalPath,
    lexicalProjectRoot,
    workflowId: input.effectivePolicy.workflowId,
    nodeId: input.effectivePolicy.nodeId,
    grants: Object.freeze(grants),
    secretPaths: Object.freeze([...(input.secretPaths ?? [])]),
    additionalProtectedRoots: Object.freeze([...(input.additionalProtectedRoots ?? []), ...artifactRoots]),
  });
}

function grantMatches(grant: CompiledGrant, target: { lexicalPath: string; canonicalPath: string }, operation: FilesystemOperation): boolean {
  if (!grant.operations.has(operation)) return false;
  if (!isPathInside(grant.lexicalPath, target.lexicalPath) || !isPathInside(grant.canonicalPath, target.canonicalPath)) return false;
  const relativeTarget = relative(grant.lexicalPath, target.lexicalPath).split(sep).join("/") || ".";
  let normalized: string;
  try { normalized = normalizeFilesystemRelativePath(relativeTarget); } catch { return false; }
  if (grant.exclude.some((pattern) => matchFilesystemGlob(pattern, normalized))) return false;
  return grant.include.length === 0 || grant.include.some((pattern) => matchFilesystemGlob(pattern, normalized));
}

export function recursiveFilesystemEffectProtectedKind(policy: CompiledFilesystemPolicy, requestedPath: string): ProtectedPathKind | undefined {
  const candidate = resolveProjectPath(policy.lexicalProjectRoot, requestedPath, { allowMissing: true });
  if (!candidate) return "project-boundary";
  const roots: ProtectedPathRoot[] = [...DEFAULT_PROTECTED_PATHS, ...policy.additionalProtectedRoots];
  for (const secret of policy.secretPaths) {
    if (!secret || (secret.startsWith("/") && !isPathInside(policy.projectRoot, secret))) continue;
    roots.push({ path: relative(policy.projectRoot, resolve(policy.projectRoot, secret)).split(sep).join("/"), kind: "credential-secret" });
  }
  for (const root of roots) {
    if (!root.path || root.path.startsWith("/")) continue;
    const protectedLexical = resolve(policy.lexicalProjectRoot, root.path);
    const protectedCanonical = resolveProjectPath(policy.lexicalProjectRoot, root.path, { allowMissing: true });
    if (isPathInside(candidate.lexicalPath, protectedLexical)
      || Boolean(protectedCanonical && isPathInside(candidate.canonicalPath, protectedCanonical.canonicalPath))) return root.kind;
  }
  return undefined;
}

export function authorizeFilesystemOperation(policy: CompiledFilesystemPolicy, request: FilesystemAuthorizationRequest): FilesystemAuthorizationDecision {
  if (!request || !(["read", "create", "update", "delete"] as readonly string[]).includes(request.operation)
    || typeof request.path !== "string" || !request.path || Buffer.byteLength(request.path, "utf8") > 4_096 || request.path.includes("\0")) {
    return deny(policy, request ?? { operation: "read", path: "" }, "FILESYSTEM_TARGET_INVALID", "invalid bounded target");
  }
  const target = resolveProjectPath(policy.lexicalProjectRoot, request.path, { allowMissing: request.operation === "create" });
  if (!target) return deny(policy, request, "FILESYSTEM_TARGET_INVALID", "target is not canonically contained in the project");
  if ((request.operation === "create" && target.exists) || (request.operation !== "create" && !target.exists)) {
    return deny(policy, request, "FILESYSTEM_EXISTENCE_MISMATCH", request.operation === "create" ? "target already exists" : "target does not exist");
  }
  const reservation = checkProtectedPath(policy.lexicalProjectRoot, request.path, {
    allowMissing: request.operation === "create",
    secretPaths: policy.secretPaths,
    additionalRoots: policy.additionalProtectedRoots,
  });
  if (reservation.protected) return deny(policy, request, "FILESYSTEM_PROTECTED", `protected ${reservation.kind ?? "subsystem"} path`);
  const grant = policy.grants.find((candidate) => grantMatches(candidate, target, request.operation));
  if (!grant) return deny(policy, request, "FILESYSTEM_SCOPE_DENIED", "no effective scope permits the operation (includes must match and exclusions win)");
  return Object.freeze({
    ok: true,
    reason: clipped(`Filesystem ${request.operation} authorized for ${policy.workflowId}/${policy.nodeId} by ceiling clause ${grant.ceilingClause}.`),
    targetPath: target.canonicalPath,
    mutationPath: target.lexicalPath,
    exists: target.exists,
    ceilingClause: grant.ceilingClause,
  });
}

function extractPaths(toolName: string, input: unknown): string[] {
  const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const values: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) values.push(value.trim());
    else if (Array.isArray(value)) for (const item of value) add(item);
  };
  for (const key of ["path", "paths", "file", "files", "filename", "directory"]) add(record[key]);
  if (["grep", "find", "ls"].includes(toolName) && values.length === 0) values.push(".");
  const unique = [...new Set(values)];
  if (unique.length > MAX_TOOL_PATHS) throw new Error("FILESYSTEM_TOOL_INPUT_LIMIT_EXCEEDED");
  return unique;
}

export function classifyFilesystemToolCall(toolName: string, input: unknown, policy: CompiledFilesystemPolicy): FilesystemAuthorizationRequest[] {
  const paths = extractPaths(toolName, input);
  if (["read", "write", "edit", "delete"].includes(toolName) && paths.length === 0) throw new Error("FILESYSTEM_TOOL_TARGET_REQUIRED");
  if (["grep", "find"].includes(toolName)) return paths.map((path) => ({ operation: "read", path, recursive: true }));
  if (["read", "ls"].includes(toolName)) return paths.map((path) => ({ operation: "read", path }));
  if (toolName === "edit") return paths.map((path) => ({ operation: "update", path }));
  if (toolName === "delete") return paths.map((path) => ({ operation: "delete", path }));
  if (toolName === "write") return paths.map((path) => {
    const resolved = resolveProjectPath(policy.lexicalProjectRoot, path, { allowMissing: true });
    return { operation: resolved?.exists ? "update" : "create", path };
  });
  return [];
}

export function createFilesystemPolicyHook(policy: CompiledFilesystemPolicy): (event: { toolName?: unknown; input?: unknown }) => Promise<{ block: true; reason: string } | undefined> {
  return async (event) => {
    try {
      for (const request of classifyFilesystemToolCall(String(event.toolName ?? ""), event.input, policy)) {
        const decision = authorizeFilesystemOperation(policy, request);
        if (!decision.ok) return { block: true, reason: decision.reason };
        if (request.recursive) {
          const protectedKind = recursiveFilesystemEffectProtectedKind(policy, request.path);
          if (protectedKind) return {
            block: true,
            reason: clipped(`Filesystem recursive read denied for ${policy.workflowId}/${policy.nodeId}: effect intersects a protected ${protectedKind} path.`),
          };
        }
      }
      return undefined;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid tool input";
      return { block: true, reason: clipped(`Filesystem tool call denied for ${policy.workflowId}/${policy.nodeId}: ${detail}.`) };
    }
  };
}

export interface TrustedStatHashResult {
  readonly ok: boolean;
  readonly kind?: "file" | "directory" | "other";
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly sha256?: string;
  readonly code?: "TARGET_INVALID" | "HASH_LIMIT_EXCEEDED" | "INSPECTION_FAILED";
}
export function trustedStatAndHash(projectRoot: string, requestedPath: string): TrustedStatHashResult {
  const target = resolveProjectPath(projectRoot, requestedPath);
  if (!target) return Object.freeze({ ok: false, code: "TARGET_INVALID" });
  let descriptor: number | undefined;
  try {
    // Bind inspection to the already-authorized canonical object. O_NOFOLLOW
    // turns a post-check symlink replacement into a denial instead of hashing a
    // new referent. Content is consumed only by the digest and never returned.
    descriptor = openSync(target.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
    if (!stat.isFile()) return Object.freeze({ ok: true, kind, size: stat.size, mtimeMs: stat.mtimeMs });
    if (stat.size > MAX_HASH_BYTES) return Object.freeze({ ok: false, kind, size: stat.size, mtimeMs: stat.mtimeMs, code: "HASH_LIMIT_EXCEEDED" });
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < stat.size) {
      const bytes = readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (bytes <= 0) throw new Error("short read");
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
    return Object.freeze({ ok: true, kind, size: stat.size, mtimeMs: stat.mtimeMs, sha256: hash.digest("hex") });
  } catch {
    return Object.freeze({ ok: false, code: "INSPECTION_FAILED" });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export type FilesystemMutationQueue = <T>(targetPath: string, task: () => Promise<T>) => Promise<T>;
export interface QueuedMutationResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly decision: FilesystemAuthorizationDecision;
}
export interface QueuedMutationAttemptAccounting {
  readonly runtime: AttemptRuntime; readonly correlationId: string; readonly nodeId: string; readonly operation: string;
  readonly input: unknown;
}
export interface QueuedMutationAccounting {
  readonly attemptId: string;
  readonly recorder: MutationAccountingRecorder;
  readonly attempts?: QueuedMutationAttemptAccounting;
}

function beginQueuedAttemptAccounting(accounting: QueuedMutationAccounting | undefined): void {
  if (!accounting?.attempts) return;
  const begun = accounting.attempts.runtime.begin({
    attemptId: accounting.attemptId, correlationId: accounting.attempts.correlationId, nodeId: accounting.attempts.nodeId,
    operation: accounting.attempts.operation, input: accounting.attempts.input,
    descriptor: { effect: "filesystem", readOnly: false, idempotent: false },
  });
  if (begun.state !== "started") throw new Error(`Queued mutation attempt ${accounting.attemptId} is already unresolved or completed`);
}
function beginImmediateMutationIntent(accounting: QueuedMutationAccounting | undefined, path: string): MutationIntent | undefined {
  if (!accounting) return undefined;
  try { return accounting.recorder.begin(accounting.attemptId, path); }
  catch (error) {
    accounting.attempts?.runtime.fail(accounting.attemptId, Object.assign(error instanceof Error ? error : new Error(String(error)), { effectNotApplied: true }));
    throw error;
  }
}
function resolveQueuedMutationNotApplied(accounting: QueuedMutationAccounting | undefined, path: string, reason: unknown): void {
  accounting?.recorder.notApplied?.(accounting.attemptId, path, String(reason instanceof Error ? reason.message : reason).slice(0, 2_048));
}
function failQueuedMutationAccounting(accounting: QueuedMutationAccounting | undefined, mutationMayHaveRun: boolean, error: unknown): void {
  if (!accounting?.attempts) return;
  const existing = accounting.attempts.runtime.restore().attempts[accounting.attemptId];
  if (existing?.result) return;
  if (mutationMayHaveRun) accounting.attempts.runtime.markUnknown(accounting.attemptId, String(error instanceof Error ? error.message : error).slice(0, 8_192));
  else accounting.attempts.runtime.fail(accounting.attemptId, Object.assign(error instanceof Error ? error : new Error(String(error)), { effectNotApplied: true }));
}

const defaultMutationQueue: FilesystemMutationQueue = async (targetPath, task) => {
  // Keep the Pi runtime dependency lazy so the core policy graph remains
  // loadable on every supported Node line.
  const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
  return withFileMutationQueue(targetPath, task);
};

/**
 * Custom generic mutations must use this boundary. Authorization is performed
 * before admission and again inside Pi's per-file queue immediately before the
 * trusted callback. The second decision closes symlink/existence swaps while a
 * mutation waits for the queue.
 */
export async function runQueuedFilesystemMutation<T>(
  policy: CompiledFilesystemPolicy,
  request: FilesystemAuthorizationRequest,
  mutate: (canonicalTarget: string) => Promise<T>,
  queue: FilesystemMutationQueue = defaultMutationQueue,
  accounting?: QueuedMutationAccounting,
): Promise<QueuedMutationResult<T>> {
  const admitted = authorizeFilesystemOperation(policy, request);
  if (!admitted.ok || !admitted.mutationPath) return Object.freeze({ ok: false, decision: admitted });
  beginQueuedAttemptAccounting(accounting);
  let mutationEntered = false;
  let recorderFailure: unknown;
  try {
    return await queue(admitted.mutationPath, async () => {
      const immediate = authorizeFilesystemOperation(policy, request);
      if (!immediate.ok || !immediate.mutationPath) {
        resolveQueuedMutationNotApplied(accounting, request.path, immediate.reason);
        accounting?.attempts?.runtime.fail(accounting.attemptId, Object.assign(new Error(immediate.reason), { policyDenied: true, effectNotApplied: true }));
        return Object.freeze({ ok: false, decision: immediate });
      }
      const intent = beginImmediateMutationIntent(accounting, request.path);
      mutationEntered = true;
      const value = await mutate(immediate.mutationPath);
      try { if (accounting && intent) accounting.recorder.complete(intent, request.path); }
      catch (error) { recorderFailure = error; failQueuedMutationAccounting(accounting, true, error); throw error; }
      accounting?.attempts?.runtime.complete(accounting.attemptId, { ok: true });
      return Object.freeze({ ok: true, value, decision: immediate });
    });
  } catch (error) {
    if (recorderFailure !== undefined) throw recorderFailure;
    if (!mutationEntered) resolveQueuedMutationNotApplied(accounting, request.path, error);
    failQueuedMutationAccounting(accounting, mutationEntered, error);
    return Object.freeze({ ok: false, decision: deny(policy, request, "FILESYSTEM_TARGET_INVALID", "queued mutation failed closed") });
  }
}

export interface QueuedSubsystemMutationInput<T> {
  readonly projectRoot: string;
  readonly subsystem: "artifact" | "knowledge";
  readonly request: Readonly<{ operation: "create" | "update" | "delete"; path: string }>;
  readonly mutate: (canonicalTarget: string) => Promise<T>;
  readonly queue?: FilesystemMutationQueue;
  readonly accounting?: QueuedMutationAccounting;
  readonly additionalRoots?: readonly ProtectedPathRoot[];
}

function authorizeSubsystemMutation<T>(input: QueuedSubsystemMutationInput<T>): FilesystemAuthorizationDecision {
  const pseudoPolicy: CompiledFilesystemPolicy = Object.freeze({
    projectRoot: resolve(input.projectRoot), lexicalProjectRoot: resolve(input.projectRoot), workflowId: input.subsystem,
    nodeId: "trusted-facade", grants: Object.freeze([]), secretPaths: Object.freeze([]),
    additionalProtectedRoots: Object.freeze([...(input.additionalRoots ?? [])]),
  });
  const target = resolveProjectPath(input.projectRoot, input.request.path, { allowMissing: input.request.operation === "create" });
  if (!target) return deny(pseudoPolicy, input.request, "FILESYSTEM_TARGET_INVALID", "target is not canonically contained in the project");
  if ((input.request.operation === "create" && target.exists) || (input.request.operation !== "create" && !target.exists)) {
    return deny(pseudoPolicy, input.request, "FILESYSTEM_EXISTENCE_MISMATCH", input.request.operation === "create" ? "target already exists" : "target does not exist");
  }
  const reservation = checkProtectedPath(input.projectRoot, input.request.path, {
    allowMissing: input.request.operation === "create", additionalRoots: input.additionalRoots,
  });
  if (!reservation.protected || reservation.kind !== input.subsystem) {
    return deny(pseudoPolicy, input.request, "FILESYSTEM_PROTECTED", `target is not owned by the ${input.subsystem} facade`);
  }
  return Object.freeze({
    ok: true,
    reason: clipped(`Filesystem ${input.request.operation} authorized for ${input.subsystem}/trusted-facade.`),
    targetPath: target.canonicalPath,
    mutationPath: target.lexicalPath,
    exists: target.exists,
  });
}

/** Dedicated protected-path API for artifact and knowledge subsystem writers. */
export async function runQueuedSubsystemMutation<T>(input: QueuedSubsystemMutationInput<T>): Promise<QueuedMutationResult<T>> {
  const admitted = authorizeSubsystemMutation(input);
  if (!admitted.ok || !admitted.mutationPath) return Object.freeze({ ok: false, decision: admitted });
  const queue = input.queue ?? defaultMutationQueue;
  beginQueuedAttemptAccounting(input.accounting);
  let mutationEntered = false;
  let recorderFailure: unknown;
  try {
    return await queue(admitted.mutationPath, async () => {
      const immediate = authorizeSubsystemMutation(input);
      if (!immediate.ok || !immediate.mutationPath) {
        resolveQueuedMutationNotApplied(input.accounting, input.request.path, immediate.reason);
        input.accounting?.attempts?.runtime.fail(input.accounting.attemptId, Object.assign(new Error(immediate.reason), { policyDenied: true, effectNotApplied: true }));
        return Object.freeze({ ok: false, decision: immediate });
      }
      const intent = beginImmediateMutationIntent(input.accounting, input.request.path);
      mutationEntered = true;
      const value = await input.mutate(immediate.mutationPath);
      try { if (input.accounting && intent) input.accounting.recorder.complete(intent, input.request.path); }
      catch (error) { recorderFailure = error; failQueuedMutationAccounting(input.accounting, true, error); throw error; }
      input.accounting?.attempts?.runtime.complete(input.accounting.attemptId, { ok: true });
      return Object.freeze({ ok: true, value, decision: immediate });
    });
  } catch (error) {
    if (recorderFailure !== undefined) throw recorderFailure;
    if (!mutationEntered) resolveQueuedMutationNotApplied(input.accounting, input.request.path, error);
    failQueuedMutationAccounting(input.accounting, mutationEntered, error);
    const pseudo = compileSubsystemFailurePolicy(input.projectRoot, input.subsystem, input.additionalRoots);
    return Object.freeze({ ok: false, decision: deny(pseudo, input.request, "FILESYSTEM_TARGET_INVALID", "queued subsystem mutation failed closed") });
  }
}

function compileSubsystemFailurePolicy(projectRoot: string, subsystem: "artifact" | "knowledge", roots: readonly ProtectedPathRoot[] | undefined): CompiledFilesystemPolicy {
  return Object.freeze({
    projectRoot: resolve(projectRoot), lexicalProjectRoot: resolve(projectRoot), workflowId: subsystem, nodeId: "trusted-facade",
    grants: Object.freeze([]), secretPaths: Object.freeze([]), additionalProtectedRoots: Object.freeze([...(roots ?? [])]),
  });
}
