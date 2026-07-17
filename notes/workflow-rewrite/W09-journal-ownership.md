# W09 — Build Journal, Checkpoint, and Runtime-ownership Foundations

Status: **Not started**  
Depends on: W08  
Blocks: W10

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Create the authoritative project-local event journal, atomic checkpoints, hash-chain replay, and single-runtime workflow-session ownership primitives used by every later runtime subsystem. SQLite/dashboard remains a projection and must not become authority.

## Design authority

- Design Sections 13.8, 14.1, 14.6–14.8, 17, 25.3, 25.7, and deferred physical-format/lease questions
- Project state under `.pi/hive/sessions/`; global registry/database under `~/.pi/agent/hive/`

## Current touchpoints to inspect

- `src/engine/state.ts`, `src/engine/session.ts`
- `src/core/file-lock.ts`, `src/core/fs.ts`
- current telemetry JSONL writers/readers and project identity helpers
- session lifecycle, JSONL ingestion, daemon lifecycle, and file-lock tests

## Required journal contract

- Append-only, versioned event envelope with event ID, project/session/run IDs as applicable, monotonic sequence, previous hash, payload hash, timestamp, producer, and correlation/attempt IDs.
- One authoritative workflow-session journal; periodic atomic validated checkpoints store last applied sequence/hash.
- Restore loads latest valid checkpoint and replays the tail; sequence gap/hash mismatch/corruption fails closed with bounded diagnostics.
- Runtime state transitions are journal-first where required; no in-memory-only authority.
- One Pi process owns workflow execution at a time via heartbeat lock.
- Stale takeover requires bounded expiry plus owner-death verification; never steal a fresh lock.
- Dashboard may append authenticated bounded control events under short journal-write lock but never owns runtime/model execution.
- Core implementation is Node-compatible and independent of Bun/SQLite.

## Target modules

- `src/workflows/events.ts`
- `src/workflows/journal.ts`
- `src/workflows/checkpoints.ts`
- `src/workflows/ownership.ts`
- `src/workflows/replay.ts`

## Implementation plan

1. Resolve physical event/checkpoint/lock formats and timings in `IMPLEMENTATION_DECISIONS.md`; include schema/version migration policy.
2. Define typed event union extensible for sessions, runs, input, tasks, attempts, questions, approvals, artifacts, handoffs, knowledge jobs, and terminal outcomes without importing those implementations.
3. Implement atomic append with process-safe short lock, fsync/rename policy appropriate to platform, bounded event size, and strict serialization.
4. Implement checkpoint creation/validation and fallback to prior valid checkpoint after incomplete write.
5. Implement replay reducer interface with unknown-event-version failure, sequence/hash verification, and deterministic state.
6. Implement runtime owner lock with owner identity, PID/process marker, heartbeat, boot/session nonce, timestamps, and conservative death verification.
7. Separate long runtime ownership from short append locks so offline dashboard control can append safely.
8. Add orphan-preserving behavior: missing Pi session never deletes journal.
9. Add inspection/doctor summaries that never dump full payloads by default.
10. Provide fault-injection seams around append, flush, rename, checkpoint, heartbeat, and takeover.

## Required tests

- Deterministic replay from zero, checkpoint, and checkpoint+tail.
- Partial/truncated/duplicate/out-of-order/hash-corrupt/unknown-version events fail safely.
- Crash at every append/checkpoint stage leaves either old or new valid state.
- Two processes cannot own one workflow session; fresh lock rejects; verified dead stale owner may recover.
- Dashboard-style short append does not acquire runtime ownership and survives contention.
- Missing Pi session marks orphan without journal deletion.
- Event/payload/diagnostic bounds and redaction-safe summaries.
- Node compatibility tests; no Bun import reaches these modules.

## Out of scope

- Linked Pi session creation (W10).
- Concrete run/task/question/artifact reducers beyond event placeholders.
- SQLite projection (W24).
- Dashboard control authentication (W25).

## Verification

- Targeted journal/replay/lock/fault tests
- Cross-process tests
- `just typecheck-core`
- `just test`
- `just test-node-compat`
- `just verify`

## Completion checklist

- [ ] Journal/checkpoint is authoritative and crash-replayable.
- [ ] Runtime ownership is exclusive with conservative stale recovery.
- [ ] Short control-event append is separate from model runtime ownership.
- [ ] Missing/corrupt state is preserved for recovery, not silently deleted.
- [ ] Core path has no Bun/SQLite dependency.

## Handoff

Record event/checkpoint/lock formats, timing constants, replay reducer API, ownership lifecycle, fault-injection hooks, and compatibility rules W10–W25 must use.
