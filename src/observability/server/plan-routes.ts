import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import * as openspec from "../../engine/openspec";
import { latestVerdict, listVerdicts } from "./db";

// OpenSpec-backed read routes for the dashboard. CLI-backed reads are async,
// content-versioned, and shared across identical concurrent requests so they
// never block Bun's request loop or launch duplicate validators.

export interface PlanSummary {
  changeId: string;
  status: openspec.ChangeTaskStatus;
  completedTasks: number;
  totalTasks: number;
  lastModified?: string;
  latestVerdict: ReturnType<typeof latestVerdict>;
}

export interface PlanRouteOptions { signal?: AbortSignal }

type CachedOpenSpecDetail = {
  detail: openspec.ChangeDetail | null;
  validation: openspec.ValidateResult;
};

type SharedEntry<T> = {
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
  settled: boolean;
};

const resultCache = new Map<string, unknown>();
const inFlight = new Map<string, SharedEntry<unknown>>();
const MAX_CACHE_ENTRIES = 128;
const MAX_FINGERPRINT_FILES = 4096;

function remember<T>(key: string, value: T): T {
  resultCache.delete(key);
  resultCache.set(key, value);
  while (resultCache.size > MAX_CACHE_ENTRIES) resultCache.delete(resultCache.keys().next().value!);
  return value;
}

function cancelled(): openspec.OpenSpecCommandError {
  return new openspec.OpenSpecCommandError("cancelled", "OpenSpec request was cancelled");
}

async function fingerprint(cwd: string, roots: string[], signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  let files = 0;
  const walk = async (path: string): Promise<void> => {
    if (signal?.aborted) throw cancelled();
    let stat;
    try { stat = await lstat(path); } catch { hash.update(`missing:${relative(cwd, path)}\n`); return; }
    const rel = relative(cwd, path);
    hash.update(`${rel}:${stat.mode}:${stat.size}:${stat.mtimeMs}\n`);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++files > MAX_FINGERPRINT_FILES) throw new openspec.OpenSpecCommandError("output-limit", "OpenSpec tree contains too many files");
      await walk(join(path, entry.name));
    }
  };
  for (const root of roots) await walk(join(cwd, root));
  return hash.digest("hex");
}

function waitForShared<T>(entry: SharedEntry<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(cancelled());
  entry.waiters++;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", onAbort);
      entry.waiters--;
      if (!entry.settled && entry.waiters === 0) entry.controller.abort();
    };
    const onAbort = () => { release(); rejectPromise(cancelled()); };
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (value) => { if (!released) { release(); resolvePromise(value); } },
      (error) => { if (!released) { release(); rejectPromise(error); } },
    );
  });
}

async function cachedShared<T>(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (resultCache.has(key)) return resultCache.get(key) as T;
  let entry = inFlight.get(key) as SharedEntry<T> | undefined;
  if (!entry) {
    const controller = new AbortController();
    const promise = load(controller.signal).then((value) => remember(key, value));
    entry = { controller, promise, waiters: 0, settled: false };
    inFlight.set(key, entry as SharedEntry<unknown>);
    const cleanup = () => {
      entry!.settled = true;
      if (inFlight.get(key) === entry) inFlight.delete(key);
    };
    void promise.then(cleanup, cleanup);
  }
  return waitForShared(entry, signal);
}

export function clearPlanRouteCaches(): void {
  resultCache.clear();
  for (const entry of inFlight.values()) entry.controller.abort();
  inFlight.clear();
}

export async function listPlans(cwd: string, options: PlanRouteOptions = {}): Promise<PlanSummary[]> {
  const version = await fingerprint(cwd, ["openspec/config.yaml", "openspec/changes"], options.signal);
  const changes = await cachedShared(`list:${cwd}:${version}`, (signal) => openspec.listChangesAsync(cwd, signal), options.signal);
  return changes.map((change) => ({
    changeId: change.name,
    status: change.status,
    completedTasks: change.completedTasks,
    totalTasks: change.totalTasks,
    lastModified: change.lastModified,
    latestVerdict: latestVerdict(change.name, cwd),
  }));
}

// Per-artifact review state encoding the two-stage flow: the reviewer AGENT
// vets an authored artifact first, then the HUMAN signs off in the dashboard.
export interface ArtifactReview {
  id: string;
  authored: boolean;
  agentCleared: boolean;
  humanVerdict: "green" | "red" | null;
  humanReviewReady: boolean;
}

export interface PlanDetail {
  changeId: string;
  artifacts: openspec.ArtifactState[];
  artifactReview: ArtifactReview[];
  nextReady: string | null;
  files: string[];
  validation: { passed: boolean; failed: number; issues: openspec.ValidateIssue[] };
  readyToExecute: boolean;
  taskProgress: openspec.ExecutionTaskProgress[];
  verdicts: ReturnType<typeof listVerdicts>;
}

function agentClearedArtifact(cwd: string, changeId: string, artifact: string): boolean {
  const verdict = openspec.agentReviewVerdict(cwd, changeId, artifact);
  return verdict === "green" || verdict === "yellow";
}

export async function planDetail(cwd: string, changeId: string, options: PlanRouteOptions = {}): Promise<PlanDetail | null> {
  if (!openspec.changeExists(cwd, changeId)) return null;
  const version = await fingerprint(cwd, ["openspec/config.yaml", "openspec/specs", `openspec/changes/${changeId}`], options.signal);
  const loaded = await cachedShared<CachedOpenSpecDetail>(`detail:${cwd}:${changeId}:${version}`, async (signal) => {
    const [detail, validation] = await Promise.all([
      openspec.changeDetailAsync(cwd, changeId, signal),
      openspec.validateAsync(cwd, changeId, signal),
    ]);
    return { detail, validation };
  }, options.signal);
  if (!loaded.detail) return null;

  const artifactReview: ArtifactReview[] = loaded.detail.artifacts.map((artifact) => {
    const authored = artifact.status === "done";
    const humanVerdict = openspec.artifactVerdict(cwd, changeId, artifact.id);
    const agentCleared = authored && agentClearedArtifact(cwd, changeId, artifact.id);
    return {
      id: artifact.id,
      authored,
      agentCleared,
      humanVerdict,
      humanReviewReady: authored && agentCleared && humanVerdict !== "green",
    };
  });
  return {
    changeId,
    artifacts: loaded.detail.artifacts,
    artifactReview,
    nextReady: loaded.detail.nextReady,
    files: openspec.listArtifacts(cwd, changeId),
    validation: loaded.validation,
    readyToExecute: openspec.isReadyToExecuteWithValidation(cwd, changeId, loaded.validation),
    taskProgress: openspec.executionTaskProgress(cwd, changeId),
    verdicts: listVerdicts(changeId, cwd),
  };
}

export interface PlanFile {
  content: string | null;
  truncated: boolean;
  size: number;
}

const MAX_FILE_BYTES = 512_000;

export function planFile(cwd: string, changeId: string, relPath: string): PlanFile | null {
  const target = openspec.resolveArtifact(cwd, changeId, relPath);
  if (!target) return null;
  const content = openspec.readArtifact(cwd, changeId, relPath);
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_FILE_BYTES) return { content: null, truncated: true, size };
  return { content, truncated: false, size };
}
