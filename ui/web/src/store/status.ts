import type { HiveEvent } from "../types";

export type AgentStatusBySession = Map<string, Map<string, string>>;

// Event-driven agent status overlay. The topology must reflect activity the
// instant an event arrives (same channel as the activity feed) — snapshots
// arrive later (file-poll) and can coalesce, so they alone make the graph lag.
//
// We replay events chronologically and track, per session:
//   • each agent's last status
//   • outstanding delegations per parent (delegation_start without a matching
//     delegation_end from that child yet)
//
// Status meaning:
//   running  — actively executing (issued tool calls, or just delegated-to)
//   waiting  — has ≥1 outstanding delegation to a child; it's blocked waiting
//              on that child rather than doing work itself
//   done/error — finished
//   idle     — never ran / reset by session_start
export function buildEventStatus(events: HiveEvent[]): AgentStatusBySession {
  const bySession = new Map<string, Map<string, string>>();
  // per session: child -> parent (who delegated to it), and parent -> set of
  // outstanding child delegations.
  const parentOf = new Map<string, Map<string, string>>();
  const outstanding = new Map<string, Map<string, Set<string>>>();

  const ses = <T>(map: Map<string, Map<string, T>>, sid: string): Map<string, T> => {
    let values = map.get(sid);
    if (!values) { values = new Map(); map.set(sid, values); }
    return values;
  };
  const setStatus = (sid: string, name: string | undefined, status: string) => {
    if (!name) return; ses(bySession, sid).set(name, status);
  };

  for (const e of events) {
    const sid = e.session_id, p = e.payload || {};
    switch (e.type) {
      case "session_start":
        bySession.set(sid, new Map()); parentOf.set(sid, new Map()); outstanding.set(sid, new Map());
        break;
      case "delegation_start": {
        if (!p.to) break;
        setStatus(sid, p.to, "running");
        if (p.from) {
          ses(parentOf, sid).set(p.to, p.from);
          const out = ses(outstanding, sid);
          const set = out.get(p.from) || new Set<string>(); set.add(p.to); out.set(p.from, set);
          setStatus(sid, p.from, "waiting"); // blocked on the child it just spawned
        }
        break;
      }
      case "worker_tool_start": {
        // An agent that has handed work to a child is WAITING even though pi
        // emits tool calls for it — the delegation itself (delegate_agent /
        // team_conversation) is a tool call, and a parent mid-delegation isn't
        // doing real work. So only flip to running when it has NO outstanding
        // delegations. (Delegation tools never count as "work".)
        const out = ses(outstanding, sid).get(p.agent);
        if (out && out.size) break; // still waiting on a child
        setStatus(sid, p.agent, "running");
        break;
      }
      case "delegation_end": {
        const child = p.from;
        if (!child) break;
        setStatus(sid, child, p.type === "error" ? "error" : "done");
        // clear this child from its parent's outstanding set; if the parent has
        // none left, it resumes running.
        const parent = ses(parentOf, sid).get(child);
        if (parent) {
          const out = ses(outstanding, sid);
          const set = out.get(parent); if (set) { set.delete(child); if (!set.size) { out.delete(parent); setStatus(sid, parent, "running"); } }
          ses(parentOf, sid).delete(child);
        }
        break;
      }
    }
  }
  return bySession;
}
