import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  fetchPlanDetail, fetchPlanFile, fetchPlans, postPlanApproval, postPlanComment,
  type PlanApproval, type PlanComment, type PlanDetail, type PlanSummary, type PlanVerdict,
} from "../api";
import { useHive } from "../store";
import RelTime from "../hooks/RelTime";
import { absTime } from "../lib/format";

type ReviewAnnotation = { id: string; artifact: string; type: "COMMENT" | "DELETION" | "LOOKS_GOOD"; originalText: string; text: string; };

// ── Safe markdown renderer ──────────────────────────────────────────────────
// Builds React nodes line-by-line; every span comes from inline() which only
// emits <strong>/<code>/<a>/text nodes (auto-escaped by React).

function highlightedText(text: string, anns: ReviewAnnotation[], keyBase: string): ReactNode[] {
  const matches = anns
    .map((ann) => ({ ann, at: text.indexOf(ann.originalText) }))
    .filter((m) => m.at >= 0)
    .sort((a, b) => a.at - b.at || b.ann.originalText.length - a.ann.originalText.length);
  const out: ReactNode[] = [];
  let pos = 0, k = 0;
  for (const m of matches) {
    if (m.at < pos) continue;
    if (m.at > pos) out.push(text.slice(pos, m.at));
    out.push(<mark key={`${keyBase}-m${k++}`} className={`plan-mark ${m.ann.type.toLowerCase()}`} title={m.ann.text}>{text.slice(m.at, m.at + m.ann.originalText.length)}</mark>);
    pos = m.at + m.ann.originalText.length;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

function inline(text: string, anns: ReviewAnnotation[] = [], keyBase = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0, k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(...highlightedText(text.slice(last, m.index), anns, `${keyBase}-h${k++}`));
    const tok = m[0];
    if (tok.startsWith("`")) {
      nodes.push(<code key={`${keyBase}-c${k++}`} className="md-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={`${keyBase}-b${k++}`}>{tok.slice(2, -2)}</strong>);
    } else {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (lm) {
        const href = lm[2];
        const safe = /^(https?:|mailto:|\/|\.\/|#)/i.test(href) ? href : "#";
        nodes.push(<a key={`${keyBase}-a${k++}`} className="md-link" href={safe} target="_blank" rel="noopener noreferrer">{lm[1]}</a>);
      } else {
        nodes.push(tok);
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(...highlightedText(text.slice(last), anns, `${keyBase}-h${k++}`));
  return nodes;
}

function renderMarkdown(src: string, anns: ReviewAnnotation[] = []): ReactNode {
  const lines = (src || "").replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let list: ReactNode[] | null = null;
  let para: string[] = [];
  let code: string[] | null = null;
  let key = 0;

  const flushPara = () => {
    if (para.length) { out.push(<p key={`p${key++}`} className="md-p">{inline(para.join(" "), anns, `p${key}`)}</p>); para = []; }
  };
  const flushList = () => {
    if (list && list.length) { out.push(<ul key={`ul${key++}`} className="md-ul">{list}</ul>); }
    list = null;
  };

  let li = 0;
  for (const raw of lines) {
    const line = raw;
    if (/^\s*```/.test(line)) {
      if (code === null) { flushPara(); flushList(); code = []; }
      else { out.push(<pre key={`pre${key++}`} className="md-pre"><code>{code.join("\n")}</code></pre>); code = null; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushPara(); flushList();
      const level = heading[1].length;
      const content = inline(heading[2], anns, `h${key}`);
      out.push(level === 1 ? <h3 key={`h${key++}`} className="md-h1">{content}</h3> : level === 2 ? <h4 key={`h${key++}`} className="md-h2">{content}</h4> : <h5 key={`h${key++}`} className="md-h3">{content}</h5>);
      continue;
    }

    const check = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (check) {
      flushPara();
      const done = check[1].toLowerCase() === "x";
      list = list || [];
      list.push(<li key={`li${li++}`} className="md-task"><input type="checkbox" checked={done} disabled /><span className={done ? "md-task-done" : ""}>{inline(check[2], anns, `li${li}`)}</span></li>);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushPara();
      list = list || [];
      list.push(<li key={`li${li++}`} className="md-li">{inline(bullet[1], anns, `li${li}`)}</li>);
      continue;
    }

    if (!line.trim()) { flushPara(); flushList(); continue; }

    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  if (code !== null && code.length) out.push(<pre key={`pre${key++}`} className="md-pre"><code>{code.join("\n")}</code></pre>);
  return <div className="md">{out}</div>;
}

function VerdictPill(props: { verdict: PlanVerdict["verdict"]; label?: string }) {
  return <span className={`verdict-pill v-${props.verdict}`}>{props.label ?? props.verdict}</span>;
}
function PhaseBadge(props: { phase: string }) {
  return <span className={`phase-badge ${props.phase === "ready" ? "ready" : ""}`}>{props.phase}</span>;
}

export default function Plans(props: { search: string }) {
  const currentSession = useHive((s) => s.currentSession);
  const cwd = currentSession?.cwd;

  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [artifact, setArtifact] = useState<string>("");
  const [fileBody, setFileBody] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const [cFile, setCFile] = useState<string>("");
  const [cAnchor, setCAnchor] = useState<string>("");
  const [cBody, setCBody] = useState<string>("");
  const [reviewNote, setReviewNote] = useState("");
  const [selectedText, setSelectedText] = useState("");
  const [selectionBox, setSelectionBox] = useState<{ top: number; left: number } | null>(null);
  const [annType, setAnnType] = useState<ReviewAnnotation["type"]>("COMMENT");
  const [annText, setAnnText] = useState("");
  const [annotations, setAnnotations] = useState<ReviewAnnotation[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const artifactEl = useRef<HTMLDivElement | null>(null);
  // Monotonic token so that if the user clicks through plans/artifacts quickly,
  // a slow earlier response can't overwrite the state from a later selection.
  const loadToken = useRef(0);

  const loadPlans = useCallback(async () => {
    setLoading(true);
    const list = await fetchPlans(cwd);
    setPlans(list);
    setLoading(false);
    setSelected((sel) => (sel && !list.some((p) => p.changeId === sel)) ? "" : sel);
  }, [cwd]);

  const loadDetail = useCallback(async (changeId: string) => {
    const token = ++loadToken.current;
    const d = await fetchPlanDetail(changeId, cwd);
    if (token !== loadToken.current) return;
    setDetail(d);
    const arts = d?.artifacts || [];
    const first = arts.includes("proposal.md") ? "proposal.md" : arts[0] || "";
    setArtifact(first);
    if (first) {
      const body = await fetchPlanFile(changeId, first, cwd);
      if (token !== loadToken.current) return;
      setFileBody(body);
    } else setFileBody("");
  }, [cwd]);

  async function selectPlan(changeId: string) {
    setSelected(changeId);
    setCFile(""); setCAnchor(""); setCBody(""); setReviewNote("");
    await loadDetail(changeId);
  }

  async function openArtifact(name: string) {
    const token = ++loadToken.current;
    setArtifact(name);
    setSelectedText(""); setAnnText(""); setSelectionBox(null);
    const body = await fetchPlanFile(selected, name, cwd);
    if (token !== loadToken.current) return;
    setFileBody(body);
  }

  function captureSelection() {
    const sel = window.getSelection();
    const text = sel?.toString().trim() || "";
    if (!text || !artifactEl.current || !sel?.anchorNode || !sel?.focusNode || !artifactEl.current.contains(sel.anchorNode) || !artifactEl.current.contains(sel.focusNode)) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelectedText(text.replace(/\s+/g, " ").slice(0, 1200));
    setSelectionBox({ top: Math.max(12, rect.top - 10), left: rect.left + rect.width / 2 });
    setAnnType("COMMENT");
    setAnnText("");
  }

  function addAnnotation(type = annType) {
    const originalText = selectedText.trim();
    if (!originalText) return;
    const text = annText.trim();
    if (type === "COMMENT" && !text) return;
    setAnnotations((prev) => [...prev, { id: crypto.randomUUID(), artifact, type, originalText, text }]);
    setSelectedText(""); setAnnText(""); setSelectionBox(null);
    window.getSelection()?.removeAllRanges();
  }

  function closeSelectionTools() {
    setSelectedText(""); setAnnText(""); setSelectionBox(null);
    window.getSelection()?.removeAllRanges();
  }

  function removeAnnotation(id: string) { setAnnotations((prev) => prev.filter((a) => a.id !== id)); }

  async function submitComment() {
    if (!cBody.trim() || !selected) return;
    setSubmitting(true);
    const ok = await postPlanComment(selected, { file: cFile || undefined, anchor: cAnchor.trim() || undefined, body: cBody.trim() }, cwd);
    setSubmitting(false);
    if (ok) { setCBody(""); setCAnchor(""); await loadDetail(selected); }
  }

  async function approveGate(phase: string) {
    if (!selected) return;
    const summary = exportReviewFeedback();
    const ok = await postPlanApproval(selected, { phase, summary: summary || undefined }, cwd);
    if (ok) { setReviewNote(""); setAnnotations([]); await loadDetail(selected); await loadPlans(); }
  }

  function exportReviewFeedback(extra = reviewNote.trim()): string {
    const lines: string[] = [];
    if (extra) lines.push(`# General feedback\n\n${extra}`);
    if (annotations.length) {
      lines.push(`# Inline plan annotations`);
      for (const [idx, ann] of annotations.entries()) {
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

  async function sendReviewFeedback() {
    if (!selected) return;
    const general = reviewNote.trim();
    const anns = annotations;
    if (!general && !anns.length) return;
    setSubmitting(true);
    let ok = true;
    if (general) ok = await postPlanComment(selected, { body: general, author: "dashboard" }, cwd) && ok;
    for (const ann of anns) {
      ok = await postPlanComment(selected, {
        file: ann.artifact,
        author: "dashboard",
        body: ann.text || (ann.type === "DELETION" ? "Remove this section from the plan." : "Looks good."),
        annotationType: ann.type,
        originalText: ann.originalText,
      }, cwd) && ok;
    }
    setSubmitting(false);
    if (ok) { setReviewNote(""); setAnnotations([]); await loadDetail(selected); }
  }

  // Refetch the list whenever the scoped project cwd changes (and on mount).
  useEffect(() => { void loadPlans(); }, [loadPlans]);

  const filtered = useMemo<PlanSummary[]>(() => {
    const q = props.search.toLowerCase();
    return plans.filter((p) => !q || p.changeId.toLowerCase().includes(q) || (p.title || "").toLowerCase().includes(q));
  }, [plans, props.search]);

  const persistedAnnotations = useMemo<ReviewAnnotation[]>(() => (detail?.comments || [])
    .filter((c) => c.annotationType && c.originalText)
    .map((c) => ({
      id: c.id,
      artifact: c.file || "",
      type: c.annotationType as ReviewAnnotation["type"],
      originalText: c.originalText || "",
      text: c.body,
    })), [detail]);
  const artifactAnnotations = useMemo(() => [...persistedAnnotations, ...annotations].filter((ann) => ann.artifact === artifact), [persistedAnnotations, annotations, artifact]);

  const renderedBody = useMemo(() => renderMarkdown(fileBody, artifactAnnotations), [fileBody, artifactAnnotations]);

  return (
    <>
      <div className="plans-layout">
        <div className="plans-list tab-card">
          <div className="plans-list-head">
            <span>Plans</span>
            <button className="plans-refresh" title="Refresh" onClick={() => void loadPlans()}>⟳</button>
          </div>
          {(!loading || plans.length) ? (
            filtered.length ? filtered.map((p) => (
              <button type="button" key={p.changeId} className={`plan-row ${selected === p.changeId ? "active" : ""}`} aria-pressed={selected === p.changeId} onClick={() => void selectPlan(p.changeId)}>
                <div className="plan-row-main">
                  <span className="plan-title">{p.title || p.changeId}</span>
                  <span className="plan-id mono">{p.changeId}</span>
                </div>
                <div className="plan-row-meta">
                  <PhaseBadge phase={p.phase} />
                  {p.latestVerdict && <VerdictPill verdict={p.latestVerdict.verdict} />}
                </div>
              </button>
            )) : <div className="empty">No plans for this project yet.</div>
          ) : <div className="empty">Loading…</div>}
        </div>

        <div className="plans-detail">
          {!detail ? <div className="tab-card empty plans-empty">Select a plan to view its artifacts, verdicts, and comments.</div> : (
            <>
              <div className="tab-card plan-head">
                <div className="plan-head-title">
                  <h2>{detail.title || detail.changeId}</h2>
                  <span className="plan-id mono">{detail.changeId}</span>
                </div>
                <div className="plan-head-meta">
                  <PhaseBadge phase={detail.phase} />
                  {detail.status && <span className="meta-chip">status: {detail.status}</span>}
                  {detail.owner && <span className="meta-chip">owner: {detail.owner}</span>}
                </div>
                <div className="gate-track">
                  {detail.gates.map((g, i) => (
                    <div key={i} className={`gate ${g.present ? "on" : "off"}`}>
                      <span className="gate-mark">{g.present ? "●" : "○"}</span>
                      <span className="gate-name">{g.gate}</span>
                    </div>
                  ))}
                </div>
                <div className="review-box slim">
                  <div className="review-main">
                    <textarea placeholder="General feedback… or select text in the artifact below for inline feedback" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} rows={2} />
                    {annotations.length > 0 && (
                      <div className="annotation-list compact">
                        {annotations.map((ann) => (
                          <div key={ann.id} className="annotation-item">
                            <b>{ann.type === "DELETION" ? "Remove" : ann.type === "LOOKS_GOOD" ? "Looks good" : "Comment"}</b>
                            <span className="mono">{ann.artifact}</span>
                            <button onClick={() => removeAnnotation(ann.id)}>×</button>
                            <p>“{ann.originalText}”</p>
                            {ann.text && <small>{ann.text}</small>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="review-actions">
                    <button className="btn-submit" disabled={(!reviewNote.trim() && !annotations.length) || submitting} onClick={() => void sendReviewFeedback()}>{submitting ? "Sending…" : "Send feedback"}</button>
                    <button className="btn-approve" disabled={detail.phase === "ready"} onClick={() => void approveGate(detail.phase)}>Approve {detail.phase}</button>
                  </div>
                </div>
              </div>

              <div className="tab-card plan-artifacts">
                <div className="artifact-tabs">
                  {detail.artifacts.length ? detail.artifacts.map((name) => (
                    <button key={name} className={`artifact-tab ${artifact === name ? "active" : ""}`} onClick={() => void openArtifact(name)}>{name}</button>
                  )) : <span className="empty-inline">No artifacts written yet.</span>}
                </div>
                <div className="artifact-review-shell">
                  {artifact ? (
                    <div className="artifact-body" ref={artifactEl} onMouseUp={captureSelection}>{renderedBody}</div>
                  ) : <div className="empty">Nothing to display.</div>}
                  <aside className="artifact-rail">
                    <div className="rail-head">
                      <b>Annotations</b>
                      <span>{artifactAnnotations.length}</span>
                    </div>
                    {artifactAnnotations.length ? artifactAnnotations.map((ann) => (
                      <div key={ann.id} className={`rail-ann ${ann.type.toLowerCase()} ${annotations.some((a) => a.id === ann.id) ? "pending" : "saved"}`}>
                        <div className="rail-ann-top">
                          <b>{ann.type === "DELETION" ? "Remove" : ann.type === "LOOKS_GOOD" ? "Looks good" : "Comment"}</b>
                          {annotations.some((a) => a.id === ann.id) && <button onClick={() => removeAnnotation(ann.id)}>×</button>}
                        </div>
                        <blockquote>{ann.originalText}</blockquote>
                        {ann.text && <p>{ann.text}</p>}
                      </div>
                    )) : <div className="empty small">Select text to annotate this artifact.</div>}
                  </aside>
                </div>
              </div>

              <div className="plan-grid">
                <div className="tab-card timeline-card">
                  <h3 className="card-h">Verdicts</h3>
                  {detail.verdicts.length ? [...detail.verdicts].reverse().map((v: PlanVerdict) => (
                    <div key={v.id} className="timeline-item">
                      <div className="ti-head">
                        <VerdictPill verdict={v.verdict} />
                        <span className="ti-who">{v.reviewer}</span>
                        <span className="ti-time"><RelTime ts={v.createdAt} title={absTime(v.createdAt)} /></span>
                      </div>
                      {v.summary && <div className="ti-summary">{v.summary}</div>}
                      {v.blockers.length > 0 && <ul className="ti-list blockers">{v.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>}
                      {v.concerns.length > 0 && <ul className="ti-list concerns">{v.concerns.map((c, i) => <li key={i}>{c}</li>)}</ul>}
                      {v.evidence.length > 0 && <ul className="ti-list evidence">{v.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>}
                    </div>
                  )) : <div className="empty">No verdicts yet.</div>}
                </div>

                <div className="tab-card timeline-card">
                  <h3 className="card-h">Approvals</h3>
                  {detail.approvals.length ? [...detail.approvals].reverse().map((a: PlanApproval) => (
                    <div key={a.id} className="timeline-item">
                      <div className="ti-head">
                        <span className="approve-phase">{a.phase}</span>
                        <span className="ti-who">{a.approvedBy}{a.actor ? ` · ${a.actor}` : ""}</span>
                        <span className="ti-time"><RelTime ts={a.createdAt} title={absTime(a.createdAt)} /></span>
                      </div>
                      {a.summary && <div className="ti-summary">{a.summary}</div>}
                    </div>
                  )) : <div className="empty">No approvals yet.</div>}
                </div>
              </div>

              <div className="tab-card comments-card">
                <h3 className="card-h">Review log</h3>
                <div className="comment-form">
                  <div className="cf-row">
                    <select value={cFile} onChange={(e) => setCFile(e.target.value)}>
                      <option value="">(general)</option>
                      {detail.artifacts.map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                    <input type="text" placeholder="anchor (heading, optional)" value={cAnchor} onChange={(e) => setCAnchor(e.target.value)} />
                  </div>
                  <textarea placeholder="Add a comment…" value={cBody} onChange={(e) => setCBody(e.target.value)} rows={3} />
                  <div className="cf-actions">
                    <button className="btn-submit" disabled={!cBody.trim() || submitting} onClick={() => void submitComment()}>{submitting ? "Posting…" : "Comment"}</button>
                  </div>
                </div>
                {detail.comments.length ? [...detail.comments].reverse().map((c: PlanComment) => (
                  <div key={c.id} className="comment-item">
                    <div className="ci-head">
                      <span className="ci-who">{c.author || "anon"}</span>
                      {c.annotationType && <span className={`ann-kind ${(c.annotationType || "").toLowerCase()}`}>{c.annotationType === "DELETION" ? "Remove" : c.annotationType === "LOOKS_GOOD" ? "Looks good" : "Comment"}</span>}
                      {c.file && <span className="ci-target mono">{c.file}{c.anchor ? `#${c.anchor}` : ""}</span>}
                      <span className="ti-time"><RelTime ts={c.createdAt} title={absTime(c.createdAt)} /></span>
                    </div>
                    {c.originalText && <blockquote className="ci-quote">{c.originalText}</blockquote>}
                    <div className="ci-body">{c.body}</div>
                  </div>
                )) : <div className="empty">No comments yet.</div>}
              </div>
            </>
          )}
        </div>
      </div>
      {selectionBox && createPortal(
        <div className="selection-popover" style={{ top: `${selectionBox.top}px`, left: `${selectionBox.left}px` }} onMouseDown={(e) => e.preventDefault()}>
          {annType === "COMMENT" ? (
            <>
              <div className="selection-popover-actions">
                <button onClick={() => setAnnType("DELETION")}>Remove</button>
                <button onClick={() => setAnnType("LOOKS_GOOD")}>Looks good</button>
                <button onClick={closeSelectionTools}>×</button>
              </div>
              <textarea autoFocus placeholder="Feedback for this text…" value={annText} onChange={(e) => setAnnText(e.target.value)} rows={3} />
              <div className="selection-popover-actions end">
                <button className="btn-submit" disabled={!annText.trim()} onClick={() => addAnnotation("COMMENT")}>Add comment</button>
              </div>
            </>
          ) : (
            <div className="selection-popover-actions">
              <button onClick={() => addAnnotation(annType)}>{annType === "DELETION" ? "Remove selected text" : "Mark looks good"}</button>
              <button onClick={() => setAnnType("COMMENT")}>Comment instead</button>
              <button onClick={closeSelectionTools}>×</button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
