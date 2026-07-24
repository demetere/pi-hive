import { readFileSync, statSync, type Stats } from "node:fs";
import { relative } from "node:path";
import { isCatalogAggregateLimitError } from "./catalog-budget";
import { hashCatalogFrames, decodeCatalogText } from "./catalog-hash";
import {
  CONFIG_CATALOG_LIMITS,
  type AgentCatalogNode,
  type AgentCatalogResult,
  type AgentFileRanges,
  type CatalogDependencyEdge,
} from "./catalog-types";
import {
  createDiagnosticCollector,
  sourceRange,
  type ConfigDiagnostic,
  type ConfigDiagnosticCode,
  type SourcePosition,
  type SourceRange,
} from "./diagnostics";
import type { ConfiguredProject } from "./manifest";
import { CONFIG_REGISTRY_LIMITS } from "./paths";
import type { RegistryEntry } from "./registry";
import { AgentFrontmatterV1Schema, validateSchemaValue } from "./schema";
import { parseConfigYaml, type YamlSourceMap } from "./yaml";

export interface AgentLoadOperations {
  stat?(path: string): Pick<Stats, "size" | "isFile">;
  readFile?(path: string): Uint8Array;
}

interface FrontmatterParts {
  yaml: string;
  body: string;
  yamlStart: number;
  ranges: AgentFileRanges;
}

function lineStarts(value: string): number[] {
  const starts = [0];
  for (let index = 0; index < value.length; index++) if (value[index] === "\n") starts.push(index + 1);
  return starts;
}

function positionAt(starts: readonly number[], offset: number): SourcePosition {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return { offset, line: low + 1, column: offset - starts[low] + 1 };
}

function rangeAt(starts: readonly number[], start: number, end: number): SourceRange {
  return { start: positionAt(starts, start), end: positionAt(starts, end) };
}

function parseFrontmatter(source: string): { parts?: FrontmatterParts; code?: ConfigDiagnosticCode; range?: SourceRange } {
  const starts = lineStarts(source);
  if (source.charCodeAt(0) === 0xfeff)
    return { code: "AGENT_FRONTMATTER_MISSING", range: rangeAt(starts, 0, 1) };
  if (!(source.startsWith("---\n") || source.startsWith("---\r\n")))
    return { code: "AGENT_FRONTMATTER_MISSING", range: rangeAt(starts, 0, Math.min(3, source.length)) };
  const openingEnd = source.startsWith("---\r\n") ? 5 : 4;
  let cursor = openingEnd;
  let closingStart = -1;
  let closingEnd = -1;
  let bodyStart = -1;
  while (cursor <= source.length) {
    const newline = source.indexOf("\n", cursor);
    const lineEnd = newline < 0 ? source.length : newline;
    const contentEnd = lineEnd > cursor && source[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    if (source.slice(cursor, contentEnd) === "---") {
      closingStart = cursor;
      closingEnd = contentEnd;
      bodyStart = newline < 0 ? source.length : newline + 1;
      break;
    }
    if (newline < 0) break;
    cursor = newline + 1;
  }
  if (closingStart < 0) return { code: "AGENT_FRONTMATTER_UNTERMINATED", range: rangeAt(starts, 0, source.length) };
  const body = source.slice(bodyStart);
  let secondStart = bodyStart;
  while (secondStart < source.length && /\s/u.test(source[secondStart])) secondStart++;
  const secondOpeningEnd = source.startsWith("---\r\n", secondStart) ? secondStart + 5
    : source.startsWith("---\n", secondStart) ? secondStart + 4 : -1;
  if (secondOpeningEnd >= 0) {
    let secondCursor = secondOpeningEnd;
    while (secondCursor <= source.length) {
      const newline = source.indexOf("\n", secondCursor);
      const lineEnd = newline < 0 ? source.length : newline;
      const contentEnd = lineEnd > secondCursor && source[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
      if (source.slice(secondCursor, contentEnd) === "---")
        return { code: "AGENT_FRONTMATTER_MULTIPLE", range: rangeAt(starts, secondStart, contentEnd) };
      if (newline < 0) break;
      secondCursor = newline + 1;
    }
  }
  return {
    parts: {
      yaml: source.slice(openingEnd, closingStart),
      body,
      yamlStart: openingEnd,
      ranges: {
        source: rangeAt(starts, 0, source.length),
        openingDelimiter: rangeAt(starts, 0, 3),
        frontmatter: rangeAt(starts, openingEnd, closingStart),
        closingDelimiter: rangeAt(starts, closingStart, closingEnd),
        body: rangeAt(starts, bodyStart, source.length),
      },
    },
  };
}

function translateRange(range: SourceRange, base: number, starts: readonly number[]): SourceRange {
  return rangeAt(starts, base + range.start.offset, base + range.end.offset);
}

function translateSourceMap(map: YamlSourceMap, base: number, starts: readonly number[]): YamlSourceMap {
  return Object.fromEntries(Object.entries(map).map(([pointer, entry]) => [pointer, {
    ...(entry.key ? { key: translateRange(entry.key, base, starts) } : {}),
    value: translateRange(entry.value, base, starts),
  }]));
}

function agentDiagnostic(
  code: ConfigDiagnosticCode,
  source: string,
  range: SourceRange,
  id: string,
  message = "The catalog agent is invalid.",
): ConfigDiagnostic {
  return { code, severity: "error", message, source, range, resourceId: id };
}

function sourceName(project: ConfiguredProject, entry: RegistryEntry<"agents">): string {
  return entry.projectPath ?? relative(project.projectRoot, entry.canonicalPath ?? project.manifestPath).split("\\").join("/");
}

function failNode(id: string, codes: readonly ConfigDiagnosticCode[]): AgentCatalogNode {
  return { kind: "agent", id, status: "failed", diagnosticCodes: codes };
}

export function loadAgentCatalog(project: ConfiguredProject, operations: AgentLoadOperations = {}): AgentCatalogResult {
  const collector = createDiagnosticCollector();
  const agents: AgentCatalogNode[] = [];
  const edges: CatalogDependencyEdge[] = [];
  let loadedBytes = 0;
  const ownershipEdges = project.registries.knowledge.filter((entry) => entry.declaredData.owner !== undefined).length;
  const attachmentEdgeLimit = Math.max(0, CONFIG_REGISTRY_LIMITS.dependencyEdges - ownershipEdges);
  for (const entry of project.registries.agents) {
    if (entry.status === "failed" || !entry.canonicalPath) {
      agents.push(failNode(entry.id, entry.diagnosticCodes));
      continue;
    }
    const source = sourceName(project, entry);
    const codes: ConfigDiagnosticCode[] = [];
    const add = (code: ConfigDiagnosticCode, range = entry.sourceRange, message?: string): void => {
      codes.push(code);
      collector.add(agentDiagnostic(code, source, range, entry.id, message));
    };
    let bytes: Buffer;
    try {
      const stats = (operations.stat ?? statSync)(entry.canonicalPath);
      if (!stats.isFile()) {
        add("RESOURCE_TYPE_MISMATCH");
        agents.push(failNode(entry.id, codes));
        continue;
      }
      if (stats.size > CONFIG_CATALOG_LIMITS.agentFileBytes) {
        add("CATALOG_FILE_TOO_LARGE");
        agents.push(failNode(entry.id, codes));
        continue;
      }
      bytes = Buffer.from(operations.readFile?.(entry.canonicalPath) ?? readFileSync(entry.canonicalPath));
    } catch (error: unknown) {
      add(isCatalogAggregateLimitError(error) ? "CATALOG_AGGREGATE_TOO_LARGE" : "RESOURCE_ACCESS_FAILED");
      agents.push(failNode(entry.id, codes));
      continue;
    }
    if (bytes.byteLength > CONFIG_CATALOG_LIMITS.agentFileBytes) {
      add("CATALOG_FILE_TOO_LARGE");
      agents.push(failNode(entry.id, codes));
      continue;
    }
    let text: string;
    try {
      text = decodeCatalogText(bytes);
    } catch {
      add("CATALOG_TEXT_INVALID_UTF8", sourceRange(0, 1, 1, 0, 1, 1));
      agents.push(failNode(entry.id, codes));
      continue;
    }
    const parsedFile = parseFrontmatter(text);
    if (!parsedFile.parts) {
      add(parsedFile.code!, parsedFile.range ?? sourceRange(0, 1, 1, 0, 1, 1));
      agents.push(failNode(entry.id, codes));
      continue;
    }
    const { parts } = parsedFile;
    if (Buffer.byteLength(parts.yaml, "utf8") > CONFIG_CATALOG_LIMITS.frontmatterBytes)
      add("CATALOG_FILE_TOO_LARGE", parts.ranges.frontmatter);
    if (Buffer.byteLength(parts.body, "utf8") > CONFIG_CATALOG_LIMITS.promptBodyBytes)
      add("CATALOG_FILE_TOO_LARGE", parts.ranges.body);
    if (!parts.body.trim()) add("AGENT_BODY_EMPTY", parts.ranges.body);
    if (codes.length > 0) {
      agents.push(failNode(entry.id, codes));
      continue;
    }
    const starts = lineStarts(text);
    const parsed = parseConfigYaml(parts.yaml, source);
    for (const diagnostic of parsed.diagnostics) {
      codes.push(diagnostic.code);
      collector.add({ ...diagnostic, range: translateRange(diagnostic.range, parts.yamlStart, starts), resourceId: entry.id });
    }
    if (!parsed.value) {
      agents.push(failNode(entry.id, codes));
      continue;
    }
    const translatedMap = translateSourceMap(parsed.value.sourceMap, parts.yamlStart, starts);
    const validated = validateSchemaValue(AgentFrontmatterV1Schema, parsed.value.data, source, translatedMap);
    for (const diagnostic of validated.diagnostics) {
      codes.push(diagnostic.code);
      collector.add({ ...diagnostic, resourceId: entry.id });
    }
    const raw = parsed.value.data as Record<string, unknown>;
    const tags = Array.isArray(raw.tags) ? raw.tags : [];
    const skills = Array.isArray(raw.skills) ? raw.skills : [];
    const knowledge = Array.isArray(raw.knowledge) ? raw.knowledge : [];
    const stringTooLarge = (value: unknown, limit: number): boolean => typeof value === "string" && Buffer.byteLength(value, "utf8") > limit;
    if (stringTooLarge(raw.name, CONFIG_CATALOG_LIMITS.agentNameBytes))
      add("CATALOG_FILE_TOO_LARGE", translatedMap["/name"]?.value ?? parts.ranges.frontmatter);
    if (stringTooLarge(raw.description, CONFIG_CATALOG_LIMITS.agentDescriptionBytes))
      add("CATALOG_FILE_TOO_LARGE", translatedMap["/description"]?.value ?? parts.ranges.frontmatter);
    if (stringTooLarge(raw.model, CONFIG_CATALOG_LIMITS.agentModelBytes))
      add("CATALOG_FILE_TOO_LARGE", translatedMap["/model"]?.value ?? parts.ranges.frontmatter);
    if (tags.length > CONFIG_CATALOG_LIMITS.agentTags)
      add("SCHEMA_INVALID", translatedMap["/tags"]?.value ?? parts.ranges.frontmatter, "Agent tags exceed the catalog safety limit.");
    if (skills.length > CONFIG_CATALOG_LIMITS.agentSkills)
      add("AGENT_ATTACHMENT_LIMIT_EXCEEDED", translatedMap["/skills"]?.value ?? parts.ranges.frontmatter);
    if (knowledge.length > CONFIG_CATALOG_LIMITS.agentKnowledge)
      add("AGENT_ATTACHMENT_LIMIT_EXCEEDED", translatedMap["/knowledge"]?.value ?? parts.ranges.frontmatter);
    if (skills.length + knowledge.length > CONFIG_CATALOG_LIMITS.agentAttachments)
      add("AGENT_ATTACHMENT_LIMIT_EXCEEDED", translatedMap["/knowledge"]?.value ?? translatedMap["/skills"]?.value ?? parts.ranges.frontmatter);
    if (!validated.value || codes.length > 0) {
      agents.push(failNode(entry.id, codes));
      continue;
    }
    const attachmentCount = (validated.value.skills?.length ?? 0) + (validated.value.knowledge?.length ?? 0);
    if (edges.length + attachmentCount > attachmentEdgeLimit) {
      add("DEPENDENCY_LIMIT_EXCEEDED", parts.ranges.frontmatter, "Catalog attachment edges exceed the shared dependency graph limit.");
      agents.push(failNode(entry.id, codes));
      continue;
    }
    const sourceHash = hashCatalogFrames("agent-source", [bytes]);
    const canonicalSourceHash = hashCatalogFrames("agent-source", [text], true);
    const promptHash = hashCatalogFrames("agent-prompt", [parts.body]);
    loadedBytes += bytes.byteLength;
    const value = validated.value;
    agents.push({
      kind: "agent",
      id: entry.id,
      status: "available",
      diagnosticCodes: [],
      name: value.name,
      tags: value.tags ?? [],
      frontmatter: value,
      prompt: parts.body,
      ranges: parts.ranges,
      sourceHash,
      canonicalSourceHash,
      promptHash,
      sourceBytes: bytes.byteLength,
    });
    for (const id of value.skills ?? []) {
      const range = translatedMap[`/skills/${(value.skills ?? []).indexOf(id)}`]?.value ?? parts.ranges.frontmatter;
      edges.push({ from: `agent:${entry.id}`, target: `skill:${id}`, source, range, kind: "attachment" });
    }
    for (const id of value.knowledge ?? []) {
      const range = translatedMap[`/knowledge/${(value.knowledge ?? []).indexOf(id)}`]?.value ?? parts.ranges.frontmatter;
      edges.push({ from: `agent:${entry.id}`, target: `knowledge:${id}`, source, range, kind: "attachment" });
    }
  }
  const result = collector.result();
  return { agents, edges, diagnostics: result.diagnostics, truncated: result.truncated, loadedBytes };
}
