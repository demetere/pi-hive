import { For, Show } from "solid-js";
import { scopedEvents, now } from "../store";
import { fmtCost, relTime } from "../lib/format";
import type { HiveEvent } from "../types";
import "./activity.css";

function describe(e: HiveEvent): { title: string; body: string; color: string } {
  const p = e.payload || {};
  switch (e.type) {
    case "delegation_start": return { title: `${p.from} → ${p.to}`, body: p.task || "", color: "accent" };
    case "delegation_end": return { title: `${p.from} ${p.type || ""}`.trim(), body: `${p.message || ""} · ${Math.round((p.elapsedMs || 0) / 1000)}s · ${fmtCost(p.costUsd || 0)}`, color: p.type === "error" ? "err" : "ok" };
    case "worker_tool_start": return { title: p.agent || "", body: "▶ " + (p.toolName || ""), color: "accent" };
    case "worker_tool_end": return { title: p.agent || "", body: (p.isError ? "✗ " : "✓ ") + (p.toolName || ""), color: p.isError ? "err" : "ok" };
    case "assistant_message": return { title: e.actor || "assistant", body: p.text || "", color: "muted" };
    case "user_message": return { title: "user", body: p.text || "", color: "muted" };
    case "error": return { title: e.actor || "error", body: p.message || JSON.stringify(p), color: "err" };
    default: return { title: e.actor || e.type, body: typeof p.text === "string" ? p.text : "", color: "muted" };
  }
}

export default function LiveActivity(props: { limit?: number }) {
  const items = () => scopedEvents().slice(0, props.limit ?? 40);
  return (
    <div class="tl-scroll">
      <Show when={items().length} fallback={<div class="empty">No activity yet.</div>}>
        <For each={items()}>
          {(e) => {
            const d = describe(e);
            return (
              <div class={`tl ${d.color}`}>
                <span class="tl-dot" />
                <div class="tl-body">
                  <div class="tl-top"><span class="tl-type">{e.type}</span><span class="tl-time">{relTime(e.ts, now())}</span></div>
                  <div class="tl-title">{d.title}</div>
                  <Show when={d.body}><div class="tl-text">{d.body}</div></Show>
                </div>
              </div>
            );
          }}
        </For>
      </Show>
    </div>
  );
}
