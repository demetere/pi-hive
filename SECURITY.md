# Security policy

## Supported release

Security fixes target the current 1.x workflow architecture on Linux and macOS. Windows is unsupported; in particular, pi-hive does not claim Windows process-tree termination support. Darwin uses the packaged architecture-specific N-API helper for descriptor-relative filesystem operations rather than weakening Linux path-identity guarantees.

## Report a vulnerability

Use GitHub private vulnerability reporting for this repository. Include the affected version, configuration shape, reproduction steps, impact, and whether the issue crosses a capability, project-containment, journal, dashboard authentication, or package-install boundary. Do not include real credentials or private telemetry.

## Security model

pi-hive activates only for the nearest project containing `.pi/hive/hive-config.yaml`. Without it the extension registers nothing and creates no files or processes. Invalid or pre-1.0 configuration fails before runtime registration and requires manual migration.

Schema-v1 capabilities default deny. Workflow overlays may only narrow catalog ceilings. Filesystem targets are canonicalized inside the project, symlink escape is rejected, protected runtime/artifact/knowledge paths have dedicated mutation paths, and unknown tools or command classes fail closed. Mutating custom tools use Pi's file mutation queue.

Workflow journals under `.pi/hive/sessions/` are authoritative. The global workflow SQLite database is a rebuildable, separately versioned projection. Historical telemetry archives are preserved but never dual-read into that projection.

The dashboard binds to loopback by default, requires a high-entropy bearer credential, checks Host and same-origin requests, requires CSRF proof for browser writes, uses replay-safe operation IDs and exact compare-and-swap object identity, bounds bodies and pages, and has authenticated teardown plus bounded idle timeout. It never executes models and sends no third-party telemetry. Use `/hive:observe`, `/hive:observe-stop`, and `/hive:observe-prune <ISO-timestamp>` for explicit operation.

Human questions, approvals, knowledge proposals, handoffs, leases, and run termination bind exact project/session/run/object identities. Conversational text cannot forge approval. Handoffs are immutable, same-project, bounded, one-shot, authority-free, and exclude transcripts.

## Accepted limits

pi-hive is policy enforcement, not an OS sandbox or hostile-code containment system.

- General interpreters, scripts, tests, builds, package hooks, compilers, and Git hooks/aliases can hide filesystem or network effects from static command classification.
- External-network denial blocks known operations but cannot prove that allowed code never opens a connection.
- Bare filename reads in shell commands may evade path extraction; mutating command classes still fail closed.
- Arbitrary shell and external API effects are not exactly once. Unknown outcomes pause for reconciliation rather than automatic retry or rollback.
- Prompt content from users, repositories, artifacts, knowledge, handoffs, and tools may be adversarial. Mechanical policy—not prompt wording—is the authority boundary.
- Structured delegation references are re-authorized, but task prose is not a general information-flow or DLP boundary.
- Local users with access to the same account and files are outside the dashboard's remote attacker boundary.

Do not grant `execute-code`, Git, broad writes, external network, or secret-readable paths to untrusted work. Keep provider credentials in Pi/provider stores, never workflow YAML.

## Operational guidance

- Review capability ceilings and every workflow override.
- Prefer split workflows for materially different authority or approval boundaries.
- Keep `.pi/hive/sessions/` and `~/.pi/agent/hive/` private and out of version control.
- Treat projection pruning as cache maintenance; journal pruning is a separate explicit irreversible operation.
- Run `/hive:doctor [--json]` after configuration changes.
- Keep Node, Bun (when used), Pi, and package dependencies current.
- Run `just verify-licenses`, `just pack-dry-run`, and `just verify-packed-install` before release.
