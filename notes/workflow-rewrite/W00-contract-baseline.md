# W00 — Freeze Executable Contracts and Rewrite Baseline

Status: **Complete**  
Depends on: none  
Blocks: W01–W28

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Create the test fixtures, implementation decision record, baseline evidence, and old-to-new ownership map that every later task will use. This task changes no production runtime behavior. It prevents later agents from implementing incompatible interpretations of the architecture or deleting legacy behavior before an equivalent new contract is tested.

## Required reading

- `notes/workflow-rewrite/README.md`
- `docs/WORKFLOW_ARCHITECTURE_DESIGN.md`, especially Sections 1–5, 21–26
- `AGENTS.md`
- `package.json`, `Justfile`, `index.ts`
- Current config/runtime tests: `tests/config.test.ts`, `tests/modes.test.ts`, `tests/activation.test.ts`, `tests/session-lifecycle.integration.test.ts`, `tests/policy.test.ts`, `tests/openspec.test.ts`, `tests/questions.test.ts`, telemetry/dashboard suites

## Current-state facts

- Production types/config are centered on `HiveMode`, `HiveConfig.hive`, `HiveConfig.planning`, `HiveTeam`, semantic `AgentType`, planner `stages`, OpenSpec-specific tools, and a YAML-lite parser.
- Existing tests intentionally encode those contracts. They cannot all be deleted up front; each later task must replace the invariant it owns.
- The extension already has critical behavior worth preserving: no registration without the opt-in manifest, path containment, policy hooks, bounded output, daemon authentication, cancellation cleanup, and package verification.
- The rewrite is a clean release contract, but development must remain testable while new modules coexist with legacy modules until W27.

## In scope

1. Create a versioned fixture tree under `tests/fixtures/workflow-configs/` containing at minimum:
   - `combined-delivery/`: manifest, reusable agents, one OpenSpec lifecycle workflow, skills/knowledge placeholders;
   - `split-plan-build/`: planning and build workflows with `suggested-next` and handoff-compatible adapter profiles;
   - `artifact-free-debug/`: `none/default/none` workflow;
   - `nested-project/`: parent and child manifests proving nearest-manifest behavior;
   - `invalid/`: duplicate keys, unsupported schema version, unknown keys/IDs, missing resources, bad ID grammar, symlink escape, invalid team node IDs, widening overrides, invalid checkpoint maps, and prompt/size-limit cases.
2. Add a reusable fixture-copy/temp-project helper. It must preserve symlink fixtures where the platform supports them and expose an explicit skip reason otherwise.
3. Create `notes/workflow-rewrite/IMPLEMENTATION_DECISIONS.md` with a checklist for the implementation-level items in design Section 26. Do not reopen architectural decisions; record exact constants/schemas as the owning W task resolves them.
4. Create `notes/workflow-rewrite/LEGACY_REPLACEMENT_MAP.md` mapping current files/symbol families/tests to their owning W task. Include at least config/types, mode/session state, policy, dispatch/routing, tools/prompts, OpenSpec/review, questions, mental model, observability/server, dashboard/TUI, docs/examples, and generated assets.
5. Record baseline command results in this task's Handoff section: Node/Bun test totals, package size budgets, dashboard build freshness, and whether the current tree already has unrelated changes.
6. Add or retain an explicit regression test proving the extension factory performs zero registrations when `.pi/hive/hive-config.yaml` is absent. This guard remains throughout the rewrite.

## Out of scope

- Adding the `yaml` dependency or schema-v1 production parser (W01).
- Changing config loading, commands, tools, sessions, dashboards, or package major.
- Renaming/removing legacy tests merely because they will eventually be obsolete.
- Choosing implementation constants owned by later tasks without the relevant code/test investigation.

## Implementation steps

1. Inspect all current test helpers and reuse conventions instead of creating a parallel temp-project framework.
2. Build fixtures from the normative examples in design Sections 6, 8, and 10. Ensure every resource path is project-relative and every workflow file is a direct child of `.pi/hive/workflows/`.
3. Keep fixture prompts minimal but valid; include capability differences needed to prove combined versus split authority.
4. Add fixture README files only if test code cannot make intent obvious. Fixtures must not contain credentials, real telemetry, or runtime session state.
5. Populate the replacement map with concrete current symbols such as `loadConfig`, `teamForMode`, `HiveMode`, `AgentType`, `applyMode`, `dispatchAgent`, `routeAgents`, type-based policy tables, OpenSpec plan tools, review gates, mental-model distillation, and fixed dashboard plan routes.
6. Run baseline checks without modifying generated UI. Record results and any pre-existing failures exactly.

## Required tests and checks

- Existing opt-in activation test passes.
- Fixture helper unit tests prove copy/isolation and nested-project behavior at filesystem level only.
- `just test`
- `just test-db`
- `just dashboard-verify`
- `just verify-package`
- `just verify`

## Completion checklist

- [x] Fixture tree covers combined, split, `none`, nested, and invalid configurations.
- [x] Fixtures contain no old `planning:`/`hive:` schema.
- [x] Replacement map assigns every legacy subsystem to one later task.
- [x] Implementation decision checklist exists and names its owning W tasks.
- [x] Opt-in no-registration guard is explicit and passing.
- [x] Baseline results and unrelated working-tree state are recorded below.
- [x] No production behavior changed.

## Handoff

### Working-tree baseline (2026-07-16)

- Branch: `feat/workflow-rewrite`.
- Runtime versions: Node `v22.23.1`; Bun `1.3.14`.
- Before W00 edits, `git status --short` contained only the pre-existing untracked `.pi-subagents/` tree and `docs/WORKFLOW_ARCHITECTURE_DESIGN.md`. The orchestrator-created `notes/workflow-rewrite/AGENTS.md` and this task's existing **In progress** state were preserved. There were no staged paths.
- W00 added only fixture/test-helper/test and workflow-rewrite record content. No `index.ts`, `src/**`, dependency, package-version, `ui/web/dist/**`, or `ui/review/dist/**` file changed. No dashboard/review build was run.
- `tests/activation.test.ts` intentionally changes process-global `cwd` to test activation, then restores it in `finally`. No other unexpected global-process dependency was observed.

### TDD evidence

All focused commands used:

`node --import tsx --import ./tests/register-ts-loader.mjs --test tests/workflow-fixtures.test.ts`

1. Copy/isolation RED: exit 1, `ERR_MODULE_NOT_FOUND` for the absent `tests/helpers/workflow-fixtures.ts` (1 test, 0 pass, 1 fail). GREEN after the minimum copy helper and first fixture: 1 test passed, 0 failed.
2. Nested nearest-manifest RED: exit 1 because the helper did not export `findNearestWorkflowProject` (1 test file failed). GREEN after the filesystem-only ancestor walk: 2 tests passed, 0 failed. The result contains exactly one `{ projectRoot, manifestPath }`; child and parent registries are never merged.
3. Symlink RED: 2 passed and 1 failed because the fixture link was `../../../../../outside-agent.md`, not the asserted contained fixture-root escape. The context handoff's five-level target was a path-counting error: from `.pi/hive/agents/`, the sibling of `project/` is `../../../../outside-agent.md`. The supervisor approved this correction. GREEN after correcting the fixture: 3 tests passed, 0 failed.
4. Inventory/contracts RED: 5 passed and 1 failed because `nested-project/work/deep/.keep` widened the exact normative topology. GREEN after removing that extra path: 6 tests passed, 0 failed.
5. Final focused GREEN: exit 0; 6 tests, 6 passed, 0 failed, 0 skipped, duration `371.739569ms`. A final post-record fixture-format rerun was also green at `306.635598ms`. This covers isolated deep copies, nearest-manifest selection, symlink preservation/skip, exact valid and invalid inventory, direct workflow children, schema-v1 valid manifests, absence of legacy `planning:`/`hive:` keys, and deferred exact-byte generation.

The existing activation guard was retained rather than given a manufactured red. Focused command:

`node --import tsx --import ./tests/register-ts-loader.mjs --test tests/activation.test.ts`

Result: exit 0; 1 test, 1 passed, 0 failed, 0 skipped, duration `286.377551ms`. The extension factory's `registerTool`, `registerCommand`, `registerShortcut`, and `on` surfaces all remain throwing guards when `.pi/hive/hive-config.yaml` is absent.

### Fixture helper contract

`tests/helpers/workflow-fixtures.ts` exports:

- `copyWorkflowFixture(name, { projectSubdir? })` → `{ fixtureRoot, projectRoot, sourceRoot, cleanup }`; each call uses a unique temp directory and recursively copies without dereferencing symlinks.
- `findNearestWorkflowProject(startPath)` → one nearest `{ projectRoot, manifestPath }` or `undefined`; this is test-only filesystem behavior, not the W02 production implementation.
- `symlinkSupport()` → `{ supported: true }` or `{ supported: false, reason }`; unsupported platforms call `t.skip(reason)` rather than silently passing.
- `writeRepeatedFile(path, byteCount, byte)` writes an exact requested byte count. The oversized-prompt fixture deliberately supplies no guessed W01–W03 limit; its documented future boundary is `resolvedLimit + 1`.

On this Linux host symlink probing succeeded. The copied `debugger.md` remained a symbolic link with target `../../../../outside-agent.md`; its resolved target was outside `projectRoot` and inside the disposable `symlink-escape` fixture root. No skip was taken.

### Required baseline gates (2026-07-16)

| Command | Exit | Result |
|---|---:|---|
| `just test` | 0 | Node TAP: 317 tests, 317 passed, 0 failed, 0 skipped, duration `30626.510301ms`. |
| `just test-db` | 0 | Bun: 73 passed, 0 failed, 418 `expect()` calls across 14 files, `6.92s`. |
| `just dashboard-verify` | 0 | `✓ dashboard dist/ is up to date with ui/web/src`; committed `.build-hash` is `81c09f4086142d8e0413d2a646c9e20197c5f8fc64bac4ad3540d214a926e102`. |
| `just verify-package` | 0 | `✓ package files and manifest are ready to publish`. |
| `just verify-budgets` | 0 | Package `376494` packed / `1184611` unpacked bytes (95 allowlisted files); review bundle `12625` raw / `4304` compressed bytes; all 10% regression budgets passed. |
| `just verify` | 0 | Aggregate gate passed, including Node 317/317 and Bun 73/73, dashboard/review freshness/vendor checks, package/budgets, licenses, typechecks, and lint; ended `All verification gates passed.` |

Final tree evidence before independent review: `git diff --cached --name-only` was empty. `git status --short -- index.ts src ui/web/dist ui/review/dist package.json` was empty. The only status entries were the preserved untracked `.pi-subagents/` and architecture design plus W00's untracked `tests/fixtures/`, `tests/helpers/`, and `tests/workflow-fixtures.test.ts`; workflow-rewrite notes are ignored by the repository but present on disk. Completion boxes and **In progress** status remain unchanged for parent review.

### Accepted review fixes (2026-07-16)

The delivery decision is implementation-only: the eventual PR may contain `.gitignore`, `tests/helpers/workflow-fixtures.ts`, `tests/workflow-fixtures.test.ts`, and `tests/fixtures/workflow-configs/**`. It must not contain `docs/WORKFLOW_ARCHITECTURE_DESIGN.md` or any `notes/workflow-rewrite/**` task/phase/record. Those documents remain local orchestration artifacts; `/notes/` remains ignored.

Review-fix TDD used the same focused fixture command. Initial RED: exit 1 with 10 tests total, 7 passed and 3 failed. Unsafe/empty/absolute fixture names and escaping project subdirectories did not throw, and a missing source surfaced the raw `ENOENT` after allocating a temp root. GREEN after helper containment/validation/failure cleanup: 10/10 passed (`420.343569ms`); exact invalid inventories were then frozen and the focused suite remained 10/10 green (`452.695416ms`). A separate deterministic copy-failure regression was RED at 10 passed/1 failed because the injected `cpSync` failure was not observed (`451.715231ms`); after routing copies through the mockable Node `fs` object, it was GREEN at 11/11 (`494.860612ms`) and proved the allocated root is removed.

The helper now resolves and containment-checks fixture names with `resolve`, `relative`, `isAbsolute`, and platform separators; validates the source directory before allocation; validates requested project directories after copying; removes an allocated root on every setup/copy exception; and retains idempotent cleanup. Tests prove rejected traversal/empty/absolute names, rejected escaping/absolute/missing project subdirectories, no new `pi-hive-workflow-fixture-*` roots after failures, and root removal on repeated cleanup. Frozen inventory comparisons normalize only relative fixture paths to POSIX separators. Symlink containment assertions use `relative`/`isAbsolute`, not literal slash prefixes.

Exact per-case inventories now cover all 18 invalid directories, including missing-resource asymmetry, the oversized generator input, and the symlink entry itself. The final combined activation + fixture command passed 12/12 (`412.028339ms`), and `just typecheck-tests` passed both Node and Bun test TypeScript projects. Final `just verify` exited 0: Node 322/322, Bun 73/73 (418 expectations), dashboard/review/package/budget/license checks green, ending `All verification gates passed.`

`.gitignore` now narrowly re-includes only nested `.pi` directories/files beneath `/tests/fixtures/workflow-configs/**`; the global `.pi/` runtime rule and `/notes/` rule remain effective. Delivery checks reported 82 untracked fixture entries visible through `git ls-files --others --exclude-standard`, 82 entries in `git add -n -- tests/fixtures/workflow-configs`, and the symlink path explicitly visible. No dry-run included the design document or local notes because the implementation paths are staged explicitly; no actual staging was performed.

### Final symlink portability review (2026-07-16)

A final regression simulates a symlink-incapable checkout by replacing the copied symlink with a regular file while supplying `{ supported: false, reason: "simulated symlink-incapable checkout" }`. RED on the focused fixture command: exit 1, 12 total, 11 passed, 1 failed (`474.032604ms`) because the invalid-inventory loop still unconditionally required `isSymbolicLink() === true`. GREEN after gating only that type assertion on the explicit `symlinkSupport()` result: 12/12 passed (`441.676657ms`). Exact four-path inventory remains asserted in both branches, and the unsupported branch requires a non-empty reason. On this Linux supported host, both the dedicated target/resolution assertions and the inventory symlink-type assertion still execute.

Final validation: combined fixture + activation 13/13 (`495.616169ms`); `just typecheck-tests` passed both test projects after correcting test-only callback annotations (an intermediate run diagnosed `TS7006`/`TS2345` before the typed green); implementation-only Git dry-run remained exactly 85 paths with 82 fixtures and zero docs/notes; `just verify` exited 0 with Node 323/323 and Bun 73/73 (418 expectations), ending `All verification gates passed.` No files were staged. The PR scope remains implementation-only and W00 remains **In progress** with every checklist box unchecked.

### Final review gate

Fresh-context review after the final portability regression reported **CLEAN — no blockers or worthwhile fixes remain**. Its focused run passed 13/13 tests with zero skips, both test TypeScript projects passed, the explicit staging dry run contained exactly 85 approved implementation paths (82 fixture leaves plus `.gitignore`, helper, and test), and no production/generated/package path was included. The latest full `just verify` passed with Node 323/323 and Bun 73/73.

### Final staged whitespace hygiene (2026-07-16)

A focused regression now extracts the Markdown body after the closing frontmatter delimiter and proves both `body.trim() === ""` and absence of any space/tab-only line. RED on the current fixture: exit 1, 13 total, 12 passed, 1 failed (`479.992886ms`), with body bytes `"   \n\n"` matching `/^[\\t ]+$/m`. The fixture body was replaced by empty content after the delimiter; the file retains its final newline and therefore remains an intentional empty-prompt violation without ASCII whitespace. Final combined fixture + activation GREEN: 14/14 (`485.213111ms`).

The first newline-only edit removed spaces but left an extra blank line at EOF, which `git diff --cached --check` correctly rejected. Removing that extra body line preserved the empty-body contract and made all three checks pass with no output: `git diff --cached --check`, `git diff --check`, and `git diff HEAD --check`. The parent intentionally supplied an 85-path staged pre-commit set; it remains exactly 85 paths with no working implementation diff, and only existing-scope files were refreshed in the index. The existing `.gitignore` path also now ignores top-level `/.pi-subagents/`, so local worker artifacts disappear from ordinary status without affecting fixture visibility; the pre-existing design document remains unignored and unstaged for the parent to handle separately. PR scope remains implementation-only, W00 remains **In progress**, and every checklist box remains unchecked.

### Fixture directory naming correction (2026-07-16)

The fixture directory was renamed to `tests/fixtures/workflow-configs/` without changing any manifest's `schema-version: 1`. TDD RED after updating helper/test references but before moving the tree: focused fixture run exited 1 with 13 total, 2 passed and 11 failed (`493.834234ms`), consistently reporting missing sources beneath `tests/fixtures/workflow-configs/`. After `git mv`, focused GREEN passed 13/13 (`460.213014ms`); final fixture + activation passed 14/14 (`412.961447ms`).

Final `just verify` passed with Node 324/324 and Bun 73/73 (418 expectations), ending `All verification gates passed.` Repository checks found no obsolete fixture-directory string in tracked implementation, no old directory, exactly 82 fixture leaves under `workflow-configs`, zero fixture leaves elsewhere, and 22 manifests retaining `schema-version: 1`. The combined implementation diff contains exactly 85 logical paths with no out-of-scope path or whitespace error. The unrelated untracked design document remains preserved. Local execution rules now require every implementation PR to target `develop/workflow-rewrite`, followed by one final integration PR from that branch to `main`.

Later tasks must update this section when they discover a missing ownership mapping rather than letting code fall between tasks.
