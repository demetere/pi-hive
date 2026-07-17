# W14 — Implement Deterministic Prompts and Generic Tools

Status: **Not started**  
Depends on: W13  
Blocks: W15

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Assemble root/worker prompts in the normative order, label untrusted context, enforce static prompt/context limits, and register only generic topology/capability-derived tools with bounded schemas/results. Remove semantic behavior from the new prompt/tool path without cutting over legacy runtime yet.

## Design authority

- Design Sections 9.4–9.5, 10.4, 14.3–14.4, 14.9, 19.2, 20, and Risk 25.13/25.16

## Current touchpoints to inspect

- `src/agents/prompts.ts`, `src/agents/role-templates.ts`, `src/agents/tools.ts`
- `src/engine/prompts.ts`, `src/engine/dispatch.ts`, `src/integration/hooks.ts`
- worker resource loading and current tool registration
- tools/worker/prompt/policy/activation tests

## Normative prompt order

Root: identity; shared instructions; root instructions; node role metadata; adapter bounded state; skills/knowledge index; run input/handoff/verified refs; final immutable harness contract.

Worker: identity; shared instructions; node role metadata; permitted adapter state; skills/knowledge index; exact task/refs; final immutable harness contract.

Final contract includes effective capabilities/tools/budgets, direct members, reserved paths/trust boundaries, workspace identity, task/result or finish requirements, and accepted static enforcement limits.

## Trust and size rules

- Harness policy/mechanical checks outrank workflow, identity/skills, objectives, and retrieved data.
- Handoff, repository, artifact, knowledge, tool output, and external text are untrusted data even when instruction-like.
- Static identity/workflow/contract content is never silently truncated; activation fails if model context plus reserve cannot fit.
- Dynamic sections are individually bounded and expose truncation/pagination.
- Compaction preserves immutable run/task markers and refs; it cannot rewrite snapshot authority.

## Generic tools in this task

- `route_agent`
- `delegate_agent`
- `team_status`
- `workflow_status`
- `workflow_finish`

Reserve trusted descriptors/names for `artifact_status`, `artifact_action`, `knowledge_search`, `knowledge_read`, `knowledge_propose`, and `human_question`, but do not expose them until their subsystem/capability is active.

## Implementation plan

1. Build pure prompt-section functions and one deterministic assembler for root/worker.
2. Delimit every untrusted dynamic section with source/provenance/hash/truncation metadata; never interpolate it into authority prose.
3. Generate final operating contract from immutable effective policy and runtime IDs, not workflow prose.
4. Enforce prompt byte/token estimates and context reserve at W05 activation/model change.
5. Implement exact TypeBox schemas for generic tools; reject unknown fields and bound all strings/arrays/refs.
6. Bind tool handlers to caller node/run/task from trusted async-local/runtime context, never caller-supplied identity.
7. Re-check policy on every call and through hooks; active tool list is convenience, not security.
8. Ensure `workflow_finish` sole-call/root-only behavior and harness-derived fields.
9. Implement pagination/ref readback for status rather than silently truncating authority-relevant state.
10. Remove planner/coder/reviewer wording and OpenSpec actions from the new path; W27 deletes old templates/tools.

## Required tests

- Golden root/worker prompt order and distinct instruction scope.
- Worker never receives root transcript/root-only instructions implicitly.
- Untrusted instruction-like content cannot alter mechanical tool/capability checks.
- Static oversize fails; dynamic oversize truncates with explicit metadata/ref.
- Tool schema unknown/oversize fields fail.
- Caller identity spoofing/direct-member/finish authority fail.
- Re-enabled foreign or absent subsystem tools remain blocked.
- Compaction/resume retains markers/refs and contract hash.

## Out of scope

- Handoff packet implementation (W15).
- Adapter/knowledge/question tools (W16–W23).
- Final removal of old tools/templates (W27).

## Verification

- Targeted prompt/tool/policy/compaction tests
- `just typecheck-core`
- `just test`
- `just test-node-compat`
- `just verify`

## Completion checklist

- [ ] Root/worker prompt composition is deterministic and scope-correct.
- [ ] Untrusted data is clearly bounded/labeled and never authority.
- [ ] Generic tool identity comes from trusted runtime context.
- [ ] Every tool is schema/policy/output bounded.
- [ ] New path contains no semantic type/OpenSpec-specific procedure.

## Handoff

Record prompt section APIs/limits, operating-contract hash/provenance, tool schemas/result pagination, async caller-context contract, and extension points W15–W23 must use.
