import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveProjectIdentity } from "../../src/shared/project-identity";

test("legacy overrides migrate to project IDs and duplicate basenames stay isolated", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-project-db-"));
  const firstRoot = join(root, "one", "service");
  const secondRoot = join(root, "two", "service");
  mkdirSync(firstRoot, { recursive: true });
  mkdirSync(secondRoot, { recursive: true });
  const first = resolveProjectIdentity(firstRoot, { gitRoot: () => undefined });
  const second = resolveProjectIdentity(secondRoot, { gitRoot: () => undefined });

  const dbFile = join(root, "telemetry.db");
  const legacy = new Database(dbFile);
  legacy.run(`CREATE TABLE project_overrides (cwd TEXT PRIMARY KEY, label TEXT NOT NULL, updated_at TEXT)`);
  legacy.query(`INSERT INTO project_overrides (cwd, label, updated_at) VALUES (?, ?, ?)`).run(firstRoot, "First service", "2026-07-01T00:00:00.000Z");
  legacy.close();

  const script = `
    const db = await import("./src/observability/server/db.ts");
    const runtime = await import("./src/observability/server/runtime.ts");
    const add = (sessionId, cwd) => {
      const event = { event_id: "event-" + sessionId, session_id: sessionId, seq: 1, ts: "2026-07-01T00:00:00.000Z", type: "session_start", actor: "System", pid: 1, cwd, payload: {} };
      db.insertEvent.run(db.dbEventRow(event));
      db.upsertSession.run(db.dbSessionRowFromEvent(event));
    };
    const migrated = db.listProjectOverrides();
    add("first-session", process.env.FIRST_ROOT);
    add("second-session", process.env.SECOND_ROOT);
    const before = runtime.sessionSummaries();
    const deleted = runtime.deleteProject(process.env.FIRST_ID);
    const after = runtime.sessionSummaries();
    db.setProjectOverride(process.env.SECOND_ID, process.env.SECOND_ROOT, "Second service", "2026-07-02T00:00:00.000Z");
    const secondLabel = db.listProjectOverrides().find((row) => row.projectId === process.env.SECOND_ID)?.label;
    db.clearProjectOverride(process.env.FIRST_ID);
    console.log(JSON.stringify({ migrated, before, deleted, after, secondLabel, firstOverrideRemaining: db.listProjectOverrides().some((row) => row.projectId === process.env.FIRST_ID) }));
  `;
  const child = spawnSync("bun", ["--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HIVE_TELEMETRY_DB: dbFile,
      HIVE_TELEMETRY_REGISTRY: join(root, "registry.jsonl"),
      FIRST_ROOT: firstRoot,
      SECOND_ROOT: secondRoot,
      FIRST_ID: first.projectId,
      SECOND_ID: second.projectId,
    },
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout.trim());

  expect(first.projectId).not.toBe(second.projectId);
  expect(first.displayLabel).toBe("service");
  expect(second.displayLabel).toBe("service");
  expect(result.migrated).toEqual([expect.objectContaining({ projectId: first.projectId, canonicalRoot: first.canonicalRoot, label: "First service" })]);
  expect(result.before.find((row: any) => row.session_id === "first-session")?.project_id).toBe(first.projectId);
  expect(result.before.find((row: any) => row.session_id === "second-session")?.project_id).toBe(second.projectId);
  expect(result.deleted).toBe(1);
  expect(result.after.some((row: any) => row.session_id === "first-session")).toBe(false);
  expect(result.after.some((row: any) => row.session_id === "second-session")).toBe(true);
  expect(result.secondLabel).toBe("Second service");
  expect(result.firstOverrideRemaining).toBe(false);
});
