import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  bootCwd, createReviewSession, fetchPlanDetail, fetchPlanFile, fetchPlans,
  type ArtifactReview, type ArtifactState, type PlanDetail, type PlanSummary,
} from "../api";
import { useHive } from "../store";
import RelTime from "../hooks/RelTime";

// The Plans tab is now a slim two-pane status view over OpenSpec changes. The
// actual review/annotation happens in the self-hosted Plannotator UI, rendered
// inline in an iframe on our own dashboard server. The dashboard first mints a
// short-lived, content-bound review capability; the nonce-bearing URL is then
// used by the vendored iframe without creating per-review processes.

const STATUS_LABEL: Record<string, string> = {
  "no-tasks": "no tasks",
  "in-progress": "in progress",
  complete: "complete",
};

function StatusBadge({ status }: { status: PlanSummary["status"] }) {
  return <span className={`plan-status plan-status-${status}`}>{STATUS_LABEL[status] || status}</span>;
}

function VerdictPill({ verdict }: { verdict: "red" | "yellow" | "green" }) {
  return <span className={`verdict-pill verdict-${verdict}`}>{verdict}</span>;
}

// Map an artifact to the markdown path the review UI should load. Single-file
// artifacts (proposal/design/tasks) are "<id>.md"; specs stays as OpenSpec's
// glob because the server expands it into a bounded combined review document.
function artifactFile(a: ArtifactState, _files: string[]): string {
  if (a.outputPath.includes("*")) return a.outputPath;
  return a.outputPath || `${a.id}.md`;
}
function ridFor(changeId: string, a: ArtifactState, files: string[]): string {
  return `${changeId}#${artifactFile(a, files)}`;
}
function artifactPathFromRid(rid: string): string {
  return rid.includes("#") ? rid.slice(rid.indexOf("#") + 1) : "proposal.md";
}

// A chip for an AUTHORED artifact (exists on disk). Two-stage review state:
// awaiting the reviewer AGENT, ready for the HUMAN, approved, or denied. Only
// authored artifacts are shown; unwritten ones surface as an "up next" hint,
// since OpenSpec "ready" means "cleared to author", not "ready to review".
function reviewState(r?: ArtifactReview): { label: string; cls: string } {
  if (!r) return { label: "", cls: "" };
  if (r.humanVerdict === "green") return { label: "approved", cls: "state-approved" };
  if (r.humanVerdict === "red") return { label: "changes requested", cls: "state-denied" };
  if (r.humanReviewReady) return { label: "review now", cls: "state-review" };
  if (r.authored && !r.agentCleared) return { label: "agent review", cls: "state-agent" };
  return { label: "", cls: "" };
}

function ArtifactChip({
  a, review, changeId, files, selectedRid, onSelect,
}: { a: ArtifactState; review?: ArtifactReview; changeId: string; files: string[]; selectedRid: string; onSelect: (rid: string) => void }) {
  const rid = ridFor(changeId, a, files);
  const st = reviewState(review);
  return (
    <button
      type="button"
      className={`plan-artifact ${st.cls} ${selectedRid === rid ? "active" : ""}`}
      aria-pressed={selectedRid === rid}
      title="Open in the review UI"
      onClick={() => onSelect(rid)}
    >
      <span className="plan-artifact-id" title={a.outputPath}>{a.displayLabel}</span>
      {st.label && <span className="plan-artifact-review">{st.label}</span>}
    </button>
  );
}

function inlineMarkdown(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${m.index}-${token}`;
    if (token.startsWith("`")) parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else {
      const close = token.indexOf("](");
      const label = token.slice(1, close);
      const href = token.slice(close + 2, -1);
      parts.push(<a key={key} href={href} target="_blank" rel="noreferrer">{label}</a>);
    }
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function MarkdownView({ markdown }: { markdown: string }) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let i = 0;
  const paragraph = (start: number) => {
    const acc: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|[-*]\s+|\d+\.\s+|>\s?|```|\|)/.test(lines[i].trim())) acc.push(lines[i++].trim());
    nodes.push(<p key={`p-${start}`}>{inlineMarkdown(acc.join(" "))}</p>);
  };
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const key = `${i}-${trimmed.slice(0, 12)}`;
    if (!trimmed) { i++; continue; }
    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      if (i < lines.length) i++;
      nodes.push(<pre key={key}><code data-lang={lang || undefined}>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const children = inlineMarkdown(heading[2]);
      nodes.push(level === 1 ? <h1 key={key}>{children}</h1> : level === 2 ? <h2 key={key}>{children}</h2> : <h3 key={key}>{children}</h3>);
      i++;
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(<li key={i}>{inlineMarkdown(lines[i].trim().replace(/^[-*]\s+/, ""))}</li>);
        i++;
      }
      nodes.push(<ul key={key}>{items}</ul>);
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(<li key={i}>{inlineMarkdown(lines[i].trim().replace(/^\d+\.\s+/, ""))}</li>);
        i++;
      }
      nodes.push(<ol key={key}>{items}</ol>);
      continue;
    }
    if (trimmed.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) quote.push(lines[i++].trim().replace(/^>\s?/, ""));
      nodes.push(<blockquote key={key}>{inlineMarkdown(quote.join(" "))}</blockquote>);
      continue;
    }
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        const cells = lines[i].trim().slice(1, -1).split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{3,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      nodes.push(<table key={key}><thead><tr>{(head || []).map((c, n) => <th key={n}>{inlineMarkdown(c)}</th>)}</tr></thead><tbody>{body.map((r, n) => <tr key={n}>{r.map((c, x) => <td key={x}>{inlineMarkdown(c)}</td>)}</tr>)}</tbody></table>);
      continue;
    }
    paragraph(i);
  }
  return <div className="plan-markdown">{nodes}</div>;
}

export default function Plans(props: { search: string }) {
  // The plan store is a per-project OpenSpec tree. Prefer the cwd of the session
  // in scope, but the dashboard is GLOBAL and its "current session" may belong to
  // an unrelated project (or there may be no session at all for a fresh OpenSpec
  // project). Fall back to the server's boot project cwd so the list is stable
  // and doesn't flash-then-vanish when a foreign session becomes "current".
  const scopeCwd = useHive((s) => {
    if (s.scope.level === "session") return s.currentSession?.cwd;
    if (s.scope.level === "project") return s.scopedSessions.find((x) => x.cwd)?.cwd;
    return undefined; // fleet scope: don't pin to an arbitrary project's session
  });
  const [fallbackCwd, setFallbackCwd] = useState<string | undefined>(undefined);
  useEffect(() => { void bootCwd().then((c) => setFallbackCwd(c || undefined)); }, []);
  const cwd = scopeCwd || fallbackCwd;

  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [rid, setRid] = useState<string>("");
  const [fullscreen, setFullscreen] = useState(false);
  const [readOnlyMarkdown, setReadOnlyMarkdown] = useState<string | null>(null);
  const [reviewSession, setReviewSession] = useState<{ rid: string; url: string } | null>(null);
  const [reviewSessionPending, setReviewSessionPending] = useState(false);
  const [reviewSessionFailed, setReviewSessionFailed] = useState(false);

  // Esc exits the fullscreen review.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const loadPlans = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    const list = await fetchPlans(cwd);
    setPlans(list);
    setLoading(false);
  }, [cwd]);

  const selectPlan = useCallback(async (changeId: string) => {
    setSelected(changeId);
    setDetail(null);
    const d = await fetchPlanDetail(changeId, cwd);
    setDetail(d);
    // Default the review to the first authored artifact, else the proposal.
    const files = d?.files || [];
    const firstDone = d?.artifacts.find((a) => a.status === "done");
    setRid(firstDone ? ridFor(changeId, firstDone, files) : `${changeId}#proposal.md`);
  }, [cwd]);

  useEffect(() => { void loadPlans(); }, [loadPlans]);

  const filtered = useMemo(() => {
    const q = props.search.toLowerCase();
    return plans.filter((p) => !q || p.changeId.toLowerCase().includes(q));
  }, [plans, props.search]);

  const selectedArtifact = useMemo(() => (detail?.artifacts || []).find((a) => ridFor(detail!.changeId, a, detail!.files) === rid), [detail, rid]);
  const selectedReview = useMemo(() => detail?.artifactReview.find((r) => r.id === selectedArtifact?.id), [detail, selectedArtifact]);
  // A red human verdict is not final: it means feedback was requested and the
  // same artifact should become reviewable again after the planner revises it.
  // Only green locks the artifact into read-only mode.
  const reviewFinal = selectedReview?.humanVerdict === "green";
  const artifactPath = artifactPathFromRid(rid);
  const reviewSrc = reviewSession?.rid === rid ? reviewSession.url : "";

  useEffect(() => {
    let cancelled = false;
    setReviewSession(null);
    setReviewSessionFailed(false);
    if (!rid || !cwd || !selectedArtifact || reviewFinal) { setReviewSessionPending(false); return; }
    setReviewSessionPending(true);
    void createReviewSession(rid, cwd).then((session) => {
      if (cancelled) return;
      setReviewSessionPending(false);
      if (session) setReviewSession({ rid, url: session.reviewUrl });
      else setReviewSessionFailed(true);
    });
    return () => { cancelled = true; };
  }, [cwd, reviewFinal, rid, selectedArtifact?.id]);

  useEffect(() => {
    let cancelled = false;
    setReadOnlyMarkdown(null);
    if (!detail || !rid || !cwd || !reviewFinal) return;
    void fetchPlanFile(detail.changeId, artifactPath, cwd).then((file) => {
      if (!cancelled) setReadOnlyMarkdown(file.content ?? "_Unable to load reviewed artifact._");
    });
    return () => { cancelled = true; };
  }, [artifactPath, cwd, detail, reviewFinal, rid]);

  // The embedded review UI cannot notify this React tree after approve/deny
  // because it is a vendored iframe. Poll while the selected artifact is awaiting
  // human approval, then swap to read-only markdown only once it is approved.
  // A red verdict stays reviewable so the revision loop can reopen Plannotator.
  useEffect(() => {
    if (!detail || !selectedReview?.humanReviewReady || selectedReview.humanVerdict === "green" || !selected) return;
    const timer = window.setInterval(() => {
      void fetchPlanDetail(selected, cwd).then((d) => { if (d) setDetail(d); });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [cwd, detail, selected, selectedReview]);

  // Only AUTHORED artifacts (on disk) are reviewable; the single next unwritten
  // one is surfaced as an "up next" hint. OpenSpec's "specs" delta is what makes
  // a change validatable, so before it's authored we show "in progress" instead
  // of a red validation error (a fresh change failing validation is expected).
  const authored = useMemo(() => (detail?.artifacts || []).filter((a) => a.status === "done"), [detail]);
  const upNext = useMemo(() => (detail?.artifacts || []).find((a) => a.status === "ready"), [detail]);
  const specsAuthored = useMemo(() => authored.some((a) => a.id === "specs"), [authored]);

  return (
    <div className="plans-layout">
      <div className="plans-list tab-card">
        <div className="plans-list-head">
          <span>OpenSpec changes</span>
          <button className="plans-refresh" title="Refresh" onClick={() => void loadPlans()}>⟳</button>
        </div>
        {(!loading || plans.length) ? (
          filtered.length ? filtered.map((p) => (
            <button
              type="button"
              key={p.changeId}
              className={`plan-row ${selected === p.changeId ? "active" : ""}`}
              aria-pressed={selected === p.changeId}
              onClick={() => void selectPlan(p.changeId)}
            >
              <div className="plan-row-main">
                <span className="plan-title mono">{p.changeId}</span>
                {p.totalTasks > 0 && <span className="plan-tasks">{p.completedTasks}/{p.totalTasks} tasks</span>}
              </div>
              <div className="plan-row-meta">
                <StatusBadge status={p.status} />
                {p.latestVerdict && <VerdictPill verdict={p.latestVerdict.verdict} />}
                {p.lastModified && <RelTime ts={p.lastModified} />}
              </div>
            </button>
          )) : <div className="empty">No OpenSpec changes for this project yet.</div>
        ) : <div className="empty">Loading…</div>}
      </div>

      <div className="plans-detail">
        {!detail ? (
          <div className="tab-card empty plans-empty">Select a change to review its artifacts.</div>
        ) : (
          <>
            <div className="tab-card plan-head">
              <div className="plan-head-title">
                <span className="mono">{detail.changeId}</span>
                {/* Validation only reads as an ERROR once specs exist (a change
                    is expected to fail validation until its spec deltas are
                    authored — before that it's simply in progress). */}
                {specsAuthored ? (
                  <span className={`plan-validation ${detail.validation.passed ? "ok" : "fail"}`}>
                    {detail.validation.passed ? "✓ valid" : `✗ ${detail.validation.failed} validation issue(s)`}
                  </span>
                ) : (
                  <span className="plan-validation progress">in progress</span>
                )}
                {detail.readyToExecute && <span className="plan-ready">ready to execute</span>}
                {detail.taskProgress.length > 0 && (
                  <span className="plan-tasks">
                    {detail.taskProgress.filter((task) => task.completed).length}/{detail.taskProgress.length} execution tasks recorded
                  </span>
                )}
              </div>
              <div className="plan-artifacts">
                {authored.length ? authored.map((a) => (
                  <ArtifactChip key={a.id} a={a} review={detail.artifactReview.find((r) => r.id === a.id)} changeId={detail.changeId} files={detail.files} selectedRid={rid} onSelect={setRid} />
                )) : <span className="plan-artifact-none">No artifacts authored yet.</span>}
                {upNext && <span className="plan-artifact-next">up next: {upNext.displayLabel}</span>}
              </div>
              {/* Surface real validation issues only once specs are authored. */}
              {specsAuthored && !detail.validation.passed && detail.validation.issues.length > 0 && (
                <ul className="plan-issues">
                  {detail.validation.issues.slice(0, 5).map((iss, i) => (
                    <li key={i} className={`plan-issue plan-issue-${iss.level.toLowerCase()}`}>{iss.message}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className={`tab-card plan-review-frame ${fullscreen ? "fullscreen" : ""}`}>
              {reviewSrc || reviewFinal ? (
                <>
                  <div className="plan-review-bar">
                    <div className="plan-review-title">
                      <span className="plan-review-rid mono">{artifactPath}</span>
                      {selectedReview?.humanVerdict && (
                        <span className={`plan-review-final verdict-${selectedReview.humanVerdict}`}>
                          {selectedReview.humanVerdict === "green" ? "approved" : "changes requested"}
                        </span>
                      )}
                    </div>
                    <div className="plan-review-actions">
                      {!reviewFinal && <a className="plan-review-btn" href={reviewSrc} target="_blank" rel="noreferrer" title="Open in a new tab">↗ New tab</a>}
                      <button type="button" className="plan-review-btn" title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"} onClick={() => setFullscreen((v) => !v)}>
                        {fullscreen ? "✕ Close" : "⤢ Fullscreen"}
                      </button>
                    </div>
                  </div>
                  {reviewFinal ? (
                    <div className="plan-review-readonly">
                      {readOnlyMarkdown === null ? <div className="empty">Loading reviewed artifact…</div> : <MarkdownView markdown={readOnlyMarkdown} />}
                    </div>
                  ) : (
                    <iframe
                      key={reviewSrc}
                      title="Plan review"
                      src={reviewSrc}
                      className="plan-review-iframe"
                    />
                  )}
                </>
              ) : reviewSessionPending ? (
                <div className="empty">Creating secure review session…</div>
              ) : reviewSessionFailed ? (
                <div className="empty">Secure review session unavailable. Refresh and try again.</div>
              ) : <div className="empty">Select an authored artifact to review.</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
