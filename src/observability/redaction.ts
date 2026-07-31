import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import type { JsonValue } from "../config/types";

export const TELEMETRY_REDACTED = "[REDACTED]" as const;

export type WorkflowRedactionMode = "journal-pre-persistence" | "authoritative-projection";

export interface WorkflowRedactionOptions {
  /** Projection mode is deterministic and never reads or applies process/configured secrets. */
  readonly mode?: WorkflowRedactionMode;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly protectedPaths?: readonly string[];
  /** Canonical project root used to match absolute and project-relative path spellings. */
  readonly projectRoot?: string;
  readonly maxStringBytes?: number;
  readonly maxArrayItems?: number;
  readonly maxObjectKeys?: number;
  readonly maxDepth?: number;
}

const SENSITIVE_KEY = /^(?:cookie|set-cookie|api[-_]?key|x[-_]?(?:api[-_]?key|auth[-_]?token)|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|passwd|secret|private[-_]?key|client[-_]?secret|credential|credentials)$/iu;
const AUTH_HEADER_KEY = /^(?:authorization|proxy-authorization)$/iu;
const SENSITIVE_ENV_KEY = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)(?:$|_)/iu;
const OMITTED_PROJECTION_FIELD = /^(?:transcript|transcriptText|prompt|promptText|messages|conversation|toolArgs|toolArguments|toolResult|toolResults|arguments|args|resultPayload|raw|rawContent)$/iu;
const PROTECTED_CONTENT_FIELD = /^(?:content|body|text|bytes|source|data|fileContent|raw|value)$/iu;
const PATH_KEY_TERMINALS = new Set(["path", "file", "filename", "directory", "dir", "root"]);

function pathField(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  if (!words.length) return false;
  const compact = words.join("");
  return PATH_KEY_TERMINALS.has(words.at(-1)!) || /^(?:canonical|config|source|target|workspace|working|artifact)?(?:path|file|filename|directory|dir|root)$/u.test(compact);
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

const REDACTION_POLICY_LIMITS = Object.freeze({ environmentEntries: 1_024, secrets: 128, secretCharacters: 8_192, secretBytes: 8_192, totalSecretBytes: 262_144, protectedPaths: 256, protectedPathBytes: 4_096 });

function secretValues(environment: Readonly<Record<string, string | undefined>>): readonly string[] {
  const output: string[] = [];
  let entries = 0;
  let totalBytes = 0;
  for (const [key, value] of Object.entries(environment)) {
    entries++;
    if (entries > REDACTION_POLICY_LIMITS.environmentEntries) throw new Error("Workflow redaction environment entry limit exceeded");
    if (key.length > 512 || !SENSITIVE_ENV_KEY.test(key) || value === undefined || value === "") continue;
    if (value.length < 4 || value.length > REDACTION_POLICY_LIMITS.secretCharacters) throw new Error("Workflow redaction secret length limit exceeded");
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > REDACTION_POLICY_LIMITS.secretBytes) throw new Error("Workflow redaction secret byte limit exceeded");
    totalBytes += bytes;
    if (output.length >= REDACTION_POLICY_LIMITS.secrets || totalBytes > REDACTION_POLICY_LIMITS.totalSecretBytes) throw new Error("Workflow redaction secret limit exceeded");
    output.push(value);
  }
  return output.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function redactText(value: string, secrets: readonly string[], maxBytes: number): string {
  let output = value
    .replace(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/giu, TELEMETRY_REDACTED)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/giu, `$1 ${TELEMETRY_REDACTED}`)
    .replace(/\b((?:api[-_]?key|x[-_]?(?:api[-_]?key|auth[-_]?token)|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|passwd|secret|client[-_]?secret|credential)\s*[=:]\s*)(["']?)[^\s,"';&]+\2/giu, `$1${TELEMETRY_REDACTED}`)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/giu, `$1${TELEMETRY_REDACTED}$2`);
  for (const secret of secrets) output = output.split(secret).join(TELEMETRY_REDACTED);
  return utf8Prefix(output, maxBytes);
}

function normalizedPath(value: string): string {
  const slash = value.replaceAll("\\", "/");
  const normalized = posix.normalize(slash);
  return normalized === "." ? "" : normalized.replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function canonicalExistingPath(value: string, projectRoot?: string): string | undefined {
  if (!projectRoot) return undefined;
  const absolute = isAbsolute(value) ? resolve(value) : resolve(projectRoot, value);
  let ancestor = absolute;
  const suffix: string[] = [];
  try {
    while (!existsSync(ancestor)) {
      try { if (lstatSync(ancestor).isSymbolicLink()) return undefined; } catch { /* absent component */ }
      const parent = dirname(ancestor);
      if (parent === ancestor) return undefined;
      suffix.unshift(ancestor.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
      ancestor = parent;
    }
    return normalizedPath(resolve(realpathSync.native(ancestor), ...suffix));
  } catch { return undefined; }
}

function pathSpellings(value: string, projectRoot?: string): readonly string[] | undefined {
  const normalized = normalizedPath(value);
  const output = new Set<string>([normalized]);
  if (projectRoot) {
    const canonicalRoot = canonicalExistingPath(projectRoot, projectRoot);
    const canonical = canonicalExistingPath(value, projectRoot);
    if (!canonicalRoot || !canonical) return undefined;
    const absolute = normalized.startsWith("/") ? normalized : normalizedPath(resolve(projectRoot, normalized));
    output.add(absolute); output.add(canonical);
    for (const candidate of [absolute, canonical]) {
      const projectRelative = normalizedPath(relative(canonicalRoot, candidate).replaceAll("\\", "/"));
      if (projectRelative && projectRelative !== ".." && !projectRelative.startsWith("../")) output.add(projectRelative);
    }
  }
  return [...output];
}

function pathProtected(value: string, protectedPaths: readonly string[], projectRoot?: string): boolean {
  const candidates = pathSpellings(value, projectRoot);
  if (!candidates) return true;
  return protectedPaths.some((root) => {
    const roots = pathSpellings(root, projectRoot);
    if (!roots) return true;
    return candidates.some((candidate) => roots.some((protectedRoot) => candidate === protectedRoot || candidate.startsWith(`${protectedRoot}/`)
      || (!isAbsolute(protectedRoot) && candidate.endsWith(`/${protectedRoot}`))));
  });
}

interface InternalOptions {
  readonly secrets: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly maxStringBytes: number;
  readonly maxArrayItems: number;
  readonly maxObjectKeys: number;
  readonly maxDepth: number;
  readonly omitProjectionFields: boolean;
  readonly projectRoot?: string;
}

function redactValue(value: unknown, options: InternalOptions, depth: number, seen: WeakSet<object>, protectedTaint = false): JsonValue {
  if (typeof value === "string") return redactText(value, options.secrets, options.maxStringBytes);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (value === undefined || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") return null;
  if (depth >= options.maxDepth) return "[TRUNCATED]";
  if (seen.has(value as object)) return TELEMETRY_REDACTED;
  seen.add(value as object);
  if (Array.isArray(value)) {
    const output = value.slice(0, options.maxArrayItems).map((entry) => redactValue(entry, options, depth + 1, seen, protectedTaint));
    seen.delete(value);
    return output;
  }
  const source = value as Record<string, unknown>;
  const protectedObject = protectedTaint || Object.entries(source).some(([key, entry]) => pathField(key) && typeof entry === "string" && pathProtected(entry, options.protectedPaths, options.projectRoot));
  const output: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(source).sort(([a], [b]) => a.localeCompare(b)).slice(0, options.maxObjectKeys)) {
    if (options.omitProjectionFields && OMITTED_PROJECTION_FIELD.test(key)) continue;
    const structuredAuthorization = key.toLowerCase() === "authorization" && (entry === "authorized" || entry === "denied");
    if (SENSITIVE_KEY.test(key) || (AUTH_HEADER_KEY.test(key) && typeof entry === "string" && !structuredAuthorization)
      || (protectedObject && (PROTECTED_CONTENT_FIELD.test(key) || OMITTED_PROJECTION_FIELD.test(key)))) output[key] = TELEMETRY_REDACTED;
    else output[key] = redactValue(entry, options, depth + 1, seen, protectedObject);
  }
  seen.delete(value as object);
  return output;
}

function options(input: WorkflowRedactionOptions, mode: WorkflowRedactionMode): InternalOptions {
  const projection = mode === "authoritative-projection";
  const configuredPaths = projection ? [] : input.protectedPaths ?? [];
  if (configuredPaths.length > REDACTION_POLICY_LIMITS.protectedPaths || configuredPaths.some((value) => typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > REDACTION_POLICY_LIMITS.protectedPathBytes)) throw new Error("Workflow redaction protected path limit exceeded");
  return {
    secrets: projection ? [] : secretValues(input.environment ?? process.env),
    protectedPaths: [".env", ".git", ".pi/hive/private", ".pi/hive/sessions", ...configuredPaths],
    ...(!projection && input.projectRoot ? { projectRoot: resolve(input.projectRoot) } : {}),
    // Journal subsystems already enforce narrower authority-specific limits
    // (questions, terminal summaries, references). This defensive ceiling must
    // not truncate valid restart data before those contracts can replay it.
    maxStringBytes: input.maxStringBytes ?? (projection ? 2_048 : 131_072),
    maxArrayItems: input.maxArrayItems ?? (projection ? 64 : 8_192),
    maxObjectKeys: input.maxObjectKeys ?? (projection ? 128 : 8_192),
    maxDepth: input.maxDepth ?? (projection ? 8 : 64),
    omitProjectionFields: projection,
  };
}

export function redactProjectionValue(value: unknown, input: WorkflowRedactionOptions = {}): JsonValue {
  return redactValue(value, options(input, "authoritative-projection"), 0, new WeakSet<object>());
}

export function redactJournalPayload(value: unknown, input: WorkflowRedactionOptions = {}): JsonValue {
  return redactValue(value, options(input, "journal-pre-persistence"), 0, new WeakSet<object>());
}
