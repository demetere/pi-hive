import type { RawManifestV1 } from "./types";
import type { YamlSourceMap } from "./yaml";
import {
  CONFIG_LIMITS,
  createDiagnosticCollector,
  sourceRange,
  type ConfigDiagnostic,
  type DiagnosticResult,
  type SourceRange,
} from "./diagnostics";
import {
  CONFIG_REGISTRY_LIMITS,
  resolveRegistryTarget,
  type ResourceKind,
} from "./paths";

export type RegistryEntryStatus = "available" | "failed";
export type KnowledgeDeclaration = NonNullable<RawManifestV1["knowledge"]>[string];

type DeclarationByKind = {
  agents: string;
  workflows: string;
  skills: string;
  knowledge: KnowledgeDeclaration;
};

export interface RegistryEntry<Kind extends ResourceKind = ResourceKind> {
  kind: Kind;
  id: string;
  declaredPath: string;
  declaredData: DeclarationByKind[Kind];
  sourceRange: SourceRange;
  projectPath?: string;
  canonicalPath?: string;
  status: RegistryEntryStatus;
  diagnosticCodes: readonly ConfigDiagnostic["code"][];
}

export interface ConfigRegistries {
  agents: RegistryEntry<"agents">[];
  workflows: RegistryEntry<"workflows">[];
  skills: RegistryEntry<"skills">[];
  knowledge: RegistryEntry<"knowledge">[];
}

export interface RegistryBuildResult {
  registries: ConfigRegistries;
  diagnostics: ConfigDiagnostic[];
  globalDiagnostics: ConfigDiagnostic[];
  truncated: boolean;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function rangeFor(sourceMap: YamlSourceMap, kind: ResourceKind, id: string): SourceRange {
  const entryPointer = `/${kind}/${pointer(id)}`;
  const pathPointer = kind === "knowledge" ? `${entryPointer}/path` : entryPointer;
  return sourceMap[pathPointer]?.value ?? sourceMap[entryPointer]?.value ?? sourceMap[`/${kind}`]?.value ?? sourceMap[""]?.value ?? sourceRange(0, 1, 1, 0, 1, 1);
}

function problem(
  code: ConfigDiagnostic["code"],
  source: string,
  range: SourceRange,
  id?: string,
): ConfigDiagnostic {
  const messages: Partial<Record<ConfigDiagnostic["code"], string>> = {
    CONFIG_PATH_INVALID: "The declared resource path is not a portable relative path.",
    CONFIG_PATH_TOO_LONG: `The declared resource path exceeds ${CONFIG_REGISTRY_LIMITS.declaredPathBytes} UTF-8 bytes.`,
    CONFIG_PATH_TOO_DEEP: `The declared resource path exceeds ${CONFIG_REGISTRY_LIMITS.pathSegments} segments.`,
    RESOURCE_PATH_ESCAPE: "The declared resource resolves outside the configured project.",
    RESOURCE_NOT_FOUND: "The declared resource does not exist.",
    RESOURCE_TYPE_MISMATCH: "The declared resource has the wrong filesystem type.",
    RESOURCE_ACCESS_FAILED: "The declared resource cannot be inspected.",
    WORKFLOW_PATH_INVALID: "Workflow resources must be direct .yaml children of the workflows directory.",
    REGISTRY_LIMIT_EXCEEDED: "The manifest registry safety limit was exceeded.",
    REGISTRY_DUPLICATE_TARGET: "Multiple IDs in one registry resolve to the same target.",
  };
  return {
    code,
    severity: "error",
    message: messages[code] ?? "Configuration registry validation failed.",
    source,
    range,
    ...(id ? { resourceId: id } : {}),
  };
}

function canonicalKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function declarationPath<Kind extends ResourceKind>(kind: Kind, data: DeclarationByKind[Kind]): string {
  return kind === "knowledge" ? (data as KnowledgeDeclaration).path : data as string;
}

export function buildManifestRegistries(
  projectRoot: string,
  configDirectory: string,
  manifest: RawManifestV1,
  sourceMap: YamlSourceMap,
  source: string,
): RegistryBuildResult {
  const resourceCollector = createDiagnosticCollector();
  const globalCollector = createDiagnosticCollector();
  const registries: ConfigRegistries = { agents: [], workflows: [], skills: [], knowledge: [] };
  const count = Object.keys(manifest.agents).length
    + Object.keys(manifest.workflows).length
    + Object.keys(manifest.skills ?? {}).length
    + Object.keys(manifest.knowledge ?? {}).length;
  let aggregateBytes = 0;

  const addGlobal = (diagnostic: ConfigDiagnostic): void => globalCollector.add(diagnostic);
  if (count > CONFIG_REGISTRY_LIMITS.registryEntries)
    addGlobal(problem("REGISTRY_LIMIT_EXCEEDED", source, sourceMap[""]?.value ?? sourceRange(0, 1, 1, 0, 1, 1)));

  function buildKind<Kind extends ResourceKind>(
    kind: Kind,
    raw: Readonly<Record<string, DeclarationByKind[Kind]>>,
    output: RegistryEntry<Kind>[],
  ): void {
    const targets = new Map<string, RegistryEntry<Kind>>();
    for (const id of Object.keys(raw).sort(compareStrings)) {
      const declaredData = raw[id];
      const declaredPath = declarationPath(kind, declaredData);
      aggregateBytes += Buffer.byteLength(declaredPath, "utf8");
      const declarationRange = rangeFor(sourceMap, kind, id);
      const target = resolveRegistryTarget(projectRoot, configDirectory, kind, declaredPath);
      const codes: ConfigDiagnostic["code"][] = [];
      if (!target.ok && target.code) {
        codes.push(target.code);
        resourceCollector.add(problem(target.code, source, declarationRange, id));
      }
      const entry: RegistryEntry<Kind> = {
        kind,
        id,
        declaredPath,
        declaredData,
        sourceRange: declarationRange,
        ...(target.projectPath ? { projectPath: target.projectPath } : {}),
        ...(target.canonicalPath ? { canonicalPath: target.canonicalPath } : {}),
        status: target.ok ? "available" : "failed",
        diagnosticCodes: codes,
      };
      output.push(entry);

      if (target.canonicalPath) {
        const key = canonicalKey(target.canonicalPath);
        const previous = targets.get(key);
        if (previous) {
          const duplicate = problem("REGISTRY_DUPLICATE_TARGET", source, declarationRange, id);
          addGlobal(duplicate);
          previous.status = "failed";
          entry.status = "failed";
          previous.diagnosticCodes = [...previous.diagnosticCodes, "REGISTRY_DUPLICATE_TARGET"];
          entry.diagnosticCodes = [...entry.diagnosticCodes, "REGISTRY_DUPLICATE_TARGET"];
        } else targets.set(key, entry);
      }
    }
  }

  buildKind("agents", manifest.agents, registries.agents);
  buildKind("workflows", manifest.workflows, registries.workflows);
  buildKind("skills", manifest.skills ?? {}, registries.skills);
  buildKind("knowledge", manifest.knowledge ?? {}, registries.knowledge);

  if (aggregateBytes > CONFIG_REGISTRY_LIMITS.aggregateDeclaredPathBytes)
    addGlobal(problem("REGISTRY_LIMIT_EXCEEDED", source, sourceMap[""]?.value ?? sourceRange(0, 1, 1, 0, 1, 1)));

  const globalResult = globalCollector.result();
  const resourceResult = resourceCollector.result();
  const combinedCollector = createDiagnosticCollector();
  for (const diagnostic of globalResult.diagnostics) combinedCollector.add(diagnostic);
  for (const diagnostic of resourceResult.diagnostics) combinedCollector.add(diagnostic);
  const combined = combinedCollector.result();
  return {
    registries,
    diagnostics: combined.diagnostics,
    globalDiagnostics: globalResult.diagnostics,
    truncated: globalResult.truncated || resourceResult.truncated || combined.truncated,
  };
}

export interface DependencyEdge {
  target: string;
  source?: string;
  range?: SourceRange;
}

export type DependencyEdgeInput = string | DependencyEdge;

function normalizeEdge(edge: DependencyEdgeInput): DependencyEdge {
  return typeof edge === "string" ? { target: edge } : edge;
}

function compareEdges(a: DependencyEdge, b: DependencyEdge): number {
  return compareStrings(a.target, b.target)
    || compareStrings(a.source ?? "", b.source ?? "")
    || (a.range?.start.offset ?? 0) - (b.range?.start.offset ?? 0)
    || (a.range?.end.offset ?? 0) - (b.range?.end.offset ?? 0);
}

function dependencyDiagnostic(
  code: "DEPENDENCY_CYCLE" | "DEPENDENCY_LIMIT_EXCEEDED",
  chain?: readonly string[],
  edge?: DependencyEdge,
): ConfigDiagnostic {
  return {
    code,
    severity: "error",
    message: code === "DEPENDENCY_CYCLE" ? "The dependency graph contains a cycle." : "The dependency graph exceeds its safety limit.",
    source: edge?.source ?? ".pi/hive/hive-config.yaml",
    range: edge?.range ?? sourceRange(0, 1, 1, 0, 1, 1),
    ...(chain ? { dependencyChain: chain } : {}),
  };
}

export function dependencyChains(
  graph: ReadonlyMap<string, readonly DependencyEdgeInput[]>,
  start: string,
): DiagnosticResult<readonly (readonly string[])[]> {
  const collector = createDiagnosticCollector();
  const nodes = new Set<string>([start]);
  let edges = 0;
  let overLimit = false;
  let limitEdge: DependencyEdge | undefined;
  for (const [node, dependencies] of graph) {
    nodes.add(node);
    if (nodes.size > CONFIG_REGISTRY_LIMITS.dependencyNodes) {
      overLimit = true;
      break;
    }
    for (const input of dependencies) {
      const edge = normalizeEdge(input);
      edges++;
      nodes.add(edge.target);
      if (nodes.size > CONFIG_REGISTRY_LIMITS.dependencyNodes || edges > CONFIG_REGISTRY_LIMITS.dependencyEdges) {
        overLimit = true;
        limitEdge = edge;
        break;
      }
    }
    if (overLimit) break;
  }
  if (overLimit) {
    collector.add(dependencyDiagnostic("DEPENDENCY_LIMIT_EXCEEDED", undefined, limitEdge));
    return collector.result([]);
  }

  const chains: string[][] = [];
  const stack: Array<{ node: string; path: string[]; incomingEdge?: DependencyEdge }> = [{ node: start, path: [start] }];
  let traversed = 0;
  while (stack.length > 0) {
    const { node, path, incomingEdge } = stack.pop()!;
    if (++traversed > CONFIG_REGISTRY_LIMITS.dependencyEdges + CONFIG_REGISTRY_LIMITS.dependencyNodes) {
      collector.add(dependencyDiagnostic("DEPENDENCY_LIMIT_EXCEEDED", path, incomingEdge));
      break;
    }
    const dependencies = [...(graph.get(node) ?? [])].map(normalizeEdge).sort(compareEdges);
    if (dependencies.length === 0) {
      chains.push(path);
      continue;
    }
    for (let index = dependencies.length - 1; index >= 0; index--) {
      const edge = dependencies[index];
      const dependency = edge.target;
      const next = [...path, dependency];
      if (next.length > CONFIG_LIMITS.dependencyChain) {
        chains.push(next.slice(0, CONFIG_LIMITS.dependencyChain));
        collector.add(dependencyDiagnostic("DEPENDENCY_LIMIT_EXCEEDED", next.slice(0, CONFIG_LIMITS.dependencyChain), edge));
      } else if (path.includes(dependency)) {
        chains.push(next);
        collector.add(dependencyDiagnostic("DEPENDENCY_CYCLE", next, edge));
      } else stack.push({ node: dependency, path: next, incomingEdge: edge });
    }
  }
  chains.sort((a, b) => compareStrings(a.join("\0"), b.join("\0")));
  return collector.result(chains);
}
