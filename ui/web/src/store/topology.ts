import type { AgentRuntime, Topology, TopologyNode } from "../types";

export function buildAgents(snap: { agents?: AgentRuntime[] } | undefined): Map<string, AgentRuntime> {
  const m = new Map<string, AgentRuntime>();
  for (const a of snap?.agents || []) m.set(a.name, a);
  return m;
}

// Flatten a topology into ordered nodes (for leaderboards / model mix).
export function flattenTopology(topo?: Topology): Topology["agents"] {
  const out: NonNullable<Topology["agents"]> = [];
  const walk = (node?: TopologyNode) => { if (!node) return; out.push(node); (node.children || []).forEach(walk); };
  walk(topo?.orchestrator);
  (topo?.agents || []).forEach(walk);
  return out;
}
