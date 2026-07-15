# pi-hive

A globally-installed extension for [Pi](https://github.com/earendil-works/pi-coding-agent), the coding agent by Earendil Works. `pi-hive` runs a **hierarchical team of agents** (a "hive") on a project: an Orchestrator delegates to team Leads, each Lead fans work out to its Members, and every worker runs in a separate in-process Pi `AgentSession` with scoped tools and enforced filesystem domains.

> **Note:** This is a Pi *host extension*, not a standalone Node library — it is loaded by Pi via `pi.extensions`, not `import`ed directly.

![pi-hive telemetry dashboard — live session topology, KPIs, and streaming activity](docs/assets/dashboard-overview.png)

*The `/hive:observe` dashboard: live session topology (orchestrator → leads → members), per-session KPIs, streaming activity, cost, and model mix.*

## What this is

Most agent frameworks hand you a fixed swarm and a black box. `pi-hive` is the
opposite: **it's config-first, and you own the whole tree.** Nothing runs until
*you* describe the team.

- **Config-first — you own everything.** The extension does nothing until a
  project contains `.pi/hive/hive-config.yaml`. That one file is both the opt-in
  trigger *and* the team definition: you declare the agents, their models, their
  tools, their filesystem domains, and their nesting. Roles aren't magic — a node
  is a **lead** if it has members and a **member** if it doesn't, and an agent may
  delegate **only to its own direct reports**. You express permissions by nesting,
  not by writing policy. Every agent's prompt, knowledge, and skills live as plain
  files under `.pi/hive/` in your repo, versioned with your code. See
  **[SETUP.md](./SETUP.md)** for the full authoring guide.

- **A real hierarchy, not a flat swarm.** The visible session is an *orchestrator*
  that routes but never edits. It delegates to team **leads**, each lead fans work
  out to its **members**, and each worker runs in a separate in-process Pi
  `AgentSession` with its own transcript, scoped tool allow-list, and enforced
  domains. Pi-hive's registered tool and command policies reject out-of-domain
  mutations by cooperative workers; this is policy enforcement, not an OS sandbox.
  See [SECURITY.md](SECURITY.md) for the accepted interpreter and bare-path limits.
  Nesting goes arbitrarily deep.

- **Plan first, then execute — two separate teams.** The session runs in one of
  three modes (`normal → plan → hive`, cycled with `Ctrl+Alt+T`). **Plan mode**
  activates a `planning:` team that produces a full spec and writes *no code*.
  **Hive mode** activates a separate `hive:` team that executes an already-approved
  spec. They're distinct trees in your config so a project can never silently run
  planning against its coding tree.

- **Spec-driven, backed by OpenSpec.** Non-trivial work follows one artifact graph:
  `proposal → { design, specs } → tasks`, stored under
  `openspec/changes/<change-id>/`. [OpenSpec](https://github.com/Fission-AI/OpenSpec)
  (a CLI dependency) is the store and validator. Specification deltas live at
  `specs/<capability>/spec.md`; there is no `requirements.md` or alternate
  project-local plan store. `/hive:execute` refuses to run until every exact
  artifact has automated review and human approval.

- **Human-in-the-loop plan review, self-hosted.** `pi-hive` embeds a compact,
  [Plannotator](https://github.com/backnotprop/plannotator)-compatible review-only surface
  **directly in its own dashboard** — no full Plannotator extension and no
  per-review server. You annotate, approve, or deny each plan artifact in the
  browser; approval unblocks the planner, a denial routes your feedback back and
  holds the gate. Verdicts persist to local SQLite.

- **Local, private telemetry.** Every session streams its own tailored event log to
  `.pi/hive/sessions/`, and `/hive:observe` opens a local React + Vite dashboard
  (`127.0.0.1:43191`) showing live topology, delegation lifecycle, tokens, and cost
  across every project and session. Nothing is sent to any third party.

## Install location & activation

Install from GitHub with `pi install` (recommended):

```sh
pi install git:github.com/demetere/pi-hive          # latest main
pi install git:github.com/demetere/pi-hive@v0.1.0   # pin a tag/commit
```

`pi install` also accepts the full HTTPS or SSH URL, e.g.
`pi install https://github.com/demetere/pi-hive` or
`pi install ssh://git@github.com/demetere/pi-hive`. Pi runs `npm install` for the
package, so the extension's runtime dependency
([OpenSpec](https://github.com/Fission-AI/OpenSpec)) is fetched automatically; the
Pi host packages are declared as peer dependencies and provided by Pi at load time.

You can also add it declaratively in Pi's `settings.json`:

```json
{
  "packages": ["git:github.com/demetere/pi-hive"]
}
```

For local development, load a checkout temporarily without installing:

```sh
pi -e .        # from the repository root
```

When installed, Pi auto-discovers the package for **every** project.

For repository-first development, use `just` as the command source of truth:

```sh
just pi-dev         # run this checkout temporarily with pi -e .
just pi-reload-dry-run # preview copying this checkout to ~/.pi/agent/extensions/pi-hive
just pi-reload         # update the user-level extension from this checkout
```

After `just pi-reload`, run `/reload` in Pi.

- **Activates only when a project contains `.pi/hive/hive-config.yaml`.** Without it, the extension registers nothing — no tools, no commands, no hooks — so non-hive projects are completely unaffected.

## Quickstart

1. Install the extension (see above), so Pi discovers it for every project.
2. In the project you want to run a hive on, create `.pi/hive/hive-config.yaml`. This file is the opt-in trigger and defines the team tree — the fastest way to author it is to point an agent at [SETUP.md](./SETUP.md) and let it interview you (see [Build a hive in a new project](#build-a-hive-in-a-new-project) below).
3. Start Pi in that project and press `Ctrl+Alt+T` (or run `/hive`) to enter hive mode; the visible session becomes a Lead that delegates to its team.
4. Run `/hive:observe` to open the live telemetry dashboard at `http://127.0.0.1:43191`.

`/hive:doctor` runs read-only diagnostics if anything looks off.

## Requirements and platform support

- **Linux** is the currently supported runtime platform. Native macOS and Windows are untested and unsupported; see [SECURITY.md](SECURITY.md#platform-support).
- **Node.js ≥ 20.19.0** for package tooling. The Pi host itself may require a newer Node release.
- **Bun ≥ 1.3.14** for the telemetry dashboard server (`src/observability/server/index.ts`), which uses `bun:sqlite`. Core extension loading remains Bun-independent; `/hive:observe` reports when Bun is unavailable.
- The Pi host provides `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` at load time (declared as peer dependencies).

## Packaging & distribution

This extension is self-contained and ships in two ways:

- **Git** — clone or submodule into `~/.pi/agent/extensions/`. The prebuilt dashboard (`ui/web/dist/`) is committed, so there is **no build step at install time**. Dependency folders are gitignored.
- **Tarball/package** — `just pack-dry-run` previews the published package contents. The root `package.json` `files` allowlist ships only runtime code + the prebuilt `dist/`; dependency folders never ship. The package prepack hook delegates to `just prepack`, so a published package can never contain stale UI.

After editing anything under `ui/web/src/`, rebuild the committed bundle:

```sh
just dashboard-build   # Vite build + stamp dist/.build-hash
```

Guard against shipping stale UI (wire into a pre-commit hook or CI):

```sh
just dashboard-verify  # fails if dist/ is out of date with src/
```

## Build a hive in a new project

Point an agent at the build guide and let it interview you:

> "Set up a hive for this project. Follow `~/.pi/agent/extensions/pi-hive/SETUP.md` — interview me for the teams, members, domains, and models, then scaffold `.pi/hive/`."

**[SETUP.md](./SETUP.md)** is the authoritative, self-contained playbook: the config + frontmatter schema, copy-paste templates for orchestrator/lead/member, the interview questions, conventions (tools, domains, distiller), and a validation checklist.

## Modes and commands (only registered when a hive is configured)

`pi-hive` has three hardcoded session modes: `normal` → `plan` → `hive` → `normal`. The cycle order is not configurable.

- `normal` — plain Pi chat. No hive tools or hive enforcement.
- `plan` — the `planning:` team is active. The visible main session should be `agent-type: planner`; artifacts follow `proposal → { design, specs } → tasks` under `openspec/changes/<change-id>/`.
- `hive` — the `hive:` team is active. The visible main session should be `agent-type: lead`; execution agents implement the approved `tasks.md` and the lead records evidence with `plan_task_complete`.

Commands:

- `/hive:normal`, `/hive:plan-mode`, `/hive` — switch to a specific mode.
- `/hive:toggle` or `Ctrl+Alt+T` — cycle `normal → plan → hive → normal`.
- `/hive:execute <change-id>` — validates that the change exists, has `tasks.md`, and the tasks gate is approved, then switches to hive mode and drives execution.
- `/hive:plan [change-id]` — list plan changes or select/show one.
- `/hive:doctor` — run read-only diagnostics for opt-in config, loaded agents, dashboard assets, Bun availability, SDD state, and telemetry paths.
- `/hive:observe` — restart/open the local browser dashboard for global hive telemetry (`http://127.0.0.1:43191` by default).
- `/hive:observe-stop` — stop the telemetry dashboard on the configured port.
- `/hive:observe-prune <days>` — delete global dashboard rows older than the retention window through the authenticated daemon API. This does not delete project source JSONL logs.

The hive tool set is mode/type scoped in code, not configurable by users. Shared tools are `route_agent`, `delegate_agent`, `team_status`, `team_conversation`, `hive_sdd_status`, and `ask_user`. Planners and leads use `ask_user` for ambiguous scope; in the TUI it opens a native human prompt, while headless sessions record and surface the question and proceed with an explicit assumption. Type-scoped tools are `submit_review_verdict` for reviewers and `plan_new`, `plan_select`, and `plan_task_complete` for leads. Human approval is only an authenticated dashboard action—there is no agent approval tool. Normal mode exposes no hive tools. The dashboard host/port default to `127.0.0.1:43191` and can only be changed with `HIVE_TELEMETRY_HOST` / `HIVE_TELEMETRY_PORT`.

SDD/OpenSpec is the default operating mode for non-trivial hive work. Agent `skills:` paths are supplied explicitly to each worker `AgentSession` resource loader while ambient skill and extension discovery is disabled, so Hive reuses Pi's native skill system without discovery bleed-through.

## Layout of a configured project

```
.pi/hive/
  hive-config.yaml      # the team tree + global settings (also the activation trigger)
  agents/               # one folder per agent, mirroring the tree; each holds <name>.md + <name>-mental-model.yaml
  knowledge/            # always-inlined context/reference files
  skills/               # Pi Agent Skills explicitly granted to agents
  sessions/             # runtime transcripts + hive-events.jsonl telemetry (gitignore this)
```

See SETUP.md §4 for the full directory contract.

## Hive telemetry

`pi-hive` writes its own tailored telemetry stream to `.pi/hive/sessions/<session>/hive-events.jsonl` for each hive session and a live mutable state snapshot to `.pi/hive/sessions/<session>/hive-state.json`. Top-level sessions are also registered in a global index at `~/.pi/agent/hive/telemetry-sessions.jsonl`, so one `/hive:observe` dashboard can show hives from multiple projects and many simultaneously running sessions.

`/hive:observe` starts a local Bun/SSE dashboard with hive-specific views for project/session cards, topology, delegation lifecycle, worker state, tool activity, tokens, and cost. The dashboard also indexes events/state into local SQLite at `~/.pi/agent/hive/telemetry.db` for fast reloads and historical browsing. By default, sensitive credential-shaped values are redacted before persistence, telemetry files use mode `0600`, directories use `0700`, the database is pruned after 30 days, source logs rotate at 50 MiB, and raw reasoning text is not exposed. Configure these controls under `settings.telemetry` in `hive-config.yaml`.

Database pruning and project logs are deliberately separate: pruning SQLite does **not** delete `.pi/hive/sessions/**`. The Settings tab reports both stores independently, offers an authenticated, explicitly confirmed source-log deletion action, and provides per-session JSONL downloads for backup.

The dashboard UI is a prebuilt React + Vite single-page app under `ui/web/`. The
server (`src/observability/server/index.ts`) serves the built bundle from `ui/web/dist/`,
which is committed so end users need no build step. If you change anything under
`ui/web/src/`, rebuild it:

```sh
just dashboard-install # first time only
just dashboard-build   # rebuild dashboard dist/
just review-build      # rebuild deterministic gzip review assets
```

Before publishing or opening a release PR, run the same gates as CI:

```sh
just ci
```

The npm package contains only the runtime dashboard `dist/` plus the tiny review
bundle and its reproducible source; `ui/web/src/` and dashboard build tooling are
not shipped. CI enforces 600 KiB packed / 1.5 MiB unpacked package budgets and a
10 KiB compressed review-bundle budget.

During UI development you can run `just dashboard-dev` (Vite HMR on port 43192) with a
telemetry server running on `HIVE_TELEMETRY_PORT`; the dev server proxies the
`/events`, `/states`, `/stream`, and `/health` endpoints to it.

This is not wired to a third-party observability server. See [`SECURITY.md`](SECURITY.md) for the trust boundaries, approval and path invariants, supported platform, and accepted enforcement limits.

Runtime knobs are hive-specific:

- `HIVE_TELEMETRY_PORT` — dashboard port, default `43191`
- `HIVE_TELEMETRY_HOST` — dashboard host, default `127.0.0.1`; non-loopback values are rejected
- `HIVE_TELEMETRY_ALLOW_NON_LOOPBACK=1` — dangerous explicit opt-in for network binding; use only with an understood exposure model
- `HIVE_TELEMETRY_NO_OPEN=1` — start the server without opening a browser
- `HIVE_TELEMETRY_REGISTRY` — override the global session registry path
- `HIVE_TELEMETRY_DB` — override the local SQLite database path
- `HIVE_DAEMON_IDLE_TIMEOUT_MS` — stop an unused daemon after this interval, default `900000` (15 minutes; allowed `1000..86400000`)
- `settings.telemetry.enabled` — disable pi-hive event/state telemetry for this project
- `settings.telemetry.dashboard-auto-start` — keep telemetry but require `/hive:observe` to start the dashboard
- `settings.telemetry.retention-days` — automatic SQLite retention, default `30`
- `settings.telemetry.max-log-bytes` — rotate each source JSONL before the next event would exceed this size, default `52428800`
- `settings.telemetry.capture-thinking` — expose raw worker reasoning in dashboard transcript/activity APIs, default `false`
- `settings.telemetry.redact-sensitive-data` — redact credential-shaped keys and text before pi-hive persistence, default `true`

Dashboard startup is serialized across Pi processes. A session adopts a daemon only when `/health` reports the same protocol, package/build, registry, and database identity; compatible upgrades restart stale same-storage daemons, while a daemon using different storage is never adopted. Host headers must exactly match the configured listener origin.

The dashboard uses an explicit shared-daemon lifecycle: it survives individual Pi session shutdowns because other sessions may still use it. It stops through `/hive:observe-stop`, an authenticated restart, normal OS/process supervision, or automatically after 15 minutes with no HTTP activity and no active browser event stream. Shutdown requests must carry both the daemon bearer token and its current startup nonce. PID metadata is informational only—pi-hive never signals a process merely because its PID appears in a file, and it does not discover termination targets with `lsof`. Managed child-process handles may be terminated directly when startup fails because the live handle, rather than persisted metadata, supplies process identity. Manual `just run` and `just dashboard-serve` starts also keep write authentication enabled by minting an ephemeral credential when no private stored token exists.
