# W02 — Implement Project Discovery, Manifest Registries, and Diagnostics

Status: **Not started**  
Depends on: W01  
Blocks: W03

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Resolve the canonical configured project, load the schema-v1 root manifest, construct strict resource registries, and provide dependency-aware diagnostics/quarantine primitives. This task establishes project/config identity but does not yet fully load agent/workflow resources.

## Design authority

- Design Sections 5, 6, 7, 13.8, and 19.1 (`/hive:doctor --json` contract)
- Opt-in, nearest-ancestor, project containment, registry identity, failure isolation, and resource-limit acceptance criteria

## Current touchpoints to inspect

- `index.ts` (`projectHasHive`)
- `src/core/config.ts`, `src/core/config-validation.ts`, `src/core/safe-path.ts`, `src/core/fs.ts`
- `src/shared/project.ts`, `src/shared/project-identity.ts`
- `src/engine/doctor.ts`
- `tests/activation.test.ts`, `tests/config.test.ts`, `tests/safe-path.test.ts`, `tests/doctor.test.ts`, project identity tests

## Required behavior

1. Starting at `ctx.cwd`, find the nearest ancestor containing `.pi/hive/hive-config.yaml`.
2. The canonical project root is that ancestor, not `.pi/hive/` and not necessarily the Git root.
3. Nested configured projects do not merge. The nearest manifest wins.
4. If the manifest does not exist, return an explicit unconfigured result that lets the extension factory register nothing.
5. Canonicalize root/resource paths and enforce containment. Project-registered files cannot escape via `..`, symlinks, missing-tail creation, alternate spellings, or nested symlink ancestors.
6. Manifest IDs are stable registry keys. Files never redeclare resource IDs.
7. Workflow resources must be direct `.yaml` children of `.pi/hive/workflows/`; basename and ID may differ.
8. Root syntax/schema/registry-structure failures invalidate new project configuration globally. A broken referenced resource becomes a failed dependency node so unrelated workflows can remain valid later.
9. Diagnostics have stable codes, exact source ranges, bounded dependency chains, and human/JSON renderers.
10. Config contains literal data only; no environment or secret interpolation is introduced while resolving paths.

## Target modules

- `src/config/discovery.ts`
- `src/config/manifest.ts`
- `src/config/registry.ts` or `catalogs.ts`
- `src/config/paths.ts`
- extend `src/config/diagnostics.ts`

Reuse hardened canonical-path primitives where correct, but do not preserve `allowOutsideProject` behavior in schema v1.

## Implementation plan

1. Define `ConfiguredProject | UnconfiguredProject | InvalidProject` results; do not throw away structured diagnostics at the top boundary.
2. Separate lexical path validation from canonical filesystem containment. Check the nearest existing ancestor for missing paths.
3. Parse only the root manifest with W01 parser/schema.
4. Build typed registry entries for agents, workflows, skills, and knowledge:
   - retain ID, declared relative path/data, source range, canonical target when available, and load status;
   - reject duplicate IDs/paths where ambiguity could result;
   - reject unknown IDs only when references are semantically resolved in W03/W04.
5. Represent dependency failures as a graph/chain type usable by the selector and doctor. Bound traversal and diagnostic counts; use iterative traversal.
6. Implement deterministic ordering by registry ID for diagnostics and selector data.
7. Add human and JSON diagnostic renderers. JSON output must have no ANSI, absolute secret content, or unbounded nested errors.
8. Preserve the existing stable global `ProjectIdentity` where appropriate, but distinguish it from the canonical config project root. Record any identity migration needed by W24.
9. Update `IMPLEMENTATION_DECISIONS.md` with path/resource byte/count limits and canonicalization rules.

## Required tests

- No manifest returns unconfigured with zero side effects.
- Parent/child configured projects choose the nearest only.
- Canonical root is correct when cwd is a nested directory or symlinked path.
- Manifest symlink/resource symlink/`..`/missing-tail escapes fail closed.
- Unsupported/missing schema version and malformed root registry fail globally with exact diagnostics.
- Workflow nesting and wrong extensions fail.
- Same basename with different manifest IDs remains stable and valid where paths are otherwise unique.
- Bounded behavior under many entries, long paths, many failures, and dependency-chain cycles injected at the data-structure level.
- Human and JSON diagnostics are deterministic and redact/bound values.

## Out of scope

- Agent/frontmatter content loading (W03).
- Full workflow semantic resolution or `suggested-next` validation (W04).
- Extension command registration or selector UI.
- Loading old config as a fallback.

## Verification

- Targeted discovery/manifest/path/doctor tests
- `just typecheck-core`
- `just test`
- `just verify`

## Completion checklist

- [ ] Nearest-manifest discovery and canonical root are unambiguous.
- [ ] No-manifest path performs no registrations or runtime writes.
- [ ] Registries retain stable IDs and source ranges.
- [ ] Project resources cannot escape the project root.
- [ ] Global errors and dependency-node failures are represented separately.
- [ ] Doctor renderers are deterministic and bounded.

## Handoff

Record discovery API, canonical-root versus project-identity semantics, registry entry/status types, limits, and diagnostic codes W03/W04 must emit when resource loading fails.
