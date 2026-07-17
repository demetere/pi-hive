# W15 — Implement Handoff, Reload, Archive, and Orphan Recovery

Status: **Not started**  
Depends on: W14  
Blocks: W16

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Complete workflow-session lifecycle beyond simple selection: explicit immutable cross-workflow handoff, idle reload to a fresh activation, persistent archive/staleness behavior, and auditable recovery when linked Pi session files disappear.

## Design authority

- Design Sections 4.11–4.12, 10.6, 13.3, 13.7–13.10, and 14.8
- Handoff is user-initiated navigation, never automatic workflow invocation/composition

## Current touchpoints to inspect

- W05 snapshots, W09 journal, W10 sessions/navigation, W11 run lifecycle
- `src/integration/commands.ts`, session history/custom-entry APIs
- session lifecycle/branch/command tests

## Handoff packet contract

Content-addressed and bounded:

- source project/workflow/session/run/snapshot IDs;
- terminal status/summary;
- runtime-derived typed file changes and coverage;
- artifact refs/digests and verified evidence refs;
- bounded `data`;
- packet hash/version/creation metadata.

Explicitly excluded: full transcript, pending input/questions, capabilities, approvals as authority, leases, budgets, model state, in-memory objects, and source team authority.

## Required behavior

- Source run must be terminal and same canonical project identity.
- `/hive:select <target> --from <run-id|last>` stages one packet and selects target; no model/run starts.
- `last` means most recent terminal run in current source workflow; normal chat requires explicit ID.
- `--fresh` may combine with `--from`.
- Existing open target run or conflicting staged packet rejects without partial switch.
- Staged packet persists across restart/navigation; `/hive:handoff-clear` is idle-only.
- Next ordinary target message atomically creates run and consumes packet once.
- Target independently resolves policy/budgets/adapter; packet grants nothing.
- Artifact refs are candidates until W17 adapter revalidation.
- `suggested-next` remains UI metadata only.

## Reload/recovery behavior

- `/hive:reload` idle-only; validate full new activation first; on failure current remains unchanged; on success archive current and switch fresh.
- Source changes never mutate an existing activation.
- Missing linked Pi session marks journal orphaned. `/hive:recover` refuses live owner and creates a new auditable Pi-session link; no transcript fabrication/deletion.
- Unsupported snapshot/runtime contract produces explicit blocked recovery path, not silent migration.

## Target modules

- `src/workflows/handoff.ts`
- `src/workflows/recovery.ts`
- extend sessions/navigation/commands service

## Implementation plan

1. Define packet schema/hash/size limits and source-envelope verifier.
2. Persist stage/clear/consume events with compare-and-swap semantics.
3. Resolve source IDs without exposing unrelated project runs.
4. Integrate packet into W14 root dynamic context as untrusted read-only data.
5. Implement reload two-phase validation/link switch.
6. Implement orphan detection/recovery links and dashboard/doctor summaries.
7. Ensure archive/current pointers update atomically and history is never rewritten.
8. Add selector DTO fields for staged handoff, source staleness, resumable/archive/orphan state.
9. Keep command presentation for W26; expose tested service handlers now.

## Required tests

- Completed/blocked/failed source packets; nonterminal/missing/cross-project reject.
- `last` resolution contexts, fresh+from, existing target open run, conflicting packet.
- Persist/restart/clear/one-shot atomic consumption and duplicate callbacks.
- Target cannot inherit capabilities/approval/lease/model/team from packet.
- Stale artifact ref remains evidence and waits for adapter validation.
- Reload success/failure/no-active-run and source-change races.
- Orphan detection, live-owner refusal, new link provenance, corrupt snapshot failure.
- Suggested-next has no invocation effect.

## Out of scope

- Adapter binding implementation (W17).
- Final TUI selector/commands (W26).
- Automatic router/programmatic workflow invocation.

## Verification

- Targeted handoff/reload/orphan/navigation tests
- `just typecheck-core`
- `just test`
- `just verify`

## Completion checklist

- [ ] Handoff is immutable, bounded, same-project, one-shot, authority-free.
- [ ] Selecting/staging never starts a run/model.
- [ ] Reload never mutates current activation on failure.
- [ ] Orphan recovery preserves journal/history and creates auditable linkage.
- [ ] No automatic composition semantics exist.

## Handoff

Record packet schema/limit/hash, stage CAS/events, selector status additions, reload transaction, orphan recovery link schema, and W17 artifact-ref validation hook.
