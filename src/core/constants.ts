export const HIVE_TOOL_NAMES = new Set(["route_agent", "delegate_agent", "team_status", "team_conversation", "hive_sdd_status"]);

// Fixed layout (relative to cwd). The whole extension assumes this tree, so it is
// a convention, not a configurable knob.
export const HIVE_ROOT = ".pi/hive";
export const HIVE_AGENTS_DIR = `${HIVE_ROOT}/agents`;
export const HIVE_SESSIONS_DIR = `${HIVE_ROOT}/sessions`;
