# W19 — Port OpenSpec into Adapter Profiles

Status: **Not started**  
Depends on: W18  
Blocks: W20

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Move all OpenSpec-specific workspace, actions, status, checkpoints, completion, evidence, and dashboard data behind the generic adapter contract. Generic runtime/prompts/tools must no longer understand proposal/design/specs/tasks semantics.

## Design authority

- Design Sections 10.2/10.6, 11, 12, 22.5
- Profiles/checkpoints:
  - author: proposal, design, specs, tasks
  - execute: tasks, implementation
  - review: implementation, review
  - lifecycle: proposal, design, specs, tasks, implementation, review

## Current touchpoints to inspect

- `src/engine/openspec.ts`, `src/engine/sdd.ts`, `src/engine/review.ts`
- OpenSpec-specific sections of `src/agents/tools.ts`, `src/agents/role-templates.ts`, `src/engine/prompts.ts`, `src/engine/dispatch.ts`
- `src/shared/openspec-artifacts.ts`
- dashboard plan bridge/routes/DB/review wiring
- all OpenSpec, artifact verification, review, plan bridge/server/DB tests

## Adapter responsibilities

- Detect/validate OpenSpec availability and project initialization.
- Resolve/create/list exact change workspaces under canonical project containment.
- Expose profile-specific generic action IDs/typed args; action IDs may be OpenSpec-specific behind `artifact_action`.
- Provide bounded status/view/prompt guidance.
- Keep proposal/design/specs/tasks dependency graph internal.
- Implement checkpoint digest contributors and profile completion.
- Record implementation task evidence without mutating an approved tasks digest incorrectly.
- Never route/delegate agents or dictate workflow procedure.

## Implementation plan

1. Define exact OpenSpec adapter options/action schemas/profile prerequisites/completion/digest contract in implementation decisions.
2. Reuse hardened CLI invocation/timeouts/output limits from current engine where correct, but place them inside adapter module.
3. Implement workspace ID/path resolver and binding modes from W17.
4. Implement author actions for scaffold/status/read/write/validate according to capability/profile.
5. Implement execute actions for task/evidence state, preserving exact approved task digest and current repository evidence.
6. Implement review actions/view data without allowing agent to impersonate human checkpoint approval.
7. Implement lifecycle union with no harness-level phase state; root decides action order.
8. Convert current plan/review approval records to W18 generic checkpoints for new runs only.
9. Apply shared adapter contract suite plus OpenSpec-specific CLI/fault/hash tests.
10. Remove OpenSpec imports from new generic runtime/prompts/tools/dashboard DTO. Leave old path only until W27 deletion.

## Required tests

- Every profile/action/binding/checkpoint/completion matrix.
- CLI unavailable/timeout/cancel/output limit/invalid JSON/partial filesystem cases.
- Exact change ID/path containment/list pagination/no latest selection.
- Proposal/design/specs/tasks state and validation remain adapter-internal.
- Execution evidence/checkpoint digest does not mutate or forge approved tasks.
- Author→handoff→execute stale/current workspace cases.
- Concurrent readers/writer lease/hash/operation recovery via contract suite.
- Generic runtime has no OpenSpec semantic branch/import.

## Out of scope

- Markdown adapter (W20).
- Final removal of legacy OpenSpec commands/routes (W27).
- Third-party adapters.

## Verification

- Adapter contract suite + OpenSpec/review/artifact tests
- `just typecheck-core`
- `just test`
- `just test-db` if generic approval projection touched
- `just verify`

## Completion checklist

- [ ] OpenSpec is a built-in adapter, not global mode.
- [ ] All four profiles and six checkpoint IDs match design.
- [ ] Generic code has no proposal/design/specs/tasks branching.
- [ ] CLI/error/hash/lease behavior remains bounded and recoverable.
- [ ] Split and combined fixtures work through same adapter contract.

## Handoff

Record adapter options/action schemas, profile completion rules, digest contributors, CLI limits, evidence sidecar contract, and old files/routes W27 must delete.
