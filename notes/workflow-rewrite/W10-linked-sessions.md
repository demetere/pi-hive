# W10 — Implement Linked Workflow Sessions and Selection/Navigation

Status: **Not started**  
Depends on: W09  
Blocks: W11

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Implement the core linked-Pi-session graph: normal chat as canonical parent, sibling workflow activations, explicit selection/fresh/archive/exit, per-session model/thinking/tool baseline, and safe runtime ownership. Selection opens/resumes an environment but never starts a run.

## Required Pi documentation

Before editing, read the installed Pi documentation completely for extensions, SDK/session switching, TUI/session lifecycle, commands, tools, and any linked examples referenced by those docs. In particular inspect:

- Pi `README.md`
- `docs/extensions.md`
- `docs/sdk.md`
- relevant session/TUI/keybinding docs and linked examples

Do not infer session lifecycle APIs from old pi-hive code alone.

## Design authority

- Design Sections 4.2, 13.1–13.8, 14.7–14.8, and 19.1
- Selection must remain explicit; workflow sessions are siblings under canonical normal parent; no nested chain/cycle shortcut

## Current touchpoints to inspect

- `index.ts`
- `src/engine/session.ts`, `src/engine/state.ts`, `src/integration/commands.ts`, `src/integration/hooks.ts`
- mode switching in existing tests (`tests/modes.test.ts`, activation/session integration/branch tests)
- active-tool/model/thinking handling in current Pi integration

## Required behavior

- New top-level Pi session starts normal; no workflow prompt/tools/topology/widget/policy/telemetry activity.
- Configured project exposes lightweight commands only.
- `/hive:select` core API lists valid/invalid/resumable workflows; actual UI command wiring completes W26.
- Selecting ID creates/resumes current linked activation under canonical normal parent.
- Selecting from inside a workflow resolves normal parent first; workflows remain siblings.
- `--fresh` archives prior current activation for that workflow and creates a new one.
- Invalid current source blocks fresh creation but a compatible stored snapshot may remain resumable and visibly stale.
- `/hive:exit` returns to canonical normal session; open-run pause behavior is added W11.
- Normal session persists/restores its own active-tool baseline, never Pi defaults or stale workflow tools.
- Root model/thinking state belongs to workflow session; changes pass W05 model/context checks and are journaled.
- One workflow session may be opened by one runtime owner only.
- Session replacement callbacks use only the fresh context; no captured old session-bound objects.

## Target modules

- `src/workflows/sessions.ts`
- `src/workflows/registry.ts`
- `src/workflows/navigation.ts`
- `src/integration/session-links.ts`
- minimal internal selection command service, without final TUI presentation

## Implementation plan

1. Define persisted normal-parent/workflow-child link entries and naming/archive states.
2. Implement canonical parent resolution robust to commands issued from normal/workflow/history contexts.
3. Persist normal-session active-tool baseline before first switch and reconstruct workflow tools from snapshot policy on every selected turn.
4. Create workflow Pi session with exact activation snapshot marker, root prompt identity placeholder (final prompt W14), model/thinking defaults, and journal linkage.
5. Acquire W09 runtime ownership before opening executable workflow state; release on navigation/shutdown according to lifecycle.
6. Resume only after snapshot compatibility/live dependency checks. Never re-read mutable source config into an old activation.
7. Implement fresh/archive semantics without rewriting history or deleting journals.
8. Ensure native `/new` and `/resume` integration can identify workflow sessions; W11 adds open-run pause semantics and fork/clone/tree blocking.
9. Return bounded selector/status DTOs with stale/invalid diagnostics and no prompt content.
10. Keep old mode command behavior operational until W27 but isolate new services; do not map plan/hive modes into workflow IDs.

## Required tests

- Normal startup has zero workflow registrations/state when unconfigured and quiet command-only state when configured.
- First selection creates sibling session; reselection resumes; fresh archives and creates new.
- Selection from a workflow does not create nested session chains.
- Invalid source versus compatible stale snapshot behavior.
- Normal and each workflow restore distinct model/thinking/tool state.
- Second process/session owner is rejected; shutdown/navigation releases safely.
- Session replacement does not use stale context objects.
- Missing Pi session preserves orphan journal for W15 recovery.

## Out of scope

- Ordinary chat creating/steering runs (W11).
- Delegation/workers (W12).
- `--from` handoff and reload/orphan command UX (W15).
- Final commands/TUI/widget (W26).

## Verification

- Targeted linked-session/navigation/activation integration tests
- `just typecheck-core`
- `just test`
- `just test-node-compat`
- `just verify`

## Completion checklist

- [ ] Normal/workflow Pi sessions are linked siblings with persisted canonical parent.
- [ ] Selection never creates a run or invokes another workflow.
- [ ] Fresh/archive/resume/stale-source behavior is deterministic.
- [ ] Tool/model/thinking state cannot leak between linked sessions.
- [ ] Runtime ownership and fresh-context lifecycle are correct.

## Handoff

Record Pi APIs used, link/custom-entry schema, selector DTO, baseline-tool reconstruction, archive naming, ownership acquisition/release points, and the exact hooks W11 must use for input/navigation.
