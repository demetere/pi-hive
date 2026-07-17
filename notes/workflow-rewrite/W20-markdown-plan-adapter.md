# W20 — Implement Markdown-plan Adapter Profiles

Status: **Not started**  
Depends on: W19  
Blocks: W21

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Implement a first-class Markdown-plan adapter with author, execute, review, and lifecycle profiles using the same generic workspace, lease, approval, evidence, completion, and dashboard contracts as OpenSpec.

## Design authority

- Design Sections 4.7, 10.6, 11.1–11.7, 12, and deferred Markdown-plan contract item
- Checkpoints:
  - author: plan
  - execute: plan, execution
  - review: execution, review
  - lifecycle: plan, execution, review

## Contract decisions this task must finalize first

Record exact choices in `IMPLEMENTATION_DECISIONS.md` and tests before implementation:

- adapter options schema and default/configurable project-contained plan root;
- workspace ID grammar and ID-to-plan path mapping;
- canonical Markdown structure/frontmatter and stable task identifiers;
- adapter-owned metadata/evidence sidecar location;
- author/update/validate/list/status action IDs;
- execution progress/evidence representation that does not rewrite an approved plan digest silently;
- plan/execution/review digest contributors and profile completion rules;
- how revisions invalidate/re-request approvals.

Prefer a human-readable Git-friendly plan file and machine-owned sidecar for mutable execution evidence. Generic file tools must not mutate a bound plan workspace directly.

## Target modules

- `src/artifacts/adapters/markdown-plan.ts`
- parser/validator/sidecar helpers under adapter directory
- adapter-specific tests/fixtures

## Implementation plan

1. Add valid/invalid Markdown-plan fixture workspaces for each profile and revision state.
2. Implement options validation and canonical path resolution through W07/W17.
3. Implement create/list/resolve/read/status actions with bounded parsing/output.
4. Implement author/update actions through mutation queue, optimistic hash, and operation IDs.
5. Implement stable task/evidence sidecar so execute progress does not forge approved plan content.
6. Implement review data and checkpoint digest contributors through W18.
7. Implement profile-specific completion validators and lifecycle union without workflow phases.
8. Add standard bounded prompt/dashboard view data.
9. Run the exact shared adapter contract suite used by `none` and OpenSpec.
10. Add end-to-end split Markdown author→handoff→execute and combined lifecycle tests.

## Required tests

- Options/path/ID/schema/Markdown parse validation and bounds.
- Every profile/binding/action/checkpoint/completion combination.
- Exact digest invalidation on plan/evidence contributor changes; unrelated changes do not invalidate.
- Revision after denial and stale handoff behavior.
- Concurrent readers/writer lease/hash/idempotent crash recovery.
- Generic tools cannot directly write bound plan/sidecar paths.
- Execution evidence cannot mutate approved plan invisibly.
- Dashboard view bounded and no injected HTML/React.

## Out of scope

- Workflow orchestration or phase order.
- General Markdown task parser outside adapter workspace.
- Third-party configurable adapter code.

## Verification

- Shared adapter contract suite + Markdown-specific tests
- `just typecheck-core`
- `just test`
- `just verify`

## Completion checklist

- [ ] Markdown plan workspace/profile/checkpoint contract is fully documented and tested.
- [ ] Plan remains human-readable and execution evidence is auditable.
- [ ] All mutations use facade/queue/lease/hash/operation ID.
- [ ] Split and combined workflows work without special runtime names.
- [ ] No adapter code orchestrates agents.

## Handoff

Record final plan format/options/actions/sidecar/digests/completion rules, reserved paths, and dashboard view schema W24–W26 consume.
