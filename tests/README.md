# Test suite

Tests are grouped by product domain rather than test runner. Node tests use
`*.test.ts`; Bun-only tests use `*.spec.ts` and stay beside the domain they
exercise.

| Directory | Scope |
| --- | --- |
| `capabilities/` | Filesystem, command, network, process, and tool capability enforcement |
| `config/` | Schema, YAML, catalogs, manifests, snapshots, and configuration budgets |
| `core/` | Shared primitives such as paths, locks, formatting, limits, and identity |
| `dashboard/` | Dashboard transport, static assets, browser security, and event handling |
| `integration/` | Extension activation, commands, modes, sessions, and worker integration |
| `observability/` | Telemetry storage, runtime materialization, server routes, plans, and SSE |
| `orchestration/` | Routing, governance, questions, process control, topology, and verdicts |
| `policy/` | Security, privacy, artifact contracts, review gates, and policy enforcement |
| `release/` | Packaging, documentation, release workflow, and coverage gates |
| `workflows/` | Workflow journals, ownership, linked sessions, selectors, and navigation |
| `fixtures/` | Checked-in test projects and configuration examples |
| `helpers/` | Shared test helpers and TypeScript loader support |

Use the repository recipes so recursive discovery and the correct runtime are
applied consistently:

```sh
just test
just test-db
just test-node-compat
just verify
```

When adding a test, place it in the narrowest matching domain. Add a new domain
only when the behavior does not fit an existing one; do not return test files to
the `tests/` root.
