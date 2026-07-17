# W26 — Rewrite Dashboard UI, TUI, and Command Surfaces

Status: **Not started**  
Depends on: W25  
Blocks: W27

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Deliver the user-facing generic workflow experience: selector and linked-session navigation, selected-workflow status widget, all first-release commands, generated dashboard views, approval/question/knowledge controls, and no fixed mode/plan UI assumptions.

## Required Pi/UI documentation

Before implementation, read the installed Pi docs completely for extensions, TUI components, commands, keybindings, session navigation, and SDK APIs, following referenced examples. Guard TUI behavior with `ctx.mode === "tui"` and user interaction with `ctx.hasUI`.

## Design authority

- Design Sections 10.5–10.8, 13.3–13.5/13.10, 18, 19, 22.6–22.7
- Dashboard is not workflow editor/launcher; selection happens through Pi command/TUI

## Current touchpoints to inspect

- `src/integration/commands.ts`, `src/integration/hooks.ts`
- `src/ui/tui/activity.ts`, `src/ui/tui/widget.ts`
- `ui/web/src/**`, shared dashboard API, current plan/topology views
- command/dashboard/unit/e2e/accessibility tests

## Command surface

Implement exactly:

- `/hive:select [workflow-id] [--fresh] [--from <run-id|last>]`
- `/hive:status`
- `/hive:exit`
- `/hive:cancel [reason]`
- `/hive:reload`
- `/hive:checkpoints [<checkpoint-id> on|off]`
- `/hive:answer <question-id> [value]`
- `/hive:handoff-clear`
- `/hive:recover <orphan-session-id>`
- `/hive:doctor [--json]`
- `/hive:observe`, `/hive:observe-stop`, `/hive:observe-prune`

Respect idle/open-run rules from the design. Invalid state/args produce bounded diagnostic and no partial state.

## Selector/TUI requirements

- Searchable selector shows ID/name, description, use/avoid hints, tags, adapter/profile, active/archive/stale/orphan state, and concise invalid diagnostics.
- Invalid cannot create fresh activation; compatible stored activation may resume.
- No automatic selection/routing and no keyboard mode-cycle shortcut.
- No widget in normal chat. Selected workflow widget shows workflow/run/workspace/tasks/questions/approvals/budget summary without flooding.
- TUI checkpoint/answer/approval actions use exact service CAS/provenance.

## Dashboard views

Workflows; sessions; runs; recursive topology/tasks; activity; cost/usage/model mix; artifacts/checkpoints/evidence; pending questions/approvals; knowledge bundles/jobs/proposals. Use generic components and adapter bounded view DTO only. No injected React/HTML.

## Implementation plan

1. Wire commands to W10–W25 services; no command reimplements state transitions.
2. Replace fixed mode widget/cycle with selector/status components.
3. Implement headless behavior: bounded list/help, explicit values where no UI, dashboard-required approval constraints.
4. Rewrite shared API client/types and React routes/components around W24/W25 DTOs.
5. Add accessible keyboard/focus/status/error behavior and responsive large-topology pagination/virtualization.
6. Implement exact digest/ID controls for approvals/questions/knowledge proposals.
7. Remove plan-specific UI imports/routes from new entry path; W27 deletes dead files.
8. Run dashboard build and commit `ui/web/dist/`.

## Required tests

- Every command valid/invalid state, headless/TUI behavior, no partial changes.
- Selector search/status/stale/invalid/fresh/from/resume behavior.
- Normal chat no widget; workflow widget bounded and restored by session.
- Dashboard route/component tests for all generated views/control races/errors/redaction/pagination.
- Keyboard-only and axe no serious/critical issues.
- Large topology/history stable rendering and SSE updates.
- No dashboard workflow launch/config edit or arbitrary frontend injection.
- Committed dist matches source.

## Verification

- Command/TUI tests
- `just dashboard-typecheck`
- `just dashboard-test-unit`
- `just dashboard-test-e2e`
- `just dashboard-build`
- `just dashboard-verify`
- `just verify`

## Completion checklist

- [ ] User can select a workflow, chat across runs, hand off, exit, reload, recover, and inspect status.
- [ ] Normal chat remains quiet and no mode-cycle UI remains.
- [ ] Dashboard is generic observation/control only.
- [ ] All controls bind exact IDs/digests and are accessible/bounded.
- [ ] Committed dashboard bundle is fresh.

## Handoff

Record command parser/service mapping, TUI component lifecycle, dashboard routes/components/API version, accessibility results, generated bundle hash, and dead legacy UI W27 removes.
