import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bootCwd, fetchPlanDetail, fetchPlans,
  type ArtifactState, type PlanDetail, type PlanSummary,
} from "../api";
import { useHive } from "../store";
import RelTime from "../hooks/RelTime";

// The Plans tab is now a slim two-pane status view over OpenSpec changes. The
// actual review/annotation happens in the self-hosted Plannotator UI, rendered
// inline in an iframe on our own dashboard server at /pl-review/?rid=<change#artifact>.
// Navigating between changes/artifacts just re-renders the iframe — zero
// per-review processes.

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

// Map an artifact + the change's real file list to the concrete markdown file
// the review UI should load. Single-file artifacts (proposal/design/tasks) are
// "<id>.md"; specs is a glob, so pick the first actual spec .md under specs/.
function artifactFile(a: ArtifactState, files: string[]): string {
  if (a.outputPath.includes("*")) {
    return files.find((f) => f.startsWith("specs/") && f.endsWith(".md")) || a.outputPath;
  }
  return a.outputPath || `${a.id}.md`;
}
function ridFor(changeId: string, a: ArtifactState, files: string[]): string {
  return `${changeId}#${artifactFile(a, files)}`;
}

// A chip for an AUTHORED artifact (exists on disk). Only authored artifacts are
// shown + clickable; unwritten ones (OpenSpec "ready"/"blocked") are surfaced as
// a separate "up next" hint, since "ready" there means "cleared to author", not
// "ready to review".
function ArtifactChip({
  a, changeId, files, selectedRid, onSelect,
}: { a: ArtifactState; changeId: string; files: string[]; selectedRid: string; onSelect: (rid: string) => void }) {
  const rid = ridFor(changeId, a, files);
  return (
    <button
      type="button"
      className={`plan-artifact ${selectedRid === rid ? "active" : ""}`}
      aria-pressed={selectedRid === rid}
      title="Open in the review UI"
      onClick={() => onSelect(rid)}
    >
      <span className="plan-artifact-id mono">{a.id}</span>
    </button>
  );
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

  const reviewSrc = rid ? `/pl-review/?rid=${encodeURIComponent(rid)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}` : "";

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
              </div>
              <div className="plan-artifacts">
                {authored.length ? authored.map((a) => (
                  <ArtifactChip key={a.id} a={a} changeId={detail.changeId} files={detail.files} selectedRid={rid} onSelect={setRid} />
                )) : <span className="plan-artifact-none">No artifacts authored yet.</span>}
                {upNext && <span className="plan-artifact-next">up next: {upNext.id}</span>}
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
              {reviewSrc ? (
                <>
                  <div className="plan-review-bar">
                    <span className="plan-review-rid mono">{rid.split("#")[1]}</span>
                    <div className="plan-review-actions">
                      <a className="plan-review-btn" href={reviewSrc} target="_blank" rel="noreferrer" title="Open in a new tab">↗ New tab</a>
                      <button type="button" className="plan-review-btn" title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"} onClick={() => setFullscreen((v) => !v)}>
                        {fullscreen ? "✕ Close" : "⤢ Fullscreen"}
                      </button>
                    </div>
                  </div>
                  <iframe
                    key={rid}
                    title="Plan review"
                    src={reviewSrc}
                    className="plan-review-iframe"
                  />
                </>
              ) : <div className="empty">Select an authored artifact to review.</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
