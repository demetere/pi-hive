# W06 — Implement Capability Narrowing and Tool Derivation

Status: **Not started**  
Depends on: W05  
Blocks: W07

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Replace semantic agent-type authority in the new architecture with a closed, default-deny capability resolver. Produce immutable effective node policies and derived tool descriptors that W07/W08 enforce and activation snapshots freeze.

## Design authority

- Design Sections 4.8, 9.1–9.5, 10.3, 14.9, and 20
- Closed capability schema and strict precedence/narrowing rules
- Acceptance criteria covering no semantic types, no capability defaults, no widening, foreign tools blocked, direct-member topology tools, and fail-closed unknown values

## Current touchpoints to inspect

- `src/core/types.ts`, `src/core/schema.ts`, `src/core/agent-type-audit.ts`
- `src/engine/policy.ts`, `src/engine/governance.ts`, `src/engine/domain.ts`, `src/engine/routing.ts`
- `src/agents/tools.ts`, `src/engine/prompts.ts`
- policy/governance/config/schema tests

## Effective-resolution contract

- Non-authority scalar precedence: project defaults < catalog agent < workflow node < persisted root-session model/thinking choice (root only).
- Capabilities: catalog agent declaration is both default and hard ceiling; workflow node may only narrow.
- Project defaults never grant capabilities.
- Budget values use the strictest applicable package/project/workflow/agent/node ceiling.
- Skills/knowledge use explicit add/remove; there is no implicit list merge.
- Missing capability group grants nothing. Unknown group/value fails validation.
- Tool availability requires a known trusted mapping plus effective capability/topology/adapter prerequisites.
- Unclassified foreign tools remain inactive/blocked but do not invalidate unrelated workflows.
- Root receives workflow controls; nodes with members receive direct-member routing/delegation; leaf nodes do not.

## Target modules

- `src/capabilities/types.ts`
- `src/capabilities/resolve.ts`
- `src/capabilities/tools.ts`
- `src/capabilities/policy.ts` shared decision primitives

## Implementation plan

1. Define normalized internal capability representation with explicit booleans/sets/scoped filesystem grants. Preserve source provenance for every grant/narrowing decision.
2. Implement subset checking for every group:
   - booleans can change `true → false`, never `false/absent → true`;
   - operation sets can only remove members;
   - filesystem scopes must be demonstrably contained subsets, including operations/path/include/exclude semantics;
   - ambiguous narrowing fails instead of approximating broader authority.
3. Resolve budgets with explicit run-wide/per-node scope. Reject agent/node `max-parallel` and `max-delegations`.
4. Resolve model/thinking and attachment overlays deterministically; produce diagnostics for add/remove conflicts.
5. Define trusted tool-classifier registry. Each tool descriptor states capability requirements, topology requirements, mutability, idempotency, context-output bounds, and whether Pi file mutation queue is mandatory.
6. Derive node tool sets without registering them yet. Artifact/knowledge/question tools may remain unavailable until their subsystem contract exists, but descriptors must reserve generic names.
7. Define advisory route metadata input from direct members only; no semantic type/name bonuses.
8. Feed complete effective policy into W05 snapshot finalization and update snapshot hash tests.
9. Remove no legacy runtime tables yet; add tests against new modules and record W27 deletion ownership.
10. Update implementation decisions with exact subset/narrowing semantics.

## Required tests

- Property/table tests prove every overlay result is a subset of the agent ceiling.
- Attempts to add shell classes, filesystem operations/scopes, network, Git, human input, artifact, or knowledge capability fail.
- Exclusions always win; narrower path/filter grants cannot escape by glob tricks.
- Strictest budget and attachment resolution is deterministic.
- Repeated catalog agent at different node IDs yields independent effective node policies.
- Root/direct-member/leaf tool derivation matches topology.
- Unknown/foreign tools remain blocked; known mappings expose only when every prerequisite passes.
- Snapshot hashes include effective authority and change when it narrows.

## Out of scope

- Path/command enforcement implementation (W07/W08).
- Runtime tool registration and prompts (W14).
- Adapter/knowledge/question implementations.
- Deleting `AgentType` from the old runtime (W27).

## Verification

- Targeted capability/property/tool-derivation tests
- `just typecheck-core`
- `just test`
- `just verify`

## Completion checklist

- [ ] New authority has no semantic agent-type dependency.
- [ ] Every overlay is mechanically proven narrower.
- [ ] Tool derivation is topology/capability based and default-deny.
- [ ] Foreign tools cannot become active accidentally.
- [ ] Activation snapshots freeze the complete effective node policy.

## Handoff

Record normalized policy types, subset algorithm, provenance/diagnostic model, trusted tool descriptor schema, and exact W07/W08 enforcement entry points.
