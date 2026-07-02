# pi-hive: Agent Type System + Planning/Execution Split — Implementation Spec

> **Status:** Ready to implement. This spec supersedes the original brainstorming plan. Every decision below was settled in a design review; where it differs from earlier drafts, this document wins. Build in the phase order given (A→B→C→D→E); each phase is independently shippable and testable.
>
> **Audience:** an engineer/agent implementing this in a fresh session with no prior context. Read the whole "Grounding" section first — several original assumptions were wrong against the real code.

---

## 1. Intent

Add explicit **agent types** and make **spec-driven planning** a first-class workflow. Concretely:

1. Every worker declares an **agent type** (`planner`/`coder`/`tester`/`reviewer`/`lead`) that enforces a capability policy on top of the existing filesystem-domain boundary.
2. Planning produces durable **markdown spec artifacts** under `.pi/hive/plans/<change-id>/`, one approval gate at a time (`proposal → requirements → design → tasks`).
3. Reviewers submit **structured verdicts** (red/yellow/green) via a reviewer-only tool; verdicts, approvals, and comments are stored in **SQLite typed tables**.
4. The **dashboard** renders plans/specs and accepts comments + approvals.
5. Execution is triggered explicitly by a **`/hive-execute <change-id>` command**.

---

## 2. Grounding: what the code actually looks like today

**Read this before writing anything.** These are verified facts about the current tree; several contradict the original plan.

### 2.1 The main Pi session IS the orchestrator
- `src/core/config.ts:67` instantiates `config.orchestrator` with `role:"orchestrator"` and `allowedAgents = top-level agent names`. It is the identity/prompt/domain of the **main session**, not a spawned subprocess. Workers are the subprocesses.
- Therefore "remove the orchestrator" is **not** a goal. It stays. It just gets typed like everything else (see §5).

### 2.2 Workers run IN-PROCESS; current-agent is `AsyncLocalStorage`, not env vars
- Recent commit "Migrate subagent delegation to Pi's in-process SDK" means workers are **not** separate OS processes anymore.
- `src/engine/session.ts:171-179`: `currentAgentName()` reads from an `AsyncLocalStorage<string>` (`currentAgentStorage`), set via `runAsAgent(name, fn)`. **`process.env.PI_HIVE_CURRENT_AGENT` is dead** — do not use env vars for per-agent or per-change state. The active change-id must flow the same way (see §7.1).

### 2.3 Enforcement is stateless, per-tool-call, in `enforceDomainForTool`
- `src/engine/domain.ts:169` `enforceDomainForTool(state, event, ctx)` is the single hook. It resolves the runtime via `currentAgentName()`, extracts paths, and checks `domainAllows(...)` for `read`/`upsert`/`delete`. Returns `{ block: true, reason }` or `undefined`.
- **This is exactly where the new type-policy check plugs in** (see §6.3).
- The glob engine already exists here: `globToRegExp` (domain.ts:37), `globSpecificity` (61), most-specific-wins resolution in `domainAllows` (100). **Reuse it** for the file classifier — do not write a second matcher.

### 2.4 Uncommitted work already in the tree (do not redo)
The working tree has staged-but-uncommitted changes that are the *precursor* to this work:
- `src/core/types.ts`: `DomainScope` gained optional `include?: string[]` / `exclude?: string[]` globs.
- `src/core/normalize.ts`: `normalizeDomainScopes` now requires explicit booleans and parses include/exclude (`requiredBoolean`, `optionalPatternList`).
- `src/core/schema.ts`: `validateDomains` requires booleans + validates include/exclude string lists.
- `src/engine/domain.ts`: glob matching + include/exclude + most-specific-wins added.
- `src/core/prompting.ts`: domain rendering shows include/exclude.
- `tests/config.test.ts`: updated for the above.

**None of this adds agent types, policy, verdicts, or plans yet.** That is this spec's job.

### 2.5 `sdd.ts` reads `openspec/changes/**`, NOT `.pi/hive/plans/**`
- `src/engine/sdd.ts` `PHASE_FILES` = `proposal / specs / design / tasks / apply-progress / verify-report / sync-report`; it scans `join(cwd, "openspec", "changes")`.
- It has **no** `requirements.md`, no `plan.yaml`, no comments/approvals/verdicts.
- `nextPhase()` derives a phase label from which files exist — this is the model we keep (derived, not enforced), but the store must move to `.pi/hive/plans/**` and add `requirements` (see §8).

### 2.6 SQLite is Bun-only and dashboard-only
- `src/observability/server/db.ts` does top-level `import { Database } from "bun:sqlite"`. Existing tables: `sessions`, `events` (generic, `payload_json`), `states`. WAL mode, `busy_timeout=5000`.
- **CLAUDE.md rule:** Bun-specific code stays isolated to dashboard/server paths so the core extension loads even when Bun is unavailable. The core (enforcer/tools/commands) therefore **cannot** `import bun:sqlite`.
- Consequence baked into this design: the core never reads verdict/approval state from SQLite. See §7.

### 2.7 Other anchors
- Custom tools are built in `src/agents/tools.ts` via `buildHiveTools(state, callerName)` using `defineTool(...)` + `Type.Object` (typebox). The same defs are used for the orchestrator's `pi.registerTool()` and each worker's `customTools`.
- Commands register via `pi.registerCommand(...)` in `src/integration/commands.ts`. **`hive-doctor` already exists at `commands.ts:107`** — extend it, don't recreate it.
- Telemetry event types are the union `HiveTelemetryEventType` in `src/shared/telemetry.ts:4`.
- Dashboard write guard: `isSameOriginWrite(req, url)` (imported in `src/observability/server/index.ts:1`), already used on `DELETE` at index.ts:46. Host `127.0.0.1`, port `43191`.
- Worker prompt is assembled in `src/engine/prompts.ts` `buildWorkerPrompt(...)`. Type-specific operating contracts get injected here (see §6.5).

---

## 3. Core design: three concepts, only two enforce

| Concept | Values | Source | Enforced? |
|---|---|---|---|
| **Tree role** | `orchestrator` / `lead` / `member` | derived from hierarchy (`config.ts` `allConfiguredAgents`) | delegation only (unchanged) |
| **Agent type** | `planner` / `coder` / `tester` / `reviewer` / `lead` | explicit `agent-type` in frontmatter | **yes** (type-policy) |
| **Phase** | `proposal` / `requirements` / `design` / `tasks` | derived from which files exist | **no** — dashboard display + prompt guidance only |

**Key decision: there is NO live "workflow phase" state machine.** The original plan gated tools on `(agentType, workflowPhase, fileClass, action)`. We drop `workflowPhase` from enforcement entirely. Enforcement is `(agentType, fileClass, action)` — all statically determinable at the moment of a tool call. "Phase" is only ever *computed* from files on disk for display, exactly like `sdd.ts` `nextPhase()` does today.

**Two layers gate every mutation; both must pass:**
1. **Domain globs** (existing, `domainAllows`): "is this agent allowed to touch this path at all?" — the hard filesystem boundary.
2. **Type policy** (new, `checkTypePolicy`): "may this *agent type* perform this *action* on this *kind of file*?"

---

## 4. Agent-type policy matrix

`checkTypePolicy(agentType, fileClass, action) -> { ok: boolean; reason?: string }`.

**Actions:** `read` | `upsert` | `delete` | `command` (bash) | `verdict` | `commit`.
**File classes (see §6.1):** `spec` | `docs` | `tasks` | `code` (everything not spec/docs/tasks).

> Note: the classifier deliberately does **not** split `code` into test-vs-production globally (that's a per-language treadmill). The tester/coder split is done with **per-agent domain include/exclude globs**, not the classifier. See §6.2.

| Agent type | read | upsert/delete | Notes |
|---|---|---|---|
| `planner` | any | `spec`, `docs`, `tasks` only — **DENY `code`** | `stages` further narrows *which* spec files (see §9.2). No commits. No verdicts. |
| `coder` | any | `code`, `docs`, `tasks` — DENY `spec` mutation | Mutates production/tests **within domain** (domain globs draw the test/prod line). No verdicts. No commits unless `commit:` field. |
| `tester` | any | tests only — the coder-vs-tester file split is via **domain include/exclude**, not type-policy | No verdicts. No commits. (Type-policy treats tester like coder for classes; the tests-only restriction comes from the tester agent's domain config.) |
| `reviewer` | any | **DENY all upsert/delete** (read-only) | May run inspection/test `command`s. Only type that may call `verdict` (`submit_review_verdict`). No commits. |
| `lead` | any (read-only) | **DENY all upsert/delete** | Delegates/coordinates. May `commit` **iff** it has a `commit:` field. Includes the orchestrator. |

**Commit** is orthogonal to the matrix: allowed **iff** the agent config has a `commit:` text field (§7.2), regardless of type — but in practice only `lead`s carry it.

**Denials** return an explanatory tool error naming type + class + reason, e.g.:
`Blocked: agent-type "planner" may not upsert code files. "src/foo.ts" is class=code. Planners write spec/docs/tasks only.`
The agent is **not** killed; it reads the error and adapts. Matches existing domain-denial UX.

---

## 5. Agent types & the orchestrator

- **Five types only:** `planner`, `coder`, `tester`, `reviewer`, `lead`. **One type per agent** (no `agent-types: []` array in v1).
- **`agent-type` is REQUIRED.** Config validation **hard-fails** if any agent lacks it. (Rationale: only two repos use pi-hive today, so a clean break is acceptable; we get real guarantees immediately instead of a half-typed migration.)
- **The orchestrator and every routing/lead node are `agent-type: lead`.** The orchestrator is not exempt — it carries a type so it, too, has limitations. A mutation-capable root would let a human route around the whole type system, making it theater.
- **Leads (including the orchestrator) are mutation-denied.** All file mutation flows through typed `coder`/`tester` agents. Invariant: *if a file changed, a typed mutator did it.* The main session delegates all edits; no direct Edit/Write from the orchestrator.

---

## 6. Phase B detail: file classifier + policy + enforcement

### 6.1 New module `src/engine/file-class.ts`
Pure classifier. **Reuses `globToRegExp`/most-specific-wins from `domain.ts`** (export those helpers from `domain.ts` or move them into a shared `src/engine/glob.ts` imported by both — prefer a small shared module to avoid a circular import).

```ts
export type FileClass = "spec" | "docs" | "tasks" | "code";

// Ordered, most-specific-first. First matching class wins; fallback = "code".
// Only LANGUAGE-AGNOSTIC classes are modeled. Do NOT add test/production globs here.
const RULES: Array<{ cls: FileClass; globs: string[] }> = [
  { cls: "tasks", globs: ["**/tasks.md", "**/todo.md", ".pi/hive/tasks/**"] },
  { cls: "spec",  globs: [".pi/hive/plans/**", ".pi/hive/specs/**", "openspec/**"] },
  { cls: "docs",  globs: ["**/*.md", "docs/**", "**/*.mdx"] },
];

export function classify(pathRelativeToCwd: string): FileClass {
  // toPosix, then test globs in RULES order; return first cls whose any-glob matches; else "code".
}
```

- Input is the **cwd-relative** path (the enforcer already resolves absolute → use `relative(ctx.cwd, target)`).
- `tasks` is checked before `docs` so `tasks.md` classifies as `tasks`, not `docs`.
- Everything unmatched (`src/**`, `*.ts`, `Cargo.toml`, `package.json`, `*_test.go`, …) is `code`.

### 6.2 The test-vs-production split is NOT in the classifier
Different languages disagree (Go `*_test.go`, Rust tests inside `src/**`, Python `test_*.py`, JS `*.test.ts`). Hardcoding this globally is a treadmill and the fallback (`code`) is the dangerous class to get wrong. Instead:
- A **tester** agent gets a domain like `{ path: "src", include: ["**/*.test.ts"], upsert: true, ... }`.
- A **coder** agent gets `{ path: "src", exclude: ["**/*.test.ts"], upsert: true, ... }`.
- Whoever authors that project's agent configs (who knows the language) draws the line. Type-policy just says both may mutate `code`; domains decide *which* code.

### 6.3 New module `src/engine/policy.ts`
```ts
import type { AgentType } from "../core/types";
import type { FileClass } from "./file-class";

export type PolicyAction = "read" | "upsert" | "delete" | "command" | "verdict" | "commit";

// Matrix as data. Pure function; no I/O, unit-testable in isolation.
export function checkTypePolicy(
  agentType: AgentType,
  fileClass: FileClass | null,     // null when the action has no path (e.g. verdict, commit, some commands)
  action: PolicyAction,
): { ok: boolean; reason?: string } { /* implement §4 table */ }
```

### 6.4 Wire into `enforceDomainForTool` (`domain.ts:169`)
After resolving `runtime` and **before/alongside** the existing domain checks:
1. Read `runtime.config.agentType` (guaranteed present post-validation).
2. For each extracted path: `classify(relative(ctx.cwd, resolveDomainPath(ctx, path)))`, then `checkTypePolicy(agentType, cls, action)`. If `!ok`, return `{ block: true, reason }`.
3. Keep existing `domainAllows` checks — **both must pass**. Order: run the type-policy check first (cheaper, clearer message), then domain.
4. Map tools→actions: read tools→`read`; `write`/`edit`→`upsert`; bash→`bashMutationKind` → `read`/`upsert`/`delete` (and treat non-mutating bash as `command` for reviewer inspection allowance).
5. `commit` gating for bash is separate — see §7.2; evaluate it in the bash branch.

### 6.5 Prompt injection (`src/engine/prompts.ts` `buildWorkerPrompt`)
Add a `## Operating contract (agent type)` block built from `runtime.config.agentType`:
- `planner`: "You are a **planner**. You write only spec/requirements/design/tasks artifacts under `.pi/hive/plans/`. You must not modify production or test code." + if `stages` set: "You own these planning gates: `<stages>`."
- `coder`: "You are a **coder**. You implement production code and tests within your domain. You do not issue review verdicts. Tests are typically the tester's job."
- `tester`: "You are a **tester**. You write tests, not production code."
- `reviewer`: "You are a **reviewer**. You are read-only and must submit your final verdict with `submit_review_verdict` — not as chat text."
- `lead`: "You are a **lead**. You delegate and coordinate; you do not modify files." + if `commit:` present: "Commit guidance: `<commit text>`. Never add AI attribution trailers to commit messages."
- **RED discipline is light:** state the tester/coder *division* only. Do **not** mandate test-first ordering — ordering is the orchestrator's per-task delegation choice.

---

## 7. Storage model: documents=files, events=SQLite

**Reversal from the original plan:** there are **no `.jsonl` event files**. Markdown artifacts live as files; verdicts/approvals/comments live in **SQLite typed tables**.

### 7.1 Change-id plumbing
- The active change-id flows through **`AsyncLocalStorage`**, mirroring `currentAgentStorage` (§2.2) — **not** an env var.
- Add to `session.ts`: `currentChangeStorage: AsyncLocalStorage<string | undefined>`, `currentChangeId(): string | undefined`, and thread it in `runAsAgent` (or a sibling `runWithChange`). When a change is selected/created (planning tools, `/hive-execute`), set it around the delegation call chain.
- Absent change-id ⇒ "no active change" ⇒ verdict/approval/comment writes that need a change-id are recorded against the session only (or skipped for plan-scoped rows). This must degrade gracefully, never throw.

### 7.2 Commit gate
- **Blocked by default at the tool layer.** A commit-class bash command is allowed **iff** the current agent's config has a non-empty `commit:` text field. This is a **static config check — no DB read**, so the Bun-less core handles it fine.
- **"Commit only after green" is PROMPT guidance, not a mechanical gate.** The core does not read verdict state to decide commits (it can't reach SQLite). The `commit:` text is injected into the agent's prompt (§6.5).
- **Only leads commit.** Coders/testers have no `commit:` field. A lead commits the working tree that coders/testers produced — `git commit` records others' changes and does not require the lead to have mutated files, so the "leads never mutate" invariant holds.
- **Commit detection (broad, two-tier), in the bash branch of `enforceDomainForTool`:**
  - **Blocked without `commit:`** (publish / history creation): `git commit` (incl. `-m`, `-am`, `--amend`), `git push`, `git tag`, `gh pr merge`, `gh release create`, `npm|pnpm|yarn|bun publish`, and release runners (`just release`). Include common aliases (`gc`, `gp`, `gcm`).
  - **Always allowed** (local working-tree ops, no publish): `git merge`, `git rebase`, `git cherry-pick`, `git add`, `git status`, `git diff`, etc.
  - **Word-boundary aware** parsing of the command head (same spirit as `bashMutationKind`) so `git commit-graph` or a path containing "commit" does not false-positive.
- **Commit messages must contain no AI attribution trailers** (enforced by prompt only; CLAUDE.md already forbids them).

### 7.3 New SQLite tables (`src/observability/server/db.ts`)
Typed tables (not the generic `events` blob — real columns, no `payload_json` parsing). Add to the `db.run(...)` schema block:

```sql
CREATE TABLE IF NOT EXISTS plan_verdicts (
  id           TEXT PRIMARY KEY,
  change_id    TEXT NOT NULL,
  reviewer     TEXT NOT NULL,
  verdict      TEXT NOT NULL,          -- 'red' | 'yellow' | 'green'
  summary      TEXT,
  evidence_json TEXT,                  -- string[]
  concerns_json TEXT,                  -- string[]  (yellow: non-blocking)
  blockers_json TEXT,                  -- string[]  (red: must-fix)
  session_id   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_verdicts_change ON plan_verdicts(change_id, created_at);

CREATE TABLE IF NOT EXISTS plan_approvals (
  id           TEXT PRIMARY KEY,
  change_id    TEXT NOT NULL,
  phase        TEXT NOT NULL,          -- 'proposal'|'requirements'|'design'|'tasks'
  approved_by  TEXT NOT NULL,          -- 'ui' | 'chat'
  actor        TEXT,
  summary      TEXT,
  session_id   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_approvals_change ON plan_approvals(change_id, created_at);

CREATE TABLE IF NOT EXISTS plan_comments (
  id           TEXT PRIMARY KEY,
  change_id    TEXT NOT NULL,
  file         TEXT,                   -- which artifact the comment targets (nullable = general)
  anchor       TEXT,                   -- heading/section anchor within the file (nullable)
  author       TEXT,
  body         TEXT NOT NULL,
  session_id   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_comments_change ON plan_comments(change_id, created_at);
```

Add prepared-statement helpers next to `insertEvent` (e.g. `insertPlanVerdict`, `insertPlanApproval`, `insertPlanComment`) and query helpers (`latestVerdict(changeId)`, `listApprovals(changeId)`, `listComments(changeId)`, `listVerdicts(changeId)`).

> **Who writes these:** the dashboard server writes comments/approvals (from UI POST) and reads all three. The reviewer's `submit_review_verdict` tool runs in core (Bun-less) → it **cannot** write SQLite directly. Resolve via §7.4.

### 7.4 How `submit_review_verdict` (core) records to SQLite (Bun-only)
The verdict tool runs in the core extension, which can't `import bun:sqlite`. Record the verdict as an ordinary **telemetry event** (the existing event pipeline already crosses core→dashboard), then have the **dashboard's telemetry runtime** materialize it into `plan_verdicts` on ingest:
1. Add `"review_verdict"` to `HiveTelemetryEventType` (`telemetry.ts:4`).
2. `submit_review_verdict` emits a `review_verdict` event with payload `{ changeId, reviewer, verdict, summary, evidence, concerns, blockers }` through the same path other events use.
3. In the dashboard server's event-ingest (where events land in the `events` table — see `runtime.ts` / `db.ts` `insertEvent`), add a hook: when `type === "review_verdict"`, also `insertPlanVerdict(...)` from the payload.
- This keeps the core free of SQLite, reuses the one-way core→dashboard event flow, and still yields a queryable typed table.
- Approvals/comments originating from the **UI** are written directly by the dashboard server (it's Bun) via the POST endpoints (§10) — no event round-trip needed. Approvals originating from **chat** go through an `approve_plan` tool that emits a `plan_approval` event, materialized the same way as verdicts.

---

## 8. Phase D detail: plan store migration (`sdd.ts` → `.pi/hive/plans/**`)

### 8.1 Canonical layout
```
.pi/hive/plans/<change-id>/
  plan.yaml            # metadata: title, status, current phase, owner
  proposal.md          # why / what / scope / success criteria
  requirements.md      # user requirements, acceptance criteria, edge cases   ← NEW vs current sdd.ts
  design.md            # technical approach, trade-offs
  tasks.md             # ordered checklist
  specs/               # optional detailed capability specs
  apply-progress.md    # execution evidence
  verify-report.md     # reviewer/test evidence summary
```
- **No** `comments.jsonl` / `approvals.jsonl` / `verdicts.jsonl` — those are SQLite tables now (§7.3).

### 8.2 Changes to `src/engine/sdd.ts`
- Change the scan root from `join(cwd, "openspec", "changes")` to `join(cwd, ".pi", "hive", "plans")`. Optionally keep an OpenSpec fallback read if `.pi/hive/plans` is absent (nice-to-have, not required).
- Update `PHASE_FILES` to the planning-gate set plus evidence: `proposal → requirements → design → tasks → apply-progress → verify-report`. (Drop `sync-report`/`spec`-dir-as-phase unless you want them; the **derived phase list the dashboard shows is `proposal → requirements → design → tasks`** — the evidence files are status detail, not gates.)
- `nextPhase()` logic is unchanged in spirit: first missing gate file = next phase; all present = ready/execute.
- Update `resolveHiveSddStatus` / `renderHiveSddStatus` / `renderSddPromptBlock` wording from "OpenSpec" to "Hive plan store" and point paths at `.pi/hive/plans/**`.

### 8.3 `/hive-execute <change-id>` command (`src/integration/commands.ts`)
- Register via `pi.registerCommand("hive-execute", { ... })`.
- Behavior: validate the change-id folder exists and `tasks.md` is present (and, if you track it, approved in `plan_approvals`). Set the active change-id in `currentChangeStorage`, read `tasks.md`, and drive the existing delegation flow (route/delegate to coder/tester leads) to execute the tasks. Reuse `dispatchAgent`/routing already used by the tools.
- This is the **only** execution trigger in v1. The dashboard "Execute" button is **deferred** (it would require signalling the live Pi session from the separate dashboard process — an intent-row the session polls — which is out of scope now).

### 8.4 Planning tools/commands
- Provide a way to create/select a change-id (a `plan_new`/`plan_select` tool or a `/hive-plan` command) that scaffolds the folder + `plan.yaml` and sets `currentChangeStorage`.
- Planners write artifacts with normal file tools; type-policy + `stages` (§9.2) constrain them to spec/docs/tasks and to their assigned gates.
- Chat approval: an `approve_plan` tool that appends a `plan_approval` (via event → materialized, §7.4) with `approved_by:"chat"`, `phase`, `actor`.

---

## 9. Config / frontmatter changes

### 9.1 Types (`src/core/types.ts`)
```ts
export type AgentType = "planner" | "coder" | "tester" | "reviewer" | "lead";
export type PlanStage = "proposal" | "requirements" | "design" | "tasks";

// in AgentConfig:
interface AgentConfig {
  // ...existing...
  agentType: AgentType;        // REQUIRED (validation hard-fails if missing)
  stages?: PlanStage[];        // planner-only; omitted = all four gates
  commit?: string;             // optional commit guidance; presence unlocks commit gate
}
```

### 9.2 `stages` semantics (planner scoping)
- A `planner` with `stages: [design]` may write `design.md` but not `proposal.md`/`requirements.md`/`tasks.md`.
- Omitted `stages` on a planner ⇒ may write all four gate files.
- One planner covering all gates, or N specialist planners one gate each — **same type; config decides granularity.** No threshold/auto-scaling logic.
- Enforcement: extend the type-policy path so that for a `planner` upserting a `spec`/`tasks` file, the specific target filename is checked against `stages` (map `proposal.md→proposal`, `requirements.md→requirements`, `design.md→design`, `tasks.md→tasks`). Non-gate spec files (e.g. under `specs/`) require `design` or are allowed for any planner — pick "allowed for any planner" for simplicity in v1.
- `stages` is also injected into the planner's prompt (§6.5).

### 9.3 Frontmatter spelling
```yaml
---
name: Backend Coder
agent-type: coder
---
```
```yaml
---
name: Requirements Planner
agent-type: planner
stages: [proposal, requirements]
---
```
```yaml
---
name: Engineering Lead
agent-type: lead
commit: "Only commit when the user explicitly asks after review is green."
---
```

### 9.4 Parsing (`src/core/config.ts` / `src/engine/session.ts`)
- Read `agent-type` in the same frontmatter→config path as `model`/`thinking`/`color`. Kebab `agent-type` → camel `agentType`. Do it in `loadAgentRuntime` (session.ts:70-86, the `mergedConfig` block) and/or `enrichFromFrontmatter` (config.ts:14) so both display and spawn see it.
- Read `stages` and `commit` the same way (`normalizeStringList` for `stages`; trimmed string for `commit`).

### 9.5 Validation (`src/core/schema.ts`)
- In `validateAgent` (schema.ts:52), add:
  - `assertEnum(agent.agentType, ["planner","coder","tester","reviewer","lead"], `${label}.agentType`)` — **required**, hard-fail if missing/invalid.
  - If `agent.stages` present: must be an array whose members ∈ the four gates, and only meaningful for `agentType==="planner"` (warn or error if set on a non-planner — prefer error for cleanliness).
  - If `agent.commit` present: must be a non-empty string.
- **Because `agent-type` is required, every agent in `orchestrator` + `agents[]` must declare it** — including the orchestrator node (which must be `lead`).

### 9.6 Migration story
- **No auto-migration.** Only two repos use pi-hive; a clean break is acceptable.
- **Extend `hive-doctor` (`commands.ts:107`)** to detect and report agents missing/invalid `agent-type`, printing an inferred suggestion per agent (heuristics: name/role contains "review"→`reviewer`, "test"→`tester`, "plan"/"product"/"requirement"→`planner`, is orchestrator or has reports→`lead`, else `coder`). **Report only — do not auto-write files.**
- Update all `SETUP.md` agent templates to include `agent-type` (and `stages`/`commit` where illustrative).
- Update `tests/config.test.ts` fixtures so every agent has `agent-type` (otherwise the suite red-fails once validation is required).

---

## 10. Phase E detail: dashboard (read + write comments/approvals)

### 10.1 Server (`src/observability/server/index.ts` + `runtime.ts`)
Add local-only endpoints (all writes behind `isSameOriginWrite`, same pattern as the `DELETE` handler at index.ts:46):
- `GET /plans` — list change-ids from `.pi/hive/plans/**` with derived phase + latest verdict (join `plan_verdicts`).
- `GET /plans/:changeId` — metadata (`plan.yaml`), phase, artifact list, latest verdict, approvals, comments.
- `GET /plans/:changeId/file?path=...` — return a specific artifact's markdown (path-guarded to the change folder; no traversal).
- `POST /plans/:changeId/comments` — `isSameOriginWrite`; body `{ file?, anchor?, author?, body }` → `insertPlanComment`.
- `POST /plans/:changeId/approval` — `isSameOriginWrite`; body `{ phase, actor?, summary? }` → `insertPlanApproval` with `approved_by:"ui"`.
- (Verdicts are written server-side from the `review_verdict` event, §7.4; a `POST /plans/:changeId/verdict` may be added later but is not required for v1.)

### 10.2 UI (`ui/web/src/**`)
- New **Plans** tab: list plans; per-plan view renders markdown artifacts (proposal/requirements/design/tasks), shows the task checklist from `tasks.md`, a verdict timeline (red/yellow/green with summary/evidence/concerns/blockers), an approvals timeline, and a comments panel with a submit form (targets a file/anchor).
- **After editing `ui/web/src/**`, run `just build-dashboard`** and commit `ui/web/dist/` (per CLAUDE.md — dist is shipped, not built at install).

### 10.3 Comment anchoring
- Comments may target a whole artifact (`file`) and optionally a section (`anchor` = heading slug). Free-form body. Line-level anchoring is out of scope for v1 (heading-level is enough).

---

## 11. Structured verdict shape (Phase C)

```ts
export type ReviewVerdict = {
  changeId: string;
  reviewer: string;
  verdict: "red" | "yellow" | "green";
  summary: string;
  evidence: string[];   // what was checked / commands run
  concerns: string[];   // yellow: non-blocking follow-ups
  blockers: string[];   // red: must-fix before proceeding
  createdAt: string;    // ISO
};
```
**Semantics:** `green` = clean approval; `yellow` = **approve with non-blocking concerns** (proceed, surface `concerns` to the human); `red` = blocked, populate `blockers`.

**`submit_review_verdict` tool (`src/agents/tools.ts`, via `defineTool`):**
- Parameters (typebox `Type.Object`): `verdict` (enum), `summary` (string), `evidence` (string[]), `concerns` (string[] optional), `blockers` (string[] optional). `changeId` comes from `currentChangeId()` (fallback to a parameter if absent).
- **Registered ONLY for `reviewer` agents.** Filter at tool-assembly time: in `buildHiveTools` (or wherever per-agent `customTools` are chosen), include `submit_review_verdict` only when the caller's `agentType === "reviewer"`. Non-reviewers never see it — no runtime-rejection path.
- On call: emit a `review_verdict` telemetry event (§7.4) and return a concise confirmation. Also surface latest verdict in `team_status` output.

---

## 12. Implementation phases (build in this order)

### Phase A — Types, validation, migration signalling
- `src/core/types.ts`: add `AgentType`, `PlanStage`, and `agentType` (required) / `stages?` / `commit?` on `AgentConfig`.
- Parse `agent-type`/`stages`/`commit` from frontmatter (`config.ts` + `session.ts`).
- `schema.ts`: required-enum validation + `stages`/`commit` checks (hard-fail on missing `agent-type`).
- Extend `hive-doctor` to report untyped agents with inferred suggestions (no auto-write).
- Update `SETUP.md` templates + `tests/config.test.ts` fixtures.
- **Tests:** valid types parse; missing type hard-fails; invalid type hard-fails; `stages` on non-planner rejected; `commit` string parsed; orchestrator requires a type.

### Phase B — File classifier + policy + enforcement
- Extract glob helpers into `src/engine/glob.ts` (shared by `domain.ts` + `file-class.ts`).
- `src/engine/file-class.ts`: `classify()` (spec/docs/tasks/code).
- `src/engine/policy.ts`: `checkTypePolicy()` implementing §4.
- Wire into `enforceDomainForTool` (both layers must pass); commit gate in the bash branch (§7.2).
- Inject type-specific operating contracts in `buildWorkerPrompt` (§6.5).
- **Tests (per type × class × action):** reviewer upsert blocked; planner code-upsert blocked; planner spec-upsert allowed; planner `design.md` allowed but `proposal.md` blocked when `stages:[design]`; coder code-upsert allowed, spec-upsert blocked; lead upsert blocked; commit blocked without `commit:` field and allowed with it; `git merge` allowed; `git commit-graph` not treated as commit; both-layers-must-pass (in-domain but wrong-type still blocked).

### Phase C — Structured verdicts + SQLite tables
- Add `plan_verdicts`/`plan_approvals`/`plan_comments` tables + statement/query helpers in `db.ts`.
- Add `"review_verdict"` (and `"plan_approval"`, `"plan_comment"` if used) to `HiveTelemetryEventType`.
- `submit_review_verdict` tool, reviewer-only registration.
- Materialize `review_verdict` (and chat `plan_approval`) events into typed tables on dashboard ingest.
- Surface latest verdict in `team_status`.
- **Tests:** verdict tool absent for non-reviewers, present for reviewers; green/yellow/red persisted; latest-verdict query; graceful behavior with no change-id.

### Phase D — Plan store migration + execution trigger
- Migrate `sdd.ts` to `.pi/hive/plans/**`, add `requirements` gate, update rendering/prompt wording.
- Change-id `AsyncLocalStorage` plumbing in `session.ts`.
- `plan_new`/`plan_select` (or `/hive-plan`) + `approve_plan` tool.
- `/hive-execute <change-id>` command.
- **Tests:** phase derivation over the new layout; `requirements.md` counted; `/hive-execute` validates change-id + tasks presence; change-id propagates via storage.

### Phase E — Dashboard plans UI (read + write)
- Server endpoints (§10.1) with `isSameOriginWrite` on writes.
- Plans tab UI (§10.2): render artifacts, task checklist, verdict/approval timelines, comment submit.
- `just build-dashboard`, commit `ui/web/dist/`.
- **Tests/verify:** endpoints return expected shapes; cross-origin writes blocked; comment/approval round-trips into SQLite and renders.

---

## 13. Acceptance criteria
- A `planner` can write `proposal.md`/`requirements.md`/`design.md`/`tasks.md` (subject to `stages`) but **cannot** edit `src/**` (`code`).
- A `coder` can edit `code` in-domain but **cannot** write `spec` files and **cannot** submit a verdict.
- A `tester` can edit test files (via its domain include globs) and run tests; the classifier/type-policy do not let it write `spec`.
- A `reviewer` is read-only, may run inspection/test commands, and submits verdicts only via `submit_review_verdict`.
- A `lead` (incl. the orchestrator) **cannot mutate files**; it may `commit` only if it has a `commit:` field.
- Commits are blocked at the tool layer unless the agent has a `commit:` field; local `git merge`/`rebase` remain allowed; commit messages carry no AI attribution trailers.
- Verdicts/approvals/comments persist in SQLite typed tables and render in the dashboard; comments/approvals can be created from the UI (same-origin-guarded).
- `/hive-execute <change-id>` starts execution from an approved `tasks.md`.
- Config validation **hard-fails** if any agent lacks `agent-type`; `hive-doctor` reports offenders with suggestions.

---

## 14. Explicitly OUT of scope for v1 (do not build)
- Live workflow-phase state machine / phase-gated enforcement (RED as a hard gate).
- `.jsonl` event files for comments/approvals/verdicts.
- Integration phase (CHANGELOG/version-bump/cleanup workflow).
- `intake` phase; multi-type agents (`agent-types: []`).
- User-configurable `settings.file-classes`.
- Global test-vs-production classification (handled by per-agent domain globs).
- Dashboard "Execute" button / any dashboard→live-session command channel.
- Core-side reading of SQLite / mechanical "commit-only-when-green" enforcement.
- Soft/staged migration (warn-then-fail).

---

## 15. Cross-cutting rules (from CLAUDE.md — must hold)
- Do nothing unless `.pi/hive/hive-config.yaml` exists; don't start long-lived processes from the extension factory.
- Keep `bun:sqlite`/Bun code in dashboard/server paths only.
- Tool output must be bounded/truncated.
- Dashboard stays local-only (`127.0.0.1:43191`); no third-party telemetry.
- No AI attribution trailers anywhere (commits, docs, package text).
- Commit `ui/web/dist/` after dashboard changes; run `just ci` before tagging/publishing.
