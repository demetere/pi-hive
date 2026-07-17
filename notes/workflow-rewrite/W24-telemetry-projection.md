# W24 — Implement Workflow Event Telemetry, Projection, Redaction, and Retention

Status: **Not started**  
Depends on: W23  
Blocks: W25

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Replace fixed planning/hive telemetry with versioned workflow/session/run/node/task/adapter/question/approval/knowledge events and an idempotent rebuildable global SQLite projection. Apply pre-persistence redaction, bounded content rules, sequence-gap detection, and clean old-schema separation.

## Design authority

- Design Sections 17, 18.2, 22.7, 25.15
- Authoritative state remains project journals; projection can be dropped/rebuilt
- Old telemetry preserved/archived, not migrated/dual-read/deleted

## Current touchpoints to inspect

- `src/observability/agent-log.ts`, `src/engine/observability.ts`
- `src/shared/telemetry.ts`, `src/shared/privacy.ts`, `src/shared/project-identity.ts`
- `src/observability/server/db.ts`, `jsonl-reader.ts`, runtime/config/types
- dashboard event/ingestion/runtime/log/privacy/project identity tests

## Required dimensions

Project identity/root, Pi session, workflow/snapshot, run, agent ID, node/parent node, task, adapter/profile/workspace/hash/lease, question, checkpoint/approval, knowledge job/update, model/thinking/tool/capability, attempt/operation, tokens/cost/time/budgets, terminal envelope refs/coverage.

No generic `planning`/`hive` team fields remain.

## Event/projection contract

- Versioned envelope from W09 with event ID, sequence/hash, correlation IDs.
- Projection ingestion idempotent by event ID and detects gaps/hash mismatches; never guesses.
- Structured metadata, bounded summaries/hashes/refs by default—not full transcripts/unrestricted tool args/results.
- Redact known credentials, auth headers, environment secret values, and protected-path content before global persistence.
- Project journals retain restart/audit-required content under bounds.
- Projection retention configurable/rebuildable; projection prune never deletes authoritative journals/open runs.
- Explicit journal prune is separate, authenticated, refuses nonterminal runs, and explains irrecoverability.

## Target modules

- `src/observability/events.ts`
- `src/observability/projection.ts`
- `src/observability/redaction.ts`
- new workflow-aware DB schema/migrations under Bun server path
- shared dashboard API DTOs

## Implementation plan

1. Define event-to-projection mapping and new DB schema/version from scratch.
2. Materialize current state plus historical events/usage without making DB runtime authority.
3. Implement rebuild from project journals/registry and incremental idempotent ingestion.
4. Detect/report sequence gaps/corruption and stop affected projection stream safely.
5. Implement field-level redaction before JSONL/global DB/log output; test secrets never land on disk.
6. Enforce payload/summary/page/query limits and stable pagination.
7. Separate estimated/provider-confirmed usage and change-coverage metadata.
8. Archive/ignore old files/schema with no destructive upgrade or dual reader.
9. Implement retention/prune boundaries and doctor status.
10. Produce generic API DTOs W25/W26 consume.

## Required tests

- Projection rebuild equals incremental result; duplicate events idempotent; gaps/hash corruption detected.
- Every required dimension and state transition materializes.
- No fixed mode/team/plan assumptions in new schema/API.
- Credential/header/env/protected-content redacted before file/DB; false-positive behavior bounded/documented.
- Transcript/tool payload omitted by default and pagination bounds.
- Retention/projection prune/rebuild; authoritative open journal untouched.
- Old telemetry preserved and not dual-read/migrated/deleted.
- Node/Bun boundary tests and large-history scale tests.

## Out of scope

- HTTP daemon/control endpoints (W25).
- Dashboard rendering (W26).
- Release migration docs (W27).

## Verification

- Telemetry/projection/DB/redaction/retention tests
- `just typecheck`
- `just test`
- `just test-db`
- `just verify`

## Completion checklist

- [ ] Projection is workflow-generic, idempotent, gap-detecting, and rebuildable.
- [ ] Journals remain runtime authority.
- [ ] Sensitive/raw content is redacted/omitted before global persistence.
- [ ] Retention cannot prune open authoritative state accidentally.
- [ ] Old telemetry is preserved but isolated.

## Handoff

Record event/DB/API schema versions, rebuild/ingestion commands, redaction rules/limits, retention/prune behavior, and W25 route DTOs.
