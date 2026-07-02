import { useMemo } from "react";
import { useHive } from "../store";
import RelTime from "../hooks/RelTime";
import { fmtCost } from "../lib/format";
import { bundleEvents, itemAgent, type ActivityItem as LiveItem } from "../lib/activity";

function title(item: LiveItem): string {
  if (item.kind === "tool") {
    const p = (item.end || item.start)?.payload || {};
    const state = item.end ? (p.isError ? "failed" : "finished") : "started";
    return `${p.agent || "agent"} ${state} ${p.toolName || "tool"}`;
  }
  const e = item.event;
  const p = e.payload || {};
  switch (e.type) {
    case "delegation_start": return `${p.from || "agent"} → ${p.to || "agent"}`;
    case "delegation_end": return `${p.from || "agent"} ${p.type || "done"}`;
    case "assistant_message": return e.actor || "assistant";
    case "user_message": return "user";
    case "error": return e.actor || "error";
    default: return e.actor || e.type;
  }
}

function body(item: LiveItem): string {
  if (item.kind === "tool") {
    const p = (item.end || item.start)?.payload || {};
    const ms = item.start && item.end ? new Date(item.end.ts).getTime() - new Date(item.start.ts).getTime() : undefined;
    return [p.toolName, ms != null ? (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`) : "running"].filter(Boolean).join(" · ");
  }
  const e = item.event;
  const p = e.payload || {};
  switch (e.type) {
    case "delegation_start": return p.task || "";
    case "delegation_end": return `${p.message || ""} · ${Math.round((p.elapsedMs || 0) / 1000)}s · ${fmtCost(p.costUsd || 0)}`;
    case "assistant_message": case "user_message": return p.text || "";
    case "error": return p.message || JSON.stringify(p);
    default: return typeof p.text === "string" ? p.text : "";
  }
}

export default function LiveActivity(props: { limit?: number }) {
  const scopedEvents = useHive((s) => s.scopedEvents);
  const scopedAgents = useHive((s) => s.scopedAgents);

  const agentColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of scopedAgents) if (a.color) m.set(a.name, a.color);
    return m;
  }, [scopedAgents]);

  const items = useMemo(() => bundleEvents(scopedEvents).slice(0, props.limit ?? 40), [scopedEvents, props.limit]);

  if (!items.length) return <div className="tl-scroll live-cards"><div className="empty">No activity yet.</div></div>;

  return (
    <div className="tl-scroll live-cards">
      {items.map((item) => {
        const agent = itemAgent(item);
        const color = agentColor.get(agent) || "var(--accent)";
        const errored = item.kind === "tool" ? item.end?.payload?.isError : item.event.type === "error" || item.event.payload?.isError;
        const b = body(item);
        return (
          <article
            key={item.id}
            className={`activity-box compact ${errored ? "err" : item.kind === "tool" && item.end ? "ok" : ""}`}
            style={{ "--agent-color": color } as React.CSSProperties}
          >
            <div className="activity-event-head">
              <span className="tl-type">{item.type}</span>
              <b>{title(item)}</b>
              <span className="tl-time"><RelTime ts={item.ts} /></span>
            </div>
            {agent && <span className="agent-chip live-agent-chip">{agent}</span>}
            {b && <div className="tl-text activity-summary">{b}</div>}
          </article>
        );
      })}
    </div>
  );
}
