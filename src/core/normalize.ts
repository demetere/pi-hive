import type { AgentType, DomainScope, KnowledgeRef, PlanStage } from "./types";

export const AGENT_TYPES: readonly AgentType[] = ["planner", "coder", "tester", "reviewer", "lead"];
export const PLAN_STAGES: readonly PlanStage[] = ["proposal", "requirements", "design", "tasks"];

// Parse an agent-type value from frontmatter/config. Returns the lowercased
// enum member when valid, otherwise the raw string (so schema validation can
// hard-fail with a clear message) or undefined when absent.
export function normalizeAgentType(value: any): AgentType | string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim().toLowerCase();
  if (!text) return undefined;
  return (AGENT_TYPES as readonly string[]).includes(text) ? (text as AgentType) : text;
}

// Parse the planner stages list. Members are lowercased; validation decides
// whether each is a legal gate. Returns undefined when absent so "omitted"
// (= all gates) stays distinguishable from an explicit empty list.
export function normalizePlanStages(value: any): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeStringList(value).map((item) => item.toLowerCase());
}

// Trim commit guidance to a string; empty/whitespace collapses to undefined so
// "has a commit field" means "has non-empty guidance" (which unlocks the gate).
export function normalizeCommit(value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

export function normalizeTools(tools: string | undefined, fallback: string): string {
  return (tools || fallback || "read, grep, find, ls")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean)
    .join(",");
}

export function normalizeWorkerTools(tools: string | undefined, fallback: string): string {
  // Nested delegation is intentionally enabled: workers may receive extension
  // tools such as delegate_agent when their per-agent config grants them. Filter
  // retired Hive tools so older configs don't pass unknown names to child pi.
  return normalizeTools(tools, fallback)
    .split(",")
    .filter((tool) => tool !== "load_skill")
    .join(",");
}

export function normalizeStringList(value: any): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

export function normalizeKnowledgeRefs(value: any): KnowledgeRef[] {
  if (!value) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .map((entry) => typeof entry === "string" ? { path: entry } : entry)
    .filter((entry) => entry?.path)
    .map((entry) => ({
      path: String(entry.path),
      useWhen: entry.useWhen ? String(entry.useWhen) : undefined,
      updatable: Boolean(entry.updatable),
      allowOutsideProject: entry.allowOutsideProject === true,
    }));
}

function requiredBoolean(value: any, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be explicitly set to true or false.`);
  return value;
}

function optionalPatternList(value: any, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list of glob strings.`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${label}[${index}] must be a non-empty string.`);
    return item.trim();
  });
}

export function normalizeDomainScopes(value: any, label = "domain"): DomainScope[] {
  if (!value) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  return value
    .map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${label}[${index}] must be an object.`);
      const entryLabel = `${label}[${index}]`;
      if (typeof entry.path !== "string" || !entry.path.trim()) throw new Error(`${entryLabel}.path must be a non-empty string.`);
      return {
        path: String(entry.path),
        read: requiredBoolean(entry.read, `${entryLabel}.read`),
        upsert: requiredBoolean(entry.upsert, `${entryLabel}.upsert`),
        delete: requiredBoolean(entry.delete, `${entryLabel}.delete`),
        include: optionalPatternList(entry.include, `${entryLabel}.include`),
        exclude: optionalPatternList(entry.exclude, `${entryLabel}.exclude`),
        description: entry.description ? String(entry.description) : undefined,
        allowOutsideProject: entry.allowOutsideProject === true,
      };
    });
}
