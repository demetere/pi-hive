# Contributing to pi-hive

Thanks for your interest in improving `pi-hive`. This guide covers the toolchain,
the local workflow, and the gates your change must pass.

## Prerequisites

Install these before building:

- **[`just`](https://just.systems)** — the command runner. Every dev/build/verify
  task routes through the `Justfile`, which is the source of truth. Run `just --list`
  to see all recipes. (CI installs `just` via its official script; do the same
  locally.)
- **[Bun](https://bun.sh) ≥ 1.1** — required for the telemetry dashboard server
  (`bun:sqlite`) and the Bun-only test suite (`just test-db`).
- **[Node.js](https://nodejs.org) ≥ 20** — runs the extension and the Node test suite.
  CI uses Node 24.
- **[Pi](https://github.com/earendil-works/pi-coding-agent)** — to actually run the
  extension end to end. Pi provides `@earendil-works/pi-coding-agent` and
  `@earendil-works/pi-tui` at load time (they are peer dependencies).

## Getting started

```sh
just install        # install root + dashboard dependencies
just verify         # tests + typecheck + verification gates (no packaging dry-run)
```

To run the extension against a real project during development:

```sh
just pi-dev         # load this checkout temporarily with pi -e .
```

The extension only activates in a project that contains `.pi/hive/hive-config.yaml`
(see [SETUP.md](./SETUP.md)).

## Working on the dashboard

The dashboard is a Solid + Vite SPA under `ui/web/`. Its built bundle
(`ui/web/dist/`) is **committed** so end users need no build step. After editing
anything under `ui/web/src/`, rebuild and re-stamp the bundle:

```sh
just dashboard-build
```

`just dashboard-verify` fails if `dist/` is stale relative to `src/` — CI enforces
this, so never commit `src/` changes without rebuilding.

For live UI work, `just dashboard-dev` runs Vite HMR (port 43192) proxied to a
running telemetry server.

## Before you open a PR

Run the same gates as CI:

```sh
just ci             # typecheck (core + dashboard), tests, dashboard freshness,
                    # package-manifest verification, and `npm pack --dry-run`
```

Your PR must pass `just ci` green.

## Code style

There is no ESLint/Prettier gate by design — TypeScript's type checkers
(`strict` for the dashboard, `noImplicitAny` for the core) are the enforced
correctness gate. Match the surrounding style: 2-space indent, double quotes,
semicolons, named exports. Keep diffs minimal and idiomatic to the file you are
editing.

## Commit and PR conventions

- Use [Conventional Commits](https://www.conventionalcommits.org/): e.g.
  `feat: add hive policy checks`, `fix(dashboard): preserve runtime counters`,
  `docs: update setup guide`.
- Do not commit `node_modules/`, `.tgz` artifacts, runtime sessions, logs, or local
  telemetry databases (these are gitignored).
- Do not add AI-attribution or "generated-by" trailers to commits, docs, or release
  notes.
- Prefer complete, production-ready changes: no TODO placeholders, no debug logging,
  no unexplained temporary behavior.

## Security

Do not report vulnerabilities in public issues or PRs. See
[SECURITY.md](./SECURITY.md).
