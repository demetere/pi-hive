# W23 — Implement Durable Knowledge Enrichment

Status: **Not started**  
Depends on: W22  
Blocks: W24

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Replace ad hoc mental-model distillation with bounded, durable, provenance-rich agent/shared enrichment jobs that run only while the owning workflow session is idle, are preemptible/restartable, respect automatic/reviewed/read-only policy, and resolve stale conflicts safely.

## Design authority

- Design Sections 16.6–16.8, 18.1, Risks 25.5–25.6
- Completed, failed, and terminally blocked runs may enqueue; cancelled runs enqueue nothing unless user explicitly requests preservation

## Current touchpoints to inspect

- distillation/enrichment code in `src/engine/dispatch.ts`
- `src/core/mental-model.ts`, current timers/queues/governance
- dashboard review/proposal patterns
- worker cleanup/session lifecycle/usage tests
- W09 journal, W13 budgets/attempts, W21 control CAS, W22 provider

## Required job model

At run termination:

- at most one consolidated agent-scoped job per participating catalog agent with durable candidates;
- at most one shared project-curation job over bounded verified evidence from whole run;
- no transcript dumping; candidates contain stable conclusions, provenance, citations/evidence refs, source hashes, and scope.

Policies:

- agent-owned omitted policy defaults automatic;
- shared omitted defaults reviewed;
- read-only never mutates;
- reviewed produces proposal requiring authenticated dashboard decision;
- automatic still validates/deduplicates/bounds and uses optimistic hashes.

## Runtime behavior

- Persist jobs without blocking terminal transition or workflow switching.
- At most one low-priority curation model job while owning workflow session otherwise idle.
- User work preempts; pause/abort-and-resume without normal run slot.
- Shutdown persists and resumes; no silent discard.
- Stale input hash reloads/re-evaluates once; unresolved conflict becomes reviewed proposal, never overwrite.
- All mutations use knowledge subsystem + Pi mutation queue + short locks.

## Target modules

- `src/knowledge/enrichment.ts`
- `src/knowledge/queue.ts`
- `src/knowledge/proposals.ts`
- `src/knowledge/curator.ts`

## Implementation plan

1. Resolve curator model selection, prompt, budgets, limits, and idle/preemption policy in implementation decisions.
2. Define job/proposal/update schemas and journal events with evidence refs/hashes.
3. Consolidate candidates deterministically at terminal outcome.
4. Implement durable queue reducer/scheduler separate from normal worker slots.
5. Build strict curator prompt/output schema: stable conclusions only, citations required, no authority/config changes.
6. Implement automatic update with optimistic hash, OKF/schema validation, dedupe/consolidation, bounded mutation queue.
7. Implement reviewed proposal CAS/control service for W25/W26.
8. Implement read-only suppression with auditable skipped reason.
9. Implement stale re-evaluate-once then reviewed fallback.
10. Delete no old distiller path until W27; prove new queue cleanup/preemption independently.

## Required tests

- Job counts/scopes for completed/failed/blocked/cancelled outcomes and repeated agent nodes.
- Default/explicit policies and read-only behavior.
- Terminal transition does not wait for curation.
- Idle start, user preemption, shutdown/restart, no worker slot consumption.
- Provenance/citation/hash/schema/dedupe bounds.
- Concurrent writers and stale hash: one re-evaluation then reviewed fallback.
- Reviewed approve/deny/replay race through service; no model-created human approval.
- No leaked timer/session/model job after cancellation/shutdown.

## Out of scope

- Dashboard proposal UI (W26) and server routes (W25).
- Other knowledge providers.
- Automatic migration of old mental-model YAML.

## Verification

- Enrichment/queue/concurrency/provenance/preemption tests
- `just typecheck-core`
- `just test`
- `just verify`

## Completion checklist

- [ ] Enrichment is consolidated, durable, bounded, and non-blocking.
- [ ] Policy defaults and read-only/reviewed/automatic semantics match design.
- [ ] User work preempts curation and no normal slot is consumed.
- [ ] Stale conflict never overwrites silently.
- [ ] Every update/proposal has verifiable provenance.

## Handoff

Record job/proposal/update schemas, curator model/prompt/budgets, queue priority/preemption API, mutation/conflict behavior, and W25/W26 control DTOs.
