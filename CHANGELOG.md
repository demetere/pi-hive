# Changelog

## 1.0.0

### Breaking

- Replaced the fixed pre-1.0 runtime with schema-v1 config-first workflows.
- Removed fixed mode switching, dual-team configuration, semantic agent enforcement, planner stages, fixed artifact commands, keyboard cycling, and plan-specific dashboard routes.
- Removed automatic loading of pre-1.0 configuration and durable YAML memory. Migration is manual; see README and SETUP.
- Started a separate workflow telemetry projection. Historical telemetry files remain untouched and are not displayed or migrated.

### Added

- Strict YAML registries, reusable agents, recursive workflow teams, immutable activation snapshots, and capability narrowing.
- Linked workflow sessions with multi-run chat semantics, explicit handoff, recovery, cancellation, budgets, and change accounting.
- Generic artifact adapters for `none`, Markdown plans, and OpenSpec with leases, checkpoints, and exact approvals.
- Durable questions, attached local OKF knowledge, bounded enrichment, workflow telemetry, authenticated API v1, and the workflow dashboard.
- Checked-in combined, split-handoff, Markdown lifecycle, artifact-free, and invalid migration examples.

### Security

- Preserved unconfigured inertness, Node-compatible core loading, loopback-only dashboard binding, authenticated exact-object controls, bounded output/pagination, and Pi mutation-queue participation.
- Documented that capability enforcement is not an OS sandbox, network denial is best effort, and delegation prose is not DLP.
