# W22 — Implement OKF Catalogs, Attachments, and Local Retrieval

Status: **Not started**  
Depends on: W21  
Blocks: W23

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Replace custom mental-model read paths with a provider-bounded OKF implementation for agent-owned and shared project knowledge, strict attachment authorization, deterministic local lexical retrieval, progressive disclosure, and content-hash provenance.

## Design authority

- Design Sections 4.9, 9.3, 16.1–16.5, 20, Risks 25.5–25.6/25.13
- OKF v0.1 is draft; format assumptions must remain behind provider interface

## Required external reference

Before implementation, fetch/read the current OKF specification linked in the design. Record the exact commit/version used in `IMPLEMENTATION_DECISIONS.md`; do not spread draft-only fields through runtime types.

## Current touchpoints to inspect

- `src/core/mental-model.ts`, `src/core/prompting.ts`
- knowledge/mental model logic in `src/engine/prompts.ts`, `src/engine/dispatch.ts`, worker resource loading
- current config shared-context/knowledge refs and tests
- W03 catalog metadata, W07 protected paths, W14 prompt/tool extension

## Memory/authorization contract

- Run transcript is episodic and workflow-session local.
- Agent-owned OKF persists specialist knowledge across workflows for that catalog agent.
- Shared OKF persists project architecture/decisions/conventions/risks.
- Search/read only attached bundles: agent defaults, workflow-added bundles, and agent's own bundle.
- Generic file tools cannot bypass protected knowledge roots.
- Structured knowledge refs are re-authorized for recipient.
- Knowledge content is untrusted data, not policy authority.

## Target modules

- `src/knowledge/types.ts`
- `src/knowledge/provider.ts`
- `src/knowledge/okf.ts`
- `src/knowledge/attachments.ts`
- `src/knowledge/index.ts`
- `src/knowledge/search.ts`

## Implementation plan

1. Define provider-neutral bundle/document/link/index/search result interfaces.
2. Implement only the minimal stable OKF conventions needed; validate IDs/frontmatter/links/path containment/size and report bounded diagnostics.
3. Build deterministic Node-compatible lexical index with bounded files/bytes/tokens/results and no mandatory embeddings/external service.
4. Use progressive disclosure: bounded bundle/index summaries in prompt, `knowledge_search`, then exact bounded `knowledge_read`.
5. Every search/read records bundle/document content hash and provenance refs in run journal.
6. Enforce attachments and `knowledge.read` at every call; no global catalog search.
7. Protect knowledge paths from generic filesystem/artifact mutation.
8. Integrate prompt sections as untrusted bounded context and generic tools through W14 descriptors.
9. Handle concurrent content changes by index invalidation/rebuild without serving mismatched hash/content.
10. Keep Bun dashboard code out of provider/index path.

## Required tests

- Minimal valid/invalid OKF bundles, frontmatter, links, traversal/symlink/size/cycle cases.
- Agent/shared ownership and attachment add/remove authorization.
- Unattached and recipient-unauthorized refs fail without content leakage.
- Deterministic ranking/tie/pagination/bounds and index invalidation.
- Search/read content hash provenance matches exact returned bytes.
- Prompt labels knowledge as untrusted and bounds summaries.
- No external network/embedding requirement and Node compatibility.

## Out of scope

- Automatic/reviewed updates/enrichment (W23).
- Dashboard knowledge views (W26).
- Supporting other providers or exposing third-party provider API.
- Migrating old mental-model files automatically.

## Verification

- Knowledge/OKF/attachment/search tests
- `just typecheck-core`
- `just test`
- `just test-node-compat`
- `just verify`

## Completion checklist

- [ ] OKF assumptions are isolated behind provider interface.
- [ ] Retrieval is attached-only, bounded, deterministic, and local.
- [ ] Every result has exact content-hash provenance.
- [ ] Knowledge cannot grant authority or bypass protected paths.
- [ ] No Bun/external service is required in core.

## Handoff

Record OKF spec version, provider interfaces, accepted subset, lexical index algorithm/limits, attachment authorization API, result refs/hashes, and W23 mutation proposal hooks.
