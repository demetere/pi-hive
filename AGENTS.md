# pi-hive Development Guide

## Project purpose

`pi-hive` is a Linux and macOS Pi package that provides a hierarchical multi-agent orchestration extension plus a local telemetry dashboard. Darwin descriptor-relative filesystem operations must use the committed N-API helper and preserve Linux-equivalent fail-closed identity guarantees. Do not claim Windows process-tree termination support; Windows-form paths remain fail-closed security test inputs.

The extension must stay safe to install globally: it should do nothing unless the current project opts in with `.pi/hive/hive-config.yaml`.

## Pi package rules

- Package entrypoint is `index.ts` and must remain declared in `package.json` under `pi.extensions`.
- Runtime Pi imports belong in `peerDependencies` with `"*"` ranges: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`.
- Do not require users to build the dashboard at install time. Keep `ui/web/dist/` committed and included in the package.
- After editing `ui/web/src/**`, run `just dashboard-build` before packaging.
- Before publishing or tagging, run `just ci`.

## Extension behavior

- Do not register commands, tools, hooks, background servers, file watchers, or UI widgets unless `.pi/hive/hive-config.yaml` exists in the active project.
- Do not start long-lived processes from the extension factory. Start them from commands/session hooks. Clean up session-owned processes on session shutdown; deliberately shared daemons must provide authenticated explicit teardown and a bounded idle timeout.
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
- Bash **read** checks fail OPEN on bare filenames. `extractBashPathTokens` only recognizes path-like tokens containing a `/` (or an absolute path), so `cat secrets.env` / `less .env` (no slash) produce no token and skip the read-domain check. Mutations still fail CLOSED (classification keys off the command verb, not the path). Tightening this would false-positive on ordinary bash arguments — every word looks like a filename — so it is left as documented accepted risk, alongside the interpreter limit.

## Repository hygiene

- Do not commit `node_modules/`, `.tgz` package artifacts, runtime sessions, logs, or local telemetry databases.
- Use Conventional Commits for commit messages, for example `feat: add hive policy checks`, `fix(dashboard): preserve runtime counters`, or `docs: update setup guide`.
- For audit remediation backlog tasks (`Txx`), completion includes committing, pushing, and opening a PR after required checks pass. Do not begin the next task until that PR exists.
- Do not add AI attribution trailers or generated-by notices to commits, docs, package text, or release notes.
- Prefer complete, production-ready changes: no TODO placeholders, no debug logs, and no unexplained temporary behavior.

## Useful commands

```sh
just dashboard-build
just verify
just pack-dry-run
just pi-dev
```
