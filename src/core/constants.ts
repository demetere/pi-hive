export const HIVE_TOOL_NAMES = new Set(["route_agent", "delegate_agent", "team_status", "team_conversation", "hive_sdd_status", "submit_review_verdict", "plan_new", "plan_select", "ask_user"]);

// Hive tools that are granted by AGENT TYPE, not by the per-agent tools list, so
// they survive dispatch's tools-list filter (a reviewer need not list its own
// verdict tool). buildHiveTools only emits them for the eligible type. Plan
// approval is no longer a tool — it happens in the dashboard's plan-review UI.
export const TYPE_SCOPED_TOOL_NAMES = new Set(["submit_review_verdict", "plan_new", "plan_select"]);

// Fixed layout (relative to cwd). The whole extension assumes this tree, so it is
// a convention, not a configurable knob.
export const HIVE_ROOT = ".pi/hive";
export const HIVE_AGENTS_DIR = `${HIVE_ROOT}/agents`;
export const HIVE_SESSIONS_DIR = `${HIVE_ROOT}/sessions`;
