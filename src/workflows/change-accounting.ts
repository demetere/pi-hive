import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { checkProtectedPath, type ProtectedPathRoot } from "../capabilities/reserved-paths";
import { isTrustedCommandAttemptMetadata, type CommandAttemptMetadata } from "../capabilities/command";
import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";
import { resolveProjectPath } from "../core/safe-path";
import { createWorkflowEvent, sealWorkflowEvent, WORKFLOW_EVENT_LIMITS, type WorkflowEventEnvelope, type WorkflowEventType } from "./events";
import { appendWorkflowEventChecked, readWorkflowJournal } from "./journal";
import { replayWorkflowJournal } from "./replay";
import type { FileChangeRecord, ProjectStateResult } from "./runs";
import { boundedId, boundedText, deepFreeze, plainRecord } from "./values";

const FORMAT_VERSION = 1 as const;
export interface ChangeAccountingLimits { readonly maxFiles: number; readonly maxAggregatePathBytes: number; readonly maxFileBytes: number }
export const CHANGE_ACCOUNTING_LIMITS: ChangeAccountingLimits = Object.freeze({ maxFiles: 2_048, maxAggregatePathBytes: 131_072, maxFileBytes: 33_554_432 });
export type ChangeAccountingMode = "git" | "scoped" | "partial";
interface InventoryEntry { readonly path: string; readonly hash: string; readonly size: number }
interface Inventory { readonly entries: Readonly<Record<string, InventoryEntry>>; readonly partial: boolean; readonly diagnostics: readonly string[] }
export interface PreExistingChange { readonly path: string; readonly status: string; readonly baselineHash?: string }
export interface GitChangeEvidence {
  readonly available: boolean; readonly head?: string; readonly indexHash?: string;
  readonly indexEntries?: Readonly<Record<string, string>>;
  readonly status: readonly PreExistingChange[]; readonly diagnostics: readonly string[]; readonly partial?: boolean;
}
export type MutationPathKind = "file" | "directory";
export interface MutationIntent { readonly attemptId: string; readonly path: string; readonly beforeHash?: string; readonly beforeKind?: MutationPathKind; readonly startedSequence: number }
export interface MutationRecord extends MutationIntent { readonly operation: "create" | "update" | "delete"; readonly afterHash?: string; readonly afterKind?: MutationPathKind; readonly recordedSequence: number }
export interface MutationNotAppliedResolution { readonly attemptId: string; readonly path: string; readonly diagnostic: string; readonly recordedSequence: number }
export interface MutationAccountingRecorder {
  begin(attemptId: string, path: string): MutationIntent;
  complete(intent: MutationIntent, path?: string): MutationRecord;
  notApplied?(attemptId: string, path: string, diagnostic: string): MutationNotAppliedResolution;
}
export interface CommandAccountingAttempt {
  readonly attemptId: string; readonly effect: "shell" | "git"; readonly paths: readonly string[];
  readonly status: "pending" | "completed"; readonly startedSequence: number; readonly recordedSequence?: number;
}
export interface CommandMutationIntent {
  readonly attemptId: string; readonly command: CommandAccountingAttempt; readonly mutations: readonly MutationIntent[];
}
export interface ChangeBaseline {
  readonly mode: ChangeAccountingMode; readonly entries: Readonly<Record<string, InventoryEntry>>; readonly dirty: readonly PreExistingChange[];
  readonly git?: GitChangeEvidence; readonly partial: boolean; readonly diagnostics: readonly string[]; readonly recordedSequence: number;
}
export interface ChangeAccountingState {
  readonly sessionId: string; readonly runId: string; readonly baseline?: ChangeBaseline;
  readonly intents: Readonly<Record<string, MutationIntent>>; readonly mutations: readonly MutationRecord[];
  readonly notApplied: Readonly<Record<string, MutationNotAppliedResolution>>;
  readonly commandAttempts: Readonly<Record<string, CommandAccountingAttempt>>;
}
export interface ChangeAccountingReport extends ProjectStateResult {
  readonly state: "satisfied" | "unsatisfied";
  readonly fileChanges: readonly FileChangeRecord[]; readonly changeCoverage: "recorded" | "git-reconciled" | "scoped-reconciled" | "partial";
  readonly preExistingChanges: readonly PreExistingChange[]; readonly issues: readonly string[]; readonly partial: boolean;
}
export interface ChangeAccountingOptions {
  readonly projectRoot: string; readonly projectId: string; readonly sessionId: string; readonly runId: string;
  readonly now?: () => string; readonly scopes?: readonly string[]; readonly protectedRoots?: readonly ProtectedPathRoot[];
  readonly limits?: Partial<ChangeAccountingLimits>;
}
const CHANGE_EVENTS = new Set<WorkflowEventType>(["change.baseline.recorded", "change.mutation.started", "change.mutation.recorded", "change.mutation.not-applied", "change.command.started", "change.command.recorded"]);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
function normalizedPath(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 4_096 || value.includes("\\") || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Change path is invalid");
  return value;
}
function digest(value: unknown, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error("Change hash is invalid");
  return value;
}
function parseEntries(value: unknown): Readonly<Record<string, InventoryEntry>> {
  if (!plainRecord(value) || Object.keys(value).length > CHANGE_ACCOUNTING_LIMITS.maxFiles) throw new Error("Change inventory is invalid");
  const entries: Record<string, InventoryEntry> = {};
  for (const [key, raw] of Object.entries(value)) {
    const path = normalizedPath(key);
    if (!plainRecord(raw) || raw.path !== path || !Number.isSafeInteger(raw.size) || Number(raw.size) < 0) throw new Error("Change inventory entry is invalid");
    entries[path] = Object.freeze({ path, hash: digest(raw.hash)!, size: Number(raw.size) });
  }
  return deepFreeze(entries);
}
function parseDirty(value: unknown): readonly PreExistingChange[] {
  if (!Array.isArray(value) || value.length > CHANGE_ACCOUNTING_LIMITS.maxFiles) throw new Error("Dirty baseline is invalid");
  return Object.freeze(value.map((raw) => {
    if (!plainRecord(raw)) throw new Error("Dirty baseline entry is invalid");
    return Object.freeze({ path: normalizedPath(raw.path), status: boundedText(raw.status, "Dirty status", 128), ...(raw.baselineHash === undefined ? {} : { baselineHash: digest(raw.baselineHash)! }) });
  }));
}
function parseGitEvidence(value: unknown): GitChangeEvidence | undefined {
  if (value === undefined) return undefined;
  if (!plainRecord(value) || typeof value.available !== "boolean" || !Array.isArray(value.status) || !Array.isArray(value.diagnostics)) throw new Error("Git change evidence is invalid");
  const head = value.head === undefined ? undefined : boundedText(value.head, "Git HEAD", 128);
  if (head !== undefined && !/^[0-9a-f]{40,64}$/u.test(head)) throw new Error("Git HEAD is invalid");
  const indexHash = value.indexHash === undefined ? undefined : digest(value.indexHash)!;
  let indexEntries: Record<string, string> | undefined;
  if (value.indexEntries !== undefined) {
    if (!plainRecord(value.indexEntries) || Object.keys(value.indexEntries).length > CHANGE_ACCOUNTING_LIMITS.maxFiles) throw new Error("Git index entries are invalid");
    indexEntries = {};
    for (const [rawPath, rawEntry] of Object.entries(value.indexEntries)) {
      const path = normalizedPath(rawPath);
      if (typeof rawEntry !== "string" || !/^[0-7]{6}:[0-9a-f]{40,64}:0$/u.test(rawEntry)) throw new Error("Git index entry is invalid");
      indexEntries[path] = rawEntry;
    }
  }
  if (value.partial !== undefined && typeof value.partial !== "boolean") throw new Error("Git change evidence partial marker is invalid");
  const diagnostics = Object.freeze(value.diagnostics.map((item) => boundedText(item, "Git diagnostic", 2_048)));
  return deepFreeze({ available: value.available, ...(head ? { head } : {}), ...(indexHash ? { indexHash } : {}), ...(indexEntries ? { indexEntries } : {}), status: parseDirty(value.status), diagnostics, ...(value.partial === true ? { partial: true } : {}) });
}
function payload(event: WorkflowEventEnvelope): Record<string, unknown> {
  if (!plainRecord(event.payload) || event.payload.formatVersion !== FORMAT_VERSION) throw new Error("Change accounting event payload is invalid");
  return event.payload;
}
export function createChangeAccountingState(sessionId: string, runId: string): ChangeAccountingState { return deepFreeze({ sessionId: boundedId(sessionId, "Change session ID"), runId: boundedId(runId, "Change run ID"), intents: {}, mutations: [], notApplied: {}, commandAttempts: {} }); }
export function reduceChangeAccountingState(state: ChangeAccountingState, event: WorkflowEventEnvelope): ChangeAccountingState {
  if (!CHANGE_EVENTS.has(event.type) || event.runId !== state.runId) return state;
  if (event.sessionId !== state.sessionId) throw new Error("Change accounting session identity mismatch");
  const data = payload(event);
  if (event.type === "change.baseline.recorded") {
    if (event.producer !== "harness" || state.baseline) throw new Error("Change baseline is unauthorized or duplicated");
    if (data.mode !== "git" && data.mode !== "scoped" && data.mode !== "partial") throw new Error("Change baseline mode is invalid");
    if (typeof data.partial !== "boolean" || !Array.isArray(data.diagnostics)) throw new Error("Change baseline bounds are invalid");
    const diagnostics = Object.freeze(data.diagnostics.map((item) => boundedText(item, "Change diagnostic", 2_048)));
    const git = parseGitEvidence(data.git);
    const baseline: ChangeBaseline = Object.freeze({ mode: data.mode, entries: parseEntries(data.entries), dirty: parseDirty(data.dirty), ...(git ? { git } : {}), partial: data.partial, diagnostics, recordedSequence: event.sequence });
    return deepFreeze({ ...state, baseline });
  }
  const attemptId = boundedId(String(data.attemptId ?? ""), "Change attempt ID");
  if (event.type === "change.command.started") {
    if (event.producer !== "harness" || state.commandAttempts[attemptId]) throw new Error("Command change intent is unauthorized or duplicated");
    if (data.effect !== "shell" && data.effect !== "git") throw new Error("Command change effect is invalid");
    if (!Array.isArray(data.paths) || data.paths.length > 64) throw new Error("Command change paths are invalid");
    const paths = Object.freeze(data.paths.map(normalizedPath));
    const command: CommandAccountingAttempt = Object.freeze({ attemptId, effect: data.effect, paths, status: "pending", startedSequence: event.sequence });
    return deepFreeze({ ...state, commandAttempts: { ...state.commandAttempts, [attemptId]: command } });
  }
  if (event.type === "change.command.recorded") {
    const command = state.commandAttempts[attemptId];
    if (event.producer !== "harness" || !command || command.status !== "pending") throw new Error("Command change result is unauthorized, stale, or duplicated");
    return deepFreeze({ ...state, commandAttempts: { ...state.commandAttempts, [attemptId]: { ...command, status: "completed", recordedSequence: event.sequence } } });
  }
  const path = normalizedPath(data.path);
  if (event.type === "change.mutation.started") {
    if (event.producer !== "harness" || state.intents[attemptId] || state.notApplied[attemptId] || state.mutations.some((entry) => entry.attemptId === attemptId)) throw new Error("Change mutation intent is unauthorized or duplicated");
    if (data.beforeKind !== undefined && data.beforeKind !== "file" && data.beforeKind !== "directory") throw new Error("Change mutation before kind is invalid");
    const beforeHash = data.beforeHash === undefined ? undefined : digest(data.beforeHash)!;
    if ((beforeHash === undefined) !== (data.beforeKind === undefined)) throw new Error("Change mutation before state is incomplete");
    const intent: MutationIntent = Object.freeze({ attemptId, path, ...(beforeHash === undefined ? {} : { beforeHash, beforeKind: data.beforeKind as MutationPathKind }), startedSequence: event.sequence });
    return deepFreeze({ ...state, intents: { ...state.intents, [attemptId]: intent } });
  }
  if (event.type === "change.mutation.not-applied") {
    if (event.producer !== "harness" || state.notApplied[attemptId] || state.mutations.some((entry) => entry.attemptId === attemptId)) throw new Error("Change mutation not-applied resolution is unauthorized or duplicated");
    const intent = state.intents[attemptId];
    if (intent && intent.path !== path) throw new Error("Change mutation not-applied resolution path is stale");
    const diagnostic = boundedText(data.diagnostic, "Change mutation not-applied diagnostic", 2_048);
    const resolution: MutationNotAppliedResolution = Object.freeze({ attemptId, path, diagnostic, recordedSequence: event.sequence });
    return deepFreeze({ ...state, notApplied: { ...state.notApplied, [attemptId]: resolution } });
  }
  if (event.type === "change.mutation.recorded") {
    const intent = state.intents[attemptId];
    if (event.producer !== "harness" || !intent || intent.path !== path || state.mutations.some((entry) => entry.attemptId === attemptId)) throw new Error("Change mutation result is unauthorized, stale, or duplicated");
    if (data.operation !== "create" && data.operation !== "update" && data.operation !== "delete") throw new Error("Change mutation operation is invalid");
    const beforeHash = data.beforeHash === undefined ? undefined : digest(data.beforeHash)!;
    const afterHash = data.afterHash === undefined ? undefined : digest(data.afterHash)!;
    if (data.afterKind !== undefined && data.afterKind !== "file" && data.afterKind !== "directory") throw new Error("Change mutation after kind is invalid");
    if ((afterHash === undefined) !== (data.afterKind === undefined)) throw new Error("Change mutation after state is incomplete");
    if (beforeHash !== intent.beforeHash || data.beforeKind !== intent.beforeKind) throw new Error("Change mutation before state does not match intent");
    if (data.operation === "create" && (beforeHash !== undefined || afterHash === undefined)) throw new Error("Created change hash shape is invalid");
    if (data.operation === "update" && (beforeHash === undefined || afterHash === undefined)) throw new Error("Updated change hash shape is invalid");
    if (data.operation === "delete" && (beforeHash === undefined || afterHash !== undefined)) throw new Error("Deleted change hash shape is invalid");
    const record: MutationRecord = Object.freeze({ ...intent, operation: data.operation, ...(afterHash === undefined ? {} : { afterHash, afterKind: data.afterKind as MutationPathKind }), recordedSequence: event.sequence });
    return deepFreeze({ ...state, mutations: [...state.mutations, record] });
  }
  return state;
}
function hashFile(path: string, maxBytes: number): { hash?: string; size?: number; diagnostic?: string } {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { diagnostic: "non-regular file" };
    if (stat.size > maxBytes) return { size: stat.size, diagnostic: "file exceeds hash bound" };
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (count <= 0) throw new Error("short read");
      hash.update(buffer.subarray(0, count)); offset += count;
    }
    return { size: stat.size, hash: `sha256:${hash.digest("hex")}` };
  } catch (error) { return { diagnostic: String(error instanceof Error ? error.message : error) }; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function isRuntimeExcluded(path: string): boolean { return path === ".git" || path.startsWith(".git/") || path === ".pi/hive/sessions" || path.startsWith(".pi/hive/sessions/"); }
function inventory(options: ChangeAccountingOptions, limits: ChangeAccountingLimits, priorityPaths: readonly string[] = []): Inventory {
  const entries: Record<string, InventoryEntry> = {};
  const diagnostics: string[] = [];
  let aggregatePathBytes = 0;
  let partial = false;
  const addFile = (path: string, absolute: string): void => {
    if (entries[path]) return;
    const pathBytes = Buffer.byteLength(path, "utf8");
    if (Object.keys(entries).length >= limits.maxFiles || aggregatePathBytes + pathBytes > limits.maxAggregatePathBytes) { partial = true; return; }
    const hashed = hashFile(absolute, limits.maxFileBytes);
    if (!hashed.hash || hashed.size === undefined) { partial = true; diagnostics.push(`${path}: ${hashed.diagnostic ?? "hash unavailable"}`); return; }
    entries[path] = Object.freeze({ path, hash: hashed.hash, size: hashed.size });
    aggregatePathBytes += pathBytes;
  };
  for (const path of [...new Set(priorityPaths)].sort()) {
    const target = resolveProjectPath(options.projectRoot, path, { allowMissing: true });
    if (!target?.exists || isRuntimeExcluded(path)) continue;
    let stat;
    try { stat = lstatSync(target.lexicalPath); } catch { partial = true; diagnostics.push(`cannot inspect priority path ${path}`); continue; }
    if (stat.isFile()) addFile(path, target.lexicalPath);
  }
  const roots = options.scopes?.length ? options.scopes : ["."];
  const stack: string[] = [];
  for (const scope of roots) {
    const target = resolveProjectPath(options.projectRoot, scope, { allowMissing: false });
    if (!target) { diagnostics.push(`scope ${scope} is unavailable or escapes the project`); partial = true; continue; }
    stack.push(target.lexicalPath);
  }
  while (stack.length) {
    const absolute = stack.pop()!;
    const path = relative(resolve(options.projectRoot), absolute).split(sep).join("/") || ".";
    if (path !== "." && isRuntimeExcluded(path)) continue;
    let stat;
    try { stat = lstatSync(absolute); } catch { diagnostics.push(`cannot inspect ${path}`); partial = true; continue; }
    if (stat.isDirectory()) {
      let names: string[];
      try { names = readdirSync(absolute).sort().reverse(); } catch { diagnostics.push(`cannot enumerate ${path}`); partial = true; continue; }
      for (const name of names) stack.push(join(absolute, name));
      continue;
    }
    if (!stat.isFile()) { diagnostics.push(`unsupported inventory entry ${path}`); partial = true; continue; }
    if (Object.keys(entries).length >= limits.maxFiles || aggregatePathBytes + Buffer.byteLength(path, "utf8") > limits.maxAggregatePathBytes) { partial = true; diagnostics.push("inventory file/path bound exceeded"); break; }
    addFile(path, absolute);
  }
  return deepFreeze({ entries, partial, diagnostics: diagnostics.slice(0, 128) });
}
function gitPath(projectRoot: string, rawPath: string): string | undefined {
  const local = relative(resolve(projectRoot), resolve(projectRoot, rawPath)).split(sep).join("/");
  return local && !local.startsWith("../") && !isRuntimeExcluded(local) ? local : undefined;
}
function gitStatus(projectRoot: string): PreExistingChange[] {
  const output = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024 });
  const fields = output.split("\0").filter(Boolean);
  const changes: PreExistingChange[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    const status = field.slice(0, 2);
    const path = gitPath(projectRoot, field.slice(3));
    if (path) changes.push({ path, status });
    if (status.includes("R") || status.includes("C")) {
      const previous = gitPath(projectRoot, fields[++index] ?? "");
      if (previous) changes.push({ path: previous, status });
    }
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status));
}
function gitEvidence(projectRoot: string, limits: ChangeAccountingLimits): GitChangeEvidence {
  const diagnostics: string[] = [];
  let partial = false;
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!root) return deepFreeze({ available: false, status: [], diagnostics: ["Git root is unavailable"] });
    let head: string | undefined;
    try { head = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; }
    catch { diagnostics.push("Git HEAD is unborn or unavailable"); }
    const allStatus = gitStatus(projectRoot);
    const status: PreExistingChange[] = [];
    let statusPathBytes = 0;
    const statusPathLimit = Math.min(limits.maxAggregatePathBytes, 49_152);
    for (const change of allStatus) {
      const pathBytes = Buffer.byteLength(change.path, "utf8");
      if (status.length >= Math.min(limits.maxFiles, 512) || statusPathBytes + pathBytes > statusPathLimit) { partial = true; break; }
      status.push(change); statusPathBytes += pathBytes;
    }
    if (partial) diagnostics.push("Git status evidence bound exceeded");
    const statusPaths = new Set(status.map((change) => change.path));
    const index = execFileSync("git", ["ls-files", "--stage", "-z", "--", "."], { cwd: projectRoot, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 });
    const indexHash = `sha256:${createHash("sha256").update("pi-hive-git-index-v1\0").update(index).digest("hex")}`;
    const indexEntries: Record<string, string> = {};
    for (const field of index.toString("utf8").split("\0").filter(Boolean)) {
      const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/u.exec(field);
      if (!match || match[3] !== "0") continue;
      const path = gitPath(projectRoot, match[4]);
      if (path && statusPaths.has(path)) indexEntries[path] = `${match[1]}:${match[2]}:${match[3]}`;
    }
    return deepFreeze({ available: true, ...(head ? { head } : {}), indexHash, indexEntries, status, diagnostics, ...(partial ? { partial: true } : {}) });
  } catch (error) {
    return deepFreeze({ available: false, status: [], diagnostics: [`Git evidence unavailable: ${String(error instanceof Error ? error.message : error).slice(0, 1_024)}`] });
  }
}
function gitHeadChangedPaths(projectRoot: string, before?: string, after?: string): readonly string[] {
  if (!before || !after || before === after) return Object.freeze([]);
  try {
    const output = execFileSync("git", ["diff", "--name-only", "-z", before, after, "--", "."], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024 });
    return Object.freeze(output.split("\0").flatMap((path) => gitPath(projectRoot, path) ?? []).sort());
  } catch { return Object.freeze([]); }
}
function limitsFor(input?: Partial<ChangeAccountingLimits>): ChangeAccountingLimits {
  const result = { ...CHANGE_ACCOUNTING_LIMITS, ...(input ?? {}) };
  for (const [key, value] of Object.entries(result)) if (!Number.isSafeInteger(value) || value < 1 || value > CHANGE_ACCOUNTING_LIMITS[key as keyof typeof CHANGE_ACCOUNTING_LIMITS]) throw new Error(`Change accounting ${key} limit is invalid`);
  return Object.freeze(result);
}
function pathInsideScope(path: string, scope: string): boolean { return path === scope || path.startsWith(`${scope}/`); }
function treeHash(entries: Readonly<Record<string, InventoryEntry>>, scope: string): string {
  const hash = createHash("sha256").update("pi-hive-scoped-tree-v1\0");
  for (const entry of Object.values(entries).filter((candidate) => pathInsideScope(candidate.path, scope)).sort((a, b) => a.path.localeCompare(b.path))) {
    const local = entry.path === scope ? "." : entry.path.slice(scope.length + 1);
    hash.update(local).update("\0").update(entry.hash).update("\0").update(String(entry.size)).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
export class ChangeAccountingRuntime {
  readonly options: ChangeAccountingOptions;
  private readonly zero: ChangeAccountingState;
  private readonly limits: ChangeAccountingLimits;
  constructor(options: ChangeAccountingOptions) { this.options = options; this.zero = createChangeAccountingState(options.sessionId, options.runId); this.limits = limitsFor(options.limits); }
  restore(): ChangeAccountingState { return replayWorkflowJournal(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), this.zero, reduceChangeAccountingState).state; }
  private append(type: "change.baseline.recorded" | "change.mutation.started" | "change.mutation.recorded" | "change.mutation.not-applied" | "change.command.started" | "change.command.recorded", data: Record<string, JsonValue>): WorkflowEventEnvelope {
    const draft = createWorkflowEvent({ projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId, type, payload: { formatVersion: FORMAT_VERSION, ...data }, producer: "harness", timestamp: this.options.now?.() ?? new Date().toISOString(), ...(typeof data.attemptId === "string" ? { attemptId: data.attemptId } : {}) });
    return appendWorkflowEventChecked(this.options.projectRoot, draft, (events) => {
      const replayed = replayWorkflowJournal(events, this.zero, reduceChangeAccountingState);
      reduceChangeAccountingState(replayed.state, sealWorkflowEvent(draft, replayed.lastSequence + 1, replayed.lastHash));
    });
  }
  captureBaseline(): ChangeBaseline {
    const existing = this.restore().baseline;
    if (existing) return existing;
    const git = gitEvidence(this.options.projectRoot, this.limits);
    const scan = inventory(this.options, this.limits, git.status.map((change) => change.path));
    const dirty = git.status.map((change) => Object.freeze({ ...change, ...(scan.entries[change.path]?.hash ? { baselineHash: scan.entries[change.path].hash } : {}) }));
    const orderedEntries = Object.values(scan.entries).sort((left, right) => Number(Boolean(dirty.some((change) => change.path === right.path))) - Number(Boolean(dirty.some((change) => change.path === left.path))) || left.path.localeCompare(right.path));
    const baseDiagnostics = [...scan.diagnostics, ...git.diagnostics];
    const payloadFor = (count: number): Record<string, JsonValue> => {
      const compacted = count < orderedEntries.length;
      const entries = Object.fromEntries(orderedEntries.slice(0, count).map((entry) => [entry.path, entry]));
      const partial = scan.partial || git.partial === true || compacted;
      const diagnostics = [...baseDiagnostics, ...(compacted ? ["baseline event payload bound reduced inventory evidence"] : [])];
      const mode: ChangeAccountingMode = partial ? "partial" : git.available ? "git" : "scoped";
      return { mode, entries: entries as unknown as JsonValue, dirty: dirty as unknown as JsonValue, git: git as unknown as JsonValue, partial, diagnostics };
    };
    const payloadLimit = WORKFLOW_EVENT_LIMITS.payloadBytes - 4_096;
    let low = 0, high = orderedEntries.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(canonicalJson({ formatVersion: FORMAT_VERSION, ...payloadFor(middle) }), "utf8") <= payloadLimit) low = middle;
      else high = middle - 1;
    }
    const payload = payloadFor(low);
    if (Buffer.byteLength(canonicalJson({ formatVersion: FORMAT_VERSION, ...payload }), "utf8") > payloadLimit) throw new Error("CHANGE_BASELINE_PAYLOAD_LIMIT_EXCEEDED");
    this.append("change.baseline.recorded", payload);
    return this.restore().baseline!;
  }
  private currentState(path: string): Readonly<{ kind: MutationPathKind; hash: string }> | undefined {
    const target = resolveProjectPath(this.options.projectRoot, path, { allowMissing: true });
    if (!target?.exists) return undefined;
    let stat;
    try { stat = lstatSync(target.lexicalPath); } catch (error) { throw new Error(`Cannot inspect mutation target ${path}: ${String(error instanceof Error ? error.message : error)}`); }
    if (stat.isFile()) {
      const hashed = hashFile(target.lexicalPath, this.limits.maxFileBytes);
      if (!hashed.hash) throw new Error(`Cannot hash mutation target ${path}: ${hashed.diagnostic ?? "hash unavailable"}`);
      return Object.freeze({ kind: "file", hash: hashed.hash });
    }
    if (stat.isDirectory()) {
      const scan = inventory({ ...this.options, scopes: [path] }, this.limits);
      if (scan.partial) throw new Error(`Directory mutation accounting is incomplete for ${path}: ${scan.diagnostics.join("; ")}`);
      return Object.freeze({ kind: "directory", hash: treeHash(scan.entries, path) });
    }
    throw new Error(`Mutation target ${path} is not a regular file or directory`);
  }
  private currentHash(path: string): string | undefined { return this.currentState(path)?.hash; }
  beginMutation(attemptId: string, path: string): MutationIntent {
    const normalized = normalizedPath(path);
    const before = this.currentState(normalized);
    this.append("change.mutation.started", { attemptId: boundedId(attemptId, "Change attempt ID"), path: normalized, ...(before ? { beforeHash: before.hash, beforeKind: before.kind } : {}) });
    return this.restore().intents[attemptId];
  }
  recordTrustedCreation(attemptId: string, path: string): MutationRecord {
    const id = boundedId(attemptId, "Change attempt ID");
    const normalized = normalizedPath(path);
    const state = this.restore();
    if (!state.baseline) throw new Error("Trusted creation accounting requires a run baseline");
    if (state.baseline.entries[normalized] || Object.keys(state.baseline.entries).some((entry) => pathInsideScope(entry, normalized))) throw new Error("Trusted creation accounting cannot overwrite baseline state");
    if (!this.currentState(normalized)) throw new Error("Trusted creation accounting requires a current file or directory");
    this.append("change.mutation.started", { attemptId: id, path: normalized });
    return this.completeMutation(this.restore().intents[id], normalized);
  }
  completeMutation(intent: MutationIntent, path = intent.path): MutationRecord {
    const normalized = normalizedPath(path);
    if (normalized !== intent.path) throw new Error("Mutation completion path differs from its intent");
    const durable = this.restore().intents[intent.attemptId];
    if (!durable || durable.path !== normalized || durable.beforeHash !== intent.beforeHash || durable.beforeKind !== intent.beforeKind) throw new Error("Mutation intent is stale or untrusted");
    const after = this.currentState(normalized);
    const operation = durable.beforeHash === undefined ? "create" : after === undefined ? "delete" : "update";
    if (durable.beforeHash === undefined && after === undefined) throw new Error("Mutation produced no observable file state");
    this.append("change.mutation.recorded", {
      attemptId: durable.attemptId, path: normalized, operation,
      ...(durable.beforeHash ? { beforeHash: durable.beforeHash, beforeKind: durable.beforeKind! } : {}),
      ...(after ? { afterHash: after.hash, afterKind: after.kind } : {}),
    });
    return this.restore().mutations.find((entry) => entry.attemptId === durable.attemptId)!;
  }
  recordMutationNotApplied(attemptId: string, path: string, diagnostic: string): MutationNotAppliedResolution {
    const id = boundedId(attemptId, "Change attempt ID");
    const normalized = normalizedPath(path);
    const existing = this.restore().notApplied[id];
    if (existing) return existing;
    this.append("change.mutation.not-applied", { attemptId: id, path: normalized, diagnostic: boundedText(diagnostic, "Change mutation not-applied diagnostic", 2_048) });
    return this.restore().notApplied[id];
  }
  mutationRecorder(): Readonly<MutationAccountingRecorder> {
    return Object.freeze({
      begin: (attemptId: string, path: string) => this.beginMutation(attemptId, path),
      complete: (intent: MutationIntent, path?: string) => this.completeMutation(intent, path),
      notApplied: (attemptId: string, path: string, diagnostic: string) => this.recordMutationNotApplied(attemptId, path, diagnostic),
    });
  }
  beginCommandAttempt(attemptId: string, metadata: CommandAttemptMetadata): CommandMutationIntent {
    if (!isTrustedCommandAttemptMetadata(metadata) || !metadata.valid || !metadata.mutating) throw new Error("Command change accounting requires trusted valid mutating metadata");
    const id = boundedId(attemptId, "Command change attempt ID");
    const paths = [...new Set(metadata.effects.flatMap((effect) => effect.operation === "read" || effect.path === "." ? [] : [normalizedPath(effect.path)]))];
    const effect = metadata.git ? "git" : "shell";
    this.append("change.command.started", { attemptId: id, effect, paths });
    const command = this.restore().commandAttempts[id];
    const mutations = paths.map((path, index) => this.beginMutation(`${id}-effect-${index + 1}`, path));
    return deepFreeze({ attemptId: id, command, mutations });
  }
  completeCommandAttempt(input: CommandMutationIntent): CommandAccountingAttempt {
    const current = this.restore().commandAttempts[input.attemptId];
    if (!current || current.status !== "pending" || current.startedSequence !== input.command.startedSequence) throw new Error("Command change intent is stale or untrusted");
    return this.reconcileCommandAttempt(input.attemptId, "applied");
  }
  reconcileCommandAttempt(attemptId: string, state: "applied" | "not-applied"): CommandAccountingAttempt {
    const id = boundedId(attemptId, "Command change attempt ID");
    const command = this.restore().commandAttempts[id];
    if (!command) throw new Error("Command change reconciliation has no durable intent");
    if (command.status === "completed") return command;
    const durable = this.restore();
    for (let index = 0; index < command.paths.length; index++) {
      const mutationId = `${id}-effect-${index + 1}`;
      const mutation = durable.intents[mutationId];
      if (!mutation) throw new Error("Command change reconciliation is missing a path intent");
      if (durable.mutations.some((record) => record.attemptId === mutationId) || durable.notApplied[mutationId]) continue;
      if (state === "not-applied") {
        if (this.currentHash(mutation.path) !== mutation.beforeHash) throw new Error("Command effect cannot be proven not applied from its before hash");
        this.recordMutationNotApplied(mutationId, mutation.path, "trusted reconciliation proved command effect was not applied");
      } else this.completeMutation(mutation);
    }
    this.append("change.command.recorded", { attemptId: id });
    return this.restore().commandAttempts[id];
  }
  reconcile(): ChangeAccountingReport {
    const state = this.restore();
    const baseline = state.baseline;
    if (!baseline) return deepFreeze({ state: "unsatisfied", issues: ["run change baseline is missing"], fileChanges: [], changeCoverage: "partial", preExistingChanges: [], partial: true });
    const currentGit = baseline.git?.available ? gitEvidence(this.options.projectRoot, this.limits) : undefined;
    const current = inventory(this.options, this.limits, [...Object.keys(baseline.entries), ...(currentGit?.status.map((change) => change.path) ?? [])]);
    const baselineStatus = new Map((baseline.git?.status ?? []).map((entry) => [entry.path, entry.status]));
    const currentStatus = new Map((currentGit?.status ?? []).map((entry) => [entry.path, entry.status]));
    const statusChangedPaths = [...new Set([...baselineStatus.keys(), ...currentStatus.keys()])]
      .filter((path) => baselineStatus.get(path) !== currentStatus.get(path));
    const headChangedPaths = gitHeadChangedPaths(this.options.projectRoot, baseline.git?.head, currentGit?.head);
    const gitBackedPaths = new Set([...statusChangedPaths, ...headChangedPaths]);
    const indexChanged = Boolean(baseline.git?.available && currentGit?.available && baseline.git.indexHash !== currentGit.indexHash);
    const indexChangedPaths = [...new Set([
      ...Object.keys(baseline.git?.indexEntries ?? {}), ...Object.keys(currentGit?.indexEntries ?? {}),
    ])].filter((path) => baseline.git?.indexEntries?.[path] !== currentGit?.indexEntries?.[path]).sort();
    const headChanged = Boolean(baseline.git?.head && currentGit?.head && baseline.git.head !== currentGit.head);
    const paths = [...new Set([...Object.keys(baseline.entries), ...Object.keys(current.entries)])].sort();
    const dirty = new Set(baseline.dirty.map((entry) => entry.path));
    const mutationsByPath = new Map<string, MutationRecord[]>();
    for (const record of state.mutations) {
      const records = mutationsByPath.get(record.path) ?? [];
      records.push(record);
      mutationsByPath.set(record.path, records);
    }
    const recordedChainCovers = (path: string, before: string | undefined, after: string | undefined): boolean => {
      const records = [...(mutationsByPath.get(path) ?? [])].sort((left, right) => left.recordedSequence - right.recordedSequence);
      if (!records.length) return false;
      let expected = before;
      for (const record of records) {
        if (record.beforeHash !== expected) return false;
        expected = record.afterHash;
      }
      return expected === after;
    };
    const recordedDirectoryScopes = [...new Set(state.mutations
      .filter((record) => record.beforeKind === "directory" || record.afterKind === "directory")
      .map((record) => record.path))]
      .filter((scope) => {
        const first = [...(mutationsByPath.get(scope) ?? [])].sort((a, b) => a.recordedSequence - b.recordedSequence)[0];
        const last = [...(mutationsByPath.get(scope) ?? [])].sort((a, b) => b.recordedSequence - a.recordedSequence)[0];
        const before = first?.beforeHash === undefined ? undefined : treeHash(baseline.entries, scope);
        const after = last?.afterHash === undefined ? undefined : treeHash(current.entries, scope);
        return recordedChainCovers(scope, before, after);
      });
    const recordedScopeCovers = (path: string): boolean => recordedDirectoryScopes.some((scope) => pathInsideScope(path, scope));
    const changes: FileChangeRecord[] = [];
    const issues: string[] = [];
    for (const path of paths) {
      const before = baseline.entries[path]?.hash;
      const after = current.entries[path]?.hash;
      if (before === after) continue;
      const mutations = mutationsByPath.get(path) ?? [];
      let attribution: FileChangeRecord["attribution"];
      if (recordedChainCovers(path, before, after) || recordedScopeCovers(path)) attribution = "recorded";
      else if (mutations.length) { attribution = "conflicted"; issues.push(`external or concurrent conflict in recorded mutation chain: ${path}`); }
      else if (dirty.has(path)) { attribution = "conflicted"; issues.push(`pre-existing dirty file changed again without provable ordering: ${path}`); }
      else attribution = baseline.mode === "git" && gitBackedPaths.has(path) ? "git-reconciled" : "unattributed";
      const operation = before === undefined ? "create" : after === undefined ? "delete" : "update";
      changes.push(Object.freeze({ path, operation, ...(before ? { beforeHash: before } : {}), ...(after ? { afterHash: after } : {}), attribution }));
    }
    // Deterministically infer only unambiguous content-preserving renames.
    const deletes = changes.filter((change) => change.operation === "delete");
    const creates = changes.filter((change) => change.operation === "create");
    const consumed = new Set<FileChangeRecord>();
    const renames: FileChangeRecord[] = [];
    for (const deleted of deletes) {
      const candidates = creates.filter((created) => created.afterHash === deleted.beforeHash && !consumed.has(created));
      const reverse = candidates.length === 1 ? deletes.filter((candidate) => candidate.beforeHash === candidates[0].afterHash && !consumed.has(candidate)) : [];
      if (candidates.length !== 1 || reverse.length !== 1 || deleted.attribution === "conflicted" || candidates[0].attribution === "conflicted") continue;
      const created = candidates[0]; consumed.add(deleted); consumed.add(created);
      const gitBacked = gitBackedPaths.has(deleted.path) || gitBackedPaths.has(created.path);
      renames.push(Object.freeze({ path: created.path, previousPath: deleted.path, operation: "rename", beforeHash: deleted.beforeHash!, afterHash: created.afterHash!, attribution: baseline.mode === "git" && gitBacked ? "git-reconciled" : "scoped-reconciled" }));
    }
    const fileChanges = [...changes.filter((change) => !consumed.has(change)), ...renames].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    for (const change of fileChanges) {
      const reservation = checkProtectedPath(this.options.projectRoot, change.path, { allowMissing: change.operation === "delete", additionalRoots: this.options.protectedRoots });
      const previousReservation = change.previousPath ? checkProtectedPath(this.options.projectRoot, change.previousPath, { allowMissing: true, additionalRoots: this.options.protectedRoots }) : undefined;
      if ((reservation.protected || previousReservation?.protected) && change.attribution !== "recorded") issues.push(`unexplained protected-path drift (${reservation.kind ?? previousReservation?.kind ?? "protected"}): ${change.path}`);
    }
    for (const path of [...new Set([...statusChangedPaths, ...indexChangedPaths])]) {
      const reservation = checkProtectedPath(this.options.projectRoot, path, { allowMissing: true, additionalRoots: this.options.protectedRoots });
      if (reservation.protected && !mutationsByPath.has(path)) issues.push(`unexplained protected Git index blob/staged drift (${reservation.kind ?? "protected"}): ${path}`);
    }
    const unresolvedIntents = Object.values(state.intents).filter((intent) => !state.notApplied[intent.attemptId] && !state.mutations.some((record) => record.attemptId === intent.attemptId));
    if (unresolvedIntents.length) issues.push(`${unresolvedIntents.length} queued mutation intent(s) have no durable accounting result`);
    const unresolvedCommands = Object.values(state.commandAttempts).filter((attempt) => attempt.status === "pending");
    if (unresolvedCommands.length) issues.push(`${unresolvedCommands.length} known mutating shell/Git attempt(s) have no durable change-accounting result`);
    const gitUnavailable = baseline.mode === "git" && !currentGit?.available;
    const partial = baseline.partial || current.partial || currentGit?.partial === true || gitUnavailable;
    const metadataDrift = indexChanged || headChanged || statusChangedPaths.length > 0;
    const allRecorded = fileChanges.every((change) => change.attribution === "recorded");
    const allGitBacked = fileChanges.every((change) => change.attribution === "recorded" || change.attribution === "git-reconciled");
    const changeCoverage: ChangeAccountingReport["changeCoverage"] = partial ? "partial"
      : allRecorded && !metadataDrift ? "recorded"
        : baseline.mode === "git" && currentGit?.available && allGitBacked ? "git-reconciled" : "scoped-reconciled";
    const uniqueIssues = [...new Set(issues)];
    return deepFreeze({
      state: uniqueIssues.length ? "unsatisfied" : "satisfied", issues: uniqueIssues, fileChanges, changeCoverage,
      preExistingChanges: baseline.dirty, partial,
      partialState: {
        preExistingChanges: baseline.dirty as unknown as JsonValue, baselineMode: baseline.mode, baselinePartial: baseline.partial,
        git: { ...(baseline.git ? { baseline: baseline.git } : {}), ...(currentGit ? { current: currentGit } : {}), indexChanged, indexChangedPaths, headChanged, statusChangedPaths, headChangedPaths } as unknown as JsonValue,
        commandAttempts: state.commandAttempts as unknown as JsonValue,
        reconciliationDiagnostics: [...baseline.diagnostics, ...current.diagnostics, ...(currentGit?.diagnostics ?? [])],
      },
    });
  }
}
