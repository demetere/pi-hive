# W04 — Implement Workflow/Team Resolution and Budgets

Status: **Not started**  
Depends on: W03  
Blocks: W05

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Load workflow YAML, resolve recursive reusable-agent topology, validate instruction scopes/artifact metadata/checkpoints/budgets/discovery hints, and quarantine only workflows whose dependencies are invalid. Produce deterministic unresolved-authority workflow definitions for activation.

## Design authority

- Design Sections 4.1–4.5, 6.1–6.3, 9.2, and all of Section 10
- Built-in adapter/profile/checkpoint table in Section 11.1
- Acceptance criteria for many workflows, recursive team nodes, repeated agent IDs, combined/split configs, explicit checkpoints, and no generic phases

## Current touchpoints to inspect

- `src/core/agent-tree.ts`, `src/core/config.ts`, `src/core/config-validation.ts`, `src/core/types.ts`
- `src/core/agent-type-audit.ts`
- `src/engine/routing.ts`, `src/engine/domain.ts`, `src/engine/governance.ts`
- `tests/config.test.ts`, `tests/modes.test.ts`, `tests/schema-branches.test.ts`, routing/governance tests

## Required workflow contract

- ID comes from manifest registry key.
- Required metadata: name, description, `use-when`, artifact adapter/profile/binding, recursive team, and `instructions.root`.
- Optional: `avoid-when`, tags, examples, `suggested-next`, adapter options, approvals, budgets, `instructions.shared`.
- `suggested-next` validates workflow IDs but has no execution semantics and cycles are permitted.
- Team nodes require unique stable node ID and catalog agent ID; optional role, responsibilities, `consult-when`, safe overrides, and members.
- Same agent ID may appear at multiple node IDs. Runtime addressing always uses node ID.
- Safe overrides only replace model/thinking, narrow capabilities/budgets, and explicitly add/remove skill/knowledge attachments.
- No phases, DAG, reports-to list, special root schema, semantic type, raw tool list, or workflow inheritance.
- Workflow budget fields and scopes exactly match design Section 10.7.
- Every checkpoint published by the exact built-in adapter/profile is explicitly configured; unknown/missing IDs fail. `none/default` has none.

## Target modules

- `src/config/workflows.ts`
- `src/config/team.ts`
- `src/config/resolver.ts`
- `src/config/budgets.ts`
- built-in adapter contract metadata may begin in `src/artifacts/contracts.ts` as data-only definitions, without runtime adapter code

## Implementation plan

1. Parse each registered workflow independently with W01 parser/schema and W02 path rules.
2. Validate discovery metadata lengths/counts and deterministic ID ordering.
3. Resolve every team node to its catalog agent while preserving node-local metadata/source ranges.
4. Traverse iteratively; enforce bounded node count/depth, unique node IDs, and no YAML alias/object reuse.
5. Resolve skill/knowledge add/remove sets:
   - every ID must exist;
   - duplicate/conflicting add/remove entries fail;
   - removal of an unattached item should be a precise validation error unless the design decision log explicitly chooses harmless no-op semantics;
   - keep authority resolution for W06.
6. Validate model/thinking replacements syntactically and budget narrowing structurally. W06 proves capability subsets.
7. Validate adapter/profile/binding/options envelope and exact checkpoint key set against versioned built-in contract metadata.
8. Validate each `suggested-next` target after all workflow files are known. Do not treat it as an execution dependency edge.
9. Produce `ValidWorkflowDefinition | InvalidWorkflowDefinition` entries. Invalid workflows include complete bounded dependency chains; valid siblings remain selectable.
10. Add deterministic human selector summaries without prompt text.
11. Test the normative combined, split, and artifact-free fixtures from W00.

## Required tests

- Deep recursive team, repeated agent IDs at unique node IDs, leaf/root shapes, and deterministic traversal.
- Duplicate IDs, excessive depth/count, missing agent, malformed metadata, unsafe overrides, and unknown attachment IDs fail locally.
- Combined lifecycle, split author/execute, and `none/default` fixtures resolve.
- Adapter/profile/binding mismatch and every checkpoint set error fail.
- `suggested-next` validates IDs, allows cycles, and does not create invocation/order.
- One invalid workflow does not disable independent valid workflows.
- Budgets validate exact fields/scopes/duration grammar and strictest-value representation.
- Selector summaries are bounded and ID-stable.

## Out of scope

- Effective capability subset/intersection (W06).
- Model availability/context fit and content-addressed activation snapshot (W05).
- Runtime selector/session behavior (W10).
- Adapter action implementations (W16+).

## Verification

- Targeted workflow/team/budget tests
- `just typecheck-core`
- `just test`
- `just verify`

## Completion checklist

- [ ] Workflows are generic config, never hardcoded names.
- [ ] Team is one recursive node shape with stable IDs.
- [ ] Combined, split, and specialist workflows resolve from fixtures.
- [ ] Checkpoint maps exactly match profile contracts.
- [ ] Invalid workflows are quarantined with dependency diagnostics.
- [ ] No runtime phase/DAG semantics were introduced.

## Handoff

Record resolved workflow/team types, built-in profile contract metadata version, traversal/size limits, selector summary shape, and the unresolved authority/model checks W05/W06 must finish.
