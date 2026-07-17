# W08 — Rewrite Shell, Git, and Network Enforcement

Status: **Not started**  
Depends on: W07  
Blocks: W09

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Replace type-based command policy with closed schema-v1 shell classes, high-trust Git capability, best-effort external-network controls, and protected network zones. Every command must satisfy all applicable classes and filesystem effects; unknown/ambiguous mutations fail closed.

## Design authority

- Design Sections 9.3, 9.7, 9.8, 14.10, 25.1–25.2
- Accepted static limits in `AGENTS.md`: opaque interpreters/scripts and bare-filename Bash reads cannot be completely policed

## Current touchpoints to inspect

- `src/engine/policy.ts`, `src/engine/governance.ts`, `src/engine/process.ts`
- `src/engine/file-class.ts`, `src/engine/domain.ts`, `src/integration/hooks.ts`
- existing bash/Git/network classifiers and tests in `tests/policy.test.ts`, `tests/governance.test.ts`, `tests/process.test.ts`

## Closed shell classes

- `inspect`
- `test`
- `build`
- `package`
- `mutate`
- `execute-code`

A command must pass every applicable class. Examples:

- project test runner: `test` + `execute-code`;
- compiler/build script: `build` + `execute-code`;
- package install with hooks/network: `package` + often `execute-code` + filesystem authority + `external-network`;
- known `rm`/`mv`/`find -delete`: `mutate` + matching filesystem operations;
- remote Git: `git: true` + filesystem effects + `external-network`;
- unknown mutating/pathless command: deny.

## Implementation plan

1. Freeze command membership/classifier rules and conformance vectors in `IMPLEMENTATION_DECISIONS.md` before replacing enforcement.
2. Implement structured command analysis for known shell syntax and executable/argument extraction with bounded complexity.
3. Classify intent and all potential effects; require intersection of classes rather than first-match permission.
4. Require `execute-code` for interpreters, scripts, tests/builds, package hooks, Git hooks/aliases, and opaque project code.
5. Pass recognized filesystem effects through W07 scopes. Pathless known mutation fails closed.
6. Treat `git: true` as high trust but still classify local filesystem effects. Handle worktree/index/ref operations, hooks, aliases, submodules, and remote transports conservatively.
7. Gate curl/wget/ssh/scp/gh/remote Git/package registry and trusted network tools on `external-network`.
8. Deny loopback dashboard/control endpoints, private ranges, link-local/cloud metadata, Unix sockets, and authenticated harness channels regardless of external-network. Dedicated authenticated harness APIs are separate.
9. Add operation metadata for W13 retry/change accounting: mutability, idempotency, expected path scopes, network use, and process-tree ownership.
10. Keep denial messages bounded and explicit about static-enforcement limits.

## Required tests

- Table-driven coverage for every command class and every multi-class combination.
- Opaque interpreter/script/package-hook commands require `execute-code`.
- All known Git mutation/remote/hook/alias/submodule forms are classified conservatively.
- Remote operations fail without external-network; public network succeeds only when granted.
- Dashboard loopback, localhost variants, private IPs, DNS rebinding inputs where inspectable, and metadata endpoints remain denied.
- Pathless mutations fail closed; W07 scope checks run for extracted effects.
- Bare-filename read limitation and interpreter-hidden writes are explicit accepted-risk regression tests/documentation, not false passing claims.
- Cancellation terminates owned process trees without unsafe unrelated PID kills.

## Out of scope

- OS firewall/container sandbox.
- Runtime retries and unknown-side-effect reconciliation (W13).
- General DLP/secret scanning of network payloads.
- Removing old type-policy code before W27.

## Verification

- Targeted policy/governance/process tests
- `just typecheck-core`
- `just test`
- `just verify`

## Completion checklist

- [ ] No new command enforcement references semantic agent types.
- [ ] Every applicable class and filesystem/network requirement is checked.
- [ ] Git/network protected zones fail closed.
- [ ] Known unpoliceable interpreter/bare-read limits are documented honestly.
- [ ] Command metadata is available for W13 recovery/accounting.

## Handoff

Record classifier tables/version, process ownership/termination API, protected network-zone implementation, command attempt metadata, and all accepted-risk test cases W13/W14 must surface in operating contracts.
