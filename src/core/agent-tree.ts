import type { AgentConfig } from "./types";

export function uniqueAgents(agents: AgentConfig[]): AgentConfig[] {
  const seen = new Set<string>();
  const unique: AgentConfig[] = [];
  for (const agent of agents) {
    const key = agent.name?.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(agent);
  }
  return unique;
}

export function configuredChildAgents(agent: AgentConfig): AgentConfig[] {
  return uniqueAgents([...(agent.members || []), ...(agent.children || [])]);
}

export function flatAgentConfig(agent: AgentConfig): AgentConfig {
  const { members: _members, children: _children, ...flatAgent } = agent;
  return flatAgent;
}

export function agentTreeContains(agent: AgentConfig, agentName: string, childrenOverride?: AgentConfig[]): boolean {
  if (agent.name.toLowerCase() === agentName.toLowerCase()) return true;
  const children = childrenOverride || configuredChildAgents(agent);
  return children.some((child) => agentTreeContains(child, agentName));
}
