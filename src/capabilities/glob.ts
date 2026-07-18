export const FILESYSTEM_GLOB_LIMITS = Object.freeze({
  patterns: 64,
  patternBytes: 4_096,
  segments: 128,
  pathBytes: 4_096,
});

type CompiledSegment = Readonly<{ globstar: true } | { globstar: false; expression: RegExp }>;
export interface CompiledFilesystemGlob {
  readonly pattern: string;
  readonly segments: readonly CompiledSegment[];
}

function invalid(code: "FILESYSTEM_GLOB_INVALID" | "FILESYSTEM_GLOB_LIMIT_EXCEEDED" | "FILESYSTEM_PATH_INVALID"): never {
  throw new Error(code);
}

function hasControl(value: string): boolean {
  for (const character of value) if (character.codePointAt(0)! <= 0x1f || character.codePointAt(0) === 0x7f) return true;
  return false;
}

function normalizeSegments(value: string, kind: "glob" | "path"): string[] {
  const normalized = value.normalize("NFC");
  const byteLimit = kind === "glob" ? FILESYSTEM_GLOB_LIMITS.patternBytes : FILESYSTEM_GLOB_LIMITS.pathBytes;
  const invalidCode = kind === "glob" ? "FILESYSTEM_GLOB_INVALID" : "FILESYSTEM_PATH_INVALID";
  if (!normalized || Buffer.byteLength(normalized, "utf8") > byteLimit) {
    if (Buffer.byteLength(normalized, "utf8") > byteLimit) invalid("FILESYSTEM_GLOB_LIMIT_EXCEEDED");
    invalid(invalidCode);
  }
  if (normalized === "." && kind === "path") return [];
  if (normalized === "." || normalized.startsWith("/") || normalized.startsWith("./") || normalized.includes("\\") || normalized.includes("//") || hasControl(normalized)) invalid(invalidCode);
  const segments = normalized.split("/");
  if (segments.length > FILESYSTEM_GLOB_LIMITS.segments) invalid("FILESYSTEM_GLOB_LIMIT_EXCEEDED");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) invalid(invalidCode);
  return segments;
}

export function normalizeFilesystemRelativePath(value: string): string {
  if (typeof value !== "string") invalid("FILESYSTEM_PATH_INVALID");
  const segments = normalizeSegments(value, "path");
  if (segments.some((segment) => segment.includes("*") || segment.includes("?") || segment.includes(":"))) invalid("FILESYSTEM_PATH_INVALID");
  return segments.length === 0 ? "." : segments.join("/");
}

function escapeRegExp(value: string): string { return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"); }

function compileSegment(segment: string): CompiledSegment {
  if (segment === "**") return Object.freeze({ globstar: true });
  if (segment.includes("**") || segment.includes("[") || segment.includes("]") || /[{}()]/.test(segment)) invalid("FILESYSTEM_GLOB_INVALID");
  let source = "^";
  for (const character of segment) {
    if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += escapeRegExp(character);
  }
  source += "$";
  return Object.freeze({ globstar: false, expression: new RegExp(source, "u") });
}

export function compileFilesystemGlob(pattern: string): CompiledFilesystemGlob {
  if (typeof pattern !== "string") invalid("FILESYSTEM_GLOB_INVALID");
  const normalized = pattern.normalize("NFC");
  if (normalized.startsWith("!") || normalized.includes(":")) invalid("FILESYSTEM_GLOB_INVALID");
  const segments = normalizeSegments(normalized, "glob");
  const compiled = Object.freeze(segments.map(compileSegment));
  return Object.freeze({ pattern: segments.join("/"), segments: compiled });
}

export function compileFilesystemGlobList(patterns: readonly string[]): readonly CompiledFilesystemGlob[] {
  if (!Array.isArray(patterns) || patterns.length > FILESYSTEM_GLOB_LIMITS.patterns) invalid("FILESYSTEM_GLOB_LIMIT_EXCEEDED");
  return Object.freeze(patterns.map(compileFilesystemGlob));
}

export function matchFilesystemGlob(glob: CompiledFilesystemGlob, value: string): boolean {
  const normalized = normalizeFilesystemRelativePath(value);
  const pathSegments = normalized === "." ? [] : normalized.split("/");
  const memo = new Map<string, boolean>();
  const visit = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${patternIndex}:${pathIndex}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (patternIndex === glob.segments.length) result = pathIndex === pathSegments.length;
    else {
      const segment = glob.segments[patternIndex];
      result = segment.globstar
        ? visit(patternIndex + 1, pathIndex) || (pathIndex < pathSegments.length && visit(patternIndex, pathIndex + 1))
        : pathIndex < pathSegments.length && segment.expression.test(pathSegments[pathIndex]) && visit(patternIndex + 1, pathIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}
