# W07 — Rewrite Filesystem and Reserved-path Enforcement

Status: **Not started**  
Depends on: W06  
Blocks: W08

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Enforce schema-v1 filesystem capabilities mechanically for direct Pi file tools and classified mutation effects, with canonical project containment, separate read/create/update/delete authority, protected subsystem paths, and symlink-safe behavior.

## Design authority

- Design Sections 5, 9.3, 9.6, 11.3, 16.4, 25.1, and 25.16
- Accepted risks: no OS sandbox; bare-filename Bash reads may remain fail-open; interpreter-hidden writes are not statically policeable

## Current touchpoints to inspect

- `src/core/safe-path.ts`, `src/core/fs.ts`
- `src/engine/domain.ts`, `src/engine/glob.ts`, `src/engine/file-class.ts`, `src/engine/reserved-paths.ts`, `src/engine/policy.ts`
- `src/integration/hooks.ts`
- `tests/safe-path.test.ts`, `tests/policy.test.ts`, `tests/governance.test.ts`, reserved-path/domain tests

## Required policy semantics

- Every operation checks an explicit effective scope and operation.
- Paths are project-root-relative in config and canonicalized at use.
- New targets use nearest-existing-ancestor checks.
- Include/exclude globs use the exact grammar recorded in implementation decisions; exclusions always win and negated re-inclusion is forbidden.
- First-release agent authority never reaches outside canonical project root.
- Symlink target must remain inside project root and granted subtree.
- Create, update, and delete are distinct; existence/race is rechecked immediately before mutation.
- Artifact, knowledge, runtime/session, telemetry, authority/config, credential/secret, and dashboard-auth paths are protected from generic file tools.
- Trusted harness may stat/hash for enforcement/accounting without exposing content to an agent lacking read.
- Structured delegation refs are re-authorized for the recipient; this is not general DLP.

## Target modules

- `src/capabilities/filesystem.ts`
- `src/capabilities/glob.ts`
- `src/capabilities/reserved-paths.ts`
- policy-hook adapter connecting effective node policy to Pi tool calls

## Implementation plan

1. Finalize and document glob grammar/normalization in `IMPLEMENTATION_DECISIONS.md`; add conformance vectors before enforcement code.
2. Normalize configured scopes once during activation, retaining source provenance and canonical project root.
3. Implement operation classifier for direct read/write/edit/delete tools and mutation-queue operations.
4. Resolve target and nearest existing ancestor without time-of-check assumptions; revalidate on actual queued mutation.
5. Make protected-path checks independent from user grants. A broad `path: .` cannot cover reserved roots.
6. Define explicit subsystem APIs for artifact/knowledge/runtime writes so they do not bypass the file mutation queue while remaining inaccessible to generic tools.
7. Ensure tool-hook enforcement runs on every call even if the user/UI re-enables a tool.
8. Bound path counts, glob evaluation, diagnostics, and output.
9. Preserve/document the accepted bare-filename Bash-read limitation for W08; do not pretend this task solves opaque shell reads.
10. Add provenance to denials without leaking inaccessible paths/content.

## Required tests

- Matrix for read/create/update/delete against absent/existing files and directory targets.
- Include/exclude precedence, normalization, Unicode/case platform behavior, traversal, separator, and glob-complexity cases.
- Symlink at target/intermediate/nearest-existing ancestor; symlink swap race at queued mutation boundary.
- Every protected root denied to generic tools even under broad grant.
- Artifact/knowledge subsystem mutation path succeeds only through its dedicated queued API.
- Harness hash/stat does not expose content in result/prompt/telemetry.
- Re-enabled/directly-invoked file tools remain policy checked.
- Windows behavior is either supported by tests or explicitly rejected according to project platform decision.

## Out of scope

- Bash command/path extraction and Git/network classification (W08).
- Artifact workspace permission semantics beyond protected facade paths (W16/W17).
- Change ledger/reconciliation (W13).
- Hostile interpreter containment.

## Verification

- Targeted safe-path/glob/policy/race tests
- `just typecheck-core`
- `just test`
- `just verify`

## Completion checklist

- [ ] All direct filesystem operations are scope/operation checked.
- [ ] Symlink and missing-tail escape tests fail closed.
- [ ] Protected subsystem paths cannot be granted generically.
- [ ] Every custom mutation uses Pi's mutation queue.
- [ ] Accepted non-sandbox limits remain explicitly documented.

## Handoff

Record glob grammar, canonicalization API, protected-path registry, operation classifier, mutation-queue contract, platform limits, and W08 hooks for shell/Git effects.
