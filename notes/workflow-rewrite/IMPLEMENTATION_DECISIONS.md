# Workflow Rewrite Implementation Decisions

This ledger records implementation specifications that remain intentionally unresolved after the architecture was accepted. Each owner must resolve its row with tests before the first release. A resolution may narrow implementation details, but it must not introduce authority, fixed workflow semantics, or compatibility behavior absent from the design.

## Section 26 decisions

| Status | Design item | Owner(s) | Decision | Rationale/evidence | Conformance tests | Contract/schema version | Resolved date |
|---|---|---|---|---|---|---|---|
| Unresolved | [§26 item 1](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md#26-deferred-design-questions): command classes and `execute-code` | W08 | — | — | — | — | — |
| Unresolved | [§26 item 2](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md#26-deferred-design-questions): glob grammar and normalization | W07 | — | — | — | — | — |
| Unresolved | [§26 item 3](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md#26-deferred-design-questions): adapter action schemas, bounds, and operation IDs | W16/W17 common interface; W19 OpenSpec; W20 Markdown plan (`none` has no actions in W16) | — | — | — | — | — |
| Unresolved | [§26 item 4](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md#26-deferred-design-questions): Markdown workspace, options, completion, sidecars, and digests | W20 | — | — | — | — | — |
| Unresolved | [§26 item 5](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md#26-deferred-design-questions): OpenSpec lifecycle, implementation completion, and digests | W19; W18 supplies generic digest integration | — | — | — | — | — |
| Unresolved | [§26 item 6](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md#26-deferred-design-questions): physical journal/checkpoint/snapshot/handoff formats, compaction, and pruning UX | W09 journal/checkpoint/compaction; W05 snapshot; W15 handoff; W24–W26 pruning control/UX | — | — | — | — | — |
| Unresolved | [§26 item 7](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md#26-deferred-design-questions): session/workspace leases and timing | W09 workflow-session lease; W17 workspace lease/timing | — | — | — | — | — |
| Unresolved | [§26 item 8](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md#26-deferred-design-questions): safety caps, warnings, finalization reserve, and usage reconciliation | W13 | — | — | — | — | — |
| Unresolved | [§26 item 9](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md#26-deferred-design-questions): curator model and budgets | W23 | — | — | — | — | — |
| Unresolved | [§26 item 10](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md#26-deferred-design-questions): Node-compatible OKF lexical index | W22 | — | — | — | — | — |
| Unresolved | [§26 item 11](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md#26-deferred-design-questions): workflow session naming and archive/orphan presentation | W10 native session contract; W26 user presentation | — | — | — | — | — |
| Unresolved | [§26 item 12](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md#26-deferred-design-questions): dashboard IA and routes | W25 API/security; W26 UI/IA | — | — | — | — | — |
| Unresolved | [§26 item 13](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md#26-deferred-design-questions): programmatic I/O schemas | Post-v1 deferred; W27 documents the non-goal only | — | Explicitly deferred by the accepted first-release interactive contract. | W27 documentation consistency | Post-v1 | — |
| Unresolved | [§26 item 14](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md#26-deferred-design-questions): automatic meta-orchestrator protocol | Post-v1 deferred; W27 documents the non-goal only | — | Automatic routing/composition is outside the first release. | W27 documentation consistency | Post-v1 | — |
| Unresolved | [§26 item 15](../../docs/WORKFLOW_ARCHITECTURE_DESIGN.md#26-deferred-design-questions): trusted third-party adapter API | Post-v1 deferred; W27 documents the non-goal only | — | The first release has built-in adapters only. | W27 documentation consistency | Post-v1 | — |

## Supporting first-release decisions

These obligations are explicit in the ordered task files even where Section 26 groups them under a broader item.

| Status | Obligation | Owner(s) | Decision | Rationale/evidence | Conformance tests | Contract/schema version | Resolved date |
|---|---|---|---|---|---|---|---|
| Unresolved | Parser, aggregate, diagnostic, and generated-schema limits | W01 | — | — | — | Schema v1 | — |
| Unresolved | Path depth/length, resource bytes/counts, canonicalization limits | W02 | — | — | — | Schema v1 | — |
| Unresolved | Catalog, prompt/hash, attachment, and skill limits | W03 | — | — | — | Schema v1 | — |
| Unresolved | Workflow traversal limits and overlay-removal semantics | W04 | — | — | — | Schema v1 | — |
| Unresolved | Snapshot serialization and reserved context budget | W05 | — | — | — | Snapshot v1 | — |
| Unresolved | Capability subset rules and provenance representation | W06 | — | — | — | Capability contract v1 | — |
| Unresolved | Journal write/compaction timing and cancellation grace/kill timing | W09 journal timing; W11 cancellation timing | — | — | — | Runtime contract v1 | — |
| Unresolved | Scheduler fairness details | W12 | — | — | — | Scheduler contract v1 | — |
| Unresolved | Prompt composition and tool/result bounds | W14 | — | — | — | Prompt/tool contract v1 | — |
| Unresolved | Telemetry envelope, redaction, and retention limits | W24 | — | — | — | Telemetry schema v1 | — |
| Unresolved | Daemon idle timeout and authenticated control DTOs | W25 | — | — | — | Daemon/API v1 | — |
| Unresolved | Dashboard pagination and virtualization thresholds | W26 | — | — | — | Dashboard API/UI v1 | — |

## Update rule

The owning task replaces `Unresolved` only after recording the exact decision, evidence, conformance-test paths, version impact, and resolution date. Later discoveries extend this ledger rather than silently choosing a constant in unrelated work.
