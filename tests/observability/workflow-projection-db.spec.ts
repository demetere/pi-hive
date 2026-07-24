import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowEvent, sealWorkflowEvent, type WorkflowEventEnvelope } from "../../src/workflows/events";
import { appendWorkflowEvent } from "../../src/workflows/journal";
import { toWorkflowTelemetryEvent, workflowTelemetryStreamId, type WorkflowTelemetryEvent } from "../../src/observability/events";
import { WorkflowTelemetryProjection } from "../../src/observability/projection";

let module: typeof import("../../src/observability/server/workflow-db");
let runtimeModule: typeof import("../../src/observability/server/workflow-runtime");

beforeAll(async () => {
  module = await import("../../src/observability/server/workflow-db");
  runtimeModule = await import("../../src/observability/server/workflow-runtime");
});
afterAll(() => {});

function events(count: number, sessionId = "session-db"): WorkflowTelemetryEvent[] {
  const output: WorkflowEventEnvelope[] = [];
  for (let index = 0; index < count; index++) {
    const draft = createWorkflowEvent({
      eventId: `${sessionId}-event-${index}`,
      projectId: "project-db",
      sessionId,
      runId: "run-db",
      type: index === count - 1 ? "terminal.recorded" : index === 0 ? "run.started" : "budget.model.usage.recorded",
      producer: "harness",
      timestamp: new Date(Date.UTC(2026, 6, 20, 0, 0, index)).toISOString(),
      payload: index === count - 1
        ? { formatVersion: 1, status: "completed", changeCoverage: "recorded" }
        : index === 0
          ? { formatVersion: 1, status: "running", workflowId: "delivery", nodeId: "root" }
          : { formatVersion: 1, nodeId: "root", usage: { inputTokens: 1, outputTokens: 2, costMicroUsd: 3, precision: index % 2 ? "estimated" : "provider-confirmed" } },
    });
    output.push(sealWorkflowEvent(draft, index + 1, output.at(-1)?.eventHash ?? null));
  }
  return output.map((event) => toWorkflowTelemetryEvent(event, { workflowId: "delivery", projectRoot: "/project", projectLabel: "Project DB", workflowConfigVersion: "1" }));
}

test("workflow projection default path is separate from the legacy database", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-db-config-"));
  const child = Bun.spawnSync(["bun", "-e", `const c = await import('./src/observability/server/config.ts'); console.log(JSON.stringify({ legacy: c.DB_PATH, workflow: c.WORKFLOW_DB_PATH }))`], { cwd: process.cwd(), env: { ...process.env, PI_CODING_AGENT_DIR: root, HIVE_TELEMETRY_DB: join(root, "legacy.db") } });
  expect(child.exitCode).toBe(0);
  const paths = JSON.parse(child.stdout.toString());
  expect(paths.workflow).toBe(join(root, "hive", "workflow-telemetry-v1.db"));
  expect(paths.workflow).not.toBe(paths.legacy);
});

test("workflow SQLite projection uses a clean v1 schema and leaves legacy DB/JSONL byte-identical", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-db-"));
  const legacyDb = join(root, "telemetry.db");
  const legacyJsonl = join(root, "telemetry-sessions.jsonl");
  writeFileSync(legacyDb, "legacy-db-bytes");
  writeFileSync(legacyJsonl, "legacy-jsonl-bytes");
  const before = [readFileSync(legacyDb), readFileSync(legacyJsonl)];
  const workflowPath = join(root, "workflow-telemetry-v1.db");
  const projection = module.openWorkflowProjectionDatabase({ path: workflowPath, legacyPaths: [legacyDb, legacyJsonl] });
  try {
    expect(projection.schemaVersion()).toBe(1);
    const columns = projection.schemaSql().toLowerCase();
    expect(columns).toContain("workflow_id");
    expect(columns).toContain("snapshot_id");
    expect(columns).toContain("project_label");
    expect(columns).toContain("workflow_config_version");
    for (const dimension of ["agent_id", "agent_name", "node_id", "parent_node_id", "task_id", "adapter_id", "profile_id", "workspace_id", "workspace_hash", "lease_state", "question_id", "checkpoint_id", "approval_id", "knowledge_job_id", "knowledge_update_id", "model_id", "thinking", "tool_name", "capability_id", "attempt_id", "operation_id", "precision", "elapsed_ms", "budget_scope", "change_coverage", "terminal_refs_json"]) expect(columns).toContain(dimension);
    expect(columns).not.toContain("planning");
    expect(columns).not.toContain("hive_team");
    expect(columns).not.toContain("plan_id");
  } finally { projection.close(); }
  expect(readFileSync(legacyDb)).toEqual(before[0]);
  expect(readFileSync(legacyJsonl)).toEqual(before[1]);
  expect(() => module.openWorkflowProjectionDatabase({ path: legacyDb, legacyPaths: [legacyDb] })).toThrow(/legacy|separate/i);
});

test("workflow SQLite ingestion is idempotent, gap/hash fail-stop, crash-atomic, and rebuild-equivalent", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-db-ingest-"));
  const path = join(root, "workflow-telemetry-v1.db");
  const projection = module.openWorkflowProjectionDatabase({ path });
  const source = events(5);
  try {
    expect(projection.ingest(source[0])).toBe("inserted");
    expect(projection.ingest(source[0])).toBe("duplicate");
    expect(projection.history({ limit: 10 }).items).toHaveLength(1);
    const gapDraft = createWorkflowEvent({ eventId: "trusted-gap", projectId: "project-db", sessionId: "session-db", runId: "run-db", type: "budget.model.usage.recorded", producer: "harness", payload: { formatVersion: 1 } });
    const trustedGap = toWorkflowTelemetryEvent(sealWorkflowEvent(gapDraft, 3, source[0].sourceEventHash), { workflowId: "delivery", projectRoot: "/project" });
    expect(() => projection.ingest(trustedGap)).toThrow(/gap/i);
    expect(projection.streamStatus(source[0].streamId).state).toBe("blocked");
    projection.reset();

    projection.database.run(`CREATE TRIGGER fail_projection_current BEFORE INSERT ON workflow_current BEGIN SELECT RAISE(ABORT, 'crash'); END`);
    expect(() => projection.ingest(source[0])).toThrow(/crash/i);
    expect(projection.history({ limit: 10 }).items).toHaveLength(0);
    expect(projection.streamStatus(source[0].streamId).lastSequence).toBe(0);
    projection.database.run(`DROP TRIGGER fail_projection_current`);

    projection.rebuild([source]);
    const rebuilt = projection.snapshot();
    projection.reset();
    for (const event of source) projection.ingest(event);
    expect(projection.snapshot()).toEqual(rebuilt);
    expect(projection.current().runs[0].status).toBe("completed");
    expect(projection.usage().estimated.inputTokens).toBe(2);
    expect(projection.usage().providerConfirmed.inputTokens).toBe(1);
  } finally { projection.close(); }
});

test("workflow SQLite rejects forged projected envelopes and matches blocked duplicate/prune usage semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-db-auth-"));
  const path = join(root, "workflow.db");
  let projection = module.openWorkflowProjectionDatabase({ path });
  const source = events(3);
  try {
    expect(() => projection.ingest({ ...source[0], eventHash: "f".repeat(64) })).toThrow(/authentic|trusted|hash/i);
    projection.ingest(source[0]);
    expect(() => projection.ingest({ ...source[1], eventId: "forged-gap", sequence: 3 })).toThrow(/authentic|gap/i);
    expect(projection.ingest(source[0])).toBe("duplicate");
    projection.reset();
    projection.rebuild([source]);
    projection.pruneProjection("2026-07-20T00:00:02.000Z");
    expect(projection.usage()).toEqual({ estimated: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 }, providerConfirmed: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 } });
    expect(projection.database.query(`SELECT COUNT(*) AS count FROM workflow_event_identities`).get()).toEqual({ count: 3 });
  } finally { projection.close(); }

  projection = module.openWorkflowProjectionDatabase({ path });
  const reused = toWorkflowTelemetryEvent(sealWorkflowEvent(createWorkflowEvent({
    eventId: source[0].eventId,
    projectId: "project-reused",
    sessionId: "session-reused",
    type: "run.started",
    producer: "harness",
    payload: { formatVersion: 1 },
  }), 1, null));
  try {
    expect(() => projection.ingest(reused)).toThrow(/reused event ID/i);
    expect(projection.streamStatus(reused.streamId).state).toBe("blocked");
  } finally { projection.close(); }
});

test("workflow SQLite path initialization rejects symlinks/legacy aliases and enforces private permissions concurrently", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-db-secure-"));
  chmodSync(root, 0o777);
  const legacy = join(root, "legacy.db");
  writeFileSync(legacy, "legacy bytes");
  const alias = join(root, "alias.db");
  symlinkSync(legacy, alias);
  expect(() => module.openWorkflowProjectionDatabase({ path: alias, legacyPaths: [legacy] })).toThrow(/symlink|legacy|alias/i);
  const directory = join(root, "private");
  mkdirSync(directory, { mode: 0o777 });
  const path = join(directory, "workflow.db");
  const script = `const {openWorkflowProjectionDatabase}=await import('./src/observability/server/workflow-db.ts'); const db=openWorkflowProjectionDatabase({path:${JSON.stringify(path)}}); db.close()`;
  const children = await Promise.all([0, 1, 2, 3].map(async () => Bun.spawn(["bun", "-e", script], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }).exited));
  expect(children).toEqual([0, 0, 0, 0]);
  expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
});

test("configured workflow projection runtime incrementally syncs PROJECT_CWD without legacy sources and rebuilds on restart", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-runtime-"));
  expect(runtimeModule.workflowProjectionRootCandidates(root, [])).toEqual([root]);
  const dbPath = join(root, "global", "workflow.db");
  const unconfiguredDb = join(root, "global", "absent.db");
  expect(runtimeModule.syncConfiguredWorkflowProjection({ databasePath: unconfiguredDb, projectRoots: [join(root, "unconfigured")] })).toEqual({ active: false, events: 0, streams: 0 });
  expect(existsSync(unconfiguredDb)).toBe(false);
  mkdirSync(join(root, ".pi", "hive"), { recursive: true });
  writeFileSync(join(root, ".pi", "hive", "hive-config.yaml"), "schema-version: 1\nagents: {}\nworkflows: {}\n");
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "runtime-1", projectId: "project-runtime", sessionId: "session-runtime", runId: "run-runtime", type: "run.started", producer: "runtime", payload: { formatVersion: 1, status: "running" } }));
  expect(runtimeModule.syncConfiguredWorkflowProjection({ databasePath: dbPath, projectRoots: [root] }).events).toBe(1);
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "runtime-2", projectId: "project-runtime", sessionId: "session-runtime", runId: "run-runtime", type: "terminal.recorded", producer: "harness", payload: { formatVersion: 1, status: "completed" } }));
  expect(runtimeModule.syncConfiguredWorkflowProjection({ databasePath: dbPath, projectRoots: [root] }).events).toBe(1);
  const projection = module.openWorkflowProjectionDatabase({ path: dbPath });
  try { expect(projection.current().runs[0].status).toBe("completed"); } finally { projection.close(); }
});

test("configured sync retains healthy rows and a stable zero-event blocked stream without rebuilding", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-runtime-blocked-"));
  mkdirSync(join(root, ".pi", "hive"), { recursive: true });
  writeFileSync(join(root, ".pi", "hive", "hive-config.yaml"), "schema-version: 1\nagents: {}\nworkflows: {}\n");
  const candidates = ["candidate-a", "candidate-b"].sort((left, right) => workflowTelemetryStreamId("project-runtime-blocked", left).localeCompare(workflowTelemetryStreamId("project-runtime-blocked", right)));
  const [healthySession, blockedSession] = candidates;
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "shared-event-id", projectId: "project-runtime-blocked", sessionId: healthySession, runId: "run-healthy", type: "run.started", producer: "runtime", payload: { formatVersion: 1 } }));
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "shared-event-id", projectId: "project-runtime-blocked", sessionId: blockedSession, runId: "run-blocked", type: "run.started", producer: "runtime", payload: { formatVersion: 1 } }));
  const path = join(root, "global", "workflow.db");
  const first = runtimeModule.syncConfiguredWorkflowProjection({ databasePath: path, projectRoots: [root] });
  expect(first.diagnostics).toHaveLength(1);

  let projection = module.openWorkflowProjectionDatabase({ path });
  projection.database.run(`CREATE TABLE rebuild_audit (deleted INTEGER NOT NULL)`);
  projection.database.run(`CREATE TRIGGER audit_projection_rebuild AFTER DELETE ON workflow_events BEGIN INSERT INTO rebuild_audit VALUES (1); END`);
  projection.close();

  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "healthy-finish", projectId: "project-runtime-blocked", sessionId: healthySession, runId: "run-healthy", type: "terminal.recorded", producer: "harness", payload: { formatVersion: 1, status: "completed" } }));
  const second = runtimeModule.syncConfiguredWorkflowProjection({ databasePath: path, projectRoots: [root] });
  expect(second.diagnostics).toHaveLength(1);
  projection = module.openWorkflowProjectionDatabase({ path });
  try {
    expect(projection.database.query(`SELECT COUNT(*) AS count FROM rebuild_audit`).get()).toEqual({ count: 0 });
    expect(projection.history({ limit: 10 }).items.map((event) => event.eventId)).toEqual(["shared-event-id", "healthy-finish"]);
    expect(projection.current().runs.find((row) => row.runId === "run-healthy")?.status).toBe("completed");
    expect(projection.streamStatus(workflowTelemetryStreamId("project-runtime-blocked", blockedSession))).toMatchObject({ state: "blocked", lastSequence: 0 });
  } finally { projection.close(); }
});

test("configured sync preserves an unsupported projection schema byte-for-byte", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-unknown-schema-"));
  mkdirSync(join(root, ".pi", "hive"), { recursive: true });
  writeFileSync(join(root, ".pi", "hive", "hive-config.yaml"), "schema-version: 1\nagents: {}\nworkflows: {}\n");
  const path = join(root, "global", "unknown.db");
  mkdirSync(join(root, "global"));
  const unknown = new Database(path);
  unknown.run(`CREATE TABLE workflow_projection_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  unknown.query(`INSERT INTO workflow_projection_metadata (key, value) VALUES ('schema_version', '999')`).run();
  unknown.run(`CREATE TABLE unknown_payload (bytes BLOB NOT NULL)`);
  unknown.query(`INSERT INTO unknown_payload (bytes) VALUES (?)`).run(Buffer.from("preserve-these-unknown-schema-bytes"));
  unknown.close();
  const before = readFileSync(path);

  expect(() => runtimeModule.syncConfiguredWorkflowProjection({ databasePath: path, projectRoots: [root] })).toThrow(module.WorkflowProjectionSchemaError);
  expect(readFileSync(path)).toEqual(before);
  const reopened = new Database(path, { readonly: true });
  try { expect(reopened.query(`SELECT CAST(bytes AS TEXT) AS value FROM unknown_payload`).get()).toEqual({ value: "preserve-these-unknown-schema-bytes" }); }
  finally { reopened.close(); }
});

test("workflow SQLite and in-memory current DTOs select the same stable bounded entity set", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-db-current-"));
  const projection = module.openWorkflowProjectionDatabase({ path: join(root, "workflow.db") });
  const memory = new WorkflowTelemetryProjection();
  try {
    for (let index = 0; index < 550; index++) {
      const event = events(2, `current-${String(index).padStart(4, "0")}`)[0];
      projection.ingest(event);
      memory.ingest(event);
    }
    expect(projection.current().sessions).toHaveLength(500);
    expect(projection.current().sessions.map((row) => row.sessionId)).toEqual(memory.current().sessions.map((row) => row.sessionId));
    expect(projection.current().sessions[0].projectLabel).toBe("Project DB");
    expect(projection.current().sessions[0].workflowConfigVersion).toBe("1");
    const first = projection.currentPage({ kind: "sessions", limit: 500 });
    const second = projection.currentPage({ kind: "sessions", limit: 300, cursor: first.nextCursor });
    expect(first.items).toEqual(projection.current().sessions);
    expect(first.items).toHaveLength(500);
    expect(second.items).toHaveLength(50);
    expect(new Set([...first.items, ...second.items].map((row) => row.sessionId)).size).toBe(550);
  } finally { projection.close(); }
}, 10_000);

test("workflow SQLite verifies persisted event and current integrity on restart and repairs from authoritative journals", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-db-tamper-"));
  mkdirSync(join(root, ".pi", "hive"), { recursive: true });
  writeFileSync(join(root, ".pi", "hive", "hive-config.yaml"), "schema-version: 1\nagents: {}\nworkflows: {}\n");
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "tamper-1", projectId: "project-tamper", sessionId: "session-tamper", runId: "run-tamper", type: "run.started", producer: "runtime", payload: { formatVersion: 1, status: "running" } }));
  const dbPath = join(root, "global", "workflow.db");
  runtimeModule.syncConfiguredWorkflowProjection({ databasePath: dbPath, projectRoots: [root] });
  let projection = module.openWorkflowProjectionDatabase({ path: dbPath });
  projection.database.query(`UPDATE workflow_events SET event_json = jsonb(?)`).run(JSON.stringify({ forged: true }));
  projection.close();
  expect(() => module.openWorkflowProjectionDatabase({ path: dbPath })).toThrow(/integrity|corrupt|event/i);
  // The production synchronizer treats the DB as disposable and reconstructs it from journals.
  expect(runtimeModule.syncConfiguredWorkflowProjection({ databasePath: dbPath, projectRoots: [root] }).events).toBe(1);
  projection = module.openWorkflowProjectionDatabase({ path: dbPath });
  projection.database.query(`UPDATE workflow_current SET current_json = jsonb(?)`).run(JSON.stringify({ forged: true }));
  projection.close();
  expect(() => module.openWorkflowProjectionDatabase({ path: dbPath })).toThrow(/integrity|corrupt|current/i);
});

test("configured projection preserves last-known-good corrupt streams while healthy streams continue", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-mixed-journals-"));
  mkdirSync(join(root, ".pi", "hive"), { recursive: true });
  writeFileSync(join(root, ".pi", "hive", "hive-config.yaml"), "schema-version: 1\nagents: {}\nworkflows: {}\n");
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "healthy", projectId: "project-mixed", sessionId: "healthy", runId: "run-healthy", type: "run.started", producer: "runtime", payload: { formatVersion: 1 } }));
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "corrupt", projectId: "project-mixed", sessionId: "corrupt", runId: "run-corrupt", type: "run.started", producer: "runtime", payload: { formatVersion: 1 } }));
  const dbPath = join(root, "workflow.db");
  runtimeModule.syncConfiguredWorkflowProjection({ databasePath: dbPath, projectRoots: [root] });
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "healthy-finish", projectId: "project-mixed", sessionId: "healthy", runId: "run-healthy", type: "terminal.recorded", producer: "runtime", payload: { formatVersion: 1, status: "completed" } }));
  const corruptDir = join(root, ".pi", "hive", "sessions", "corrupt", "journal");
  writeFileSync(join(corruptDir, readdirSync(corruptDir)[0]), "{corrupt\n");
  const result = runtimeModule.syncConfiguredWorkflowProjection({ databasePath: dbPath, projectRoots: [root] });
  expect(result).toMatchObject({ active: true, events: 1, streams: 2 });
  expect(result.diagnostics?.[0]?.diagnostic.length).toBeLessThanOrEqual(2_048);
  const projection = module.openWorkflowProjectionDatabase({ path: dbPath });
  try {
    expect(new Set(projection.current().runs.map((row) => row.runId))).toEqual(new Set(["run-corrupt", "run-healthy"]));
    expect(projection.current().runs.find((row) => row.runId === "run-healthy")?.status).toBe("completed");
    const corruptStream = projection.current().runs.find((row) => row.runId === "run-corrupt")!;
    expect(projection.streamStatus(workflowTelemetryStreamId("project-mixed", corruptStream.sessionId)).state).toBe("blocked");
  } finally { projection.close(); }
});

test("workflow SQLite rejects malformed history and current cursors", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-db-cursor-"));
  const projection = module.openWorkflowProjectionDatabase({ path: join(root, "workflow.db") });
  try {
    for (const cursor of ["!", "a=", "a b", "%%%%", "eyJub3QiOiJhLWN1cnNvciJ9"]) {
      expect(() => projection.history({ limit: 1, cursor })).toThrow(/cursor.*invalid/i);
      expect(() => projection.currentPage({ kind: "sessions", limit: 1, cursor })).toThrow(/cursor.*invalid/i);
    }
  } finally { projection.close(); }
});

test("workflow SQLite detects normalized filter, timestamp, usage, current, identity, and stream-state tamper", () => {
  const mutations = [
    `UPDATE workflow_events SET workflow_id = 'forged'`,
    `UPDATE workflow_events SET timestamp = '1900-01-01T00:00:00.000Z'`,
    `UPDATE workflow_usage SET input_tokens = input_tokens + 1000`,
    `UPDATE workflow_current SET workflow_id = 'forged'`,
    `UPDATE workflow_event_identities SET event_hash = '${"f".repeat(64)}'`,
    `UPDATE workflow_streams SET last_sequence = 999`,
  ];
  for (const [index, mutation] of mutations.entries()) {
    const root = mkdtempSync(join(tmpdir(), `pi-hive-workflow-db-tamper-${index}-`));
    const path = join(root, "workflow.db");
    const projection = module.openWorkflowProjectionDatabase({ path });
    projection.rebuild([events(3)]);
    projection.database.run(mutation);
    projection.close();
    expect(() => module.openWorkflowProjectionDatabase({ path })).toThrow(/integrity|tamper|projection/i);
  }
});

test("aggregate SQLite rebuild persists zero-event blocked streams across reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-db-cross-stream-"));
  const path = join(root, "workflow.db");
  let projection = module.openWorkflowProjectionDatabase({ path });
  const healthy = events(2, "a-healthy");
  const conflictingDraft = createWorkflowEvent({ eventId: healthy[0].eventId, projectId: "project-db", sessionId: "z-corrupt", runId: "run-corrupt", type: "run.started", producer: "harness", payload: { formatVersion: 1 } });
  const conflicting = toWorkflowTelemetryEvent(sealWorkflowEvent(conflictingDraft, 1, null), { workflowId: "delivery" });
  const gapDraft = createWorkflowEvent({ eventId: "first-gap", projectId: "project-db", sessionId: "z-gap", runId: "run-gap", type: "run.started", producer: "harness", payload: { formatVersion: 1 } });
  const gap = toWorkflowTelemetryEvent(sealWorkflowEvent(gapDraft, 2, null), { workflowId: "delivery" });
  try {
    const result = projection.rebuild([healthy, [conflicting], [gap]]);
    expect(result.diagnostics).toHaveLength(2);
    expect(projection.history({ limit: 10 }).items.map((event) => event.eventId)).toEqual(healthy.map((event) => event.eventId));
    expect(projection.current().runs[0].runId).toBe("run-db");
    for (const event of [conflicting, gap]) {
      expect(projection.streamStatus(event.streamId)).toMatchObject({ state: "blocked", lastSequence: 0, lastHash: null });
    }
  } finally { projection.close(); }

  projection = module.openWorkflowProjectionDatabase({ path });
  try {
    expect(projection.history({ limit: 10 }).items.map((event) => event.eventId)).toEqual(healthy.map((event) => event.eventId));
    for (const event of [conflicting, gap]) expect(projection.streamStatus(event.streamId).state).toBe("blocked");
  } finally { projection.close(); }
});

test("in-memory and SQLite DTOs match for filtered history pages and every current kind beyond 500", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-db-dto-equivalence-"));
  const database = module.openWorkflowProjectionDatabase({ path: join(root, "workflow.db") });
  const memory = new WorkflowTelemetryProjection();
  const streams: WorkflowTelemetryEvent[][] = [];
  for (let index = 0; index < 501; index++) {
    const sessionId = `dto-${String(index).padStart(4, "0")}`;
    const runId = `run-${index}`;
    const drafts = [
      createWorkflowEvent({ eventId: `${sessionId}-session`, projectId: "project-dto", sessionId, type: "session.created", producer: "harness", timestamp: new Date(Date.UTC(2026, 6, 21, 0, 0, index * 8)).toISOString(), payload: { formatVersion: 1 } }),
      createWorkflowEvent({ eventId: `${sessionId}-run`, projectId: "project-dto", sessionId, runId, type: "run.started", producer: "harness", timestamp: new Date(Date.UTC(2026, 6, 21, 0, 0, index * 8 + 1)).toISOString(), payload: { formatVersion: 1, nodeId: `node-${index}` } }),
      createWorkflowEvent({ eventId: `${sessionId}-task`, projectId: "project-dto", sessionId, runId, type: "task.started", producer: "harness", timestamp: new Date(Date.UTC(2026, 6, 21, 0, 0, index * 8 + 2)).toISOString(), payload: { formatVersion: 1, nodeId: `node-${index}`, taskId: `task-${index}` } }),
      createWorkflowEvent({ eventId: `${sessionId}-workspace`, projectId: "project-dto", sessionId, runId, type: "artifact.recorded", producer: "harness", timestamp: new Date(Date.UTC(2026, 6, 21, 0, 0, index * 8 + 3)).toISOString(), payload: { formatVersion: 1, workspaceId: `workspace-${index}` } }),
      createWorkflowEvent({ eventId: `${sessionId}-question`, projectId: "project-dto", sessionId, runId, type: "question.transition", producer: "harness", timestamp: new Date(Date.UTC(2026, 6, 21, 0, 0, index * 8 + 4)).toISOString(), payload: { formatVersion: 1, operation: "create", questionId: `question-${index}` } }),
      createWorkflowEvent({ eventId: `${sessionId}-approval`, projectId: "project-dto", sessionId, runId, type: "approval.recorded", producer: "harness", timestamp: new Date(Date.UTC(2026, 6, 21, 0, 0, index * 8 + 5)).toISOString(), payload: { formatVersion: 1, operation: "request", approvalId: `approval-${index}` } }),
      createWorkflowEvent({ eventId: `${sessionId}-knowledge`, projectId: "project-dto", sessionId, runId, type: "knowledge.transition", producer: "harness", timestamp: new Date(Date.UTC(2026, 6, 21, 0, 0, index * 8 + 6)).toISOString(), payload: { formatVersion: 1, knowledgeJobId: `knowledge-${index}` } }),
    ];
    const sealed: WorkflowEventEnvelope[] = [];
    for (const draft of drafts) sealed.push(sealWorkflowEvent(draft, sealed.length + 1, sealed.at(-1)?.eventHash ?? null));
    const stream = sealed.map((event) => toWorkflowTelemetryEvent(event, { workflowId: index % 2 ? "odd" : "even", snapshotId: `snapshot-${index}` }));
    streams.push(stream);
    for (const event of stream) memory.ingest(event);
  }
  try {
    database.rebuild(streams);
    for (const kind of ["sessions", "runs", "nodes", "tasks", "workspaces", "questions", "approvals", "knowledge"] as const) {
      const dbItems: unknown[] = [];
      const memoryItems: unknown[] = [];
      let dbCursor: string | undefined;
      let memoryCursor: string | undefined;
      do {
        const dbPage = database.currentPage({ kind, limit: 200, ...(dbCursor ? { cursor: dbCursor } : {}) });
        const memoryPage = memory.currentPage({ kind, limit: 200, ...(memoryCursor ? { cursor: memoryCursor } : {}) });
        dbItems.push(...dbPage.items); memoryItems.push(...memoryPage.items);
        dbCursor = dbPage.nextCursor; memoryCursor = memoryPage.nextCursor;
      } while (dbCursor || memoryCursor);
      expect(dbItems).toEqual(memoryItems);
      expect(dbItems).toHaveLength(501);
    }
    let dbCursor: string | undefined;
    let memoryCursor: string | undefined;
    do {
      const dbPage = database.history({ limit: 173, workflowId: "even", eventType: "task.started", ...(dbCursor ? { cursor: dbCursor } : {}) });
      const memoryPage = memory.history({ limit: 173, workflowId: "even", eventType: "task.started", ...(memoryCursor ? { cursor: memoryCursor } : {}) });
      expect(dbPage).toEqual(memoryPage);
      dbCursor = dbPage.nextCursor; memoryCursor = memoryPage.nextCursor;
    } while (dbCursor || memoryCursor);
  } finally { database.close(); }
}, 20_000);

test("in-memory and SQLite current pages and cursors are byte-identical for Unicode IDs", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-db-unicode-order-"));
  const database = module.openWorkflowProjectionDatabase({ path: join(root, "workflow.db") });
  const memory = new WorkflowTelemetryProjection();
  const ids = [`session-\u{10000}`, `session-\uE000`, "session-ascii"];
  try {
    for (const [index, sessionId] of ids.entries()) {
      const draft = createWorkflowEvent({
        eventId: `unicode-order-${index}`,
        projectId: "project-unicode",
        sessionId,
        runId: `run-${sessionId}`,
        type: "run.started",
        producer: "harness",
        timestamp: `2026-07-21T00:00:0${index}.000Z`,
        payload: { formatVersion: 1, nodeId: `node-${sessionId}` },
      });
      const event = toWorkflowTelemetryEvent(sealWorkflowEvent(draft, 1, null));
      database.ingest(event);
      memory.ingest(event);
    }
    const seen: string[] = [];
    let databaseCursor: string | undefined;
    let memoryCursor: string | undefined;
    do {
      const databasePage = database.currentPage({ kind: "sessions", limit: 1, ...(databaseCursor ? { cursor: databaseCursor } : {}) });
      const memoryPage = memory.currentPage({ kind: "sessions", limit: 1, ...(memoryCursor ? { cursor: memoryCursor } : {}) });
      expect(databasePage).toEqual(memoryPage);
      if (databasePage.nextCursor) expect(Buffer.from(databasePage.nextCursor)).toEqual(Buffer.from(memoryPage.nextCursor!));
      seen.push(...databasePage.items.map((row) => row.sessionId));
      databaseCursor = databasePage.nextCursor;
      memoryCursor = memoryPage.nextCursor;
    } while (databaseCursor || memoryCursor);
    expect(seen).toEqual(["session-ascii", `session-\uE000`, `session-\u{10000}`]);
    expect(database.schemaSql()).toContain("current_order_key");
  } finally { database.close(); }
});

test("in-memory prune matches SQLite contiguous per-stream prefix semantics for old-new-old timestamps", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-db-prune-prefix-"));
  const database = module.openWorkflowProjectionDatabase({ path: join(root, "workflow.db") });
  const memory = new WorkflowTelemetryProjection();
  const drafts = [
    createWorkflowEvent({ eventId: "prefix-old", projectId: "project-prefix", sessionId: "session-prefix", runId: "run-prefix", type: "budget.model.usage.recorded", producer: "harness", timestamp: "2026-07-20T00:00:00.000Z", payload: { formatVersion: 1, usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1, precision: "estimated" } } }),
    createWorkflowEvent({ eventId: "prefix-new", projectId: "project-prefix", sessionId: "session-prefix", runId: "run-prefix", type: "budget.model.usage.recorded", producer: "harness", timestamp: "2026-07-20T00:00:02.000Z", payload: { formatVersion: 1, usage: { inputTokens: 2, outputTokens: 2, costMicroUsd: 2, precision: "estimated" } } }),
    createWorkflowEvent({ eventId: "prefix-old-after-new", projectId: "project-prefix", sessionId: "session-prefix", runId: "run-prefix", type: "budget.model.usage.recorded", producer: "harness", timestamp: "2026-07-20T00:00:00.500Z", payload: { formatVersion: 1, usage: { inputTokens: 4, outputTokens: 4, costMicroUsd: 4, precision: "estimated" } } }),
    createWorkflowEvent({ eventId: "prefix-continuation", projectId: "project-prefix", sessionId: "session-prefix", runId: "run-prefix", type: "budget.model.usage.recorded", producer: "harness", timestamp: "2026-07-20T00:00:03.000Z", payload: { formatVersion: 1, usage: { inputTokens: 8, outputTokens: 8, costMicroUsd: 8, precision: "estimated" } } }),
  ];
  const sealed: WorkflowEventEnvelope[] = [];
  for (const draft of drafts) sealed.push(sealWorkflowEvent(draft, sealed.length + 1, sealed.at(-1)?.eventHash ?? null));
  const stream = sealed.map((event) => toWorkflowTelemetryEvent(event));
  try {
    for (const event of stream.slice(0, 3)) { database.ingest(event); memory.ingest(event); }
    const databasePruned = database.pruneProjection("2026-07-20T00:00:01.000Z");
    expect(databasePruned).toEqual({ removed: 1, retained: 2 });
    expect(memory.pruneProjection("2026-07-20T00:00:01.000Z")).toEqual(databasePruned);
    expect(memory.history({ limit: 10 })).toEqual(database.history({ limit: 10 }));
    expect(memory.history({ limit: 10 }).items.map((event) => event.eventId)).toEqual(["prefix-old-after-new", "prefix-new"]);
    expect(memory.usage()).toEqual(database.usage());
    expect(memory.usage().estimated).toEqual({ inputTokens: 6, outputTokens: 6, costMicroUsd: 6 });
    expect(memory.streamStatus(stream[0].streamId)).toEqual(database.streamStatus(stream[0].streamId));
    expect(memory.ingest(stream[3])).toBe("inserted");
    expect(database.ingest(stream[3])).toBe("inserted");
    expect(memory.snapshot()).toEqual(database.snapshot());
  } finally { database.close(); }
});

test("projection prune compares timezone-offset timestamps chronologically in memory and SQLite", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-db-prune-offset-"));
  const database = module.openWorkflowProjectionDatabase({ path: join(root, "workflow.db") });
  const memory = new WorkflowTelemetryProjection();
  const drafts = [
    createWorkflowEvent({ eventId: "offset-chronologically-old", projectId: "project-offset", sessionId: "session-offset", runId: "run-offset", type: "budget.model.usage.recorded", producer: "harness", timestamp: "2026-07-20T01:00:00.000+02:00", payload: { formatVersion: 1 } }),
    createWorkflowEvent({ eventId: "offset-chronologically-new", projectId: "project-offset", sessionId: "session-offset", runId: "run-offset", type: "budget.model.usage.recorded", producer: "harness", timestamp: "2026-07-19T23:30:00.000-02:00", payload: { formatVersion: 1 } }),
  ];
  const sealed: WorkflowEventEnvelope[] = [];
  for (const draft of drafts) sealed.push(sealWorkflowEvent(draft, sealed.length + 1, sealed.at(-1)?.eventHash ?? null));
  const stream = sealed.map((event) => toWorkflowTelemetryEvent(event));
  try {
    for (const event of stream) { database.ingest(event); memory.ingest(event); }
    const cutoff = "2026-07-20T00:00:00.000Z";
    expect(database.pruneProjection(cutoff)).toEqual({ removed: 1, retained: 1 });
    expect(memory.pruneProjection(cutoff)).toEqual({ removed: 1, retained: 1 });
    expect(memory.history({ limit: 10 }).items.map((event) => event.eventId)).toEqual(["offset-chronologically-new"]);
    expect(memory.snapshot()).toEqual(database.snapshot());
  } finally { database.close(); }
});

test("workflow SQLite history handles more than ten thousand events with bounded pages", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-db-large-"));
  const path = join(root, "workflow-telemetry-v1.db");
  const projection = module.openWorkflowProjectionDatabase({ path });
  try {
    const source = events(10_001, "large-session");
    projection.rebuild([source]);
    const first = projection.history({ limit: 200 });
    expect(first.items).toHaveLength(200);
    expect(first.hasMore).toBe(true);
    const second = projection.history({ limit: 200, cursor: first.nextCursor });
    const firstIds = new Set(first.items.map((event) => event.eventId));
    expect(second.items.some((event) => firstIds.has(event.eventId))).toBe(false);
    expect(() => projection.history({ limit: 501 })).toThrow(/limit/i);
    expect(projection.current().runs[0].status).toBe("completed");
  } finally { projection.close(); }
}, 30_000);

test("persistent configured synchronizer processes only committed journal suffixes and closes its database", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-incremental-runtime-"));
  mkdirSync(join(root, ".pi", "hive"), { recursive: true });
  writeFileSync(join(root, ".pi", "hive", "hive-config.yaml"), "schema-version: 1\nagents: {}\nworkflows: {}\n");
  const sessionId = "large-incremental";
  const journal = join(root, ".pi", "hive", "sessions", sessionId, "journal");
  mkdirSync(journal, { recursive: true });
  const source: WorkflowEventEnvelope[] = [];
  for (let index = 0; index < 2_000; index++) {
    const draft = createWorkflowEvent({
      eventId: `incremental-${index}`,
      projectId: "project-incremental",
      sessionId,
      runId: "run-incremental",
      type: index === 0 ? "run.started" : "budget.model.usage.recorded",
      producer: "harness",
      timestamp: new Date(Date.UTC(2026, 6, 20, 0, 0, index)).toISOString(),
      payload: { formatVersion: 1 },
    });
    const event = sealWorkflowEvent(draft, index + 1, source.at(-1)?.eventHash ?? null);
    source.push(event);
    writeFileSync(join(journal, `${String(event.sequence).padStart(16, "0")}-${event.eventHash}.json`), `${JSON.stringify(event)}\n`);
  }
  const path = join(root, "global", "workflow.db");
  const synchronizer = runtimeModule.createConfiguredWorkflowProjectionSynchronizer({ databasePath: path, retentionDays: 30, now: () => new Date("2026-08-01T00:00:00.000Z") });
  expect(synchronizer.sync([root])).toMatchObject({ active: true, events: 2_000, streams: 1 });
  expect(synchronizer.sync([root])).toMatchObject({ active: true, events: 0, streams: 1 });
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "incremental-one-more", projectId: "project-incremental", sessionId, runId: "run-incremental", type: "terminal.recorded", producer: "harness", timestamp: "2026-08-01T00:00:01.000Z", payload: { formatVersion: 1, status: "completed" } }));
  expect(synchronizer.sync([root])).toMatchObject({ active: true, events: 1, streams: 1 });
  synchronizer.close();
  expect(() => synchronizer.sync([root])).toThrow(/closed/i);
  const projection = module.openWorkflowProjectionDatabase({ path });
  try { expect(projection.current().runs[0].status).toBe("completed"); } finally { projection.close(); }
}, 20_000);

test("persistent sync detects older event corruption before and after a later append", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-incremental-corrupt-"));
  mkdirSync(join(root, ".pi", "hive"), { recursive: true });
  writeFileSync(join(root, ".pi", "hive", "hive-config.yaml"), "schema-version: 1\nagents: {}\nworkflows: {}\n");
  const sessionId = "incremental-corrupt";
  const source: WorkflowEventEnvelope[] = [];
  for (let index = 0; index < 3; index++) {
    source.push(appendWorkflowEvent(root, createWorkflowEvent({
      eventId: `incremental-corrupt-${index}`,
      projectId: "project-incremental-corrupt",
      sessionId,
      runId: "run-incremental-corrupt",
      type: index === 0 ? "run.started" : "budget.model.usage.recorded",
      producer: "harness",
      timestamp: new Date(Date.UTC(2026, 6, 20, 0, 0, index)).toISOString(),
      payload: { formatVersion: 1 },
    })));
  }
  const path = join(root, "global", "workflow.db");
  const synchronizer = runtimeModule.createConfiguredWorkflowProjectionSynchronizer({ databasePath: path });
  expect(synchronizer.sync([root])).toMatchObject({ events: 3, streams: 1 });
  expect(synchronizer.sync([root])).toMatchObject({ events: 0, streams: 1 });

  const journal = join(root, ".pi", "hive", "sessions", sessionId, "journal");
  const names = readdirSync(journal).sort();
  writeFileSync(join(journal, names[0]), "{corrupt-older-event\n");
  const corrupted = synchronizer.sync([root]);
  expect(corrupted).toMatchObject({ events: 0, streams: 1 });
  expect(corrupted.diagnostics?.some((entry) => entry.sessionId === sessionId)).toBe(true);

  const later = sealWorkflowEvent(createWorkflowEvent({
    eventId: "incremental-corrupt-later",
    projectId: "project-incremental-corrupt",
    sessionId,
    runId: "run-incremental-corrupt",
    type: "terminal.recorded",
    producer: "harness",
    timestamp: "2026-07-20T00:00:03.000Z",
    payload: { formatVersion: 1, status: "completed" },
  }), 4, source.at(-1)!.eventHash);
  writeFileSync(join(journal, `${String(later.sequence).padStart(16, "0")}-${later.eventHash}.json`), `${JSON.stringify(later)}\n`);
  for (let poll = 0; poll < 2; poll++) {
    const repeated = synchronizer.sync([root]);
    expect(repeated).toMatchObject({ events: 0, streams: 1 });
    expect(repeated.diagnostics?.some((entry) => entry.sessionId === sessionId)).toBe(true);
  }
  synchronizer.close();

  const projection = module.openWorkflowProjectionDatabase({ path });
  try {
    const streamId = workflowTelemetryStreamId("project-incremental-corrupt", sessionId);
    expect(projection.streamStatus(streamId)).toMatchObject({ state: "blocked", lastSequence: 3 });
    expect(projection.database.query(`SELECT COUNT(*) AS count FROM workflow_event_identities`).get()).toEqual({ count: 3 });
  } finally { projection.close(); }
});

test("production retention prunes only disposable projection rows and preserves journals and current state", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-production-retention-"));
  mkdirSync(join(root, ".pi", "hive"), { recursive: true });
  writeFileSync(join(root, ".pi", "hive", "hive-config.yaml"), "schema-version: 1\nagents: {}\nworkflows: {}\n");
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "retention-open", projectId: "project-retention", sessionId: "retention-open", runId: "run-open", type: "run.started", producer: "runtime", timestamp: "2026-07-01T00:00:00.000Z", payload: { formatVersion: 1, status: "running" } }));
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "retention-closed-start", projectId: "project-retention", sessionId: "retention-closed", runId: "run-closed", type: "run.started", producer: "runtime", timestamp: "2026-07-01T00:00:00.000Z", payload: { formatVersion: 1 } }));
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "retention-closed-finish", projectId: "project-retention", sessionId: "retention-closed", runId: "run-closed", type: "terminal.recorded", producer: "runtime", timestamp: "2026-07-01T00:00:01.000Z", payload: { formatVersion: 1, status: "completed" } }));
  const journalBytes = ["retention-open", "retention-closed"].map((sessionId) => readdirSync(join(root, ".pi", "hive", "sessions", sessionId, "journal")).map((name) => readFileSync(join(root, ".pi", "hive", "sessions", sessionId, "journal", name))));
  const path = join(root, "global", "workflow.db");
  const synchronizer = runtimeModule.createConfiguredWorkflowProjectionSynchronizer({ databasePath: path, retentionDays: 7, now: () => new Date("2026-08-01T00:00:00.000Z") });
  expect(synchronizer.sync([root]).events).toBe(3);
  synchronizer.close();
  const projection = module.openWorkflowProjectionDatabase({ path });
  try {
    expect(projection.history({ limit: 10 }).items).toHaveLength(0);
    expect(new Map(projection.current().runs.map((row) => [row.runId, row.status]))).toEqual(new Map([["run-open", "running"], ["run-closed", "completed"]]));
    expect(projection.database.query(`SELECT COUNT(*) AS count FROM workflow_prune_watermarks`).get()).toEqual({ count: 2 });
  } finally { projection.close(); }
  for (const [index, sessionId] of ["retention-open", "retention-closed"].entries()) {
    const after = readdirSync(join(root, ".pi", "hive", "sessions", sessionId, "journal")).map((name) => readFileSync(join(root, ".pi", "hive", "sessions", sessionId, "journal", name)));
    expect(after).toEqual(journalBytes[index]);
  }
});

test("fully pruned corrupt stream preserves last-known-good projection while a healthy stream advances", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-pruned-corrupt-"));
  mkdirSync(join(root, ".pi", "hive"), { recursive: true });
  writeFileSync(join(root, ".pi", "hive", "hive-config.yaml"), "schema-version: 1\nagents: {}\nworkflows: {}\n");
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "pruned-corrupt", projectId: "project-pruned-corrupt", sessionId: "corrupt", runId: "run-corrupt", type: "terminal.recorded", producer: "runtime", timestamp: "2026-07-01T00:00:00.000Z", payload: { formatVersion: 1, status: "completed" } }));
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "pruned-healthy", projectId: "project-pruned-corrupt", sessionId: "healthy", runId: "run-healthy", type: "run.started", producer: "runtime", timestamp: "2026-07-01T00:00:00.000Z", payload: { formatVersion: 1, status: "running" } }));
  const path = join(root, "global", "workflow.db");
  const synchronizer = runtimeModule.createConfiguredWorkflowProjectionSynchronizer({ databasePath: path, retentionDays: 7, now: () => new Date("2026-08-01T00:00:00.000Z") });
  expect(synchronizer.sync([root]).events).toBe(2);
  const corruptJournal = join(root, ".pi", "hive", "sessions", "corrupt", "journal");
  writeFileSync(join(corruptJournal, readdirSync(corruptJournal)[0]), "{corrupt\n");
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "pruned-healthy-finish", projectId: "project-pruned-corrupt", sessionId: "healthy", runId: "run-healthy", type: "terminal.recorded", producer: "runtime", timestamp: "2026-08-01T00:00:01.000Z", payload: { formatVersion: 1, status: "completed" } }));
  const result = synchronizer.sync([root]);
  expect(result).toMatchObject({ active: true, events: 1, streams: 2 });
  expect(result.diagnostics?.some((entry) => entry.sessionId === "corrupt")).toBe(true);
  synchronizer.close();
  const projection = module.openWorkflowProjectionDatabase({ path });
  try {
    const corruptId = workflowTelemetryStreamId("project-pruned-corrupt", "corrupt");
    expect(projection.streamStatus(corruptId)).toMatchObject({ state: "blocked", lastSequence: 1 });
    expect(new Map(projection.current().runs.map((row) => [row.runId, row.status]))).toEqual(new Map([["run-corrupt", "completed"], ["run-healthy", "completed"]]));
    expect(projection.database.query(`SELECT COUNT(*) AS count FROM workflow_event_identities`).get()).toEqual({ count: 3 });
    expect(projection.database.query(`SELECT through_sequence FROM workflow_prune_watermarks WHERE stream_id = ?`).get(corruptId)).toEqual({ through_sequence: 1 });
  } finally { projection.close(); }
});

test("projection prune watermark survives reopen and routine sync without reimporting journal history", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-prune-reopen-"));
  mkdirSync(join(root, ".pi", "hive"), { recursive: true });
  writeFileSync(join(root, ".pi", "hive", "hive-config.yaml"), "schema-version: 1\nagents: {}\nworkflows: {}\n");
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "prune-start", projectId: "project-prune", sessionId: "session-prune", runId: "run-prune", type: "run.started", producer: "runtime", timestamp: "2026-07-20T00:00:00.000Z", payload: { formatVersion: 1 } }));
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "prune-finish", projectId: "project-prune", sessionId: "session-prune", runId: "run-prune", type: "terminal.recorded", producer: "runtime", timestamp: "2026-07-20T00:00:01.000Z", payload: { formatVersion: 1, status: "completed" } }));
  const path = join(root, "global", "workflow.db");
  runtimeModule.syncConfiguredWorkflowProjection({ databasePath: path, projectRoots: [root] });
  let projection = module.openWorkflowProjectionDatabase({ path });
  expect(projection.pruneProjection("2026-07-20T00:00:02.000Z")).toEqual({ removed: 2, retained: 0 });
  expect(projection.current().runs[0].status).toBe("completed");
  projection.close();

  projection = module.openWorkflowProjectionDatabase({ path });
  expect(projection.history({ limit: 10 }).items).toHaveLength(0);
  expect(projection.current().runs[0].status).toBe("completed");
  projection.close();
  runtimeModule.syncConfiguredWorkflowProjection({ databasePath: path, projectRoots: [root] });
  projection = module.openWorkflowProjectionDatabase({ path });
  try {
    expect(projection.history({ limit: 10 }).items).toHaveLength(0);
    expect(projection.current().runs[0].status).toBe("completed");
    expect(projection.database.query(`SELECT COUNT(*) AS count FROM workflow_event_identities`).get()).toEqual({ count: 2 });
    expect(projection.database.query(`SELECT COUNT(*) AS count FROM workflow_prune_watermarks`).get()).toEqual({ count: 1 });
  } finally { projection.close(); }
});
