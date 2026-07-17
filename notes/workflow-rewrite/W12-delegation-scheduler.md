# W12 — Implement Delegation Tasks, Scheduler, and Worker Transcripts

Status: **Not started**  
Depends on: W11  
Blocks: W13

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Replace mode/type-driven dispatch with durable direct-member delegation tasks, deterministic advisory routing, fair concurrency scheduling, per-node/per-run worker transcripts, recursive team delegation, and bounded worker result envelopes.

## Design authority

- Design Sections 4.5, 4.10, 9.5, 14.4, and 14.9
- Authority graph is exactly the recursive team; runtime addressing is node ID, not reusable agent ID

## Current touchpoints to inspect

- `src/engine/dispatch.ts`, `src/engine/routing.ts`, `src/engine/worker-extension.ts`
- `src/engine/governance.ts`, `src/engine/session.ts`, `src/engine/state.ts`
- `src/engine/agent-lookup.ts`, `src/agents/tools.ts`
- dispatch usage, worker extension, routing, governance, session cleanup tests

## Required task contract

A persisted delegation contains task ID, parent/target node IDs, objective, context refs, deliverables, creation sequence/provenance, queue state, attempt/result refs, and terminal worker status (`completed|blocked|failed|cancelled`).

- Caller may target direct members only.
- `route_agent` is deterministic local advisory ranking only: capability filter, token match over role/responsibilities/consult-when/description/tags/objective, stable node-ID tie, reasons; no model/network/dispatch.
- `delegate_agent` persists then immediately returns accepted/queued task ID. No in-memory blocking promise.
- One node executes one task at a time; additional tasks FIFO.
- Different node IDs may execute concurrently even when they reuse one agent identity.
- Parent suspended on descendants yields its slot; durable result event makes it resumable.
- Workers may delegate to their direct members under the same rule.
- Root/parent transcript is not copied. Explicit task prose/authorized refs are the context boundary.
- Structured refs are re-authorized for recipient; unauthorized content remains opaque/denied.
- Parent receives bounded result/refs, not full transcript.

## Target modules

- `src/workflows/delegation.ts`
- `src/workflows/scheduler.ts`
- `src/workflows/workers.ts`
- `src/workflows/routing.ts`
- ref authorization service shared with artifact/knowledge/file subsystems

## Implementation plan

1. Add task/queue/worker events and reducers to W09/W11 state.
2. Implement direct-member authorization from immutable activation team node.
3. Implement route ranking exactly and test stable reasons/order.
4. Implement scheduler with per-node FIFO and fair sibling selection. Define fairness algorithm in decisions file.
5. A concurrency slot represents a worker node with active model/tool batch. Queued and dependency-suspended nodes do not occupy slots; root and curation are excluded.
6. Create/resume a linked worker Pi session/transcript per node/run, with immutable task boundaries; sequential tasks reuse it only in that run.
7. Worker task completion persists bounded result before parent resume. Worker cannot call `workflow_finish`.
8. Handle worker/process/model failure as task result; root/parent chooses new task/revision/run terminal status.
9. Integrate cancellation/pause/shutdown with queue rejection, worker abort, transcript preservation, and no leaked sessions/listeners/timers.
10. Add status query pagination/summary for finish guards/dashboard.

## Required tests

- Direct-member allow and sibling/deeper/unknown-node denial.
- Repeated agent ID under distinct node IDs has independent queue/transcript/budgets.
- FIFO per node, stable fair sibling scheduling, max-parallel 1 nested delegation without deadlock.
- Parent yields/resumes from durable child result across process restart.
- Route ranking deterministic, capability filtered, no semantic-name bonus.
- Structured ref authorization for recipient and explicit no-DLP prose limitation.
- Worker terminal result bounds and inability to finish run.
- Cancellation/failure cleanup leaves no active run/session/timer/listener.
- Journal replay reconstructs queue, active/suspended tasks, and delivered results.

## Out of scope

- Actual budget counters/retries (W13), though scheduler exposes hooks.
- Final prompts/tool registration (W14).
- Artifacts/knowledge/question ref implementations.

## Verification

- Targeted routing/delegation/scheduler/worker integration tests
- `just typecheck-core`
- `just test`
- `just verify`

## Completion checklist

- [ ] Team topology is the only delegation authority graph.
- [ ] Task acceptance/result is durable and non-blocking.
- [ ] Scheduler is fair, bounded, restartable, and nested-team safe.
- [ ] Worker transcripts are node/run scoped with task boundaries.
- [ ] Parent receives bounded authorized results only.

## Handoff

Record task/result schemas, scheduler fairness/slot semantics, worker-session lifecycle, ref authorization interface, status pagination, and W13 counter/attempt hooks.
