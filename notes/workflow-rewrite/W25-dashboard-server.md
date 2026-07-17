# W25 — Rewrite Dashboard Daemon, APIs, and Control Security

Status: **Not started**  
Depends on: W24  
Blocks: W26

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Rewrite the shared local dashboard server around generic workflow projection and authenticated control events. Preserve local-only, bounded, offline approvals/questions/knowledge decisions, explicit teardown/idle timeout, and strict separation from model/runtime ownership.

## Design authority

- Design Sections 13.5, 15.4, 18, 19.1, 25.2
- Dashboard observes/controls exact pending objects; it does not edit/launch workflows or execute models

## Current touchpoints to inspect

- `src/observability/server/*`, `src/observability/security.ts`, `src/engine/dashboard.ts`
- `src/shared/daemon-protocol.ts`, `src/shared/dashboard-api.ts`
- current plan/review routes/bridge/wiring and daemon lifecycle/security/SSE/server tests

## Required lifecycle

- Default bind `127.0.0.1:43191`.
- Startup config: session, workflow (default first selection), or manual.
- Never start long-lived process from extension factory.
- Shared daemon may survive Pi briefly for offline control, has authenticated explicit teardown and bounded idle timeout.
- Daemon never owns workflow runtime or executes models.
- Bun-specific implementation stays server-side; core loads without Bun.

## Required security

- High-entropy local secret, owner-only storage; never URL/log/prompt/telemetry.
- Authentication on writes and protected reads as defined.
- Origin checks, browser CSRF protection, bounded bodies, content types, replay-safe operation IDs, timing-safe token checks.
- Exact project/session/run/object IDs and expected state/digest CAS for approval/question/curation writes.
- Loopback only; no private/non-loopback binding in first release.
- CSP/security headers; no custom adapter/workflow frontend code.
- Pagination/rate/buffer/backpressure bounds.

## API scope

Read: workflows, invalid diagnostics, sessions, runs, topology/tasks/activity, usage, artifacts/checkpoints, questions, approvals, knowledge jobs/proposals, daemon health/version.

Write: exact approve/deny checkpoint digest, answer question, approve/deny knowledge proposal, authenticated maintenance/teardown/prune where allowed. No workflow selection/launch/config editing/prompt/capability mutation.

## Implementation plan

1. Version daemon protocol/API against W24 DTOs; reject incompatible clients clearly.
2. Replace plan-specific routes/bridges with generic resource routes and cursor pagination.
3. Route writes to W09 short journal control append with W18/W21/W23 validators; never mutate DB as authority.
4. Implement offline append and runtime catch-up without model daemon.
5. Harden auth/CSRF/origin/replay/body/CSP/SSE/backpressure.
6. Implement startup ownership/single daemon/version awareness and safe PID/process validation.
7. Implement idle timeout/teardown and stale registry cleanup without killing unrelated processes.
8. Keep static committed dashboard serving and bounded cache headers.
9. Remove old route compatibility only at W27, but new server tests must not use plan semantics.

## Required tests

- Startup modes, no factory daemon, single owner/version conflict, stale PID, explicit teardown, idle timeout.
- Loopback binding and secret permissions/non-leakage.
- Auth/origin/CSRF/content-type/body/replay/timing-safe mutation tests.
- Every read route pagination/bounds/redaction.
- Every control write exact expected state/digest and first-valid CAS.
- Offline control event persists; no model/runtime starts; owning session later catches up.
- SSE lossless catch-up/backpressure/slow client bounds.
- Protocol mismatch and Bun/core import isolation.

## Out of scope

- React/TUI views (W26).
- Workflow launch/config editing.
- Third-party telemetry or remote binding.

## Verification

- `just test-db`
- server/security/daemon/SSE/protocol tests
- `just typecheck-bun`
- `just verify`

## Completion checklist

- [ ] Daemon is local/authenticated/bounded and never model authority.
- [ ] Generic APIs contain no plan/hive assumptions.
- [ ] Offline controls append authoritative journal events safely.
- [ ] Security and process lifecycle withstand replay/stale PID/slow client cases.
- [ ] Core remains Bun-independent.

## Handoff

Record protocol/API versions, route/control schemas, auth secret location, process/idle lifecycle, SSE pagination/backpressure, and old server files W27 removes.
