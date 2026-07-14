import type { AgentConfig, HiveConfig } from "./types";
import { AGENT_TYPES, PLAN_STAGES } from "./normalize";
import { agentSlug } from "./agent-tree";

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function assertString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
}

function assertBoolean(value: unknown, label: string) {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${label} must be true or false when provided.`);
}

function assertRequiredBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label} must be explicitly set to true or false.`);
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

function validateStringList(value: unknown, label: string) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list of strings.`);
  value.forEach((entry, index) => assertString(entry, `${label}[${index}]`));
}

function validateDomains(value: unknown, label: string) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  value.forEach((entry, index) => {
    assertObject(entry, `${label}[${index}]`);
    assertString(entry.path, `${label}[${index}].path`);
    assertRequiredBoolean(entry.read, `${label}[${index}].read`);
    assertRequiredBoolean(entry.upsert, `${label}[${index}].upsert`);
    assertRequiredBoolean(entry.delete, `${label}[${index}].delete`);
    validateStringList(entry.include, `${label}[${index}].include`);
    validateStringList(entry.exclude, `${label}[${index}].exclude`);
  });
}

function validateAgent(agent: AgentConfig, label: string, seen: Map<string, string>) {
  assertObject(agent, label);
  assertString(agent.name, `${label}.name`);
  assertString(agent.path, `${label}.path`);
  if (agent.slug !== undefined) assertString(agent.slug, `${label}.slug`);
  const key = agentSlug(agent);
  const prior = seen.get(key);
  if (prior) throw new Error(`Duplicate agent slug "${key}" at ${label}; already used at ${prior}.`);
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

// Validate the agent-type contract for one node. Runs AFTER frontmatter
// enrichment (agent-type lives in the .md, not hive-config.yaml). agent-type is
// REQUIRED and must be one of the five types; a clean break is acceptable
// because only a couple of repos use pi-hive today.
function validateAgentType(agent: AgentConfig, label: string) {
  const type = agent.agentType;
  if (type === undefined || type === null || String(type).trim() === "") {
    throw new Error(`${label}.agent-type is required (one of ${AGENT_TYPES.join(", ")}). Add 'agent-type:' to the agent's frontmatter.`);
  }
  if (!(AGENT_TYPES as readonly string[]).includes(String(type))) {
    throw new Error(`${label}.agent-type must be one of ${AGENT_TYPES.join(", ")}; got "${type}".`);
  }
  if (agent.stages !== undefined) {
    if (!Array.isArray(agent.stages)) throw new Error(`${label}.stages must be a list of planning gates (${PLAN_STAGES.join(", ")}).`);
    if (type !== "planner") throw new Error(`${label}.stages is only valid on an agent-type: planner (this agent is "${type}").`);
    agent.stages.forEach((stage, index) => {
      if (!(PLAN_STAGES as readonly string[]).includes(String(stage))) {
        throw new Error(`${label}.stages[${index}] must be one of ${PLAN_STAGES.join(", ")}; got "${stage}".`);
      }
    });
  }
  if (agent.network !== undefined && typeof agent.network !== "boolean") {
    throw new Error(`${label}.network must be true or false when provided.`);
  }
  if (agent.commit !== undefined && (typeof agent.commit !== "string" || !agent.commit.trim())) {
    throw new Error(`${label}.commit must be a non-empty string when provided.`);
  }
}

// Walk the enriched config tree (orchestrator + agents + nested members) and
// hard-fail if any node violates the agent-type contract.
export function validateAgentTypes(config: HiveConfig): void {
  const walk = (agent: AgentConfig | undefined, label: string) => {
    if (!agent) return;
    validateAgentType(agent, label);
    [...(agent.members || []), ...(agent.children || [])].forEach((child, index) => walk(child, `${label}.members[${index}]`));
  };
  walk(config.orchestrator, "orchestrator");
  (config.agents || []).forEach((agent, index) => walk(agent, `agents[${index}]`));
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
