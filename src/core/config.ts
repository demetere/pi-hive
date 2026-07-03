import { join, resolve } from "node:path";
import type { AgentConfig, HiveConfig, HiveMode, HiveTeam } from "./types";
import { parseYamlLite, parseFrontmatter } from "./yaml";
import { configuredChildAgents, flatAgentConfig, normalizeAgentType, normalizeCommit, normalizePlanStages, safeRead } from "./utils";
import { validateAgentTypes, validateHiveConfigShape } from "./schema";

// Read an agent's .md frontmatter and copy model/thinking onto the config node
// when the config itself does not set them. The config tree (from hive-config.
// yaml) does not carry model/thinking — those live in each agent's frontmatter,
// read lazily at spawn time. Without this, anything that reads model/thinking
// off the config node (e.g. the status modal, the footer) shows "inherit"/"off"
// even though the agent actually runs on its frontmatter model. Enriching here
// makes the config the single source of truth for display + spawn fallback.
// Warn if any raw config node carries `allowedAgents` (removed from the schema,
// H1). The delegation hierarchy is derived from `members`/`children`; honoring a
// user filter would silently fight that derivation. Warn-only — the value is
// ignored either way (derivation overwrites it).
function warnOnAllowedAgents(parsed: any): void {
  const seen: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if ("allowedAgents" in node) seen.push(String(node.name || "a node"));
    for (const child of node.members || node.children || []) walk(child);
  };
  for (const block of [parsed?.hive, parsed?.planning]) {
    if (!block) continue;
    walk(block.main || block.orchestrator);
    (block.agents || []).forEach(walk);
  }
  if (seen.length) {
    console.warn(`[pi-hive] 'allowedAgents' is no longer a config field and is ignored (found on: ${seen.join(", ")}). Delegation is derived from 'members'/'children'.`);
  }
}

// Warn (not throw) when the main-session node is not the expected type for its
// mode. The runtime policy is still safe, but a mismatched main identity makes
// prompts, tool affordances, and dashboard semantics confusing. Called after
// enrichment so agentType is populated from frontmatter.
function warnOnMainAgentTypes(planning: HiveTeam | undefined, hive: HiveTeam | undefined): void {
  const mismatches: string[] = [];
  if (planning?.main && planning.main.agentType !== "planner") {
    mismatches.push(`planning.main "${planning.main.name}" is agent-type: ${planning.main.agentType || "<missing>"}; expected agent-type: planner`);
  }
  if (hive?.main && hive.main.agentType !== "lead") {
    mismatches.push(`hive.main "${hive.main.name}" is agent-type: ${hive.main.agentType || "<missing>"}; expected agent-type: lead`);
  }
  if (mismatches.length) {
    console.warn(`[pi-hive] main agent type mismatch: ${mismatches.join("; ")}. This is currently warn-only, but these main-session types are the supported mode contract.`);
  }
}

// Phase 5.1: warn (not throw) when the planning team contains coder/tester
// agents. Plan mode only delegates to planners/leads/reviewers, so such agents
// are dead weight in the planning block — they can never run there. Called after
// enrichment so agentType is populated from frontmatter.
function warnOnPlanningExecutionAgents(planning: HiveTeam | undefined): void {
  if (!planning) return;
  const offenders: string[] = [];
  const walk = (node: AgentConfig | undefined) => {
    if (!node) return;
    if (node.agentType === "coder" || node.agentType === "tester") {
      offenders.push(`${node.name} (${node.agentType})`);
    }
    for (const child of node.members || node.children || []) walk(child);
  };
  walk(planning.main);
  (planning.agents || []).forEach(walk);
  if (offenders.length) {
    console.warn(`[pi-hive] planning block contains execution agents that plan mode cannot delegate to (${offenders.join(", ")}). Plan mode only delegates to planners/leads/reviewers; move coders/testers to the 'hive:' block.`);
  }
}

function enrichFromFrontmatter(cwd: string, agent: AgentConfig | undefined): void {
  if (!agent) return;
  // agent-type/stages/commit live in the agent's .md frontmatter (like
  // model/thinking) but must be validated at the config layer, so copy them
  // onto the config node whenever the node itself does not already set them.
  const needsEnrich = !agent.model || !agent.thinking || agent.agentType === undefined || agent.stages === undefined || agent.commit === undefined;
  if (agent.path && needsEnrich) {
    const raw = safeRead(resolve(cwd, agent.path));
    if (raw) {
      const { attrs } = parseFrontmatter(raw);
      if (!agent.model && attrs.model) agent.model = String(attrs.model).trim();
      if (!agent.thinking && attrs.thinking) agent.thinking = String(attrs.thinking).trim();
      if (agent.agentType === undefined) agent.agentType = normalizeAgentType(attrs.agentType) as AgentConfig["agentType"];
      if (agent.stages === undefined) agent.stages = normalizePlanStages(attrs.stages) as AgentConfig["stages"];
      if (agent.commit === undefined) agent.commit = normalizeCommit(attrs.commit);
    }
  }
  for (const child of agent.members || agent.children || []) enrichFromFrontmatter(cwd, child);
}

// The main-session node of a team block: `main:` (preferred) or the legacy
// `orchestrator:` alias.
function teamMain(block: any): AgentConfig | undefined {
  return block?.main || block?.orchestrator;
}

// Resolve the raw team blocks. The current architecture requires explicit,
// separate hierarchies for PLAN mode and HIVE execution mode. The legacy
// top-level `orchestrator:`/`agents:` shape is intentionally rejected so a
// project cannot silently run plan mode against the coding hierarchy.
function resolveTeams(parsed: any): { hive: HiveTeam; planning: HiveTeam } {
  if (!parsed.planning) throw new Error("hive-config.yaml must define a dedicated `planning:` team block for plan mode.");
  if (!parsed.hive) throw new Error("hive-config.yaml must define a dedicated `hive:` team block for execution mode.");
  const planning: HiveTeam = { main: teamMain(parsed.planning)!, agents: parsed.planning.agents || [] };
  const hive: HiveTeam = { main: teamMain(parsed.hive)!, agents: parsed.hive.agents || [] };
  if (!planning.main) throw new Error("planning.main is required (or planning.orchestrator as a legacy alias inside the planning block).");
  if (!hive.main) throw new Error("hive.main is required (or hive.orchestrator as a legacy alias inside the hive block).");
  return { hive, planning };
}

function enrichTeam(cwd: string, team: HiveTeam | undefined): void {
  if (!team) return;
  enrichFromFrontmatter(cwd, team.main);
  for (const agent of team.agents || []) enrichFromFrontmatter(cwd, agent);
}

export function loadConfig(cwd: string): HiveConfig {
  const configPath = join(cwd, ".pi", "hive", "hive-config.yaml");
  const raw = safeRead(configPath);
  if (!raw) throw new Error(`Missing config: ${configPath}`);
  const parsed = parseYamlLite(raw) as any;

  // H1 (Decision 7): allowedAgents is no longer a user config field — the
  // delegation hierarchy is derived from members/children. A user-set value was
  // silently discarded before; warn instead so the mechanism is discoverable.
  warnOnAllowedAgents(parsed);

  const { hive, planning } = resolveTeams(parsed);

  const settings = parsed.settings || ({} as HiveConfig["settings"]);
  const distiller = (settings as any).distiller || {};
  const distillerEnabled = distiller.enabled !== false;
  const distillerModel = String(distiller.model || "").trim();
  if (distillerEnabled && !distillerModel) {
    throw new Error("settings.distiller.model is required when the distiller is enabled (set a 'provider/id' model, or set distiller.enabled: false).");
  }

  // Populate model/thinking/agent-type on every node in BOTH teams from their
  // .md frontmatter, then validate shape + agent-type over both teams.
  enrichTeam(cwd, hive);
  enrichTeam(cwd, planning);
  // Structural validation: the active team must be a valid config; validate the
  // hive team as the canonical shape, plus each block's agents.
  validateHiveConfigShape({ orchestrator: hive.main, agents: hive.agents } as HiveConfig);
  if (planning) validateHiveConfigShape({ orchestrator: planning.main, agents: planning.agents } as HiveConfig);
  validateAgentTypes({ orchestrator: hive.main, agents: hive.agents } as HiveConfig);
  if (planning) validateAgentTypes({ orchestrator: planning.main, agents: planning.agents } as HiveConfig);
  // Mode contract checks stay warn-only for compatibility, but make confusing
  // config visible: plan mode's main session should be a planner and hive mode's
  // main session should be a lead.
  warnOnMainAgentTypes(planning, hive);
  // Phase 5.1: coder/tester agents in the planning block are undelegatable there
  // (plan mode only delegates to planners/leads/reviewers). Warn — don't throw —
  // so the config still loads; they simply never run during planning.
  warnOnPlanningExecutionAgents(planning);

  return {
    // Active team defaults to hive; applyMode swaps to planning in plan mode.
    orchestrator: hive.main,
    agents: hive.agents,
    hive,
    planning,
    // `parseKeyValue` only camelizes kebab-case, so the documented snake_case
    // `shared_context:` key arrives verbatim. Accept both here rather than
    // camelizing snake_case parser-wide (plan-store reads `session_id` raw).
    sharedContext: parsed.shared_context ?? parsed.sharedContext ?? [],
    settings: {
      subagentOutputLimit: Number(settings.subagentOutputLimit || 12_000),
      defaultTools: String(settings.defaultTools || "read, grep, find, ls"),
      maxParallel: Number(settings.maxParallel || 3),
      distiller: {
        enabled: distillerEnabled,
        model: distillerModel,
        conversationLines: Number(distiller.conversationLines || 200),
      },
    },
  };
}

// The team that is active for a given mode. Hive/normal use the hive execution
// team; plan uses the dedicated planning team. loadConfig requires both blocks,
// but the fallback keeps hand-built test configs from crashing.
export function teamForMode(config: HiveConfig, mode: HiveMode): HiveTeam {
  if (mode === "plan" && config.planning) return config.planning;
  return config.hive ?? { main: config.orchestrator, agents: config.agents };
}

// Flatten a team (main + reports) into runtime agent configs with derived roles.
// Accepts either a HiveConfig (uses its active orchestrator/agents) or an
// explicit HiveTeam. The main node is the root ("orchestrator" tree role); its
// direct reports are the top-level agents.
export function allConfiguredAgents(configOrTeam: HiveConfig | HiveTeam): AgentConfig[] {
  const main = (configOrTeam as HiveTeam).main ?? (configOrTeam as HiveConfig).orchestrator;
  const topLevel = (configOrTeam as HiveTeam).main ? (configOrTeam as HiveTeam).agents : (configOrTeam as HiveConfig).agents;
  const topLevelNames = topLevel.map((agent) => agent.name);
  const agents: AgentConfig[] = [{ ...flatAgentConfig(main), role: "orchestrator", allowedAgents: topLevelNames }];
  const seen = new Set<string>([main.name.toLowerCase()]);

  const visitAgent = (agent: AgentConfig, groupName: string, isTopLevel = false) => {
    const key = agent.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const children = configuredChildAgents(agent);
    const childNames = children.map((child) => child.name);
    agents.push({
      ...flatAgentConfig(agent),
      // Lead-ness is derived, never declared: a node is a lead if it is a
      // top-level report or has reports of its own (sub-lead). Leaves are members.
      role: isTopLevel || children.length > 0 ? "lead" : "member",
      groupName,
      allowedAgents: childNames,
    });

    for (const child of children) {
      visitAgent(child, groupName);
    }
  };

  // Each top-level agent's own name is the group label for its whole subtree.
  for (const agent of topLevel) {
    visitAgent(agent, agent.name, true);
  }
  return agents;
}
