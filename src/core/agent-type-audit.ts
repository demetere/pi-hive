import { join, resolve } from "node:path";
import type { AgentType } from "./types";
import { parseFrontmatter, parseYamlLite } from "./yaml";
import { AGENT_TYPES, normalizeAgentType } from "./normalize";
import { safeRead } from "./fs";

// One agent's agent-type status, resilient to a config that no longer loads
// because validation now hard-fails on a missing/invalid agent-type. The doctor
// uses this to report offenders WITHOUT auto-writing any files.
export interface AgentTypeAuditRow {
  name: string;
  path?: string;
  hasReports: boolean;
  isOrchestrator: boolean;
  declared?: string;     // raw agent-type read from frontmatter (may be invalid)
  valid: boolean;        // declared is a legal AgentType
  suggestion: AgentType; // inferred type to suggest when missing/invalid
}

export interface AgentTypeAudit {
  rows: AgentTypeAuditRow[];
  offenders: AgentTypeAuditRow[]; // rows whose declared type is missing or invalid
}

// Infer a plausible agent-type from the agent's name + whether it leads. Used
// only to SUGGEST a fix in the doctor report; never written automatically.
export function inferAgentType(name: string, hasReports: boolean, isOrchestrator: boolean): AgentType {
  const text = name.toLowerCase();
  // Order matters: "test"/"verify" is checked before "review"/"qa" so a
  // "QA Tester" resolves to tester, not reviewer.
  if (/test|verif/.test(text)) return "tester";
  if (/review|audit|security|\bqa\b/.test(text)) return "reviewer";
  if (/plan|product|requirement|spec|design/.test(text)) return "planner";
  if (isOrchestrator || hasReports) return "lead";
  return "coder";
}

type RawAgentNode = {
  name?: unknown;
  path?: unknown;
  agentType?: unknown;
  members?: unknown;
  children?: unknown;
};

function childNodes(node: RawAgentNode): RawAgentNode[] {
  const members = Array.isArray(node.members) ? (node.members as RawAgentNode[]) : [];
  const children = Array.isArray(node.children) ? (node.children as RawAgentNode[]) : [];
  return [...members, ...children].filter((child) => child && typeof child === "object");
}

// Read agent-type from the node itself or, failing that, the agent's .md
// frontmatter — mirroring enrichFromFrontmatter, but tolerant of any errors so
// the audit still runs when the real loader would throw.
function declaredType(cwd: string, node: RawAgentNode): string | undefined {
  const onNode = normalizeAgentType(node.agentType);
  if (onNode !== undefined) return onNode;
  const path = typeof node.path === "string" ? node.path : undefined;
  if (!path) return undefined;
  try {
    const raw = safeRead(resolve(cwd, path));
    if (!raw) return undefined;
    const { attrs } = parseFrontmatter(raw);
    return normalizeAgentType(attrs.agentType);
  } catch {
    return undefined;
  }
}

// Audit every agent in .pi/hive/hive-config.yaml for a valid agent-type,
// tolerating a config that fails to load. Returns [] rows when the config is
// missing or unparseable (the doctor reports that separately).
export function auditAgentTypes(cwd: string): AgentTypeAudit {
  const rows: AgentTypeAuditRow[] = [];
  let parsed: any;
  try {
    const raw = safeRead(join(cwd, ".pi", "hive", "hive-config.yaml"));
    if (!raw) return { rows, offenders: [] };
    parsed = parseYamlLite(raw);
  } catch {
    return { rows, offenders: [] };
  }
  if (!parsed || typeof parsed !== "object") return { rows, offenders: [] };

  const visit = (node: RawAgentNode | undefined, isOrchestrator: boolean) => {
    if (!node || typeof node !== "object") return;
    const children = childNodes(node);
    const hasReports = isOrchestrator || children.length > 0;
    const name = typeof node.name === "string" && node.name.trim() ? node.name.trim() : "(unnamed)";
    const declared = declaredType(cwd, node);
    const valid = declared !== undefined && (AGENT_TYPES as readonly string[]).includes(declared);
    rows.push({
      name,
      path: typeof node.path === "string" ? node.path : undefined,
      hasReports,
      isOrchestrator,
      declared,
      valid,
      suggestion: inferAgentType(name, hasReports, isOrchestrator),
    });
    for (const child of children) visit(child, false);
  };

  // Walk every team block. Mirrors resolveTeams' back-compat: the hive team is
  // either an explicit `hive:` block or the legacy top-level main:/orchestrator:
  // + agents:; the planning team is an explicit `planning:` block.
  const walkTeam = (block: any) => {
    if (!block || typeof block !== "object") return;
    const main = block.main || block.orchestrator;
    if (main) visit(main as RawAgentNode, true);
    const agents = Array.isArray(block.agents) ? (block.agents as RawAgentNode[]) : [];
    for (const agent of agents) visit(agent, false);
  };

  const hiveBlock = parsed.hive || { main: parsed.main || parsed.orchestrator, agents: parsed.agents };
  walkTeam(hiveBlock);
  walkTeam(parsed.planning);

  // De-duplicate rows by name (a shared main node across blocks, or accidental
  // repeats) keeping the first — the report should list each agent once.
  const byName = new Map<string, AgentTypeAuditRow>();
  for (const row of rows) if (!byName.has(row.name.toLowerCase())) byName.set(row.name.toLowerCase(), row);
  const unique = Array.from(byName.values());
  return { rows: unique, offenders: unique.filter((row) => !row.valid) };
}
