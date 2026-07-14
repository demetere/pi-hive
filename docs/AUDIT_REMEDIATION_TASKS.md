# pi-hive Audit Remediation Backlog

Status: **Open**  
Created: 2026-07-14  
Scope: Security, approval integrity, policy enforcement, reliability, observability, dashboard, testing, packaging, and documentation.

## Handoff rules

- Execute tasks in the listed order; later phases depend on earlier invariants and migrations.
- Start each cohesive remediation slice from a fresh branch off `main`.
- Size branches and pull requests by a logical, reviewable amount of work rather than by phase boundaries. A task may be one PR or several ordered PRs when needed.
- Open a PR once its coherent change, regression tests, and required checks are complete; do not accumulate an entire phase when smaller changes can land safely.
- Use capability-based branch names, commit messages, PR titles, and PR descriptions. Do not mention internal phase numbering in PRs.
- Land regression tests with every fix.
- Keep legacy migrations fail-closed: old approval data must never silently open execution.
- Run `just ci` after every completed remediation slice and keep `ui/web/dist/` committed after UI changes.
- Do not weaken the project opt-in rule: without `.pi/hive/hive-config.yaml`, register nothing.

## Baseline

- [x] `just ci` passes.
- [x] 147 Node tests pass.
- [x] 38 Bun tests pass.
- [x] Root and dashboard `npm audit` report zero vulnerabilities.
- [x] Dashboard build is fresh.
- [x] Package dry-run succeeds.
- [x] Repository was clean after the audit.

---

# Phase 0 — Invariants and decisions

## T00. Define security and compatibility invariants

- [x] Document that only a human interaction may create human approval.
- [x] Document that approval is valid only for an exact artifact content hash.
- [x] Define reviewer/lead read-only semantics, including test commands and Git operations.
- [x] Define symlink behavior for reads and writes.
- [x] Define whether same-user local processes are trusted by the dashboard.
- [x] Decide whether Windows is supported or explicitly unsupported.
- [x] Record baseline coverage, package size, and bundle size for regression checks.

**Done when:** `SECURITY.md` or an ADR states testable invariants and remaining accepted risks.

---

# Phase 1 — Critical security and integrity

## T01. Introduce canonical project identity

- [ ] Add a `ProjectIdentity` helper based on canonical `realpath` and Git root when available.
- [ ] Generate a stable project ID; keep the display label separate.
- [ ] Add `project_id` to telemetry and approval records.
- [ ] Change filter/delete endpoints to use project ID, not `projectName(cwd)`.
- [ ] Migrate existing session rows and project overrides.
- [ ] Test duplicate basenames, generic names, worktrees, non-Git roots, and Windows paths.

**Done when:** two projects named `app` cannot be merged, queried, or deleted together.

## T02. Centralize safe path containment

- [ ] Add shared path helpers using `path.relative`, not string-prefix checks.
- [ ] Resolve existing paths with `realpath`.
- [ ] For new files, resolve the nearest existing parent and reject symlink escapes.
- [ ] Replace containment logic in domain policy, distiller targets, OpenSpec artifacts, static assets, agent prompts, skills, and context refs.
- [ ] Add traversal, sibling-prefix, symlink, absolute-path, nonexistent-target, and Windows tests.

**Done when:** a symlink inside an allowed domain cannot read or mutate outside it.

## T03. Replace the project approval sidecar as authority

Recommended store: `~/.pi/agent/hive/approvals/<projectId>/<changeId>/`.

- [ ] Create a versioned approval record schema.
- [ ] Store automated review and human approval separately per artifact.
- [ ] Include project ID, canonical root, change ID, artifact ID, verdict, actor, timestamp, and artifact hash.
- [ ] Define hashes for proposal, design, tasks, and a stable sorted aggregate of `specs/**/*.md`.
- [ ] Require current automated-review hash before human approval.
- [ ] Require current human hashes for tasks and every upstream artifact before execution.
- [ ] Invalidate current and downstream approvals whenever content changes.
- [ ] Use atomic writes and avoid shared cross-process read-modify-write files.
- [ ] Treat `.pi-hive-approval.json` as untrusted legacy data.
- [ ] Require explicit human reapproval during migration.
- [ ] Propagate persistence failures instead of returning success.

**Regression tests:**

- [ ] Planner cannot forge approval with `write`, `edit`, or classified bash.
- [ ] Editing approved content closes the gate.
- [ ] Editing proposal invalidates downstream approvals.
- [ ] Concurrent agent/human writes do not lose data.
- [ ] Legacy sidecars do not open execution.
- [ ] Hashes remain stable across file enumeration order.

**Done when:** execution opens only for the exact content a human approved.

## T04. Secure review HTTP mutations

- [ ] Remove the pre-bearer bypass for review API routes.
- [ ] Add authenticated `POST /review-sessions` to mint a short-lived random review nonce.
- [ ] Bind nonce to project, change, artifact, and artifact hash.
- [ ] Require nonce on approve, deny, and feedback calls.
- [ ] Validate exact Host, Origin, and Referer origin/path; reject headerless mutations.
- [ ] Remove production behavior where an empty token disables authentication.
- [ ] Add request size, annotation count, and string-length limits.
- [ ] Return 400 for malformed input, 401/403 for auth, 409 for stale/not-ready review, and 500 for persistence failure.
- [ ] Ensure malformed feedback cannot default to denial.
- [ ] Add `Cache-Control: no-store` to credentials and review-session responses.

**Done when:** an unauthenticated forged-Referer request never invokes approval or denial hooks.

## T05. Correct bash and Git classification

- [ ] Replace “unknown means read” for read-only agent types.
- [ ] Define an explicit inspection-command allowlist for reviewer/lead.
- [ ] Classify `merge`, `rebase`, `cherry-pick`, `revert`, `reset`, `checkout`, `switch`, `stash`, `apply`, `am`, `clean`, and `restore` as repository mutations/history operations.
- [ ] Handle `git -C`, `--git-dir`, and `--work-tree`.
- [ ] Classify patch/archive/extraction/package-install commands.
- [ ] Deny ambiguous or pathless commands for reviewer/lead.
- [ ] Decide whether tests run in a disposable checkout or are explicitly considered mutating.
- [ ] Add an optional network capability and block worker access to the dashboard loopback API by default.
- [ ] Remove the test that calls `git merge` read-only.
- [ ] Add a table-driven adversarial command suite.

**Done when:** all mutating Git commands from the audit are blocked for reviewer/lead while `git status` and `git diff` remain usable.

## T06. Protect reserved paths and queue custom mutations

- [ ] Reserve approval records, telemetry/session files, daemon metadata, `.git/**`, `.env*`, private keys, and configured secret paths.
- [ ] Apply reserved-path policy before normal domain policy.
- [ ] Require explicit trusted override for exceptional access.
- [ ] Route `ask_user` records, agent-review writes, `plan_new`, OpenSpec writes, and mental-model writes through Pi's mutation queue.
- [ ] Use cross-process locks or separate records for dashboard writes.
- [ ] Update broad-read setup examples with secure default exclusions.

**Phase 1 gate:** all approval, shell-policy, and symlink regression tests pass.

---

# Phase 2 — Core reliability

## T07. Make worker cleanup unconditional

- [ ] Refactor `dispatchAgent()` around a reserved-slot lifecycle object.
- [ ] Put loader reload, session creation, subscription, prompting, usage collection, and disposal under one outer `try/finally`.
- [ ] On every failure: decrement `activeRuns`, clear timers/listeners, unsubscribe, abort/dispose, clear `runtime.session`, set error status, emit bounded terminal telemetry, and snapshot state.
- [ ] Block switching to normal mode while workers run, or implement explicit abort-and-drain.
- [ ] Clear pending orchestrator snapshot timers on shutdown.
- [ ] Cancel/ignore dashboard-start completion after shutdown.
- [ ] Track background distillers, serialize per target, prevent stale overwrite, and always emit `distill_end`.

**Tests:** loader failure, factory rejection, subscription failure, prompt failure, abort during setup, shutdown during setup, cleanup method failures, mode switch while active, concurrent distillers.

**Done when:** every injected failure ends with zero active runs and no live session/timer/listener.

## T08. Make JSONL ingestion complete and bounded

- [ ] Implement a reusable fixed-size chunked JSONL reader.
- [ ] Commit offsets only through the last complete newline.
- [ ] Retain partial trailing bytes for the next read.
- [ ] Keep event insertion and offset advancement in one transaction.
- [ ] Handle rotation, truncation, duplicate replay, corrupt complete lines, UTF-8 boundaries, and large records.
- [ ] Track corrupt-line count, pending-tail size, source lag, and last successful ingest in health output.

**Tests:** split an event at every byte boundary, partial multi-event tail, restart with partial tail, truncate/rewrite, duplicate replay, and bounded-memory large-log test.

**Done when:** every complete record is ingested exactly once and incomplete records remain pending.

## T09. Enforce strict configuration validation

- [ ] Validate complete raw settings before applying defaults.
- [ ] Reject unknown keys with path-aware errors.
- [ ] Require bounded positive integers for output limit, max parallelism, and conversation lines.
- [ ] Limit config size, agent count, tree depth, context refs, and total injected context bytes.
- [ ] Validate agent/context/skill/domain paths as project-relative by default; require explicit opt-in for outside paths.
- [ ] Require agent prompt paths to exist and be regular Markdown files.
- [ ] Validate duplicate names/slugs across both teams.
- [ ] Make truncation/tail/route/tool limits safe for NaN, infinity, and negative values.
- [ ] Add doctor diagnostics and malformed-config/property tests.

**Done when:** the invalid settings reproduction fails during config load with a precise message.

---

# Phase 3 — Planning architecture reconciliation

## T10. Define one canonical OpenSpec artifact model

- [ ] Create a shared artifact table with ID, display label, output path, dependencies, planner stage, review order, and hash strategy.
- [ ] Align runtime with `proposal`, `design`, `specs`, and `tasks`.
- [ ] Replace `requirements` stage with `specs`, or support it temporarily as a deprecated alias.
- [ ] Enforce planner ownership for `specs/**/*.md`.
- [ ] Remove or explicitly migrate `.pi/hive/plans/**` behavior.
- [ ] Update core types, policy, dispatch inference, OpenSpec adapter, UI, tests, README, and SETUP from the same model.
- [ ] Add dedicated planner and reviewer templates.
- [ ] Remove `approve_plan`; document `ask_user`.
- [ ] Add a trusted mechanism to mark execution tasks complete.

**Done when:** runtime, policy, tests, UI, README, and SETUP describe the same artifact graph and paths.

---

# Phase 4 — Daemon and browser security

## T11. Make daemon startup single-owner and version-aware

- [ ] Add a cross-process startup lock.
- [ ] Publish token/PID metadata only after successful bind and health readiness.
- [ ] Write metadata atomically with restrictive permissions.
- [ ] Add protocol version, package version, build hash, registry path, DB path, and startup nonce to `/health`.
- [ ] Refuse to adopt incompatible or wrong-registry daemons.
- [ ] Restart automatically after incompatible extension upgrades.
- [ ] Validate host/port and refuse non-loopback binding without explicit dangerous opt-in.
- [ ] Validate Host headers against configured origins.

**Test:** 20 concurrent startup calls produce one daemon and one matching token.

## T12. Replace unsafe PID killing and define lifecycle

- [ ] Never kill a process from PID file alone.
- [ ] Validate startup nonce/process identity or use an authenticated `/shutdown` endpoint.
- [ ] Remove `lsof` as the primary control mechanism.
- [ ] Choose and document idle-timeout or reference-counted shutdown behavior.
- [ ] Reconcile implementation with `AGENTS.md`.
- [ ] Ensure manual/dev startup always enables authentication.
- [ ] Update restart scripts and Justfile recipes.

**Done when:** a stale PID file cannot terminate an unrelated process.

## T13. Add browser security headers and review isolation

- [ ] Add CSP, `frame-ancestors 'self'`, nosniff, Referrer-Policy, COOP, and correct cache controls.
- [ ] Prevent cross-origin framing/clickjacking.
- [ ] Sandbox the review iframe or serve it from a constrained separate origin.
- [ ] Restrict CSP connections to the local dashboard.
- [ ] Test hostile Markdown, framing, Origin/Host validation, and DNS-rebinding-style requests.

---

# Phase 5 — Telemetry correctness, scale, and privacy

## T14. Make historical token/cost totals authoritative

- [ ] Derive totals from per-run worker deltas and per-message orchestrator usage, not active snapshots.
- [ ] Keep totals monotonic except during explicit pruning.
- [ ] Preserve totals across fresh runs, mode switches, reloads, restarts, and dead sessions.
- [ ] Add orchestrator usage projection to SQLite.
- [ ] Backfill existing events where possible; label unverifiable legacy totals.
- [ ] Update API/UI to use SQL historical totals.

**Tests:** fresh run after a larger prior run, planning→hive switch, reload, main model change, prune, and mixed legacy/delta rows.

## T15. Bound transcript and frontend event processing

- [ ] Add bounded tail readers for team conversation, distiller input, agent logs, and main logs.
- [ ] Add byte pagination and response-size limits.
- [ ] Materialize thinking incrementally instead of reparsing complete transcripts every five seconds.
- [ ] Cap frontend events with a ring buffer and load older rows from SQLite.
- [ ] Replace whole-map copies and full recomputation on every event.
- [ ] Handle SSE backpressure and paginate fleet-wide endpoints.

**Done when:** long sessions maintain bounded memory and stable response time.

## T16. Make SSE catch-up lossless

- [ ] Return `nextCursor`, `highWaterCursor`, and `hasMore`.
- [ ] Never advance past the last event actually ingested by the client.
- [ ] Remove the silent 100-page cutoff or surface incomplete sync.
- [ ] Ingest pages incrementally with retry/backoff.
- [ ] Keep UI status at `syncing` until the full gap is closed.
- [ ] Test gaps larger than 100,000 events.

## T17. Remove synchronous OpenSpec work from server requests

- [ ] Replace request-path `execFileSync` with async subprocess calls.
- [ ] Reuse validation within one detail request.
- [ ] Cache status/validation by content hash or mtime.
- [ ] Coalesce identical concurrent requests.
- [ ] Add timeout/cancellation and visible error states.

## T18. Add retention and privacy controls

- [ ] Add settings for telemetry enablement, dashboard auto-start, retention, maximum log size, thinking capture, and redaction.
- [ ] Add automatic DB pruning and source-log rotation/archive.
- [ ] Explain that DB prune does not delete project logs.
- [ ] Add guarded source-log deletion and optional export/backup.
- [ ] Redact credentials, authorization headers, tokens, and private keys before persistence.
- [ ] Create telemetry directories/files with restrictive permissions.
- [ ] Report DB and source-log storage separately.

## T19. Reduce Plannotator/package overhead

- [ ] Build/vendor a review-only bundle without unused features.
- [ ] Serve it compressed with ETag/content hash.
- [ ] Avoid full iframe reload for every artifact; consider persistent iframe + `postMessage`.
- [ ] Stream or use `Bun.file` instead of synchronous 22 MiB reads.
- [ ] Establish package and review-bundle size budgets.
- [ ] Remove `ui/web/src` from the package if it is not runtime-required, or include all reproducible build inputs.

---

# Phase 6 — Resource governance

## T20. Add worker budgets and queuing

- [ ] Add per-worker timeout, maximum delegation depth, maximum runs, token budget, cost budget, distiller budget, queue size, and concurrency settings.
- [ ] Replace immediate parallel-limit failure with a bounded fair queue where appropriate.
- [ ] Propagate cancellation through nested delegation.
- [ ] Emit budget warning/exhaustion events.
- [ ] Display remaining budget in team status, TUI, and dashboard.
- [ ] Add timeout, queue fairness, nested cancellation, and budget-exhaustion tests.

---

# Phase 7 — Frontend and accessibility

## T21. Make dashboard interaction accessible

- [ ] Replace clickable rows/divs with semantic controls where possible.
- [ ] Add roles, tab index, Enter/Space handling, and labels where custom controls remain.
- [ ] Add `type="button"` to non-submit buttons.
- [ ] Add consistent dialog semantics, focus traps, focus restoration, and Escape behavior.
- [ ] Make tabs, sorting, filters, replay controls, and topology keyboard-operable.
- [ ] Add reduced-motion support and verify contrast.
- [ ] Replace silent empty fallbacks with visible error/retry states.

**Done when:** axe reports no serious/critical issues and core workflows work keyboard-only.

---

# Phase 8 — Tests and type safety

## T22. Add missing integration suites

- [ ] Extract the HTTP handler from top-level `Bun.serve()` for direct tests.
- [ ] Test every route, method, auth state, malformed parameter, and size limit.
- [ ] Add command tests for mode switching, execution, dashboard lifecycle, and pruning.
- [ ] Add extension session start/shutdown and worker-drain tests.
- [ ] Add React Testing Library tests.
- [ ] Add Playwright tests for Overview, Plans/review, Sessions, Settings, delete/prune, and SSE reconnect.
- [ ] Add axe checks.

## T23. Enforce coverage

- [ ] Set initial gates: overall lines ≥85%, branches ≥80%, critical security/state modules ≥90%.
- [ ] Prioritize server runtime, agent-log, review, dashboard process control, commands/hooks, and dashboard store/components.
- [ ] Publish coverage artifacts in CI.

## T24. Strengthen TypeScript and linting

- [ ] Add separate strict configs for core, Bun server, dashboard, and tests.
- [ ] Typecheck Bun specs with Bun types.
- [ ] Replace permissive runtime shims where real types exist.
- [ ] Reduce unsafe `any` in DB mappings, hook events, telemetry payloads, and frontend store.
- [ ] Share runtime API schemas between server and client.
- [ ] Add ESLint or Biome, formatting checks, floating-promise rules, exhaustive switches, hooks rules, and justified-catch rules.

---

# Phase 9 — CI, dependencies, packaging, and release

## T25. Make CI deterministic and safer

- [ ] Pin setup-bun to a commit SHA.
- [ ] Replace unversioned `curl | bash` Just installation with a pinned/checksummed method.
- [ ] Add timeouts and concurrency cancellation.
- [ ] Test Node 20.19.x plus current LTS/current.
- [ ] Test the minimum supported Bun or raise the declared minimum.
- [ ] Align Node engine with OpenSpec's `>=20.19.0` requirement.
- [ ] Add npm audit/OSV, Dependabot/Renovate, and CodeQL.

## T26. Verify generated and vendored artifacts

- [ ] Build dashboard in CI and require `git diff --exit-code ui/web/dist`.
- [ ] Verify vendored Plannotator hash/version against the lockfile package.
- [ ] Fail when dependency version changes without vendor refresh.
- [ ] Add package allowlist and package-size regression checks.

## T27. Add third-party licensing

- [ ] Add `THIRD_PARTY_NOTICES.md`.
- [ ] Include required Plannotator attribution/license.
- [ ] Document Hanken Grotesk and DM Mono license/provenance.
- [ ] Ship notices in the package and add a license scan.

## T28. Upgrade dependencies after regression coverage exists

- [ ] Update Pi coding agent/TUI patch versions.
- [ ] Update TypeBox patch version.
- [ ] Update OpenSpec 1.5.x → 1.6.x with contract tests.
- [ ] Update Plannotator 0.21.x → 0.23.x and rebuild vendor output.
- [ ] Keep React/Vite/Tailwind major migrations in separate PRs.
- [ ] Run audit, package-size, and browser tests after each upgrade.

## T29. Harden release publishing

- [ ] Use a protected GitHub environment.
- [ ] Prefer npm trusted publishing/OIDC over a long-lived token.
- [ ] Make direct local publish run typechecks and Bun tests.
- [ ] Verify tag, package version, build hash, vendor hash, and clean Git state.
- [ ] Generate an SBOM/dependency manifest and maintain release notes.

---

# Phase 10 — Documentation

## T30. Reconcile README, SETUP, comments, and package metadata

- [ ] Replace Solid with React.
- [ ] Replace subprocess worker descriptions with in-process AgentSession behavior.
- [ ] Replace `.pi/hive/plans/**` with `openspec/changes/**`.
- [ ] Use the canonical proposal/design/specs/tasks model.
- [ ] Remove `/hive-status` and `approve_plan`.
- [ ] Document `/hive-observe-prune` and `ask_user`.
- [ ] Add planner and reviewer templates.
- [ ] Correct lead templates that imply writes blocked by type policy.
- [ ] Document daemon lifecycle, auth, loopback binding, retention, and privacy.
- [ ] Replace “physically cannot edit” with accurate enforcement/accepted-risk language.
- [ ] Document supported operating systems.
- [ ] Fix stale Justfile and `.gitignore` command references.
- [ ] Add a command/tool documentation consistency test.

---

# Phase 11 — Final release gate

## T31. Run end-to-end acceptance

- [ ] `just ci`
- [ ] Minimum Node/Bun matrix
- [ ] Approval/security regression suite
- [ ] Symlink and Windows-path suite
- [ ] Concurrent daemon and approval tests
- [ ] Partial JSONL tests
- [ ] Cost/accounting migration tests
- [ ] Playwright and axe suites
- [ ] Audit/OSV/CodeQL and license checks
- [ ] Dashboard/vendor freshness and package-size checks
- [ ] `npm pack --dry-run`
- [ ] Install the packed tarball into a clean Pi environment
- [ ] Verify non-opted projects register nothing
- [ ] Verify plan → automated review → human approval → execute
- [ ] Verify artifact mutation invalidates approval
- [ ] Verify daemon restart/adoption and session shutdown
- [ ] Confirm final Git tree is clean

## Release-blocking minimum

The following must be completed before claiming hard enforcement or approval guarantees:

- [ ] T02 Safe path containment
- [ ] T03 Approval authority and content hashes
- [ ] T04 Review API authentication
- [ ] T05 Bash/Git policy
- [ ] T07 Worker cleanup
- [ ] T08 Lossless JSONL ingestion
- [ ] T09 Settings validation
- [ ] T10 OpenSpec reconciliation
- [ ] Regression tests for all of the above
