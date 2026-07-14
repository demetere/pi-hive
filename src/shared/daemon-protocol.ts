import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const DAEMON_PROTOCOL_VERSION = 1;

export interface DaemonIdentity {
  protocolVersion: number;
  packageVersion: string;
  buildHash: string;
  registryPath: string;
  dbPath: string;
  startupNonce: string;
}

export interface DaemonHealth extends DaemonIdentity {
  ok: true;
  mode: "global";
  pid: number;
}

function readTrimmed(path: string): string {
  try { return readFileSync(path, "utf8").trim(); } catch { return ""; }
}

export function packageVersion(extensionRoot: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

export function dashboardBuildHash(extensionRoot: string): string {
  return readTrimmed(join(extensionRoot, "ui", "web", "dist", ".build-hash")) || "unknown";
}

export function daemonIdentity(
  extensionRoot: string,
  registryPath: string,
  dbPath: string,
  startupNonce: string,
): DaemonIdentity {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    packageVersion: packageVersion(extensionRoot),
    buildHash: dashboardBuildHash(extensionRoot),
    registryPath: resolve(registryPath),
    dbPath: resolve(dbPath),
    startupNonce,
  };
}

export function isCompatibleDaemon(actual: DaemonHealth, expected: Omit<DaemonIdentity, "startupNonce">): boolean {
  return actual.ok === true
    && actual.mode === "global"
    && actual.protocolVersion === expected.protocolVersion
    && actual.packageVersion === expected.packageVersion
    && actual.buildHash === expected.buildHash
    && resolve(actual.registryPath) === resolve(expected.registryPath)
    && resolve(actual.dbPath) === resolve(expected.dbPath);
}
