import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { descriptorPath, openDescriptorAt, openDirectoryAt, readDirectoryAt, statAt } from "../core/descriptor-fs";
import { isPathInside, resolveProjectPath } from "../core/safe-path";
import {
  validKnowledgeBundleId,
  validKnowledgeDocumentId,
  type KnowledgeBundle,
  type KnowledgeBundleLoadRequest,
  type KnowledgeBundleLoadResult,
  type KnowledgeDiagnostic,
  type KnowledgeDocument,
  type KnowledgeLink,
  type KnowledgeProvider,
} from "./types";

/** Accepted subset of OKF draft v0.1 at d44368c15e38e7c92481c5992e4f9b5b421a801d. */
export const OKF_PROVIDER_VERSION = "okf-0.1-draft-d44368c" as const;
export const OKF_PROVIDER_LIMITS = Object.freeze({
  depth: 32,
  files: 1_024,
  fileBytes: 262_144,
  aggregateBytes: 8_388_608,
  pathBytes: 262_144,
  frontmatterBytes: 65_536,
  metadataDepth: 16,
  metadataNodes: 4_096,
  linksPerDocument: 512,
  summaryBytes: 16_384,
  reservedLines: 4_096,
  indexSections: 256,
  indexEntries: 4_096,
  logDates: 512,
  logEntries: 4_096,
  diagnostics: 100,
  diagnosticBytes: 2_048,
});

export type OkfProviderLimits = { readonly [Key in keyof typeof OKF_PROVIDER_LIMITS]: number };
type OkfLimits = OkfProviderLimits;
export type OkfTraversalFaultPoint = "before-directory-open" | "after-root-pinned" | "after-directory-listed" | "before-entry-open";
export interface OkfLoadOperations {
  /** Deterministic test-only race seam; production callers leave this undefined. */
  readonly fault?: (point: OkfTraversalFaultPoint, relativePath: string) => void;
}
export interface LoadOkfBundleRequest extends KnowledgeBundleLoadRequest {
  readonly limits?: Partial<OkfLimits>;
  readonly operations?: OkfLoadOperations;
}
interface LoadedFile { readonly relativePath: string; readonly content: string; readonly bytes: number; readonly hash: string }

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sha256(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }
function utf8Prefix(value: string, bytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= bytes) return value;
  let output = "";
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > bytes) break;
    output += character;
    used += size;
  }
  return output;
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
class Diagnostics {
  readonly items: KnowledgeDiagnostic[] = [];
  private truncated = false;
  private readonly bundleId: string;
  private readonly limits: OkfLimits;
  constructor(bundleId: string, limits: OkfLimits) {
    this.bundleId = bundleId;
    this.limits = limits;
  }
  add(code: string, severity: "error" | "warning", message: string, documentId?: string): void {
    if (this.truncated) return;
    if (this.items.length >= this.limits.diagnostics - 1) {
      this.truncated = true;
      this.items.push(Object.freeze({ code: "OKF_DIAGNOSTICS_TRUNCATED", severity: "error", message: "Additional OKF diagnostics were omitted.", bundleId: this.bundleId }));
      return;
    }
    this.items.push(Object.freeze({ code, severity, message: utf8Prefix(message, this.limits.diagnosticBytes), bundleId: this.bundleId, ...(documentId ? { documentId } : {}) }));
  }
}

function openDirectory(path: string): number {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  if (!fstatSync(descriptor).isDirectory()) { closeSync(descriptor); throw new Error("not-directory"); }
  return descriptor;
}

function matchesDirectoryIdentity(descriptor: number, lexicalPath: string): boolean {
  try {
    const pinned = fstatSync(descriptor);
    const linked = lstatSync(lexicalPath);
    return pinned.isDirectory() && linked.isDirectory() && !linked.isSymbolicLink()
      && pinned.dev === linked.dev && pinned.ino === linked.ino;
  } catch { return false; }
}

function pinBundleRoot(projectRoot: string, bundlePath: string, operations?: OkfLoadOperations): { descriptor: number; canonicalRoot: string; lexicalRoot: string } {
  const projectPhysical = realpathSync.native(projectRoot);
  let descriptor = openDirectory(projectPhysical);
  try {
    const fromProject = relative(resolve(projectRoot), bundlePath);
    if (!fromProject || fromProject === ".." || fromProject.startsWith(`..${sep}`)) throw new Error("escape");
    const segments = fromProject.split(sep);
    let traversed = "";
    for (const segment of segments) {
      traversed = traversed ? `${traversed}/${segment}` : segment;
      operations?.fault?.("before-directory-open", traversed);
      const child = openDirectoryAt(descriptor, segment);
      closeSync(descriptor);
      descriptor = child;
    }
    const canonicalRoot = descriptorPath(descriptor);
    operations?.fault?.("after-root-pinned", "");
    if (!matchesDirectoryIdentity(descriptor, bundlePath)) throw new Error("identity-changed");
    return { descriptor, canonicalRoot, lexicalRoot: bundlePath };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function readExactFile(
  directoryDescriptor: number,
  name: string,
  limits: OkfLimits,
  aggregateRemaining: number,
  reserveContentBytes?: (bytes: number) => void,
): { value?: LoadedFile; code?: string } {
  let descriptor: number | undefined;
  try {
    const named = statAt(directoryDescriptor, name);
    if (named.kind === "symlink") return { code: "OKF_SYMLINK_DENIED" };
    descriptor = openDescriptorAt(directoryDescriptor, name, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (String(before.dev) !== named.device || String(before.ino) !== named.inode) return { code: "OKF_CONTENT_CHANGED" };
    if (!before.isFile()) return { code: "OKF_IRREGULAR_FILE" };
    if (before.size > limits.fileBytes) return { code: "OKF_FILE_TOO_LARGE" };
    if (before.size > aggregateRemaining) return { code: "OKF_AGGREGATE_TOO_LARGE" };
    try { reserveContentBytes?.(before.size); }
    catch { return { code: "OKF_CONTENT_BUDGET_EXCEEDED" }; }
    const bytes = Buffer.alloc(before.size);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(descriptor, bytes, used, bytes.length - used, used);
      if (count <= 0) return { code: "OKF_READ_FAILED" };
      used += count;
    }
    const after = fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { code: "OKF_CONTENT_CHANGED" };
    let content: string;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      content = bytes.toString("utf8");
    } catch { return { code: "OKF_INVALID_UTF8" }; }
    return { value: { relativePath: "", content, bytes: bytes.length, hash: sha256(bytes) } };
  } catch (error) {
    return { code: (error as NodeJS.ErrnoException).code === "ELOOP" ? "OKF_SYMLINK_DENIED" : "OKF_READ_FAILED" };
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function enumerate(
  rootDescriptor: number,
  rootLexicalPath: string,
  limits: OkfLimits,
  diagnostics: Diagnostics,
  operations?: OkfLoadOperations,
  reserveContentBytes?: (bytes: number) => void,
): LoadedFile[] {
  const output: LoadedFile[] = [];
  const stack: Array<{ descriptor: number; lexicalPath: string; relativePath: string; depth: number }> = [{ descriptor: rootDescriptor, lexicalPath: rootLexicalPath, relativePath: "", depth: 0 }];
  let aggregate = 0;
  let pathBytes = 0;
  try {
    while (stack.length) {
      const directory = stack.pop()!;
      try {
        if (directory.depth > limits.depth) { diagnostics.add("OKF_DEPTH_EXCEEDED", "error", "The OKF directory depth exceeds its bound."); continue; }
        if (!matchesDirectoryIdentity(directory.descriptor, directory.lexicalPath)) { diagnostics.add("OKF_DIRECTORY_IDENTITY_CHANGED", "error", "An OKF directory identity changed during traversal."); continue; }
        let entries: readonly string[];
        try { entries = [...readDirectoryAt(directory.descriptor)].sort(compare); }
        catch { diagnostics.add("OKF_READ_FAILED", "error", "An OKF directory cannot be read."); continue; }
        operations?.fault?.("after-directory-listed", directory.relativePath);
        if (!matchesDirectoryIdentity(directory.descriptor, directory.lexicalPath)) { diagnostics.add("OKF_DIRECTORY_IDENTITY_CHANGED", "error", "An OKF directory identity changed during traversal."); continue; }
        for (const entryName of entries) {
          const relativePath = directory.relativePath ? `${directory.relativePath}/${entryName}` : entryName;
          pathBytes += Buffer.byteLength(relativePath, "utf8");
          if (pathBytes > limits.pathBytes) { diagnostics.add("OKF_PATH_LIMIT_EXCEEDED", "error", "OKF path metadata exceeds its bound."); return output; }
          operations?.fault?.("before-entry-open", relativePath);
          let entry;
          try { entry = statAt(directory.descriptor, entryName); }
          catch { diagnostics.add("OKF_READ_FAILED", "error", "An OKF entry changed during traversal."); continue; }
          if (entry.kind === "symlink") { diagnostics.add("OKF_SYMLINK_DENIED", "error", "Symbolic links are not accepted in an OKF bundle."); continue; }
          if (entry.kind === "directory") {
            try { stack.push({ descriptor: openDirectoryAt(directory.descriptor, entryName), lexicalPath: join(directory.lexicalPath, entryName), relativePath, depth: directory.depth + 1 }); }
            catch (error) { diagnostics.add((error as NodeJS.ErrnoException).code === "ELOOP" ? "OKF_SYMLINK_DENIED" : "OKF_READ_FAILED", "error", "An OKF directory changed during traversal."); }
            continue;
          }
          if (entry.kind !== "file") { diagnostics.add("OKF_IRREGULAR_FILE", "error", "Irregular entries are not accepted in an OKF bundle."); continue; }
          if (!entryName.endsWith(".md")) continue;
          if (output.length >= limits.files) { diagnostics.add("OKF_FILE_LIMIT_EXCEEDED", "error", "The OKF file count exceeds its bound."); return output; }
          const loaded = readExactFile(directory.descriptor, entryName, limits, limits.aggregateBytes - aggregate, reserveContentBytes);
          if (!loaded.value) {
            const code = loaded.code ?? "OKF_READ_FAILED";
            diagnostics.add(code, "error", code === "OKF_AGGREGATE_TOO_LARGE"
              ? "The OKF aggregate content exceeds its bound."
              : "An OKF document failed bounded descriptor validation.", relativePath.slice(0, -3));
            if (code === "OKF_AGGREGATE_TOO_LARGE" || code === "OKF_CONTENT_BUDGET_EXCEEDED") return output;
            continue;
          }
          aggregate += loaded.value.bytes;
          output.push(Object.freeze({ ...loaded.value, relativePath }));
        }
        if (!matchesDirectoryIdentity(directory.descriptor, directory.lexicalPath)) diagnostics.add("OKF_DIRECTORY_IDENTITY_CHANGED", "error", "An OKF directory identity changed during traversal.");
      } finally { closeSync(directory.descriptor); }
    }
  } finally {
    for (const pending of stack) closeSync(pending.descriptor);
  }
  return output.sort((left, right) => compare(left.relativePath, right.relativePath));
}

interface ValidatedReservedFiles { readonly rootIndexBody?: string }

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function rootIndexBody(file: LoadedFile, limits: OkfLimits, diagnostics: Diagnostics): string | undefined {
  const source = file.content.charCodeAt(0) === 0xfeff ? file.content.slice(1) : file.content;
  if (!source.startsWith("---")) return source;
  const match = /^(?:---)[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/u.exec(source);
  if (!match || Buffer.byteLength(match[1], "utf8") > limits.frontmatterBytes) {
    diagnostics.add("OKF_INDEX_INVALID", "error", "The root OKF index version frontmatter is invalid.");
    return undefined;
  }
  try {
    const parsed = parseDocument(match[1], { uniqueKeys: true, prettyErrors: false });
    if (parsed.errors.length) throw new Error("parse");
    const metadata = parsed.toJS({ maxAliasCount: 0 });
    if (!plainRecord(metadata) || Object.keys(metadata).length !== 1 || metadata.okf_version !== "0.1") throw new Error("version");
    return source.slice(match[0].length);
  } catch {
    diagnostics.add("OKF_INDEX_INVALID", "error", "The root OKF index may declare only supported okf_version 0.1 frontmatter.");
    return undefined;
  }
}

function validateIndex(file: LoadedFile, limits: OkfLimits, diagnostics: Diagnostics): string | undefined {
  const root = file.relativePath === "index.md";
  const source = root ? rootIndexBody(file, limits, diagnostics) : file.content;
  if (source === undefined) return undefined;
  if (!root && /^(?:\ufeff)?---[\t ]*\r?$/mu.test(source.split(/\r?\n/u, 1)[0] ?? "")) {
    diagnostics.add("OKF_INDEX_INVALID", "error", "Frontmatter is permitted only in the bundle-root OKF index.");
    return undefined;
  }
  const lines = source.split(/\r?\n/u);
  if (lines.length > limits.reservedLines) { diagnostics.add("OKF_INDEX_LIMIT_EXCEEDED", "error", "The OKF index line bound is exceeded."); return undefined; }
  let sections = 0;
  let entries = 0;
  let sectionEntries = 0;
  let sawSection = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^# [^#\r\n].*$/u.test(line)) {
      if (sawSection && sectionEntries === 0) { diagnostics.add("OKF_INDEX_INVALID", "error", "Every OKF index section must contain an entry."); return undefined; }
      sawSection = true; sectionEntries = 0;
      if (++sections > limits.indexSections) { diagnostics.add("OKF_INDEX_LIMIT_EXCEEDED", "error", "The OKF index section bound is exceeded."); return undefined; }
      continue;
    }
    const entry = /^\* \[[^\]\r\n]{1,1024}\]\(([^)\s]{1,4096})\)(?: - [^\r\n]+)?$/u.exec(line);
    if (!sawSection || !entry || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(entry[1]) || entry[1].startsWith("/") || entry[1].startsWith("//")
      || normalizeInternalTarget(file.relativePath, entry[1], false) === undefined) {
      diagnostics.add("OKF_INDEX_INVALID", "error", "The OKF index must contain only headed bundle-contained relative-link entry lists.");
      return undefined;
    }
    sectionEntries++;
    if (++entries > limits.indexEntries) { diagnostics.add("OKF_INDEX_LIMIT_EXCEEDED", "error", "The OKF index entry bound is exceeded."); return undefined; }
  }
  if (!sawSection || entries === 0 || sectionEntries === 0) {
    diagnostics.add("OKF_INDEX_INVALID", "error", "The OKF index must contain at least one non-empty section.");
    return undefined;
  }
  return source;
}

function validateLog(file: LoadedFile, limits: OkfLimits, diagnostics: Diagnostics): void {
  const source = file.content.charCodeAt(0) === 0xfeff ? file.content.slice(1) : file.content;
  if (source.startsWith("---")) { diagnostics.add("OKF_LOG_INVALID", "error", "OKF log files do not permit frontmatter."); return; }
  const lines = source.split(/\r?\n/u);
  if (lines.length > limits.reservedLines) { diagnostics.add("OKF_LOG_LIMIT_EXCEEDED", "error", "The OKF log line bound is exceeded."); return; }
  let sawTitle = false;
  let currentDate: string | undefined;
  let previousDate: string | undefined;
  let groupEntries = 0;
  let dates = 0;
  let entries = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!sawTitle) {
      if (!/^# [^#\r\n].*$/u.test(line)) { diagnostics.add("OKF_LOG_INVALID", "error", "The OKF log must start with one title heading."); return; }
      sawTitle = true;
      continue;
    }
    const date = /^## (\d{4}-\d{2}-\d{2})$/u.exec(line)?.[1];
    if (date !== undefined) {
      if (!validIsoDate(date) || (previousDate !== undefined && date >= previousDate) || (currentDate !== undefined && groupEntries === 0)) {
        diagnostics.add("OKF_LOG_INVALID", "error", "OKF log dates must be valid ISO dates in newest-first groups with entries.");
        return;
      }
      currentDate = date; previousDate = date; groupEntries = 0;
      if (++dates > limits.logDates) { diagnostics.add("OKF_LOG_LIMIT_EXCEEDED", "error", "The OKF log date-group bound is exceeded."); return; }
      continue;
    }
    if (!currentDate || !/^\* [^\r\n]+$/u.test(line)) { diagnostics.add("OKF_LOG_INVALID", "error", "The OKF log must contain only date-grouped flat list entries."); return; }
    groupEntries++;
    if (++entries > limits.logEntries) { diagnostics.add("OKF_LOG_LIMIT_EXCEEDED", "error", "The OKF log entry bound is exceeded."); return; }
  }
  if (!sawTitle || !currentDate || groupEntries === 0) diagnostics.add("OKF_LOG_INVALID", "error", "The OKF log must contain at least one non-empty date group.");
}

/**
 * Strict accepted reserved-file subset for pinned OKF v0.1: headed relative-link index lists,
 * optional root-only `okf_version: "0.1"`, and newest-first ISO-date flat log lists.
 */
function validateReservedFiles(files: readonly LoadedFile[], limits: OkfLimits, diagnostics: Diagnostics): ValidatedReservedFiles {
  let rootSummary: string | undefined;
  for (const file of files) {
    const basename = posix.basename(file.relativePath);
    if (basename === "index.md") {
      const body = validateIndex(file, limits, diagnostics);
      if (file.relativePath === "index.md" && body !== undefined) rootSummary = body;
    } else if (basename === "log.md") validateLog(file, limits, diagnostics);
  }
  return Object.freeze({ ...(rootSummary !== undefined ? { rootIndexBody: rootSummary } : {}) });
}

function splitFrontmatter(file: LoadedFile, limits: OkfLimits, diagnostics: Diagnostics, documentId: string): { metadata?: Record<string, unknown>; body?: string } {
  const source = file.content.charCodeAt(0) === 0xfeff ? file.content.slice(1) : file.content;
  const match = /^(?:---)[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/u.exec(source);
  if (!match) { diagnostics.add("OKF_FRONTMATTER_INVALID", "error", "The concept document has missing or unterminated YAML frontmatter.", documentId); return {}; }
  if (Buffer.byteLength(match[1], "utf8") > limits.frontmatterBytes) { diagnostics.add("OKF_FRONTMATTER_TOO_LARGE", "error", "The concept frontmatter exceeds its bound.", documentId); return {}; }
  try {
    const parsed = parseDocument(match[1], { uniqueKeys: true, prettyErrors: false });
    if (parsed.errors.length) throw new Error("parse");
    const metadata = parsed.toJS({ maxAliasCount: 0 });
    if (!plainRecord(metadata)) throw new Error("shape");
    const stack: Array<{ value: unknown; depth: number }> = [{ value: metadata, depth: 1 }];
    let nodes = 0;
    while (stack.length) {
      const current = stack.pop()!;
      if (++nodes > limits.metadataNodes || current.depth > limits.metadataDepth) throw new Error("bound");
      if (Array.isArray(current.value)) for (const value of current.value) stack.push({ value, depth: current.depth + 1 });
      else if (plainRecord(current.value)) for (const value of Object.values(current.value)) stack.push({ value, depth: current.depth + 1 });
    }
    return { metadata, body: source.slice(match[0].length) };
  } catch {
    diagnostics.add("OKF_FRONTMATTER_INVALID", "error", "The concept YAML frontmatter is invalid or exceeds its structural bound.", documentId);
    return {};
  }
}

function optionalString(value: unknown, bytes: number): string | undefined {
  return typeof value === "string" && value.trim() && Buffer.byteLength(value, "utf8") <= bytes ? value.trim() : undefined;
}
function normalizeInternalTarget(sourcePath: string, rawTarget: string, allowBundleAbsolute = true): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(rawTarget); } catch { return undefined; }
  decoded = decoded.replace(/^<|>$/gu, "").split(/[?#]/u, 1)[0];
  if (!decoded || decoded.includes("\\") || decoded.includes("\0") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(decoded) || decoded.startsWith("//")) return undefined;
  const absolute = decoded.startsWith("/");
  if (absolute && !allowBundleAbsolute) return undefined;
  const candidate = absolute ? decoded.slice(1) : posix.join(posix.dirname(sourcePath), decoded);
  if (!candidate || candidate.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) return undefined;
  const normalized = posix.normalize(candidate);
  const markdownPath = normalized.endsWith("/") ? `${normalized}index.md` : normalized;
  if (!markdownPath.endsWith(".md")) return undefined;
  const withoutSuffix = markdownPath.slice(0, -3);
  return validKnowledgeDocumentId(withoutSuffix) ? withoutSuffix : undefined;
}
function linksFor(body: string, sourcePath: string, documentIds: ReadonlySet<string>, limits: OkfLimits, diagnostics: Diagnostics, documentId: string): readonly KnowledgeLink[] {
  const links: KnowledgeLink[] = [];
  const pattern = /\[[^\]\r\n]{0,1024}\]\(([^)\s]{1,4096})(?:\s+["'][^"'\r\n]{0,1024}["'])?\)/gu;
  for (const match of body.matchAll(pattern)) {
    if (links.length >= limits.linksPerDocument) { diagnostics.add("OKF_LINK_LIMIT_EXCEEDED", "error", "The concept link count exceeds its bound.", documentId); break; }
    const target = match[1];
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target) || target.startsWith("//")) {
      links.push(Object.freeze({ kind: "external", target }));
      continue;
    }
    if (target.startsWith("#")) continue;
    const normalized = normalizeInternalTarget(sourcePath, target);
    if (!normalized) { diagnostics.add("OKF_LINK_ESCAPE", "error", "An internal concept link is invalid or escapes the bundle.", documentId); continue; }
    links.push(Object.freeze({ kind: "internal", target: normalized, exists: documentIds.has(normalized) }));
  }
  return Object.freeze(links);
}

function cycleDiagnostic(documents: readonly KnowledgeDocument[], diagnostics: Diagnostics): void {
  const edges = new Map(documents.map((document) => [document.id, document.links.filter((link) => link.kind === "internal" && link.exists).map((link) => link.target)]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const target of edges.get(id) ?? []) if (walk(target)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  for (const id of [...edges.keys()].sort(compare)) if (walk(id)) {
    diagnostics.add("OKF_LINK_CYCLE", "warning", "The OKF link graph contains a cycle; traversal remains bounded.");
    return;
  }
}

export function loadOkfBundle(request: LoadOkfBundleRequest): KnowledgeBundleLoadResult {
  const limits = Object.freeze({ ...OKF_PROVIDER_LIMITS, ...(request.limits ?? {}) }) as OkfLimits;
  const diagnostics = new Diagnostics(request.declaration.id, limits);
  if (!validKnowledgeBundleId(request.declaration.id) || request.declaration.providerId !== "okf") {
    diagnostics.add("OKF_DECLARATION_INVALID", "error", "The OKF bundle declaration is invalid.");
    return Object.freeze({ ok: false, diagnostics: Object.freeze(diagnostics.items) });
  }
  const root = resolveProjectPath(request.projectRoot, request.declaration.path);
  if (!root || !isPathInside(resolve(request.projectRoot), root.lexicalPath)) {
    diagnostics.add("OKF_PATH_ESCAPE", "error", "The OKF bundle root is not contained in the project.");
    return Object.freeze({ ok: false, diagnostics: Object.freeze(diagnostics.items) });
  }
  let pinned: { descriptor: number; canonicalRoot: string; lexicalRoot: string };
  try {
    pinned = pinBundleRoot(request.projectRoot, root.lexicalPath, request.operations);
    if (!isPathInside(realpathSync.native(request.projectRoot), pinned.canonicalRoot)) throw new Error("escape");
  } catch {
    diagnostics.add("OKF_PATH_ESCAPE", "error", "The OKF bundle root is invalid, symbolic, or outside the project.");
    return Object.freeze({ ok: false, diagnostics: Object.freeze(diagnostics.items) });
  }
  const files = enumerate(pinned.descriptor, pinned.lexicalRoot, limits, diagnostics, request.operations, request.reserveContentBytes);
  const reserved = validateReservedFiles(files, limits, diagnostics);
  const conceptFiles = files.filter((file) => !["index.md", "log.md"].includes(posix.basename(file.relativePath)));
  const documentIds = new Set(conceptFiles.map((file) => file.relativePath.slice(0, -3)));
  const documents: KnowledgeDocument[] = [];
  for (const file of conceptFiles) {
    const id = file.relativePath.slice(0, -3);
    if (!validKnowledgeDocumentId(id)) { diagnostics.add("OKF_DOCUMENT_ID_INVALID", "error", "A concept path does not form a valid document ID."); continue; }
    const parsed = splitFrontmatter(file, limits, diagnostics, id);
    if (!parsed.metadata || parsed.body === undefined) continue;
    const type = optionalString(parsed.metadata.type, 256);
    if (!type) { diagnostics.add("OKF_TYPE_REQUIRED", "error", "The concept type is required and bounded.", id); continue; }
    const titleValue = parsed.metadata.title === undefined ? posix.basename(id) : optionalString(parsed.metadata.title, 1_024);
    if (!titleValue) { diagnostics.add("OKF_METADATA_INVALID", "error", "The optional concept title is invalid.", id); continue; }
    const description = parsed.metadata.description === undefined ? undefined : optionalString(parsed.metadata.description, 4_096);
    if (parsed.metadata.description !== undefined && !description) { diagnostics.add("OKF_METADATA_INVALID", "error", "The optional concept description is invalid.", id); continue; }
    const tags = parsed.metadata.tags === undefined ? [] : parsed.metadata.tags;
    if (!Array.isArray(tags) || tags.length > 128 || tags.some((tag) => !optionalString(tag, 256))) { diagnostics.add("OKF_METADATA_INVALID", "error", "The optional concept tags are invalid.", id); continue; }
    documents.push(Object.freeze({
      id, type, title: titleValue, ...(description ? { description } : {}), tags: Object.freeze(tags.map((tag) => String(tag).trim()).sort(compare)),
      body: parsed.body, content: file.content, contentHash: file.hash, bytes: file.bytes, links: Object.freeze([]),
    }));
  }
  const linked = documents.map((document) => {
    const file = conceptFiles.find((candidate) => candidate.relativePath === `${document.id}.md`)!;
    return Object.freeze({ ...document, links: linksFor(document.body, file.relativePath, documentIds, limits, diagnostics, document.id) });
  }).sort((left, right) => compare(left.id, right.id));
  cycleDiagnostic(linked, diagnostics);
  const hasError = diagnostics.items.some((diagnostic) => diagnostic.severity === "error");
  if (hasError) return Object.freeze({ ok: false, diagnostics: Object.freeze(diagnostics.items) });
  const synthesized = linked.map((document) => `- ${document.title} (${document.id})${document.description ? ` — ${document.description}` : ""}`).join("\n") || "(empty knowledge bundle)";
  const summary = utf8Prefix(reserved.rootIndexBody ?? synthesized, limits.summaryBytes);
  const contentHash = createHash("sha256").update("pi-hive-knowledge-bundle-v1\0");
  for (const file of files) contentHash.update(file.relativePath).update("\0").update(file.hash).update("\0");
  const bundle: KnowledgeBundle = Object.freeze({
    id: request.declaration.id,
    providerId: request.declaration.providerId,
    ...(request.declaration.ownerAgentId ? { ownerAgentId: request.declaration.ownerAgentId } : {}),
    updatePolicy: request.declaration.updatePolicy,
    canonicalRoot: pinned.canonicalRoot,
    documents: Object.freeze(linked),
    summary,
    contentHash: contentHash.digest("hex"),
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    diagnostics: Object.freeze(diagnostics.items),
  });
  return Object.freeze({ ok: true, bundle, diagnostics: bundle.diagnostics });
}

export const OKF_KNOWLEDGE_PROVIDER: KnowledgeProvider = Object.freeze({
  id: "okf",
  version: OKF_PROVIDER_VERSION,
  load: (request: KnowledgeBundleLoadRequest) => loadOkfBundle(request),
});
