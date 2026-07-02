import { useHive } from "../store";
import { hhmmss } from "../lib/agents";

// The live wall clock. Reads the store's 1s `now` tick — no second timer.
function Clock() {
  const now = useHive((s) => s.now);
  return (
    <span className="font-mono text-[19px] font-medium tracking-[.02em] text-ink tabular-nums">
      {hhmmss(now || Date.now())}
    </span>
  );
}

export default function Topbar() {
  const liveCount = useHive((s) => s.scopedStats.live);
  const isLive = liveCount > 0;

  return (
    <header className="flex items-center gap-5 h-[52px] shrink-0 px-0.5">
      <div className="ml-auto flex items-center gap-3">
        {isLive && (
          <span className="flex items-center gap-[7px] text-[11px] font-semibold tracking-[.1em] text-run">
            <span
              className="w-2 h-2 rounded-full bg-run animate-softblink-fast"
              style={{ boxShadow: "0 0 0 3px color-mix(in srgb, var(--run) 22%, transparent)" }}
            />
            LIVE
          </span>
        )}
        <Clock />
      </div>
    </header>
  );
}
