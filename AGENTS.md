# pi-hive Development Guide

## Project purpose

`pi-hive` is a Pi package that provides a hierarchical multi-agent orchestration extension plus a local telemetry dashboard.

The extension must stay safe to install globally: it should do nothing unless the current project opts in with `.pi/hive/hive-config.yaml`.

## Pi package rules

- Package entrypoint is `index.ts` and must remain declared in `package.json` under `pi.extensions`.
- Runtime Pi imports belong in `peerDependencies` with `"*"` ranges: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`.
- Do not require users to build the dashboard at install time. Keep `ui/web/dist/` committed and included in the package.
- After editing `ui/web/src/**`, run `just build-dashboard` before packaging.
- Before publishing or tagging, run `just ci`.

## Extension behavior

- Do not register commands, tools, hooks, background servers, file watchers, or UI widgets unless `.pi/hive/hive-config.yaml` exists in the active project.
- Do not start long-lived processes from the extension factory. Start them from commands/session hooks and clean them up on session shutdown.
- Guard TUI-specific behavior with `ctx.mode === "tui"`; guard user prompts/notifications with `ctx.hasUI`.
- Custom tools that mutate files must use Pi's file mutation queue.
- Tool output must be bounded/truncated so it cannot flood model context.

## Telemetry/dashboard

- The dashboard server is local-only by default: `127.0.0.1:43191`.
- Keep telemetry files under `.pi/hive/sessions/` for project state and `~/.pi/agent/hive/` for the global registry/database.
- Do not send telemetry to third-party services.
- Keep Bun-specific code isolated to dashboard/server paths so the core extension can load even when Bun is unavailable.

## Policy enforcement limits (accepted risk)

- The bash policy classifies mutations by matching known commands (`rm`, `mv`, `git restore`, `find -delete`, `dd of=`, `rsync`, …). File changes made *through* a general-purpose interpreter — `node -e`, `python -c`, `sh script.sh`, `npm run <script>` — are **statically unpoliceable**: the enforcer cannot see writes hidden inside interpreted code. This is a known, accepted limit, stated in the worker operating-contract prompt so agents treat it as a trust boundary, not a loophole. Do not rely on the bash classifier to contain a hostile interpreter invocation.

## Repository hygiene

- Do not commit `node_modules/`, `.tgz` package artifacts, runtime sessions, logs, or local telemetry databases.
- Use Conventional Commits for commit messages, for example `feat: add hive policy checks`, `fix(dashboard): preserve runtime counters`, or `docs: update setup guide`.
- Do not add AI attribution trailers or generated-by notices to commits, docs, package text, or release notes.
- Prefer complete, production-ready changes: no TODO placeholders, no debug logs, and no unexplained temporary behavior.

## Useful commands

```sh
just build-dashboard
just verify
just pack-dry-run
just dev
```
