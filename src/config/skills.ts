import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { join, relative } from "node:path";
import { isPathInside } from "../core/safe-path";
import { isCatalogAggregateLimitError } from "./catalog-budget";
import { decodeCatalogText, hashCatalogFrames } from "./catalog-hash";
import { CONFIG_CATALOG_LIMITS } from "./catalog-types";
import { createDiagnosticCollector, type ConfigDiagnostic, type ConfigDiagnosticCode } from "./diagnostics";
import type { ConfiguredProject } from "./manifest";

export interface LoadedSkillFile {
  relativePath: string;
  content: string;
  bytes: number;
  hash: string;
}

interface SkillBase {
  kind: "skill";
  id: string;
  status: "available" | "failed";
  diagnosticCodes: readonly ConfigDiagnosticCode[];
}

export interface AvailableSkillCatalogNode extends SkillBase {
  status: "available";
  files: LoadedSkillFile[];
  fileCount: number;
  totalBytes: number;
  treeHash: string;
}
export interface FailedSkillCatalogNode extends SkillBase { status: "failed" }
export type SkillCatalogNode = AvailableSkillCatalogNode | FailedSkillCatalogNode;
export interface SkillCatalogResult {
  skills: SkillCatalogNode[];
  diagnostics: ConfigDiagnostic[];
  truncated: boolean;
  loadedBytes: number;
}

export interface SkillLoadOperations {
  readdir?(path: string): string[];
  lstat?(path: string): Stats;
  stat?(path: string): Stats;
  realpath?(path: string): string;
  readFile?(path: string): Uint8Array;
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function key(value: string): string { return process.platform === "win32" ? value.toLowerCase() : value; }
function hasReservedGitSegment(projectRoot: string, canonicalPath: string): boolean {
  const projectPath = relative(projectRoot, canonicalPath).split("\\").join("/");
  return projectPath.split("/").some((segment) => segment === ".git" || segment === ".gitignore");
}
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code : undefined;
}

export function loadSkillCatalog(project: ConfiguredProject, operations: SkillLoadOperations = {}): SkillCatalogResult {
  const collector = createDiagnosticCollector();
  const skills: SkillCatalogNode[] = [];
  let loadedBytes = 0;
  const readdir = operations.readdir ?? ((path: string) => readdirSync(path));
  const lstat = operations.lstat ?? lstatSync;
  const stat = operations.stat ?? statSync;
  const realpath = operations.realpath ?? realpathSync.native;
  const read = operations.readFile ?? ((path: string) => readFileSync(path));

  for (const entry of project.registries.skills) {
    if (entry.status === "failed" || !entry.canonicalPath) {
      skills.push({ kind: "skill", id: entry.id, status: "failed", diagnosticCodes: entry.diagnosticCodes });
      continue;
    }
    const source = project.manifestSource;
    const codes: ConfigDiagnosticCode[] = [];
    const add = (code: ConfigDiagnosticCode, message = "The catalog skill is invalid."): void => {
      if (!codes.includes(code)) codes.push(code);
      collector.add({ code, severity: "error", message, source, range: entry.sourceRange, resourceId: entry.id });
    };
    const files: LoadedSkillFile[] = [];
    let totalBytes = 0;
    let pathBytes = 0;
    let root: string;
    try { root = realpath(entry.canonicalPath); }
    catch { add("RESOURCE_ACCESS_FAILED"); skills.push({ kind: "skill", id: entry.id, status: "failed", diagnosticCodes: codes }); continue; }
    if (!isPathInside(project.projectRoot, root)) add("RESOURCE_PATH_ESCAPE");
    const seenTargets = new Set<string>();
    const stack: Array<{ lexical: string; relativePath: string; depth: number; ancestors: ReadonlySet<string> }> = [
      { lexical: entry.canonicalPath, relativePath: "", depth: 0, ancestors: new Set() },
    ];
    while (stack.length > 0 && codes.length === 0) {
      const current = stack.pop()!;
      let currentReal: string;
      let currentStat: Stats;
      try {
        lstat(current.lexical);
        currentReal = realpath(current.lexical);
        currentStat = stat(current.lexical);
      } catch (error: unknown) {
        add(errorCode(error) === "ENOENT" ? "RESOURCE_NOT_FOUND" : "RESOURCE_ACCESS_FAILED");
        break;
      }
      if (!isPathInside(project.projectRoot, currentReal) || !isPathInside(root, currentReal)) { add("RESOURCE_PATH_ESCAPE"); break; }
      if (hasReservedGitSegment(project.projectRoot, currentReal)) { add("SKILL_FILE_UNSUPPORTED"); break; }
      const targetKey = key(currentReal);
      if (currentStat.isDirectory()) {
        if (current.depth > CONFIG_CATALOG_LIMITS.skillDepth) { add("SKILL_DEPTH_EXCEEDED"); break; }
        if (current.ancestors.has(targetKey)) { add("SKILL_CYCLE"); break; }
        if (seenTargets.has(targetKey)) { add("SKILL_DUPLICATE_TARGET"); break; }
        seenTargets.add(targetKey);
        let names: string[];
        try { names = [...readdir(current.lexical)].sort(compare); }
        catch { add("RESOURCE_ACCESS_FAILED"); break; }
        let afterDirectoryReal: string;
        let afterDirectoryStat: Stats;
        try {
          lstat(current.lexical);
          afterDirectoryReal = realpath(current.lexical);
          afterDirectoryStat = stat(current.lexical);
        } catch { add("RESOURCE_ACCESS_FAILED"); break; }
        if (!isPathInside(project.projectRoot, afterDirectoryReal) || !isPathInside(root, afterDirectoryReal)) { add("RESOURCE_PATH_ESCAPE"); break; }
        if (hasReservedGitSegment(project.projectRoot, afterDirectoryReal)) { add("SKILL_FILE_UNSUPPORTED"); break; }
        if (key(afterDirectoryReal) !== targetKey || !afterDirectoryStat.isDirectory()) { add("SKILL_DUPLICATE_TARGET"); break; }
        const childAncestors = new Set(current.ancestors);
        childAncestors.add(targetKey);
        for (let index = names.length - 1; index >= 0; index--) {
          const name = names[index];
          if (name === ".git" || name === ".gitignore") { add("SKILL_FILE_UNSUPPORTED"); break; }
          const childRelative = current.relativePath ? `${current.relativePath}/${name}` : name;
          pathBytes += Buffer.byteLength(childRelative, "utf8");
          if (pathBytes > CONFIG_CATALOG_LIMITS.skillPathBytes) { add("SKILL_PATH_BYTES_EXCEEDED"); break; }
          stack.push({ lexical: join(current.lexical, name), relativePath: childRelative, depth: current.depth + 1, ancestors: childAncestors });
        }
        continue;
      }
      if (!currentStat.isFile()) { add("SKILL_FILE_UNSUPPORTED"); break; }
      if (!current.relativePath.endsWith(".md")) { add("SKILL_FILE_UNSUPPORTED"); break; }
      if (seenTargets.has(targetKey)) { add("SKILL_DUPLICATE_TARGET"); break; }
      seenTargets.add(targetKey);
      if (files.length >= CONFIG_CATALOG_LIMITS.skillFiles) { add("SKILL_FILE_LIMIT_EXCEEDED"); break; }
      if (currentStat.size > CONFIG_CATALOG_LIMITS.skillFileBytes) { add("CATALOG_FILE_TOO_LARGE"); break; }
      if (totalBytes + currentStat.size > CONFIG_CATALOG_LIMITS.skillAggregateBytes) { add("CATALOG_AGGREGATE_TOO_LARGE"); break; }
      let bytes: Buffer;
      try { bytes = Buffer.from(read(current.lexical)); }
      catch (error: unknown) { add(isCatalogAggregateLimitError(error) ? "CATALOG_AGGREGATE_TOO_LARGE" : "RESOURCE_ACCESS_FAILED"); break; }
      let afterReal: string;
      let afterStat: Stats;
      try {
        lstat(current.lexical);
        afterReal = realpath(current.lexical);
        afterStat = stat(current.lexical);
      } catch { add("RESOURCE_ACCESS_FAILED"); break; }
      if (!isPathInside(project.projectRoot, afterReal) || !isPathInside(root, afterReal)) { add("RESOURCE_PATH_ESCAPE"); break; }
      if (hasReservedGitSegment(project.projectRoot, afterReal)) { add("SKILL_FILE_UNSUPPORTED"); break; }
      if (key(afterReal) !== targetKey || !afterStat.isFile()) { add("SKILL_DUPLICATE_TARGET"); break; }
      if (afterStat.size > CONFIG_CATALOG_LIMITS.skillFileBytes || bytes.byteLength > CONFIG_CATALOG_LIMITS.skillFileBytes) { add("CATALOG_FILE_TOO_LARGE"); break; }
      if (totalBytes + bytes.byteLength > CONFIG_CATALOG_LIMITS.skillAggregateBytes) { add("CATALOG_AGGREGATE_TOO_LARGE"); break; }
      totalBytes += bytes.byteLength;
      let content: string;
      try { content = decodeCatalogText(bytes); }
      catch { add("CATALOG_TEXT_INVALID_UTF8"); break; }
      const pathFrame = Buffer.from(current.relativePath, "utf8");
      files.push({ relativePath: current.relativePath, content, bytes: bytes.byteLength, hash: hashCatalogFrames("skill-file", [pathFrame, content]) });
    }
    files.sort((a, b) => compare(a.relativePath, b.relativePath));
    if (codes.length === 0 && files.length === 0) add("SKILL_EMPTY");
    if (codes.length > 0) {
      skills.push({ kind: "skill", id: entry.id, status: "failed", diagnosticCodes: codes });
      continue;
    }
    const treeHash = hashCatalogFrames("skill-tree", files.flatMap((file) => [Buffer.from(file.relativePath, "utf8"), file.hash]));
    loadedBytes += totalBytes;
    skills.push({ kind: "skill", id: entry.id, status: "available", diagnosticCodes: [], files, fileCount: files.length, totalBytes, treeHash });
  }
  const result = collector.result();
  return { skills, diagnostics: result.diagnostics, truncated: result.truncated, loadedBytes };
}
