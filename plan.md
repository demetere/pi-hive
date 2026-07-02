# pi-hive Dashboard React/Tailwind Rewrite Plan

## Goal

Rewrite the `ui/web` dashboard from Solid + custom CSS to React + Tailwind, making the Plans experience first-class and as close to Plannotator as practical while keeping pi-hive's existing backend, telemetry, packaging, and local-only safety model.

## Why

pi-hive is increasingly plan-first: users should be able to create, review, annotate, approve, and iterate plans from the dashboard with the same ergonomics as Plannotator. Plannotator's implementation is React/Tailwind-based, so a React/Tailwind dashboard unlocks much more direct reuse of its interaction patterns and, where appropriate, vendored components.

## Non-goals

- Do not rewrite the core extension, orchestration engine, telemetry server, or plan store as part of this UI migration.
- Do not introduce third-party telemetry or hosted services.
- Do not make dashboard build a global install-time requirement beyond the existing committed `ui/web/dist/` package rule.
- Do not remove the existing API surface until the React UI has parity.
- Do not vendor large Plannotator subsystems blindly; reuse concepts/components deliberately with license attribution where copied.

## Constraints

- Package must remain globally safe: extension behavior stays opt-in via `.pi/hive/hive-config.yaml`.
- Dashboard server remains local-only by default: `127.0.0.1:43191`.
- Keep `ui/web/dist/` committed and up to date after UI changes.
- After editing `ui/web/src/**`, run `just build-dashboard`.
- Before publishing/tagging, run `just ci`.
- No AI attribution trailers or generated-by notices in project text.

## Architecture

### Keep

- Existing Bun dashboard server endpoints:
  - `/plans`, `/plans/:changeId`, `/plans/:changeId/file`
  - `/plans/:changeId/comments`, `/plans/:changeId/approval`
  - telemetry/history/session/state APIs
  - SSE `/stream`
- Existing plan storage under `.pi/hive/plans/<change-id>/`.
- Existing SQLite typed tables for verdicts, approvals, comments, and telemetry.
- Existing dashboard action bridge back to the live TUI session.

### Replace

- `ui/web` Solid runtime with React.
- Hand-written broad CSS with Tailwind utility-first styling plus a small token layer.
- Current Plans tab with a Plannotator-inspired planning workspace.

### Candidate dependencies

- Runtime:
  - `react`
  - `react-dom`
  - `@vitejs/plugin-react`
- Styling:
  - `tailwindcss`
  - `@tailwindcss/vite` or standard Tailwind PostCSS setup
  - optional `clsx` / `tailwind-merge`
- Planning/review UX:
  - evaluate vendoring from Plannotator under `ui/web/src/plannotator-vendor/`
  - possible focused reuse patterns: annotation toolbar, comment popover, annotation panel, clean plan diff view
  - avoid importing the whole Plannotator monorepo unless we intentionally embed it as a separate app

## Target UX

### Shell

- Left sidebar remains the primary navigation.
- Project selector remains simple combobox-style project scoping.
- No redundant project/session tree.
- Connection status remains compact and low-noise.

### Overview

- High-level dashboard only.
- Topology tabs: `Hive execution` and `Planning`.
- Live Activity remains compact/read-only.
- Detailed agent/event exploration stays in Activity.

### Activity

- Replaces the old Agents tab permanently.
- Shows agents in scope, team filters, agent filters, event timeline, bundled tool calls, expandable details.
- Smooth SSE updates: stable keyed items; only new events animate.

### Plans: first-class planning workspace

The Plans tab becomes the main product surface.

Required Plannotator-like capabilities:

1. Artifact viewer
   - rendered markdown plan artifacts
   - artifact tabs/files
   - stable text selection support
   - inline highlights for saved/pending annotations

2. Floating selection tools
   - select text -> anchored toolbar/popover
   - comment
   - remove/redline
   - looks-good/approval label
   - keyboard-friendly close/cancel behavior

3. Annotation panel
   - right-side annotation rail
   - pending vs saved annotations
   - jump/scroll to annotation when possible
   - edit/delete pending annotations
   - delete or resolve saved annotations if supported by backend

4. Review log / changelog
   - persisted annotation timeline
   - general comments
   - approvals
   - verdicts
   - grouped by artifact and timestamp

5. Plan iteration snapshots
   - store artifact version snapshot on feedback and approval
   - show before/after diff when plan changes after feedback
   - highlight removed/added/changed sections

6. Approval flow
   - approve current phase from the primary review bar
   - approval notes include selected annotations when present
   - no duplicate bottom approval gate UI

7. Feedback bridge
   - `Send feedback` persists structured annotations/comments
   - queues a dashboard action back to the live terminal/session
   - planner can update artifacts from structured annotation context

8. External annotation API compatibility
   - add a local endpoint similar in spirit to Plannotator `/api/external-annotations`
   - allow agents/tools to post fresh annotations to the active plan
   - stream updates to the dashboard via SSE

## Migration strategy

### Phase 0: preserve current working behavior

- Build and verify current dashboard before migration.
- Capture current APIs and UI screens as parity checklist.
- Keep a rollback path: Solid UI can remain on a branch or be restorable from git.

### Phase 1: React/Tailwind foundation

- Replace Solid dependencies with React dependencies in `ui/web/package.json`.
- Replace Vite Solid plugin with React plugin.
- Add Tailwind configuration and global token CSS.
- Port API client/types first; keep endpoint contracts unchanged.
- Implement React app shell, sidebar, topbar/search/project selector.
- Keep visual parity before adding new features.

### Phase 2: shared data layer

- Recreate store logic with React hooks/context.
- Preserve SSE behavior and smoothing:
  - stable event keys
  - no full-list flashing
  - bounded event history
  - scoped project/session handling
- Port formatting helpers and topology derivations.

### Phase 3: Plans workspace first

- Build React Plans tab before migrating every secondary tab.
- Implement rendered artifact viewer.
- Implement floating selection toolbar/comment popover.
- Implement annotation rail.
- Persist structured annotations through existing comments endpoint.
- Add missing endpoints only where needed for changelog/snapshots.

### Phase 4: Plannotator-grade review features

- Add plan artifact snapshots.
- Add plan diff/changelog UI.
- Add annotation jump/edit/delete/resolve lifecycle.
- Add external annotation endpoint + SSE updates.
- Evaluate vendoring specific Plannotator components once the React/Tailwind shell exists.

### Phase 5: Remaining tabs

- Port Overview.
- Port Activity.
- Port Cost/Sessions widgets if still needed.
- Remove unused Agents tab.
- Remove obsolete Solid components and CSS.

### Phase 6: cleanup and verification

- Remove Solid and vite-plugin-solid.
- Remove obsolete CSS files after parity.
- Rebuild dashboard.
- Run `just verify`.
- Check package files include fresh `ui/web/dist/`.

## Data model additions likely needed

Existing `plan_comments` already supports structured annotation fields:

- `annotation_type`
- `original_text`
- `file`
- `body`

Additional tables or columns for full changelog parity:

```sql
CREATE TABLE IF NOT EXISTS plan_artifact_snapshots (
  id          TEXT PRIMARY KEY,
  change_id   TEXT NOT NULL,
  file        TEXT NOT NULL,
  content     TEXT NOT NULL,
  reason      TEXT NOT NULL, -- feedback | approval | planner_update | manual
  session_id  TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plan_artifact_snapshots_change
  ON plan_artifact_snapshots(change_id, file, created_at);
```

Optional annotation lifecycle fields:

```sql
ALTER TABLE plan_comments ADD COLUMN status TEXT; -- open | resolved | archived
ALTER TABLE plan_comments ADD COLUMN resolved_at TEXT;
ALTER TABLE plan_comments ADD COLUMN updated_at TEXT;
```

## Plannotator reuse policy

Plannotator is licensed `MIT OR Apache-2.0`. We may vendor focused source if needed, but must:

- keep license notices for copied files
- copy only what we actually need
- adapt package imports/state assumptions to pi-hive
- avoid introducing the full Plannotator server model unless intentionally embedding
- prefer native pi-hive APIs and storage

Recommended reuse targets after React migration:

- AnnotationToolbar behavior
- CommentPopover behavior
- AnnotationPanel layout/card patterns
- PlanCleanDiffView concepts
- external annotation API shape/instructions

## Acceptance criteria

- `ui/web` builds with React/Tailwind and no Solid runtime dependency.
- Dashboard shell, project scoping, Overview, Activity, and Plans are usable.
- Plans tab supports select-text feedback via floating popover.
- Plans tab shows persistent inline highlights and right annotation rail.
- Feedback and approvals continue to reach the live planning session.
- Normal sessions remain hidden from telemetry.
- Token throughput metrics remain wall-clock accurate.
- `just build-dashboard` passes.
- `just verify` passes.
- `ui/web/dist/` is fresh.
