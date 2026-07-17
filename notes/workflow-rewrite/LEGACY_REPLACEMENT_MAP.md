# Legacy Replacement Map

This is the rewrite ownership ledger. Legacy code remains active until the W27 cutover; an earlier replacement task proves its new invariant but does not authorize premature deletion. Every row has one primary owner, with prerequisites and cleanup called out separately.

| Legacy family | Current evidence | Primary replacement owner | Dependencies / supporting owners | Final deletion or cutover |
|---|---|---|---|---|
| Config, YAML, schema, normalization, and types | `src/core/config.ts:loadConfig`, `teamForMode`; `src/core/types.ts:HiveMode`, `AgentType`, `HiveTeam`, `HiveConfig`; `src/core/yaml.ts`, `schema.ts`, `config-validation.ts`, `normalize.ts`, `agent-tree.ts`, `agent-type-audit.ts`; config/YAML/schema/audit tests | W01 schema/parser | W02 manifest; W03 catalogs; W04 resolver; W05 snapshots | W27 |
| Extension opt-in and project discovery | `index.ts` manifest guard; `tests/activation.test.ts`; `src/shared/project.ts`, `src/core/fs.ts`, `safe-path.ts` | W02 nearest-manifest discovery | W00 freezes the no-config guard; W07 consumes safe paths | W27 entrypoint switch; guard remains |
| Shared project identity | `src/shared/project-identity.ts`; `tests/project-identity.test.ts`, `project-identity-db.spec.ts` | W02 canonical project identity | W24 projection identity | W27 old identity adapters |
| Core constants, formatting, prompting, usage, and utilities | `src/core/constants.ts`, `format.ts`, `prompting.ts`, `usage.ts`, `utils.ts`; limits/format/usage tests | W05 resolved snapshot/serialization foundation | W13 usage/accounting; W14 prompt/output bounds | W27 |
| File locking | `src/core/file-lock.ts`; `tests/file-lock.test.ts` | W09 journal/runtime ownership | W17 workspace leases | W27 obsolete lock protocol |
| Mode and session state | `src/engine/state.ts`, `session.ts`; `src/ui/tui/widget.ts:applyMode`; modes/session lifecycle/branch tests | W09 journal and ownership | W10 linked sessions; W11 run lifecycle/navigation | W27 |
| Integration hooks and lifecycle wiring | `src/integration/hooks.ts`; orchestrator hook and session lifecycle tests | W10 linked-session hooks | W11 lifecycle; W27 entrypoint cleanup | W27 |
| Semantic policy, domain, and file classification | `src/engine/policy.ts` type tables; `domain.ts`, `file-class.ts`, `glob.ts`, `reserved-paths.ts`; policy/domain/safe-path/security tests | W06 capability resolution | W07 filesystem/globs; W08 shell/Git/network | W27 |
| Process and worker enforcement | `src/engine/process.ts`, `worker-extension.ts`; process/worker/security tests | W08 shell/Git/network enforcement | W07 filesystem policy; W14 worker tool surface | W27 |
| Dispatch, lookup, routing, and governance | `src/engine/dispatch.ts:dispatchAgent`, `routing.ts:routeAgents`, `agent-lookup.ts`, `governance.ts`; dispatch/domain-routing/governance tests | W12 scheduler and delegation | W10/W11 runtime; W13 budgets/recovery/accounting | W27 |
| Agent tools and prompts | `src/agents/tools.ts:registerTools`, `prompts.ts`, `role-templates.ts`; `src/engine/prompts.ts`; tool/prompt tests | W14 generic tools/prompts | W16 artifact facade; W21 human input; W22 knowledge tools | W27 |
| Doctor and diagnostics | `src/engine/doctor.ts`; `tests/doctor.test.ts` | W02 dependency diagnostics | W04 resolver; W25/W26 API and presentation | W27 command cutover |
| OpenSpec, SDD, and review gates | `src/engine/openspec.ts`, `sdd.ts`, `review.ts`; `src/shared/openspec-artifacts.ts`; OpenSpec/verdict/review/artifact and plan suites | W19 OpenSpec adapter | W16 adapter contract; W17 workspace; W18 approvals | W27 |
| Durable questions | `src/engine/questions.ts`; question tools/dashboard bridge; `tests/questions.test.ts` | W21 | W14 generic tool wiring; W25/W26 surfaces | W27 |
| Mental model and distiller | `src/core/mental-model.ts`; `src/engine/dispatch.ts:distillMentalModel`; config distiller fields/events/tests | W22 OKF retrieval | W23 enrichment/curation | W27 |
| Engine observability and project event logs | `src/engine/observability.ts`, `src/observability/agent-log.ts`; observability-agent-log and telemetry tests | W24 telemetry/projection | W09 journal source; W25 server | W27 old-schema isolation |
| Privacy, telemetry, and shared dashboard DTOs | `src/shared/privacy.ts`, `telemetry.ts`, `dashboard-api.ts`, `daemon-protocol.ts`; privacy/dashboard/runtime suites | W24 event/redaction/projection schema | W25 daemon/API protocol | W27 old DTO removal |
| Dashboard startup and static assets | `src/engine/dashboard.ts`, `src/observability/static.ts`; dashboard/static/path tests | W25 daemon/server | W26 command/UI integration | W27 |
| Dashboard daemon, database, ingestion, SSE, and HTTP security | `src/observability/security.ts`, `src/observability/server/config.ts`, `db.ts`, `http-handler.ts`, `index.ts`, `jsonl-reader.ts`, `runtime.ts`, `sse.ts`, `topology-hash.ts`, `types.ts`; all Bun DB/runtime/server/SSE/security tests | W25 | W24 projection/event contract | W27 obsolete schema/routes |
| Fixed plan/review server routes | `src/observability/server/plan-routes.ts`, `plan-bridge.ts`, `review-wiring.ts`; plan bridge/DB/server and review-security suites | W25 generic authenticated controls | W18 approval service; W21 questions; W26 UI | W27 dead route removal |
| TUI, commands, and activity UI | `src/ui/tui/activity.ts`, `widget.ts`; `src/integration/commands.ts`; mode/command/dashboard helper tests | W26 | W10/W11 session/run commands; W25 API | W27 dead fixed-mode UI removal |
| Dashboard web application | `ui/web/src/**`, including plan/history/status stores and components; Vitest/Playwright suites | W26 | W24 projection; W25 API | W27 old views; W28 verifies build |
| Review-only embedded UI | `ui/review/src/**`, `ui/review/dist/**`, vendor/build verification and review tests | W26 | W18 approvals; W25 authenticated serving | W27 final integration; W28 verifies |
| Documentation, examples, and package metadata | `README.md`, `SETUP.md`, `SECURITY.md`, `CHANGELOG.md`, `package.json`; documentation/package/release tests | W27 | All earlier contract owners provide facts | W27 |
| Generated dashboard/review assets and release scripts | `ui/web/dist/**`, `ui/review/dist/**`, `scripts/**`, freshness/package/budget checks | W27 final rebuild/package cutover | W26 owns dashboard source changes | W28 verification |

## Config replacement, switch, and deletion proof sequence

The config row uses this ordered proof; coexistence is not deletion permission:

1. **Replacement contract:** W01 adds schema-v1 parser/schema tests against `tests/fixtures/workflow-configs/**` while all existing `tests/config.test.ts`, `tests/yaml.test.ts`, `tests/schema-branches.test.ts`, and `tests/activation.test.ts` legacy invariants remain green.
2. **Resolved replacement:** W02–W05 add nearest-manifest, catalog, workflow-resolution, and immutable-snapshot conformance tests. Their final integration test loads `combined-delivery`, `split-plan-build`, and `artifact-free-debug`, quarantines the standalone invalid fixtures by owner, and proves the no-config activation guard before any entrypoint switch.
3. **Switch proof:** W27 changes `index.ts` to call only the schema-v1 discovery/resolution path. A focused entrypoint integration test must be red against the legacy call, green after the switch, and prove that `loadConfig`/`teamForMode` are not invoked for schema-v1 activation while no-config still registers nothing.
4. **Deletion proof:** only after the switch test and full verification are green may W27 delete legacy `src/core/config.ts` loading, `src/core/yaml.ts`, legacy config/type branches, and their superseded assertions. Replacement conformance tests stay; no compatibility loader is introduced.
5. **Absence proof:** W27 records a repository search showing no runtime references to `loadConfig`, `teamForMode`, `HiveConfig.hive`, `HiveConfig.planning`, `HiveTeam.main`, or the YAML-lite parser, then runs the schema-v1 focused suite and `just ci`. W28 independently reruns the release gate.

## Coverage rule

When a later task finds a legacy symbol or test without an owner, it updates this map before changing or deleting that behavior. W27 may delete a row's legacy implementation only after the replacement owner's conformance tests and all listed supporting contracts are green.
