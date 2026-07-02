import { createHash } from "node:crypto";
import type { HiveStateSnapshot, TopologyNode } from "../../shared/telemetry";

// Content-addressed team topology (Phase C). Each unique team CONFIGURATION gets
// one immutable hash; sessions reference the hash they ran under so historical
// sessions render the exact topology that existed at the time (Decision 3).
//
// The hash granularity is the full config-derived pair {planning, hive} per
// project — a change to either team is a new configuration epoch. Hashing is
// daemon-side (Decision 4): node:crypto is available in Bun and historical JSONL
// replay retro-versions old sessions for free.

// Identity/config fields kept in the canonical form, in a fixed order. Volatile
// runtime fields (status, tokens, cost, contextPct, toolCount, elapsedMs,
// lastWork, active, …) are stripped. `thinkingLevels` is EXCLUDED from the hash
// (Decision 13): an SDK/provider update changing a model's level map must not
// mint a new topology version — the user's config didn't change.
function canonicalNode(node: TopologyNode): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: node.name,
    role: node.role ?? null,
    agentType: node.agentType ?? null,
    model: node.model ?? null,
    thinking: node.thinking ?? null,
    tools: node.tools ?? null,
    stages: node.stages ?? null,
    group: node.group ?? null,
    color: node.color ?? null,
    consultWhen: node.consultWhen ?? null,
    routingTags: node.routingTags ?? null,
    domain: node.domain ?? null,
    commit: node.commit ?? null,
    responsibilities: node.responsibilities ?? null,
    // children recurse, order-preserving (config order is meaningful).
    children: (node.children || []).map(canonicalNode),
  };
  return out;
}

function canonicalTeam(team: HiveStateSnapshot["topology"] | undefined): Record<string, unknown> | null {
  if (!team) return null;
  return {
    orchestrator: team.orchestrator ? canonicalNode(team.orchestrator) : null,
    agents: (team.agents || []).map(canonicalNode),
  };
}

// The canonical form of the {planning, hive} pair. Object keys are emitted in a
// fixed order (planning, hive) and node keys in the fixed order above, so
// stringify is deterministic; arrays stay order-preserving.
export function canonicalTopology(topologies: HiveStateSnapshot["topologies"] | undefined): Record<string, unknown> {
  return {
    planning: canonicalTeam(topologies?.planning),
    hive: canonicalTeam(topologies?.hive),
  };
}

export function canonicalTopologyJson(topologies: HiveStateSnapshot["topologies"] | undefined): string {
  return JSON.stringify(canonicalTopology(topologies));
}

export function topologyHash(topologies: HiveStateSnapshot["topologies"] | undefined): string {
  return createHash("sha256").update(canonicalTopologyJson(topologies)).digest("hex");
}

// Explode a canonical team into flat preorder rows for topology_nodes. node_id
// is the preorder index within (hash, team); parent_id comes from the walk.
// Stable because the canonical JSON is order-preserving.
export interface ExplodedNode {
  team: string;
  nodeId: number;
  parentId: number | null;
  node: TopologyNode;
}

export function explodeTeam(team: HiveStateSnapshot["topology"] | undefined, teamName: string): ExplodedNode[] {
  if (!team) return [];
  const rows: ExplodedNode[] = [];
  let counter = 0;
  const walk = (node: TopologyNode, parentId: number | null) => {
    const nodeId = counter++;
    rows.push({ team: teamName, nodeId, parentId, node });
    for (const child of node.children || []) walk(child, nodeId);
  };
  // The team's main/root node (orchestrator) is the tree root; its configured
  // agents are its children in config order.
  if (team.orchestrator) {
    const rootId = counter++;
    rows.push({ team: teamName, nodeId: rootId, parentId: null, node: team.orchestrator });
    for (const agent of team.agents || []) walk(agent, rootId);
  } else {
    for (const agent of team.agents || []) walk(agent, null);
  }
  return rows;
}

export function explodeTopology(topologies: HiveStateSnapshot["topologies"] | undefined): ExplodedNode[] {
  return [
    ...explodeTeam(topologies?.planning, "planning"),
    ...explodeTeam(topologies?.hive, "hive"),
  ];
}
