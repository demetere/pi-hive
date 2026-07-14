import { useMemo } from "react";
import { useHive } from "../store";
import type { ScopeAgent } from "../store";
import type { ModelInfo } from "../api";
import { viewAgent } from "../store/raw";
import { fmtCost, fmtNum, shortModel } from "../lib/format";

// Phase 6.5: model-capability tooltip — context window + cost per Mtok, from the
// /models capability record. costRates are USD/token; ×1e6 gives USD per Mtok.
function modelCapabilityTitle(m: ModelInfo | undefined): string | undefined {
  if (!m) return undefined;
  const lines: string[] = [];
  if (m.contextWindow) lines.push(`context: ${(m.contextWindow / 1000).toFixed(0)}k tokens`);
  if (m.maxTokens) lines.push(`max output: ${(m.maxTokens / 1000).toFixed(0)}k tokens`);
  const inC = m.costRates?.input, outC = m.costRates?.output;
  if (inC != null || outC != null) {
    lines.push(`cost/Mtok: in $${((inC || 0) * 1e6).toFixed(2)} · out $${((outC || 0) * 1e6).toFixed(2)}`);
  }
  return lines.length ? lines.join("\n") : undefined;
}

// Compact millisecond formatter for the turn-latency cell (Phase 4.11).
function fmtMs(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Raw context-window fill behind the percentage (Phase 4.7), as a hover detail:
// the absolute tokens currently in context over the model's window.
function remainingBudget(r: ScopeAgent): string {
  const b = r.budgetRemaining?.worker;
  if (!b || Object.values(b).every((value) => value == null)) return "unlimited";
  const parts: string[] = [];
  if (b.runs != null) parts.push(`${Math.floor(b.runs)} runs`);
  if (b.tokens != null) parts.push(`${fmtNum(b.tokens)} tok`);
  if (b.costUsd != null) parts.push(fmtCost(b.costUsd));
  if (b.distillerRuns != null) parts.push(`${Math.floor(b.distillerRuns)} distill`);
  return parts.join(" · ");
}

function contextTitle(r: ScopeAgent): string | undefined {
  if (r.contextTokens == null && r.contextWindow == null) return undefined;
  const tok = r.contextTokens != null ? fmtNum(r.contextTokens) : "?";
  const win = r.contextWindow != null ? fmtNum(r.contextWindow) : "?";
  return `context: ${tok} / ${win} tokens`;
}

// Status group order: actively-running first, then those blocked waiting on a
// child, then finished, idle, errored. Within a group, keep hierarchy order.
const STATUS_RANK: Record<string, number> = { running: 0, waiting: 1, done: 2, idle: 3, error: 4 };

// Collapse per-(session,agent) rows into one row per agent name, summing
// tokens/cost/runs/tools. The representative row keeps the most-active status,
// the earliest order (stable hierarchy sort), and the first non-empty
// task/type/model/color/role seen. Used at project/fleet scope so the table
// matches the deduped "N agents" count instead of showing K copies.
function collapseByName(agents: ScopeAgent[]): ScopeAgent[] {
  const byName = new Map<string, ScopeAgent>();
  for (const a of agents) {
    const key = a.name.trim().toLowerCase();
    if (!key) continue;
    const cur = byName.get(key);
    if (!cur) {
      byName.set(key, { ...a });
      continue;
    }
    cur.tokens += a.tokens;
    cur.cost += a.cost;
    cur.runs += a.runs;
    cur.tools += a.tools;
    // Prefer the more-active status (lower rank) as the shown state.
    if ((STATUS_RANK[a.status] ?? 5) < (STATUS_RANK[cur.status] ?? 5)) cur.status = a.status;
    if (a.order < cur.order) cur.order = a.order;
    if (!cur.task && a.task) cur.task = a.task;
    if (!cur.model && a.model) cur.model = a.model;
    if (!cur.color && a.color) cur.color = a.color;
    if (!cur.role && a.role) cur.role = a.role;
    if (!cur.agentType && a.agentType) cur.agentType = a.agentType;
    // Enforcement contract is the same for an agent name across sessions; keep
    // the first non-empty values (a runtime-only row carries none).
    if (!cur.domain?.length && a.domain?.length) cur.domain = a.domain;
    if (!cur.commit && a.commit) cur.commit = a.commit;
    if (!cur.stages?.length && a.stages?.length) cur.stages = a.stages;
    if (!cur.consultWhen && a.consultWhen) cur.consultWhen = a.consultWhen;
    if (!cur.responsibilities && a.responsibilities) cur.responsibilities = a.responsibilities;
  }
  return Array.from(byName.values());
}

// The full enforcement contract for a row, as a hover tooltip (Phase 6.1) — the
// same answer the topology node tooltip gives, surfaced in the table. Omits
// fields the config didn't declare.
function enforcementTitle(r: ScopeAgent): string {
  const lines: string[] = [];
  if (r.commit) lines.push("commit: yes");
  if (r.domain?.length) lines.push(`domains: ${r.domain.join(", ")}`);
  if (r.stages?.length) lines.push(`plan gates: ${r.stages.join(", ")}`);
  if (r.consultWhen) lines.push(`consult when: ${r.consultWhen}`);
  if (r.responsibilities) lines.push(`responsibilities:\n${r.responsibilities}`);
  return lines.join("\n");
}

// Compact enforcement cell: a commit marker (✓) plus the domain count/first path,
// with the full contract on hover. "—" when the agent declares no boundary.
function enforcementCell(r: ScopeAgent) {
  const hasDomain = !!r.domain?.length;
  if (!hasDomain && !r.commit && !r.stages?.length) return "—";
  const domainLabel = hasDomain
    ? (r.domain!.length === 1 ? r.domain![0] : `${r.domain![0]} +${r.domain!.length - 1}`)
    : (r.stages?.length ? `gates: ${r.stages.length}` : "");
  return (
    <span title={enforcementTitle(r)}>
      {r.commit ? <span title="may commit" style={{ color: "var(--brand)" }}>✓ </span> : null}
      {domainLabel || (r.commit ? "commit" : "—")}
    </span>
  );
}

export default function Agents(props: { search: string }) {
  const scopedAgents = useHive((s) => s.scopedAgents);
  const scopedEvents = useHive((s) => s.scopedEvents);
  const modelInfo = useHive((s) => s.modelInfo);
  const scope = useHive((s) => s.scope);
  // Per-agent average turn latency (Phase 4.11). `turn` events carry the SDK's
  // measured per-turn duration and are actor-tagged; today only the main session
  // emits them (workers have no turn lifecycle of their own).
  //
  // R3-1.5: turn events are tagged with the literal telemetry actor "Orchestrator"
  // (see hooks.ts), but the Agents rows key by the topology's CONFIGURED main name
  // — which is "Planner" for a planning team and arbitrary for a custom-named main.
  // So the column populated only when the main was literally named "Orchestrator".
  // Remap the "Orchestrator" tag onto the actual orchestrator-role row name(s) so
  // the per-row lookup succeeds regardless of the configured name. Still keyed by
  // actor otherwise, so it lights up automatically if worker turn events appear.
  // NOTE: the average only covers turn events in the loaded event window.
  const turnLatency = useMemo(() => {
    const orchestratorNames = scopedAgents.filter((a) => a.role === "orchestrator").map((a) => a.name);
    const acc = new Map<string, { total: number; n: number }>();
    const add = (who: string, ms: number) => {
      const cur = acc.get(who) || { total: 0, n: 0 };
      cur.total += ms; cur.n += 1; acc.set(who, cur);
    };
    for (const e of scopedEvents) {
      if (e.type !== "turn") continue;
      const ms = Number(e.payload?.durationMs);
      const who = e.payload?.agent || e.actor;
      if (!who || !Number.isFinite(ms)) continue;
      // Fan the "Orchestrator" telemetry tag out to the configured main name(s).
      if (who === "Orchestrator" && orchestratorNames.length) {
        for (const name of orchestratorNames) add(name, ms);
      } else {
        add(who, ms);
      }
    }
    const out = new Map<string, number>();
    for (const [who, { total, n }] of acc) if (n) out.set(who, total / n);
    return out;
  }, [scopedEvents, scopedAgents]);
  // Resolve a row's model to its capability record (Phase 6.5), matching the
  // store's normalized keys (full "provider/id" or bare id, lowercased).
  const capabilityOf = (model?: string): ModelInfo | undefined => {
    if (!model) return undefined;
    const k = model.toLowerCase();
    return modelInfo.get(k) || modelInfo.get(k.split("/").pop() || k);
  };
  // Per-session rows only make sense at session scope; elsewhere collapse by name.
  const collapsed = scope.level !== "session";

  const rows = useMemo<ScopeAgent[]>(() => {
    const base = collapsed ? collapseByName(scopedAgents) : scopedAgents;
    const q = props.search.toLowerCase();
    const filtered = base.filter((r) => !q || r.name.toLowerCase().includes(q) || shortModel(r.model).toLowerCase().includes(q) || (r.role || "").toLowerCase().includes(q) || (r.agentType || "").toLowerCase().includes(q));
    return [...filtered].sort((a, b) => {
      const sr = (STATUS_RANK[a.status] ?? 5) - (STATUS_RANK[b.status] ?? 5);
      if (sr !== 0) return sr;
      return a.order - b.order;
    });
  }, [scopedAgents, props.search, collapsed]);

  return (
    <div className="tab-card">
      <table className="table">
        <thead>
          <tr>
            <th>Agent</th><th>Role</th><th>Type</th><th>Domain</th><th>Status</th><th>Model</th>
            <th className="num">Tokens</th><th className="num">Cost</th><th className="num">Runs</th><th className="num">Tools</th><th>Remaining</th>
            <th className="num" title="Average per-turn latency of the main session, over turn events in the loaded window. In multi-session scopes each turn is attributed to every session's main row (turn events carry no session key), so the average is an approximation across sessions.">Turn</th>
            {!collapsed && <th className="num">Context</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="clickable" onClick={() => viewAgent({ sessionId: r.session_id, name: r.name, color: r.color, status: r.status, model: r.model })}>
              <td>
                <span><span className="cdot" style={{ background: r.color || "var(--muted)" }} /><b>{r.name}</b></span>
                {r.task && <div className="muted-cell" style={{ fontSize: "11px", marginTop: "2px", maxWidth: "340px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.task}</div>}
              </td>
              <td className="muted-cell">{r.role || "member"}</td>
              <td className="muted-cell mono">{r.agentType || "—"}</td>
              <td className="muted-cell mono">{enforcementCell(r)}</td>
              <td><span className={`status-tag ${r.status}`}>{r.status}</span></td>
              <td className="muted-cell mono" title={modelCapabilityTitle(capabilityOf(r.model))}>{shortModel(r.model)}</td>
              <td className="num">{fmtNum(r.tokens)}</td>
              <td className="num">{fmtCost(r.cost)}</td>
              <td className="num">{r.runs}</td>
              <td className="num">{r.tools}</td>
              <td className="muted-cell mono">{remainingBudget(r)}</td>
              <td className="num">{turnLatency.has(r.name) ? fmtMs(turnLatency.get(r.name)!) : "—"}</td>
              {!collapsed && <td className="num" title={contextTitle(r)}>{r.contextPct != null ? `${Math.round(r.contextPct)}%` : "—"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty">No agents in this scope yet.</div>}
    </div>
  );
}
