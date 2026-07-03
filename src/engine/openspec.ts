import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, readIfSmall } from "../core/fs";

// Thin, bounded wrapper around the OpenSpec CLI (@fission-ai/openspec).
//
// pi-hive shells out to the CLI and parses `--json` rather than importing its
// TypeScript tree (which drags in PostHog telemetry). All child output is
// bounded (timeout + maxBuffer) per the CLAUDE.md "tool output must be bounded"
// rule, and every command runs with telemetry disabled.
//
// OpenSpec is the *store + validator*: it owns the artifact dependency graph
// (proposal -> {design, specs} -> tasks) and validation, and reports readiness
// per artifact via `openspec status --json`. It does NOT model human approval —
// pi-hive owns the approval gate (verdicts in SQLite). `isReadyToExecute` here
// answers only "are the artifacts materially complete + valid", which the
// dispatch execution gate combines with pi-hive's own approval state.

// Node's Dirent, declared locally because the core tsconfig loads no @types/node
// (matches the pattern in plan-store.ts / sdd.ts).
type FsDirent = { name: string; isDirectory(): boolean; isFile(): boolean };

const CHANGE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXEC_TIMEOUT_MS = 20_000;
const EXEC_MAX_BUFFER = 4_000_000; // 4 MB hard cap on CLI stdout
const MAX_ARTIFACT_BYTES = 512_000;

export function isSafeChangeId(changeId: string): boolean {
  return CHANGE_ID_RE.test(changeId);
}

// ---------------------------------------------------------------------------
// Binary resolution + invocation
// ---------------------------------------------------------------------------

// Resolve the OpenSpec CLI binary. It ships as a dependency of pi-hive (not of
// the user's project), so we look in pi-hive's own node_modules first, then
// allow an explicit override, then fall back to a PATH lookup. Returns null when
// the CLI is absent so callers can degrade gracefully instead of throwing.
let cachedBinary: string | null | undefined;
function resolveBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary;
  const override = process.env.HIVE_OPENSPEC_BIN;
  if (override && existsSync(override)) return (cachedBinary = override);

  // Walk up from this module toward a node_modules/.bin/openspec. Under an
  // installed extension this file lives at <extension>/src/engine/openspec.ts.
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = process.cwd();
  }
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "node_modules", ".bin", "openspec");
    if (existsSync(candidate)) return (cachedBinary = candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (cachedBinary = null);
}

// Whether the OpenSpec CLI is available at all. When false, the extension still
// loads and reports "no plan store" rather than throwing.
export function isAvailable(): boolean {
  return resolveBinary() !== null;
}

// Run a CLI command expecting JSON on stdout. `openspec validate` exits non-zero
// when validation FAILS while still emitting a valid JSON report to stdout, so
// we recover stdout from the thrown error (execFileSync attaches it to
// error.stdout) and only return null when there is no parseable JSON at all.
function runJson<T>(cwd: string, args: string[]): T | null {
  const bin = resolveBinary();
  if (!bin) return null;
  let out: string | undefined;
  try {
    out = execFileSync(bin, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      env: { ...process.env, OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1", NO_COLOR: "1" },
    });
  } catch (err) {
    // encoding:"utf8" means stdout is a string; validate exits non-zero on a
    // failing report but still writes the JSON to error.stdout.
    const stdout = (err as { stdout?: string })?.stdout;
    out = typeof stdout === "string" ? stdout : undefined;
  }
  if (!out) return null;
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

function run(cwd: string, args: string[]): boolean {
  const bin = resolveBinary();
  if (!bin) return false;
  try {
    execFileSync(bin, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      env: { ...process.env, OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1", NO_COLOR: "1" },
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// init / update
// ---------------------------------------------------------------------------

// True once `openspec init` has run in this project (the openspec/ tree exists).
export function isInitialized(cwd: string): boolean {
  return existsSync(join(cwd, "openspec", "config.yaml")) || existsSync(join(cwd, "openspec", "changes"));
}

// Normalize a title/id into a stable kebab change-id (matches OpenSpec's naming).
export function toChangeId(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Scaffold a new change directory via `openspec new change <id>`. Returns the
// change-id, or null if the CLI is unavailable / the id is unsafe / the command
// failed. Idempotent: if the change already exists, returns it without error.
export function newChange(cwd: string, title: string): { changeId: string; created: boolean } | null {
  const changeId = toChangeId(title);
  if (!isSafeChangeId(changeId)) return null;
  if (changeExists(cwd, changeId)) return { changeId, created: false };
  if (!isAvailable()) return null;
  const ok = run(cwd, ["new", "change", changeId]);
  if (!ok || !changeExists(cwd, changeId)) return null;
  return { changeId, created: true };
}

// Idempotently initialize OpenSpec with the Pi adapter selected, writing the
// /opsx-* prompts + skills to .pi/. Non-interactive via `--tools pi`. Returns
// true if OpenSpec is (now) initialized. Safe to call when the CLI is absent
// (returns false without throwing).
export function ensureInit(cwd: string): boolean {
  if (!isAvailable()) return false;
  if (isInitialized(cwd)) return true;
  return run(cwd, ["init", "--tools", "pi"]) && isInitialized(cwd);
}

// ---------------------------------------------------------------------------
// list --json
// ---------------------------------------------------------------------------

export type ChangeTaskStatus = "no-tasks" | "in-progress" | "complete";

export interface ChangeSummary {
  name: string;
  completedTasks: number;
  totalTasks: number;
  status: ChangeTaskStatus;
  lastModified?: string;
}

interface ListJson {
  changes?: Array<{
    name?: string;
    completedTasks?: number;
    totalTasks?: number;
    status?: string;
    lastModified?: string;
  }>;
}

// All changes under openspec/changes/, from `openspec list --json`.
export function listChanges(cwd: string): ChangeSummary[] {
  const data = runJson<ListJson>(cwd, ["list", "--json"]);
  if (!data?.changes) return [];
  return data.changes
    .filter((c): c is Required<Pick<typeof c, "name">> & typeof c => typeof c.name === "string" && isSafeChangeId(c.name))
    .map((c) => ({
      name: c.name as string,
      completedTasks: Number(c.completedTasks ?? 0),
      totalTasks: Number(c.totalTasks ?? 0),
      status: (c.status === "in-progress" || c.status === "complete" ? c.status : "no-tasks") as ChangeTaskStatus,
      lastModified: c.lastModified,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function changeExists(cwd: string, name: string): boolean {
  return isSafeChangeId(name) && existsSync(join(cwd, "openspec", "changes", name));
}

// ---------------------------------------------------------------------------
// status --json (artifact dependency graph)
// ---------------------------------------------------------------------------

export type ArtifactStatus = "done" | "ready" | "blocked";

export interface ArtifactState {
  id: string; // proposal | design | specs | tasks
  outputPath: string;
  status: ArtifactStatus;
  missingDeps: string[];
}

export interface ChangeDetail {
  name: string;
  artifacts: ArtifactState[];
  // The first artifact whose dependencies are satisfied but which is not yet
  // authored — i.e. the next thing the planning team should produce. null when
  // everything is authored.
  nextReady: string | null;
}

interface StatusJson {
  artifacts?: Array<{
    id?: string;
    outputPath?: string;
    status?: string;
    missingDeps?: string[] | null;
  }>;
}

export function changeDetail(cwd: string, name: string): ChangeDetail | null {
  if (!isSafeChangeId(name)) return null;
  const data = runJson<StatusJson>(cwd, ["status", "--json", "--change", name]);
  if (!data?.artifacts) return null;
  const artifacts: ArtifactState[] = data.artifacts.map((a) => ({
    id: String(a.id ?? ""),
    outputPath: String(a.outputPath ?? ""),
    status: (a.status === "done" || a.status === "ready" ? a.status : "blocked") as ArtifactStatus,
    missingDeps: Array.isArray(a.missingDeps) ? a.missingDeps.map(String) : [],
  }));
  const nextReady = artifacts.find((a) => a.status === "ready")?.id ?? null;
  return { name, artifacts, nextReady };
}

// ---------------------------------------------------------------------------
// validate --json
// ---------------------------------------------------------------------------

export interface ValidateIssue {
  level: string; // ERROR | WARNING
  path: string;
  message: string;
}

export interface ValidateResult {
  passed: boolean;
  failed: number;
  issues: ValidateIssue[];
}

interface ValidateJson {
  items?: Array<{ issues?: Array<{ level?: string; path?: string; message?: string }> }>;
  summary?: { totals?: { passed?: number; failed?: number } };
}

// Validate one change (or all when name omitted). A change passes when the
// summary reports zero failures.
export function validate(cwd: string, name?: string): ValidateResult {
  const args = name ? ["validate", name, "--json"] : ["validate", "--all", "--json"];
  const data = runJson<ValidateJson>(cwd, args);
  if (!data?.summary?.totals) {
    return { passed: false, failed: -1, issues: [] };
  }
  const failed = Number(data.summary.totals.failed ?? 0);
  const issues: ValidateIssue[] = [];
  for (const item of data.items ?? []) {
    for (const issue of item.issues ?? []) {
      issues.push({
        level: String(issue.level ?? "ERROR"),
        path: String(issue.path ?? ""),
        message: String(issue.message ?? ""),
      });
    }
  }
  return { passed: failed === 0, failed, issues };
}

// ---------------------------------------------------------------------------
// Execution readiness gate
// ---------------------------------------------------------------------------

// tasks.md exists and contains at least one checkbox item.
export function hasTasks(cwd: string, name: string): boolean {
  if (!isSafeChangeId(name)) return false;
  const raw = readIfSmall(join(cwd, "openspec", "changes", name, "tasks.md"), MAX_ARTIFACT_BYTES);
  return /^\s*[-*]\s*\[[ xX]\]/m.test(raw);
}

// Artifact-side readiness: the artifacts are materially complete (tasks
// authored) AND OpenSpec validation passes. This is what the dashboard and
// /hive-plan surface show as "ready to approve". It does NOT include pi-hive's
// human approval — see isExecutionGateOpen for the load-bearing dispatch gate.
export function isReadyToExecute(cwd: string, name: string): boolean {
  return hasTasks(cwd, name) && validate(cwd, name).passed;
}

// The load-bearing gate consumed by dispatch.ts before it will delegate to a
// coder/tester: the artifacts are ready AND a human has approved execution via
// the review surface. pi-hive owns approval, so both halves are required.
export function isExecutionGateOpen(cwd: string, name: string): boolean {
  return isReadyToExecute(cwd, name) && isApprovedForExecution(cwd, name);
}

// ---------------------------------------------------------------------------
// Artifact reads (path-guarded)
// ---------------------------------------------------------------------------

// Guard a requested artifact path so a read cannot traverse outside the change
// folder. Returns the resolved absolute path or null if unsafe. Ported from
// plan-store.resolveArtifact.
export function resolveArtifact(cwd: string, name: string, relPath: string): string | null {
  if (!isSafeChangeId(name)) return null;
  const base = resolve(cwd, "openspec", "changes", name);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(`${base}/`)) return null;
  return target;
}

// Read an artifact under a change folder, path-guarded and capped at 512 KB.
export function readArtifact(cwd: string, name: string, relPath: string): string {
  const target = resolveArtifact(cwd, name, relPath);
  if (!target) return "";
  return readIfSmall(target, MAX_ARTIFACT_BYTES);
}

// ---------------------------------------------------------------------------
// pi-hive approval gate (pi-hive owns approval; OpenSpec has no phase gates)
// ---------------------------------------------------------------------------
//
// OpenSpec is the store + validator; it models artifact dependencies but not
// human approval. pi-hive layers its own approval on top, persisted as a sidecar
// under the change dir so the CORE (Node, inside the Pi session) can read it
// without touching the dashboard's Bun SQLite. The self-hosted review surface
// (Bun server, which has fs access to the project) writes it on approve.

const APPROVAL_FILE = ".pi-hive-approval.json";

function approvalPath(cwd: string, name: string): string | null {
  if (!isSafeChangeId(name)) return null;
  return join(cwd, "openspec", "changes", name, APPROVAL_FILE);
}

// True once the change's tasks artifact has been approved via the review
// surface. This is pi-hive's own gate state, independent of OpenSpec.
export function isApprovedForExecution(cwd: string, name: string): boolean {
  const p = approvalPath(cwd, name);
  if (!p) return false;
  const raw = readIfSmall(p, 8_000);
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as { approved?: boolean })?.approved === true;
  } catch {
    return false;
  }
}

// Record (or clear) pi-hive's execution approval for a change. Called by the
// review surface when the tasks artifact is approved/denied.
export function setExecutionApproval(cwd: string, name: string, approved: boolean, by = "ui"): boolean {
  const p = approvalPath(cwd, name);
  if (!p) return false;
  try {
    ensureDir(dirname(p));
    writeFileSync(p, `${JSON.stringify({ approved, by, at: new Date().toISOString() })}\n`);
    return true;
  } catch {
    return false;
  }
}

// The .md artifact files present at the top level of a change folder.
export function listArtifacts(cwd: string, name: string): string[] {
  if (!isSafeChangeId(name)) return [];
  try {
    return (readdirSync(join(cwd, "openspec", "changes", name), { withFileTypes: true }) as FsDirent[])
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
