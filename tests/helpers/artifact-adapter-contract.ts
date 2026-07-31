import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { ArtifactFacadeError } from "../../src/artifacts/facade.ts";
import { isPathInside, resolveContainedPath } from "../../src/core/safe-path.ts";
import type { ArtifactAdapter } from "../../src/artifacts/types.ts";

const FORBIDDEN_ADAPTER_KEYS = new Set([
  "model", "invokeModel", "delegate", "delegateAgent", "route", "routeAgent",
  "transcript", "readTranscript", "workflow", "setRunState", "setSessionState",
]);

/** Reusable W16 contract assertions for every repository-built adapter. */
export function assertArtifactAdapterContract(adapter: ArtifactAdapter): void {
  assert.equal(typeof adapter.id, "string");
  assert.equal(typeof adapter.version, "string");
  assert.ok(adapter.profiles.length > 0);
  for (const key of Reflect.ownKeys(adapter)) {
    assert.equal(FORBIDDEN_ADAPTER_KEYS.has(String(key)), false, `adapter exposes forbidden orchestration hook ${String(key)}`);
  }
  for (const profile of adapter.profiles) {
    assert.equal(profile.adapterId, adapter.id);
    assert.equal(profile.adapterVersion, adapter.version);
    assert.equal(new Set(profile.actions.map((action) => action.id)).size, profile.actions.length);
    assert.equal(profile.actions.every((action) => action.completion === "mandatory" || action.completion === "optional"), true);
  }
}

/** Reusable check that the facade detects a declared mutation outside the bound workspace. */
export async function assertArtifactWorkspaceEscapeRejected(invoke: () => Promise<unknown>): Promise<void> {
  await assert.rejects(invoke, (error: unknown) => error instanceof ArtifactFacadeError && error.code === "WORKSPACE_ESCAPE");
}

interface FilesystemEntrySnapshot { readonly kind: "directory" | "file" | "symlink" | "other"; readonly mode: number; readonly digest?: string; readonly target?: string }
const HARNESS_ENTRY_LIMIT = 10_000;
const HARNESS_FILE_BYTES = 8 * 1024 * 1024;
function snapshotFilesystem(root: string): ReadonlyMap<string, FilesystemEntrySnapshot> {
  const entries = new Map<string, FilesystemEntrySnapshot>();
  const walk = (path: string): void => {
    if (entries.size >= HARNESS_ENTRY_LIMIT) throw new Error("Artifact contract harness filesystem entry limit exceeded");
    const stat = lstatSync(path);
    const key = relative(root, path) || ".";
    if (stat.isSymbolicLink()) {
      entries.set(key, Object.freeze({ kind: "symlink", mode: stat.mode, target: readlinkSync(path) }));
      return;
    }
    if (stat.isDirectory()) {
      entries.set(key, Object.freeze({ kind: "directory", mode: stat.mode }));
      for (const name of readdirSync(path).sort()) walk(resolve(path, name));
      return;
    }
    if (stat.isFile()) {
      if (stat.size > HARNESS_FILE_BYTES) throw new Error(`Artifact contract harness file exceeds snapshot limit: ${key}`);
      entries.set(key, Object.freeze({ kind: "file", mode: stat.mode, digest: createHash("sha256").update(readFileSync(path)).digest("hex") }));
      return;
    }
    entries.set(key, Object.freeze({ kind: "other", mode: stat.mode }));
  };
  walk(resolve(root));
  return entries;
}
function changedFilesystemPaths(before: ReadonlyMap<string, FilesystemEntrySnapshot>, after: ReadonlyMap<string, FilesystemEntrySnapshot>): readonly string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => JSON.stringify(before.get(path)) !== JSON.stringify(after.get(path))).sort();
}

/**
 * Real adapter-action containment harness. It snapshots the whole isolated fixture filesystem,
 * then rejects every changed path outside the workspace and every changed symlink that resolves out.
 */
export async function assertArtifactActionFilesystemContained(input: {
  readonly filesystemRoot: string;
  readonly workspacePath: string;
  readonly invoke: () => unknown | Promise<unknown>;
}): Promise<void> {
  const filesystemRoot = realpathSync.native(resolve(input.filesystemRoot));
  const workspacePath = realpathSync.native(resolve(input.workspacePath));
  assert.ok(isPathInside(filesystemRoot, workspacePath), "workspace must be inside the isolated harness filesystem");
  const before = snapshotFilesystem(filesystemRoot);
  let invocationError: unknown;
  try { await input.invoke(); }
  catch (error) { invocationError = error; }
  const after = snapshotFilesystem(filesystemRoot);
  const escaped = changedFilesystemPaths(before, after).filter((path) => {
    const absolute = resolve(filesystemRoot, path);
    if (!isPathInside(workspacePath, absolute)) return true;
    const entry = after.get(path);
    return entry?.kind === "symlink" && !resolveContainedPath(workspacePath, absolute);
  });
  assert.deepEqual(escaped, [], `adapter action mutated outside its bound workspace: ${escaped.join(", ")}`);
  if (invocationError !== undefined) throw invocationError;
}

/** Artifact modules may depend on data/policy primitives, never orchestration engines. */
export function assertArtifactModuleBoundary(paths: readonly string[]): void {
  const forbidden = /(?:from\s+["'][^"']*(?:engine\/(?:dispatch|routing|session)|workflows\/orchestration)|@earendil-works\/pi-coding-agent|\b(?:invokeModel|delegateAgent|routeAgent)\b)/u;
  for (const path of paths) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, forbidden, `${relative(process.cwd(), resolve(path))} crosses the artifact lifecycle boundary`);
  }
}
