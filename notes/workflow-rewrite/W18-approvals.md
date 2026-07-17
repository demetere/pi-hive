# W18 — Implement Generic Checkpoint Approvals

Status: **Not started**  
Depends on: W17  
Blocks: W19

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Replace OpenSpec-specific approval authority with a generic exact-digest checkpoint service used by any adapter profile. Implement explicit required/optional/none policy, idle next-run defaults, immutable decisions, denial/revision flow, authenticated control events, and finish validation.

## Design authority

- Design Sections 10.1, 11.1, 12, 14.4, 18.1, 19.1
- Every published checkpoint is explicitly configured; approval is human-only and bound to exact deterministic digest

## Current touchpoints to inspect

- approval/review logic in `src/engine/review.ts`, `src/agents/tools.ts`, `src/shared/openspec-artifacts.ts`
- dashboard server plan/review routes and DB approval records
- `tests/artifact-verification.test.ts`, review security, plan server/DB/bridge tests
- W09 control events, W17 hashes/leases, W11 finish validator

## Required checkpoint policy

- Values: `required`, `optional`, `none`.
- Required cannot disable at runtime.
- None creates no fake approval record.
- Optional session default can change only while idle via checkpoint service; enabled set freezes into run snapshot at creation.
- Later default change never modifies an existing run.
- `completed` requires every enabled checkpoint satisfied.
- `blocked|failed` may record unsatisfied gates as such.

## Required approval authority

- Human dashboard action is primary.
- Equivalent explicit TUI action allowed when dashboard/Bun unavailable in TUI; headless requires dashboard.
- Conversational/model/tool text cannot create human approval.
- Approval/denial binds deterministic digest including adapter/profile/schema version and declared contributor files/data/hashes.
- Unrelated workspace change invalidates only if contributor set includes it.
- First valid decision wins through CAS.
- Denial is immutable for exact digest and reopens run for revision; changed digest creates new request.
- Handoff carries approval refs as evidence only; target profile independently evaluates them.

## Target modules

- `src/artifacts/approvals.ts`
- `src/artifacts/checkpoints.ts`
- typed control event/API contracts shared with W25/W26

## Implementation plan

1. Define checkpoint descriptor/digest contributor interface for adapters.
2. Define approval request/decision schema with IDs, project/session/run/workspace/checkpoint/profile versions, digest, approver/channel/time/provenance.
3. Persist request/decision under W09 journal with exact expected-state CAS.
4. Implement workflow config policy + idle optional-default + run-frozen effective set.
5. Verify current workspace hashes/lease/digest at request and decision.
6. Integrate completion validator and denial revision state.
7. Expose service handlers for dashboard/TUI, but do not build final routes/UI until W25/W26.
8. Make all outputs bounded/redacted and operation-ID replay safe.
9. Migrate no old approval authority; W27 clean break archives old data.

## Required tests

- Missing/unknown checkpoint config already fails W04; runtime tests all policy/default/freeze cases.
- Required cannot disable; none creates no record; optional idle-only update.
- Digest changes for each declared contributor/profile/schema version and not unrelated content.
- Forged conversational/tool/model approval rejected.
- Dashboard/TUI exact digest provenance equivalence; headless no-dashboard behavior.
- Concurrent approve/deny/late/replay races: first valid wins.
- Denial exact digest immutable; revision changed digest new request.
- Handoff ref does not automatically satisfy target.
- Finish completed versus blocked/failed gate behavior.

## Out of scope

- Actual dashboard endpoints/UI (W25/W26).
- Adapter-specific digest contributor implementation (W19/W20).
- Migration of old approval records.

## Verification

- Approval digest/forgery/race/revision tests
- `just typecheck-core`
- `just test`
- `just verify`

## Completion checklist

- [ ] Only authenticated explicit human action creates approval.
- [ ] Every decision is exact-digest/profile/version bound and immutable.
- [ ] Optional defaults freeze per run and required cannot disable.
- [ ] Denial supports revision without false approval carryover.
- [ ] Completion guards consume generic approval service only.

## Handoff

Record checkpoint/digest interfaces, approval schemas/CAS, control service API, channel provenance, run-default event shape, and adapter requirements for W19/W20.
