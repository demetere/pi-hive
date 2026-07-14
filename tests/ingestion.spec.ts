import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, renameSync, truncateSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_TELEMETRY_DB ||= join(mkdtempSync(join(tmpdir(), "pi-hive-ingest-db-")), "telemetry.db");

let runtime: typeof import("../src/observability/server/runtime");
let database: typeof import("../src/observability/server/db");

beforeAll(async () => {
  database = await import("../src/observability/server/db");
  runtime = await import("../src/observability/server/runtime");
});

function event(id: string, session: string, seq: number, text = id) {
  return JSON.stringify({
    event_id: id,
    session_id: session,
    seq,
    ts: `2026-07-14T00:00:${String(seq).padStart(2, "0")}.000Z`,
    type: "user_message",
    actor: "User",
    pid: 1,
    payload: { text },
  });
}

function source(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `pi-hive-ingest-${name}-`));
  return { dir, file: join(dir, "hive-events.jsonl") };
}

test("runtime ingests complete lines exactly once and retains partial tail across reads", () => {
  const { file } = source("partial");
  const session = "ingest-partial";
  const first = event("ip-1", session, 1, "héllo 🐝");
  const second = event("ip-2", session, 2);
  const split = Math.floor(Buffer.byteLength(second) / 2);
  const secondBytes = Buffer.from(second);
  writeFileSync(file, Buffer.concat([Buffer.from(`${first}\n`), secondBytes.subarray(0, split)]));

  runtime.addSource(file, { session_id: session });
  expect(runtime.queryEvents({ session }).map((row) => row.event_id)).toEqual(["ip-1"]);
  let health = runtime.ingestionHealth().sources.find((row) => row.path === file)!;
  expect(health.pending_tail_bytes).toBe(split);
  expect(health.source_lag_bytes).toBe(split);

  appendFileSync(file, Buffer.concat([secondBytes.subarray(split), Buffer.from("\n")]));
  runtime.readSource(file);
  expect(runtime.queryEvents({ session }).map((row) => row.event_id)).toEqual(["ip-1", "ip-2"]);
  runtime.readSource(file);
  expect(runtime.queryEvents({ session }).map((row) => row.event_id)).toEqual(["ip-1", "ip-2"]);
  health = runtime.ingestionHealth().sources.find((row) => row.path === file)!;
  expect(health.pending_tail_bytes).toBe(0);
  expect(health.source_lag_bytes).toBe(0);
  expect(health.last_successful_ingest).toBeTruthy();
});

test("runtime advances past corrupt complete lines and reports ingestion health", () => {
  const { file } = source("corrupt");
  const session = "ingest-corrupt";
  writeFileSync(file, `{not-json}\n${event("ic-1", session, 1)}\npartial`);

  runtime.addSource(file, { session_id: session });
  expect(runtime.queryEvents({ session }).map((row) => row.event_id)).toEqual(["ic-1"]);
  const health = runtime.ingestionHealth().sources.find((row) => row.path === file)!;
  expect(health.corrupt_lines).toBe(1);
  expect(health.pending_tail_bytes).toBe(Buffer.byteLength("partial"));
});

test("event insertion and complete-line offset advancement roll back together", () => {
  const { file } = source("transaction");
  const session = "ingest-transaction";
  writeFileSync(file, `${event("itx-1", session, 1)}\n`);
  database.db.run(`CREATE TRIGGER fail_itx BEFORE INSERT ON events WHEN NEW.event_id = 'itx-1' BEGIN SELECT RAISE(ABORT, 'forced ingest failure'); END`);
  try {
    runtime.addSource(file, { session_id: session });
    expect(runtime.queryEvents({ session }).length).toBe(0);
    expect(database.getIngestOffset(file)).toBe(0);
  } finally {
    database.db.run("DROP TRIGGER IF EXISTS fail_itx");
  }

  runtime.readSource(file);
  expect(runtime.queryEvents({ session }).map((row) => row.event_id)).toEqual(["itx-1"]);
  expect(database.getIngestOffset(file)).toBe(Buffer.byteLength(`${event("itx-1", session, 1)}\n`));
});

test("runtime resets safely on truncation and same-path rotation; duplicate replay stays idempotent", () => {
  const { dir, file } = source("rotate");
  const session = "ingest-rotate";
  writeFileSync(file, `${event("ir-1", session, 1, "first-long-record")}\n`);
  runtime.addSource(file, { session_id: session });
  expect(runtime.queryEvents({ session }).map((row) => row.event_id)).toEqual(["ir-1"]);

  // Truncate and rewrite the same inode between polls, growing it beyond the
  // prior offset. The persisted checkpoint (not size alone) detects replacement.
  truncateSync(file, 0);
  writeFileSync(file, `${event("ir-2", session, 2, "x".repeat(500))}\n`);
  runtime.readSource(file);
  expect(runtime.queryEvents({ session }).map((row) => row.event_id).sort()).toEqual(["ir-1", "ir-2"]);

  // Rotate to a new inode at the same path. Replay one duplicate plus one fresh
  // event: the identity reset reads both, while event_id uniqueness stores each
  // logical event exactly once.
  renameSync(file, join(dir, "hive-events.old.jsonl"));
  writeFileSync(file, `${event("ir-2", session, 2, "x".repeat(500))}\n${event("ir-3", session, 3)}\n`);
  runtime.readSource(file);
  expect(runtime.queryEvents({ session }).map((row) => row.event_id).sort()).toEqual(["ir-1", "ir-2", "ir-3"]);
});
