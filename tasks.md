# React/Tailwind Dashboard Rewrite Tasks

## Phase 0 — Safety and baseline

- [ ] Run `just build-dashboard` on current tree.
- [ ] Run `just verify` on current tree.
- [ ] Record current dashboard API contracts used by `ui/web/src/api.ts`.
- [ ] Record current tab parity checklist:
  - [ ] Sidebar/project selector
  - [ ] Overview topology/KPIs/live activity
  - [ ] Activity event timeline/filters/agent log modal
  - [ ] Plans list/detail/artifacts/comments/approvals/verdicts
- [ ] Confirm current modified files are intentional before broad rewrite.

## Phase 1 — React/Tailwind foundation

- [x] Update `ui/web/package.json`:
  - [x] remove `solid-js`
  - [x] remove `vite-plugin-solid`
  - [x] add `react`
  - [x] add `react-dom`
  - [x] add `@vitejs/plugin-react`
  - [x] add Tailwind dependencies
- [x] Replace `ui/web/vite.config.ts` Solid plugin with React plugin.
- [x] Add Tailwind config/input CSS.
- [x] Create React `main.tsx` entrypoint.
- [x] Create React `App.tsx` shell.
- [x] Port theme/design tokens from current CSS into Tailwind/global CSS.
- [x] Keep dashboard served from `ui/web/dist/` with relative asset base.
- [x] Run `just build-dashboard`.

## Phase 2 — API and state layer

- [x] Port `ui/web/src/api.ts` to React-compatible TypeScript unchanged at the endpoint level.
- [ ] Replace Solid store with React hooks/context:
  - [x] session/project state
  - [x] status/connection state
  - [ ] topology state
  - [x] event history
  - [x] SSE subscription lifecycle
- [ ] Preserve smooth live updates:
  - [x] stable event keys
  - [x] only new items animate
  - [x] no full-list flashing on SSE snapshots
- [ ] Preserve active-team inference for planning vs hive execution.
- [ ] Port formatting helpers.
- [ ] Run `just build-dashboard`.

## Phase 3 — Shell/navigation parity

- [x] Port Sidebar to React/Tailwind.
- [x] Keep real left-side tabs.
- [x] Keep simple project combobox.
- [x] Keep bottom-left connection status.
- [x] Do not restore project/session tree.
- [x] Port Topbar/search behavior if still needed.
- [x] Verify shell overflow/scroll behavior.
- [x] Run `just build-dashboard`.

## Phase 4 — Plans workspace MVP

- [x] Port Plans tab first, before secondary tabs.
- [x] Render plan list with phase/verdict status.
- [x] Render plan header with phase gates.
- [x] Render artifact tabs.
- [x] Render markdown artifact content safely without raw HTML injection.
- [x] Implement stable text selection capture inside artifact viewer.
- [x] Implement floating selection popover:
  - [x] comment
  - [x] remove/redline
  - [x] looks good
  - [ ] cancel/escape/outside click
- [x] Queue pending annotations in React state.
- [x] Persist annotations through `POST /plans/:changeId/comments`.
- [x] Persist general feedback separately from inline annotations.
- [x] Send feedback through existing dashboard action bridge.
- [x] Approve current phase from primary review bar.
- [x] Remove duplicate approval gate UI.
- [x] Run `just build-dashboard`.

## Phase 5 — Plannotator-like annotation rail

- [x] Add right-side annotation rail beside artifact viewer.
- [x] Show pending annotations.
- [x] Show saved annotations from plan comments.
- [x] Distinguish annotation types visually:
  - [x] comment/yellow
  - [x] deletion/red strikethrough
  - [x] looks-good/green
- [x] Inline-highlight saved and pending annotations in artifact body.
- [x] Allow deleting pending annotations before send.
- [ ] Add click-to-scroll/jump from rail annotation to highlighted text where possible.
- [ ] Add selected annotation focus state.
- [x] Run `just build-dashboard`.

## Phase 6 — Review log and changelog

- [ ] Rename comments area to Review log.
- [ ] Group review log entries by type:
  - [ ] annotations
  - [ ] general comments
  - [ ] approvals
  - [ ] verdicts
- [ ] Add filters for review log entry type.
- [ ] Add compact timeline display.
- [ ] Add copy/export feedback payload action.
- [ ] Add backend snapshot table for plan artifacts.
- [ ] Store artifact snapshots on:
  - [ ] feedback send
  - [ ] approval
  - [ ] planner update if detectable
- [ ] Add API endpoint to list artifact snapshots.
- [ ] Add API endpoint to fetch snapshot content.
- [ ] Add before/after diff view for artifact changes.
- [ ] Run `just build-dashboard`.
- [ ] Run targeted plan server/db tests.

## Phase 7 — External annotation API

- [ ] Design local-only external annotation endpoint inspired by Plannotator:
  - [ ] `GET /plans/:changeId/annotations`
  - [ ] `POST /plans/:changeId/annotations`
  - [ ] optional stream via existing SSE
- [ ] Accept structured annotation payloads:
  - [ ] file
  - [ ] type
  - [ ] originalText
  - [ ] body
  - [ ] author/source
- [ ] Persist as structured plan comments or a dedicated annotation table.
- [ ] Surface external annotations immediately in Plans tab.
- [ ] Add tests for endpoint validation and same-origin write guard.
- [ ] Run `just verify`.

## Phase 8 — Evaluate vendoring Plannotator components

- [ ] Re-check Plannotator source at pinned commit before copying.
- [ ] Identify focused components to vendor:
  - [ ] AnnotationToolbar
  - [ ] CommentPopover
  - [ ] AnnotationPanel card/layout patterns
  - [ ] PlanCleanDiffView concepts
- [ ] Decide copy vs reimplementation per component.
- [ ] If copying source:
  - [ ] add license header/notice where required
  - [ ] isolate under `ui/web/src/plannotator-vendor/`
  - [ ] remove unused dependencies/imports
  - [ ] adapt to pi-hive API/state
- [ ] Avoid pulling full Plannotator app/server unless iframe embedding becomes an explicit requirement.
- [ ] Run `just build-dashboard`.

## Phase 9 — Overview React port

- [x] Port KPI cards.
- [x] Preserve token throughput wall-clock metric.
- [x] Port topology graph.
- [x] Keep topology tabs only:
  - [x] Hive execution
  - [x] Planning
- [x] Port compact read-only Live Activity.
- [ ] Preserve inactive-team status behavior.
- [x] Run `just build-dashboard`.

## Phase 10 — Activity React port

- [x] Port Activity tab.
- [ ] Preserve team filters:
  - [ ] All
  - [ ] Hive
  - [ ] Planning
- [x] Preserve agent filtering.
- [ ] Preserve bundled worker tool start/end cards.
- [x] Preserve expandable details.
- [ ] Preserve agent color coding.
- [x] Preserve main/root transcript log behavior.
- [x] Run `just build-dashboard`.

## Phase 11 — Remaining components and cleanup

- [x] Port AgentLog modal.
- [x] Port ConfirmModal/WidgetModal if still needed.
- [x] Port Cost/Sessions widgets or remove if no longer in nav.
- [x] Remove old Solid components.
- [x] Remove obsolete CSS files after Tailwind parity.
- [x] Remove Solid dependencies from lockfile.
- [x] Run `just build-dashboard`.
- [x] Run `just verify`.

## Phase 12 — Final acceptance

- [ ] Confirm dashboard opens and streams live telemetry.
- [ ] Confirm normal chat sessions remain hidden.
- [ ] Confirm Plans tab can:
  - [ ] select text
  - [ ] add comment annotation
  - [ ] add removal annotation
  - [ ] add looks-good annotation
  - [ ] show inline highlight
  - [ ] show annotation rail item
  - [ ] send feedback to live session
  - [ ] approve phase
- [ ] Confirm Activity tab replaces Agents tab.
- [ ] Confirm package verification passes.
- [ ] Confirm `ui/web/dist/` is fresh.
