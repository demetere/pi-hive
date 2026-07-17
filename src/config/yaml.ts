import {
  LineCounter,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
  type Pair,
  type YAMLMap,
} from "yaml";
import {
  CONFIG_LIMITS,
  createDiagnosticCollector,
  sourceRange,
  type ConfigDiagnosticCode,
  type DiagnosticResult,
  type SourceRange,
} from "./diagnostics";

export interface YamlSourceMapEntry {
  key?: SourceRange;
  value: SourceRange;
}

export type YamlSourceMap = Record<string, YamlSourceMapEntry>;

export interface ParsedConfigYaml {
  data: unknown;
  sourceMap: YamlSourceMap;
}

const YAML_12_CORE_TAGS = new Set([
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:map",
]);

function rangeAt(lineCounter: LineCounter, start: number, end: number): SourceRange {
  const startPosition = lineCounter.linePos(start);
  const endPosition = lineCounter.linePos(end);
  return sourceRange(
    start,
    Math.max(1, startPosition.line),
    Math.max(1, startPosition.col),
    end,
    Math.max(1, endPosition.line),
    Math.max(1, endPosition.col),
  );
}

function nodeRange(node: Node, lineCounter: LineCounter): SourceRange {
  const [start, valueEnd] = node.range ?? [0, 0];
  return rangeAt(lineCounter, start, valueEnd);
}

function errorRange(
  position: readonly [number, number] | undefined,
  lineCounter: LineCounter,
): SourceRange {
  return position ? rangeAt(lineCounter, position[0], position[1]) : rangeAt(lineCounter, 0, 0);
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function yamlErrorCode(code: string): ConfigDiagnosticCode {
  if (code === "DUPLICATE_KEY") return "YAML_DUPLICATE_KEY";
  if (code === "NON_STRING_KEY") return "YAML_NON_STRING_KEY";
  return "YAML_SYNTAX";
}

interface WalkEntry {
  node: Node;
  depth: number;
  pointer: string;
  keyRange?: SourceRange;
  recordSourceMap?: boolean;
}

function childrenOf(entry: WalkEntry, lineCounter: LineCounter): WalkEntry[] {
  if (isMap(entry.node)) {
    const children: WalkEntry[] = [];
    for (let index = entry.node.items.length - 1; index >= 0; index--) {
      const pair = entry.node.items[index] as Pair;
      const key = pair.key;
      const stringKey = isScalar(key) && typeof key.value === "string";
      if (isNode(key)) {
        children.push({
          node: key,
          depth: entry.depth + 1,
          pointer: entry.pointer,
          recordSourceMap: false,
        });
      }
      if (isNode(pair.value)) {
        children.push({
          node: pair.value,
          depth: entry.depth + 1,
          pointer: stringKey
            ? `${entry.pointer}/${pointerSegment(key.value as string)}`
            : entry.pointer,
          ...(stringKey ? { keyRange: nodeRange(key as Node, lineCounter) } : {}),
          recordSourceMap: stringKey,
        });
      }
    }
    return children;
  }

  if (isSeq(entry.node)) {
    const children: WalkEntry[] = [];
    for (let index = entry.node.items.length - 1; index >= 0; index--) {
      const child = entry.node.items[index];
      if (isNode(child)) {
        children.push({
          node: child,
          depth: entry.depth + 1,
          pointer: `${entry.pointer}/${index}`,
        });
      }
    }
    return children;
  }

  return [];
}

function inspectMappingKeys(
  map: YAMLMap,
  lineCounter: LineCounter,
  add: (code: ConfigDiagnosticCode, message: string, range: SourceRange) => void,
): void {
  for (const pair of map.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      const range = isNode(pair.key) ? nodeRange(pair.key, lineCounter) : rangeAt(lineCounter, 0, 0);
      add("YAML_NON_STRING_KEY", "YAML mapping keys must be strings.", range);
      continue;
    }
    if (pair.key.value === "<<" && pair.key.type === "PLAIN") {
      add(
        "YAML_MERGE_KEY_FORBIDDEN",
        "Plain YAML merge keys are not supported.",
        nodeRange(pair.key, lineCounter),
      );
    }
  }
}

export function parseConfigYaml(source: string, sourceName: string): DiagnosticResult<ParsedConfigYaml> {
  const collector = createDiagnosticCollector();
  const lineCounter = new LineCounter();
  const add = (code: ConfigDiagnosticCode, message: string, range: SourceRange) => {
    collector.add({ code, severity: "error", message, source: sourceName, range });
  };

  const inputBytes = Buffer.byteLength(source, "utf8");
  if (inputBytes > CONFIG_LIMITS.inputBytes) {
    add(
      "CONFIG_INPUT_TOO_LARGE",
      `YAML input is ${inputBytes} UTF-8 bytes; the limit is ${CONFIG_LIMITS.inputBytes}.`,
      rangeAt(lineCounter, 0, 0),
    );
    return collector.result();
  }

  let document;
  try {
    document = parseDocument(source, {
      version: "1.2",
      schema: "core",
      strict: true,
      stringKeys: false,
      uniqueKeys: true,
      merge: false,
      resolveKnownTags: false,
      customTags: [],
      lineCounter,
      prettyErrors: false,
      keepSourceTokens: false,
    });
  } catch (error) {
    add(
      "YAML_SYNTAX",
      `YAML parsing failed: ${error instanceof Error ? error.message : String(error)}`,
      rangeAt(lineCounter, 0, 0),
    );
    return collector.result();
  }

  for (const error of document.errors) {
    add(yamlErrorCode(error.code), error.message, errorRange(error.pos, lineCounter));
  }
  if (document.errors.length > 0) return collector.result();

  if (document.directives.yaml.explicit && document.directives.yaml.version !== "1.2") {
    add("YAML_SYNTAX", "Only an explicit YAML 1.2 directive is supported.", rangeAt(lineCounter, 0, 0));
  }

  const tagWarnings = document.warnings.filter((warning) => warning.code === "TAG_RESOLVE_FAILED");
  for (const warning of tagWarnings) {
    add("YAML_TAG_FORBIDDEN", "Custom and legacy YAML tags are not supported.", errorRange(warning.pos, lineCounter));
  }
  for (const warning of document.warnings) {
    if (warning.code !== "TAG_RESOLVE_FAILED") {
      add("YAML_SYNTAX", warning.message, errorRange(warning.pos, lineCounter));
    }
  }

  const sourceMap: YamlSourceMap = {};
  const root = document.contents;
  if (isNode(root)) {
    const stack: WalkEntry[] = [{ node: root, depth: 1, pointer: "" }];
    let nodeCount = 0;
    let forbiddenTagsWithoutWarning = 0;

    while (stack.length > 0) {
      const entry = stack.pop()!;
      nodeCount++;
      if (nodeCount > CONFIG_LIMITS.maxNodes) {
        add(
          "YAML_MAX_NODES",
          `YAML contains more than ${CONFIG_LIMITS.maxNodes} AST nodes.`,
          nodeRange(entry.node, lineCounter),
        );
        break;
      }
      if (entry.depth > CONFIG_LIMITS.maxDepth) {
        add(
          "YAML_MAX_DEPTH",
          `YAML nesting exceeds the maximum depth of ${CONFIG_LIMITS.maxDepth}.`,
          nodeRange(entry.node, lineCounter),
        );
        break;
      }

      if (entry.recordSourceMap !== false) {
        sourceMap[entry.pointer] = {
          ...(entry.keyRange ? { key: entry.keyRange } : {}),
          value: nodeRange(entry.node, lineCounter),
        };
      }

      if (entry.node.anchor) {
        add("YAML_ANCHOR_FORBIDDEN", "YAML anchors are not supported.", nodeRange(entry.node, lineCounter));
      }
      if (isAlias(entry.node)) {
        add("YAML_ALIAS_FORBIDDEN", "YAML aliases are not supported.", nodeRange(entry.node, lineCounter));
      }
      if (entry.node.tag && !YAML_12_CORE_TAGS.has(entry.node.tag)) {
        if (forbiddenTagsWithoutWarning >= tagWarnings.length) {
          add("YAML_TAG_FORBIDDEN", "Custom and legacy YAML tags are not supported.", nodeRange(entry.node, lineCounter));
        }
        forbiddenTagsWithoutWarning++;
      }
      if (isScalar(entry.node) && typeof entry.node.value === "number" && !Number.isFinite(entry.node.value)) {
        add("YAML_NON_FINITE_NUMBER", "YAML numbers must be finite.", nodeRange(entry.node, lineCounter));
      }
      if (isMap(entry.node)) {
        inspectMappingKeys(entry.node, lineCounter, add);
      }

      stack.push(...childrenOf(entry, lineCounter));
    }
  }

  const inspected = collector.result<ParsedConfigYaml>();
  if (inspected.diagnostics.length > 0) return inspected;

  try {
    const data = document.toJS({ maxAliasCount: 0, mapAsMap: false });
    return collector.result({ data, sourceMap });
  } catch (error) {
    add(
      "YAML_SYNTAX",
      `YAML conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      rangeAt(lineCounter, 0, 0),
    );
    return collector.result();
  }
}
