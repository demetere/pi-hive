# pi-hive

A globally-installed Pi extension that runs a **hierarchical team of agents** (a "hive") on a project: an Orchestrator delegates to team Leads, each Lead fans work out to its Members, each agent runs as its own `pi` subprocess with scoped tools and enforced filesystem domains, and a status view shows the live tree.

## Install location & activation

For local development from this checkout:

```sh
pi -e /Users/demetere/Projects/pi-hive
```

For package installation after this repository is pushed/tagged, use `pi install` with the final GitHub or npm package spec. For local path installation, use:

```sh
pi install /Users/demetere/Projects/pi-hive
```

When installed globally, Pi auto-discovers the package for **every** project.

For repository-first development without publishing a package, use the included `Justfile`:

```sh
just dev            # run this checkout temporarily with pi -e .
just reload-dry-run # preview copying this checkout to ~/.pi/agent/extensions/pi-hive
just reload         # update the user-level extension from this checkout
```

After `just reload`, run `/reload` in Pi.

- **Activates only when a project contains `.pi/hive/hive-config.yaml`.** Without it, the extension registers nothing — no tools, no commands, no hooks — so non-hive projects are completely unaffected.

## Requirements

- **Bun ≥ 1.1** — the telemetry dashboard server (`observability/server.ts`) runs under Bun and uses `bun:sqlite`. The `/hive-observe` command notifies you if Bun is missing.
- The Pi host provides `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` at load time (declared as peer deps).

## Packaging & distribution

This extension is self-contained and ships in two ways:

- **Git** — clone or submodule into `~/.pi/agent/extensions/`. The prebuilt dashboard (`ui/web/dist/`) is committed, so there is **no build step at install time**. `node_modules` is gitignored.
- **npm / tarball** — `npm pack` (or `npm publish`) produces a ~100 kB package. The root `package.json` `files` allowlist ships only runtime code + the prebuilt `dist/`; `node_modules` never ships. A `prepack` hook rebuilds and re-stamps the dashboard automatically, so a published package can never contain stale UI.

After editing anything under `ui/web/src/`, rebuild the committed bundle:

```sh
npm run build:dashboard   # vite build + stamp dist/.build-hash
```

Guard against shipping stale UI (wire into a pre-commit hook or CI):

```sh
npm run verify:dashboard  # fails if dist/ is out of date with src/
```

## Build a hive in a new project

Point an agent at the build guide and let it interview you:

> "Set up a hive for this project. Follow `~/.pi/agent/extensions/pi-hive/SETUP.md` — interview me for the teams, members, domains, and models, then scaffold `.pi/hive/`."

**[SETUP.md](./SETUP.md)** is the authoritative, self-contained playbook: the config + frontmatter schema, copy-paste templates for orchestrator/lead/member, the interview questions, conventions (tools, domains, distiller), and a validation checklist.

## Commands (only registered when a hive is configured)

- `/hive-toggle` or `Ctrl+Alt+T` — toggle between normal chat and hive orchestrator mode.
- `/hive-status` — open the live hierarchy view (per-agent status, tokens, cost).
- `/hive-observe` — restart/open the local browser dashboard for global hive telemetry (`http://127.0.0.1:43191` by default).
- `/hive-observe-stop` — stop the telemetry dashboard on the configured port.

SDD/OpenSpec is the default operating mode for non-trivial hive work. Skill discovery is automatic on session start; discovered project/user skills are indexed at `.atl/hive-skill-registry.md` and can be loaded by agents via `load_skill`.

## Layout of a configured project

```
.pi/hive/
  hive-config.yaml      # the team tree + global settings (also the activation trigger)
  agents/               # one folder per agent, mirroring the tree; each holds <name>.md + <name>-mental-model.yaml
  knowledge/            # shared context/skill files referenced by agents
  sessions/             # runtime transcripts + hive-events.jsonl telemetry (gitignore this)
.atl/
  hive-skill-registry.md # generated discovered project/user SKILL.md index
```

See SETUP.md §4 for the full directory contract.

## Hive telemetry

`pi-hive` writes its own tailored telemetry stream to `.pi/hive/sessions/<session>/hive-events.jsonl` for each hive session and a live mutable state snapshot to `.pi/hive/sessions/<session>/hive-state.json`. Top-level sessions are also registered in a global index at `~/.pi/agent/hive/telemetry-sessions.jsonl`, so one `/hive-observe` dashboard can show hives from multiple projects and many simultaneously running sessions.

`/hive-observe` starts a local Bun/SSE dashboard with hive-specific views for project/session cards, topology, delegation lifecycle, worker state, tool activity, tokens, and cost. The dashboard also indexes events/state into local SQLite at `~/.pi/agent/hive/telemetry.db` for fast reloads and historical browsing. Telemetry persists even when the dashboard is not running; serve it only when you want to watch or inspect.

The dashboard UI is a prebuilt Solid + Vite single-page app under `ui/web/`. The
server (`observability/server.ts`) serves the built bundle from `ui/web/dist/`,
which is committed so end users need no build step. If you change anything under
`ui/web/src/`, rebuild it:

```sh
cd ui/web
npm install   # first time only
npm run build # rebuild dist/ — the server picks it up on next page load
```

During UI development you can run `npm run dev` (Vite HMR on port 43192) with a
telemetry server running on `HIVE_TELEMETRY_PORT`; the dev server proxies the
`/events`, `/states`, `/stream`, and `/health` endpoints to it.

This is not wired to a third-party observability server. Runtime knobs are hive-specific:

- `HIVE_TELEMETRY_PORT` — dashboard port, default `43191`
- `HIVE_TELEMETRY_HOST` — dashboard host, default `127.0.0.1`
- `HIVE_TELEMETRY_NO_OPEN=1` — start the server without opening a browser
- `HIVE_TELEMETRY_REGISTRY` — override the global session registry path
- `HIVE_TELEMETRY_DB` — override the local SQLite database path
