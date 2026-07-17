# W28 — Exhaustive Verification and Release Gate

Status: **Not started**  
Depends on: W27  
Blocks: release/tag/publish

## Mandatory TDD sequence

Every defect or missing invariant found during this gate must first be reproduced by the smallest failing automated test. Run it and confirm the expected behavioral failure, implement the minimum fix, rerun to green, then refactor. Missing verification coverage is added before changing production behavior. Record red and green commands/results in Handoff; never waive, weaken, or delete a test to make the release gate pass.

## Outcome

Prove the implementation satisfies all 48 design acceptance criteria, global package invariants, security/reliability boundaries, and representative user workflows. Fix discovered defects with regression tests; do not waive failures or reduce gates.

## Required reading

- Entire `docs/WORKFLOW_ARCHITECTURE_DESIGN.md`, especially Sections 24–26
- Every W task Handoff and incomplete checklist
- `AGENTS.md`, release/package scripts, SECURITY/README/SETUP/migration guide
- Current CI configuration and generated artifact verification

## Verification matrix

Create a checked matrix mapping each design acceptance criterion to one or more automated tests and, only where unavoidable, an explicit manual test with recorded evidence. No criterion may be marked by prose assertion alone when automation is feasible.

## Required suites

1. **Schema/config:** golden/negative cases, generated schema parity, strict YAML/fuzz, registry quarantine, snapshots/hashes/stale source.
2. **Capabilities/policy:** property subset tests, every tool/command class, paths/globs/symlinks/protected roots/network zones/foreign tools, accepted interpreter/bare-read limits.
3. **Sessions/runs:** normal baseline, sibling links, model/context, one-open-run, input races, terminal guards, cancel/pause/resume/reload/archive/orphan.
4. **Delegation/runtime:** recursive teams, repeated agent IDs, direct authority, routing determinism, FIFO/fairness, max-parallel 1 nesting, budgets, retries, worker cleanup.
5. **Effects/accounting:** attempt idempotency, uncertain effects, dirty Git/non-Git, concurrent edits, hidden writes, partial coverage, protected drift.
6. **Artifacts/approvals:** shared contract suite for all profiles/bindings, leases/hashes/crashes, checkpoint digest/forgery/replay/denial/revision, combined/split handoff.
7. **Questions/knowledge:** restart/offline CAS, terminal close races, OKF validation/retrieval/hash provenance, enrichment preemption/conflicts/review.
8. **Telemetry/dashboard:** rebuild/idempotency/gaps/redaction/retention, daemon auth/CSRF/origin/replay/lifecycle/SSE, API/UI pagination/accessibility.
9. **Package/global safety:** Node compatibility, Bun isolation, no-config no-op, packed install, files/dependencies/licenses/budgets/generated assets.
10. **End-to-end user journeys:** combined feature delivery, split plan→build, Markdown author→execute, artifact-free debug, out-of-scope blocked, cancellation, stale handoff, offline answer/approval.

## Fault/property testing requirements

- Crash injection at journal append/checkpoint, ownership heartbeat, queue transition, model/tool attempt, mutation queue, workspace lease/action, approval/question CAS, enrichment update, projection ingest, daemon control append.
- Property/fuzz for YAML/parser limits, IDs, path/glob normalization, capability narrowing, recursive teams, journal replay, projection idempotency, pagination bounds.
- Cross-process tests for session owner, workspace writer, control append, stale lock/death verification.
- Large-input tests for workflow counts, topology, history, logs, status output, dashboard rendering, SSE backpressure.

## Manual checks that remain valuable

- TUI selection/status/checkpoints/questions/session switching under real Pi.
- Headless command guidance and dashboard-required approval path.
- Dashboard visual/keyboard screen sizes and screen reader announcements.
- Kill/restart Pi and Bun daemon during active/waiting/paused scenarios.
- Inspect packed artifact in a clean environment with and without opt-in config.

Every manual check records date, environment, exact steps, and result in this Handoff section or a linked release verification artifact.

## Release checks

- `just coverage`
- `just verify`
- `just generated-verify`
- `just pack-dry-run`
- `just verify-packed-install`
- `just verify-licenses`
- `npm audit` for root/dashboard according to repository policy
- `just ci`

## Stop-ship conditions

- Any acceptance criterion lacks passing evidence.
- Any no-config path registers tools/hooks/server/widget or creates state.
- Any capability widening/policy bypass/approval forgery/path escape/protected control access.
- Any non-idempotent effect auto-retries after uncertain outcome.
- Any journal/projection corruption is ignored or guessed through.
- Any daemon executes models or dashboard launches/edits workflows.
- Any stale generated UI, package-content drift, missing license, failing coverage/type/lint/test/security gate.
- Any TODO/FIXME/debug log/temporary compatibility branch remains.

## Completion checklist

- [ ] All 48 acceptance criteria map to passing evidence.
- [ ] All W00–W27 tasks/checklists/Handoffs are complete.
- [ ] Fault/property/cross-process/scale/end-to-end suites pass.
- [ ] Manual Pi/TUI/headless/dashboard/restart journeys are recorded.
- [ ] Coverage/security/package/generated/license/audit gates pass.
- [ ] Working tree contains no runtime artifacts, logs, DBs, tgz, node_modules additions, swap files, or unexplained changes.
- [ ] `just ci` passes from clean checkout.
- [ ] Release/tag/publish is the only remaining action.

## Handoff

Record the acceptance-to-test matrix location, exact test totals/coverage, all command outputs or CI links, manual environment/results, package contents/size, dashboard build hash, known accepted risks, and final release recommendation. Do not mark Complete if any stop-ship condition remains.
