import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { openAgent, closeAgent } from "../store";
import { shortModel } from "../lib/format";
import "./agentlog.css";

interface Part { type: "text" | "thinking" | "toolCall" | "toolResult"; text?: string; name?: string; args?: any; result?: string | null; resultError?: boolean; }
interface Entry { kind: "message" | "meta"; role?: string; parts?: Part[]; text?: string; ts?: string; }
interface Invoc { task: string; entries: Entry[] }

// Split a transcript into invocations. Each user-role message is the task handed
// to the agent for one invocation (the orchestrator re-calling it with -continue
// appends a new user turn to the SAME log). Leading meta lines (model/thinking)
// that appear before the first user message are folded INTO the first
// invocation rather than forming an empty "(no task text)" group.
function splitInvocations(entries: Entry[]): Invoc[] {
  const invs: Invoc[] = [];
  let cur: Invoc | null = null;
  let pending: Entry[] = []; // leading entries before the first user message
  const firstTextOf = (e: Entry) => e.parts?.find((p) => p.type === "text")?.text || "";
  for (const e of entries) {
    if (e.kind === "message" && e.role === "user") {
      cur = { task: firstTextOf(e), entries: [...pending, e] };
      pending = [];
      invs.push(cur);
    } else if (!cur) {
      pending.push(e); // hold until the first user message
    } else {
      cur.entries.push(e);
    }
  }
  // No user message at all (rare) — show the leading entries as one block.
  if (!invs.length && pending.length) invs.push({ task: "", entries: pending });
  return invs;
}

// Broadcast expand/collapse to every tool card. A bump on this signal forces
// all cards to (un)collapse their result regardless of individual state.
const [bulkResult, setBulkResult] = createSignal<{ open: boolean; n: number }>({ open: false, n: 0 });

interface RunRef { id: string; label: string; }

export default function AgentLog() {
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [status, setStatus] = createSignal<string>("");
  const [loading, setLoading] = createSignal(true);
  const [exists, setExists] = createSignal(true);
  const [runs, setRuns] = createSignal<RunRef[]>([]);
  const [selectedRun, setSelectedRun] = createSignal<string>("current");
  const invocations = createMemo(() => splitInvocations(entries()));
  let offset = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let scroller: HTMLDivElement | undefined;

  async function poll(initial: boolean) {
    const a = openAgent();
    if (!a) return;
    try {
      const run = selectedRun();
      const url = `/agent-log?session=${encodeURIComponent(a.sessionId)}&agent=${encodeURIComponent(a.name)}&offset=${offset}&run=${encodeURIComponent(run)}`;
      const res = await fetch(url);
      const data = await res.json();
      setStatus(data.status || "");
      setExists(!!data.exists);
      if (Array.isArray(data.runs)) setRuns(data.runs);
      if (data.offset != null) offset = data.offset;
      if (data.entries?.length) {
        const atBottom = scroller ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 60 : true;
        setEntries((prev) => initial ? data.entries : [...prev, ...data.entries]);
        if (atBottom) queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
      }
      // only tail the live "current" run
      const shouldTail = data.running && selectedRun() === "current";
      if (shouldTail && !timer) timer = setInterval(() => poll(false), 1500);
      if (!shouldTail && timer) { clearInterval(timer); timer = undefined; }
    } catch { /* transient */ }
    setLoading(false);
  }

  function loadRun(runId: string) {
    if (timer) { clearInterval(timer); timer = undefined; }
    setSelectedRun(runId);
    offset = 0; setEntries([]); setLoading(true);
    poll(true);
  }

  // (re)load when the target agent changes
  createEffect(on(openAgent, (a) => {
    if (timer) { clearInterval(timer); timer = undefined; }
    offset = 0; setEntries([]); setLoading(true); setExists(true); setRuns([]); setSelectedRun("current");
    if (a) poll(true);
  }));
  onCleanup(() => { if (timer) clearInterval(timer); });

  function onKey(e: KeyboardEvent) { if (e.key === "Escape") closeAgent(); }
  createEffect(() => { if (openAgent()) document.addEventListener("keydown", onKey); else document.removeEventListener("keydown", onKey); });
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <Show when={openAgent()}>
      {(a) => (
        <Portal>
          <div class="modal-backdrop" onClick={closeAgent}>
            <div class="modal-panel log-panel" onClick={(e) => e.stopPropagation()}>
              <div class="w-head log-head">
                <span class="log-dot" style={{ background: a().color || "var(--accent)" }} />
                <span class="w-title">{a().name}</span>
                <span class={`status-tag ${status() || a().status || "idle"}`}>{status() || a().status || "idle"}</span>
                <Show when={a().model}><span class="log-model">{shortModel(a().model)}</span></Show>
                <Show when={status() === "running"}><span class="log-live"><span class="live-pip" /> live</span></Show>
                <span class="w-tools">
                  <button class="log-bulk" onClick={() => setBulkResult((b) => ({ open: true, n: b.n + 1 }))} title="Expand all results">Expand all</button>
                  <button class="log-bulk" onClick={() => setBulkResult((b) => ({ open: false, n: b.n + 1 }))} title="Collapse all results">Collapse all</button>
                  <button onClick={closeAgent} title="Close">✕</button>
                </span>
              </div>
              <Show when={runs().length > 1}>
                <div class="log-runs">
                  <span class="log-runs-label">Runs:</span>
                  <For each={runs()}>
                    {(r) => (
                      <button class={`log-run-tab ${selectedRun() === r.id ? "active" : ""}`} onClick={() => loadRun(r.id)}>{r.label}</button>
                    )}
                  </For>
                </div>
              </Show>
              <div class="log-body" ref={scroller}>
                <Show when={!loading()} fallback={<div class="empty">Loading transcript…</div>}>
                  <Show when={exists()} fallback={<div class="empty">No transcript for this agent yet{status() === "idle" ? " — it hasn't run." : "."}</div>}>
                    <For each={invocations()}>
                      {(inv, i) => <Invocation inv={inv} index={i()} total={invocations().length} />}
                    </For>
                    <Show when={!entries().length}><div class="empty">Transcript is empty.</div></Show>
                  </Show>
                </Show>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  );
}

// One collapsible invocation block. The latest invocation (and a single-
// invocation log) is expanded by default; earlier ones collapse so the
// orchestrator↔agent back-and-forth is navigable.
function Invocation(props: { inv: Invoc; index: number; total: number }) {
  const isLatest = () => props.index === props.total - 1;
  const [open, setOpen] = createSignal(props.total === 1 || isLatest());
  const taskPreview = () => props.inv.task ? props.inv.task.replace(/\s+/g, " ").slice(0, 90) : "(no task text)";
  return (
    <div class={`log-inv ${open() ? "open" : ""}`}>
      <div class="log-inv-head" onClick={() => setOpen(!open())}>
        <span class="log-inv-caret">{open() ? "▾" : "▸"}</span>
        <span class="log-inv-num">{props.index === 0 ? "Invocation 1" : `↻ Invocation ${props.index + 1}`}</span>
        <span class="log-inv-task">{taskPreview()}</span>
        <span class="log-inv-count">{props.inv.entries.length} msg{props.inv.entries.length === 1 ? "" : "s"}</span>
      </div>
      <Show when={open()}>
        <div class="log-inv-body">
          <For each={props.inv.entries}>{(e) => <LogEntry entry={e} />}</For>
        </div>
      </Show>
    </div>
  );
}

function LogEntry(props: { entry: Entry }) {
  const e = props.entry;
  if (e.kind === "meta") return <div class="log-meta">{e.text}</div>;
  return (
    <div class={`log-msg ${e.role}`}>
      <div class="log-role">{e.role}</div>
      <div class="log-parts">
        <For each={e.parts}>{(p) => <LogPart part={p} />}</For>
      </div>
    </div>
  );
}

function LogPart(props: { part: Part }) {
  const p = props.part;
  if (p.type === "text") return <div class="log-text">{p.text}</div>;
  if (p.type === "thinking") return <div class="log-thinking">💭 {p.text}</div>;
  if (p.type === "toolResult") {
    // Unpaired result (rare, e.g. live-tail across chunks) — render standalone.
    return <ToolCard name={p.name || "result"} result={p.result ?? p.text ?? ""} resultError={p.resultError} />;
  }
  // toolCall — one merged card: request (args) shown, result collapsed.
  return <ToolCard name={p.name || "tool"} args={p.args} result={p.result ?? undefined} resultError={p.resultError} />;
}

// One card for a tool invocation: the call (name + args) is always shown; the
// result is collapsed by default and toggled per-card or via Expand/Collapse all.
function ToolCard(props: { name: string; args?: any; result?: string; resultError?: boolean }) {
  const [open, setOpen] = createSignal(false);
  // react to the global Expand all / Collapse all bump
  createEffect(on(bulkResult, (b, prev) => { if (prev && b.n !== prev.n) setOpen(b.open); }));
  const hasResult = () => props.result !== undefined && props.result !== null && props.result !== "";
  return (
    <div class={`log-tool ${props.resultError ? "err" : ""}`}>
      <div class="log-tool-head" onClick={() => hasResult() && setOpen(!open())}>
        <span class="tool-ic">{props.resultError ? "✗" : "⚙"}</span>
        <b>{props.name}</b>
        <Show when={hasResult()}><span class="tool-toggle">{open() ? "hide result −" : "show result +"}</span></Show>
        <Show when={!hasResult()}><span class="tool-toggle dim">no result</span></Show>
      </div>
      <Show when={props.args && Object.keys(props.args).length}>
        <pre class="log-tool-args">{JSON.stringify(props.args, null, 2)}</pre>
      </Show>
      <Show when={open() && hasResult()}>
        <pre class="log-tool-body">{props.result}</pre>
      </Show>
    </div>
  );
}
