import { For, Show } from "solid-js";
import { scopedSessions, selectSessionScope, isLive, now } from "../store";
import { absTime, fmtCost, fmtNum, relTime, sessionSlug } from "../lib/format";
import "./cards.css";

// Project hero: cards for the sessions in the current project. Click drills in.
export default function SessionsCards() {
  return (
    <div class="cards-grid-scroll">
      <Show when={scopedSessions().length} fallback={<div class="empty">No sessions in this project.</div>}>
        <For each={scopedSessions()}>
          {(s) => (
            <div class="scard" onClick={() => selectSessionScope(s.session_id)}>
              <div class="scard-top">
                <span class={`scard-dot ${isLive(s.session_id) ? "live" : "idle"}`} />
                <span class="scard-id">{sessionSlug(s.session_id)}</span>
                <span class={`scard-tag ${isLive(s.session_id) ? "live" : "done"}`}>{isLive(s.session_id) ? "live" : "ended"}</span>
              </div>
              <div class="scard-time">{absTime(s.first_ts)} · updated {relTime(s.last_ts, now())}</div>
              <div class="scard-stats">
                <div><b>{s.running}</b><small>running</small></div>
                <div><b>{fmtNum(s.tokens)}</b><small>tokens</small></div>
                <div><b>{fmtCost(s.cost)}</b><small>cost</small></div>
                <div><b>{s.event_count}</b><small>events</small></div>
              </div>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
