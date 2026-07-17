# W27 — Cut Over Extension, Remove Legacy Architecture, and Document Migration

Status: **Not started**  
Depends on: W26  
Blocks: W28

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Make schema-v1 config-first workflows the only production runtime, remove fixed modes/teams/types/stages/tools/prompts/telemetry compatibility paths, update package major and all user documentation/examples, and leave a complete passing release candidate.

## Design authority

- Design Sections 22–25 and final architectural position
- Clean break: no loader compatibility for old `planning:`/`hive:` config, no old telemetry dual reader, no automatic mental-model migration

## Current touchpoints to inspect

- Entire `LEGACY_REPLACEMENT_MAP.md`; every entry must have new owner or explicit removal
- `index.ts`, old core/engine/agents/integration/observability/UI modules
- all tests containing HiveMode, plan/hive teams, AgentType, stages, OpenSpec global commands, plan routes/views, mental-model YAML
- `README.md`, `SETUP.md`, `SECURITY.md`, package metadata, examples, release notes, committed dist

## Required cutover behavior

- Extension factory checks nearest opt-in manifest and registers nothing if absent.
- Configured new top-level session starts normal/quiet with lightweight commands.
- Old config fails with clear schema-version/manual migration diagnostic; never silently maps to workflows.
- New linked workflow runtime/services are the only command/tool/hook path.
- No fixed `normal|plan|hive` state machine, dual teams, semantic agent types, planner stages, type policy, phase routing, global OpenSpec mode/tools, fixed plan dashboard routes, or old mental-model runtime remains.
- Old telemetry files/DB preserved/archived but not read into new projection.
- Bun remains isolated; dashboard dist committed; package entrypoint/peer dependencies obey AGENTS.

## Implementation plan

1. Switch `index.ts` and integration registration to new discovery/config/session/runtime/commands.
2. Remove temporary coexistence adapters and every legacy path assigned in replacement map.
3. Delete or rewrite legacy tests; preserve valuable security/reliability invariants against new APIs. Do not lower coverage gates to ease deletion.
4. Add complete checked-in example configs:
   - combined OpenSpec delivery;
   - split plan/build handoff;
   - Markdown plan author/execute;
   - artifact-free debug/chat;
   - invalid diagnostics examples where useful.
5. Rewrite README/SETUP command/config/tutorial sections around select-and-chat semantics, combined versus split guidance, capabilities, adapters, handoff, approvals/questions, knowledge, dashboard, and accepted non-sandbox limits.
6. Add manual breaking migration guide: old keys/types/tools/commands/mental model/telemetry behavior and how to author new files. No automatic converter claim.
7. Update package major/release notes/schema/editor assets/package contents.
8. Search repository for legacy symbols/phrases and classify every remaining occurrence as migration history/accepted test fixture or remove it.
9. Rebuild dashboard/review generated assets as needed.
10. Run full CI/package install smoke in configured and unconfigured projects.

## Required tests

- Unconfigured packed install loads with zero registrations and no daemon/files.
- New examples validate and run end-to-end through selection/chat/finish/handoff.
- Old config fails clearly with no partial runtime/telemetry mutation.
- Repository-wide tests assert no semantic name/type/mode behavior.
- Normal tool baseline restoration and all linked-session lifecycle.
- Package contents include schemas/examples/dashboard dist and exclude node_modules/runtime sessions/logs/db/tgz/swap files.
- Old telemetry preserved during upgrade but not displayed in new DB.

## Required searches

Search source/tests/docs/package for at least:

`HiveMode`, `teamForMode`, `plan-mode`, mode cycle, `AgentType`, `agent-type`, planner `stages`, `planning:`, `hive:`, old `plan_*` tools/routes/tables, semantic type-policy helpers, mental-model YAML/distiller, fixed phase prompts. Every hit must be intentional and documented.

## Verification

- `just dashboard-build`
- `just generated-verify`
- `just verify`
- `just pack-dry-run`
- `just verify-packed-install`
- `just ci`

## Completion checklist

- [ ] Production loads only schema-v1 workflow architecture.
- [ ] Legacy runtime/compatibility branches are removed.
- [ ] All examples/docs/migration/release metadata are current.
- [ ] Package/global-install safety and Bun isolation pass.
- [ ] Legacy search has no unexplained hit.
- [ ] Full `just ci` passes with committed generated assets.

## Handoff

Record package/schema versions, removed modules/commands, retained historical fixture hits, migration guide location, example paths, CI/package results, and any release blocker W28 must resolve.
