# Security Policy

`pi-hive` orchestrates autonomous agents that run real commands and edit files. It
enforces a trust boundary — a bash mutation policy, scoped tools, and per-agent
filesystem domains — so a worker cannot act outside the scope its team lead granted
it. Reports of ways to bypass that boundary are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

- Preferred: open a private [GitHub security advisory](https://github.com/demetere/pi-hive/security/advisories/new).
- Alternatively, email **demetre@pleiful.ai** with a description, affected version/commit, and a minimal reproduction.

Please allow a reasonable window for a fix before any public disclosure. There is no
bug-bounty program; acknowledgement in the release notes is offered for valid reports
if you would like it.

## Supported versions

`pi-hive` is pre-1.0. Only the latest `main` / most recent release receives security
fixes.

## Scope and known accepted risks (out of scope)

The following are **documented, intentional limits** of the enforcement model, not
bugs. They are explained in `AGENTS.md` ("Policy enforcement limits") and stated in
the worker operating-contract prompt so agents treat them as a trust boundary rather
than a loophole. Reports of these specific limits will be closed as known:

- **Interpreter escapes are statically unpoliceable.** The bash policy classifies
  mutations by matching known command verbs (`rm`, `mv`, `git restore`, `dd of=`,
  `rsync`, …). File changes made *through* a general-purpose interpreter — `node -e`,
  `python -c`, `sh script.sh`, `npm run <script>` — are invisible to the classifier by
  design. Do not rely on the bash classifier to contain a hostile interpreter
  invocation.
- **Bash read checks fail open on bare filenames.** Read-domain checks only recognize
  path-like tokens containing a `/` (or an absolute path), so `cat secrets.env` /
  `less .env` (no slash) skip the read-domain check. **Mutations still fail closed** —
  classification keys off the command verb, not the path.

A bypass that lets a worker mutate files **outside its granted write domain** through a
*classified* mutation command, escalate its tool scope, or reach another project's
telemetry, **is in scope** — please report it.

The telemetry dashboard binds to `127.0.0.1` by default and gates writes behind a
per-daemon token. A way to reach the dashboard or its data cross-origin, or without the
token, is in scope.
