import type { AgentConfig } from "./types";
import { slug } from "./format";

export function agentSlug(agent: Pick<AgentConfig, "slug" | "name">): string {
  return String(agent.slug || slug(agent.name || "agent")).trim().toLowerCase();
}

export function agentMatches(agent: Pick<AgentConfig, "slug" | "name">, value: string | undefined): boolean {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return false;
  return raw === agentSlug(agent) || raw === String(agent.name || "").trim().toLowerCase();
}

export function uniqueAgents(agents: AgentConfig[]): AgentConfig[] {
  const seen = new Set<string>();
  const unique: AgentConfig[] = [];
  for (const agent of agents) {
    const key = agentSlug(agent);
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
  if (agentMatches(agent, agentName)) return true;
  const children = childrenOverride || configuredChildAgents(agent);
  return children.some((child) => agentTreeContains(child, agentName));
}
