# W11 — Implement Chat/Run State, Finish, Pause, and Cancellation

Status: **Not started**  
Depends on: W10  
Blocks: W12

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Implement one-open-run-per-workflow-session semantics: idle chat starts a run, later messages steer it, terminal state requires a validated finish or user/harness action, navigation pauses safely, and cancellation preserves partial effects without false rollback claims.

## Design authority

- Design Sections 4.3, 10.5, 13.7–13.8, and 14.1–14.8
- Completion request/envelope and status-specific finish guards are normative

## Current touchpoints to inspect

- `src/engine/state.ts`, `src/engine/session.ts`, `src/engine/dispatch.ts`
- `src/integration/hooks.ts`, `src/integration/commands.ts`
- worker cleanup/process cancellation code
- session lifecycle, command integration, runtime event, and activation tests

## Required state model

`running`, `waiting_for_human`, and `paused` are open/resumable. `completed`, `blocked`, `failed`, and `cancelled` are immutable terminal outcomes. A workflow session has zero or one open run.

State transitions must be explicit journal events and reducer-validated. Invalid transitions fail without partial state mutation.

## Required chat semantics

- Selection alone creates no run.
- First ordinary user message while idle atomically creates the run and records initial input.
- Every later ordinary message before terminal state is sequenced steering for that run, never a second run.
- Steering arriving during model/tool activity is persisted immediately and delivered at next safe root turn.
- `workflow_finish` blocks until every input has been included in a root model input; there is no manual discard acknowledgement.
- Slash commands are control operations, not model messages unless their contract records a reason.
- Assistant prose alone never closes a run.

## Completion contract

- Root submits only status (`completed|blocked|failed`), summary, artifact refs, evidence refs, and bounded JSON `data`.
- Harness derives IDs/timestamps/file changes/coverage/root identity/event hash.
- `workflow_finish` is root-only and the sole call in its tool batch.
- All statuses require settled workers, delivered input, no cancellation, verified claimed refs, safe final project/workspace state.
- `completed` additionally requires no pending questions, adapter success requirements, enabled approvals, and valid lease.
- `blocked|failed` may close pending questions/incomplete gates only with reason/evidence and must record them unsatisfied.
- `cancelled` is user/harness-only.

## Implementation plan

1. Define typed run/input/terminal events and pure reducer transitions on W09 journal.
2. Add input sequence/delivery records tied to root model requests.
3. Implement run creation at the integration hook boundary with idempotent handling of duplicate callback delivery.
4. Define completion validator pipeline with subsystem hooks for descendants, questions, adapters, approvals, evidence, change accounting, and leases. Unimplemented later subsystems return neutral/not-present, never fake satisfaction.
5. Persist terminal envelope/marker before rendering bounded terminal result. No unrecorded post-terminal model turn.
6. Implement two-phase cancellation: request/reject new work/abort owned work; bounded settle/kill; record partial hashes/evidence; release leases; terminal event.
7. Implement pause on workflow switch, exit, native new/resume, and shutdown. Persist before switching and release ownership/leases.
8. Block fork/clone/tree in workflow sessions because external state cannot rewind.
9. On resume, reacquire ownership and revalidate recorded hashes before execution.
10. Preserve old runtime until W27; new lifecycle tests use schema-v1 fixtures/services.

## Required tests

- State-transition table including every invalid transition and terminal immutability.
- First/steering/next-after-terminal chat behavior and duplicate input callbacks.
- Finish sole-call/root-only restrictions and pending-input race.
- Status-specific completion gates: completed strict, blocked/failed evidence-based closure.
- Cancellation at idle model, active model, queued tool, process tree, and partial mutation boundaries.
- Navigation/shutdown pause persists before switch and resumes after hash/owner checks.
- Terminal result equals persisted envelope and is bounded.
- Crash/replay at run creation/input delivery/finish/cancel phases.

## Out of scope

- Worker task scheduler (W12).
- Real adapter/question/approval validators (W16–W21).
- Budget/retry/change ledger (W13), except hook interfaces.
- Final public command/TUI registration (W26).

## Verification

- Targeted run/state/cancellation/navigation tests
- `just typecheck-core`
- `just test`
- `just verify`

## Completion checklist

- [ ] One-open-run and deterministic input delivery are journal-enforced.
- [ ] Terminal statuses and finish guards match the design exactly.
- [ ] Cancellation/pause preserve partial state and never claim rollback.
- [ ] Native navigation cannot rewind external workflow authority.
- [ ] Restart/replay produces the same run state.

## Handoff

Record event/reducer types, integration hook ordering, completion-validator interface, terminal envelope schema, cancellation settlement constants, and W12/W13 subsystem hooks.
