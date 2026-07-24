import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorkflowTelemetryEvent } from "../../src/observability/events";
import { encodeWorkflowHistoryCursor } from "../../src/observability/projection";
import { openWorkflowProjectionDatabase } from "../../src/observability/server/workflow-db";
import { createWorkflowEvent, sealWorkflowEvent } from "../../src/workflows/events";

function stream(count: number) {
  const events = [];
  let previous: string | null = null;
  for (let index = 1; index <= count; index++) {
    const source = sealWorkflowEvent(createWorkflowEvent({
      eventId: `event-${index}`, projectId: "project-1", sessionId: "session-1", runId: `run-${String(index).padStart(4, "0")}`,
      type: "run.started", producer: "runtime", timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      payload: { workflowId: index % 2 ? "build" : "review", status: "running" },
    }), index, previous);
    previous = source.eventHash;
    events.push(toWorkflowTelemetryEvent(source, { projectRoot: "/project", workflowId: index % 2 ? "build" : "review" }));
  }
  return events;
}

test("pre-change schema-v1 database migrates the additive proposal dimension with ALTER", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pi-hive-workflow-schema-v1-")), "workflow.db");
  openWorkflowProjectionDatabase({ path }).close();
  const legacy = new Database(path);
  expect(legacy.query(`SELECT value FROM workflow_projection_metadata WHERE key = 'schema_version'`).get()).toEqual({ value: "1" });
  legacy.run(`ALTER TABLE workflow_events DROP COLUMN knowledge_proposal_id`);
  expect((legacy.query(`PRAGMA table_info(workflow_events)`).all() as Array<{ name: string }>).some((column) => column.name === "knowledge_proposal_id")).toBe(false);
  legacy.close();

  const database = openWorkflowProjectionDatabase({ path });
  const source = sealWorkflowEvent(createWorkflowEvent({ eventId: "proposal-event", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "runtime", payload: { formatVersion: 1, operation: "proposal-created", proposalId: "proposal-1" } }), 1, null);
  database.ingest(toWorkflowTelemetryEvent(source));
  expect(database.database.query(`SELECT knowledge_proposal_id FROM workflow_events WHERE event_id = ?`).get("proposal-event")).toEqual({ knowledge_proposal_id: "proposal-1" });
  database.close();
});

test("workflow server DB pages large filtered resources stably across restart", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pi-hive-workflow-server-db-")), "workflow.db");
  let database = openWorkflowProjectionDatabase({ path });
  for (const event of stream(701)) database.ingest(event);

  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = database.currentPage({ kind: "runs", limit: 137, cursor, projectId: "project-1", sessionId: "session-1", workflowId: "build", status: "running" });
    ids.push(...page.items.map((row) => row.runId!));
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids).toHaveLength(351);
  expect(new Set(ids).size).toBe(351);
  expect(ids).toEqual([...ids].sort());

  const history = database.history({ limit: 300, workflowId: "review", eventType: "run.started" });
  expect(history.items).toHaveLength(300);
  expect(history.hasMore).toBe(true);
  database.close();

  database = openWorkflowProjectionDatabase({ path });
  const afterRestart = database.currentPage({ kind: "runs", limit: 10, workflowId: "build" });
  expect(afterRestart.items.map((row) => row.runId)).toEqual(ids.slice(0, 10));
  database.close();
}, 10_000);

test("workflow operation receipts atomically claim, finalize, replay after restart, and fail closed", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "pi-hive-workflow-receipts-")), "workflow.db");
  let database = openWorkflowProjectionDatabase({ path });
  let invocations = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const invoke = async () => { invocations += 1; await held; return { durable: true, value: 7 }; };
  const first = database.runOperation("projection-prune", "operation-1", "a".repeat(64), invoke);
  const concurrent = database.runOperation("projection-prune", "operation-1", "a".repeat(64), invoke);
  release();
  expect(await first).toEqual({ durable: true, value: 7 });
  expect(await concurrent).toEqual({ durable: true, value: 7 });
  expect(invocations).toBe(1);
  database.close();

  database = openWorkflowProjectionDatabase({ path });
  expect(await database.runOperation<{ durable: boolean; value: number }>("projection-prune", "operation-1", "a".repeat(64), async () => {
    throw new Error("must not invoke after restart");
  })).toEqual({ durable: true, value: 7 });
  await expect(database.runOperation("projection-prune", "operation-1", "b".repeat(64), async () => null)).rejects.toThrow(/reuse|conflict/i);

  database.database.query(`INSERT INTO workflow_operation_receipts
    (scope, operation_id, request_hash, state, claimed_at, updated_at, response_json, response_hash)
    VALUES (?, ?, ?, 'in_progress', ?, ?, NULL, NULL)`).run("journal-prune", "abandoned", "c".repeat(64), "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z");
  await expect(database.runOperation("journal-prune", "abandoned", "c".repeat(64), async () => ({ unsafe: true }))).rejects.toThrow(/unknown|recovery|in.progress/i);
  expect(database.database.query(`SELECT state FROM workflow_operation_receipts WHERE scope = ? AND operation_id = ?`).get("journal-prune", "abandoned")).toEqual({ state: "unknown" });
  database.close();
});

test("workflow operation leases heartbeat under an injected clock and coordinate the active in-process promise", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "pi-hive-workflow-heartbeat-")), "workflow.db");
  let clock = 0;
  const timers = new Map<symbol, () => void>();
  const database = openWorkflowProjectionDatabase({
    path,
    operationLimits: { leaseMs: 30_000, heartbeatMs: 10_000 },
    operationRuntime: {
      now: () => clock,
      setInterval(callback) { const id = Symbol("heartbeat"); timers.set(id, callback); return id; },
      clearInterval(timer) { timers.delete(timer as symbol); },
    },
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let invocations = 0;
  const first = database.runOperation("projection-rebuild", "long-running", "d".repeat(64), async () => { invocations += 1; await held; return { ok: true }; });
  clock = 31_000;
  for (const heartbeat of timers.values()) heartbeat();
  const duplicate = database.runOperation<{ ok: boolean }>("projection-rebuild", "long-running", "d".repeat(64), async () => { invocations += 1; return { ok: false }; });
  expect(database.database.query(`SELECT state, owner_token IS NOT NULL AS owned, lease_expires_at FROM workflow_operation_receipts WHERE operation_id = 'long-running'`).get()).toEqual({ state: "in_progress", owned: 1, lease_expires_at: "1970-01-01T00:01:01.000Z" });
  release();
  expect(await first).toEqual({ ok: true });
  expect(await duplicate).toEqual({ ok: true });
  expect(invocations).toBe(1);
  expect(timers.size).toBe(0);
  database.close();
});

test("workflow operation receipts enforce count, response-byte, retention, and unknown fail-closed bounds", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-workflow-receipt-bounds-"));
  let clock = 0;
  const path = join(root, "workflow.db");
  let database = openWorkflowProjectionDatabase({ path, operationLimits: { count: 2, retentionMs: 100 }, operationRuntime: { now: () => clock } });
  await database.runOperation("question", "old-a", "a".repeat(64), async () => ({ value: "a" }));
  await database.runOperation("question", "old-b", "b".repeat(64), async () => ({ value: "b" }));
  clock = 50;
  await expect(database.runOperation("question", "at-capacity", "c".repeat(64), async () => null)).rejects.toMatchObject({ code: "OPERATION_RECEIPT_CAPACITY" });
  clock = 200;
  expect(await database.runOperation("question", "after-retention", "d".repeat(64), async () => ({ retained: true }))).toEqual({ retained: true });
  expect(database.database.query(`SELECT COUNT(*) AS count FROM workflow_operation_receipts`).get()).toEqual({ count: 1 });
  database.close();

  database = openWorkflowProjectionDatabase({ path: join(root, "unknown.db"), operationLimits: { count: 1 }, operationRuntime: { now: () => clock } });
  await expect(database.runOperation("approval", "unknown", "e".repeat(64), async () => { throw new Error("side effect failed"); })).rejects.toThrow(/side effect failed/i);
  await expect(database.runOperation("approval", "new", "f".repeat(64), async () => null)).rejects.toMatchObject({ code: "OPERATION_RECEIPT_CAPACITY" });
  database.close();

  database = openWorkflowProjectionDatabase({ path: join(root, "bytes.db"), operationLimits: { responseBytes: 16, totalResponseBytes: 16 }, operationRuntime: { now: () => clock } });
  await expect(database.runOperation("knowledge", "too-large", "1".repeat(64), async () => ({ value: "response exceeds sixteen bytes" }))).rejects.toThrow(/bounded JSON/i);
  expect(database.database.query(`SELECT state FROM workflow_operation_receipts WHERE operation_id = 'too-large'`).get()).toEqual({ state: "unknown" });
  database.close();
});

test("atomic projection replacement hides partial rows from concurrent readers and rolls back a mid-rebuild failure", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pi-hive-workflow-atomic-rebuild-")), "workflow.db");
  const writer = openWorkflowProjectionDatabase({ path });
  const old = stream(1)[0];
  writer.ingest(old);
  const reader = openWorkflowProjectionDatabase({ path });
  const replacement = toWorkflowTelemetryEvent(sealWorkflowEvent(createWorkflowEvent({ eventId: "replacement", projectId: "project-new", sessionId: "session-new", runId: "run-new", type: "run.started", producer: "runtime", payload: { formatVersion: 1, status: "running" } }), 1, null), { workflowId: "new" });
  expect(() => writer.replaceProjectionAtomically(() => {
    writer.ingest(replacement);
    expect(reader.history({ limit: 10 }).items.map((event) => event.eventId)).toEqual([old.eventId]);
    throw new Error("injected mid-rebuild failure");
  })).toThrow(/injected mid-rebuild failure/i);
  expect(writer.history({ limit: 10 }).items.map((event) => event.eventId)).toEqual([old.eventId]);
  expect(reader.history({ limit: 10 }).items.map((event) => event.eventId)).toEqual([old.eventId]);
  writer.replaceProjectionAtomically(() => { writer.ingest(replacement); });
  expect(reader.history({ limit: 10 }).items.map((event) => event.eventId)).toEqual([replacement.eventId]);
  reader.close(); writer.close();
});

test("aggregate project and workflow rows choose the deterministic latest authoritative session", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pi-hive-workflow-aggregate-latest-")), "workflow.db");
  const database = openWorkflowProjectionDatabase({ path });
  const event = (sessionId: string, eventId: string, timestamp: string, status: string) => toWorkflowTelemetryEvent(sealWorkflowEvent(createWorkflowEvent({
    eventId, projectId: "project-aggregate", sessionId, runId: `run-${sessionId}`, type: "session.selected", producer: "runtime", timestamp,
    payload: { formatVersion: 1, workflowId: "delivery", status },
  }), 1, null), { projectRoot: "/project", workflowId: "delivery" });
  const oldest = event("session-a", "aggregate-old", "2026-01-01T00:00:01.000Z", "running");
  const newest = event("session-z", "aggregate-new", "2026-01-01T00:00:09.000Z", "completed");
  database.ingest(oldest);
  database.ingest(newest);
  expect(database.aggregateCurrentPage("projects", { limit: 10 }).items.map((row) => row.eventId)).toEqual([newest.eventId]);
  expect(database.aggregateCurrentPage("workflows", { limit: 10 }).items.map((row) => row.eventId)).toEqual([newest.eventId]);
  expect(database.aggregateCurrentPage("projects", { limit: 10, status: "running" }).items).toEqual([]);
  expect(database.aggregateCurrentPage("workflows", { limit: 10, status: "running" }).items).toEqual([]);
  expect(database.aggregateCurrentPage("projects", { limit: 10, status: "completed" }).items.map((row) => row.eventId)).toEqual([newest.eventId]);
  expect(database.aggregateCurrentPage("workflows", { limit: 10, status: "completed" }).items.map((row) => row.eventId)).toEqual([newest.eventId]);
  database.close();
});

test("workflow SSE catch-up validates retained cursors, preserves order, and requires bounded resync", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pi-hive-workflow-sse-history-")), "workflow.db");
  const database = openWorkflowProjectionDatabase({ path });
  const events = stream(4);
  for (const event of events) database.ingest(event);
  expect(database.streamCatchUp(encodeWorkflowHistoryCursor(events[0]), 2)).toEqual({ state: "resync-required", reason: "catch-up-limit-exceeded" });
  expect(database.streamCatchUp(encodeWorkflowHistoryCursor(events[1]), 2)).toEqual({ state: "ready", events: events.slice(2) });
  database.pruneProjection("2026-01-01T00:00:02.500Z");
  expect(database.streamCatchUp(encodeWorkflowHistoryCursor(events[0]), 2)).toEqual({ state: "resync-required", reason: "cursor-expired" });
  expect(database.streamCatchUp("not-a-cursor", 2)).toEqual({ state: "resync-required", reason: "cursor-invalid" });
  database.close();
});
