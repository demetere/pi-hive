import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { DAEMON_PROTOCOL_VERSION, dashboardBuildHash, packageVersion } from "../../shared/daemon-protocol";

function validatedPort(): number {
  const raw = process.env.HIVE_TELEMETRY_PORT || "43191";
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid HIVE_TELEMETRY_PORT: ${raw}`);
  return port;
}

function validatedHost(): string {
  const raw = (process.env.HIVE_TELEMETRY_HOST || "127.0.0.1").trim();
  if (!raw || raw.includes("://") || /[\s/?#]/.test(raw) || raw.length > 253) throw new Error(`Invalid HIVE_TELEMETRY_HOST: ${raw || "<empty>"}`);
  const host = raw.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!loopback && process.env.HIVE_TELEMETRY_ALLOW_NON_LOOPBACK !== "1") {
    throw new Error(`Refusing non-loopback dashboard host "${raw}" without HIVE_TELEMETRY_ALLOW_NON_LOOPBACK=1`);
  }
  return host;
}

export const PORT = validatedPort();
export const HOST = validatedHost();
export const SINGLE_LOG_PATH = process.env.HIVE_TELEMETRY_LOG || "";
export const HIVE_GLOBAL_DIR = path.join(process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"), "hive");
export const REGISTRY_PATH = path.resolve(process.env.HIVE_TELEMETRY_REGISTRY || path.join(HIVE_GLOBAL_DIR, "telemetry-sessions.jsonl"));
export const DB_PATH = path.resolve(process.env.HIVE_TELEMETRY_DB || path.join(HIVE_GLOBAL_DIR, "telemetry.db"));
export const CONVERSATION_LOG = process.env.HIVE_CONVERSATION_LOG || "";
export const BOOT_SESSION_ID = process.env.HIVE_SESSION_ID || "global";
export const PROJECT_CWD = process.env.HIVE_PROJECT_CWD || process.cwd();

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const PROTOCOL_VERSION = Number(process.env.HIVE_DAEMON_PROTOCOL_VERSION || DAEMON_PROTOCOL_VERSION);
export const PACKAGE_VERSION = process.env.HIVE_DAEMON_PACKAGE_VERSION || packageVersion(EXTENSION_ROOT);
export const BUILD_HASH = process.env.HIVE_DAEMON_BUILD_HASH || dashboardBuildHash(EXTENSION_ROOT);
export const STARTUP_NONCE = process.env.HIVE_DAEMON_STARTUP_NONCE || randomUUID();

// Empty credentials always fail closed. The extension passes a fresh token to a
// managed spawn and publishes it only after identity-checked health readiness.
// An out-of-band start may reuse an existing private token but never mints one
// before the listener is known healthy.
export const DAEMON_TOKEN: string = (() => {
  const configured = process.env.HIVE_TELEMETRY_TOKEN?.trim();
  if (configured) return configured;
  try { return fs.readFileSync(path.join(path.dirname(REGISTRY_PATH), "daemon-token"), "utf8").trim(); } catch { return ""; }
})();

export function expectedHostHeader(): string {
  const host = HOST.includes(":") ? `[${HOST}]` : HOST;
  return `${host}:${PORT}`.toLowerCase();
}
