import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveContainedPath } from "../core/safe-path";
import { sourceRange, type ConfigDiagnostic } from "./diagnostics";
import { CONFIG_REGISTRY_LIMITS } from "./paths";

const MANIFEST_SOURCE = ".pi/hive/hive-config.yaml";

export type ProjectDiscoveryResult =
  | { status: "unconfigured" }
  | { status: "found"; projectRoot: string; manifestPath: string; manifestSource: string }
  | { status: "invalid"; projectRoot?: string; manifestPath?: string; diagnostics: ConfigDiagnostic[]; truncated: false };

function diagnostic(code: ConfigDiagnostic["code"], message: string, source = MANIFEST_SOURCE): ConfigDiagnostic {
  return { code, severity: "error", message, source, range: sourceRange(0, 1, 1, 0, 1, 1) };
}

function markerExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

export function discoverConfigProject(cwd: string): ProjectDiscoveryResult {
  let current: string;
  try {
    current = realpathSync.native(cwd);
  } catch (_error) {
    return {
      status: "invalid",
      diagnostics: [diagnostic("PROJECT_DISCOVERY_FAILED", "Cannot canonicalize the configuration start directory.", ".")],
      truncated: false,
    };
  }

  for (let visited = 0; visited < CONFIG_REGISTRY_LIMITS.discoveryAncestors; visited++) {
    const marker = join(current, MANIFEST_SOURCE);
    try {
      if (markerExists(marker)) {
        const contained = resolveContainedPath(current, marker);
        if (!contained) {
          return {
            status: "invalid",
            projectRoot: current,
            manifestPath: marker,
            diagnostics: [diagnostic("MANIFEST_PATH_ESCAPE", "The root manifest resolves outside the configured project.")],
            truncated: false,
          };
        }
        return { status: "found", projectRoot: current, manifestPath: contained.canonicalPath, manifestSource: MANIFEST_SOURCE };
      }
    } catch (_error) {
      return {
        status: "invalid",
        projectRoot: current,
        manifestPath: marker,
        diagnostics: [diagnostic("PROJECT_DISCOVERY_FAILED", "Cannot inspect the configuration marker.")],
        truncated: false,
      };
    }
    const parent = dirname(current);
    if (parent === current) return { status: "unconfigured" };
    current = parent;
  }
  return {
    status: "invalid",
    projectRoot: current,
    diagnostics: [diagnostic("PROJECT_DISCOVERY_LIMIT_EXCEEDED", `Configuration discovery exceeded ${CONFIG_REGISTRY_LIMITS.discoveryAncestors} ancestors.`, ".")],
    truncated: false,
  };
}
