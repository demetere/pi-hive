# pi-hive: Observability Overhaul — Closeout Spec (bugs, unfinished items, test debt)

> **Status:** SHIPPED. All four phases (I–L) plus the pre-phase index-ordering fix landed on `feat/observability-overhaul` across `272903e..e44c9eb`, each gated on `just ci` green (130 tests) and, for Phase K, `just build-dashboard` with committed `ui/web/dist/`. The new server endpoints (`/prune`, `/topologies`, `/models`, `/events?before=`, method-based write auth) were smoke-tested end-to-end. The sections below are the delivered spec, retained as the record of what was built.
>
> **Audience:** originally an engineer/agent implementing this fresh. Facts below were verified against HEAD (`c773e4a` + dist rebuilds) on 2026-07-02; line numbers are as-of that commit and have since moved.
>
> **Pre-phase fix (done):** `272903e` moved the three `idx_plan_*_cwd` index creations *after* the ALTER TABLE cwd migrations (on a legacy DB the index would otherwise fail with "no such column: cwd").
>
> **Out of scope (unchanged):** the plan-management execution loop (`plan_execute` action, poller per-line error handling, `plan.yaml` two-writer race, approval double-insert). Separate spec.

---

## 1. What shipped and holds (do not redo)

Verified at HEAD — extend, don't rebuild:

- **Telemetry truth (A):** double-count gone; `getSessionStats()` overwrites counters post-prompt with try/catch fallback (`src/engine/dispatch.ts:298-313`); cache tokens end-to-end; stopReason/errorMessage/models in `delegation_end`; bounded tool args/results + `durationMs` on worker tool events; real delegation parent via ALS (`dispatch.ts:58,330-335`); orchestrator usage + tool events; `worker_retry`/`worker_compaction`/`model_catalog` live.
- **SQLite as source of truth (B):** in-memory window/`MAX_EVENTS`/dedup-scan/re-sort deleted; cursor-paginated `/events` (rowid) + SSE `id:`; `ingest_sources` byte offsets, per-batch transactions; typed `delegations`/`tool_calls`/`messages`; authoritative `sessions` (sum-not-max, `event_count + 1` arithmetic); cwd-scoped plan reads with NULL-wildcard.
- **Topology versioning (C):** canonical SHA-256 hash (`src/observability/server/topology-hash.ts`), `topology_versions` + exploded `topology_nodes`, boot backfill from legacy embedded snapshots, slim snapshots + read-time rehydration, `GET /topologies`, `/topologies/:hash`, `/models`; content-versioned `model_versions` table.
- **Write auth (D):** per-daemon token (0600 file + env), constant-time Bearer check on POST/DELETE, same-origin kept, `/bootstrap.json` serves it to the SPA, `api.ts` attaches it.
- **UI (E/F):** lossless cursor resync; single aggregation source (`ui/web/src/lib/series.ts`); honest 60-min rate chart; cache-token KPI; topology-driven team map; Agents tab reachable; synthetic root as non-interactive header; SDK-driven thinking dial (off = zero bars); session replay panel with scrubber/speeds, pure derivations over `events[0..cursor]`, isolated store slice, replay-equals-live guardrail test.
- **Policy/hygiene (G/H):** mutator + commit-parse bypasses closed and mostly tested; `spec` before `tasks` classification; orchestrator fallback in `enforceDomainForTool`; `approve_plan` rejects worker callers; `allowedAgents` warn-and-derive; routing/prompts de-hardcoded; config-failure tool restore.

**Accepted deviations — final, do not "fix":**
1. `models` table became content-versioned `model_versions` keyed by `model_hash` (richer than spec; latest-per-model view at `db.ts:807-819`).
2. `allowedAgents` remains on `AgentConfig` as a documented derived-only internal field (not user-settable) rather than deleted.
3. `/states` serves the SQL-rehydrated snapshot cache rather than per-request queries — nothing exists only in memory, invariant holds.
4. Chart/KPI aggregation stays **client-side but unified** in `lib/series.ts` over raw `delegation_end` events; the `/delegations` and `/tool-calls` endpoints remain as API surface (and get their bugs fixed in I1) but are not force-fed into the UI.
5. G1's interpreter-limit prompt note is emitted only for coder/tester workers; the accepted-risk section in AGENTS.md/CLAUDE.md covers the rest.

---

## 2. Audit findings this spec fixes (grounding)

**Bugs:**
- `queryDelegations` accepts `after` but never applies it in SQL (`src/observability/server/db.ts:570-575`) — `/delegations?after=` silently returns from row 0. `queryToolCalls` (`db.ts:588`) is the correct template.
- `upsertTopologyVersion` (`db.ts:673-688`) runs the version insert + per-node explosion as separate autocommit statements, and its `wasNew` early-return means a crash mid-explode leaves a **permanently** partial `topology_nodes` tree for that hash.
- `ModelMix.tsx:55` — `data` memo omits `actualModelByAgent` from its dependency array → stale model segments until `scopedAgents` changes.
- Replay's pruned-history marker compares fetched count against the **client-derived windowed** count (`ui/web/src/store/replay.ts:28`, from `store/derive.ts:38,46`) instead of the server's `sessions.event_count`; the UI never calls `GET /sessions` (`server/index.ts:167`), so the marker is dead logic. `fetchSessionEvents` also drops `delegation_progress` (`api.ts:84`), skewing any count comparison.

**Missing spec items:**
- `pruneOlderThan` (`db.ts:615-636`) has **zero callers** — no endpoint, no Settings action, no `/hive-observe-prune` command. Decision 11's "explicit cleanup" doesn't exist.
- Plan-table cwd **backfill** never written — legacy `plan_*` rows rely permanently on the NULL-wildcard read (`db.ts:962-966`) that was scoped to one release.
- `model_catalog` is not re-emitted on `model_select` (only emitter call: `src/ui/tui/widget.ts:98`); a mid-session main-model switch leaves `inherit` workers on an undescribed model.
- First run per agent: `delegation_start` is emitted (`dispatch.ts:105-118`) before the session exists (`:159`), so `thinkingLevels` is `undefined` until run 2 (comment admits it at `:113-115`).
- `orchestrator_tool_end` lacks `durationMs` (`src/integration/hooks.ts:39-48` — no start-time map); orchestrator usage accumulation (`hooks.ts:115-125`) never triggers a snapshot write, so `hive-state.json` is stale in delegation-free conversations.
- TOK/S still divides lifetime tokens by per-run `elapsedMs` (`ui/web/src/lib/agents.ts:121-125`, used at `TopologyGraph.tsx:295`; `dispatch.ts:100` resets elapsed per run) — the exact bug called out twice now.
- Write failures silent: helpers collapse to booleans (`api.ts:95-111,133-138,180-192`); `Plans.tsx:237-247`, `ConfirmModal.tsx:15-19`, `Settings.tsx:44-48` ignore failures; no toast/banner exists.
- C6 UI: no topology-version chip/divider in Sessions; no client fetchers for `/topologies`/`/models`; dial's unknown-model fallback is an invented full 6-level ladder (`agents.ts:54-61`) instead of a `/models` lookup or plain text.
- Truncation affordances: source slices without flags (`hooks.ts:130` — 8000-char message cap); thinking feed silently polls only 6 sessions (`wiring.ts:14`); no UI affordance anywhere.
- Leftover heuristics: literal `participants.has("Orchestrator")` at `tabs/Activity.tsx:163,167`; `LiveActivity.tsx:78` reads `p.retry` on `error` events but retries arrive as `worker_retry` events with `attempt`/`maxAttempts` — the branch is dead.
- Replay is a standalone side panel (`components/Replay.tsx`, mounted in `Overview.tsx:80-84`); the main TopologyGraph/feed/chart stay live during replay and the versioned topology hash is unused by the client.
- E1: reconnect flips `connection:"live"` before the async gap-fetch completes (`wiring.ts:103-105`); no older-page on-demand loading in live mode.
- D nits: only POST/DELETE are auth-gated (`index.ts:55,84`) — a future PUT/PATCH endpoint would land outside the gate; `readDaemonToken` (`src/engine/dashboard.ts:30-32`) is a dead export.

**Test debt:**
- The "double-count regression test" (`tests/usage.test.ts:41-78`) re-implements the arithmetic on a plain object — it never drives `dispatchAgent` and cannot catch a real regression.
- Topology round-trip test (`tests/topology-c.spec.ts:55-74`) explodes but never reassembles via `topologyDetail` (`runtime.ts:435-471` untested) nor deep-equals canonical JSON; the "key ordering" test never permutes keys.
- Untested: backtick commit-substitution bypass (`domain.ts:170`); worker-caller `approve_plan` rejection (`tools.ts:302-307`); custom-lead-name routing prompt (`buildOrchestratorPrompt` has no test at all); cursor stability across DB reopen; pathless-mutating-bash fail-safe (`domain.ts:294-302`).

---

## 3. Decisions (settled)

1. **Replay takes over the Overview.** When replay is active, TopologyGraph statuses, the activity feed, and the chart render from the replay slice (banner: "Replaying <session> — <ts>"), using the session's versioned topology fetched by hash. The current side panel becomes the transport controls. This was the original product intent ("replay buttons to see how everything went").
2. **Prune goes through the daemon.** One auth-gated `POST /prune {olderThanDays}` endpoint; the Settings tab calls it; `/hive-observe-prune <days>` (session command) calls it over HTTP using `readDaemonToken()` — which makes that dead export live instead of deleting it.
3. **Auth gates by method, not by route list**: any request with method ≠ GET/HEAD requires the Bearer token, once, before routing. Closes the future-PUT hole for free.
4. **TOK/S = per-run rate.** Dispatch records run-start token baselines when it resets `elapsedMs`; the UI divides the delta by elapsed. No "lifetime average" fallback.
5. **First-run `thinkingLevels`: reorder, don't patch.** Create the worker session (cheap, no prompt yet) before emitting `delegation_start`, capture `getAvailableThinkingLevels()` + effective model, then emit. Delete the "second run onward" comment.
6. **Unknown-model dial = plain text.** Fetch `/models` once into the store; dial uses node sidecar → models lookup → plain-text chosen level. The invented 6-level fallback ladder is deleted.
7. **Error surfacing = one small toast component**, fed by api helpers returning `{ok, status, error}`. No per-tab bespoke error UI.
8. **`worker_retry` gets rendered; `p.retry` on `error` dies.** LiveActivity/Activity map `worker_retry` to a feed row ("retry 2/5 — <errorMessage>"); the dead `p.retry` read is removed.

---

## Phase I — Bug fixes

- **I1** `/delegations?after=`: apply the cursor in `queryDelegations` (`db.ts:570-575`) exactly as `queryToolCalls` does; extend `tests/storage-b.spec.ts` with an `after`-cursor assertion for both endpoints.
- **I2** Transactional topology explosion: wrap version-insert + node-explosion in one `db.transaction` inside `upsertTopologyVersion` (`db.ts:673-688`). Add self-healing: when the version row already exists, verify `COUNT(*)` of its nodes matches the canonical node count and re-explode (`INSERT OR IGNORE`) on mismatch — heals any tree left partial by a pre-fix crash. Test: simulate partial state (insert version row, delete half the nodes, re-ingest, assert full tree).
- **I3** `ModelMix.tsx:55`: add `actualModelByAgent` to the memo dependency array.
- **I4** Replay pruned-marker: add `fetchSessionSummaries()` to `api.ts` (`GET /sessions`); `store/replay.ts` compares fetched-event count against the server's `event_count` for that session, counting `delegation_progress`-skips out (or stop filtering them in `fetchSessionEvents` and filter at render). Marker text gains the first fetched event's timestamp ("history starts at …").

**Acceptance:** paginating `/delegations` twice with a cursor returns disjoint pages; kill -9 mid-ingest cannot produce a partial node tree that survives re-ingest (test); ModelMix updates when a model switches with an unchanged agent set; artificially pruning a test DB makes the replay marker appear with a timestamp. `just ci` green.

## Phase J — Server/telemetry completion

- **J1** Prune wiring (Decision 2): `POST /prune {olderThanDays}` in `server/index.ts` (auth-gated) → `pruneOlderThan`; Settings tab gains a "Prune history…" action with confirm + result count; `/hive-observe-prune <days>` command in `src/integration/commands.ts` calls the endpoint with `readDaemonToken()`. Prune must also delete the corresponding `delegations`/`tool_calls`/`messages` projections (extend `pruneOlderThan` if it doesn't already).
- **J2** Plan-table cwd backfill: boot migration — for `plan_*` rows with NULL cwd whose `session_id` matches a `sessions` row, copy that session's cwd. Keep NULL-wildcard reads for rows that remain unmatched (plans created outside sessions).
- **J3** `model_catalog` on model switch: subscribe `pi.on("model_select")` in `src/integration/hooks.ts` (gated off in normal mode) → `emitModelCatalog(...)`. DB upsert is already idempotent.
- **J4** First-run `thinkingLevels` (Decision 5): in `dispatchAgent`, create the `AgentSession` before emitting `delegation_start`; stamp `runtime.thinkingLevels` + effective model; emit with both populated; remove the run-2 comment (`dispatch.ts:113-115`).
- **J5** Orchestrator parity finish: `toolCallId → startedAt` map in `hooks.ts` so `orchestrator_tool_end` carries `durationMs` (same bounded shape as workers); after orchestrator usage accumulation (`hooks.ts:115-125`), trigger a debounced (≥2s) `writeHiveStateSnapshot` so orchestrator-only conversations reach `hive-state.json`.
- **J6** Truncation flags at source: everywhere a payload is sliced (`hooks.ts:130` message text; `dispatch.ts` output/args/result truncations), set `truncated: true` alongside when clipping occurred. Thread `truncated` through the `messages` projection (column exists, `db.ts:148`) and event payloads.
- **J7** Method-based auth gate (Decision 3): replace the per-route POST/DELETE checks in `server/index.ts:55,84` with one early `method !== "GET" && method !== "HEAD"` gate; keep same-origin checks.
- **J8** TOK/S baselines (Decision 4, server half): in `dispatch.ts`, when resetting `elapsedMs` at delegation start (`:100`), also record `runtime.runStartInputTokens/runStartOutputTokens`; include both in `TelemetryAgentRuntime` + snapshots.

**Acceptance:** prune works from Settings and the command, and shrinks all projections; a legacy DB gets cwd backfilled on first boot (test with synthetic rows); switching the main model mid-session emits a catalog covering the new model; a fresh agent's first `delegation_start` carries `thinkingLevels`; `orchestrator_tool_end.durationMs` present; PUT to any path → 401 without token. `just ci` green.

## Phase K — UI completion (requires `just build-dashboard`)

- **K1** Toast + error propagation (Decision 7): api helpers return `{ok, status, error}`; one `Toast` component; wire `Plans.tsx` (comment/approve), `Settings.tsx` (override save, prune), `ConfirmModal.tsx` consumers (session/project delete). Every mutating flow shows success/failure.
- **K2** Topology versions surfaced: `api.ts` fetchers for `GET /topologies?cwd` and `/topologies/:hash` with a hash-keyed store cache; Sessions tab shows a "topology vN" chip (rank of `first_seen_at` within the cwd) and a "topology changed" divider between adjacent sessions with different hashes; clicking the chip opens the versioned tree (reuse TopologyGraph in a modal, statuses off).
- **K3** Dial fallback via `/models` (Decision 6): fetch once into the store; `thinkScale` resolution order = node sidecar → models lookup by effective model → plain-text chosen level; delete the invented 6-level fallback (`agents.ts:54-61`).
- **K4** TOK/S per-run (Decision 4, UI half): `tokPerSec((input+output) − (runStartInput+runStartOutput), elapsedMs)` from J8's baselines (`lib/agents.ts:121-125`, `TopologyGraph.tsx:295`).
- **K5** Replay drives the Overview (Decision 1): when `replay.active`, TopologyGraph statuses/feed/chart consume the replay slice (`buildEventStatus`/`bundleEvents`/`series` over `events[0..cursor]` — already pure); versioned topology fetched via K2's cache using the session's `topologyHash` (from I4's `/sessions` fetch); persistent banner with session + cursor timestamp; SSE continues updating the live slice untouched underneath.
- **K6** Heuristic/dead-branch cleanup (Decision 8): replace `participants.has("Orchestrator")` (`Activity.tsx:163,167`) with a role lookup from the topology map; render `worker_retry` in LiveActivity/Activity ("retry N/M — msg"); delete the `p.retry` read on `error` events (`LiveActivity.tsx:78`); render `truncated` affordance ("… truncated") on message/tool rows using J6's flags; thinking-feed cap note ("showing first 6 sessions") at fleet scope (`wiring.ts:14` unchanged).
- **K7** E1 finish: hold `connection: "syncing"` until `resyncAfterReconnect` resolves, then flip to `"live"` (`wiring.ts:97-136`); add a "load older" affordance to the Activity feed that pages `/events?before=`-equivalent (fetch with `after` from an older anchor — if the API only supports forward paging, add `until=<cursor>` or fetch descending pages server-side; smallest correct variant wins, but no unbounded fetch).

**Acceptance:** failed comment POST (daemon stopped) shows a toast, not silence; Sessions shows v1/v2 chips after a config edit and the chip opens the old tree; unknown model renders plain text, no ladder; TOK/S for a re-run agent matches (run tokens ÷ run seconds) hand-computed from events; entering replay visibly rewinds the main topology/feed/chart and exiting restores live; retry events visible in the feed. `just build-dashboard` + `just ci` green.

## Phase L — Test fidelity

- **L1** Real double-count regression: a scripted fake `AgentSession` (subscribable, emits final `message_end` then `agent_end`, `getSessionStats()` stub) driven through `dispatchAgent`; assert delegation totals equal stats exactly and that re-adding usage on `agent_end` would fail the test. Refactor `dispatchAgent`'s session-construction seam if needed for injection (`dispatch.ts:159` — a `createSession` param defaulting to the real factory is enough).
- **L2** Topology round-trip: explode → `topologyDetail` reassemble → deep-equal against canonical JSON (nodes, adjacency, sidecars); plus a genuine key-permutation invariance test (same data, shuffled key insertion order → same hash).
- **L3** Policy: backtick command-substitution commit test (`` `git commit -m x` ``); `approve_plan` under `runAsAgent("<worker lead>")` → rejected; pathless mutating bash (`rm -rf *`) → blocked.
- **L4** Routing prompt: `buildOrchestratorPrompt` with custom lead names (no "Engineering Lead"/"Planning Lead") asserts the mandatory-routing block names the actual configured leads and nothing hardcoded.
- **L5** Cursor stability across restarts: write events, close the `Database`, reopen the same file, assert `/events?after=` cursors continue monotonically and pagination returns no duplicates/holes.

**Acceptance:** all new tests fail if their target regression is reintroduced (spot-verify L1 and L2 by temporarily reverting the fix locally — do not commit the revert); `just ci` green.

---

## 4. Cross-cutting requirements

- Commit the pre-existing `db.ts` index-ordering fix first (see header). Conventional Commits; one commit per phase-section where coherent; no attribution trailers.
- Every phase: `just ci`. K additionally: `just build-dashboard`, commit `ui/web/dist/`.
- Schema/migration changes stay idempotent (double-boot test pattern from `tests/storage-b.spec.ts`).
- No new dependencies; Bun-only code stays under `src/observability/server/`; bounded payloads for anything new entering events.
- Line numbers cited are as-of 2026-07-02 at `c773e4a` — re-verify before editing.

## 5. Order & sizing

| Phase | Size | Depends on |
|---|---|---|
| I — bug fixes | S | — |
| J — server/telemetry completion | M | — (J8 before K4) |
| K — UI completion | L | I4 (sessions fetch), J6 (flags), J8 (baselines), K2 before K5 |
| L — test fidelity | M | I2 (heal path exists) |

I and J can interleave; L1–L4 can start any time after I; the critical path is J8 → K4 and I4/K2 → K5.
