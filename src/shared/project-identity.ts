import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { projectName } from "./project";

export interface ProjectIdentity {
  projectId: string;
  canonicalRoot: string;
  displayLabel: string;
}

export interface ProjectIdentityOptions {
  platform?: NodeJS.Platform;
  realpath?: (path: string) => string;
  gitRoot?: (canonicalCwd: string) => string | undefined;
}

const identityCache = new Map<string, ProjectIdentity>();

function identityKey(canonicalRoot: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return `win32:${win32.normalize(canonicalRoot).replace(/\\/g, "/").toLowerCase()}`;
  }
  return `${platform}:${canonicalRoot}`;
}

export function projectIdFromCanonicalRoot(canonicalRoot: string, platform: NodeJS.Platform = process.platform): string {
  return createHash("sha256")
    .update("pi-hive-project-v1\0")
    .update(identityKey(canonicalRoot, platform))
    .digest("hex");
}

function defaultGitRoot(canonicalCwd: string): string | undefined {
  const result = spawnSync("git", ["-C", canonicalCwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.status !== 0) return undefined;
  const root = result.stdout.trim();
  return root || undefined;
}

function displayLabel(canonicalRoot: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const name = win32.basename(canonicalRoot);
    const parent = win32.basename(win32.dirname(canonicalRoot));
    return projectName(parent ? `${parent}/${name}` : name);
  }
  return projectName(canonicalRoot) || basename(canonicalRoot) || canonicalRoot;
}

export function resolveProjectIdentity(cwd: string, options: ProjectIdentityOptions = {}): ProjectIdentity {
  if (!cwd || !cwd.trim()) throw new Error("Project cwd is required");
  const platform = options.platform ?? process.platform;
  const resolveRealpath = options.realpath ?? ((value: string) => realpathSync.native(value));
  const cacheKey = options.realpath || options.gitRoot || options.platform ? undefined : `${platform}:${cwd}`;
  if (cacheKey) {
    const cached = identityCache.get(cacheKey);
    if (cached) return cached;
  }

  const canonicalCwd = resolveRealpath(cwd);
  const discoveredRoot = (options.gitRoot ?? defaultGitRoot)(canonicalCwd);
  const canonicalRoot = discoveredRoot ? resolveRealpath(discoveredRoot) : canonicalCwd;
  const identity: ProjectIdentity = {
    projectId: projectIdFromCanonicalRoot(canonicalRoot, platform),
    canonicalRoot,
    displayLabel: displayLabel(canonicalRoot, platform),
  };
  if (cacheKey) identityCache.set(cacheKey, identity);
  return identity;
}

export function tryResolveProjectIdentity(cwd?: string): ProjectIdentity | undefined {
  if (!cwd) return undefined;
  try {
    return resolveProjectIdentity(cwd);
  } catch {
    return undefined;
  }
}

export function clearProjectIdentityCache(): void {
  identityCache.clear();
}
