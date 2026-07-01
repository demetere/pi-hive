import { createEffect, createMemo, createSignal, For, JSX, on, Show } from "solid-js";
import {
  fetchPlanDetail, fetchPlanFile, fetchPlans, postPlanApproval, postPlanComment,
  type PlanApproval, type PlanComment, type PlanDetail, type PlanSummary, type PlanVerdict,
} from "../api";
import { currentSession, now } from "../store";
import { absTime, relTime } from "../lib/format";
import "./plans.css";

const GATES = ["proposal", "requirements", "design", "tasks"] as const;

// ── Safe markdown renderer ──────────────────────────────────────────────────
// Builds JSX nodes line-by-line from plan artifacts. Nothing is injected as raw
// HTML; every span comes from inline() which only emits <strong>/<code>/<a>/text
// nodes with their text set via JSX children (auto-escaped by Solid). Supports
// headings, bold, inline code, fenced code blocks, lists, checklists, links.

function inline(text: string): JSX.Element[] {
  const nodes: JSX.Element[] = [];
  // Tokenize on inline code, bold, and links. Order matters: code first so ** or
  // [ ] inside code spans is left literal.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      nodes.push(<code class="md-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      nodes.push(<strong>{tok.slice(2, -2)}</strong>);
    } else {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (lm) {
        const href = lm[2];
        const safe = /^(https?:|mailto:|\/|\.\/|#)/i.test(href) ? href : "#";
        nodes.push(<a class="md-link" href={safe} target="_blank" rel="noopener noreferrer">{lm[1]}</a>);
      } else {
        nodes.push(tok);
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderMarkdown(src: string): JSX.Element {
  const lines = (src || "").replace(/\r\n/g, "\n").split("\n");
  const out: JSX.Element[] = [];
  let list: JSX.Element[] | null = null;
  let para: string[] = [];
  let code: string[] | null = null;

  const flushPara = () => {
    if (para.length) { out.push(<p class="md-p">{inline(para.join(" "))}</p>); para = []; }
  };
  const flushList = () => {
    if (list && list.length) { out.push(<ul class="md-ul">{list}</ul>); }
    list = null;
  };

  for (const raw of lines) {
    const line = raw;
    // fenced code block
    if (/^\s*```/.test(line)) {
      if (code === null) { flushPara(); flushList(); code = []; }
      else { out.push(<pre class="md-pre"><code>{code.join("\n")}</code></pre>); code = null; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushPara(); flushList();
      const level = heading[1].length;
      const content = inline(heading[2]);
      out.push(level === 1 ? <h3 class="md-h1">{content}</h3> : level === 2 ? <h4 class="md-h2">{content}</h4> : <h5 class="md-h3">{content}</h5>);
      continue;
    }

    const check = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (check) {
      flushPara();
      const done = check[1].toLowerCase() === "x";
      list = list || [];
      list.push(<li class="md-task"><input type="checkbox" checked={done} disabled /><span classList={{ "md-task-done": done }}>{inline(check[2])}</span></li>);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushPara();
      list = list || [];
      list.push(<li class="md-li">{inline(bullet[1])}</li>);
      continue;
    }

    if (!line.trim()) { flushPara(); flushList(); continue; }

    // paragraph text (flush any open list first)
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  if (code !== null && code.length) out.push(<pre class="md-pre"><code>{code.join("\n")}</code></pre>);
  return <div class="md">{out}</div>;
}

// ── Small presentational helpers ────────────────────────────────────────────

function VerdictPill(props: { verdict: PlanVerdict["verdict"]; label?: string }) {
  return <span class={`verdict-pill v-${props.verdict}`}>{props.label ?? props.verdict}</span>;
}

function PhaseBadge(props: { phase: string }) {
  return <span class={`phase-badge ${props.phase === "ready" ? "ready" : ""}`}>{props.phase}</span>;
}

export default function Plans(props: { search: string }) {
  const cwd = () => currentSession()?.cwd;

  const [plans, setPlans] = createSignal<PlanSummary[]>([]);
  const [selected, setSelected] = createSignal<string>("");
  const [detail, setDetail] = createSignal<PlanDetail | null>(null);
  const [artifact, setArtifact] = createSignal<string>("");
  const [fileBody, setFileBody] = createSignal<string>("");
  const [loading, setLoading] = createSignal(false);

  // comment form
  const [cFile, setCFile] = createSignal<string>("");
  const [cAnchor, setCAnchor] = createSignal<string>("");
  const [cBody, setCBody] = createSignal<string>("");
  const [submitting, setSubmitting] = createSignal(false);

  // approval form
  const [aPhase, setAPhase] = createSignal<string>("proposal");

  async function loadPlans() {
    setLoading(true);
    const list = await fetchPlans(cwd());
    setPlans(list);
    setLoading(false);
    // keep selection valid
    if (selected() && !list.some((p) => p.changeId === selected())) { setSelected(""); setDetail(null); }
  }

  async function loadDetail(changeId: string) {
    const d = await fetchPlanDetail(changeId, cwd());
    setDetail(d);
    // default the artifact viewer to proposal.md (or the first artifact)
    const arts = d?.artifacts || [];
    const first = arts.includes("proposal.md") ? "proposal.md" : arts[0] || "";
    setArtifact(first);
    if (first) setFileBody(await fetchPlanFile(changeId, first, cwd()));
    else setFileBody("");
  }

  async function selectPlan(changeId: string) {
    setSelected(changeId);
    setCFile(""); setCAnchor(""); setCBody("");
    await loadDetail(changeId);
  }

  async function openArtifact(name: string) {
    setArtifact(name);
    setFileBody(await fetchPlanFile(selected(), name, cwd()));
  }

  async function submitComment() {
    if (!cBody().trim() || !selected()) return;
    setSubmitting(true);
    const ok = await postPlanComment(selected(), { file: cFile() || undefined, anchor: cAnchor().trim() || undefined, body: cBody().trim() }, cwd());
    setSubmitting(false);
    if (ok) { setCBody(""); setCAnchor(""); await loadDetail(selected()); }
  }

  async function approveGate() {
    if (!selected()) return;
    const ok = await postPlanApproval(selected(), { phase: aPhase() }, cwd());
    if (ok) { await loadDetail(selected()); await loadPlans(); }
  }

  // Refetch the list whenever the scoped project cwd changes (and on mount).
  createEffect(on(cwd, () => { void loadPlans(); }));

  const filtered = createMemo<PlanSummary[]>(() => {
    const q = props.search.toLowerCase();
    return plans().filter((p) => !q || p.changeId.toLowerCase().includes(q) || (p.title || "").toLowerCase().includes(q));
  });

  return (
    <div class="plans-layout">
      <div class="plans-list tab-card">
        <div class="plans-list-head">
          <span>Plans</span>
          <button class="plans-refresh" title="Refresh" onClick={() => void loadPlans()}>⟳</button>
        </div>
        <Show when={!loading() || plans().length} fallback={<div class="empty">Loading…</div>}>
          <For each={filtered()} fallback={<div class="empty">No plans for this project yet.</div>}>
            {(p) => (
              <div class={`plan-row ${selected() === p.changeId ? "active" : ""}`} onClick={() => void selectPlan(p.changeId)}>
                <div class="plan-row-main">
                  <span class="plan-title">{p.title || p.changeId}</span>
                  <span class="plan-id mono">{p.changeId}</span>
                </div>
                <div class="plan-row-meta">
                  <PhaseBadge phase={p.phase} />
                  <Show when={p.latestVerdict}>{(v) => <VerdictPill verdict={v().verdict} />}</Show>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>

      <div class="plans-detail">
        <Show when={detail()} fallback={<div class="tab-card empty plans-empty">Select a plan to view its artifacts, verdicts, and comments.</div>}>
          {(d) => (
            <>
              <div class="tab-card plan-head">
                <div class="plan-head-title">
                  <h2>{d().title || d().changeId}</h2>
                  <span class="plan-id mono">{d().changeId}</span>
                </div>
                <div class="plan-head-meta">
                  <PhaseBadge phase={d().phase} />
                  <Show when={d().status}><span class="meta-chip">status: {d().status}</span></Show>
                  <Show when={d().owner}><span class="meta-chip">owner: {d().owner}</span></Show>
                </div>
                <div class="gate-track">
                  <For each={d().gates}>
                    {(g) => (
                      <div class={`gate ${g.present ? "on" : "off"}`}>
                        <span class="gate-mark">{g.present ? "●" : "○"}</span>
                        <span class="gate-name">{g.gate}</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>

              <div class="tab-card plan-artifacts">
                <div class="artifact-tabs">
                  <For each={d().artifacts} fallback={<span class="empty-inline">No artifacts written yet.</span>}>
                    {(name) => (
                      <button class={`artifact-tab ${artifact() === name ? "active" : ""}`} onClick={() => void openArtifact(name)}>{name}</button>
                    )}
                  </For>
                </div>
                <Show when={artifact()} fallback={<div class="empty">Nothing to display.</div>}>
                  <div class="artifact-body">{renderMarkdown(fileBody())}</div>
                </Show>
              </div>

              <div class="plan-grid">
                <div class="tab-card timeline-card">
                  <h3 class="card-h">Verdicts</h3>
                  <For each={[...d().verdicts].reverse()} fallback={<div class="empty">No verdicts yet.</div>}>
                    {(v: PlanVerdict) => (
                      <div class="timeline-item">
                        <div class="ti-head">
                          <VerdictPill verdict={v.verdict} />
                          <span class="ti-who">{v.reviewer}</span>
                          <span class="ti-time" title={absTime(v.createdAt)}>{relTime(v.createdAt, now())}</span>
                        </div>
                        <Show when={v.summary}><div class="ti-summary">{v.summary}</div></Show>
                        <Show when={v.blockers.length}><ul class="ti-list blockers"><For each={v.blockers}>{(b) => <li>{b}</li>}</For></ul></Show>
                        <Show when={v.concerns.length}><ul class="ti-list concerns"><For each={v.concerns}>{(c) => <li>{c}</li>}</For></ul></Show>
                        <Show when={v.evidence.length}><ul class="ti-list evidence"><For each={v.evidence}>{(e) => <li>{e}</li>}</For></ul></Show>
                      </div>
                    )}
                  </For>
                </div>

                <div class="tab-card timeline-card">
                  <h3 class="card-h">Approvals</h3>
                  <div class="approve-row">
                    <select value={aPhase()} onChange={(e) => setAPhase(e.currentTarget.value)}>
                      <For each={GATES}>{(g) => <option value={g}>{g}</option>}</For>
                    </select>
                    <button class="btn-approve" onClick={() => void approveGate()}>Approve gate</button>
                  </div>
                  <For each={[...d().approvals].reverse()} fallback={<div class="empty">No approvals yet.</div>}>
                    {(a: PlanApproval) => (
                      <div class="timeline-item">
                        <div class="ti-head">
                          <span class="approve-phase">{a.phase}</span>
                          <span class="ti-who">{a.approvedBy}{a.actor ? ` · ${a.actor}` : ""}</span>
                          <span class="ti-time" title={absTime(a.createdAt)}>{relTime(a.createdAt, now())}</span>
                        </div>
                        <Show when={a.summary}><div class="ti-summary">{a.summary}</div></Show>
                      </div>
                    )}
                  </For>
                </div>
              </div>

              <div class="tab-card comments-card">
                <h3 class="card-h">Comments</h3>
                <div class="comment-form">
                  <div class="cf-row">
                    <select value={cFile()} onChange={(e) => setCFile(e.currentTarget.value)}>
                      <option value="">(general)</option>
                      <For each={d().artifacts}>{(name) => <option value={name}>{name}</option>}</For>
                    </select>
                    <input type="text" placeholder="anchor (heading, optional)" value={cAnchor()} onInput={(e) => setCAnchor(e.currentTarget.value)} />
                  </div>
                  <textarea placeholder="Add a comment…" value={cBody()} onInput={(e) => setCBody(e.currentTarget.value)} rows={3} />
                  <div class="cf-actions">
                    <button class="btn-submit" disabled={!cBody().trim() || submitting()} onClick={() => void submitComment()}>{submitting() ? "Posting…" : "Comment"}</button>
                  </div>
                </div>
                <For each={[...d().comments].reverse()} fallback={<div class="empty">No comments yet.</div>}>
                  {(c: PlanComment) => (
                    <div class="comment-item">
                      <div class="ci-head">
                        <span class="ci-who">{c.author || "anon"}</span>
                        <Show when={c.file}><span class="ci-target mono">{c.file}{c.anchor ? `#${c.anchor}` : ""}</span></Show>
                        <span class="ti-time" title={absTime(c.createdAt)}>{relTime(c.createdAt, now())}</span>
                      </div>
                      <div class="ci-body">{c.body}</div>
                    </div>
                  )}
                </For>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
