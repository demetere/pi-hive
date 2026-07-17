# W13 — Implement Budgets, Retries, Side-effect Recovery, and Change Accounting

Status: **Not started**  
Depends on: W12  
Blocks: W14

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Make runtime resource use and side effects deterministic enough to pause/recover safely: enforce run/node budgets, conservative retries, stable attempt IDs, unknown-side-effect handling, dirty-worktree baselines, and harness-derived completion file-change coverage.

## Design authority

- Design Sections 10.7, 11.7, 14.3–14.4, 14.10–14.13, 17, and Risks 25.12–25.15
- Do not claim exactly-once arbitrary commands, complete hidden-write attribution, or transactional rollback

## Current touchpoints to inspect

- `src/engine/governance.ts`, `src/engine/process.ts`, `src/core/usage.ts`
- worker lifecycle/usage in `src/engine/dispatch.ts`
- file mutation/locks and Git/status helpers
- usage, governance, process, dispatch usage, artifact verification, dirty-state tests

## Budget accounting

- Workflow run-wide: max-parallel, max-delegations, aggregate tool calls, aggregate tokens, active wall time; max-agent-turns applies per node.
- Agent/node ceilings add per-node turns/tool calls/tokens/active time.
- Every provider attempt including retry counts as turn and reported tokens.
- Every tool attempt including policy denial counts as tool call.
- Only accepted persisted tasks count as delegation.
- Admission checks precede work; post-response accounting may cross once when usage is only known afterward.
- Runtime warns at deterministic thresholds and reserves one bounded root finalization turn with restricted tools.
- Exhaustion never implies completion, changes model, expands limit, or disables approval.

## Retry/recovery policy

- Model request that failed before assistant output/tool call: at most two transient retries with bounded backoff/jitter.
- Explicitly read-only idempotent tool: one transient transport retry against same input/hash.
- Mutation, shell, Git, network, approval, question, and delegation acceptance: never blindly auto-retry.
- Every attempt has stable attempt/correlation ID and journal events.
- Uncertain mutation outcome pauses `unknown_side_effect` until reconciliation.

## Change accounting

- Capture pre-existing dirty baseline at run start.
- Record direct queued mutations with before/after hashes.
- Reconcile known mutating shell/Git effects.
- Git mode uses status plus hashes; non-Git uses bounded scoped inventory/Merkle where feasible.
- Distinguish pre-existing, recorded, observed, conflicted/unattributed changes.
- Coverage is `recorded | git-reconciled | scoped-reconciled | partial`.
- Root cannot submit harness-derived file changes/coverage.
- Unexplained protected-path changes block completion.

## Target modules

- `src/workflows/budgets.ts`
- `src/workflows/attempts.ts`
- `src/workflows/recovery.ts`
- `src/workflows/change-accounting.ts`
- integrate W07/W08 mutation metadata and W11 completion validator

## Implementation plan

1. Resolve package safety caps, default limits, warning thresholds, reserve size, and usage reconciliation in implementation decisions.
2. Implement immutable effective counter limits and replayable usage events.
3. Integrate scheduler/model/tool admission and post-attempt accounting.
4. Implement retry classifier using trusted tool descriptors only; policy denial is never retryable.
5. Add attempt intent/result records and replay semantics: completed same ID returns recorded bounded result; different args reject.
6. Add unknown-effect reconciliation hooks for filesystem, artifact, shell/Git, and external operations; unresolved pauses.
7. Implement run-start change baseline without modifying worktree/index.
8. Reconcile before terminal envelope; preserve dirty user work and disclose coverage.
9. Treat provider-confirmed versus estimated tokens/cost separately in telemetry metadata.
10. Fault-inject every boundary and ensure recovery does not redispatch non-idempotent effects.

## Required tests

- Every budget boundary, per-node/run interaction, retry contribution, threshold, reserve, and overage path.
- Max-parallel scheduler behavior remains correct.
- Safe model/read retries and prohibited mutation/network retries.
- Duplicate attempt same/different inputs.
- Crash with intent/no result for each effect class; reconcile or pause, never blind repeat.
- Clean/dirty Git, non-Git inventory, pre-existing changes, create/update/delete/rename, external concurrent edit, hidden interpreter write, partial coverage, protected drift.
- Terminal envelope derives immutable file changes/coverage and root spoofing fails.
- Active wall time excludes paused/waiting and survives restart.

## Out of scope

- Artifact-specific idempotency details (W17) but common attempt API is required.
- Provider-specific cost caps not in schema v1.
- OS-level transaction/rollback/sandbox.

## Verification

- Targeted budget/usage/retry/recovery/change-accounting/fault tests
- `just typecheck-core`
- `just test`
- `just verify`

## Completion checklist

- [ ] Budget accounting and exhaustion are deterministic/replayable.
- [ ] Only declared safe operations retry automatically.
- [ ] Unknown side effects pause for explicit reconciliation.
- [ ] Completion changes are harness-derived with disclosed coverage.
- [ ] Dirty user work is preserved and not falsely attributed.

## Handoff

Record caps/defaults/thresholds, attempt/retry APIs, reconciliation states, change ledger/envelope fields, provider usage precision, and tool restrictions in the finalization reserve.
