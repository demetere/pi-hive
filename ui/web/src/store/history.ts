import type { HiveEvent } from "../types";

export interface HistPeak { input: number; output: number; cost: number; }

// Historical peak per agent, per session, reconstructed from delegation_end
// events (each carries the agent's cumulative runtime at that moment). This is
// the durable record that survives a pi reload, so it backstops a live snapshot
// whose in-memory counters reset to 0 on reload.
export function buildHistoryBySession(events: HiveEvent[]): Map<string, Map<string, HistPeak>> {
  const bySession = new Map<string, Map<string, HistPeak>>();
  for (const e of events) {
    if (e.type !== "delegation_end") continue;
    const rt = e.payload?.runtime;
    const name = rt?.name || e.payload?.from;
    if (!rt || !name) continue;
    let agents = bySession.get(e.session_id);
    if (!agents) { agents = new Map(); bySession.set(e.session_id, agents); }
    const cur = agents.get(name) || { input: 0, output: 0, cost: 0 };
    cur.input = Math.max(cur.input, Number(rt.inputTokens || 0));
    cur.output = Math.max(cur.output, Number(rt.outputTokens || 0));
    cur.cost = Math.max(cur.cost, Number(rt.costUsd || 0));
    agents.set(name, cur);
  }
  return bySession;
}

export function historyTotals(history: Map<string, Map<string, HistPeak>>, sessionId: string): { tokens: number; cost: number } {
  const agents = history.get(sessionId);
  if (!agents) return { tokens: 0, cost: 0 };
  let tokens = 0, cost = 0;
  for (const p of agents.values()) { tokens += p.input + p.output; cost += p.cost; }
  return { tokens, cost };
}
