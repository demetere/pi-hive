import { createMemo, createSignal, For, Show } from "solid-js";
import { scopedAgents, scopedEvents, scopedSessions, now, viewAgent } from "../store";
import { fmtCost, fmtNum, relTime, sessionSlug, shortModel } from "../lib/format";
import "./tabs.css";
import "../components/activity.css";

const PAGE = 60;

type ActivityItem =
  | { kind: "event"; id: string; type: string; ts: string; event: any }
  | { kind: "tool"; id: string; type: "worker_tool"; ts: string; start?: any; end?: any };

function eventAgent(e: any): string {
  const p = e?.payload || {};
  return p.agent || p.to || p.from || e?.actor || "";
}

function itemAgent(item: ActivityItem): string {
  return item.kind === "tool" ? eventAgent(item.start || item.end) : eventAgent(item.event);
}

function itemParticipants(item: ActivityItem): Set<string> {
  const out = new Set<string>();
  const add = (e: any) => {
    const p = e?.payload || {};
    for (const v of [e?.actor, p.agent, p.from, p.to]) if (v) out.add(v);
  };
  if (item.kind === "tool") { add(item.start); add(item.end); }
  else add(item.event);
  return out;
}

function agentTeam(name: string): "planning" | "hive" {
  return /\b(plan|planner|planning|reviewer)\b/i.test(name) && /plan/i.test(name) ? "planning" : "hive";
}

function payloadMeta(e: any): Array<[string, string]> {
  const skip = new Set(["agent", "toolName", "toolCallId", "isError"]);
  return Object.entries(e?.payload || {})
    .filter(([k, v]) => !skip.has(k) && v != null && v !== "")
    .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
}

function fmtTime(ts?: string): string { return ts ? new Date(ts).toLocaleString() : "—"; }
function toolDuration(item: Extract<ActivityItem, { kind: "tool" }>): string {
  if (!item.start || !item.end) return "running";
  const ms = new Date(item.end.ts).getTime() - new Date(item.start.ts).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function itemTitle(item: ActivityItem): string {
  if (item.kind === "tool") {
    const p = (item.end || item.start)?.payload || {};
    const state = item.end ? (p.isError ? "failed" : "finished") : "started";
    return `${p.agent || "agent"} ${state} ${p.toolName || "tool"}`;
  }
  const e = item.event;
  const p = e.payload || {};
  switch (e.type) {
    case "session_start": return "Session started";
    case "delegation_start": return `${p.from || "agent"} delegated to ${p.to || "agent"}`;
    case "delegation_end": return `${p.from || "agent"} finished ${p.type || "work"}`;
    case "user_message": return "User message";
    case "assistant_message": return `${e.actor || "assistant"} message`;
    case "error": return p.message || "Error";
    default: return e.type;
  }
}

function itemSummary(item: ActivityItem): string {
  if (item.kind === "tool") {
    const s = item.start?.payload || {};
    const e = item.end?.payload || {};
    const ms = item.start && item.end ? new Date(item.end.ts).getTime() - new Date(item.start.ts).getTime() : undefined;
    const bits = [s.toolName || e.toolName, ms != null ? `${ms}ms` : "running"];
    if (e.isError) bits.push("error");
    return bits.filter(Boolean).join(" · ");
  }
  const e = item.event;
  const p = e.payload || {};
  switch (e.type) {
    case "session_start": return e.cwd || p.cwd || e.session_id;
    case "delegation_start": return p.task || "";
    case "delegation_end": return `${p.message || ""}${p.elapsedMs ? ` · ${Math.round((p.elapsedMs || 0) / 1000)}s` : ""}${p.costUsd != null ? ` · ${fmtCost(p.costUsd)}` : ""}`;
    case "user_message": case "assistant_message": return p.text || "";
    default: return typeof p.text === "string" ? p.text : "";
  }
}

function bundleEvents(events: any[]): ActivityItem[] {
  const pending = new Map<string, any>();
  const out: ActivityItem[] = [];
  for (const e of [...events].reverse()) {
    const p = e.payload || {};
    const callId = p.toolCallId || `${e.session_id}:${p.agent}:${p.toolName}:${e.seq}`;
    if (e.type === "worker_tool_start") {
      pending.set(callId, e);
      continue;
    }
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

export default function Activity(props: { search: string }) {
  const [type, setType] = createSignal("");
  const [agent, setAgent] = createSignal("");
  const [team, setTeam] = createSignal<"all" | "planning" | "hive">("all");
  const [page, setPage] = createSignal(0);
  const [open, setOpen] = createSignal<Set<string>>(new Set());
  const itemCache = new Map<string, ActivityItem>();

  const items = createMemo(() => {
    const next = bundleEvents(scopedEvents());
    const live = new Set(next.map((item) => item.id));
    for (const id of Array.from(itemCache.keys())) if (!live.has(id)) itemCache.delete(id);
    return next.map((item) => {
      const cached = itemCache.get(item.id);
      if (cached) { Object.assign(cached, item); return cached; }
      itemCache.set(item.id, item);
      return item;
    });
  });
  const types = createMemo(() => Array.from(new Set(items().map((e) => e.type))).sort());
  const agents = createMemo(() => {
    const statusRank: Record<string, number> = { running: 0, waiting: 1, error: 2, idle: 3, done: 4 };
    const roleRank: Record<string, number> = { orchestrator: 0, lead: 1, member: 2 };
    const sessionSeconds = new Map(scopedSessions().map((s) => {
      const first = new Date(s.first_ts).getTime();
      const last = new Date(s.last_ts).getTime();
      return [s.session_id, Math.max(1, Number.isFinite(last - first) ? (last - first) / 1000 : 0)] as const;
    }));
    const byName = new Map<string, any>();
    for (const a of scopedAgents()) {
      const prev = byName.get(a.name);
      const seconds = sessionSeconds.get(a.session_id) || 0;
      if (!prev) { byName.set(a.name, { ...a, team: agentTeam(a.name), wallSeconds: seconds, tokSec: seconds ? a.tokens / seconds : 0, sessions: new Set([a.session_id]) }); continue; }
      const firstInSession = !prev.sessions.has(a.session_id);
      prev.tokens += a.tokens;
      prev.cost += a.cost;
      prev.runs += a.runs;
      prev.tools += a.tools;
      if (firstInSession) prev.wallSeconds += seconds;
      prev.tokSec = prev.wallSeconds ? prev.tokens / prev.wallSeconds : 0;
      prev.sessions.add(a.session_id);
      if ((statusRank[a.status] ?? 9) < (statusRank[prev.status] ?? 9)) prev.status = a.status;
      if ((roleRank[a.role || "member"] ?? 9) < (roleRank[prev.role || "member"] ?? 9)) prev.role = a.role;
      if (!prev.color && a.color) prev.color = a.color;
      if (!prev.model && a.model) prev.model = a.model;
    }
    return Array.from(byName.values()).sort((a, b) => (roleRank[a.role || "member"] ?? 9) - (roleRank[b.role || "member"] ?? 9) || a.name.localeCompare(b.name));
  });
  const visibleAgents = createMemo(() => team() === "all" ? agents() : agents().filter((a) => a.team === team()));
  const agentColor = createMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents()) if (a.color) m.set(a.name, a.color);
    return m;
  });

  const filtered = createMemo(() => {
    const q = props.search.toLowerCase();
    const selectedAgent = agent();
    const selectedMeta = agents().find((a) => a.name === selectedAgent);
    return items().filter((item) => {
      const haystack = JSON.stringify(item).toLowerCase();
      const a = itemAgent(item);
      const selectedTeam = team();
      const participants = itemParticipants(item);
      const sessionLevel = item.kind === "event" && ["session_start", "user_message", "assistant_message"].includes(item.event.type);
      const matchesAgent = !selectedAgent || participants.has(selectedAgent) ||
        // Older planning telemetry used the legacy root actor name "Orchestrator"
        // even when the configured root is "Planning Lead". Treat that as the
        // planning lead's activity so its filter is not empty.
        (selectedMeta?.team === "planning" && selectedMeta?.role === "orchestrator" && participants.has("Orchestrator")) ||
        (selectedMeta?.role === "orchestrator" && sessionLevel);
      return (!type() || item.type === type()) &&
        matchesAgent &&
        (selectedTeam === "all" || (a ? agentTeam(a) === selectedTeam : false) || (selectedTeam === "planning" && participants.has("Orchestrator"))) &&
        (!q || haystack.includes(q));
    });
  });

  const total = () => filtered().length;
  const pages = () => Math.max(1, Math.ceil(total() / PAGE));
  const clampedPage = () => Math.min(page(), pages() - 1);
  const slice = () => filtered().slice(clampedPage() * PAGE, clampedPage() * PAGE + PAGE);

  function toggle(id: string) {
    setOpen((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  return (
    <div class="activity-layout">
      <aside class="activity-agents tab-card">
        <div class="activity-panel-head">
          <b>Agents in scope</b>
          <span>{agents().length}</span>
        </div>
        <div class="team-filters" role="tablist" aria-label="Agent team filter">
          <button class={`team-filter ${team() === "all" ? "active" : ""}`} onClick={() => { setTeam("all"); setAgent(""); setPage(0); }}>All</button>
          <button class={`team-filter ${team() === "hive" ? "active" : ""}`} onClick={() => { setTeam("hive"); setAgent(""); setPage(0); }}>Hive</button>
          <button class={`team-filter ${team() === "planning" ? "active" : ""}`} onClick={() => { setTeam("planning"); setAgent(""); setPage(0); }}>Planning</button>
        </div>
        <div class="activity-agent-list">
          <button class={`agent-filter ${agent() === "" ? "active" : ""}`} onClick={() => { setAgent(""); setPage(0); }}>All activity</button>
          <For each={visibleAgents()}>
            {(a) => (
              <button class={`agent-filter ${agent() === a.name ? "active" : ""}`} onClick={() => { setAgent(a.name); setPage(0); }} onDblClick={() => viewAgent({ sessionId: a.session_id, name: a.name, color: a.color, status: a.status, model: a.model })}>
                <span class="cdot" style={{ background: a.color || "var(--muted)" }} />
                <span class="agent-filter-main">
                  <b>{a.name}</b>
                  <small>{a.role || "member"} · {a.status} · {a.sessions.size} session{a.sessions.size === 1 ? "" : "s"} · {shortModel(a.model)}</small>
                </span>
                <span class="agent-filter-stat"><b>{fmtNum(a.tokens)}</b><small>{a.tokSec ? `${a.tokSec.toFixed(1)} tok/s` : "— tok/s"}</small></span>
              </button>
            )}
          </For>
          <Show when={!agents().length}><div class="empty">No agents yet.</div></Show>
        </div>
      </aside>

      <section class="activity-feed">
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
        <div class="activity-card-grid">
          <Show when={slice().length} fallback={<div class="tab-card"><div class="empty">No events match.</div></div>}>
            <For each={slice()}>
              {(item) => {
                const expanded = () => open().has(item.id);
                const a = () => itemAgent(item);
                const color = () => agentColor().get(a()) || "var(--accent)";
                const raw = () => item.kind === "tool" ? (item.end || item.start) : item.event;
                const errored = () => item.kind === "tool" ? item.end?.payload?.isError : raw()?.payload?.isError || raw()?.type === "error";
                return (
                  <article class={`activity-box ${errored() ? "err" : item.kind === "tool" && item.end ? "ok" : ""}`} style={{ "--agent-color": color() } as any}>
                    <button class="activity-event-head" onClick={() => toggle(item.id)}>
                      <span class="tl-type">{item.type}</span>
                      <b>{itemTitle(item)}</b>
                      <Show when={a()}><span class="agent-chip">{a()}</span></Show>
                      <span class="tl-time">{relTime(item.ts, now())}</span>
                      <span class="expand-mark">{expanded() ? "−" : "+"}</span>
                    </button>
                    <Show when={itemSummary(item)}><div class="tl-text activity-summary">{itemSummary(item)}</div></Show>
                    <Show when={expanded()}>
                      <div class="activity-detail">
                        {item.kind === "tool" ? (
                          <>
                            <div class="detail-grid tool-detail-grid">
                              <span>Session</span><b>{sessionSlug(raw()?.session_id)}</b>
                              <span>Agent</span><b>{itemAgent(item) || "—"}</b>
                              <span>Tool</span><b>{(item.end || item.start)?.payload?.toolName || "—"}</b>
                              <span>Status</span><b>{item.end ? (item.end.payload?.isError ? "error" : "finished") : "running"}</b>
                              <span>Duration</span><b>{toolDuration(item)}</b>
                              <span>Call id</span><b>{(item.end || item.start)?.payload?.toolCallId || "—"}</b>
                            </div>
                            <div class="tool-phases">
                              <section class="tool-phase start">
                                <h4>Started</h4>
                                <div class="detail-grid">
                                  <span>Time</span><b>{fmtTime(item.start?.ts)}</b>
                                  <span>Actor</span><b>{item.start?.actor || "—"}</b>
                                </div>
                                <Show when={payloadMeta(item.start).length}>
                                  <div class="meta-list"><For each={payloadMeta(item.start)}>{([k, v]) => <p><span>{k}</span><b>{v}</b></p>}</For></div>
                                </Show>
                                <Show when={item.start?.payload}>
                                  <pre class="phase-payload">{JSON.stringify(item.start.payload, null, 2)}</pre>
                                </Show>
                              </section>
                              <section class={`tool-phase ${item.end?.payload?.isError ? "err" : "end"}`}>
                                <h4>{item.end ? "Finished" : "Waiting for finish"}</h4>
                                <div class="detail-grid">
                                  <span>Time</span><b>{fmtTime(item.end?.ts)}</b>
                                  <span>Actor</span><b>{item.end?.actor || "—"}</b>
                                </div>
                                <Show when={payloadMeta(item.end).length}>
                                  <div class="meta-list"><For each={payloadMeta(item.end)}>{([k, v]) => <p><span>{k}</span><b>{v}</b></p>}</For></div>
                                </Show>
                                <Show when={item.end?.payload}>
                                  <pre class="phase-payload">{JSON.stringify(item.end.payload, null, 2)}</pre>
                                </Show>
                              </section>
                            </div>
                          </>
                        ) : (
                          <>
                            <div class="detail-grid">
                              <span>Session</span><b>{sessionSlug(raw()?.session_id)}</b>
                              <span>Actor</span><b>{raw()?.actor || "—"}</b>
                              <span>Time</span><b>{fmtTime(item.ts)}</b>
                            </div>
                            <pre>{JSON.stringify(raw()?.payload || {}, null, 2)}</pre>
                          </>
                        )}
                      </div>
                    </Show>
                  </article>
                );
              }}
            </For>
          </Show>
        </div>
      </section>
    </div>
  );
}
