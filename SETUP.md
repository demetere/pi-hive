# Building a Hive — Authoritative Setup Guide

This is the **build playbook** for the `pi-hive` extension. Point an agent at this file in any project and say *"set up a hive for this project following pi-hive/SETUP.md"*. The agent should **interview the user** (teams, members, domains, models) using the questions in §3, then scaffold `.pi/hive/` exactly as specified in §5–§9, and validate with §11.

The extension is installed globally at `~/.pi/agent/extensions/pi-hive/` and auto-loads in every project, but it **only activates when a project contains `.pi/hive/hive-config.yaml`**. Building a hive = creating that file plus the agent prompt files it points to.

> **Authoring rule for the agent doing the build:** Do not invent config keys, frontmatter fields, or directory names. Everything you may use is enumerated in this document. If a need arises that this guide does not cover, ask the user — do not guess. Use kebab-case for all YAML keys (the loader converts `foo-bar` → `fooBar` internally).

---

## 1. What a hive is

A hive is a hierarchical team of `pi` agents driving one project:

```
Orchestrator              ← the single visible session; routes, never edits
├─ Team Lead A            ← owns a domain; fans work to its members
│   ├─ Member             ← specialist (leaf)
│   └─ Member
├─ Team Lead B
│   ├─ Member
│   └─ Sub-Lead           ← a member that itself has members (nests arbitrarily deep)
│       └─ Member
└─ Team Lead C
```

Runtime behavior:
- The **main session** is the only user-facing voice — the visible top-level Pi session. It delegates **only to top-level leads**, then synthesizes their answers. (Internally this is the root "orchestrator" node; `main:` is the config-facing key, and `orchestrator:` is still accepted as an alias.)
- Each **lead** receives a focused task and fans it out to **its own direct reports** via `delegate_agent`, then synthesizes.
- Each agent runs as a **separate `pi` subprocess** with its own session transcript, its own tool allow-list, and **enforced filesystem domains + agent-type policy**.
- After a worker finishes, a cheap-model **distiller** consolidates that agent's durable `*-mental-model.yaml` out-of-band.

### Session modes (normal / plan / hive)
The session runs in one of three modes; the main Pi session changes identity with the mode:
- **normal** — plain Pi chat. No hive tools, **no enforcement**. The hive is dormant.
- **plan** — the **planning team** is active. The main session is a `planner`; it drives planners to produce a complete spec under `.pi/hive/plans/<change-id>/` (proposal → requirements → design → tasks). No code execution. Enforcement is on (planners cannot touch code).
- **hive** — the **execution team** is active. The main session is a `lead`; it delegates to coders/testers/reviewers to build the approved spec. Enforcement is on.

Switch modes with `/hive-normal`, `/hive-plan-mode`, `/hive`, or cycle normal → plan → hive → normal with **`/hive-toggle`** / **Ctrl+Alt+T**. `/hive-execute <change-id>` switches to hive mode and drives execution from an approved `tasks.md`.

The two teams are configured as **two required blocks** in `hive-config.yaml` — a `planning:` block **and** a `hive:` block — each with its own `main:` (the main session's identity for that mode) and `agents:` (its reports). The loader **hard-throws** if either block is missing: there is no top-level `orchestrator:`/`agents:` shape and no fallback of plan mode onto the hive team. Keeping the two hierarchies explicit is deliberate so a project cannot silently run plan mode against its coding tree (see §1's shape reference below).

### The one rule that drives the whole structure
**Roles are derived from structure, never declared.** A node is:
- the **orchestrator** if it's the `orchestrator:` entry,
- a **lead** if it's a top-level agent **or** has `members:`,
- a **member** if it has no `members:`.

Delegation permission follows the same tree: **a node may delegate only to its direct reports.** The orchestrator's reports are the top-level agents; a lead's reports are its `members`. You never declare permissions — you express them by nesting.

---

## 2. Decide the shape first (the mental model to hold)

Before writing anything, the agent should help the user converge on a tree. Good hives mirror **how the work actually divides**, not an org chart. Heuristics:

- **Teams = phases or concerns of the work**, not job titles. Typical software hive: a *Planning/Requirements* team, an *Engineering* team, a *Validation/QA* team. A data project might have *Ingestion*, *Modeling*, *Analysis*. A writing project might have *Research*, *Drafting*, *Editing*.
- **Members = the distinct specialist lenses** a lead needs. Engineering often splits into Frontend / Backend (and Backend may nest a Database sub-lead). Validation splits into QA / Security.
- **Keep it as small as it can be.** Every agent is a subprocess and a prompt; more agents = more cost and coordination. Start with 2–4 leads, 1–3 members each. Add depth only where a member genuinely owns a sub-area with its own reports.
- **A lead with one member is a smell** — either inline that work into the lead or add the missing sibling.

---

## 3. Interview the user (ask these, in order)

Ask conversationally; batch related questions. Don't proceed to scaffolding until you have answers (or the user says "use sensible defaults").

1. **Project domain & stack.** "What is this project, and what's the tech stack?" (Drives team naming, domains, and the per-agent knowledge files.)
2. **Teams (top-level leads).** "What top-level teams should the hive have? For each, what does it own?" Offer a default for the project type if they're unsure (e.g. for an app: Planning, Engineering, Validation).
3. **Members per team.** "For each team, what specialist members does the lead need?" Probe for the natural splits (frontend/backend, qa/security, etc.). Ask whether any member needs its own sub-members (a sub-lead).
4. **Filesystem domains.** For every agent that touches files: "Which directories may this agent **read**, and which may it **write** (`upsert`) or **delete**?" This is the security boundary (see §8). Leads usually get read-only over the repo + write to docs/specs; coders get write to their code area.
5. **Tools per agent.** "Should this agent edit files (`edit`/`write`), run shell (`bash`), or only read/search?" Default members to `read, grep, find, ls` + the hive tools; grant `edit`/`write` only to agents that implement. Grant `bash` sparingly.
6. **Models & thinking.** "Which model should each tier use, and what thinking level?" Common pattern: leads on a strong reasoning model, members on a capable coding model, all `inherit` to track the session model if the user prefers. Thinking: `off` for routing/light work, `low`/`medium` for implementers, higher for hard reviewers. (Valid: `off, minimal, low, medium, high, xhigh`.)
7. **Distiller model.** "Pick a cheap model for memory distillation (or disable it)." Needs a `provider/id` pi can route (e.g. `openai-codex/gpt-5.4-mini`). Required unless disabled.
8. **Shared house rules (optional).** "Any one-liner rule every agent must follow?" Goes in `shared_context` (kept tiny — paid on every delegation).

After gathering answers, **summarize the proposed tree back to the user and get confirmation** before creating files.

---

## 4. Directory layout (the folder tree mirrors the agent tree)

Create exactly this structure under the project root. Each agent lives in its own folder named after it (kebab-case), holding its `.md` + its `*-mental-model.yaml`. Members nest inside their lead's folder. The orchestrator is a singleton at the `agents/` root.

```
.pi/hive/
  hive-config.yaml                      # hierarchy + global settings (the only "registry")
  README.md                             # optional, project-specific notes
  agents/
    orchestrator.md
    orchestrator-mental-model.yaml
    <lead-a>/
      <lead-a>.md
      <lead-a>-mental-model.yaml
      <member>/
        <member>.md
        <member>-mental-model.yaml
      <sub-lead>/
        <sub-lead>.md
        <sub-lead>-mental-model.yaml
        <member>/
          <member>.md
          <member>-mental-model.yaml
    <lead-b>/ ...
  knowledge/                            # always-inlined context/reference files
    behavior-*.md                       # cross-cutting behaviors (shared by many agents)
    <project>-architecture.md           # reference docs
  skills/                               # Pi Agent Skills explicitly granted to agents
    <skill-name>/SKILL.md               # standard skill frontmatter + instructions
  sessions/                             # runtime-generated; do NOT hand-create. gitignore it.
```

Conventions:
- Folder & file stems are the agent name in **kebab-case** (`Backend Dev` → `backend-dev/backend-dev.md`).
- The mental-model file is loaded **by convention** as the sibling `<stem>-mental-model.yaml`. You never reference it in frontmatter.
- `sessions/` is created at runtime (transcripts, logs). Add `.pi/hive/sessions/` to the project `.gitignore` (or the whole `.pi/` if that's the project's convention).

---

## 5. `hive-config.yaml` — schema & template

This file declares **only**: the orchestrator, the agent tree (`name` / `color` / `path` / nested `members`), `shared_context`, and `settings`. **No behavior** goes here — behavior lives in each agent's `.md` frontmatter (frontmatter wins: the runtime reads `attrs.X || agent.X`).

### Settings keys (kebab-case in the file)

| Key | Meaning | Default |
|---|---|---|
| `subagent-output-limit` | Max chars of a worker's answer surfaced to its caller | `12000` |
| `default-tools` | Fallback tool list **only** if an agent omits `tools` | `read, grep, find, ls` |
| `max-parallel` | Max concurrent subprocess runs **per process** | `3` |
| `distiller.enabled` | Run the mental-model distiller after each worker | `true` |
| `distiller.model` | `provider/id` for distillation (required if enabled) | — |
| `distiller.conversation-lines` | Tail of the session fed to the distiller | `200` |

### Template (copy, then edit to the confirmed tree)

```yaml
---
# Hierarchy + global defaults only. Per-agent behavior lives in each agent's .md
# frontmatter. A node is a lead if it is top-level or has `members`; a leaf is a
# member. Delegation = a node to its direct reports only. Roles are derived, not declared.
#
# Two team blocks: `hive:` (execution, active in hive mode) and `planning:`
# (optional, active in plan mode). Each has a `main:` (the main session's identity
# for that mode) plus `agents:` (its reports). `main` IS the visible main
# session — give the planning main agent-type: planner (or lead) and the hive main
# agent-type: lead in their .md frontmatter.

# Inlined into EVERY agent's prompt. Keep tiny (paid per delegation). Usually [].
shared_context: []

settings:
  subagent-output-limit: 12000
  default-tools: read, grep, find, ls
  max-parallel: 10
  distiller:
    enabled: true
    model: openai-codex/gpt-5.4-mini   # see: pi --list-models
    conversation-lines: 200

# PLAN mode team (optional). The main session drives planners to produce full specs.
planning:
  main:
    name: Plan Lead
    color: "#f9e2af"
    path: .pi/hive/agents/plan-lead.md       # frontmatter: agent-type: planner (or lead)
  agents:
    - name: Requirements Planner
      color: "#fab387"
      path: .pi/hive/agents/planning/requirements/requirements.md   # agent-type: planner
    - name: Design Planner
      color: "#f9e2af"
      path: .pi/hive/agents/planning/design/design.md               # agent-type: planner

# HIVE mode team (execution). The main session delegates to leads who fan out to members.
hive:
  main:
    name: Orchestrator
    color: "#cba6f7"
    path: .pi/hive/agents/orchestrator.md    # frontmatter: agent-type: lead
  agents:
    - name: <Lead A>
      color: "#fede5d"
      path: .pi/hive/agents/<lead-a>/<lead-a>.md
      members:
        - name: <Member>
          color: "#f0c674"
          path: .pi/hive/agents/<lead-a>/<member>/<member>.md
        - name: <Member>
          color: "#b893ce"
          path: .pi/hive/agents/<lead-a>/<member>/<member>.md

    - name: <Lead B>
      color: "#8bd5ca"
      path: .pi/hive/agents/<lead-b>/<lead-b>.md
      members:
        - name: <Member>
          color: "#74c7ec"
          path: .pi/hive/agents/<lead-b>/<member>/<member>.md
        - name: <Sub-Lead>          # a member with its own members → becomes a sub-lead
          color: "#f38ba8"
          path: .pi/hive/agents/<lead-b>/<sub-lead>/<sub-lead>.md
          members:
            - name: <Member>
              color: "#a6e3a1"
              path: .pi/hive/agents/<lead-b>/<sub-lead>/<member>/<member>.md
```

> **Both blocks are required.** `hive-config.yaml` must define *both* a `hive:` team block and a `planning:` team block — the loader hard-throws otherwise. There is no top-level `orchestrator:` / `agents:` shape: keeping the two hierarchies explicit is deliberate so a project cannot silently run plan mode against its coding tree.

Rules:
- Every `name` must be **unique** across the whole tree (case-insensitive). Duplicates are dropped. Names are shared across both blocks' namespace — do not reuse a name between `planning:` and `hive:` unless it is deliberately the same agent.
- `path` is repo-relative and must point at an existing `.md` you create in §6–§7.
- `color` is `#rrggbb` (used in the tree widget and inline labels). Give each agent a distinct color.

YAML subset supported by pi-hive:
- Use two-space indentation, nested maps, and `- ` list items.
- Use scalar strings, booleans, numbers, and simple inline arrays such as `[read, grep, find]`.
- Kebab-case keys are converted to camelCase internally (`subagent-output-limit` → `subagentOutputLimit`). Snake_case keys are NOT auto-converted, so where both spellings are documented (e.g. `shared_context:` / `shared-context:`) the loader accepts each explicitly; prefer the kebab form for anything else.
- Quote strings containing `#` or leading/trailing whitespace.
- Do not rely on anchors, aliases, block scalars (`|` / `>`), tags, flow objects, or other advanced YAML features.

---

## 6. Agent `.md` files — frontmatter contract

Every agent (orchestrator, leads, members) is a Markdown file: **YAML frontmatter** (its config) + **body** (its system prompt / role instructions). The runtime parses frontmatter with a YAML-lite parser, so:
- Use **kebab-case** keys (`routing-tags`, `consult-when`) — converted to camelCase internally.
- Keep it simple: nested maps and `- ` lists work; avoid exotic YAML.

### Frontmatter fields

| Field | Required | Type | Notes |
|---|---|---|---|
| `name` | yes | string | Must match the name in `hive-config.yaml`. |
| `model` | **yes** | string | `provider/id` (e.g. `openai-codex/gpt-5.5`) or `inherit` (use the live session model). No global default — every agent declares it. |
| `thinking` | **yes** | string | One of `off, minimal, low, medium, high, xhigh`. |
| `agent-type` | **yes** | string | One of `planner, coder, tester, reviewer, lead`. Enforced capability type (see §7.1). Config **hard-fails** if missing/invalid. The orchestrator and every lead/routing node is `lead`. |
| `stages` | no | list | **Planner-only.** Which planning gates this planner may write: any of `proposal, requirements, design, tasks`. Omitted = all four. Error if set on a non-planner. |
| `commit` | no | string | Optional commit guidance. Its **presence** unlocks the commit gate for this agent (only leads carry it). The text is injected into the agent's prompt. |
| `tools` | no | list | Allow-list of tool names for this agent. Falls back to `default-tools` if omitted. See §7. |
| `context` | no | list of `{path, use-when}` | Files **always inlined** into the prompt (full content). The agent's always-on knowledge. |
| `skills` | no | list of `{path, use-when}` | On-demand procedures using Pi's native skill system. Worker launches disable ambient discovery with `--no-skills` and pass these paths explicitly with `--skill`. |
| `domain` | no | list of `{path, read, upsert, delete, include, exclude, description}` | **Enforced** filesystem scopes. See §8. |
| `routing-tags` | no | list | Keywords that bias the orchestrator/leads to route matching tasks here. |
| `consult-when` | no | string | One-line "use me when…" shown in the routing catalog. |
| `responsibilities` | no | list | Bullets describing what this agent owns. |
| `color` | no | string | Overrides the config color if set. |

> Do **not** put delegation/permission fields in frontmatter — the hierarchy in `hive-config.yaml` is the sole source of who-can-delegate-to-whom.

### Body (the system prompt)
Write the role's operating instructions: who they are, principles, conventions, and a **response contract** (the shape of their answer). Keep it focused on judgment and standards, not delegation mechanics (the runtime injects those). End with a note that durable lessons are curated automatically (so they should state stable facts plainly).

---

## 7. Tools — the hive toolset + when to grant file tools

These extension tools can be granted via an agent's `tools` list:

| Tool | Grant to | Purpose |
|---|---|---|
| `delegate_agent` | **leads only** (anyone with members) | Delegate a focused task to a direct report and get its answer. The core fan-out tool. |
| `route_agent` | leads / orchestrator | Score which agent should handle a task before delegating. |
| `team_status` | any | Inspect live session, active runs, per-agent tokens/cost. |
| `team_conversation` | any | Read **one named agent's** transcript (scoped; requires an `agent` arg). Used to inspect e.g. what a reviewer found. |
| `hive_sdd_status` | orchestrator / leads | Inspect the plan store (`.pi/hive/plans/`) active changes and recommended phase routing. |

Type-scoped hive tools (granted automatically by `agent-type`, not listed in `tools`): `submit_review_verdict` (reviewers), `plan_new` / `plan_select` / `approve_plan` (leads). You do not add these to a `tools` list.

Built-in `pi` tools you allow per role: `read`, `grep`, `find`, `ls` (read/search — safe default for everyone), `edit`, `write` (mutate files — only implementers), `bash` (shell — grant sparingly; mutating bash is gated by domains, see §8).

Guidance:
- **Members that only analyze** → `read, grep, find, ls` + `team_conversation`.
- **Members that implement** → add `edit, write` (and `bash` only if they must run builds/tests).
- **Leads** → `read, grep, find, ls, delegate_agent, route_agent, team_status, team_conversation` (they coordinate; usually no `edit`/`write` unless they also do small fixes).
- **Orchestrator** → `route_agent, delegate_agent, team_status, team_conversation` (no file tools — it never edits).

---

## 7.1 Agent types — the enforced capability policy

Every agent declares an **`agent-type`** in its frontmatter. This is **required** — the config **hard-fails to load** if any agent (including the orchestrator) is missing or has an invalid type. Run `/hive-doctor` to list offenders with a suggested type per agent.

Agent type is **separate from the derived tree role** (orchestrator/lead/member). The tree role governs *delegation*; the agent type governs *what actions an agent may take on what kind of file*. The five types:

| `agent-type` | May mutate | Verdicts | Commits | Typical use |
|---|---|---|---|---|
| `planner` | `spec` / `docs` / `tasks` artifacts only — **never `code`** | no | no | Writes `proposal.md` / `requirements.md` / `design.md` / `tasks.md` under `.pi/hive/plans/`. Scope further with `stages`. |
| `coder` | `code` / `docs` / `tasks` — **never `spec`** | no | only if it has a `commit:` field | Implements production code and tests **within its domain**. |
| `tester` | tests (drawn by its domain `include`/`exclude` globs) | no | only with `commit:` | Writes tests, not production code. |
| `reviewer` | **nothing (read-only)** — may run inspection/test `bash` | **yes** — `submit_review_verdict` (reviewer-only tool) | no | Reads and reviews; submits a structured red/yellow/green verdict. |
| `lead` | **nothing (read-only)** | no | only if it has a `commit:` field | Delegates and coordinates. Includes the orchestrator. |

**Two layers gate every mutation; both must pass.** (1) The **domain** globs (§8) — "may this agent touch this path at all?" (2) The **type policy** — "may this *type* perform this *action* on this *kind of file*?" So a `coder` whose domain allows `src/**` still cannot write a `.pi/hive/plans/**` spec file (wrong type), and a `planner` cannot write `src/**` even if its domain allows it (wrong type × class).

**File classes** are language-agnostic: `spec` (`.pi/hive/plans/**`, `.pi/hive/specs/**`, `openspec/**`), `tasks` (`**/tasks.md`, `**/todo.md`), `docs` (`**/*.md`, `docs/**`), and `code` (everything else). The test-vs-production split is **not** a class — express it per-agent with domain `include`/`exclude` globs (§8): give a `tester` an `include: ["**/*.test.ts"]` write scope and a `coder` an `exclude: ["**/*.test.ts"]` write scope.

**Leads (including the orchestrator) cannot mutate files.** All mutation flows through typed `coder`/`tester` agents. Invariant: *if a file changed, a typed mutator did it.*

**Commits are blocked at the tool layer** unless the agent's config has a non-empty **`commit:`** field (a static config fact — no review-state check). Local working-tree ops (`git merge`, `git rebase`, `git add`, `git status`, `git diff`) stay allowed; publish/history-creation (`git commit`, `git push`, `git tag`, `gh pr merge`, `gh release create`, `npm/pnpm/yarn/bun publish`, `just release`) is blocked without `commit:`. Only leads carry `commit:`; a lead commits the working tree that coders/testers produced. "Commit only when green" is prompt guidance in the `commit:` text, not a mechanical gate.

**`stages` (planner scoping).** A `planner` may optionally list which gate artifacts it may write: `stages: [proposal, requirements]`. Omitted = all four gates. One planner can own all gates, or you can run N specialist planners one gate each — same type, config decides granularity.

Denials return an explanatory tool error (naming the type, class, and reason); the agent reads it and adapts — it is not killed. This matches the domain-denial UX.

---

## 8. Domains — the enforced filesystem boundary (security-critical)

`domain` scopes are **enforced at the tool layer**: `read`/`grep`/`find`/`ls`/`edit`/`write` and path-bearing/mutating `bash` calls outside an agent's domains are **blocked**. This is the real boundary — frontmatter restrictions are cosmetic, domains are not.

Each scope: `{ path, read, upsert, delete, include, exclude, description }`.

- `read`, `upsert`, and `delete` are **required on every scope**. They must be explicit `true` or `false`; omission is a config error.
- `read: true` — may read under this path. `upsert: true` — may create/modify (`edit`, `write`, `mv/cp/touch/mkdir/…`). `delete: true` — may delete (`rm`, etc.).
- Optional `include` / `exclude` globs narrow a scope to matching files under `path` (for example `**/*_test.go`).
- An agent with **no `domain`** is blocked from all path tools (it must work through delegation or just reason).

Capabilities are resolved by **most-specific-wins**: deeper `path` entries beat broader paths; at the same path, matching `include` globs beat catch-all entries; exact ties deny. If no matching scope allows an action, the default is **deny**.

**Carve-outs (broad allow minus a hole).** Because deeper paths win, you grant broadly and subtract with an explicit `false`. This is the idiomatic way to fence a sub-area off from an otherwise-broad grant:

```yaml
domain:
  - path: .                                   # read the whole repo
    read: true
    upsert: false
    delete: false
  - path: backend/internal/                   # write broadly across the backend
    read: true
    upsert: true
    delete: false
  - path: backend/internal/identity/authz/    # ...except this subtree
    read: true
    upsert: false                             # explicit DENY — overrides the allow above
    delete: false
```

Here the agent can read everything (from `.`), write under `backend/internal/`, but **cannot** write under `backend/internal/identity/authz/`. This is how you give one agent broad write while reserving a sub-area for another agent/team.

**File-glob restrictions (test-only writers).** Use a broad read-only scope plus a narrower include-glob write scope:

```yaml
domain:
  - path: backend/internal/patient
    read: true
    upsert: false
    delete: false
    description: "Read the patient area."
  - path: backend/internal/patient
    read: true
    upsert: true
    delete: false
    include:
      - "**/*_test.go"
    description: "May create/modify Go tests only."
```

At the same `path`, the `include` rule is more specific than the catch-all deny, so `*_test.go` writes are allowed while production `.go` writes remain blocked.

Patterns:
- **Coder** → `read: true, upsert: true, delete: false` over its code area (e.g. `backend/`), plus explicit deny carve-outs for any sub-area another agent owns.
- **Lead** → `read: true, upsert: false, delete: false` broadly over the repo, plus `upsert: true` over `docs/` or `tasks/` where it writes specs.
- **Reviewer / QA** → `read: true, upsert: false, delete: false` over what it reviews.
- **Test-only implementer** → broad read scope plus an `include` write scope for test globs such as `**/*_test.go`, `**/*.test.ts`, or `**/*.spec.ts`.
- Reserve `delete: true` for the rare agent that must remove files; default it off explicitly.

Note: `domain` paths are **filesystem scopes resolved by prefix-match at tool-call time**; they need not exist on disk when the hive loads (a path can point at a file the agent will create). This is unlike `context:`/`skills:` paths, which are read at load time and must exist.

Always pair UI/role restrictions with the matching backend/domain restriction — the domain is the security boundary.

---

## 9. Copy-paste agent templates

### 9a. Orchestrator (`agents/orchestrator.md`)

```markdown
---
name: Orchestrator
model: inherit
thinking: off
agent-type: lead
tools:
  - route_agent
  - delegate_agent
  - team_status
  - team_conversation
  - hive_sdd_status
context:
  - path: .pi/hive/knowledge/behavior-conversational-response.md
    use-when: Always use when writing responses.
  - path: .pi/hive/knowledge/behavior-active-listener.md
    use-when: Always. Use the context already inlined in your prompt; call team_conversation(agent) only to inspect a specific agent's transcript.
  - path: .pi/hive/knowledge/team-operating-model.md
    use-when: Deciding whether to answer directly, delegate to one lead, or fan out across teams.
domain:
  - path: .pi/hive/
    read: true
    upsert: false
    delete: false
routing-tags:
  - coordination
  - synthesis
  - delegation
consult-when: Always. Owns top-level routing, synthesis, and team coordination.
responsibilities:
  - Maintain the end-to-end mental model of the conversation and active work.
  - Delegate focused work to the smallest useful set of leads.
  - Synthesize lead outputs into one user-facing answer with evidence and next steps.
---

You are the Orchestrator for this project's hive.

## Role
You are the only user-facing voice. You route work, coordinate leads, preserve the shared mental model, and synthesize results into clear answers.

## Operating Principles
- Do not pretend to inspect files or run commands yourself. Delegate substantive work to the team leads.
- Delegate ONLY to the top-level team leads. Each lead fans work out to its own members — never delegate to a member directly.
- Use the smallest useful pattern: one lead for bounded work, multiple leads for cross-cutting or high-risk work.
- Give each delegation a focused objective, the expected output shape, and relevant constraints.
- Ask for evidence and file paths when code is involved. Resolve disagreement explicitly.

## Synthesis Contract
Return: **Answer** (direct conclusion), **What I delegated** (when useful), **Key evidence** (paths/facts), **Risks/unknowns**, **Next steps**.
```

### 9b. Team lead (`agents/<lead>/<lead>.md`)

```markdown
---
name: <Lead Name>
model: inherit          # or a strong reasoning model, e.g. openai-codex/gpt-5.5
thinking: off           # bump to low/medium for harder coordination
agent-type: lead
# commit: "Only commit when the user explicitly asks after review is green."  # uncomment on the lead that commits
tools:
  - read
  - grep
  - find
  - ls
  - delegate_agent
  - route_agent
  - team_status
  - team_conversation
  - hive_sdd_status
context:
  - path: .pi/hive/knowledge/behavior-conversational-response.md
    use-when: Always use when writing responses.
  - path: .pi/hive/knowledge/behavior-active-listener.md
    use-when: Always. Use the context already inlined in your prompt; call team_conversation(agent) only to inspect a specific agent's transcript.
  - path: .pi/hive/knowledge/behavior-zero-micromanagement.md
    use-when: Always. You are a leader — delegate, never execute unless the task is tiny.
skills:
  - path: .pi/hive/skills/<lead-domain-skill>/SKILL.md
    use-when: <when this procedure applies>
domain:
  - path: docs/
    read: true
    upsert: true
    delete: false
  - path: <area this lead reads to scope work>
    read: true
    upsert: false
    delete: false
routing-tags:
  - <tag>
  - <tag>
consult-when: <one-line: when to route here>
responsibilities:
  - <what this team owns>
  - Coordinate its members and synthesize their findings.
---

You are the <Lead Name> for this project's hive.

## Role
<What this team turns inputs into. Which members to use for what.>

## Conventions
- Break work into focused tasks and delegate to the right member.
- Synthesize results; resolve disagreement instead of averaging it.
- Do specialist work yourself only when the task is small and clearly in your scope.

## Response Contract
Return: <the lead's deliverable shape — goals/scope/decisions, or findings/risks/next-step>.
```

### 9c. Member / specialist (`agents/<lead>/<member>/<member>.md`)

```markdown
---
name: <Member Name>
model: inherit          # or a capable coding model
thinking: off           # low/medium if it implements
agent-type: coder       # coder | tester | reviewer | planner — pick the member's capability type
tools:
  - read
  - grep
  - find
  - ls
  - edit                # include only if this member modifies files
  - write               # include only if this member creates files
  - team_conversation
context:
  - path: .pi/hive/knowledge/behavior-conversational-response.md
    use-when: Always use when writing responses.
  - path: .pi/hive/knowledge/behavior-active-listener.md
    use-when: Always. Use the context already inlined in your prompt; call team_conversation(agent) only to inspect a specific agent's transcript.
  - path: <area>/AGENTS.md
    use-when: Always before working in <area> code.
skills:
  - path: .pi/hive/skills/<role-review-checklist>/SKILL.md
    use-when: <when reviewing/implementing in this area>
domain:
  - path: <area this member owns>
    read: true
    upsert: true        # false for pure reviewers
    delete: false
routing-tags:
  - <tag>
consult-when: <one-line: this member's specialty>
responsibilities:
  - <what this member inspects/produces>
---

You are a <role> for this project.

## Operating Principles
- <domain-specific rules: read the relevant AGENTS.md first, preserve conventions, smallest safe change, etc.>

## Response Contract
Return: **Summary**, **Files inspected**, **Findings**, **Risks**, **Recommended change**, **Verification**, **Durable lessons**.
```

### 9d. Mental-model seed (`<stem>-mental-model.yaml`)

Create one next to each agent `.md`. The distiller maintains it; seed it with a valid spine:

```yaml
metadata:
  owner: <Agent Name>          # MUST match the agent name exactly
  purpose: "Durable architecture, conventions, risks, and useful paths for this role."
  updated: "1970-01-01"        # distiller stamps the real date on first run
risk_patterns: {}
observations: []
open_questions: []
```

The distiller routes new durable facts under pinned body categories: `domain_map`, `conventions`, `principles`, `evaluation`, `routing`, `patterns` (plus the spine above). You don't need to pre-fill the body.

---

## 10. Knowledge and skill files (`knowledge/`, `skills/`)

Use `knowledge/` for reusable context files referenced via `context:` (always inlined). Use `skills/` for reusable procedures referenced via `skills:` (on-demand). Skill paths are passed to Pi's native skill loader for that worker with `--no-skills --skill <path>`.

Recommended starters to create (adapt to the project):
- `behavior-conversational-response.md` — how agents phrase answers.
- `behavior-active-listener.md` — use inlined context; `team_conversation(agent)` only for a specific transcript. **Do not tell agents to bulk-read the shared log** (it's unbounded).
- `behavior-zero-micromanagement.md` — leads delegate, don't hoard implementation.
- `<project>-architecture.md` — a reference map of the codebase/stack.
- Role procedures as skills, e.g. `skills/backend-change-review/SKILL.md`, `skills/qa-test-matrix/SKILL.md`, `skills/security-threat-check/SKILL.md`.

For `skills:`, prefer standard Agent Skills: a directory with `SKILL.md` and `name`/`description` frontmatter. Hive does not scan ambient project/user skill roots for agents; list every skill path the agent should see explicitly.

Naming: prefix by scope — `behavior-*` (cross-cutting), `<role>-*` (role-owned), plus reference docs. Keep each file focused; large files inlined as `context` cost tokens on every run.

---

## 11. Build procedure & validation checklist

**Procedure (the agent does this):**
1. Confirm the tree with the user (§2–§3). Summarize teams → members → domains → models back to them.
2. Create `.pi/hive/` and the full `agents/` folder tree (§4).
3. Write `hive-config.yaml` reflecting the confirmed tree (§5).
4. Write each agent `.md` from the templates (§9), filling role-specific body, tools, domains, models.
5. Seed each `<stem>-mental-model.yaml` (§9d).
6. Create the `knowledge/` and `skills/` files the agents reference (§10).
7. Add `.pi/hive/sessions/` to `.gitignore` (or confirm `.pi/` is already ignored).
8. Validate against the checklist below, then tell the user to **restart their `pi` session**. The global telemetry dashboard starts automatically (if Bun is installed) and the header shows its URL — `/hive-observe` force-restarts it and opens a browser tab. Enter a mode with `/hive-plan-mode` (spec-writing) or `/hive` (execution), or cycle with `/hive-toggle` / `Ctrl+Alt+T`.

**Validation checklist (every item must hold):**
- [ ] `.pi/hive/hive-config.yaml` exists (this is what activates the extension).
- [ ] Every `path` in the config points to a file that **exists**.
- [ ] Every agent `.md` has **`name`, `model`, `thinking`, `agent-type`** in frontmatter (these are required — missing `model`/`thinking`/`agent-type` throws at load). The orchestrator and every lead are `agent-type: lead`.
- [ ] `stages` appears only on `agent-type: planner` agents. `commit:` unlocks the commit gate for whatever agent carries it: commit capability follows this config field, **not** agent-type — there is no "only leads may commit" enforcement, so a small project may deliberately give a leaf agent `commit:`. In practice you will usually put it only on the lead(s).
- [ ] Every `name` is **unique** across the tree and **matches** between config and the agent's frontmatter `name`.
- [ ] Every agent has a sibling `<stem>-mental-model.yaml` with a valid spine and `owner` = the agent's name.
- [ ] Every `context`/`skills`/`domain` path referenced in frontmatter **exists** (knowledge files created).
- [ ] Leads (and only leads/sub-leads) have `delegate_agent` in `tools`. Pure-leaf members do not need it.
- [ ] Agents that edit files have `edit`/`write` in `tools` **and** an `upsert: true` domain over their area. (Tools without a matching domain = blocked at runtime.)
- [ ] The orchestrator has **no** `edit`/`write`/`bash`.
- [ ] `settings.distiller.model` is set (or `distiller.enabled: false`).
- [ ] Spec-driven planning is treated as the default for non-trivial work: plans live under `.pi/hive/plans/<change-id>/` with `proposal → requirements → design → tasks` gates. A lead creates a change with `plan_new`; planners write the gate artifacts; `/hive-execute <change-id>` drives execution from an approved `tasks.md`. Teams map naturally: Planning → proposal/requirements/design/tasks, Engineering (coders/testers) → apply-progress, Validation (reviewers) → verify-report + verdict.
- [ ] Every agent `skills:` entry points to a Pi-loadable skill file or directory; only these explicit skills are exposed to that worker.
- [ ] The global local telemetry dashboard auto-starts on session start (Bun required) and the header shows its URL; `/hive-observe` force-restarts + opens it, `/hive-observe-stop` stops it. It is a shared daemon across all hive sessions and survives an individual session shutdown.
- [ ] All YAML keys are kebab-case; no tabs; consistent 2-space indentation.

**Quick scaffold sanity check** (run after building):
```bash
# every config path resolves
grep -E "path:" .pi/hive/hive-config.yaml | sed 's/.*path: *//' | while read p; do
  [ -f "$p" ] && echo "OK  $p" || echo "MISSING  $p"
done
# every agent .md has the required frontmatter keys
for f in $(grep -rl "^name:" .pi/hive/agents --include="*.md"); do
  for k in name model thinking agent-type; do grep -q "^$k:" "$f" || echo "$f missing $k"; done
done
```

---

## 12. Anti-patterns (do not do these)

- **Declaring tree roles or delegation permissions in frontmatter.** The *tree role* (orchestrator/lead/member) and delegation permissions are derived from the `members` nesting in `hive-config.yaml`. Don't add `role:` or `allowed-agents:` to frontmatter. (The `agent-type` capability field **is** required in frontmatter — that's a different axis; see §7.1.)
- **Giving a lead or the orchestrator a mutating agent-type.** Leads (incl. the orchestrator) are `agent-type: lead` and cannot mutate files. Route all edits to `coder`/`tester` members.
- **Giving the orchestrator file tools.** It routes and synthesizes only.
- **Granting `edit`/`write` without a matching `upsert` domain** (or vice versa) — the agent will be blocked or unable to act.
- **Telling agents to read the whole shared conversation log.** `team_conversation` is scoped per-agent on purpose; bulk reads blow up context.
- **A lead with a single member** — collapse it or add the missing sibling.
- **Fat `shared_context`.** It's paid on every delegation. Put per-role knowledge in each agent's `context:`/`skills:` instead.
- **Hand-creating `sessions/`** — it's runtime state; leave it to the extension and gitignore it.
- **Inventing config keys or directory names** not in this guide. If something's missing, ask the user.
