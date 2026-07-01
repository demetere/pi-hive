// Bun-only test for the plan-store SQLite layer (db.ts uses bun:sqlite). This
// is intentionally NOT part of the node `just test` suite (the core must load
// without Bun), so it is named *.bun-test.ts and run with `bun test` when the
// dashboard/DB layer changes:  bun test tests/plan-db.bun-test.ts
import { expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the DB at a throwaway file BEFORE importing db.ts (it opens DB_PATH at
// module load). config.ts reads HIVE_TELEMETRY_DB.
process.env.HIVE_TELEMETRY_DB = join(mkdtempSync(join(tmpdir(), "pi-hive-plandb-")), "telemetry.db");

let db: typeof import("../src/observability/server/db");

beforeAll(async () => {
  db = await import("../src/observability/server/db");
});

test("plan_verdicts persists red/yellow/green and latestVerdict returns the newest", () => {
  db.insertPlanVerdict({ id: "v1", changeId: "c1", reviewer: "Rev", verdict: "yellow", summary: "notes", concerns: ["x"], createdAt: "2026-07-01T10:00:00.000Z" });
  db.insertPlanVerdict({ id: "v2", changeId: "c1", reviewer: "Rev", verdict: "green", summary: "clean", evidence: ["ran tests"], createdAt: "2026-07-01T11:00:00.000Z" });
  db.insertPlanVerdict({ id: "v3", changeId: "c2", reviewer: "Rev", verdict: "red", summary: "blocked", blockers: ["authz"], createdAt: "2026-07-01T10:30:00.000Z" });

  const all = db.listVerdicts("c1");
  expect(all.length).toBe(2);
  expect(all[0].verdict).toBe("yellow");
  expect(all[0].concerns).toEqual(["x"]);

  const latest = db.latestVerdict("c1");
  expect(latest?.verdict).toBe("green");
  expect(latest?.evidence).toEqual(["ran tests"]);

  const c2 = db.latestVerdict("c2");
  expect(c2?.verdict).toBe("red");
  expect(c2?.blockers).toEqual(["authz"]);
});

test("insertPlanVerdict is idempotent on the same id (replay-safe)", () => {
  db.insertPlanVerdict({ id: "dup", changeId: "c3", reviewer: "Rev", verdict: "green", summary: "one", createdAt: "2026-07-01T10:00:00.000Z" });
  db.insertPlanVerdict({ id: "dup", changeId: "c3", reviewer: "Rev", verdict: "red", summary: "two", createdAt: "2026-07-01T10:00:00.000Z" });
  const all = db.listVerdicts("c3");
  expect(all.length).toBe(1);
  expect(all[0].verdict).toBe("green"); // first write wins (INSERT OR IGNORE)
});

test("plan_approvals and plan_comments round-trip", () => {
  db.insertPlanApproval({ id: "a1", changeId: "c1", phase: "proposal", approvedBy: "ui", actor: "demetre", createdAt: "2026-07-01T12:00:00.000Z" });
  db.insertPlanApproval({ id: "a2", changeId: "c1", phase: "design", approvedBy: "chat", createdAt: "2026-07-01T13:00:00.000Z" });
  const approvals = db.listApprovals("c1");
  expect(approvals.length).toBe(2);
  expect(approvals[0].phase).toBe("proposal");
  expect(approvals[1].approvedBy).toBe("chat");

  db.insertPlanComment({ id: "cm1", changeId: "c1", file: "design.md", anchor: "risks", author: "demetre", body: "reconsider retries", createdAt: "2026-07-01T14:00:00.000Z" });
  const comments = db.listComments("c1");
  expect(comments.length).toBe(1);
  expect(comments[0].file).toBe("design.md");
  expect(comments[0].body).toBe("reconsider retries");
});
