import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
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
// OpenSpec reports specs as a glob (`specs/**/*.md`), not as a single file; for
// that review artifact, concatenate the concrete spec markdown files into one
// bounded document so the review UI has real content to render.
export function readArtifact(cwd: string, name: string, relPath: string): string {
  if (isSpecsGlob(relPath)) return readSpecsBundle(cwd, name);
  // Be tolerant of agents/review links that point at an OpenSpec spec directory
  // (e.g. specs/front-window-backend) instead of the concrete spec.md file.
  // OpenSpec stores capability specs as directories containing markdown files.
  if (relPath.startsWith("specs/") && !relPath.endsWith(".md")) return readSpecsBundle(cwd, name, relPath);
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

// The four spec-driven artifacts, in dependency order, and each artifact's
// direct upstream deps (mirrors what `openspec status --json` reports). A human
// approval of an artifact is only meaningful while its upstream artifacts remain
// approved, so DENYING an upstream artifact invalidates everything downstream.
export const ARTIFACT_ORDER = ["proposal", "design", "specs", "tasks"] as const;
export type ArtifactId = (typeof ARTIFACT_ORDER)[number];
const UPSTREAM: Record<ArtifactId, ArtifactId[]> = {
  proposal: [],
  design: ["proposal"],
  specs: ["proposal"],
  tasks: ["design", "specs"],
};

// The set of artifacts that (transitively) depend on `artifact` — the ones whose
// approval must be revoked when `artifact` is denied.
function downstreamOf(artifact: ArtifactId): ArtifactId[] {
  const out: ArtifactId[] = [];
  for (const id of ARTIFACT_ORDER) {
    if (id === artifact) continue;
    // Walk id's upstream chain; if it reaches `artifact`, it's downstream.
    const seen = new Set<ArtifactId>();
    const stack = [...UPSTREAM[id]];
    while (stack.length) {
      const dep = stack.pop()!;
      if (dep === artifact) { out.push(id); break; }
      if (!seen.has(dep)) { seen.add(dep); stack.push(...UPSTREAM[dep]); }
    }
  }
  return out;
}

export type ArtifactVerdict = "green" | "red" | null;
export type AgentReviewVerdict = "green" | "yellow" | "red" | null;
// Per-artifact approval ledger — pi-hive's own gate state, independent of
// OpenSpec, persisted as a sidecar the CORE can read without SQLite.
export type ApprovalLedger = Partial<Record<ArtifactId, ArtifactVerdict>>;
export type AgentReviewLedger = Partial<Record<ArtifactId, AgentReviewVerdict>>;

type ApprovalSidecar = {
  approved?: boolean;
  artifacts?: ApprovalLedger;
  agentReviews?: AgentReviewLedger;
  by?: string;
  at?: string;
};

function approvalPath(cwd: string, name: string): string | null {
  if (!isSafeChangeId(name)) return null;
  return join(cwd, "openspec", "changes", name, APPROVAL_FILE);
}

function toArtifactId(artifact: string): ArtifactId | null {
  const id = artifact.replace(/\.md$/, "").replace(/^specs.*/, "specs");
  return (ARTIFACT_ORDER as readonly string[]).includes(id) ? (id as ArtifactId) : null;
}

// Read the ledger. Back-compat: the old flat shape {approved:true} maps to
// {tasks:"green"} so pre-existing sidecars keep gating execution.
function readApprovalSidecar(cwd: string, name: string): ApprovalSidecar {
  const p = approvalPath(cwd, name);
  if (!p) return {};
  const raw = readIfSmall(p, 16_000);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ApprovalSidecar;
  } catch {
    return {};
  }
}

export function readApprovalLedger(cwd: string, name: string): ApprovalLedger {
  const parsed = readApprovalSidecar(cwd, name);
  if (parsed.artifacts) return parsed.artifacts;
  if (parsed.approved === true) return { tasks: "green" }; // legacy flat shape
  return {};
}

export function readAgentReviewLedger(cwd: string, name: string): AgentReviewLedger {
  return readApprovalSidecar(cwd, name).agentReviews || {};
}

// Atomic write (temp + rename) so the core dispatch gate never reads a
// half-written ledger. Single writer in practice, but preserve unrelated sidecar
// sections so UI approvals and agent-review gates do not overwrite each other.
function writeApprovalSidecar(cwd: string, name: string, sidecar: ApprovalSidecar, by: string): boolean {
  const p = approvalPath(cwd, name);
  if (!p) return false;
  try {
    ensureDir(dirname(p));
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ...sidecar, by, at: new Date().toISOString() }, null, 2)}\n`);
    renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

function writeApprovalLedger(cwd: string, name: string, ledger: ApprovalLedger, by: string): boolean {
  return writeApprovalSidecar(cwd, name, { ...readApprovalSidecar(cwd, name), artifacts: ledger }, by);
}

// Record a human verdict for one artifact. On a DENY (red), also revoke the
// approval of every downstream artifact — work built on a rejected upstream
// artifact can no longer be trusted, so the pipeline rewinds.
export function setArtifactApproval(cwd: string, name: string, artifact: string, verdict: ArtifactVerdict, by = "ui"): boolean {
  const id = toArtifactId(artifact);
  if (!id) return false;
  const ledger = readApprovalLedger(cwd, name);
  ledger[id] = verdict;
  if (verdict === "red") {
    for (const down of downstreamOf(id)) ledger[down] = null;
  }
  return writeApprovalLedger(cwd, name, ledger, by);
}

export function artifactVerdict(cwd: string, name: string, artifact: string): ArtifactVerdict {
  const id = toArtifactId(artifact);
  if (!id) return null;
  return readApprovalLedger(cwd, name)[id] ?? null;
}

export function setAgentReviewVerdict(cwd: string, name: string, artifact: string, verdict: AgentReviewVerdict, by = "agent-reviewer"): boolean {
  const id = toArtifactId(artifact);
  if (!id) return false;
  const sidecar = readApprovalSidecar(cwd, name);
  const agentReviews = { ...(sidecar.agentReviews || {}) };
  agentReviews[id] = verdict;
  return writeApprovalSidecar(cwd, name, { ...sidecar, agentReviews }, by);
}

export function agentReviewVerdict(cwd: string, name: string, artifact: string): AgentReviewVerdict {
  const id = toArtifactId(artifact);
  if (!id) return null;
  return readAgentReviewLedger(cwd, name)[id] ?? null;
}

export function isArtifactApproved(cwd: string, name: string, artifact: string): boolean {
  return artifactVerdict(cwd, name, artifact) === "green";
}

// An artifact may be AUTHORED (by a planner) only when every one of its upstream
// dependencies has a standing green approval. This is the per-artifact planning
// gate the dispatch guard consults (H2).
export function canAuthorArtifact(cwd: string, name: string, artifact: string): boolean {
  const id = toArtifactId(artifact);
  if (!id) return false;
  const ledger = readApprovalLedger(cwd, name);
  return UPSTREAM[id].every((dep) => ledger[dep] === "green");
}

// The next artifact the planning team should author: the first in dependency
// order that is not yet on disk and whose upstream deps are all approved.
export function nextAuthorableArtifact(cwd: string, name: string): ArtifactId | null {
  const files = new Set(listArtifacts(cwd, name).map((f) => f.replace(/\.md$/, "")));
  const hasSpecs = existsSync(join(cwd, "openspec", "changes", name, "specs"));
  for (const id of ARTIFACT_ORDER) {
    const present = id === "specs" ? hasSpecs : files.has(id);
    if (!present && canAuthorArtifact(cwd, name, id)) return id;
  }
  return null;
}

// True once the tasks artifact is human-approved. Retained name for the
// execution-gate callers; now backed by the per-artifact ledger.
export function isApprovedForExecution(cwd: string, name: string): boolean {
  return isArtifactApproved(cwd, name, "tasks");
}

// The most-recently-authored artifact that the human has NOT YET decided on
// (ledger entry is absent — not green, not red). A red entry means the human
// asked for a revision, which is a permitted planner action, so it does not
// count as "awaiting". Returns null when there is nothing waiting on the human.
export function pendingReviewArtifact(cwd: string, name: string): ArtifactId | null {
  const files = new Set(listArtifacts(cwd, name).map((f) => f.replace(/\.md$/, "")));
  const hasSpecs = existsSync(join(cwd, "openspec", "changes", name, "specs"));
  const ledger = readApprovalLedger(cwd, name);
  let pending: ArtifactId | null = null;
  for (const id of ARTIFACT_ORDER) {
    const present = id === "specs" ? hasSpecs : files.has(id);
    // If the automated reviewer already rejected this artifact, it is not
    // awaiting human review; it is awaiting same-artifact revision. Missing or
    // green/yellow agent review still holds the pipeline before the next artifact.
    if (present && ledger[id] == null && agentReviewVerdict(cwd, name, id) !== "red") pending = id;
  }
  return pending;
}

// The core hard-stop planning gate: once an artifact is authored and awaiting
// the human's first decision, the planning team may NOT author the next one
// until the human approves. Returns the artifact holding the pipeline, or null
// when planning may proceed (nothing authored-and-undecided). A DENIED artifact
// does not block — revising it is exactly what the planner should do next.
// Ledger+files only (core-readable, no SQLite).
export function isAwaitingHumanApproval(cwd: string, name: string): ArtifactId | null {
  return pendingReviewArtifact(cwd, name);
}

function isSpecsGlob(relPath: string): boolean {
  return relPath.startsWith("specs/") && relPath.includes("*") && relPath.endsWith(".md");
}

function readSpecsBundle(cwd: string, name: string, relRoot = "specs"): string {
  const parts: string[] = [];
  let total = 0;
  for (const file of listSpecArtifacts(cwd, name, relRoot)) {
    const text = readArtifact(cwd, name, file);
    if (!text) continue;
    const chunk = `## ${file}\n\n${text.trim()}\n`;
    total += Buffer.byteLength(chunk, "utf8");
    if (total > MAX_ARTIFACT_BYTES) return "";
    parts.push(chunk);
  }
  return parts.join("\n");
}

function listSpecArtifacts(cwd: string, name: string, relRoot = "specs"): string[] {
  if (!isSafeChangeId(name)) return [];
  const rootTarget = resolveArtifact(cwd, name, relRoot);
  if (!rootTarget || !relRoot.startsWith("specs")) return [];
  const root = rootTarget;
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 8 || out.length >= 200) return;
    let entries: FsDirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as FsDirent[];
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= 200) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = join(dir, entry.name);
      if (entry.isDirectory()) walk(childAbs, childRel, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(`specs/${childRel}`);
    }
  };
  walk(root, relRoot.replace(/^specs\/?/, ""), 0);
  return out;
}

// The markdown artifact files present in a change folder. Includes top-level
// proposal/design/tasks files plus concrete OpenSpec spec files under specs/.
export function listArtifacts(cwd: string, name: string): string[] {
  if (!isSafeChangeId(name)) return [];
  try {
    const topLevel = (readdirSync(join(cwd, "openspec", "changes", name), { withFileTypes: true }) as FsDirent[])
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name);
    return [...topLevel, ...listSpecArtifacts(cwd, name)].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
