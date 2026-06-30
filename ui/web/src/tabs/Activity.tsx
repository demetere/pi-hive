import { createMemo, createSignal, For, Show } from "solid-js";
import { scopedEvents, now } from "../store";
import { relTime } from "../lib/format";
import "./tabs.css";
import "../components/activity.css";

const PAGE = 60;

export default function Activity(props: { search: string }) {
  const [type, setType] = createSignal("");
  const [page, setPage] = createSignal(0);

  const types = createMemo(() => Array.from(new Set(scopedEvents().map((e) => e.type))).sort());

  const filtered = createMemo(() => {
    const q = props.search.toLowerCase();
    return scopedEvents().filter((e) =>
      (!type() || e.type === type()) &&
      (!q || JSON.stringify(e).toLowerCase().includes(q)));
  });

  const total = () => filtered().length;
  const pages = () => Math.max(1, Math.ceil(total() / PAGE));
  const clampedPage = () => Math.min(page(), pages() - 1);
  const slice = () => filtered().slice(clampedPage() * PAGE, clampedPage() * PAGE + PAGE);

  function summarize(e: any): string {
    const p = e.payload || {};
    switch (e.type) {
      case "session_start": return `session ${e.session_id}\n${e.cwd || p.cwd || ""}`;
      case "delegation_start": return `${p.from} → ${p.to}\n${p.task || ""}`;
      case "delegation_end": return `${p.from} ${p.type} · ${Math.round((p.elapsedMs || 0) / 1000)}s · $${Number(p.costUsd || 0).toFixed(3)}\n${p.message || ""}`;
      case "worker_tool_start": case "worker_tool_end": return `${p.agent || ""} · ${p.toolName || ""}${p.isError ? " · error" : ""}`;
      case "user_message": case "assistant_message": return p.text || "";
      default: return JSON.stringify(p, null, 2);
    }
  }

  return (
    <>
      <div class="toolbar">
        <select value={type()} onChange={(e) => { setType(e.currentTarget.value); setPage(0); }}>
          <option value="">all types</option>
          <For each={types()}>{(t) => <option value={t}>{t}</option>}</For>
        </select>
        <div class="spacer" />
        <span class="muted-cell">{total() ? `${clampedPage() * PAGE + 1}-${Math.min(total(), (clampedPage() + 1) * PAGE)} of ${total()}` : "no events"}</span>
        <div class="pager">
          <button class="btn pill" disabled={clampedPage() <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Newer</button>
          <button class="btn pill" disabled={clampedPage() >= pages() - 1} onClick={() => setPage((p) => p + 1)}>Older</button>
        </div>
      </div>
      <div class="tab-card" style={{ padding: "8px 14px" }}>
        <Show when={slice().length} fallback={<div class="empty">No events match.</div>}>
          <For each={slice()}>
            {(e) => (
              <div class="tl" style={{ "border-bottom": "1px solid var(--border)", padding: "11px 2px" }}>
                <span class={`tl-dot ${e.payload?.isError || e.type === "error" ? "" : ""}`} />
                <div class="tl-body">
                  <div class="tl-top"><span class="tl-type">{e.type}</span><span class="muted-cell" style={{ "margin-left": "8px" }}>{e.actor || ""}</span><span class="tl-time">{relTime(e.ts, now())}</span></div>
                  <pre style={{ margin: "5px 0 0", "white-space": "pre-wrap", "word-break": "break-word", color: "var(--fg2)", "font-size": "12px", "max-height": "180px", overflow: "auto", "font-family": "var(--font)" }}>{summarize(e)}</pre>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
    </>
  );
}
