import type { AgentConfig, HiveConfig } from "./types";

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function assertString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
}

function assertBoolean(value: unknown, label: string) {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${label} must be true or false when provided.`);
}

function assertNumber(value: unknown, label: string) {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${label} must be a finite number when provided.`);
}

function validateKnowledgeRefs(value: unknown, label: string) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  value.forEach((entry, index) => {
    assertObject(entry, `${label}[${index}]`);
    assertString(entry.path, `${label}[${index}].path`);
  });
}

function validateDomains(value: unknown, label: string) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  value.forEach((entry, index) => {
    assertObject(entry, `${label}[${index}]`);
    assertString(entry.path, `${label}[${index}].path`);
    assertBoolean(entry.read, `${label}[${index}].read`);
    assertBoolean(entry.upsert, `${label}[${index}].upsert`);
    assertBoolean(entry.delete, `${label}[${index}].delete`);
  });
}

function validateAgent(agent: AgentConfig, label: string, seen: Map<string, string>) {
  assertObject(agent, label);
  assertString(agent.name, `${label}.name`);
  assertString(agent.path, `${label}.path`);
  const key = agent.name.toLowerCase();
  const prior = seen.get(key);
  if (prior) throw new Error(`Duplicate agent name "${agent.name}" at ${label}; already used at ${prior}.`);
  seen.set(key, label);
  if (agent.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(agent.color))) throw new Error(`${label}.color must be #rrggbb when provided.`);
  if (agent.routingTags !== undefined && !Array.isArray(agent.routingTags)) throw new Error(`${label}.routingTags must be a list.`);
  if (agent.responsibilities !== undefined && !Array.isArray(agent.responsibilities)) throw new Error(`${label}.responsibilities must be a list.`);
  validateKnowledgeRefs(agent.context, `${label}.context`);
  validateKnowledgeRefs(agent.skills, `${label}.skills`);
  validateDomains(agent.domain, `${label}.domain`);
  if (agent.members !== undefined && !Array.isArray(agent.members)) throw new Error(`${label}.members must be a list.`);
  if (agent.children !== undefined && !Array.isArray(agent.children)) throw new Error(`${label}.children must be a list.`);
  [...(agent.members || []), ...(agent.children || [])].forEach((child, index) => validateAgent(child, `${label}.members[${index}]`, seen));
}

export function validateHiveConfigShape(config: HiveConfig): void {
  assertObject(config, "hive-config.yaml");
  validateAgent(config.orchestrator, "orchestrator", new Map());
  if (config.sharedContext !== undefined && !Array.isArray(config.sharedContext)) throw new Error("shared_context must be a list.");
  if (config.agents !== undefined && !Array.isArray(config.agents)) throw new Error("agents must be a list.");
  const seen = new Map([[config.orchestrator.name.toLowerCase(), "orchestrator"]]);
  (config.agents || []).forEach((agent, index) => validateAgent(agent, `agents[${index}]`, seen));
  if (config.settings) {
    assertObject(config.settings, "settings");
    assertNumber(config.settings.subagentOutputLimit, "settings.subagentOutputLimit");
    assertNumber(config.settings.maxParallel, "settings.maxParallel");
    if (config.settings.distiller) {
      assertObject(config.settings.distiller, "settings.distiller");
      assertBoolean(config.settings.distiller.enabled, "settings.distiller.enabled");
      assertNumber(config.settings.distiller.conversationLines, "settings.distiller.conversationLines");
    }
  }
}
