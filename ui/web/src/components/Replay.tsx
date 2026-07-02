import { useMemo } from "react";
import { useHive } from "../store";
import { enterReplay, exitReplay, seekReplay, playReplay, pauseReplay, setReplaySpeed } from "../store/replay";
import { buildEventStatus } from "../store/status";
import { bundleEvents } from "../lib/activity";
import { seriesTotals } from "../lib/series";
import { fmtCost, fmtNum } from "../lib/format";
import { statusKey } from "../lib/agents";

// Session replay panel (Phase F). Scrubs a session's full event history and
// re-derives agent status / feed / totals at any point, reusing the same pure
// functions the live view uses (buildEventStatus, bundleEvents, seriesTotals).
export default function Replay({ sessionId }: { sessionId: string }) {
  const replay = useHive((s) => s.replay);
  const active = replay.active && replay.sessionId === sessionId;

  if (!active) {
    return (
      <div className="flex items-center gap-2">
        <button className="rounded-lg border border-line bg-well px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-panel" onClick={() => void enterReplay(sessionId)}>
          ▶ Replay session
        </button>
      </div>
    );
  }

  return <ReplayActive />;
}

function ReplayActive() {
  const replay = useHive((s) => s.replay);
  const { events, cursor, loading, loadedCount, playing, speed, truncatedStart, historyStartsAt } = replay;

  const slice = useMemo(() => events.slice(0, cursor + 1), [events, cursor]);
  const statusBySession = useMemo(() => buildEventStatus(slice), [slice]);
  const feed = useMemo(() => bundleEvents(slice).slice(0, 30), [slice]);
  const totals = useMemo(() => seriesTotals(slice), [slice]);

  const cur = events[cursor];
  const curTs = cur ? new Date(cur.ts) : null;
  const agentStatuses = useMemo(() => {
    const m = new Map<string, string>();
    for (const perSession of statusBySession.values()) for (const [name, st] of perSession) m.set(name, st);
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [statusBySession]);

  if (loading) {
    return (
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="flex items-center justify-between">
          <b className="text-[13px]">Loading replay…</b>
          <button className="text-ink-dim text-[12px] hover:text-ink" onClick={exitReplay}>✕ close</button>
        </div>
        <div className="text-ink-dim text-[12px] mt-2">{fmtNum(loadedCount)} events loaded</div>
      </div>
    );
  }

  if (!events.length) {
    return (
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="flex items-center justify-between">
          <b className="text-[13px]">No events to replay</b>
          <button className="text-ink-dim text-[12px] hover:text-ink" onClick={exitReplay}>✕ close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-panel p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <b className="text-[13px]">Replay · event {cursor + 1} / {events.length}</b>
        <button className="text-ink-dim text-[12px] hover:text-ink" onClick={exitReplay}>✕ exit replay</button>
      </div>

      {truncatedStart && (
        <div className="text-[11px] text-wait bg-well rounded-md px-2 py-1">
          History starts at {historyStartsAt ? new Date(historyStartsAt).toLocaleString() : "an unknown point"} — earlier events were pruned.
        </div>
      )}

      {/* Transport controls */}
      <div className="flex items-center gap-3">
        <button className="rounded-md border border-line bg-well px-3 py-1 text-[13px] font-mono" onClick={() => (playing ? pauseReplay() : playReplay())}>
          {playing ? "❚❚" : "▶"}
        </button>
        <div className="flex items-center gap-1">
          {([1, 10, 60] as const).map((sp) => (
            <button key={sp} className={`rounded-md px-2 py-1 text-[11px] font-mono ${speed === sp ? "bg-brand text-white" : "bg-well text-ink-dim"}`} onClick={() => setReplaySpeed(sp)}>
              {sp}×
            </button>
          ))}
        </div>
        <span className="font-mono text-[11px] text-ink-dim ml-auto tabular-nums">{curTs ? curTs.toLocaleTimeString() : "—"}</span>
      </div>

      {/* Scrubber, indexed by event, labeled by wall-clock ts */}
      <input
        type="range"
        min={0}
        max={events.length - 1}
        value={cursor}
        onChange={(e) => seekReplay(Number(e.target.value))}
        className="w-full accent-[var(--brand)]"
        aria-label="Replay position"
      />

      {/* Re-derived totals at this cursor */}
      <div className="flex gap-4 text-[12px] text-ink-dim font-mono">
        <span>tokens <b className="text-ink">{fmtNum(totals.tok)}</b></span>
        <span>cache <b className="text-ink">{fmtNum(totals.cacheRead + totals.cacheWrite)}</b></span>
        <span>cost <b className="text-ink">{fmtCost(totals.cost)}</b></span>
      </div>

      {/* Replayed agent statuses */}
      {agentStatuses.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {agentStatuses.map(([name, st]) => (
            <span key={name} className="flex items-center gap-1.5 text-[11px] text-ink-dim bg-well rounded-full pl-1.5 pr-2.5 py-1">
              <i className={`w-[7px] h-[7px] rounded-full block g-dot ${statusKey(st)}`} style={{ background: `var(--${statusKey(st) === "running" ? "run" : statusKey(st) === "done" ? "done" : statusKey(st) === "error" ? "crit" : statusKey(st) === "waiting" ? "wait" : "ink-dimmer"})` }} />
              {name}
            </span>
          ))}
        </div>
      )}

      {/* Replayed feed up to the cursor */}
      <div className="max-h-[220px] overflow-y-auto flex flex-col gap-1 border-t border-line pt-2">
        {feed.map((item) => (
          <div key={item.id} className="flex items-center gap-2 text-[11px] font-mono text-ink-dim">
            <span className="text-ink-dimmer tabular-nums">{new Date(item.ts).toLocaleTimeString()}</span>
            <span className="text-ink">{item.type}</span>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              {item.kind === "tool" ? (item.start?.payload?.toolName || item.end?.payload?.toolName || "")
                : item.kind === "thinking" ? item.agent
                : (item.event?.payload?.to || item.event?.payload?.agent || item.event?.actor || "")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
