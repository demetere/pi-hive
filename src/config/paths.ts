import { lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { resolveContainedPath, type ContainedPath } from "../core/safe-path";
import type { ConfigDiagnosticCode } from "./diagnostics";

export const CONFIG_REGISTRY_LIMITS = Object.freeze({
  declaredPathBytes: 4_096,
  pathSegments: 128,
  discoveryAncestors: 256,
  registryEntries: 4_096,
  aggregateDeclaredPathBytes: 524_288,
  dependencyNodes: 4_096,
  dependencyEdges: 20_000,
  renderedDiagnosticsBytes: 262_144,
});

export type ResourceKind = "agents" | "workflows" | "skills" | "knowledge";
export type DeclaredPathResult =
  | { ok: true; normalized: string }
  | { ok: false; code: "CONFIG_PATH_INVALID" | "CONFIG_PATH_TOO_LONG" | "CONFIG_PATH_TOO_DEEP" };

function containsNonPortableCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (`<>:"|?*`.includes(character) || code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function isReservedWindowsSegment(segment: string): boolean {
  if (segment.endsWith(".") || segment.endsWith(" ")) return true;
  const base = segment.split(".", 1)[0].toUpperCase();
  return base === "CON" || base === "PRN" || base === "AUX" || base === "NUL"
    || /^COM[1-9¹²³]$/u.test(base) || /^LPT[1-9¹²³]$/u.test(base);
}

export function validateDeclaredResourcePath(kind: ResourceKind, declared: string): DeclaredPathResult {
  if (Buffer.byteLength(declared, "utf8") > CONFIG_REGISTRY_LIMITS.declaredPathBytes)
    return { ok: false, code: "CONFIG_PATH_TOO_LONG" };
  if (!declared || containsNonPortableCharacter(declared) || declared.includes("\\") || isAbsolute(declared) || win32.isAbsolute(declared))
    return { ok: false, code: "CONFIG_PATH_INVALID" };

  const directory = kind === "skills" || kind === "knowledge";
  if (declared.endsWith("/") && !directory) return { ok: false, code: "CONFIG_PATH_INVALID" };
  const normalized = directory && declared.endsWith("/") ? declared.slice(0, -1) : declared;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || isReservedWindowsSegment(segment)))
    return { ok: false, code: "CONFIG_PATH_INVALID" };
  if (segments.length > CONFIG_REGISTRY_LIMITS.pathSegments)
    return { ok: false, code: "CONFIG_PATH_TOO_DEEP" };
  return { ok: true, normalized };
}

export type RegistryTargetResult =
  | {
      ok: true;
      normalized: string;
      projectPath: string;
      canonicalPath: string;
      exists: true;
    }
  | {
      ok: false;
      code: ConfigDiagnosticCode;
      normalized?: string;
      projectPath?: string;
      canonicalPath?: string;
      exists?: boolean;
    };

export interface RegistryPathOperations {
  resolveContained?(root: string, candidate: string): ContainedPath | null;
  lstat?(path: string): Stats;
  stat?(path: string): Stats;
  realpath?(path: string): string;
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function failureForError(error: unknown): "RESOURCE_NOT_FOUND" | "RESOURCE_ACCESS_FAILED" {
  return nodeErrorCode(error) === "ENOENT" || nodeErrorCode(error) === "ENOTDIR"
    ? "RESOURCE_NOT_FOUND"
    : "RESOURCE_ACCESS_FAILED";
}

export function resolveRegistryTarget(
  projectRoot: string,
  configDirectory: string,
  kind: ResourceKind,
  declared: string,
  operations: RegistryPathOperations = {},
): RegistryTargetResult {
  const lexical = validateDeclaredResourcePath(kind, declared);
  if (!lexical.ok) return lexical;
  if (kind === "workflows") {
    const parts = lexical.normalized.split("/");
    if (parts.length !== 2 || parts[0] !== "workflows" || parts[1].length <= ".yaml".length || !parts[1].endsWith(".yaml"))
      return { ok: false, code: "WORKFLOW_PATH_INVALID" };
  }

  const candidate = resolve(configDirectory, ...lexical.normalized.split("/"));
  const resolveContained = operations.resolveContained
    ?? ((root: string, value: string) => resolveContainedPath(root, value, { allowMissing: true }));
  let contained: ContainedPath | null;
  try {
    contained = resolveContained(projectRoot, candidate);
  } catch (error: unknown) {
    return { ok: false, code: failureForError(error) };
  }
  if (!contained) {
    try {
      (operations.lstat ?? lstatSync)(candidate);
      try {
        (operations.realpath ?? realpathSync.native)(candidate);
        return { ok: false, code: "RESOURCE_PATH_ESCAPE" };
      } catch (error: unknown) {
        return { ok: false, code: failureForError(error) };
      }
    } catch (error: unknown) {
      // A genuinely missing path is projected successfully by resolveContainedPath.
      // Null here means an escaping/broken ancestor unless inspection itself failed.
      const code = nodeErrorCode(error);
      return { ok: false, code: code === "ENOENT" || code === "ENOTDIR" ? "RESOURCE_PATH_ESCAPE" : "RESOURCE_ACCESS_FAILED" };
    }
  }
  const projectPath = relative(projectRoot, contained.lexicalPath).split("\\").join("/");
  if (!contained.exists)
    return { ok: false, code: "RESOURCE_NOT_FOUND", normalized: lexical.normalized, projectPath, canonicalPath: contained.canonicalPath, exists: false };

  let stats: Stats;
  try {
    (operations.lstat ?? lstatSync)(contained.lexicalPath);
    stats = (operations.stat ?? statSync)(contained.lexicalPath);
  } catch (error: unknown) {
    return {
      ok: false,
      code: failureForError(error),
      normalized: lexical.normalized,
      projectPath,
      canonicalPath: contained.canonicalPath,
    };
  }
  const expected = kind === "agents" || kind === "workflows" ? stats.isFile() : stats.isDirectory();
  if (!expected)
    return { ok: false, code: "RESOURCE_TYPE_MISMATCH", normalized: lexical.normalized, projectPath, canonicalPath: contained.canonicalPath, exists: true };
  return { ok: true, normalized: lexical.normalized, projectPath, canonicalPath: contained.canonicalPath, exists: true };
}
