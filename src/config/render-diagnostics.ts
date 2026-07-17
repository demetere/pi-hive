import { basename, isAbsolute, win32 } from "node:path";
import {
  CONFIG_LIMITS,
  type ConfigDiagnostic,
  type SourceRange,
} from "./diagnostics";
import { CONFIG_REGISTRY_LIMITS } from "./paths";

export interface ConfigDiagnosticReportV1 {
  formatVersion: 1;
  truncated: boolean;
  diagnostics: ConfigDiagnostic[];
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function skipControlString(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 7 || code === 156) return index;
    if (code === 27 && value[index + 1] === "\\") return index + 1;
    index++;
  }
  return index;
}

function skipCsi(value: string, start: number): number {
  let index = start;
  while (index < value.length && !(value.charCodeAt(index) >= 64 && value.charCodeAt(index) <= 126)) index++;
  return index;
}

function skipEscapeSequence(value: string, start: number): number {
  let index = start;
  while (index < value.length && value.charCodeAt(index) >= 32 && value.charCodeAt(index) <= 47) index++;
  return index < value.length && value.charCodeAt(index) >= 48 && value.charCodeAt(index) <= 126 ? index : start;
}

function stripTerminalAndControls(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 27) {
      const kind = value[index + 1];
      if (kind === "[") index = skipCsi(value, index + 2);
      else if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_")
        index = skipControlString(value, index + 2);
      else if (kind !== undefined) index = skipEscapeSequence(value, index + 1);
      if (output && !output.endsWith(" ")) output += " ";
      continue;
    }
    if (code === 155) {
      index = skipCsi(value, index + 1);
      if (output && !output.endsWith(" ")) output += " ";
      continue;
    }
    if (code === 144 || code === 152 || code === 157 || code === 158 || code === 159) {
      index = skipControlString(value, index + 1);
      if (output && !output.endsWith(" ")) output += " ";
      continue;
    }
    if (code <= 31 || (code >= 127 && code <= 159)) {
      if (output && !output.endsWith(" ")) output += " ";
      continue;
    }
    output += value[index];
  }
  return output.trim();
}

function truncateUtf8(value: string, bytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= bytes) return value;
  let result = "";
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size + 3 > bytes) break;
    result += character;
    used += size;
  }
  return `${result}…`;
}

function isAsciiLetter(value: string | undefined): boolean {
  if (!value) return false;
  const code = value.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isPathStart(value: string, index: number): boolean {
  const character = value[index];
  if (character === "/" || character === "\\") return true;
  const boundary = index === 0 || !/[A-Za-z0-9_-]/u.test(value[index - 1]);
  return boundary && isAsciiLetter(character) && value[index + 1] === ":";
}

function hasFileExtension(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]{1,16}$/u.test(basename);
}

function unquotedPathEnd(value: string, start: number): number {
  const maximum = Math.min(value.length, start + CONFIG_LIMITS.messageBytes);
  let basicEnd = start;
  while (basicEnd < maximum && !/\s|[,;'"]/u.test(value[basicEnd])) basicEnd++;
  if (hasFileExtension(value.slice(start, basicEnd))) return basicEnd;
  for (let index = basicEnd; index < maximum; index++) {
    if (value[index] === "," || value[index] === ";" || value[index] === "'" || value[index] === "\"") return index;
    if (/\s/u.test(value[index])) {
      if (hasFileExtension(value.slice(start, index))) return index;
      const remainder = value.slice(index).trimStart();
      if (/^[a-z][a-z0-9-]*:[a-z0-9-]+(?:\s|$)/u.test(remainder)) return index;
    }
  }
  return maximum;
}

function redactPathContent(value: string): string {
  let output = "";
  for (let index = 0; index < value.length;) {
    const quote = value[index] === "'" || value[index] === "\"" ? value[index] : undefined;
    if (quote && isPathStart(value, index + 1)) {
      const end = value.indexOf(quote, index + 1);
      if (end > index && end - index <= CONFIG_LIMITS.messageBytes) {
        output += `${quote}<redacted>${quote}`;
        index = end + 1;
        continue;
      }
    }
    if (isPathStart(value, index)) {
      output += "<redacted>";
      index = unquotedPathEnd(value, index);
      continue;
    }
    output += value[index];
    index++;
  }
  return output;
}

function cleanText(value: string): string {
  return truncateUtf8(redactPathContent(stripTerminalAndControls(value)), CONFIG_LIMITS.messageBytes);
}

function cleanSource(source: string): string {
  const clean = stripTerminalAndControls(source);
  const windowsForm = win32.isAbsolute(clean) || /^[A-Za-z]:/u.test(clean) || clean.startsWith("\\\\");
  if (windowsForm) return `<redacted>/${truncateUtf8(win32.basename(clean), CONFIG_LIMITS.messageBytes)}`;
  if (isAbsolute(clean)) return `<redacted>/${truncateUtf8(basename(clean), CONFIG_LIMITS.messageBytes)}`;
  const normalized = clean.replaceAll("\\", "/");
  if (normalized.includes(":") || normalized.split("/").some((segment) => segment === "..")) return "<redacted>";
  return truncateUtf8(normalized, CONFIG_LIMITS.messageBytes);
}

function cleanRange(range: SourceRange): SourceRange {
  return { start: { ...range.start }, end: { ...range.end } };
}

function cleanDiagnostic(value: ConfigDiagnostic): ConfigDiagnostic {
  return {
    code: value.code,
    severity: value.severity,
    message: cleanText(value.message),
    source: cleanSource(value.source),
    range: cleanRange(value.range),
    ...(value.resourceId ? { resourceId: cleanText(value.resourceId) } : {}),
    ...(value.dependencyChain ? { dependencyChain: value.dependencyChain.slice(0, CONFIG_LIMITS.dependencyChain).map(cleanText) } : {}),
    ...(value.related ? {
      related: value.related.slice(0, CONFIG_LIMITS.related).map((related) => ({
        message: cleanText(related.message),
        source: cleanSource(related.source),
        range: cleanRange(related.range),
      })),
    } : {}),
  };
}

function compareClean(a: ConfigDiagnostic, b: ConfigDiagnostic): number {
  return compareStrings(JSON.stringify(a), JSON.stringify(b));
}

function ordered(values: readonly ConfigDiagnostic[]): ConfigDiagnostic[] {
  return values.slice(0, CONFIG_LIMITS.diagnostics).map(cleanDiagnostic).sort(compareClean);
}

export function renderConfigDiagnosticsJson(
  values: readonly ConfigDiagnostic[],
  inputTruncated: boolean,
): ConfigDiagnosticReportV1 {
  const diagnostics: ConfigDiagnostic[] = [];
  let truncated = inputTruncated || values.length > CONFIG_LIMITS.diagnostics;
  for (const diagnostic of ordered(values)) {
    const candidate = [...diagnostics, diagnostic];
    const bytes = Buffer.byteLength(JSON.stringify({ formatVersion: 1, truncated: false, diagnostics: candidate }), "utf8");
    if (bytes > CONFIG_REGISTRY_LIMITS.renderedDiagnosticsBytes) {
      truncated = true;
      break;
    }
    diagnostics.push(diagnostic);
  }
  return { formatVersion: 1, truncated, diagnostics };
}

export function renderConfigDiagnosticsHuman(
  values: readonly ConfigDiagnostic[],
  inputTruncated: boolean,
): string {
  const report = renderConfigDiagnosticsJson(values, inputTruncated);
  const lines = report.diagnostics.map((diagnostic) => {
    const chain = diagnostic.dependencyChain?.length ? ` [chain: ${diagnostic.dependencyChain.join(" -> ")}]` : "";
    return `${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.source}:${diagnostic.range.start.line}:${diagnostic.range.start.column} ${diagnostic.message}${chain}`;
  });
  if (report.truncated) lines.push("ERROR DIAGNOSTICS_TRUNCATED additional diagnostics omitted");
  let output = lines.join("\n");
  while (Buffer.byteLength(output, "utf8") > CONFIG_REGISTRY_LIMITS.renderedDiagnosticsBytes && lines.length > 1) {
    lines.splice(-2, 1);
    output = lines.join("\n");
  }
  return output;
}
