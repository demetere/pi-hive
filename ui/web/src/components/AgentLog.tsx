import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useHive } from "../store";
import { closeAgent } from "../store/raw";
import { shortModel } from "../lib/format";
import { useFocusTrap } from "../hooks/useFocusTrap";

interface Part { type: "text" | "thinking" | "toolCall" | "toolResult"; text?: string; name?: string; args?: any; result?: string | null; resultError?: boolean; }
interface Entry { kind: "message" | "meta"; role?: string; parts?: Part[]; text?: string; ts?: string; }
interface Invoc { task: string; entries: Entry[] }
interface RunRef { id: string; label: string; }
const MAX_TRANSCRIPT_ENTRIES = 2000;

function splitInvocations(entries: Entry[]): Invoc[] {
  const invs: Invoc[] = [];
  let cur: Invoc | null = null;
  let pending: Entry[] = [];
  const firstTextOf = (e: Entry) => e.parts?.find((p) => p.type === "text")?.text || "";
  for (const e of entries) {
    if (e.kind === "message" && e.role === "user") {
      cur = { task: firstTextOf(e), entries: [...pending, e] };
      pending = [];
      invs.push(cur);
    } else if (!cur) {
      pending.push(e);
    } else {
      cur.entries.push(e);
    }
  }
  if (!invs.length && pending.length) invs.push({ task: "", entries: pending });
  return invs;
}

export default function AgentLog() {
  const openAgent = useHive((s) => s.openAgent);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [exists, setExists] = useState(true);
  const [runs, setRuns] = useState<RunRef[]>([]);
  const [selectedRun, setSelectedRun] = useState("current");
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [bulk, setBulk] = useState<{ open: boolean; n: number }>({ open: false, n: 0 });

  const invocations = useMemo(() => splitInvocations(entries), [entries]);
  const trapRef = useFocusTrap<HTMLDivElement>(!!openAgent);
  const offset = useRef(0);
  const startOffset = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const scroller = useRef<HTMLDivElement | null>(null);
  const selectedRunRef = useRef(selectedRun);
  selectedRunRef.current = selectedRun;

  const poll = useCallback(async (initial: boolean, before?: number) => {
    const a = openAgent;
    if (!a) return;
    // Don't hit the network for a background tab's live tail; the visibility
    // handler re-polls once when the tab comes back to the foreground.
    if (!initial && typeof document !== "undefined" && document.visibilityState === "hidden") return;
    try {
      setLoadError("");
      const run = selectedRunRef.current;
      const paging = before != null ? `&before=${before}` : `&offset=${offset.current}`;
      const url = `/agent-log?session=${encodeURIComponent(a.sessionId)}&agent=${encodeURIComponent(a.name)}&run=${encodeURIComponent(run)}${paging}`;
      const res = await fetch(url);
      const data = await res.json();
      setStatus(data.status || "");
      setExists(!!data.exists);
      if (Array.isArray(data.runs)) setRuns(data.runs);
      if (before == null && data.offset != null) offset.current = data.offset;
      if ((initial || before != null) && data.startOffset != null) startOffset.current = data.startOffset;
      if (initial || before != null) setHasOlder(!!data.hasMoreBefore);
      if (data.entries?.length) {
        const el = scroller.current;
        const atBottom = el ? el.scrollTop + el.clientHeight >= el.scrollHeight - 60 : true;
        setEntries((prev) => {
          if (initial) return data.entries.slice(-MAX_TRANSCRIPT_ENTRIES);
          if (before != null) {
            const combined = [...data.entries, ...prev];
            if (combined.length >= MAX_TRANSCRIPT_ENTRIES) setHasOlder(false);
            return combined.slice(0, MAX_TRANSCRIPT_ENTRIES);
          }
          return [...prev, ...data.entries].slice(-MAX_TRANSCRIPT_ENTRIES);
        });
        if (before == null && atBottom) queueMicrotask(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));
      }
      const shouldTail = data.running && selectedRunRef.current === "current";
      if (shouldTail && !timer.current) timer.current = setInterval(() => poll(false), 1500);
      if (!shouldTail && timer.current) { clearInterval(timer.current); timer.current = undefined; }
    } catch (error: any) {
      setLoadError(error?.message || "Unable to load this transcript.");
    }
    setLoading(false);
  }, [openAgent]);

  async function loadOlder() {
    if (loadingOlder || !hasOlder || startOffset.current <= 0) return;
    setLoadingOlder(true);
    await poll(false, startOffset.current);
    setLoadingOlder(false);
  }

  function loadRun(runId: string) {
    if (timer.current) { clearInterval(timer.current); timer.current = undefined; }
    setSelectedRun(runId);
    selectedRunRef.current = runId;
    offset.current = 0; startOffset.current = 0; setEntries([]); setHasOlder(false); setLoading(true);
    poll(true);
  }

  // (re)load when the target agent changes
  useEffect(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = undefined; }
    offset.current = 0; startOffset.current = 0; setEntries([]); setHasOlder(false); setLoading(true); setLoadError(""); setExists(true); setRuns([]); setSelectedRun("current");
    selectedRunRef.current = "current";
    if (openAgent) poll(true);
    return () => { if (timer.current) { clearInterval(timer.current); timer.current = undefined; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAgent]);

  useEffect(() => {
    if (!openAgent) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") closeAgent(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openAgent]);

  // When the tab returns to the foreground, immediately catch up on any live
  // tail that was skipped while hidden.
  useEffect(() => {
    if (!openAgent) return;
    function onVisible() {
      if (document.visibilityState === "visible" && status === "running" && selectedRunRef.current === "current") poll(false);
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [openAgent, status, poll]);

  if (!openAgent) return null;
  const a = openAgent;

  return createPortal(
    <div className="modal-backdrop" onClick={closeAgent}>
      <div ref={trapRef} className="modal-panel log-panel" role="dialog" aria-modal="true" aria-label={`${a.name} transcript`} onClick={(e) => e.stopPropagation()}>
        <div className="w-head log-head">
          <span className="log-dot" style={{ background: a.color || "var(--accent)" }} />
          <span className="w-title">{a.name}</span>
          <span className={`status-tag ${status || a.status || "idle"}`}>{status || a.status || "idle"}</span>
          {a.model && <span className="log-model">{shortModel(a.model)}</span>}
          {status === "running" && <span className="log-live"><span className="w-2 h-2 rounded-full bg-ok animate-ping2" /> live</span>}
          <span className="w-tools">
            <button type="button" className="log-bulk" onClick={() => setBulk((b) => ({ open: true, n: b.n + 1 }))} title="Expand all results">Expand all</button>
            <button type="button" className="log-bulk" onClick={() => setBulk((b) => ({ open: false, n: b.n + 1 }))} title="Collapse all results">Collapse all</button>
            <button type="button" onClick={closeAgent} aria-label="Close transcript" title="Close">✕</button>
          </span>
        </div>
        {runs.length > 1 && (
          <div className="log-runs" role="tablist" aria-label="Transcript runs">
            <span className="log-runs-label">Runs:</span>
            {runs.map((r) => (
              <button type="button" role="tab" aria-selected={selectedRun === r.id} key={r.id} className={`log-run-tab ${selectedRun === r.id ? "active" : ""}`} onClick={() => loadRun(r.id)}>{r.label}</button>
            ))}
          </div>
        )}
        <div className="log-body" ref={scroller}>
          {!loading && hasOlder && (
            <button type="button" className="log-bulk block mx-auto my-2" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? "Loading…" : "Load older transcript"}
            </button>
          )}
          {loading ? <div className="empty">Loading transcript…</div>
            : loadError ? <div className="empty" role="alert">{loadError} <button type="button" className="btn pill" onClick={() => { setLoading(true); void poll(true); }}>Retry</button></div>
            : !exists ? <div className="empty">No transcript for this agent yet{status === "idle" ? " — it hasn't run." : "."}</div>
            : (<>
                {invocations.map((inv, i) => <Invocation key={i} inv={inv} index={i} total={invocations.length} bulk={bulk} />)}
                {!entries.length && <div className="empty">Transcript is empty.</div>}
              </>)}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Invocation(props: { inv: Invoc; index: number; total: number; bulk: { open: boolean; n: number } }) {
  const isLatest = props.index === props.total - 1;
  const [open, setOpen] = useState(props.total === 1 || isLatest);
  const taskPreview = props.inv.task ? props.inv.task.replace(/\s+/g, " ").slice(0, 90) : "(no task text)";
  return (
    <div className={`log-inv ${open ? "open" : ""}`}>
      <button type="button" className="log-inv-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="log-inv-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="log-inv-num">{props.index === 0 ? "Invocation 1" : `↻ Invocation ${props.index + 1}`}</span>
        <span className="log-inv-task">{taskPreview}</span>
        <span className="log-inv-count">{props.inv.entries.length} msg{props.inv.entries.length === 1 ? "" : "s"}</span>
      </button>
      {open && (
        <div className="log-inv-body">
          {props.inv.entries.map((e, i) => <LogEntry key={i} entry={e} bulk={props.bulk} />)}
        </div>
      )}
    </div>
  );
}

function LogEntry(props: { entry: Entry; bulk: { open: boolean; n: number } }) {
  const e = props.entry;
  if (e.kind === "meta") return <div className="log-meta">{e.text}</div>;
  return (
    <div className={`log-msg ${e.role}`}>
      <div className="log-role">{e.role}</div>
      <div className="log-parts">
        {e.parts?.map((p, i) => <LogPart key={i} part={p} bulk={props.bulk} />)}
      </div>
    </div>
  );
}

function LogPart(props: { part: Part; bulk: { open: boolean; n: number } }) {
  const p = props.part;
  if (p.type === "text") return <div className="log-text">{p.text}</div>;
  if (p.type === "thinking") return <div className="log-thinking">💭 {p.text}</div>;
  if (p.type === "toolResult") {
    return <ToolCard name={p.name || "result"} result={p.result ?? p.text ?? ""} resultError={p.resultError} bulk={props.bulk} />;
  }
  return <ToolCard name={p.name || "tool"} args={p.args} result={p.result ?? undefined} resultError={p.resultError} bulk={props.bulk} />;
}

function ToolCard(props: { name: string; args?: any; result?: string; resultError?: boolean; bulk: { open: boolean; n: number } }) {
  const [open, setOpen] = useState(false);
  const lastBulk = useRef(props.bulk.n);
  useEffect(() => {
    if (props.bulk.n !== lastBulk.current) { lastBulk.current = props.bulk.n; setOpen(props.bulk.open); }
  }, [props.bulk]);
  const hasResult = props.result !== undefined && props.result !== null && props.result !== "";
  return (
    <div className={`log-tool ${props.resultError ? "err" : ""}`}>
      <button type="button" className="log-tool-head" disabled={!hasResult} aria-expanded={hasResult ? open : undefined} onClick={() => hasResult && setOpen(!open)}>
        <span className="tool-ic" aria-hidden="true">{props.resultError ? "✗" : "⚙"}</span>
        <b>{props.name}</b>
        {hasResult ? <span className="tool-toggle">{open ? "hide result −" : "show result +"}</span>
          : <span className="tool-toggle dim">no result</span>}
      </button>
      {props.args && Object.keys(props.args).length > 0 && (
        <pre className="log-tool-args">{JSON.stringify(props.args, null, 2)}</pre>
      )}
      {open && hasResult && <pre className="log-tool-body">{props.result}</pre>}
    </div>
  );
}
