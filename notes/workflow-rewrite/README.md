# Config-First Workflow Rewrite — Execution Backlog

Status: **In progress**  
Created: 2026-07-16  
Design authority: [`docs/WORKFLOW_ARCHITECTURE_DESIGN.md`](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md)  
Scope: Clean breaking rewrite from fixed `normal | plan | hive` modes to the config-first workflow architecture.

## Purpose

This directory turns the architecture design into ordered, reviewable implementation tasks. Each `Wxx` file is intended to give a fresh agent enough context to execute that task without rediscovering the overall architecture or silently inventing a competing design.

The task files are implementation instructions, not an alternative design. If a task conflicts with `docs/WORKFLOW_ARCHITECTURE_DESIGN.md`, the design document wins and the task must be corrected before code is changed.

## Mandatory execution protocol

1. Execute tasks strictly in numeric order. Do not start a later task because it looks independent; later contracts assume earlier types, persistence, and invariants exist.
2. Read this README, the assigned `Wxx` file, the design sections listed in that file, `AGENTS.md`, and every current source/test file named by the task before editing.
3. Inspect the working tree first. Preserve unrelated changes and never delete another contributor's untracked files.
4. Follow strict test-driven development for every executable behavior: write the smallest failing test first, run it and confirm it fails for the expected behavioral reason, implement only enough production code to pass, then refactor while green. Never implement behavior first and add tests afterward.
5. Keep each task cohesive and reviewable. If it cannot be completed safely in one change, split it into ordered subtasks inside the same `Wxx` file and finish them before advancing.
6. Add or rewrite tests in the same task as behavior. Every bug discovered during implementation gets a failing regression test before the fix. Do not defer regression coverage to W28, weaken an assertion to make code pass, or remove a legacy test before its replacement invariant is red then green.
7. Keep the existing runtime passing while new modules are built in parallel. The permanent cutover happens in W27. Temporary coexistence is allowed only as development scaffolding; do not ship a compatibility loader for old `planning:`/`hive:` config.
8. Do not add hidden feature flags, semantic workflow-name checks, planner/coder bonuses, raw-tool allowlists in config, or adapter-owned orchestration.
9. After implementation, run the task's targeted checks and `just verify`. Run `just dashboard-build` whenever `ui/web/src/**` changes. Run `just ci` at W27 and W28, and before any publish/tag.
10. Update the task file's status and completion checklist only after all required checks pass. Record the red test command/failure and green test command/result, plus materially important follow-up facts, in its Handoff section.
11. Do not begin the next task with a failing tree, unexplained generated diff, unresolved migration, or undocumented accepted risk.

## Global non-negotiable invariants

Every task must preserve these rules even when they are not repeated in every bullet:

- Without `.pi/hive/hive-config.yaml`, the extension registers **nothing**.
- In an opted-in project, normal chat remains quiet until explicit workflow selection.
- Core extension modules remain Node-compatible. Bun-specific code stays in dashboard/server paths.
- Long-lived processes never start from the extension factory.
- TUI behavior is guarded by `ctx.mode === "tui"`; prompts/notifications are guarded by `ctx.hasUI`.
- Custom tool file mutations use Pi's file mutation queue.
- Tool, journal-query, telemetry, and dashboard outputs are bounded and paginated.
- Capabilities default deny, workflow overlays only narrow, and unknown authority-bearing values fail closed.
- This is policy enforcement, not an OS sandbox. Do not claim hostile-code containment, complete network denial, exactly-once arbitrary effects, or DLP.
- No workflow name has runtime meaning. Planning, building, debugging, and review are config data.
- Adapters own artifact lifecycle only. They never invoke models, route/delegate agents, or mutate outside their workspace.
- Sessions/journals are runtime authority; the global SQLite database is a rebuildable projection.
- Handoffs are explicit, immutable, bounded, same-project, one-shot, and authority-free.
- Do not add AI attribution to commits, PRs, docs, package text, or release notes.

## Definition of a completed W task

A task is complete only when:

- its outcome and every in-scope requirement are implemented;
- each behavior was developed red → green → refactor, with the expected failing test observed before its production implementation;
- obsolete behavior within that task's ownership is removed or explicitly marked for W27 with no active dual semantics;
- required unit/integration/fault tests pass;
- affected docs, fixtures, schemas, and generated artifacts are current;
- `just verify` passes, unless the task file explicitly requires the stronger `just ci`;
- no TODO/FIXME/debug log or unexplained temporary branch remains;
- the task's Handoff section explains new public/internal contracts, migrations, and any risk that the next task must know.

## Ordered task index

| Task | Title | Depends on | Status |
|---|---|---|---|
| [W00](W00-contract-baseline.md) | Freeze executable contracts and rewrite baseline | — | Complete |
| [W01](W01-schema-yaml.md) | Add schema-v1 types, strict YAML, and generated schemas | W00 | In progress |
| [W02](W02-manifest-registry.md) | Implement project discovery, manifest registries, and diagnostics | W01 | Not started |
| [W03](W03-catalog-loaders.md) | Implement agent, skill, and knowledge catalog loaders | W02 | Not started |
| [W04](W04-workflow-resolver.md) | Implement workflow/team resolution and budgets | W03 | Not started |
| [W05](W05-activation-snapshots.md) | Implement immutable activation snapshots and stale-source behavior | W04 | Not started |
| [W06](W06-capability-resolution.md) | Implement capability narrowing and tool derivation | W05 | Not started |
| [W07](W07-filesystem-policy.md) | Rewrite filesystem and reserved-path enforcement | W06 | Not started |
| [W08](W08-shell-git-network-policy.md) | Rewrite shell, Git, and network enforcement | W07 | Not started |
| [W09](W09-journal-ownership.md) | Build journal, checkpoint, and runtime ownership foundations | W08 | Not started |
| [W10](W10-linked-sessions.md) | Implement linked workflow sessions and selection/navigation | W09 | Not started |
| [W11](W11-run-lifecycle.md) | Implement chat/run state, finish, pause, and cancellation | W10 | Not started |
| [W12](W12-delegation-scheduler.md) | Implement delegation tasks, scheduler, and worker transcripts | W11 | Not started |
| [W13](W13-budgets-recovery-accounting.md) | Implement budgets, retries, side-effect recovery, and change accounting | W12 | Not started |
| [W14](W14-prompts-tools.md) | Implement deterministic prompts and generic tools | W13 | Not started |
| [W15](W15-handoff-reload-recovery.md) | Implement handoff, reload, archive, and orphan recovery | W14 | Not started |
| [W16](W16-adapter-contract-none.md) | Build artifact adapter contracts, registry, facade, and `none` | W15 | Not started |
| [W17](W17-workspace-leases.md) | Implement workspace binding, leases, hashes, and idempotency | W16 | Not started |
| [W18](W18-approvals.md) | Implement generic checkpoint approvals | W17 | Not started |
| [W19](W19-openspec-adapter.md) | Port OpenSpec into adapter profiles | W18 | Not started |
| [W20](W20-markdown-plan-adapter.md) | Implement Markdown-plan adapter profiles | W19 | Not started |
| [W21](W21-human-questions.md) | Implement durable human questions and answer races | W20 | Not started |
| [W22](W22-okf-retrieval.md) | Implement OKF catalogs, attachments, and local retrieval | W21 | Not started |
| [W23](W23-knowledge-enrichment.md) | Implement durable knowledge enrichment | W22 | Not started |
| [W24](W24-telemetry-projection.md) | Implement workflow event telemetry, projection, redaction, and retention | W23 | Not started |
| [W25](W25-dashboard-server.md) | Rewrite dashboard daemon/API/control security | W24 | Not started |
| [W26](W26-dashboard-tui-commands.md) | Rewrite dashboard UI, TUI, and command surfaces | W25 | Not started |
| [W27](W27-cutover-cleanup-docs.md) | Cut over the extension, remove legacy architecture, and document migration | W26 | Not started |
| [W28](W28-final-verification.md) | Run exhaustive verification and release gate | W27 | Not started |

## Phase gates

- **Config gate — after W05:** schema-v1 projects resolve to deterministic immutable activation snapshots; invalid dependencies quarantine only affected workflows.
- **Policy gate — after W08:** capabilities and every known tool/command path fail closed without semantic agent types.
- **Runtime gate — after W15:** linked sessions, runs, delegation, recovery, and handoff work against the new contracts without artifacts/knowledge/dashboard assumptions.
- **Artifact/input gate — after W21:** all built-in adapters, approvals, and durable human questions work through generic services.
- **Knowledge/observability gate — after W26:** OKF, telemetry, daemon, dashboard, TUI, and commands consume the generic workflow model.
- **Cutover gate — after W27:** no fixed mode/team/type runtime remains and representative schema-v1 configs are the only supported project configuration.
- **Release gate — W28:** all architecture acceptance criteria and package checks pass.

## Task-status convention

Each task starts with `Status: Not started`. Change it to `In progress` only while actively implementing it and to `Complete` only after its completion checklist passes. If blocked, use `Status: Blocked` and record the exact blocker, evidence, and required decision in the Handoff section; do not silently weaken the task.
