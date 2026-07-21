# Security model

This document defines pi-hive's security and compatibility invariants. They are release requirements, not claims that every item is already enforced while the audit remediation backlog remains open. Known implementation gaps remain tracked in the project's local remediation notes until they are resolved.

## Trust boundaries

- The project must explicitly opt in with `.pi/hive/hive-config.yaml`. In a project without that file, pi-hive registers no commands, tools, hooks, servers, watchers, or UI.
- Agent output and tool input are untrusted. An agent's role name, a JSON field claiming a human actor, project files, telemetry, and legacy approval sidecars do not establish authority.
- The dashboard binds to loopback by default. Network origin, loopback source address, `Host`, `Origin`, or `Referer` alone do not authenticate a caller.
- A process running as the same operating-system user is **not** a trusted application caller: every dashboard mutation must still pass authentication and authorization. However, isolation from a malicious process with the same UID is outside pi-hive's threat model because that process can read the user's files and credentials, alter project files, or instrument the Pi process. Users must treat their OS account as the host security boundary.
- Third-party telemetry is forbidden. Project telemetry stays under `.pi/hive/sessions/`; the global registry, database, daemon metadata, and approval authority stay under `~/.pi/agent/hive/` (or the configured Pi agent directory).

## Approval integrity

The following invariants apply to each project, OpenSpec change, and artifact:

1. **Only an attributable human interaction may create human approval.** The interaction must occur through a trusted Pi UI prompt or an authenticated dashboard review session bound to that human action. Agents, project files, telemetry events, HTTP headers, and direct file-tool or shell writes cannot create human approval.
2. Automated review and human approval are separate records and separate authorities. Automated review can make an artifact eligible for human review but cannot substitute for human approval.
3. Approval is valid only for the exact bytes represented by the record's cryptographic artifact hash. A record also binds the canonical project identity, canonical project root, change ID, artifact ID, verdict, actor, schema version, and timestamp.
4. Human approval requires a current eligible automated-review hash for the same artifact.
5. Execution requires current human approvals for `tasks` and every upstream artifact (`proposal`, `design`, and the stable sorted aggregate of `specs/**/*.md`).
6. Any content change invalidates approval of that artifact and every downstream artifact. Renaming, adding, or removing a spec changes the aggregate specs hash.
7. Approval persistence is atomic and fail-closed. Missing, malformed, stale, legacy, partially written, or unwritable records never open a gate or report success.
8. `.pi-hive-approval.json` and other project-controlled sidecars are untrusted legacy input. Migration requires explicit human reapproval.

Minimum regression assertions: an agent cannot forge approval with `write`, `edit`, or bash; an approved-byte change closes execution; an upstream change closes downstream gates; concurrent writers do not lose records; enumeration order does not alter the specs hash; and legacy records never open execution.

## Reviewer and lead read-only semantics

`reviewer` and `lead` are read-only agent types. Their permitted shell surface is an explicit inspection-command allowlist, not an assumption that unknown commands are reads.

Permitted operations may include file inspection and non-mutating Git inspection such as `git status`, `git diff`, `git log`, `git show`, `git blame`, `git rev-parse`, and `git ls-files`, provided all referenced paths pass read-domain and reserved-path policy.

They must be denied:

- file creation, modification, deletion, permission changes, patch application, archive extraction, and package installation;
- Git index, worktree, ref, history, stash, or remote mutations, including `add`, `commit`, `push`, `tag`, `merge`, `rebase`, `cherry-pick`, `revert`, `reset`, `checkout`, `switch`, `stash`, `apply`, `am`, `clean`, and `restore`;
- ambiguous, unknown, pathless, interpreter-wrapped, aliased, or script-dispatch commands that cannot be proven read-only; and
- project test, build, format, lint, package-manager, and task-runner commands.

Tests and builds are considered potentially mutating because arbitrary project scripts can write files or run networked processes. A reviewer or lead may run them only in a disposable checkout explicitly provisioned and isolated by trusted orchestration; pi-hive does not currently provide that environment, so they are denied in normal worker sessions. `tester` or another write-capable worker must run project tests.

These restrictions are policy controls for cooperative agents, not a sandbox. See Accepted risks.

## Path and symlink semantics

All authorization is based on canonical containment, never string-prefix matching.

- The configured project root and existing candidate paths are resolved with `realpath` before authorization.
- A path must satisfy both lexical containment and canonical containment in the applicable allowed root. Absolute paths and `..` segments do not bypass policy.
- Reading through a symlink is allowed only when the symlink's canonical target remains inside an allowed read domain and is not reserved.
- Updating an existing symlink target is allowed only when both its lexical path and canonical target remain inside an allowed write domain and are not reserved.
- For a nonexistent target, pi-hive resolves the nearest existing parent with `realpath`; creation is denied if that parent escapes the allowed write domain or a symlinked ancestor escapes it.
- Deleting a symlink must never follow it and delete its target. An escaping symlink is fail-closed for agents and must be removed by a trusted human or trusted maintenance path.
- Broken symlinks, resolution errors, platform/path-flavor mismatches, and indeterminate containment are denied.
- Reserved paths are checked before ordinary domain grants; a broad domain cannot override them without an explicit trusted override.

Regression coverage must include traversal, sibling-prefix collisions, absolute paths, symlink escapes, broken links, nonexistent targets, and Windows-form path inputs.

## Dashboard authentication

Dashboard read and mutation APIs are local-only by default, but locality is not authorization. Production operation requires a non-empty random bearer credential. Sensitive review mutations additionally require a short-lived, single-purpose review nonce bound to project, change, artifact, and current artifact hash. Mutation requests fail closed on missing or invalid authentication and origin metadata.

Dashboard documents and APIs send a restrictive Content Security Policy, same-origin framing policy, `nosniff`, Referrer-Policy, Cross-Origin-Opener-Policy, and explicit cache controls. The main dashboard can connect and frame only its own local origin. The vendored review UI runs in an iframe sandbox without `allow-same-origin`; a bootstrap attaches its content-bound capability only to local `/api/*` requests, which permits the opaque sandbox origin without weakening ordinary bearer-authenticated writes. Review CSP permits executable bundle/bootstrap scripts only with a per-response nonce and blocks nested frames, forms, objects, external connections, and inline event-handler attributes. Artifact Markdown is untrusted data: text is escaped, executable link schemes are discarded, and hostile embedded HTML receives no network or script authority.

Credentials, review sessions, approval records, daemon metadata, `.git/**`, `.env*`, private keys, configured secrets, and telemetry/session state are reserved from agents unless a narrowly scoped trusted operation explicitly permits access.

## Platform support

The current supported runtime platform is **Linux** with a supported Node.js and Bun version. Native Windows and macOS are currently untested and unsupported. POSIX shell/process assumptions must not be presented as portable behavior.

Windows-style path inputs must still be tested and rejected fail-closed on supported POSIX hosts. Adding native Windows or macOS support requires platform CI plus equivalent canonical-path, locking, atomic-write, process-lifecycle, permissions, and dashboard security guarantees.

## Accepted risks

The following are deliberate limits of policy enforcement and are not approval or sandbox guarantees:

1. **General-purpose interpreters are statically unpoliceable.** Writes hidden inside `node -e`, `python -c`, shell scripts, package scripts, and similar interpreter invocations cannot be inferred reliably from command text. Such commands are denied to read-only agent types, but write-capable workers remain a trust boundary.
2. **Bare bash read paths may evade static domain extraction.** A bare filename such as `cat secrets.env` may not be distinguishable from an ordinary argument. Mutations remain fail-closed by command classification. Reserved secret paths and tool-level read controls reduce, but do not eliminate, this limitation.
3. **Same-UID compromise is out of scope.** Authentication protects against accidental, browser-origin, cross-project, and unauthenticated API use; it cannot protect credentials or files from a malicious process already running as the same OS user.
4. **Agent controls are not OS sandboxing.** Domain and command policy constrain registered Pi tools. They do not contain a hostile runtime, dependency, Pi extension, kernel exploit, or trusted human shell.
5. **Telemetry is local but sensitive.** Prompts, outputs, paths, and usage metadata can contain confidential information. Pi-hive applies restrictive permissions, bounded retention/rotation, opt-in reasoning capture, and best-effort credential redaction, but pattern-based redaction cannot recognize every secret. Users must still protect the host account, source logs, exports, and backups.

## Temporary audit exception

Root CI allows only `GHSA-3jxr-9vmj-r5cp` / npm `1123898` for `brace-expansion@5.0.6` under Pi `0.80.7`, expiring **2026-08-20**. Drift and every other high/critical finding fail. Restore `npm audit --audit-level=high` after upstream fixes the tree.

## Audit baseline

Recorded on **2026-07-14** at Git commit `2f6b42a`, using Node `v22.23.1` and Bun `1.3.14`:

| Measure | Baseline |
| --- | ---: |
| Node tests | 147 passed, 0 failed |
| Node line coverage | 80.16% |
| Node branch coverage | 72.23% |
| Node function coverage | 79.28% |
| Bun tests | 38 passed, 0 failed |
| Bun line coverage | 46.33% |
| Bun function coverage | 39.11% |
| npm packed size | 7,585,010 bytes |
| npm unpacked size | 23,760,765 bytes |
| npm package file count | 115 |
| Dashboard `dist/` size | 375,832 bytes across 8 files |
| Dashboard `dist/` summed gzip size | 134,212 bytes |
| Main dashboard JS | 265,523 bytes (84,902 gzip) |
| Topology JS chunk | 15,220 bytes (6,138 gzip) |
| Dashboard CSS | 63,652 bytes (11,792 gzip) |

Coverage was measured with Node's `--experimental-test-coverage` over `tests/*.test.ts` and `bun test --coverage ./tests/*.spec.ts`. Package measurements used `npm pack --dry-run --json --ignore-scripts`; dashboard gzip values are the sum of each committed file compressed independently. These numbers are regression baselines, not quality gates or security claims.

## Supported versions

pi-hive is pre-1.0. Only the latest `main` branch and most recent release receive security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security reports.** Do not include credentials, private telemetry, approval records, or sensitive project content in any report.

- Preferred: open a private [GitHub security advisory](https://github.com/demetere/pi-hive/security/advisories/new).
- Alternatively, email **demetredzmanashvili@gmail.com** with a description, affected version or commit, and a minimal reproduction.

Please allow a reasonable window for a fix before public disclosure. There is no bug-bounty program; acknowledgement in release notes is offered for valid reports on request.

A bypass that lets a worker mutate files outside its granted write domain through a classified mutation command, escalate its tool scope, forge human approval, cross project boundaries, or access dashboard data without required authentication is in scope and should be reported.
