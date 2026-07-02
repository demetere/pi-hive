import { useMemo } from "react";
import { useHive } from "../store";
import { fmtCost, fmtNum } from "../lib/format";
import { hhmmss, statusColorVar, statusKey } from "../lib/agents";
import { bundleEvents, itemAgent, mergeThinking, type ActivityItem as LiveItem } from "../lib/activity";
import type { ScopeAgent } from "../store";

type Kind = "DELEGATE" | "TOOL" | "MSG" | "DONE" | "ERROR" | "THINK";

const KIND_COLOR: Record<Kind, string> = {
  DELEGATE: "var(--run)",
  TOOL: "var(--ink-dim)",
  MSG: "var(--ink-dim)",
  DONE: "var(--done)",
  ERROR: "var(--crit)",
  THINK: "var(--brand)",
};

// Map a bundled activity item onto the spec's five-kind vocabulary.
function kindOf(item: LiveItem): Kind {
  if (item.kind === "thinking") return "THINK";
  if (item.kind === "tool") {
    return item.end?.payload?.isError ? "ERROR" : "TOOL";
  }
  const e = item.event;
  const p = e.payload || {};
  switch (e.type) {
    case "delegation_start": return "DELEGATE";
    case "delegation_end": return p.type === "error" || p.isError ? "ERROR" : "DONE";
    case "error": return "ERROR";
    case "assistant_message":
    case "user_message": return "MSG";
    default: return p.isError ? "ERROR" : "MSG";
  }
}

// Line-2 message text.
function messageOf(item: LiveItem): string {
  if (item.kind === "thinking") return item.text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  if (item.kind === "tool") {
    const p = (item.end || item.start)?.payload || {};
    const args = typeof p.args === "string" ? p.args : "";
    return [p.toolName, args].filter(Boolean).join(" ") || p.toolName || "tool call";
  }
  const e = item.event;
  const p = e.payload || {};
  switch (e.type) {
    case "delegation_start": return p.task || `spawned ${p.to || "worker"}`;
    case "delegation_end": return p.message || "task complete";
    case "assistant_message":
    case "user_message": return p.text || "";
    case "error": return p.message || "error";
    default: return typeof p.text === "string" ? p.text : e.type;
  }
}

// Right-aligned line-2 metadata: delegation target, token delta, duration, retry.
function metaOf(item: LiveItem): string {
  if (item.kind === "thinking") return item.tokens ? `+${fmtNum(item.tokens)} tok` : "";
  if (item.kind === "tool") {
    if (item.start && item.end) {
      const ms = new Date(item.end.ts).getTime() - new Date(item.start.ts).getTime();
      return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
    }
    return "running";
  }
  const e = item.event;
  const p = e.payload || {};
  switch (e.type) {
    case "delegation_start": return p.to ? `→ ${p.to}` : "";
    case "delegation_end": {
      const rt = p.runtime || {};
      const tok = Number(rt.inputTokens || 0) + Number(rt.outputTokens || 0);
      if (tok) return `+${fmtNum(tok)} tok`;
      if (p.costUsd) return fmtCost(p.costUsd);
      return p.elapsedMs ? `${Math.round(p.elapsedMs / 1000)}s` : "";
    }
    case "error": return p.retry ? `retry ${p.retry}` : "";
    default: return "";
  }
}

export default function LiveActivity(props: { limit?: number }) {
  const scopedEvents = useHive((s) => s.scopedEvents);
  const scopedAgents = useHive((s) => s.scopedAgents);
  const scopedSessions = useHive((s) => s.scopedSessions);
  const thinkingBySession = useHive((s) => s.thinkingBySession);

  // Single roster: id → model/status, shared with the topology graph.
  const roster = useMemo(() => {
    const m = new Map<string, ScopeAgent>();
    for (const a of scopedAgents) if (!m.has(a.name)) m.set(a.name, a);
    return m;
  }, [scopedAgents]);

  // Thinking entries for the sessions in scope, merged into the feed by time.
  const thinking = useMemo(() => {
    const out: Array<{ agent: string; ts: string; text: string }> = [];
    for (const s of scopedSessions) for (const t of thinkingBySession.get(s.session_id) || []) out.push(t);
    return out;
  }, [scopedSessions, thinkingBySession]);

  const items = useMemo(
    () => mergeThinking(bundleEvents(scopedEvents), thinking).slice(0, props.limit ?? 40),
    [scopedEvents, thinking, props.limit],
  );

  if (!items.length) return <div className="tl-scroll"><div className="empty">No activity yet.</div></div>;

  return (
    <div className="tl-scroll">
      {items.map((item) => {
        const agentId = itemAgent(item) || "—";
        const agent = roster.get(agentId);
        const kind = kindOf(item);
        const kc = KIND_COLOR[kind];
        const sk = statusKey(agent?.status);
        const dotColor = statusColorVar(agent?.status);
        const msg = messageOf(item);
        const meta = metaOf(item);
        // Identity color drives the row's left border (real agents only; else neutral).
        const agentColor = agent?.color || "var(--ink-dimmer)";
        return (
          <div key={item.id} className="feed-row animate-feedin" style={{ "--agent-color": agentColor } as React.CSSProperties}>
            <div className="flex items-center gap-[7px]">
              <span className="font-mono text-[10px] text-ink-dimmer flex-none">{hhmmss(new Date(item.ts).getTime())}</span>
              {/* one dot: live agent status. Identity color is carried by the row's left border. */}
              <span className="relative w-[6px] h-[6px] flex-none" title={sk}>
                {sk === "running" && <span className="absolute -inset-[3px] rounded-full animate-halo" style={{ background: "color-mix(in srgb, var(--run) 45%, transparent)" }} />}
                <span className="absolute inset-0 rounded-full" style={{ background: dotColor }} />
              </span>
              <span className="text-[11px] font-bold text-ink flex-none">{agentId}</span>
              <span className="flex-1" />
              <span className="feed-pill flex-none" style={{ color: kc, background: `color-mix(in srgb, ${kc} 15%, transparent)` }}>{kind}</span>
            </div>
            <div className="flex gap-2 mt-1 pl-[23px]">
              <span className="text-[11.5px] text-ink leading-[1.4] flex-1 min-w-0 line-clamp-2">{msg}</span>
              {meta && <span className="font-mono text-[10px] text-ink-dim flex-none whitespace-nowrap">{meta}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
