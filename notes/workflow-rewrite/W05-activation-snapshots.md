# W05 — Implement Immutable Activation Snapshots and Stale-source Behavior

Status: **Not started**  
Depends on: W04  
Blocks: W06

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Convert a valid workflow definition into one immutable, canonical, content-addressed activation snapshot that contains every static prompt/policy input needed to resume safely even when source config later changes. Define snapshot integrity, model/context validation, persistence, and stale-source compatibility before sessions are implemented.

## Design authority

- Design Sections 4.12, 9.2, 13.6–13.8, 14.8, 20, and the config/snapshot acceptance criteria
- Rule: mutable OKF remains live and every use records its content hash; prompts/skills/config are frozen

## Current touchpoints to inspect

- `src/engine/session.ts`, `src/engine/state.ts`, `src/engine/dispatch.ts`
- `src/core/config.ts`, `src/core/prompting.ts`, `src/core/normalize.ts`
- existing session snapshots/counters in session tests
- Pi model catalog/activation tests and `tests/model-catalog.test.ts`

## Snapshot contents

At minimum include:

- snapshot format version and schema version;
- package/capability contract versions;
- project identity/canonical root reference;
- workflow ID and canonical resolved metadata/team/node IDs;
- exact agent prompt bodies/frontmatter-effective non-authority defaults;
- exact skill content and hashes;
- attachment metadata for live knowledge bundles, but not frozen OKF content;
- raw agent capability ceilings and workflow narrowing inputs;
- resolved budgets/model/thinking defaults once their owning resolver is available;
- adapter/profile/options/checkpoint contract version and source hashes;
- source file list with canonical relative paths and hashes;
- canonical serialization hash and creation metadata.

Do not store credentials, environment values, absolute secret content, or runtime leases.

## Implementation plan

1. Define versioned snapshot schema independent from mutable runtime state.
2. Canonicalize map/list ordering where semantics are unordered; preserve semantically ordered prompt/team/member content.
3. Define exact text hashing/serialization and atomic persistence under `.pi/hive/sessions/` through trusted project-state helpers.
4. Validate all configured node models before activation:
   - model exists/activates through Pi;
   - configured thinking value is supported;
   - required static prompt plus dynamic run reserve fits context;
   - no silent model fallback.
5. Define the snapshot builder to require a branded `EffectiveAuthority` input. W05 may use a test-only fixture factory, but production config loading cannot construct that brand until W06 implements the real capability resolver. There is no persisted placeholder and no second hash pass: W06 supplies authority before the one canonical snapshot is built.
6. Compare source hashes to label snapshots current/stale/missing without mutating them.
7. Define resume compatibility checks: snapshot integrity, supported format/schema/package/adapter contracts, required live knowledge/workspace dependencies, and model availability.
8. An existing compatible snapshot may remain resumable when current source files are invalid/missing. It is never silently re-resolved.
9. Failed new snapshot validation must leave any current activation/linkage unchanged.
10. Add bounded snapshot summaries for doctor/selector; never return full prompts.
11. Update `IMPLEMENTATION_DECISIONS.md` with canonical serialization and context-reserve rules.

## Required tests

- Same resolved content yields the same hash independent of filesystem enumeration order.
- Meaningful prompt/team/capability/adapter/config changes alter the hash.
- Mutable OKF content changes do not alter the activation hash but are represented as live dependencies.
- Snapshot writes are atomic; truncated/corrupt/hash-mismatched files fail closed.
- Unavailable model, unsupported thinking, and insufficient context fail before run creation with no fallback.
- Stale source can resume a compatible stored activation; fresh/reload remains disabled until source validates.
- Snapshot summary is bounded/redacted.
- Unsupported snapshot/package/adapter version produces explicit recovery diagnostics.

## Out of scope

- Effective capability/tool derivation implementation (W06). This task defines the required branded input/serialized field but never fabricates it in production.
- Workflow session linkage/selection (W10).
- Reload/archive commands (W15).
- Journal/checkpoint runtime events (W09).

## Verification

- Targeted snapshot/model/context tests
- `just typecheck-core`
- `just test`
- `just verify`

## Completion checklist

- [ ] Snapshot builder is immutable/content-addressed and refuses missing/unbranded effective authority.
- [ ] Snapshot integrity/version checks fail closed.
- [ ] Model/context checks happen before activation/run creation.
- [ ] Stale source never mutates or silently replaces a stored snapshot.
- [ ] Knowledge is correctly represented as live hash-provenanced dependency.
- [ ] Snapshot summaries do not leak prompt/secret content.

## Handoff

Document canonical serialization/hash algorithm, snapshot schema/version, storage path/API, model/context reserve calculation, compatibility matrix, and the exact W06 callback/field that completes effective authority before a snapshot becomes activation-ready.
