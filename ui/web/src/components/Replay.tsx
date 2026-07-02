import { useHive } from "../store";
import { enterReplay, exitReplay, seekReplay, playReplay, pauseReplay, setReplaySpeed } from "../store/replay";

// Session replay transport (Phase F / K5). When active it drives the Overview's
// topology, activity feed, and chart from the replay slice (that wiring lives in
// Overview); this component is only the controls: enter/exit, play/pause, speed,
// and the scrubber. The replay store slice is separate from live state, so SSE
// keeps updating the live view underneath.
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

  return <ReplayControls />;
}

function ReplayControls() {
  const replay = useHive((s) => s.replay);
  const { events, cursor, loading, loadedCount, playing, speed, truncatedStart, historyStartsAt } = replay;

  if (loading) {
    return (
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="flex items-center justify-between">
          <b className="text-[13px]">Loading replay…</b>
          <button className="text-ink-dim text-[12px] hover:text-ink" onClick={exitReplay}>✕ close</button>
        </div>
        <div className="text-ink-dim text-[12px] mt-2">{loadedCount} events loaded</div>
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

  const cur = events[cursor];
  const curTs = cur ? new Date(cur.ts) : null;

  return (
    <div className="rounded-xl border border-line bg-panel p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <b className="text-[13px]">Replay transport · event {cursor + 1} / {events.length}</b>
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
    </div>
  );
}
