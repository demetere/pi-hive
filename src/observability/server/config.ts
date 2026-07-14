import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export const PORT = Number(process.env.HIVE_TELEMETRY_PORT || 43191);
export const HOST = process.env.HIVE_TELEMETRY_HOST || "127.0.0.1";
export const SINGLE_LOG_PATH = process.env.HIVE_TELEMETRY_LOG || "";
export const HIVE_GLOBAL_DIR = path.join(process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"), "hive");
export const REGISTRY_PATH = process.env.HIVE_TELEMETRY_REGISTRY || path.join(HIVE_GLOBAL_DIR, "telemetry-sessions.jsonl");
export const DB_PATH = process.env.HIVE_TELEMETRY_DB || path.join(HIVE_GLOBAL_DIR, "telemetry.db");
export const CONVERSATION_LOG = process.env.HIVE_CONVERSATION_LOG || "";
export const BOOT_SESSION_ID = process.env.HIVE_SESSION_ID || "global";
export const PROJECT_CWD = process.env.HIVE_PROJECT_CWD || process.cwd();

// Per-daemon bearer token for write auth. Prefer the env passed at spawn; fall
// back to the persisted token file so a daemon restarted out of band still finds
// it. Empty means unavailable, never "authentication disabled"; writes fail closed.
export const DAEMON_TOKEN: string = (() => {
  const configured = process.env.HIVE_TELEMETRY_TOKEN?.trim();
  if (configured) return configured;
  const tokenPath = path.join(HIVE_GLOBAL_DIR, "daemon-token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch { /* mint below */ }
  try {
    fs.mkdirSync(HIVE_GLOBAL_DIR, { recursive: true, mode: 0o700 });
    const token = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
    fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600, flag: "wx" });
    return token;
  } catch {
    // Another process may have won the exclusive create race.
    try { return fs.readFileSync(tokenPath, "utf8").trim(); } catch { return ""; }
  }
})();
