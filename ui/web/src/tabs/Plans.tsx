import { createEffect, createMemo, createSignal, For, JSX, on, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  fetchPlanDetail, fetchPlanFile, fetchPlans, postPlanApproval, postPlanComment,
  type PlanApproval, type PlanComment, type PlanDetail, type PlanSummary, type PlanVerdict,
} from "../api";
import { currentSession, now } from "../store";
import { absTime, relTime } from "../lib/format";
import "./plans.css";

type ReviewAnnotation = { id: string; artifact: string; type: "COMMENT" | "DELETION" | "LOOKS_GOOD"; originalText: string; text: string; };

// ── Safe markdown renderer ──────────────────────────────────────────────────
// Builds JSX nodes line-by-line from plan artifacts. Nothing is injected as raw
// HTML; every span comes from inline() which only emits <strong>/<code>/<a>/text
// nodes with their text set via JSX children (auto-escaped by Solid). Supports
// headings, bold, inline code, fenced code blocks, lists, checklists, links.

function highlightedText(text: string, anns: ReviewAnnotation[]): JSX.Element[] {
  const matches = anns
    .map((ann) => ({ ann, at: text.indexOf(ann.originalText) }))
    .filter((m) => m.at >= 0)
    .sort((a, b) => a.at - b.at || b.ann.originalText.length - a.ann.originalText.length);
  const out: JSX.Element[] = [];
  let pos = 0;
  for (const m of matches) {
    if (m.at < pos) continue;
    if (m.at > pos) out.push(text.slice(pos, m.at));
    out.push(<mark class={`plan-mark ${m.ann.type.toLowerCase()}`} title={m.ann.text}>{text.slice(m.at, m.at + m.ann.originalText.length)}</mark>);
    pos = m.at + m.ann.originalText.length;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

function inline(text: string, anns: ReviewAnnotation[] = []): JSX.Element[] {
  const nodes: JSX.Element[] = [];
  // Tokenize on inline code, bold, and links. Order matters: code first so ** or
  // [ ] inside code spans is left literal.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(...highlightedText(text.slice(last, m.index), anns));
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
  if (last < text.length) nodes.push(...highlightedText(text.slice(last), anns));
  return nodes;
}

function renderMarkdown(src: string, anns: ReviewAnnotation[] = []): JSX.Element {
  const lines = (src || "").replace(/\r\n/g, "\n").split("\n");
  const out: JSX.Element[] = [];
  let list: JSX.Element[] | null = null;
  let para: string[] = [];
  let code: string[] | null = null;

  const flushPara = () => {
    if (para.length) { out.push(<p class="md-p">{inline(para.join(" "), anns)}</p>); para = []; }
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
      const content = inline(heading[2], anns);
      out.push(level === 1 ? <h3 class="md-h1">{content}</h3> : level === 2 ? <h4 class="md-h2">{content}</h4> : <h5 class="md-h3">{content}</h5>);
      continue;
    }

    const check = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (check) {
      flushPara();
      const done = check[1].toLowerCase() === "x";
      list = list || [];
      list.push(<li class="md-task"><input type="checkbox" checked={done} disabled /><span classList={{ "md-task-done": done }}>{inline(check[2], anns)}</span></li>);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushPara();
      list = list || [];
      list.push(<li class="md-li">{inline(bullet[1], anns)}</li>);
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
  const [reviewNote, setReviewNote] = createSignal("");
  const [selectedText, setSelectedText] = createSignal("");
  const [selectionBox, setSelectionBox] = createSignal<{ top: number; left: number } | null>(null);
  const [annType, setAnnType] = createSignal<ReviewAnnotation["type"]>("COMMENT");
  const [annText, setAnnText] = createSignal("");
  const [annotations, setAnnotations] = createSignal<ReviewAnnotation[]>([]);
  const [submitting, setSubmitting] = createSignal(false);
  let artifactEl: HTMLDivElement | undefined;


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
    setCFile(""); setCAnchor(""); setCBody(""); setReviewNote("");
    await loadDetail(changeId);
  }

  async function openArtifact(name: string) {
    setArtifact(name);
    setSelectedText(""); setAnnText(""); setSelectionBox(null);
    setFileBody(await fetchPlanFile(selected(), name, cwd()));
  }

  function captureSelection() {
    const sel = window.getSelection();
    const text = sel?.toString().trim() || "";
    if (!text || !artifactEl || !sel?.anchorNode || !sel?.focusNode || !artifactEl.contains(sel.anchorNode) || !artifactEl.contains(sel.focusNode)) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelectedText(text.replace(/\s+/g, " ").slice(0, 1200));
    setSelectionBox({ top: Math.max(12, rect.top - 10), left: rect.left + rect.width / 2 });
    setAnnType("COMMENT");
    setAnnText("");
  }

  function addAnnotation(type = annType()) {
    const originalText = selectedText().trim();
    if (!originalText) return;
    const text = annText().trim();
    if (type === "COMMENT" && !text) return;
    setAnnotations((prev) => [...prev, { id: crypto.randomUUID(), artifact: artifact(), type, originalText, text }]);
    setSelectedText(""); setAnnText(""); setSelectionBox(null);
    window.getSelection()?.removeAllRanges();
  }

  function closeSelectionTools() {
    setSelectedText(""); setAnnText(""); setSelectionBox(null);
    window.getSelection()?.removeAllRanges();
  }

  function removeAnnotation(id: string) { setAnnotations((prev) => prev.filter((a) => a.id !== id)); }

  function exportReviewFeedback(extra = reviewNote().trim()): string {
    const lines: string[] = [];
    if (extra) lines.push(`# General feedback\n\n${extra}`);
    if (annotations().length) {
      lines.push(`# Inline plan annotations`);
      for (const [idx, ann] of annotations().entries()) {
        const title = ann.type === "DELETION" ? "Remove this" : ann.type === "LOOKS_GOOD" ? "Looks good" : "Feedback";
        lines.push(`## ${idx + 1}. ${title} (${ann.artifact})`);
        lines.push(`> ${ann.originalText}`);
        if (ann.type === "DELETION") lines.push(ann.text || "Remove this section from the plan.");
        else if (ann.type === "LOOKS_GOOD") lines.push(ann.text || "This part is approved / looks good.");
        else lines.push(ann.text);
      }
    }
    return lines.join("\n\n").trim();
  }

  async function submitComment() {
    if (!cBody().trim() || !selected()) return;
    setSubmitting(true);
    const ok = await postPlanComment(selected(), { file: cFile() || undefined, anchor: cAnchor().trim() || undefined, body: cBody().trim() }, cwd());
    setSubmitting(false);
    if (ok) { setCBody(""); setCAnchor(""); await loadDetail(selected()); }
  }

  async function approveGate(phase: string, summary = exportReviewFeedback()) {
    if (!selected()) return;
    const ok = await postPlanApproval(selected(), { phase, summary: summary || undefined }, cwd());
    if (ok) { setReviewNote(""); setAnnotations([]); await loadDetail(selected()); await loadPlans(); }
  }

  async function sendReviewFeedback() {
    if (!selected()) return;
    const general = reviewNote().trim();
    const anns = annotations();
    if (!general && !anns.length) return;
    setSubmitting(true);
    let ok = true;
    if (general) ok = await postPlanComment(selected(), { body: general, author: "dashboard" }, cwd()) && ok;
    for (const ann of anns) {
      ok = await postPlanComment(selected(), {
        file: ann.artifact,
        author: "dashboard",
        body: ann.text || (ann.type === "DELETION" ? "Remove this section from the plan." : "Looks good."),
        annotationType: ann.type,
        originalText: ann.originalText,
      }, cwd()) && ok;
    }
    setSubmitting(false);
    if (ok) { setReviewNote(""); setAnnotations([]); await loadDetail(selected()); }
  }

  // Refetch the list whenever the scoped project cwd changes (and on mount).
  createEffect(on(cwd, () => { void loadPlans(); }));

  const filtered = createMemo<PlanSummary[]>(() => {
    const q = props.search.toLowerCase();
    return plans().filter((p) => !q || p.changeId.toLowerCase().includes(q) || (p.title || "").toLowerCase().includes(q));
  });

  const persistedAnnotations = createMemo<ReviewAnnotation[]>(() => (detail()?.comments || [])
    .filter((c) => c.annotationType && c.originalText)
    .map((c) => ({
      id: c.id,
      artifact: c.file || "",
      type: c.annotationType as ReviewAnnotation["type"],
      originalText: c.originalText || "",
      text: c.body,
    })));
  const artifactAnnotations = createMemo(() => [...persistedAnnotations(), ...annotations()].filter((ann) => ann.artifact === artifact()));

  return (
    <>
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
                <div class="review-box slim">
                  <div class="review-main">
                    <textarea placeholder="General feedback… or select text in the artifact below for inline feedback" value={reviewNote()} onInput={(e) => setReviewNote(e.currentTarget.value)} rows={2} />
                    <Show when={annotations().length}>
                      <div class="annotation-list compact">
                        <For each={annotations()}>{(ann) => (
                          <div class="annotation-item">
                            <b>{ann.type === "DELETION" ? "Remove" : ann.type === "LOOKS_GOOD" ? "Looks good" : "Comment"}</b>
                            <span class="mono">{ann.artifact}</span>
                            <button onClick={() => removeAnnotation(ann.id)}>×</button>
                            <p>“{ann.originalText}”</p>
                            <Show when={ann.text}><small>{ann.text}</small></Show>
                          </div>
                        )}</For>
                      </div>
                    </Show>
                  </div>
                  <div class="review-actions">
                    <button class="btn-submit" disabled={(!reviewNote().trim() && !annotations().length) || submitting()} onClick={() => void sendReviewFeedback()}>{submitting() ? "Sending…" : "Send feedback"}</button>
                    <button class="btn-approve" disabled={d().phase === "ready"} onClick={() => void approveGate(d().phase)}>Approve {d().phase}</button>
                  </div>
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
                <div class="artifact-review-shell">
                  <Show when={artifact()} fallback={<div class="empty">Nothing to display.</div>}>
                    <div class="artifact-body" ref={artifactEl} onMouseUp={captureSelection}>{renderMarkdown(fileBody(), artifactAnnotations())}</div>
                  </Show>
                  <aside class="artifact-rail">
                    <div class="rail-head">
                      <b>Annotations</b>
                      <span>{artifactAnnotations().length}</span>
                    </div>
                    <For each={artifactAnnotations()} fallback={<div class="empty small">Select text to annotate this artifact.</div>}>
                      {(ann) => (
                        <div class={`rail-ann ${ann.type.toLowerCase()} ${annotations().some((a) => a.id === ann.id) ? "pending" : "saved"}`}>
                          <div class="rail-ann-top">
                            <b>{ann.type === "DELETION" ? "Remove" : ann.type === "LOOKS_GOOD" ? "Looks good" : "Comment"}</b>
                            <Show when={annotations().some((a) => a.id === ann.id)}><button onClick={() => removeAnnotation(ann.id)}>×</button></Show>
                          </div>
                          <blockquote>{ann.originalText}</blockquote>
                          <Show when={ann.text}><p>{ann.text}</p></Show>
                        </div>
                      )}
                    </For>
                  </aside>
                </div>
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
                <h3 class="card-h">Review log</h3>
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
                        <Show when={c.annotationType}><span class={`ann-kind ${(c.annotationType || "").toLowerCase()}`}>{c.annotationType === "DELETION" ? "Remove" : c.annotationType === "LOOKS_GOOD" ? "Looks good" : "Comment"}</span></Show>
                        <Show when={c.file}><span class="ci-target mono">{c.file}{c.anchor ? `#${c.anchor}` : ""}</span></Show>
                        <span class="ti-time" title={absTime(c.createdAt)}>{relTime(c.createdAt, now())}</span>
                      </div>
                      <Show when={c.originalText}><blockquote class="ci-quote">{c.originalText}</blockquote></Show>
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
    <Show when={selectionBox()}>
      {(box) => (
        <Portal>
          <div class="selection-popover" style={{ top: `${box().top}px`, left: `${box().left}px` }} onMouseDown={(e) => e.preventDefault()}>
            <Show when={annType() !== "COMMENT"} fallback={
              <>
                <div class="selection-popover-actions">
                  <button onClick={() => setAnnType("DELETION")}>Remove</button>
                  <button onClick={() => setAnnType("LOOKS_GOOD")}>Looks good</button>
                  <button onClick={closeSelectionTools}>×</button>
                </div>
                <textarea autofocus placeholder="Feedback for this text…" value={annText()} onInput={(e) => setAnnText(e.currentTarget.value)} rows={3} />
                <div class="selection-popover-actions end">
                  <button class="btn-submit" disabled={!annText().trim()} onClick={() => addAnnotation("COMMENT")}>Add comment</button>
                </div>
              </>
            }>
              <div class="selection-popover-actions">
                <button onClick={() => addAnnotation(annType())}>{annType() === "DELETION" ? "Remove selected text" : "Mark looks good"}</button>
                <button onClick={() => setAnnType("COMMENT")}>Comment instead</button>
                <button onClick={closeSelectionTools}>×</button>
              </div>
            </Show>
          </div>
        </Portal>
      )}
    </Show>
    </>
  );
}
