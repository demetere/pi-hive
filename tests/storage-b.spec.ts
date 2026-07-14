// Bun-only tests for Phase B: SQLite as the source of truth. Exercises the
// typed projections, cursor pagination, ingest offsets, project-scoped plan
// reads, and prune — all against a throwaway DB. Run: bun test tests/storage-b.spec.ts
import { expect, test, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB_FILE = join(mkdtempSync(join(tmpdir(), "pi-hive-storeb-")), "telemetry.db");
process.env.HIVE_TELEMETRY_DB = DB_FILE;

let db: typeof import("../src/observability/server/db");

beforeAll(async () => {
  db = await import("../src/observability/server/db");
});

function insertEvent(row: any) {
  return db.insertEvent.run(db.dbEventRow(row));
}

test("events are cursor-ordered and paginate by rowid (B5)", () => {
  for (let i = 0; i < 5; i++) {
    const res = insertEvent({ event_id: `e${i}`, session_id: "s1", seq: i, ts: `2026-07-01T00:00:0${i}.000Z`, type: "user_message", actor: "User", pid: 1, cwd: "/proj", payload: { text: `m${i}` } });
    expect(res.changes).toBe(1);
  }
  // Duplicate event_id is ignored (idempotent replay backstop).
  expect(insertEvent({ event_id: "e0", session_id: "s1", seq: 0, ts: "2026-07-01T00:00:00.000Z", type: "user_message", actor: "User", pid: 1, cwd: "/proj", payload: {} }).changes).toBe(0);

  const first = db.recentEvents(3, { session: "s1" });
  expect(first.length).toBe(3);
  // recentEvents returns the newest N re-sorted ascending.
  expect(first[first.length - 1].event_id).toBe("e4");

  const afterTwo = db.queryEvents({ session: "s1", after: first[0].cursor - 1, limit: 100 });
  expect(afterTwo.every((e) => e.cursor >= first[0].cursor)).toBe(true);
  expect(db.maxEventCursor()).toBeGreaterThanOrEqual(5);
});

test("delegations projection: start inserts, end completes the row (B3)", () => {
  db.materializeDelegationStart({ eventId: "d-start", sessionId: "s1", cwd: "/proj", agent: "Coder", parent: "Orchestrator", startedAt: "2026-07-01T01:00:00.000Z", model: "anthropic/x" });
  db.materializeDelegationEnd({
    eventId: "d-end", sessionId: "s1", cwd: "/proj", agent: "Coder", parent: "Orchestrator", endedAt: "2026-07-01T01:05:00.000Z", durationMs: 300000,
    inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 5, costUsd: 0.02, schemaVersion: 1, status: "done", stopReason: "toolUse", model: "anthropic/x",
  });
  const rows = db.queryDelegations({ session: "s1" });
  expect(rows.length).toBe(1);
  expect(rows[0].agent).toBe("Coder");
  expect(rows[0].startedAt).toBe("2026-07-01T01:00:00.000Z");
  expect(rows[0].endedAt).toBe("2026-07-01T01:05:00.000Z");
  expect(rows[0].inputTokens).toBe(100);
  expect(rows[0].cacheReadTokens).toBe(900);
  expect(rows[0].stopReason).toBe("toolUse");
  // The delta-schema marker round-trips so aggregation can exclude legacy rows.
  expect(rows[0].schemaVersion).toBe(1);
});

test("legacy cumulative delegation rows are marked schema_version 0 (Decision 1)", () => {
  // A row materialized WITHOUT schemaVersion:1 is legacy cumulative; a
  // deltasOnly aggregation must be able to exclude it so lifetime totals are
  // never summed with per-run deltas.
  db.materializeDelegationStart({ eventId: "legacy-s", sessionId: "sLegacy", cwd: "/legacy", agent: "Coder", parent: "Orchestrator", startedAt: "2026-07-01T06:00:00.000Z", model: "anthropic/x" });
  db.materializeDelegationEnd({
    eventId: "legacy-e", sessionId: "sLegacy", cwd: "/legacy", agent: "Coder", parent: "Orchestrator", endedAt: "2026-07-01T06:05:00.000Z", durationMs: 300000,
    inputTokens: 999, outputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 9.99, schemaVersion: 0, status: "done", stopReason: "toolUse", model: "anthropic/x",
  });
  const all = db.queryDelegations({ session: "sLegacy" });
  expect(all.length).toBe(1);
  expect(all[0].schemaVersion).toBe(0);
  const deltas = db.queryDelegations({ session: "sLegacy", deltasOnly: true });
  expect(deltas.length).toBe(0);
});

test("tool_calls projection pairs start/end by tool_call_id (B3)", () => {
  db.materializeToolStart({ eventId: "t-start", sessionId: "s1", cwd: "/proj", agent: "Coder", toolName: "read_file", toolCallId: "tc1", argsPreview: "{...}", startedAt: "2026-07-01T01:01:00.000Z" });
  db.materializeToolEnd({ sessionId: "s1", toolCallId: "tc1", resultPreview: "ok", isError: false, endedAt: "2026-07-01T01:01:02.000Z", durationMs: 2000 });
  const calls = db.queryToolCalls({ session: "s1" });
  const tc = calls.find((c) => c.toolCallId === "tc1")!;
  expect(tc.toolName).toBe("read_file");
  expect(tc.resultPreview).toBe("ok");
  expect(tc.durationMs).toBe(2000);
  expect(tc.isError).toBe(false);
});

test("queryDelegations/queryToolCalls honor the after cursor (I1)", () => {
  // Fresh session so pagination is deterministic and disjoint.
  for (let i = 0; i < 3; i++) {
    db.materializeDelegationStart({ eventId: `dp-s-${i}`, sessionId: "sPag", cwd: "/pag", agent: `A${i}`, parent: "Orchestrator", startedAt: `2026-07-01T05:0${i}:00.000Z`, model: "anthropic/x" });
    db.materializeDelegationEnd({
      eventId: `dp-e-${i}`, sessionId: "sPag", cwd: "/pag", agent: `A${i}`, parent: "Orchestrator", endedAt: `2026-07-01T05:0${i}:30.000Z`, durationMs: 30000,
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, schemaVersion: 1, status: "done", stopReason: "toolUse", model: "anthropic/x",
    });
    db.materializeToolStart({ eventId: `tp-s-${i}`, sessionId: "sPag", cwd: "/pag", agent: `A${i}`, toolName: "read_file", toolCallId: `tcp${i}`, argsPreview: "{}", startedAt: `2026-07-01T05:0${i}:10.000Z` });
    db.materializeToolEnd({ sessionId: "sPag", toolCallId: `tcp${i}`, resultPreview: "ok", isError: false, endedAt: `2026-07-01T05:0${i}:12.000Z`, durationMs: 2000 });
  }
  // Delegations: page 1 (limit 2), then page 2 with after=<last cursor> — disjoint.
  const dPage1 = db.queryDelegations({ session: "sPag", limit: 2 });
  expect(dPage1.length).toBe(2);
  const dPage2 = db.queryDelegations({ session: "sPag", after: dPage1[dPage1.length - 1].cursor, limit: 2 });
  // Page 2 must be NON-EMPTY (M8f): the 3rd row. An over-filtering regression that
  // returned nothing after the cursor would otherwise pass every-cursor vacuously.
  expect(dPage2.length).toBe(1);
  expect(dPage2.every((r) => r.cursor > dPage1[dPage1.length - 1].cursor)).toBe(true);
  const dOverlap = dPage1.filter((a) => dPage2.some((b) => b.cursor === a.cursor));
  expect(dOverlap.length).toBe(0);
  // Tool calls: same disjoint-page contract (the correct template I1 mirrors).
  const tPage1 = db.queryToolCalls({ session: "sPag", limit: 2 });
  expect(tPage1.length).toBe(2);
  const tPage2 = db.queryToolCalls({ session: "sPag", after: tPage1[tPage1.length - 1].cursor, limit: 2 });
  expect(tPage2.length).toBe(1);
  expect(tPage2.every((r) => r.cursor > tPage1[tPage1.length - 1].cursor)).toBe(true);
});

test("session stats update sums (never Math.max) and is SQL-readable (B2)", () => {
  db.upsertSession.run(db.dbSessionRowFromEvent({ event_id: "x", session_id: "s2", ts: "2026-07-01T02:00:00.000Z", cwd: "/proj2", type: "session_start", actor: "System", pid: 1, payload: {} }));
  db.updateSessionStats.run({
    $session_id: "s2", $input_tokens: 300, $output_tokens: 80, $cache_read_tokens: 400, $cache_write_tokens: 10,
    $cost_usd: 0.08, $topology_hash: "hash123", $updated_at: "2026-07-01T02:10:00.000Z", $project_id: null, $canonical_root: null, $cwd: "/proj2", $session_dir: null, $telemetry_log: null,
  });
  const summary = db.querySessionSummaries().find((s) => s.session_id === "s2")!;
  expect(summary.input_tokens).toBe(300);
  expect(summary.output_tokens).toBe(80);
  expect(summary.cache_read_tokens).toBe(400);
  expect(summary.cost_usd).toBeCloseTo(0.08);
  expect(summary.topology_hash).toBe("hash123");
});

test("plan comments are project-scoped by cwd; NULL cwd stays visible (B1)", () => {
  db.insertPlanComment({ id: "pc-a", changeId: "shared-slug", author: "a", body: "in project A", cwd: "/projA", createdAt: "2026-07-01T03:00:00.000Z" });
  db.insertPlanComment({ id: "pc-b", changeId: "shared-slug", author: "b", body: "in project B", cwd: "/projB", createdAt: "2026-07-01T03:01:00.000Z" });
  db.insertPlanComment({ id: "pc-legacy", changeId: "shared-slug", author: "c", body: "legacy no cwd", createdAt: "2026-07-01T03:02:00.000Z" });

  const a = db.listComments("shared-slug", "/projA");
  // project A sees its own comment + the legacy (NULL cwd) one, not project B's.
  expect(a.map((c) => c.id).sort()).toEqual(["pc-a", "pc-legacy"]);
  const b = db.listComments("shared-slug", "/projB");
  expect(b.map((c) => c.id).sort()).toEqual(["pc-b", "pc-legacy"]);
  // Unscoped read sees all three (legacy cross-project behavior).
  expect(db.listComments("shared-slug").length).toBe(3);
});

test("ingest offsets persist and resume (B4)", () => {
  expect(db.getIngestOffset("/tmp/does-not-exist.jsonl")).toBe(0);
  db.setIngestOffset("/tmp/log.jsonl", 4096, "s1", "2026-07-01T04:00:00.000Z");
  expect(db.getIngestOffset("/tmp/log.jsonl")).toBe(4096);
  db.setIngestOffset("/tmp/log.jsonl", 8192, "s1", "2026-07-01T04:01:00.000Z");
  expect(db.getIngestOffset("/tmp/log.jsonl")).toBe(8192);
});

test("plan-table cwd is backfilled from the owning session (J2)", () => {
  // Legacy row: has a session_id but NULL cwd (written before B1's cwd column).
  db.upsertSession.run(db.dbSessionRowFromEvent({ event_id: "bf", session_id: "bf-sess", ts: "2026-07-01T06:00:00.000Z", cwd: "/backfilled", type: "session_start", actor: "System", pid: 1, payload: {} }));
  db.insertPlanComment({ id: "pc-legacy2", changeId: "bf-change", author: "a", body: "legacy row", sessionId: "bf-sess", createdAt: "2026-07-01T06:01:00.000Z" });
  // Orphan row: session_id points nowhere — must stay NULL (wildcard-visible).
  db.insertPlanComment({ id: "pc-orphan", changeId: "bf-change", author: "b", body: "orphan row", sessionId: "no-such-sess", createdAt: "2026-07-01T06:02:00.000Z" });
  // Before backfill the legacy row has NULL cwd, so it leaks into an UNRELATED
  // project's scoped read via the NULL-wildcard — the exact cross-project bleed
  // the backfill fixes.
  expect(db.listComments("bf-change", "/other").some((c) => c.id === "pc-legacy2")).toBe(true);

  db.backfillPlanCwd();

  // After backfill the legacy row is scoped to its session's cwd: it no longer
  // leaks into /other, but is visible under /backfilled. The orphan keeps NULL
  // cwd and stays wildcard-visible everywhere.
  expect(db.listComments("bf-change", "/other").some((c) => c.id === "pc-legacy2")).toBe(false);
  const scoped = db.listComments("bf-change", "/backfilled");
  expect(scoped.some((c) => c.id === "pc-legacy2")).toBe(true);
  expect(scoped.some((c) => c.id === "pc-orphan")).toBe(true); // NULL-wildcard still applies
  expect(db.listComments("bf-change", "/other").some((c) => c.id === "pc-orphan")).toBe(true);
  // Idempotent: a second backfill changes nothing.
  db.backfillPlanCwd();
  expect(db.listComments("bf-change", "/backfilled").filter((c) => c.id === "pc-legacy2").length).toBe(1);
});

test("prune removes sessions fully older than the cutoff and shrinks projections (B6/J1)", () => {
  db.upsertSession.run(db.dbSessionRowFromEvent({ event_id: "old", session_id: "old-sess", ts: "2020-01-01T00:00:00.000Z", cwd: "/old", type: "session_start", actor: "System", pid: 1, payload: {} }));
  insertEvent({ event_id: "old-ev", session_id: "old-sess", seq: 0, ts: "2020-01-01T00:00:00.000Z", type: "user_message", actor: "User", pid: 1, cwd: "/old", payload: {} });
  // Populate every projection with pre-cutoff rows so we can assert they shrink.
  db.materializeDelegationStart({ eventId: "old-d-s", sessionId: "old-sess", cwd: "/old", agent: "Coder", parent: "Orchestrator", startedAt: "2020-01-01T00:00:00.000Z", model: "anthropic/x" });
  db.materializeDelegationEnd({ eventId: "old-d-e", sessionId: "old-sess", cwd: "/old", agent: "Coder", parent: "Orchestrator", endedAt: "2020-01-01T00:01:00.000Z", durationMs: 60000, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, schemaVersion: 1, status: "done", stopReason: "toolUse", model: "anthropic/x" });
  db.materializeToolStart({ eventId: "old-t-s", sessionId: "old-sess", cwd: "/old", agent: "Coder", toolName: "read_file", toolCallId: "old-tc", argsPreview: "{}", startedAt: "2020-01-01T00:00:30.000Z" });
  db.materializeToolEnd({ sessionId: "old-sess", toolCallId: "old-tc", resultPreview: "ok", isError: false, endedAt: "2020-01-01T00:00:32.000Z", durationMs: 2000 });
  expect(db.querySessionSummaries().some((s) => s.session_id === "old-sess")).toBe(true);
  expect(db.queryDelegations({ session: "old-sess" }).length).toBe(1);
  expect(db.queryToolCalls({ session: "old-sess" }).length).toBe(1);

  const result = db.pruneOlderThan("2021-01-01T00:00:00.000Z");
  expect(result.sessions).toBeGreaterThanOrEqual(1);
  expect(result.sessionIds).toContain("old-sess");
  expect(db.querySessionSummaries().some((s) => s.session_id === "old-sess")).toBe(false);
  // All projections for the pruned session are gone (M8e).
  expect(db.queryDelegations({ session: "old-sess" }).length).toBe(0);
  expect(db.queryToolCalls({ session: "old-sess" }).length).toBe(0);
});

test("cursors are stable and gapless across a DB reopen (L5)", () => {
  // Write a run of events through the live handle, capturing their cursors.
  const written: number[] = [];
  for (let i = 0; i < 8; i++) {
    insertEvent({ event_id: `l5-${i}`, session_id: "l5-sess", seq: i, ts: `2026-07-01T09:00:0${i}.000Z`, type: "user_message", actor: "User", pid: 1, cwd: "/l5", payload: { text: `m${i}` } });
  }
  const beforeClose = db.queryEvents({ session: "l5-sess", after: 0, limit: 100 });
  for (const e of beforeClose) written.push(e.cursor);
  expect(written.length).toBe(8);
  // Strictly increasing cursors, no duplicates.
  for (let i = 1; i < written.length; i++) expect(written[i]).toBeGreaterThan(written[i - 1]);

  // Reopen the SAME file with a fresh handle (simulates a daemon restart). rowid
  // — the cursor — is durable in SQLite, so pagination must continue from where
  // it left off with no holes or duplicates. Checkpoint the WAL first so the
  // fresh connection sees every committed write (WAL is per-connection until a
  // checkpoint flushes it into the main db file).
  db.db.run("PRAGMA wal_checkpoint(FULL)");
  // Use the path the shared db module ACTUALLY opened, not this spec's env value:
  // when all specs run in one process, whichever spec's HIVE_TELEMETRY_DB was set
  // before db.ts first imported wins, so db.db.filename is the source of truth.
  const reopened = new Database((db.db as any).filename || DB_FILE);
  const rows = reopened.query(`SELECT rowid AS cursor, event_id FROM events WHERE session_id = 'l5-sess' ORDER BY rowid ASC`).all() as any[];
  const reCursors = rows.map((r) => Number(r.cursor));
  expect(reCursors).toEqual(written); // identical cursors after reopen

  // Paginating with an `after` cursor on the reopened DB returns disjoint pages
  // that reassemble to the full set with no gaps.
  const mid = written[3];
  const page = reopened.query(`SELECT rowid AS cursor FROM events WHERE session_id = 'l5-sess' AND rowid > ? ORDER BY rowid ASC`).all(mid) as any[];
  expect(page.map((r) => Number(r.cursor))).toEqual(written.slice(4));
  reopened.close();

  // The live handle keeps assigning higher cursors after the reopen — no reset.
  insertEvent({ event_id: "l5-post", session_id: "l5-sess", seq: 8, ts: "2026-07-01T09:00:08.000Z", type: "user_message", actor: "User", pid: 1, cwd: "/l5", payload: {} });
  const after = db.queryEvents({ session: "l5-sess", after: written[written.length - 1], limit: 10 });
  expect(after.length).toBe(1);
  expect(after[0].cursor).toBeGreaterThan(written[written.length - 1]);
});

test("storageBreakdown scopes by cwd and previews prune remove/keep split", () => {
  // Two cwds; one old (pre-cutoff), one new (post-cutoff). Distinct session ids.
  db.upsertSession.run(db.dbSessionRowFromEvent({ event_id: "sb-o", session_id: "sb-old", ts: "2020-01-01T00:00:00.000Z", cwd: "/sb", type: "session_start", actor: "System", pid: 1, payload: {} }));
  db.upsertSession.run(db.dbSessionRowFromEvent({ event_id: "sb-n", session_id: "sb-new", ts: "2030-01-01T00:00:00.000Z", cwd: "/sb", type: "session_start", actor: "System", pid: 1, payload: {} }));
  db.upsertSession.run(db.dbSessionRowFromEvent({ event_id: "sb-x", session_id: "sb-other", ts: "2030-01-01T00:00:00.000Z", cwd: "/other", type: "session_start", actor: "System", pid: 1, payload: {} }));
  insertEvent({ event_id: "sb-e-old", session_id: "sb-old", seq: 0, ts: "2020-01-01T00:00:00.000Z", type: "user_message", actor: "User", pid: 1, cwd: "/sb", payload: { text: "old-in-scope" } });
  insertEvent({ event_id: "sb-e-new", session_id: "sb-new", seq: 0, ts: "2030-01-01T00:00:00.000Z", type: "user_message", actor: "User", pid: 1, cwd: "/sb", payload: { text: "new-in-scope" } });
  insertEvent({ event_id: "sb-e-other", session_id: "sb-other", seq: 0, ts: "2030-01-01T00:00:00.000Z", type: "user_message", actor: "User", pid: 1, cwd: "/other", payload: { text: "out-of-scope" } });

  const cutoff = "2025-01-01T00:00:00.000Z";
  const scoped = db.storageBreakdown(["/sb"], cutoff);
  // Only the two /sb events count — the /other event is excluded by scope.
  expect(scoped.events).toBe(2);
  expect(scoped.sessions).toBe(2);
  expect(scoped.bytes).toBeGreaterThan(0);
  // Prune preview: exactly the one pre-cutoff event/session is removed; the rest kept.
  expect(scoped.prune!.removeEvents).toBe(1);
  expect(scoped.prune!.removeSessions).toBe(1);
  expect(scoped.prune!.keepEvents).toBe(1);
  expect(scoped.prune!.removeBytes).toBeGreaterThan(0);
  // Remove + keep bytes reconcile to the total (no double counting).
  expect(scoped.prune!.removeBytes + scoped.prune!.keepBytes).toBe(scoped.bytes);

  // Whole-DB (no cwd) sees strictly more events than the /sb-scoped view.
  const whole = db.storageBreakdown(undefined, cutoff);
  expect(whole.events).toBeGreaterThan(scoped.events);
});
