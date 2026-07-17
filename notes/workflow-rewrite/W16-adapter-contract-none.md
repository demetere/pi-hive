# W16 — Build Artifact Adapter Contracts, Registry, Facade, and `none`

Status: **Not started**  
Depends on: W15  
Blocks: W17

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Create the generic artifact-lifecycle-only adapter interface, built-in registry, typed facade, bounded status/view contracts, and fully functional logical-empty `none/default` adapter. No adapter may become a hidden workflow engine.

## Design authority

- Design Sections 4.6–4.7, 10.2, 11.1–11.5, 18.3, 19.2
- First release supports repository-built `none`, `markdown-plan`, and `openspec` only; no config-loaded code or third-party registration API

## Current touchpoints to inspect

- `src/engine/openspec.ts`, `src/engine/sdd.ts`, `src/agents/tools.ts`
- `src/shared/openspec-artifacts.ts`, plan/review dashboard contracts
- W04 built-in profile metadata and W14 tool descriptor/facade extension points
- OpenSpec/artifact verification/review tests

## Adapter boundary

An adapter/profile may own:

- versioned options schema;
- supported common binding modes;
- workspace create/resolve/bind/status;
- typed action IDs/argument schemas/prerequisites;
- checkpoint IDs/digest contributors;
- completion validation;
- bounded prompt/dashboard view data;
- workspace evidence/hashes.

It may not invoke models, route/delegate agents, inspect arbitrary transcripts, change workflow/session/run state directly, mutate outside bound workspace, inject frontend code, or grant capabilities.

## Generic facade contract

- `artifact_status`: bounded profile/workspace/binding/checkpoint/action/status data permitted by `artifact.read`.
- `artifact_action`: exact action ID plus typed arguments; workspace ID comes from trusted run state, not arbitrary path per call.
- Every action requires both caller capability and profile support.
- Unknown fields/actions/options fail.
- Mutation goes through Pi file mutation queue and W13 attempt IDs.
- Results are bounded; larger content uses verified refs/pagination.

## `none/default` contract

- Only adapter/profile/binding `none/default/none`.
- Logical empty workspace record binds at run creation.
- No path, writer lease, checkpoint, or artifact action.
- Completion uses standard run envelope only.
- Agent filesystem/shell/Git authority is unaffected; `none` does not mean read-only.

## Target modules

- `src/artifacts/types.ts`
- `src/artifacts/contracts.ts`
- `src/artifacts/registry.ts`
- `src/artifacts/facade.ts`
- `src/artifacts/adapters/none.ts`

## Implementation plan

1. Promote W04 data-only profile metadata into versioned runtime interfaces without creating circular config/runtime imports.
2. Define trusted adapter registry constructed in package code only.
3. Define typed action validation/result/error model, capability prerequisites, mutability/idempotency metadata, and view bounds.
4. Bind adapter instance to run snapshot/profile/options; no global mutable selected adapter.
5. Implement facade policy checks using W06/W14 caller context.
6. Implement `none` logical workspace and completion hook.
7. Add adapter contract test harness reusable by W19/W20.
8. Verify adapter cannot access model/delegation/runtime mutation APIs at type/module boundary where practical.
9. Add bounded standard dashboard DTO; UI remains W26.

## Required tests

- Registry accepts only built-ins and rejects unknown adapter/profile/version.
- Options/action unknown fields and size bounds fail.
- Caller capability/profile prerequisites enforced per action.
- Workspace path cannot be supplied/spoofed through action args.
- Adapter result/view bounds and pagination refs.
- `none` binds once logically, has no actions/checkpoints/lease/path, and permits normal run completion.
- Contract harness detects adapter mutation outside workspace and forbidden orchestration hooks.
- Core imports remain Node-compatible.

## Out of scope

- Physical workspace binding/leases (W17).
- Approval service (W18).
- OpenSpec/Markdown implementation (W19/W20).
- Third-party adapter API.

## Verification

- Adapter contract/none/facade tests
- `just typecheck-core`
- `just test`
- `just test-node-compat`
- `just verify`

## Completion checklist

- [ ] Adapter boundary is artifact-lifecycle-only.
- [ ] Registry is built-in and versioned.
- [ ] Facade checks caller capability/profile/workspace and bounds output.
- [ ] `none` is complete, not a null special case scattered through runtime.
- [ ] Contract suite is reusable by later adapters.

## Handoff

Record adapter/profile/action/view interfaces, registry versioning, facade errors, contract-suite requirements, and W17 workspace/lease callbacks.
