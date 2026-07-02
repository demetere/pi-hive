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

// Recent provider back-pressure (Phase 4.11): `provider_response` is emitted only
// for non-2xx responses (429/529 rate-limit/overload). Surface a count of those
// seen in the last few minutes so a stalled fleet has a visible cause. Silent
// when there's no recent pressure.
const PRESSURE_WINDOW_MS = 5 * 60_000;
function ProviderPressure() {
  const events = useHive((s) => s.allEvents);
  const now = useHive((s) => s.now);
  const recent = events.filter(
    (e) => e.type === "provider_response" && (now || Date.now()) - new Date(e.ts).getTime() < PRESSURE_WINDOW_MS,
  );
  if (!recent.length) return null;
  const last = recent[recent.length - 1];
  const status = last?.payload?.status;
  return (
    <span
      className="flex items-center gap-[6px] text-[11px] font-semibold tracking-[.05em] text-crit"
      title={`${recent.length} provider rate-limit/overload response${recent.length === 1 ? "" : "s"} in the last 5 min (latest ${status ?? "?"})`}
    >
      <span className="w-2 h-2 rounded-full bg-crit animate-softblink-fast" />
      {recent.length}× {status ?? "429/529"}
    </span>
  );
}

export default function Topbar() {
  const liveCount = useHive((s) => s.scopedStats.live);
  const isLive = liveCount > 0;

  return (
    <header className="flex items-center gap-5 h-[52px] shrink-0 px-0.5">
      <div className="ml-auto flex items-center gap-3">
        <ProviderPressure />
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
