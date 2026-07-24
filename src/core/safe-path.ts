import { lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";

export type PathApi = Pick<typeof path, "isAbsolute" | "relative" | "resolve" | "dirname" | "basename" | "sep">;

export interface ContainedPath {
  lexicalPath: string;
  canonicalPath: string;
  exists: boolean;
}

export interface ContainedPathOptions {
  allowMissing?: boolean;
}

// Segment-aware containment. Unlike startsWith(), this cannot confuse
// /project/app with /project/application and works with either POSIX or win32
// path semantics in pure unit tests.
export function isPathInside(parent: string, child: string, pathApi: PathApi = path): boolean {
  const rel = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(child));
  return rel === "" || (!rel.startsWith(`..${pathApi.sep}`) && rel !== ".." && !pathApi.isAbsolute(rel));
}

function existsLexically(value: string): boolean {
  try {
    lstatSync(value);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

export function resolveCanonicalPath(value: string, options: ContainedPathOptions = {}): ContainedPath | null {
  const lexicalPath = path.resolve(value);
  const exists = existsLexically(lexicalPath);
  if (exists) {
    try {
      return { lexicalPath, canonicalPath: realpathSync.native(lexicalPath), exists: true };
    } catch {
      // Broken links, loops, and permission failures are indeterminate and must
      // never become an authorization success.
      return null;
    }
  }
  if (options.allowMissing !== true) return null;

  let ancestor = lexicalPath;
  while (!existsLexically(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return null;
    ancestor = parent;
  }
  let canonicalAncestor: string;
  try {
    canonicalAncestor = realpathSync.native(ancestor);
  } catch {
    return null;
  }
  const suffix = path.relative(ancestor, lexicalPath);
  return {
    lexicalPath,
    canonicalPath: path.resolve(canonicalAncestor, suffix),
    exists: false,
  };
}

export function hasForeignAbsoluteSyntax(value: string): boolean {
  if (process.platform === "win32") return path.posix.isAbsolute(value) && !path.win32.isAbsolute(value);
  return path.win32.isAbsolute(value) && !path.posix.isAbsolute(value);
}

// Resolve a path only when BOTH its lexical location and its real filesystem
// destination remain under root. Existing paths use realpath. Missing targets
// are projected from their nearest existing realpath parent, which catches a
// symlinked ancestor escaping the allowed tree before a file is created.
export function resolveContainedPath(root: string, candidate: string, options: ContainedPathOptions = {}): ContainedPath | null {
  if (!root || !candidate || hasForeignAbsoluteSyntax(root) || hasForeignAbsoluteSyntax(candidate)) return null;
  const lexicalRoot = path.resolve(root);
  const lexicalCandidate = path.resolve(candidate);

  // A configured root may itself be new (for example a not-yet-created tests/
  // domain), so canonicalize it through its nearest existing parent. Darwin's
  // /var -> /private/var alias also means trusted callers may already hold the
  // canonical candidate while retaining the original lexical project root.
  const canonicalRoot = resolveCanonicalPath(lexicalRoot, { allowMissing: true });
  if (!canonicalRoot || (!isPathInside(lexicalRoot, lexicalCandidate) && !isPathInside(canonicalRoot.canonicalPath, lexicalCandidate))) return null;
  const canonicalCandidate = resolveCanonicalPath(lexicalCandidate, options);
  if (!canonicalCandidate) return null;
  if (!isPathInside(canonicalRoot.canonicalPath, canonicalCandidate.canonicalPath)) return null;
  return canonicalCandidate;
}

export function resolveConfiguredPath(projectRoot: string, requestedPath: string, allowOutsideProject = false, options: ContainedPathOptions = {}): ContainedPath | null {
  if (!requestedPath || hasForeignAbsoluteSyntax(requestedPath)) return null;
  if (!allowOutsideProject) return resolveProjectPath(projectRoot, requestedPath, options);
  const candidate = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(projectRoot, requestedPath);
  return resolveCanonicalPath(candidate, options);
}

export function resolveProjectPath(projectRoot: string, requestedPath: string, options: ContainedPathOptions = {}): ContainedPath | null {
  if (!requestedPath || hasForeignAbsoluteSyntax(requestedPath)) return null;
  const candidate = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(projectRoot, requestedPath);
  return resolveContainedPath(projectRoot, candidate, options);
}
