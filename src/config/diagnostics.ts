export const CONFIG_LIMITS = Object.freeze({
  inputBytes: 524_288,
  maxDepth: 64,
  maxNodes: 20_000,
  diagnostics: 100,
  related: 16,
  dependencyChain: 16,
  messageBytes: 2_048,
});

export const CONFIG_DIAGNOSTIC_CODES = [
  "CONFIG_INPUT_TOO_LARGE",
  "YAML_SYNTAX",
  "YAML_DUPLICATE_KEY",
  "YAML_ANCHOR_FORBIDDEN",
  "YAML_ALIAS_FORBIDDEN",
  "YAML_MERGE_KEY_FORBIDDEN",
  "YAML_TAG_FORBIDDEN",
  "YAML_NON_STRING_KEY",
  "YAML_NON_FINITE_NUMBER",
  "YAML_MAX_DEPTH",
  "YAML_MAX_NODES",
  "SCHEMA_VERSION_MISSING",
  "SCHEMA_VERSION_UNSUPPORTED",
  "SCHEMA_INVALID",
  "DIAGNOSTICS_TRUNCATED",
] as const;

export type ConfigDiagnosticCode = typeof CONFIG_DIAGNOSTIC_CODES[number];
export type DiagnosticSeverity = "error" | "warning";

export interface SourcePosition {
  /** Zero-based UTF-16 source offset. */
  offset: number;
  /** One-based source line. */
  line: number;
  /** One-based UTF-16 source column. */
  column: number;
}

export interface SourceRange {
  /** Half-open range start. */
  start: SourcePosition;
  /** Half-open range end. */
  end: SourcePosition;
}

export interface RelatedDiagnostic {
  message: string;
  source: string;
  range: SourceRange;
}

export interface ConfigDiagnostic {
  code: ConfigDiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  source: string;
  range: SourceRange;
  resourceId?: string;
  dependencyChain?: readonly string[];
  related?: readonly RelatedDiagnostic[];
}

export interface DiagnosticResult<T> {
  value?: T;
  diagnostics: ConfigDiagnostic[];
  truncated: boolean;
}

export function sourceRange(
  startOffset: number,
  startLine: number,
  startColumn: number,
  endOffset: number,
  endLine: number,
  endColumn: number,
): SourceRange {
  return {
    start: { offset: startOffset, line: startLine, column: startColumn },
    end: { offset: endOffset, line: endLine, column: endColumn },
  };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const suffix = "…";
  const bodyLimit = maximumBytes - Buffer.byteLength(suffix, "utf8");
  let body = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > bodyLimit) break;
    body += character;
    bytes += size;
  }
  return `${body}${suffix}`;
}

function boundDiagnostic(diagnostic: ConfigDiagnostic): ConfigDiagnostic {
  return {
    ...diagnostic,
    message: truncateUtf8(diagnostic.message, CONFIG_LIMITS.messageBytes),
    dependencyChain: diagnostic.dependencyChain?.slice(0, CONFIG_LIMITS.dependencyChain),
    related: diagnostic.related?.slice(0, CONFIG_LIMITS.related).map((related) => ({
      ...related,
      message: truncateUtf8(related.message, CONFIG_LIMITS.messageBytes),
    })),
  };
}

export interface DiagnosticCollector {
  add(diagnostic: ConfigDiagnostic): void;
  result<T>(value?: T): DiagnosticResult<T>;
}

export function createDiagnosticCollector(): DiagnosticCollector {
  const diagnostics: ConfigDiagnostic[] = [];
  let truncated = false;

  return {
    add(diagnostic) {
      if (truncated) return;
      const bounded = boundDiagnostic(diagnostic);
      if (diagnostics.length < CONFIG_LIMITS.diagnostics) {
        diagnostics.push(bounded);
        return;
      }

      truncated = true;
      const markerRange = diagnostics.at(-1)?.range ?? sourceRange(0, 1, 1, 0, 1, 1);
      const markerSource = diagnostics.at(-1)?.source ?? diagnostic.source;
      diagnostics[CONFIG_LIMITS.diagnostics - 1] = {
        code: "DIAGNOSTICS_TRUNCATED",
        severity: "error",
        message: `Additional diagnostics were omitted after the ${CONFIG_LIMITS.diagnostics - 1}-item reporting limit.`,
        source: markerSource,
        range: markerRange,
      };
    },
    result<T>(value?: T) {
      return value === undefined
        ? { diagnostics: [...diagnostics], truncated }
        : { value, diagnostics: [...diagnostics], truncated };
    },
  };
}
