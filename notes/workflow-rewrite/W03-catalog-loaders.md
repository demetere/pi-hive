# W03 — Implement Agent, Skill, and Knowledge Catalog Loaders

Status: **Not started**  
Depends on: W02  
Blocks: W04

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Load reusable agent identities, skill resources, and knowledge bundle metadata into strict catalog nodes with exact source hashes and dependency diagnostics. Catalog loading must remain separate from workflow topology and from capability resolution.

## Design authority

- Design Sections 4.4, 4.8–4.9, 5, 6.1–6.3, 8, 9.2–9.3, and 16.1–16.4
- Acceptance criteria for reusable agents, strict IDs, project-contained resources, default-deny capabilities, explicit attachments, and dependency quarantine

## Current touchpoints to inspect

- `src/core/config.ts` frontmatter enrichment
- `src/core/schema.ts`, `src/core/types.ts`, `src/core/config-validation.ts`
- `src/core/prompting.ts`, `src/core/mental-model.ts`
- worker resource/skill loading in `src/engine/dispatch.ts` and `src/engine/worker-extension.ts`
- current agent Markdown fixtures and config tests

## Required agent contract

- Agent ID comes from the manifest key.
- Required: `name`, explicit `capabilities` mapping (which may be empty), and non-empty Markdown prompt body.
- Optional: `description`, exact model ID or `inherit`, Pi-supported thinking level or `inherit`, tags, skills, knowledge, and allowed per-node budget ceilings.
- Unknown frontmatter fields fail.
- Lists reject duplicates; IDs must exist in their catalog.
- Capabilities are raw declared ceilings here; W06 computes effective narrowing.
- Agent/node budget fields are only `max-agent-turns`, `max-tool-calls`, `token-budget`, and `active-wall-time`.
- Prompt body is behavior/identity text, not authority.

## Required skill/knowledge catalog contract

- Skill IDs map to project-contained registered skill directories/files and are snapshotted later.
- Knowledge entries validate `provider: okf`, path, optional owner agent ID, and update policy `automatic | reviewed | read-only`.
- Agent-owned bundles default `automatic`; shared bundles default `reviewed` when omitted.
- Ownership is explicit and references a catalog agent.
- This task validates metadata and paths only; it does not implement OKF parsing/search/update.

## Target modules

- `src/config/agents.ts`
- `src/config/skills.ts`
- `src/config/knowledge.ts`
- shared catalog/resource hash helpers

## Implementation plan

1. Parse Markdown frontmatter using the strict W01 YAML document rules. Preserve frontmatter and body ranges.
2. Reject missing/duplicate frontmatter, empty prompt bodies, irregular files, oversized files, and symlink escapes.
3. Normalize line endings only for canonical hashing; preserve exact prompt text used by snapshots and report what normalization is applied.
4. Validate model/thinking syntactically now. Runtime availability/context fit is W05.
5. Load skill content deterministically with bounded recursion, extension allowlist, `.gitignore`/symlink rules decided in W00/W01, aggregate byte/file limits, and stable relative ordering.
6. Load knowledge catalog metadata without reading all OKF content. Capture canonical path and current catalog-root fingerprint sufficient for dependency diagnostics.
7. Build dependency edges from agents to skills/knowledge and from owned knowledge to owner agents.
8. A broken agent/skill/knowledge entry is a failed node. Do not fail unrelated entries globally.
9. Expose bounded catalog summaries for doctor/selector without prompt bodies or file contents.
10. Do not import legacy `AgentType`, role templates, planner stages, domain shorthand, `allowOutsideProject`, or mental-model YAML.

## Required tests

- Frontmatter/body parsing with exact ranges and content hashes.
- Missing capabilities or body, unknown keys, invalid model/thinking syntax, duplicate lists, invalid budgets, and oversized prompt fail precisely.
- Skills load in deterministic order and reject escape, unsupported file, cycle, count, depth, and aggregate-byte violations.
- Knowledge defaults/owners/update policies validate; unknown owners fail as dependency nodes.
- One broken catalog entry does not invalidate independent entries.
- Diagnostic summaries never expose prompt/knowledge content.
- Hashes are stable across supported line-ending differences if normalization is promised.

## Out of scope

- Workflow nodes/overlays (W04).
- Effective capabilities/tools (W06).
- Prompt assembly (W14).
- OKF content validation/retrieval (W22).
- Mental-model migration/removal (W23/W27).

## Verification

- Targeted catalog/frontmatter/resource tests
- `just typecheck-core`
- `just test`
- `just verify`

## Completion checklist

- [ ] Reusable agent identity is independent from workflow topology.
- [ ] Skill and knowledge resources are strict catalog IDs, not workflow paths.
- [ ] Prompt/skill content is deterministically bounded and hashable.
- [ ] Broken resources become dependency failures without global collapse.
- [ ] No semantic agent type or planner stage exists in new catalog types.

## Handoff

Document loaded catalog types, hash normalization, skill resource ordering/limits, knowledge ownership defaults, and dependency edges W04/W05 consume.
