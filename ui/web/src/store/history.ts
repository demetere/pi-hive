import type { AgentRuntime, HiveEvent } from "../types";

export interface HistPeak { input: number; output: number; cost: number; runs: number; tools: number; }

function ensureAgent(history: Map<string, Map<string, HistPeak>>, sessionId: string, name: string): HistPeak {
  let agents = history.get(sessionId);
  if (!agents) { agents = new Map(); history.set(sessionId, agents); }
  let cur = agents.get(name);
  if (!cur) { cur = { input: 0, output: 0, cost: 0, runs: 0, tools: 0 }; agents.set(name, cur); }
  return cur;
}

function applyRuntimePeak(cur: HistPeak, rt: Partial<AgentRuntime> | undefined) {
  if (!rt || typeof rt !== "object") return;
  cur.input = Math.max(cur.input, Number(rt.inputTokens || 0));
  cur.output = Math.max(cur.output, Number(rt.outputTokens || 0));
  cur.cost = Math.max(cur.cost, Number(rt.costUsd || 0));
  cur.runs = Math.max(cur.runs, Number(rt.runCount || 0));
  cur.tools = Math.max(cur.tools, Number(rt.toolCount || 0));
}

// Historical peak per agent, per session, reconstructed from telemetry events.
// delegation_start/end carry the agent's cumulative runtime at that moment, and
// worker_tool_start lets child-only runs (whose parent snapshot never updates)
// still show a nonzero tool count. This durable record survives a pi reload and
// backstops live snapshots whose in-memory counters can be stale or 0.
export function buildHistoryBySession(events: HiveEvent[]): Map<string, Map<string, HistPeak>> {
  const bySession = new Map<string, Map<string, HistPeak>>();
  for (const e of events) {
    const p = e.payload || {};
    if (e.type === "delegation_start" || e.type === "delegation_end") {
      const rt = p.runtime;
      const name = rt?.name || (e.type === "delegation_start" ? p.to : p.from);
      if (!name) continue;
      const cur = ensureAgent(bySession, e.session_id, name);
      applyRuntimePeak(cur, rt);
      if (e.type === "delegation_start" && !cur.runs) cur.runs = 1;
    } else if (e.type === "worker_tool_start" && p.agent) {
      ensureAgent(bySession, e.session_id, p.agent).tools++;
    }
  }
  return bySession;
}

export function applyHistoryToRuntime(agent: AgentRuntime, peak: HistPeak) {
  const histTok = peak.input + peak.output;
  if ((agent.inputTokens || 0) + (agent.outputTokens || 0) < histTok) {
    agent.inputTokens = peak.input;
    agent.outputTokens = peak.output;
  }
  if ((agent.costUsd || 0) < peak.cost) agent.costUsd = peak.cost;
  if ((agent.runCount || 0) < peak.runs) agent.runCount = peak.runs;
  if ((agent.toolCount || 0) < peak.tools) agent.toolCount = peak.tools;
}

export function historyTotals(history: Map<string, Map<string, HistPeak>>, sessionId: string): { tokens: number; cost: number } {
  const agents = history.get(sessionId);
  if (!agents) return { tokens: 0, cost: 0 };
  let tokens = 0, cost = 0;
  for (const p of agents.values()) { tokens += p.input + p.output; cost += p.cost; }
  return { tokens, cost };
}
