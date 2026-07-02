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
