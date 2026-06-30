import type { DomainScope, KnowledgeRef } from "./types";

export function normalizeTools(tools: string | undefined, fallback: string): string {
  return (tools || fallback || "read, grep, find, ls")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean)
    .join(",");
}

export function normalizeWorkerTools(tools: string | undefined, fallback: string): string {
  // Nested delegation is intentionally enabled: workers may receive extension
  // tools such as delegate_agent when their per-agent config grants them.
  return normalizeTools(tools, fallback);
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
    }));
}

// Coerce a raw YAML capability value into the tri-state used by the matcher.
function triState(value: any): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

export function normalizeDomainScopes(value: any): DomainScope[] {
  if (!value) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .map((entry) => typeof entry === "string" ? { path: entry, read: true } : entry)
    .filter((entry) => entry?.path)
    .map((entry) => {
      const read = triState(entry.read);
      return {
        path: String(entry.path),
        // Back-compat: a scope that omits `read` historically meant read-allow.
        read: read === undefined ? true : read,
        upsert: triState(entry.upsert),
        delete: triState(entry.delete),
        description: entry.description ? String(entry.description) : undefined,
      };
    });
}
