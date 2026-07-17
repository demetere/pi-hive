# W17 — Implement Workspace Binding, Leases, Hashes, and Idempotency

Status: **Not started**  
Depends on: W16  
Blocks: W18

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Implement the common one-workspace-per-run lifecycle: explicit `new|existing|either|none` binding, no silent latest selection, concurrent readers, one cross-process writer lease, optimistic hashes, operation IDs, crash reconciliation, and handoff artifact-ref validation.

## Design authority

- Design Sections 10.6, 11.2, 11.5–11.7, 13.9, 14.12, Risks 25.7/25.12/25.14

## Current touchpoints to inspect

- `src/core/file-lock.ts`, OpenSpec change selection/current change storage
- plan/review approval hash logic
- W09 ownership, W13 attempts/recovery, W15 handoff, W16 facade
- file-lock/artifact verification/OpenSpec/concurrency tests

## Binding semantics

- `none`: only `none/default`; logical binding at run creation.
- `new`: create and bind one new workspace; cannot bind existing.
- `existing`: must bind exact existing workspace before required work/success.
- `either`: bind one new or one existing.
- Bind exactly once; no rebinding.
- Existing source: compatible handoff ref, exact user-provided ID, or bounded list followed by explicit disambiguation.
- Never choose “latest” silently.
- Workspace stable ID resolves through adapter; agents never pass arbitrary paths.

## Lease/hash semantics

- Multiple readers require no lease and every read reports current hashes.
- One writer run across all Pi processes; renewable bounded lease.
- Pause/cancel/terminal releases owned lease; crash expires conservatively.
- Resume reacquires and revalidates. It never steals or auto-forks.
- Optimistic expected hash is required on mutation/approval even with lease.
- Handoff artifact ref is a candidate until target adapter resolves identity/profile/current hash.

## Idempotency/recovery

- Mutating action records operation intent before mutation queue and result hashes after commit.
- Completed same operation ID returns recorded result; different args reject.
- Intent/no result triggers state read/reconciliation, never blind repeat.
- Indeterminate result pauses `unknown_side_effect`.

## Target modules

- `src/artifacts/workspaces.ts`
- `src/artifacts/leases.ts`
- `src/artifacts/hashes.ts`
- `src/artifacts/operations.ts`
- adapter workspace interface extensions

## Implementation plan

1. Resolve workspace/lease file formats, heartbeat/expiry/death checks, and operation limits in implementation decisions.
2. Persist binding state/events in run journal; validate binding mode/profile/options.
3. Define adapter ID-to-canonical-path resolution with W07 containment/protected roots.
4. Implement create collision failure and exact existing resolution/list pagination.
5. Implement reader hash snapshots and writer lease acquisition/renew/release.
6. Integrate W13 attempt/recovery and Pi mutation queue.
7. Validate handoff refs without consuming authority or approval.
8. Add completion/pause/cancel hooks for hash/lease finalization.
9. Add dashboard DTO for binding/lease/hash conflict without sensitive path leakage.

## Required tests

- Every profile/binding combination and invalid mismatch.
- New collision, existing missing/ambiguous, either explicit choice, bind-twice denial, no silent latest.
- Concurrent readers; competing writer processes; heartbeat; dead-owner expiry; no fresh steal.
- Resume unchanged/changed/other-owner conflict.
- Expected hash stale, unrelated hash changes, handoff stale/incompatible.
- Crash before/during/after queued mutation; idempotent replay or unknown-side-effect pause.
- Completion/cancel/pause lease release and final hash evidence.
- Node compatibility/no Bun core.

## Out of scope

- Checkpoint approval service (W18).
- Concrete OpenSpec/Markdown workspace formats (W19/W20).
- Global transactions for project files outside workspace.

## Verification

- Workspace/lease/hash/operation cross-process and fault tests
- `just typecheck-core`
- `just test`
- `just test-node-compat`
- `just verify`

## Completion checklist

- [ ] One run binds one workspace once under explicit mode.
- [ ] Existing selection is exact and never implicit-latest.
- [ ] One writer lease plus hashes prevents silent concurrent mutation.
- [ ] Crash recovery never blindly repeats a mutation.
- [ ] Handoff refs are revalidated before binding.

## Handoff

Record binding/lease/operation schemas, timing constants, hash model, list/disambiguation DTO, handoff validation result, and W18 digest/lease requirements.
