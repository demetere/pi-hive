# Contributing to pi-hive

Thanks for your interest in improving `pi-hive`. This guide covers the toolchain,
the local workflow, and the gates your change must pass.

New here? Read the [README](./README.md) "What this is" section for the concepts
(config-first ownership, the plan → hive flow, OpenSpec, Plannotator) and
[SETUP.md](./SETUP.md) for how a hive is authored. The extension is config-first:
it registers nothing until a project has `.pi/hive/hive-config.yaml`, so keep that
opt-in guarantee intact in any change.

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

## Releasing (maintainers)

`pi-hive` is distributed two ways, and publishing to npm is what lists it in the
[pi.dev package gallery](https://pi.dev/packages) (the gallery indexes npm packages
carrying the `pi-package` keyword — there is no separate submission step).

Releases are triggered by **publishing a GitHub Release**. That runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which checks out
the release tag, re-runs `just ci`, and then `npm publish --provenance`.

```sh
# 1. Bump the version and push the commit (no tag yet):
npm version <patch|minor|major> --no-git-tag-version
git commit -am "chore: release vX.Y.Z" && git push

# 2. Publish a GitHub Release whose tag matches the new version:
gh release create vX.Y.Z --generate-notes
```

You can also publish an existing tag manually (e.g. if the release event doesn't
fire): `gh workflow run Release -f tag=vX.Y.Z`, or via the Actions tab → Release →
"Run workflow".

The tag (e.g. `v0.1.0`) must match `package.json`'s version, and `just ci` must
pass, or the workflow fails before publishing — so a broken or mistagged build
cannot ship. The published tarball ships only the `files` allowlist (runtime code +
the prebuilt `ui/web/dist/`); dependency folders never ship.

**One-time setup:** add an npm access token that can publish in CI — a **granular**
token with "bypass 2FA" enabled, or a classic **automation** token — as the
`NPM_TOKEN` repository secret (Settings → Secrets and variables → Actions). A plain
publish token fails with a 403 when the account has 2FA-on-publish enabled.
Publishing to npm is what makes the package appear in the gallery.

## Security

Do not report vulnerabilities in public issues or PRs. See
[SECURITY.md](./SECURITY.md).
