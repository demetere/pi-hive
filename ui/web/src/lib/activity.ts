// Shared activity-feed helpers used by both the Activity tab and the Overview
// LiveActivity widget. Keeping the event-bundling logic in one place stops the
// two feeds from drifting.

export type ActivityItem =
  | { kind: "event"; id: string; type: string; ts: string; event: any }
  | { kind: "tool"; id: string; type: "worker_tool"; ts: string; start?: any; end?: any }
  | { kind: "thinking"; id: string; type: "thinking"; ts: string; agent: string; text: string; tokens?: number };

export function eventAgent(e: any): string {
  const p = e?.payload || {};
  return p.agent || p.to || p.from || e?.actor || "";
}

export function itemAgent(item: ActivityItem): string {
  if (item.kind === "thinking") return item.agent;
  return item.kind === "tool" ? eventAgent(item.start || item.end) : eventAgent(item.event);
}

// Merge thinking entries (from transcripts) into a bundled activity list,
// keeping everything sorted newest-first by timestamp.
export function mergeThinking(items: ActivityItem[], thinking: Array<{ agent: string; ts: string; text: string; tokens?: number }>): ActivityItem[] {
  if (!thinking.length) return items;
  const thinkItems: ActivityItem[] = thinking.map((t, i) => ({
    kind: "thinking", id: `think:${t.agent}:${t.ts}:${i}`, type: "thinking", ts: t.ts, agent: t.agent, text: t.text, tokens: t.tokens,
  }));
  return [...items, ...thinkItems].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

// Pairs worker_tool_start/worker_tool_end events into a single "tool" item and
// passes other events through, newest-first.
export function bundleEvents(events: any[]): ActivityItem[] {
  const pending = new Map<string, any>();
  const out: ActivityItem[] = [];
  for (const e of [...events].reverse()) {
    const p = e.payload || {};
    const callId = p.toolCallId || `${e.session_id}:${p.agent}:${p.toolName}:${e.seq}`;
    if (e.type === "worker_tool_start") { pending.set(callId, e); continue; }
    if (e.type === "worker_tool_end") {
      const start = pending.get(callId);
      pending.delete(callId);
      out.push({ kind: "tool", id: callId, type: "worker_tool", ts: e.ts, start, end: e });
      continue;
    }
    out.push({ kind: "event", id: e.event_id, type: e.type, ts: e.ts, event: e });
  }
  for (const [id, start] of pending) out.push({ kind: "tool", id, type: "worker_tool", ts: start.ts, start });
  return out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

// Which configured team an agent belongs to, inferred from its name. Hoisted
// here so the Activity filter can reuse a single derivation per agent instead of
// re-running the regexes per item per render.
export function agentTeam(name: string): "planning" | "hive" {
  return /\b(plan|planner|planning|reviewer)\b/i.test(name) && /plan/i.test(name) ? "planning" : "hive";
}

// A cheap, targeted search haystack for an activity item: the real text fields a
// user would search on, lowercased. Cheaper and less noisy than JSON.stringify
// over the whole event/tool payload.
export function itemHaystack(item: ActivityItem): string {
  if (item.kind === "thinking") return `thinking ${item.agent} ${item.text}`.toLowerCase();
  const parts: string[] = [item.type];
  const collect = (e: any) => {
    if (!e) return;
    if (e.type) parts.push(e.type);
    if (e.actor) parts.push(e.actor);
    const p = e.payload || {};
    for (const key of ["agent", "from", "to", "toolName", "task", "message", "text", "type"]) {
      const v = p[key];
      if (typeof v === "string" && v) parts.push(v);
    }
  };
  if (item.kind === "tool") { collect(item.start); collect(item.end); }
  else collect(item.event);
  return parts.join(" ").toLowerCase();
}
