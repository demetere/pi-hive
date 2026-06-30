import { join, resolve } from "node:path";
import type { AgentConfig, HiveConfig } from "./types";
import { parseYamlLite, parseFrontmatter } from "./yaml";
import { configuredChildAgents, flatAgentConfig, safeRead } from "./utils";

// Read an agent's .md frontmatter and copy model/thinking onto the config node
// when the config itself does not set them. The config tree (from hive-config.
// yaml) does not carry model/thinking — those live in each agent's frontmatter,
// read lazily at spawn time. Without this, anything that reads model/thinking
// off the config node (e.g. the status modal, the footer) shows "inherit"/"off"
// even though the agent actually runs on its frontmatter model. Enriching here
// makes the config the single source of truth for display + spawn fallback.
function enrichFromFrontmatter(cwd: string, agent: AgentConfig | undefined): void {
  if (!agent) return;
  if (agent.path && (!agent.model || !agent.thinking)) {
    const raw = safeRead(resolve(cwd, agent.path));
    if (raw) {
      const { attrs } = parseFrontmatter(raw);
      if (!agent.model && attrs.model) agent.model = String(attrs.model).trim();
      if (!agent.thinking && attrs.thinking) agent.thinking = String(attrs.thinking).trim();
    }
  }
  for (const child of agent.members || agent.children || []) enrichFromFrontmatter(cwd, child);
}

export function loadConfig(cwd: string): HiveConfig {
  const configPath = join(cwd, ".pi", "hive", "hive-config.yaml");
  const raw = safeRead(configPath);
  if (!raw) throw new Error(`Missing config: ${configPath}`);
  const parsed = parseYamlLite(raw) as HiveConfig;

  const settings = parsed.settings || ({} as HiveConfig["settings"]);
  const distiller = (settings as any).distiller || {};
  const distillerEnabled = distiller.enabled !== false;
  const distillerModel = String(distiller.model || "").trim();
  if (distillerEnabled && !distillerModel) {
    throw new Error("settings.distiller.model is required when the distiller is enabled (set a 'provider/id' model, or set distiller.enabled: false).");
  }
  // Populate model/thinking on every config node from its .md frontmatter so the
  // status canvas, footer, and spawn fallback all see real values.
  enrichFromFrontmatter(cwd, parsed.orchestrator);
  for (const agent of parsed.agents || []) enrichFromFrontmatter(cwd, agent);
  return {
    orchestrator: parsed.orchestrator,
    sharedContext: parsed.sharedContext || [],
    agents: parsed.agents || [],
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

export function allConfiguredAgents(config: HiveConfig): AgentConfig[] {
  // The orchestrator is the hierarchy root: its direct reports are the top-level
  // agents. It delegates only to them — they fan out to their own members. This
  // mirrors the agents/<lead>/... folder tree.
  const topLevelNames = config.agents.map((agent) => agent.name);
  const agents: AgentConfig[] = [{ ...flatAgentConfig(config.orchestrator), role: "orchestrator", allowedAgents: topLevelNames }];
  const seen = new Set<string>([config.orchestrator.name.toLowerCase()]);

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
  for (const agent of config.agents) {
    visitAgent(agent, agent.name, true);
  }
  return agents;
}
