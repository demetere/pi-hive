import { createMemo, For, Show } from "solid-js";
import { now, scopedAgents, scopedEvents } from "../store";
import { fmtCost, relTime } from "../lib/format";
import "./activity.css";

type LiveItem =
  | { kind: "event"; id: string; type: string; ts: string; event: any }
  | { kind: "tool"; id: string; type: "worker_tool"; ts: string; start?: any; end?: any };

function eventAgent(e: any): string {
  const p = e?.payload || {};
  return p.agent || p.to || p.from || e?.actor || "";
}

function itemAgent(item: LiveItem): string {
  return item.kind === "tool" ? eventAgent(item.start || item.end) : eventAgent(item.event);
}

function bundleEvents(events: any[]): LiveItem[] {
  const pending = new Map<string, any>();
  const out: LiveItem[] = [];
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
  const itemCache = new Map<string, LiveItem>();
  const agentColor = createMemo(() => {
    const m = new Map<string, string>();
    for (const a of scopedAgents()) if (a.color) m.set(a.name, a.color);
    return m;
  });
  const items = createMemo(() => {
    const next = bundleEvents(scopedEvents()).slice(0, props.limit ?? 40);
    const live = new Set(next.map((item) => item.id));
    for (const id of Array.from(itemCache.keys())) if (!live.has(id)) itemCache.delete(id);
    return next.map((item) => {
      const cached = itemCache.get(item.id);
      if (cached) { Object.assign(cached, item); return cached; }
      itemCache.set(item.id, item);
      return item;
    });
  });
  return (
    <div class="tl-scroll live-cards">
      <Show when={items().length} fallback={<div class="empty">No activity yet.</div>}>
        <For each={items()}>
          {(item) => {
            const agent = () => itemAgent(item);
            const color = () => agentColor().get(agent()) || "var(--accent)";
            const errored = () => item.kind === "tool" ? item.end?.payload?.isError : item.event.type === "error" || item.event.payload?.isError;
            return (
              <article class={`activity-box compact ${errored() ? "err" : item.kind === "tool" && item.end ? "ok" : ""}`} style={{ "--agent-color": color() } as any}>
                <div class="activity-event-head">
                  <span class="tl-type">{item.type}</span>
                  <b>{title(item)}</b>
                  <span class="tl-time">{relTime(item.ts, now())}</span>
                </div>
                <Show when={agent()}><span class="agent-chip live-agent-chip">{agent()}</span></Show>
                <Show when={body(item)}><div class="tl-text activity-summary">{body(item)}</div></Show>
              </article>
            );
          }}
        </For>
      </Show>
    </div>
  );
}
