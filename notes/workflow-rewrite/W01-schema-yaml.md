# W01 — Add Schema-v1 Types, Strict YAML, and Generated Schemas

Status: **Complete**  
Depends on: W00  
Blocks: W02

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Introduce the new schema-v1 type system and strict YAML 1.2 parsing foundation without switching the extension runtime yet. Runtime validation, TypeScript types, and published editor JSON Schemas must come from one authority and reject ambiguous/unsafe YAML before semantic resource resolution.

## Design authority

- Design Sections 5–10, especially 6, 7, 8.1, 9.3, 10.1, and 10.7
- Acceptance criteria covering `schema-version: 1`, unknown-key rejection, no interpolation, closed capability/budget values, generated-schema parity, and bounded diagnostics

## Current touchpoints to inspect

- `src/core/yaml.ts` (`parseYamlLite` and YAML-lite assumptions)
- `src/core/schema.ts`, `src/core/types.ts`, `src/core/config-validation.ts`, `src/core/config.ts`
- `tests/yaml.test.ts`, `tests/schema-branches.test.ts`, `tests/config.test.ts`
- `package.json`, lockfile, package verification tests

## Target structure

Create the new source-of-truth under `src/config/`, approximately:

- `types.ts`: public/raw/resolved schema-v1 TypeScript types
- `schema.ts`: TypeBox schemas and closed value sets
- `yaml.ts`: guarded YAML document parsing with source ranges
- `diagnostics.ts`: stable diagnostic codes and bounded collector primitives
- `versions.ts`: schema/capability contract versions
- generated editor schemas in a package-visible location chosen consistently with package verification

Do not move legacy runtime types yet. New modules must not import Bun.

## Non-negotiable schema decisions

- Root manifest requires integer `schema-version: 1`.
- YAML uses 1.2 core semantics.
- Reject duplicate keys, merge keys, aliases/anchors, custom/executable tags, non-string mapping keys, non-finite numbers, and unsupported schema versions.
- Perform no environment interpolation, command substitution, template expansion, or secret expansion.
- Public IDs match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`.
- Public YAML keys are kebab case and unknown keys fail at every authority-bearing level.
- Capability groups/values and budget fields are exactly those in the design; arbitrary raw Pi tool names are not accepted.
- Duration syntax is exactly `^[1-9][0-9]*(ms|s|m|h)$`.
- `instructions` is a mapping with optional `shared` and required `root`, not a scalar shorthand.
- JSON-schema generation must not be maintained by hand separately from runtime schemas.

## Implementation plan

1. Add the maintained `yaml` package to runtime `dependencies`; update lockfile and license/package checks as required.
2. Define raw schema-v1 shapes for manifest settings/registries, agent frontmatter, workflow/team nodes, artifact config, checkpoint policy, overlays, capabilities, budgets, skills, and knowledge entries.
3. Separate syntactic raw types from future resolved types. Paths/IDs remain unresolved strings at this layer.
4. Implement guarded document parsing:
   - byte limit check before parse;
   - bounded alias/complexity settings even though aliases are rejected;
   - duplicate/merge/tag detection;
   - line/column/range retention;
   - maximum diagnostic count with a truncation indicator;
   - no parsing fallback to YAML-lite.
5. Define stable diagnostic shape: code, severity, message, source file, range, optional resource ID/dependency chain, and bounded related diagnostics.
6. Generate editor JSON Schemas deterministically. Add a verification command/test that rebuilds in memory or to a temp location and fails on drift.
7. Keep `src/core/yaml.ts` in use by the old runtime until W27. New code must call only `src/config/yaml.ts`.
8. Update `IMPLEMENTATION_DECISIONS.md` with exact parser byte/depth/diagnostic limits and generated-schema location.

## Required tests

- Valid manifest/workflow/agent examples parse with source locations.
- `on`, `off`, `yes`, and `no` remain strings under YAML 1.2 where applicable.
- Duplicate keys fail at the duplicate's exact range.
- Anchors, aliases, merge keys, custom tags, non-string keys, and non-finite numbers fail.
- Unknown keys fail in every nested authority-bearing structure.
- ID, duration, positive-safe-integer, enum, duplicate-list, and empty-string boundaries are table-tested.
- No `${ENV}`, shell syntax, or template-like text is transformed.
- Generated JSON Schema accepts/rejects the same golden cases as runtime syntactic validation.
- Oversized input and diagnostic floods remain bounded.

## Out of scope

- Ancestor discovery, canonical paths, registry file loading, or dependency quarantine (W02).
- Parsing Markdown frontmatter bodies (W03).
- Semantic capability narrowing, adapter/profile existence, model availability, or resource hashes.
- Switching `loadConfig` or deleting YAML-lite.

## Verification

- Targeted schema/YAML tests
- `just typecheck-core`
- `just test`
- `just verify-licenses`
- `just verify-package`
- `just verify`

## Completion checklist

- [x] `yaml` is a runtime dependency and packages correctly.
- [x] One source of truth produces types/runtime validators/editor schemas.
- [x] Strict parser behavior matches every design rule.
- [x] Diagnostics preserve exact bounded source ranges.
- [x] New modules are Node-compatible and independent of legacy runtime types.
- [x] Legacy runtime behavior remains unchanged until cutover.

## Handoff

Document exported schema/type/diagnostic APIs, exact parser limits, schema-generation command, and any TypeBox/JSON-Schema representation caveat W02 must preserve.

### Completion handoff (2026-07-17)

Exported APIs are available from `src/config/index.ts`: schema/version constants, strict `parseConfigYaml`, diagnostic primitives, TypeBox runtime schemas and validators, and raw schema-v1 TypeScript types. Raw paths and IDs remain unresolved at this layer. Legacy `src/core/yaml.ts` and `src/core/config.ts` remain unchanged and active until W27.

Parser limits are 524,288 UTF-8 bytes per document, AST depth 64, and 20,000 complete AST nodes including mapping keys and their subtrees. Diagnostics contain at most 100 entries including truncation, 16 related entries, and 16 dependency-chain entries; every externally supplied diagnostic string is truncated to 2,048 UTF-8 bytes without splitting code points. Source offsets are zero-based UTF-16 half-open ranges; lines and columns are one-based.

The TypeBox authority is `src/config/schema.ts`. Deterministic editor artifacts are committed under `schemas/` and generated or checked with `just config-schema-build` / `just config-schema-verify`. Ajv Draft 2020-12 independently verifies generated-schema parity. The review bundle now uses `fflate` so package freshness is stable across supported Node/zlib versions.

Red/green evidence:

- Red: `tests/config-yaml.test.ts` exposed a wide mapping that bypassed the AST limit and caused Node's reporter to format a huge successful parse. Green: mapping keys count toward the limit, the helper reports only a bounded boolean failure, and the focused file passes 5/5 at about 196 MiB RSS.
- Red: focused anchored-key and complex-key tests failed because mapping-key subtrees were not traversed. Green: complete key/value traversal rejects key anchors and enforces depth/node limits.
- Red: `tests/config-diagnostics.test.ts` showed unbounded source, resource, dependency-chain, and related-source strings. Green: every diagnostic string is UTF-8 bounded and all 3 diagnostics tests pass.
- Red: package freshness differed between Linux and macOS gzip headers and across Node/zlib versions. Green: `fflate` produces deterministic review artifacts and package verification passes on Node 20, 22, and 24.

Final verification:

- focused config diagnostics/YAML/runtime-schema/generated-schema tests pass;
- legacy `tests/yaml.test.ts`, `tests/schema-branches.test.ts`, and `tests/config.test.ts` pass unchanged;
- `just config-schema-verify`, `just typecheck-core`, `just typecheck-tests`, package/license/budget checks, and `just verify` pass;
- `just test-node-compat` passes on Node 20.19 with all new config tests included;
- two fresh-context review passes completed; the final technical review was clean.
