import { useMemo, useState } from "react";
import { useHive } from "../store";
import { loadOlderEvents, pushToast, viewAgent } from "../store/raw";
import RelTime from "../hooks/RelTime";
import { fmtCost, fmtNum, sessionSlug, shortModel } from "../lib/format";
import { buildAgentTeamMap, bundleEvents, itemAgent, itemHaystack, mergeThinking, type ActivityItem } from "../lib/activity";

const PAGE = 60;

function itemParticipants(item: ActivityItem): Set<string> {
  const out = new Set<string>();
  const add = (e: any) => {
    const p = e?.payload || {};
    for (const v of [e?.actor, p.agent, p.from, p.to]) if (v) out.add(v);
  };
  if (item.kind === "thinking") { out.add(item.agent); return out; }
  if (item.kind === "tool") { add(item.start); add(item.end); }
  else add(item.event);
  return out;
}
function payloadMeta(e: any): Array<[string, string]> {
  const skip = new Set(["agent", "toolName", "toolCallId", "isError"]);
  return Object.entries(e?.payload || {})
    .filter(([k, v]) => !skip.has(k) && v != null && v !== "")
    .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)] as [string, string]);
}
function fmtTime(ts?: string): string { return ts ? new Date(ts).toLocaleString() : "—"; }
function fmtMs(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
// Typed fields surfaced for a delegation_end event (Phase 3.2) instead of a raw
// JSON dump. Reads the per-run `delta` block (Phase 2) for this run's tokens/cost
// and the stop_reason / duration / model the SDK reported.
function delegationDetail(e: any): Array<[string, string]> {
  const p = e?.payload || {};
  const d = p.delta || {};
  const model = Array.isArray(p.models) && p.models.length ? p.models[p.models.length - 1] : p.model;
  const inTok = Number(d.inputTokens ?? p.inputTokens ?? 0);
  const outTok = Number(d.outputTokens ?? p.outputTokens ?? 0);
  const rows: Array<[string, string]> = [
    ["Outcome", String(p.type || "—")],
    ["Stop reason", String(p.stopReason || "—")],
    ["Duration", fmtMs(Number(p.elapsedMs) || undefined)],
    ["Model", model ? shortModel(String(model)) : "—"],
    ["Tokens (in+out)", fmtNum(inTok + outTok)],
    ["Cache (r+w)", fmtNum(Number(d.cacheReadTokens ?? 0) + Number(d.cacheWriteTokens ?? 0))],
    ["Cost", p.costUsd != null || d.costUsd != null ? fmtCost(Number(d.costUsd ?? p.costUsd)) : "—"],
  ];
  if (p.errorMessage) rows.push(["Error", String(p.errorMessage)]);
  return rows;
}
function toolDuration(item: Extract<ActivityItem, { kind: "tool" }>): string {
  if (!item.start || !item.end) return "running";
  const ms = new Date(item.end.ts).getTime() - new Date(item.start.ts).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function itemTitle(item: ActivityItem): string {
  if (item.kind === "thinking") return `${item.agent} thinking`;
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
    case "worker_retry": return p.phase === "end"
      ? `${p.agent || "worker"} retry ${p.success ? "succeeded" : "failed"}`
      : `${p.agent || "worker"} retry ${p.attempt ?? "?"}/${p.maxAttempts ?? "?"}`;
    default: return e.type;
  }
}
function itemSummary(item: ActivityItem): string {
  if (item.kind === "thinking") return item.text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
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
    case "worker_retry": return p.errorMessage || "";
    default: return typeof p.text === "string" ? p.text : "";
  }
}

// Whether an item's payload was clipped at source (J6) — feeds the "… truncated"
// affordance so the reader knows the preview is partial.
function itemTruncated(item: ActivityItem): boolean {
  if (item.kind === "tool") return (item.end || item.start)?.payload?.truncated === true;
  if (item.kind === "event") return item.event?.payload?.truncated === true;
  return false;
}
export default function Activity(props: { search: string }) {
  const scopedEvents = useHive((s) => s.scopedEvents);
  const scopedAgents = useHive((s) => s.scopedAgents);
  const scopedSessions = useHive((s) => s.scopedSessions);
  const thinkingBySession = useHive((s) => s.thinkingBySession);
  const snapshots = useHive((s) => s.snapshots);

  // Name → team from the versioned topologies of the in-scope sessions (E3).
  // Replaces the old name-regex heuristic.
  const teamByAgent = useMemo(() => {
    const scoped = scopedSessions.map((s) => snapshots[s.session_id]).filter(Boolean);
    return buildAgentTeamMap(scoped);
  }, [scopedSessions, snapshots]);
  const teamOfAgent = (name: string): "planning" | "hive" => teamByAgent.get(name) || "hive";

  const [type, setType] = useState("");
  const [agent, setAgent] = useState("");
  const [team, setTeam] = useState<"all" | "planning" | "hive">("all");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [loadingOlder, setLoadingOlder] = useState(false);

  const thinking = useMemo(() => {
    const out: Array<{ agent: string; ts: string; text: string }> = [];
    for (const s of scopedSessions) for (const t of thinkingBySession.get(s.session_id) || []) out.push(t);
    return out;
  }, [scopedSessions, thinkingBySession]);
  const items = useMemo(() => mergeThinking(bundleEvents(scopedEvents), thinking), [scopedEvents, thinking]);
  const types = useMemo(() => Array.from(new Set(items.map((e) => e.type))).sort(), [items]);

  const agents = useMemo(() => {
    const statusRank: Record<string, number> = { running: 0, waiting: 1, error: 2, idle: 3, done: 4 };
    const roleRank: Record<string, number> = { orchestrator: 0, lead: 1, member: 2 };
    const sessionSeconds = new Map(scopedSessions.map((s) => {
      const first = new Date(s.first_ts).getTime();
      const last = new Date(s.last_ts).getTime();
      return [s.session_id, Math.max(1, Number.isFinite(last - first) ? (last - first) / 1000 : 0)] as const;
    }));
    const byName = new Map<string, any>();
    for (const a of scopedAgents) {
      const prev = byName.get(a.name);
      const seconds = sessionSeconds.get(a.session_id) || 0;
      if (!prev) { byName.set(a.name, { ...a, team: teamOfAgent(a.name), wallSeconds: seconds, tokSec: seconds ? a.tokens / seconds : 0, sessions: new Set([a.session_id]) }); continue; }
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
  }, [scopedAgents, scopedSessions, teamByAgent]);

  const visibleAgents = useMemo(() => team === "all" ? agents : agents.filter((a) => a.team === team), [agents, team]);
  const agentColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) if (a.color) m.set(a.name, a.color);
    return m;
  }, [agents]);

  // Precompute a cheap search haystack per item once, instead of JSON.stringify
  // over the whole event/tool payload on every keystroke inside the filter.
  const haystacks = useMemo(() => {
    const m = new Map<string, string>();
    for (const item of items) m.set(item.id, itemHaystack(item));
    return m;
  }, [items]);

  // Reuse the team already derived per agent (in the `agents` memo) rather than
  // re-running the topology team lookup for every item inside the filter.
  const teamOf = useMemo(() => {
    const m = new Map<string, "planning" | "hive">();
    for (const a of agents) m.set(a.name, a.team);
    return m;
  }, [agents]);

  // Names that stand in for "the orchestrator" when matching feed participants
  // (K6/Decision 8): the actual orchestrator-role agent names from the topology,
  // plus the literal "Orchestrator" telemetry actor its own events are tagged
  // with. Replaces the bare participants.has("Orchestrator") heuristic.
  const orchestratorNames = useMemo(() => {
    const s = new Set<string>(["Orchestrator"]);
    for (const a of agents) if (a.role === "orchestrator") s.add(a.name);
    return s;
  }, [agents]);
  const hasOrchestrator = (participants: Set<string>) => {
    for (const n of orchestratorNames) if (participants.has(n)) return true;
    return false;
  };

  const filtered = useMemo(() => {
    const q = props.search.toLowerCase();
    const selectedAgent = agent;
    const selectedMeta = agents.find((a) => a.name === selectedAgent);
    return items.filter((item) => {
      const a = itemAgent(item);
      const selectedTeam = team;
      const participants = itemParticipants(item);
      const sessionLevel = item.kind === "event" && ["session_start", "user_message", "assistant_message"].includes(item.event.type);
      const matchesAgent = !selectedAgent || participants.has(selectedAgent) ||
        (selectedMeta?.team === "planning" && selectedMeta?.role === "orchestrator" && hasOrchestrator(participants)) ||
        (selectedMeta?.role === "orchestrator" && sessionLevel);
      return (!type || item.type === type) &&
        matchesAgent &&
        (selectedTeam === "all" || (a ? (teamOf.get(a) || teamOfAgent(a)) === selectedTeam : false) || (selectedTeam === "planning" && hasOrchestrator(participants))) &&
        (!q || (haystacks.get(item.id) || "").includes(q));
    });
  }, [items, agents, agent, team, type, props.search, haystacks, teamOf, orchestratorNames]);

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const clampedPage = Math.min(page, pages - 1);
  const slice = filtered.slice(clampedPage * PAGE, clampedPage * PAGE + PAGE);

  function toggle(id: string) {
    setOpen((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  return (
    <div className="activity-layout">
      <aside className="activity-agents tab-card">
        <div className="activity-panel-head">
          <b>Agents in scope</b>
          <span>{agents.length}</span>
        </div>
        <div className="team-filters" role="tablist" aria-label="Agent team filter">
          <button className={`team-filter ${team === "all" ? "active" : ""}`} onClick={() => { setTeam("all"); setAgent(""); setPage(0); }}>All</button>
          <button className={`team-filter ${team === "hive" ? "active" : ""}`} onClick={() => { setTeam("hive"); setAgent(""); setPage(0); }}>Hive</button>
          <button className={`team-filter ${team === "planning" ? "active" : ""}`} onClick={() => { setTeam("planning"); setAgent(""); setPage(0); }}>Planning</button>
        </div>
        <div className="activity-agent-list">
          <button className={`agent-filter ${agent === "" ? "active" : ""}`} onClick={() => { setAgent(""); setPage(0); }}>All activity</button>
          {visibleAgents.map((a) => (
            <button key={a.key} className={`agent-filter ${agent === a.name ? "active" : ""}`} onClick={() => { setAgent(a.name); setPage(0); }} onDoubleClick={() => viewAgent({ sessionId: a.session_id, name: a.name, color: a.color, status: a.status, model: a.model })}>
              <span className="cdot" style={{ background: a.color || "var(--muted)" }} />
              <span className="agent-filter-main">
                <b>{a.name}</b>
                <small>{a.role || "member"} · {a.status} · {a.sessions.size} session{a.sessions.size === 1 ? "" : "s"} · {shortModel(a.model)}</small>
              </span>
              <span className="agent-filter-stat"><b>{fmtNum(a.tokens)}</b><small>{a.tokSec ? `${a.tokSec.toFixed(1)} tok/s` : "— tok/s"}</small></span>
            </button>
          ))}
          {!agents.length && <div className="empty">No agents yet.</div>}
        </div>
      </aside>

      <section className="activity-feed">
        <div className="toolbar">
          <select value={type} onChange={(e) => { setType(e.target.value); setPage(0); }}>
            <option value="">all types</option>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <div className="spacer" />
          {/* Phase 3.4: the reasoning feed is capped server-side at the last 12
              entries per agent, so older thinking isn't shown here. */}
          {thinking.length > 0 && (
            <span className="muted-cell" title="The reasoning feed shows only the most recent 12 thinking entries per agent (server-clipped).">💭 last 12/agent</span>
          )}
          <span className="muted-cell">{total ? `${clampedPage * PAGE + 1}-${Math.min(total, (clampedPage + 1) * PAGE)} of ${total}` : "no events"}</span>
          <div className="pager">
            <button className="btn pill" disabled={clampedPage <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Newer</button>
            <button className="btn pill" disabled={clampedPage >= pages - 1} onClick={() => setPage((p) => p + 1)}>Older</button>
            {/* K7: on the last loaded page, page OLDER events in from the server
                on demand (bounded, one page per click) rather than pre-loading
                the whole history. */}
            <button
              className="btn pill"
              disabled={loadingOlder || clampedPage < pages - 1}
              title="Fetch older events from the dashboard database"
              onClick={async () => {
                setLoadingOlder(true);
                try {
                  const n = await loadOlderEvents();
                  if (n > 0) setPage((p) => p + 1);
                  else pushToast("info", "No older events — you've reached the beginning.");
                } finally { setLoadingOlder(false); }
              }}
            >
              {loadingOlder ? "Loading…" : "Load older"}
            </button>
          </div>
        </div>
        <div className="activity-card-grid">
          {!slice.length ? <div className="tab-card"><div className="empty">No events match.</div></div>
            : slice.map((item) => {
              const expanded = open.has(item.id);
              const a = itemAgent(item);
              const color = agentColor.get(a) || "var(--accent)";
              const isThinking = item.kind === "thinking";
              const raw = item.kind === "tool" ? (item.end || item.start) : item.kind === "event" ? item.event : undefined;
              const errored = item.kind === "tool" ? item.end?.payload?.isError : raw?.payload?.isError || raw?.type === "error";
              const succeeded = !errored && item.kind === "tool" && !!item.end;
              const summary = itemSummary(item);
              const truncated = itemTruncated(item);
              return (
                <article key={item.id} className={`activity-box ${errored ? "err" : succeeded ? "ok" : ""}`} style={{ "--agent-color": color } as React.CSSProperties}>
                  <button className="activity-event-head" onClick={() => toggle(item.id)}>
                    <span className="tl-type">{item.type}</span>
                    {errored ? <span className="outcome err" title="failed">✗</span>
                      : succeeded ? <span className="outcome ok" title="succeeded">✓</span> : null}
                    <b>{itemTitle(item)}</b>
                    {a && <span className="agent-chip">{a}</span>}
                    {isThinking && item.tokens ? <span className="tok-meta">+{fmtNum(item.tokens)} tok</span> : null}
                    <span className="tl-time"><RelTime ts={item.ts} /></span>
                    <span className="expand-mark">{expanded ? "−" : "+"}</span>
                  </button>
                  {summary && !isThinking && (
                    <div className="tl-text activity-summary">
                      {summary}
                      {truncated && <span className="text-ink-dimmer italic" title="Preview was truncated at source"> … truncated</span>}
                    </div>
                  )}
                  {isThinking && (
                    <div className={`think-text ${expanded ? "expanded" : ""}`}>{item.text.replace(/\*\*/g, "").trim()}</div>
                  )}
                  {expanded && !isThinking && (
                    <div className="activity-detail">
                      {item.kind === "tool" ? (
                        <>
                          <div className="detail-grid tool-detail-grid">
                            <span>Session</span><b>{sessionSlug(raw?.session_id)}</b>
                            <span>Agent</span><b>{itemAgent(item) || "—"}</b>
                            <span>Tool</span><b>{(item.end || item.start)?.payload?.toolName || "—"}</b>
                            <span>Status</span><b>{item.end ? (item.end.payload?.isError ? "error" : "finished") : "running"}</b>
                            <span>Duration</span><b>{toolDuration(item)}</b>
                            <span>Call id</span><b>{(item.end || item.start)?.payload?.toolCallId || "—"}</b>
                          </div>
                          <div className="tool-phases">
                            <section className="tool-phase start">
                              <h4>Started</h4>
                              <div className="detail-grid">
                                <span>Time</span><b>{fmtTime(item.start?.ts)}</b>
                                <span>Actor</span><b>{item.start?.actor || "—"}</b>
                              </div>
                              {payloadMeta(item.start).length > 0 && (
                                <div className="meta-list">{payloadMeta(item.start).map(([k, v], i) => <p key={i}><span>{k}</span><b>{v}</b></p>)}</div>
                              )}
                              {item.start?.payload && <pre className="phase-payload">{JSON.stringify(item.start.payload, null, 2)}</pre>}
                            </section>
                            <section className={`tool-phase ${item.end?.payload?.isError ? "err" : "end"}`}>
                              <h4>{item.end ? "Finished" : "Waiting for finish"}</h4>
                              <div className="detail-grid">
                                <span>Time</span><b>{fmtTime(item.end?.ts)}</b>
                                <span>Actor</span><b>{item.end?.actor || "—"}</b>
                              </div>
                              {payloadMeta(item.end).length > 0 && (
                                <div className="meta-list">{payloadMeta(item.end).map(([k, v], i) => <p key={i}><span>{k}</span><b>{v}</b></p>)}</div>
                              )}
                              {item.end?.payload && <pre className="phase-payload">{JSON.stringify(item.end.payload, null, 2)}</pre>}
                            </section>
                          </div>
                        </>
                      ) : raw?.type === "delegation_end" ? (
                        <>
                          <div className="detail-grid">
                            <span>Session</span><b>{sessionSlug(raw?.session_id)}</b>
                            <span>Agent</span><b>{raw?.payload?.from || raw?.actor || "—"}</b>
                            <span>Time</span><b>{fmtTime(item.ts)}</b>
                          </div>
                          {/* Typed per-delegation fields (Phase 3.2) — no raw JSON dump. */}
                          <div className="meta-list">{delegationDetail(raw).map(([k, v], i) => <p key={i}><span>{k}</span><b>{v}</b></p>)}</div>
                        </>
                      ) : (
                        <>
                          <div className="detail-grid">
                            <span>Session</span><b>{sessionSlug(raw?.session_id)}</b>
                            <span>Actor</span><b>{raw?.actor || "—"}</b>
                            <span>Time</span><b>{fmtTime(item.ts)}</b>
                          </div>
                          <pre>{JSON.stringify(raw?.payload || {}, null, 2)}</pre>
                        </>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
        </div>
      </section>
    </div>
  );
}
