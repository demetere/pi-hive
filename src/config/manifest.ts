import { readFileSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { discoverConfigProject } from "./discovery";
import { CONFIG_LIMITS, sourceRange, type ConfigDiagnostic } from "./diagnostics";
import { buildManifestRegistries, type ConfigRegistries } from "./registry";
import { validateManifestV1 } from "./schema";
import type { RawManifestV1 } from "./types";
import { parseConfigYaml, type YamlSourceMap } from "./yaml";

export interface UnconfiguredProject {
  status: "unconfigured";
}

export interface InvalidProject {
  status: "invalid";
  projectRoot?: string;
  manifestPath?: string;
  diagnostics: ConfigDiagnostic[];
  truncated: boolean;
}

export interface ConfiguredProject {
  status: "configured";
  projectRoot: string;
  manifestPath: string;
  manifestSource: string;
  rawSource: string;
  manifest: RawManifestV1;
  sourceMap: YamlSourceMap;
  registries: ConfigRegistries;
  diagnostics: ConfigDiagnostic[];
  truncated: boolean;
}

export type ConfigProjectResult = UnconfiguredProject | InvalidProject | ConfiguredProject;

export interface ManifestLoadOperations {
  stat?(path: string): Pick<Stats, "size" | "isFile">;
  readFile?(path: string): string;
}

function manifestDiagnostic(code: "MANIFEST_NOT_FILE" | "MANIFEST_READ_FAILED" | "CONFIG_INPUT_TOO_LARGE", source: string): ConfigDiagnostic {
  const message = code === "MANIFEST_NOT_FILE"
    ? "The root manifest is not a regular file."
    : code === "CONFIG_INPUT_TOO_LARGE"
      ? `The root manifest exceeds ${CONFIG_LIMITS.inputBytes} UTF-8 bytes.`
      : "The root manifest cannot be read.";
  return {
    code,
    severity: "error",
    message,
    source,
    range: sourceRange(0, 1, 1, 0, 1, 1),
  };
}

export function loadConfigProject(cwd: string, operations: ManifestLoadOperations = {}): ConfigProjectResult {
  const discovery = discoverConfigProject(cwd);
  if (discovery.status === "unconfigured") return discovery;
  if (discovery.status === "invalid") return discovery;

  let source: string;
  try {
    const stats = (operations.stat ?? statSync)(discovery.manifestPath);
    if (!stats.isFile()) {
      return {
        status: "invalid",
        projectRoot: discovery.projectRoot,
        manifestPath: discovery.manifestPath,
        diagnostics: [manifestDiagnostic("MANIFEST_NOT_FILE", discovery.manifestSource)],
        truncated: false,
      };
    }
    if (stats.size > CONFIG_LIMITS.inputBytes) {
      return {
        status: "invalid",
        projectRoot: discovery.projectRoot,
        manifestPath: discovery.manifestPath,
        diagnostics: [manifestDiagnostic("CONFIG_INPUT_TOO_LARGE", discovery.manifestSource)],
        truncated: false,
      };
    }
    source = operations.readFile?.(discovery.manifestPath) ?? readFileSync(discovery.manifestPath, "utf8");
  } catch {
    return {
      status: "invalid",
      projectRoot: discovery.projectRoot,
      manifestPath: discovery.manifestPath,
      diagnostics: [manifestDiagnostic("MANIFEST_READ_FAILED", discovery.manifestSource)],
      truncated: false,
    };
  }

  const parsed = parseConfigYaml(source, discovery.manifestSource);
  if (!parsed.value) {
    return {
      status: "invalid",
      projectRoot: discovery.projectRoot,
      manifestPath: discovery.manifestPath,
      diagnostics: parsed.diagnostics,
      truncated: parsed.truncated,
    };
  }
  const validated = validateManifestV1(parsed.value.data, discovery.manifestSource, parsed.value.sourceMap);
  if (!validated.value) {
    return {
      status: "invalid",
      projectRoot: discovery.projectRoot,
      manifestPath: discovery.manifestPath,
      diagnostics: validated.diagnostics,
      truncated: validated.truncated,
    };
  }

  const registry = buildManifestRegistries(
    discovery.projectRoot,
    join(discovery.projectRoot, ".pi", "hive"),
    validated.value,
    parsed.value.sourceMap,
    discovery.manifestSource,
  );
  if (registry.globalDiagnostics.length > 0) {
    return {
      status: "invalid",
      projectRoot: discovery.projectRoot,
      manifestPath: discovery.manifestPath,
      diagnostics: registry.diagnostics,
      truncated: registry.truncated,
    };
  }
  return {
    status: "configured",
    projectRoot: discovery.projectRoot,
    manifestPath: discovery.manifestPath,
    manifestSource: discovery.manifestSource,
    rawSource: source,
    manifest: validated.value,
    sourceMap: parsed.value.sourceMap,
    registries: registry.registries,
    diagnostics: registry.diagnostics,
    truncated: registry.truncated,
  };
}
