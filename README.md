# pi-hive

Config-first workflow orchestration for the [Pi coding agent](https://github.com/badlogic/pi-mono). Projects opt in with a strict schema-v1 `.pi/hive/hive-config.yaml`; projects without that file receive no commands, tools, hooks, UI, files, or background processes.

pi-hive provides reusable agents, recursive teams, linked Pi sessions, capability policy, bounded delegation, run journals, artifact adapters, approvals, durable questions, local knowledge, and a workflow-aware dashboard. Workflow names are data: planning, implementation, debugging, and review have no hardcoded runtime meaning.

## Install

```sh
pi install npm:pi-hive
```

Pi supplies the peer dependencies. pi-hive supports Linux only; npm rejects installation on unsupported operating systems. Node.js 20.19 or newer is required for package tooling. Bun 1.3.14 or newer is optional and used only when the local dashboard is started.

## Quick start

1. Copy one of `examples/combined-openspec-delivery`, `examples/split-openspec-handoff`, `examples/markdown-plan-lifecycle`, or `examples/artifact-free-debug` into a project.
2. Restart Pi in that project.
3. Run `/hive:doctor`, then `/hive:select`.
4. Select a workflow. Selection creates or resumes a linked session but does not start work.
5. Send an ordinary chat message. The first message starts a run; later messages steer the same open run.
6. The root completes through the `workflow_finish` tool. The workflow remains selected for another run until `/hive:exit`.

No workflow is automatically selected. Normal chat keeps its original tools and has no workflow prompt, widget, policy, or telemetry.

## Configuration

The root manifest is an explicit registry:

```yaml
schema-version: 1
settings:
  telemetry:
    dashboard-start: workflow # session | workflow | manual
agents:
  orchestrator: agents/orchestrator.md
workflows:
  delivery: workflows/delivery.yaml
skills: {}
knowledge: {}
```

An agent Markdown file contains strict frontmatter and a prompt body:

```markdown
---
name: Delivery Orchestrator
thinking: medium
capabilities:
  filesystem:
    - path: .
      operations: [read]
  shell: [inspect]
  human-input: true
  artifact: [read, write, review]
  knowledge: [read, propose]
---
Coordinate the configured team and finish only with verified evidence.
```

A workflow defines discovery metadata, an adapter profile, budgets, a recursive team, and instruction scopes:

```yaml
name: Delivery
description: Deliver a verified repository change.
use-when: A complete implementation outcome is requested.
artifact:
  adapter: none
  profile: default
  binding: none
  options: {}
team:
  id: root
  agent: orchestrator
instructions:
  root: |
    Coordinate only the work needed for the request.
```

Unknown keys, YAML aliases, duplicate keys, interpolation, missing schema versions, widening capability overrides, and invalid resource references fail closed. The nearest ancestor manifest defines the canonical project; nested projects do not merge.

See [SETUP.md](SETUP.md) for complete schemas, team examples, adapters, and validation.

## Combined and split delivery

A combined workflow keeps planning, implementation, testing, and review in one linked conversation and may use an adapter `lifecycle` profile. Use it when continuity and one outcome owner matter.

Split workflows provide stronger team, capability, model, budget, and approval boundaries. After a terminal source run, stage an immutable authority-free handoff:

```text
/hive:select feature-build --from <source-run-id>
```

The next ordinary message starts the target run and consumes the handoff once. The target receives bounded summary, typed changes, artifact digests, and verified references—not transcripts, capabilities, approvals, leases, or budgets. Artifact identity and hashes are revalidated. `suggested-next` affects display only and never invokes another workflow.

## Artifact adapters

Built-in adapters are:

- `none/default`: no durable artifact workspace; filesystem capability remains independent.
- `markdown-plan`: `author`, `execute`, `review`, and `lifecycle` profiles.
- `openspec`: `author`, `execute`, `review`, and `lifecycle` profiles.

Agents use the generic `artifact_status` and `artifact_action` tools. Adapter-specific action IDs remain behind that facade. A run binds at most one workspace. Mutations use operation IDs, optimistic hashes, a writer lease, and Pi's file mutation queue. OpenSpec is not a global mode or command family.

Checkpoint policies are `required`, `optional`, or `none`. Exact-digest approvals occur through the authenticated dashboard or the guarded TUI fallback when the dashboard is unavailable. A denial is immutable for its digest; revision produces a new digest.

## Capabilities and generic tools

Capabilities default deny and workflow overlays may only narrow agent ceilings. The closed groups are filesystem operations, shell classes, Git, external network, human input, artifact operations, and knowledge operations.

Generic workflow tools are:

- team: `route_agent`, `delegate_agent`, `team_status`;
- run: `workflow_status`, `workflow_finish`;
- artifacts: `artifact_status`, `artifact_action`;
- knowledge: `knowledge_search`, `knowledge_read`, `knowledge_propose`;
- human input: `human_question`.

Routing is advisory and deterministic. Delegation is persisted and direct-member-only. Structured references are re-authorized for the recipient, but delegation prose is not a general information-flow or DLP boundary.

## Commands

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
- `/hive:observe`
- `/hive:observe-stop`
- `/hive:observe-prune <ISO-timestamp>`

## Knowledge and telemetry

Attached local OKF bundles support bounded deterministic search. Agent-owned bundles default to automatic updates, shared bundles to reviewed updates, and read-only bundles never mutate. Enrichment is durable, idle, bounded, preemptible, and provenance-backed.

Authoritative workflow journals remain under `.pi/hive/sessions/`. The dashboard projection is a rebuildable SQLite database under `~/.pi/agent/hive/`. The dashboard binds to `127.0.0.1:43191`, authenticates writes, checks origin and CSRF, and sends no third-party telemetry. Historical pre-1.0 telemetry files are preserved but are not imported or displayed.

## Manual migration from pre-1.0

This is a clean breaking release with no converter or compatibility loader.

1. Back up the project and leave historical telemetry archives in place.
2. Replace the old two-team root file with `schema-version: 1` plus explicit `agents` and `workflows` registries.
3. Move identity prompts into cataloged agent Markdown files. Replace semantic role enforcement and planner stage fields with free-form tags, node metadata, capabilities, and adapter profiles.
4. Express each old planning or execution flow as a workflow file. Choose a combined lifecycle or separate workflows with explicit handoff.
5. Replace fixed plan tools with `artifact_status` and `artifact_action`; replace mode commands with `/hive:select`, `/hive:exit`, and `/hive:status`.
6. Move durable legacy per-agent YAML memory into attached OKF knowledge bundles manually. No automatic content migration is performed.
7. Run `/hive:doctor`, select a workflow, and verify capabilities, checkpoints, workspace binding, dashboard controls, and normal-tool restoration.

The intentionally invalid `examples/invalid-legacy-config` demonstrates the migration diagnostic.

## Security boundary

pi-hive is policy enforcement, not an OS sandbox. Known command/tool interception is defense in depth. Allowed interpreters, scripts, tests, builds, package hooks, and Git hooks can hide filesystem or network effects; external-network denial is best effort. The accepted bare-filename shell-read limitation also remains. Do not grant code execution to hostile inputs or place secrets where model agents can read them. See [SECURITY.md](SECURITY.md).

## Development

```sh
just install
just dashboard-build
just verify
just pack-dry-run
```

The package ships committed dashboard assets, schemas, and examples; consumers do not build them during install.
