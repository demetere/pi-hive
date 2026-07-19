import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { canonicalJson } from "../config/snapshot-canonical";
import { resolveCanonicalPath } from "../core/safe-path";

export const ARTIFACT_HASH_VERSION = 1 as const;
export const ARTIFACT_HASH_LIMITS = Object.freeze({
  files: 2_048,
  pathBytes: 262_144,
  fileBytes: 33_554_432,
  aggregateBytes: 67_108_864,
  depth: 128,
});

export interface ArtifactHashEntryV1 {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly bytes: number;
  readonly hash: string;
}
export interface ArtifactWorkspaceHashesV1 {
  readonly schemaVersion: 1;
  readonly algorithm: "sha256";
  readonly workspaceHash: string;
  readonly entries: readonly ArtifactHashEntryV1[];
}

const digest = (domain: string, value: string | Buffer): string => `sha256:${createHash("sha256").update(`${domain}\0`).update(value).digest("hex")}`;

function safeRelative(root: string, path: string): string {
  const result = relative(root, path).split("\\").join("/");
  if (!result || result.startsWith("../") || result === "..") throw new Error("Artifact workspace hash path escaped its canonical root");
  return result;
}

/**
 * Read a deterministic, bounded physical workspace snapshot. Symlinks and
 * non-regular filesystem objects fail closed so hashes never follow authority
 * outside the adapter-owned tree.
 */
export function hashArtifactWorkspace(workspacePath: string): ArtifactWorkspaceHashesV1 {
  const suppliedRoot = lstatSync(workspacePath);
  if (suppliedRoot.isSymbolicLink()) throw new Error("Artifact workspace root symlink is denied");
  const canonical = resolveCanonicalPath(workspacePath);
  if (!canonical?.exists) throw new Error("Artifact workspace does not exist or cannot be canonically resolved");
  const rootStat = lstatSync(canonical.canonicalPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Artifact workspace root must be a physical directory");

  const entries: ArtifactHashEntryV1[] = [Object.freeze({ path: ".", kind: "directory", bytes: 0, hash: digest("pi-hive-artifact-directory-v1", ".") })];
  const stack: Array<{ path: string; depth: number }> = [{ path: canonical.canonicalPath, depth: 0 }];
  let pathBytes = 0;
  let aggregateBytes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > ARTIFACT_HASH_LIMITS.depth) throw new Error("Artifact workspace exceeds hash depth limit");
    const names = readdirSync(current.path).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (let index = names.length - 1; index >= 0; index--) {
      const name = names[index];
      const path = resolve(current.path, name);
      const rel = safeRelative(canonical.canonicalPath, path);
      pathBytes += Buffer.byteLength(rel, "utf8");
      if (pathBytes > ARTIFACT_HASH_LIMITS.pathBytes) throw new Error("Artifact workspace exceeds aggregate hash path limit");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Artifact workspace hash refuses symlink: ${rel}`);
      if (stat.isDirectory()) {
        entries.push(Object.freeze({ path: rel, kind: "directory", bytes: 0, hash: digest("pi-hive-artifact-directory-v1", rel) }));
        stack.push({ path, depth: current.depth + 1 });
      } else if (stat.isFile()) {
        if (stat.size > ARTIFACT_HASH_LIMITS.fileBytes) throw new Error(`Artifact workspace file exceeds hash limit: ${rel}`);
        aggregateBytes += stat.size;
        if (aggregateBytes > ARTIFACT_HASH_LIMITS.aggregateBytes) throw new Error("Artifact workspace exceeds aggregate hash byte limit");
        let fd: number | undefined;
        try {
          fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          const opened = fstatSync(fd);
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error(`Artifact workspace changed during hash read: ${rel}`);
          const content = readFileSync(fd);
          const after = fstatSync(fd);
          if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error(`Artifact workspace changed during hash read: ${rel}`);
          entries.push(Object.freeze({ path: rel, kind: "file", bytes: content.length, hash: digest("pi-hive-artifact-file-v1", content) }));
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      } else {
        throw new Error(`Artifact workspace contains unsupported filesystem object: ${rel}`);
      }
      if (entries.length > ARTIFACT_HASH_LIMITS.files) throw new Error("Artifact workspace exceeds hash entry limit");
    }
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : 1);
  const frozenEntries = Object.freeze(entries);
  const workspaceHash = digest("pi-hive-artifact-workspace-v1", canonicalJson(frozenEntries));
  return Object.freeze({ schemaVersion: ARTIFACT_HASH_VERSION, algorithm: "sha256", workspaceHash, entries: frozenEntries });
}

export function isArtifactHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

export function requireExpectedArtifactHash(expected: unknown, current: ArtifactWorkspaceHashesV1): string {
  if (!isArtifactHash(expected)) throw new Error("Expected artifact workspace hash is required");
  if (expected !== current.workspaceHash) throw new Error("Artifact workspace hash conflict");
  return expected;
}
