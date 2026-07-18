import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, renameSync, truncateSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_TELEMETRY_DB ||= join(mkdtempSync(join(tmpdir(), "pi-hive-ingest-db-")), "telemetry.db");

let runtime: typeof import("../../src/observability/server/runtime");
let database: typeof import("../../src/observability/server/db");

beforeAll(async () => {
  database = await import("../../src/observability/server/db");
  runtime = await import("../../src/observability/server/runtime");
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

function telemetryEvent(id: string, session: string, seq: number, type: string, payload: Record<string, unknown>) {
  return JSON.stringify({
    event_id: id,
    session_id: session,
    seq,
    ts: `2026-07-14T01:00:${String(seq).padStart(2, "0")}.000Z`,
    type,
    actor: type === "orchestrator_message" ? "Orchestrator" : "Builder",
    pid: 1,
    payload,
  });
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

test("SQL usage totals add worker deltas and orchestrator messages without snapshot regressions", () => {
  const { file } = source("usage-totals");
  const session = "usage-authoritative";
  const rows = [
    telemetryEvent("ua-1", session, 1, "delegation_end", {
      delegationsSchema: 1,
      from: "Builder",
      delta: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 8, costUsd: 0.1 },
    }),
    telemetryEvent("ua-2", session, 2, "orchestrator_message", {
      model: "test/large",
      usage: { input: 30, output: 10, cacheRead: 4, cacheWrite: 2, reasoning: 3, cost: 0.03 },
    }),
    // A model switch and a legacy cumulative row are not additive usage.
    telemetryEvent("ua-3", session, 3, "model_select", { model: "test/small", previousModel: "test/large" }),
    telemetryEvent("ua-4", session, 4, "delegation_end", {
      from: "Builder",
      runtime: { inputTokens: 9999, outputTokens: 9999, costUsd: 99 },
    }),
  ];
  writeFileSync(file, `${rows.join("\n")}\n`);

  runtime.addSource(file, { session_id: session });
  let summary = runtime.sessionSummaries().find((row) => row.session_id === session)!;
  expect(summary.tokens).toBe(180);
  expect(summary.cacheReadTokens).toBe(24);
  expect(summary.cacheWriteTokens).toBe(7);
  expect(summary.reasoningTokens).toBe(11);
  expect(summary.cost).toBeCloseTo(0.13);
  expect(summary.usageStatus).toBe("verified");

  // Snapshot metadata updates used to overwrite historical totals with whichever
  // active runtime counters happened to be present. A smaller or larger live
  // snapshot must now leave the SQL event projection untouched.
  database.updateSessionStats.run({
    $session_id: session,
    $topology_hash: null,
    $updated_at: "2026-07-14T01:01:00.000Z",
    $project_id: null,
    $canonical_root: null,
    $cwd: null,
    $session_dir: null,
    $telemetry_log: file,
  });
  summary = runtime.sessionSummaries().find((row) => row.session_id === session)!;
  expect(summary.tokens).toBe(180);
  expect(summary.cost).toBeCloseTo(0.13);

  // Re-reading the same source is idempotent at both event and usage-ledger level.
  runtime.readSource(file);
  summary = runtime.sessionSummaries().find((row) => row.session_id === session)!;
  expect(summary.tokens).toBe(180);
  expect(summary.cost).toBeCloseTo(0.13);
});

test("legacy usage migration preserves an unverified floor and backfills known rows", () => {
  const legacyDb = join(mkdtempSync(join(tmpdir(), "pi-hive-legacy-usage-")), "telemetry.db");
  const env = { ...process.env, HIVE_TELEMETRY_DB: legacyDb };
  const seed = Bun.spawnSync(["bun", "-e", `
    const m = await import("./src/observability/server/db.ts");
    m.db.run(\`INSERT INTO sessions (session_id, first_ts, last_ts, event_count, input_tokens, output_tokens, cost_usd)
      VALUES ('legacy-usage', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.000Z', 2, 900, 100, 1.5)\`);
    const insert = m.db.query(\`INSERT INTO events
      (event_id, session_id, seq, ts, type, actor, pid, payload_json)
      VALUES ($id, 'legacy-usage', $seq, $ts, $type, 'test', 1, jsonb($payload))\`);
    insert.run({ $id: 'legacy-delta', $seq: 1, $ts: '2026-01-01T00:00:01.000Z', $type: 'delegation_end',
      $payload: JSON.stringify({ delegationsSchema: 1, delta: { inputTokens: 120, outputTokens: 30, costUsd: 0.2 } }) });
    insert.run({ $id: 'legacy-orch', $seq: 2, $ts: '2026-01-01T00:00:02.000Z', $type: 'orchestrator_message',
      $payload: JSON.stringify({ usage: { input: 10, output: 5, cost: 0.01 } }) });
    m.db.run(\`DELETE FROM usage_events\`);
    m.db.run(\`DELETE FROM schema_metadata WHERE key = 'usage_projection_v1'\`);
    m.db.close();
  `], { cwd: process.cwd(), env });
  expect(seed.exitCode).toBe(0);

  const migrate = Bun.spawnSync(["bun", "-e", `
    const m = await import("./src/observability/server/db.ts");
    console.log(JSON.stringify(m.querySessionSummaries().find((row) => row.session_id === 'legacy-usage')));
    m.db.close();
  `], { cwd: process.cwd(), env });
  expect(migrate.exitCode).toBe(0);
  const row = JSON.parse(migrate.stdout.toString().trim());
  // The old snapshot floor (1000 total tokens / $1.50) is larger than the 165
  // known event-derived tokens / $0.21. Keep it without pretending its overlap
  // is verifiable; post-cutover events will add to this floor exactly once.
  expect(row.input_tokens + row.output_tokens).toBe(1000);
  expect(row.cost_usd).toBe(1.5);
  expect(row.usage_status).toBe("legacy-unverified");
});

test("usage totals remain monotonic across fresh runs and reload-style events", () => {
  const { file } = source("usage-monotonic");
  const session = "usage-monotonic";
  const first = telemetryEvent("um-1", session, 1, "delegation_end", {
    delegationsSchema: 1,
    from: "Builder",
    delta: { inputTokens: 500, outputTokens: 200, costUsd: 0.5 },
  });
  writeFileSync(file, `${first}\n`);
  runtime.addSource(file, { session_id: session });
  expect(runtime.sessionSummaries().find((row) => row.session_id === session)?.tokens).toBe(700);

  appendFileSync(file, `${telemetryEvent("um-2", session, 2, "session_start", { mode: "planning" })}\n`);
  appendFileSync(file, `${telemetryEvent("um-3", session, 3, "delegation_end", {
    delegationsSchema: 1,
    from: "Builder",
    // Fresh run session stats are smaller than the prior run, but the emitted
    // delta is this run's own additive consumption.
    delta: { inputTokens: 80, outputTokens: 30, costUsd: 0.08 },
  })}\n`);
  runtime.readSource(file);
  const summary = runtime.sessionSummaries().find((row) => row.session_id === session)!;
  expect(summary.tokens).toBe(810);
  expect(summary.cost).toBeCloseTo(0.58);
});

test("explicit prune rebuilds totals from retained usage rows", () => {
  const { file } = source("usage-prune");
  const session = "usage-prune";
  const oldRow = JSON.parse(telemetryEvent("up-1", session, 1, "delegation_end", {
    delegationsSchema: 1,
    from: "Builder",
    delta: { inputTokens: 100, outputTokens: 20, costUsd: 0.1 },
  }));
  oldRow.ts = "2026-07-13T00:00:00.000Z";
  const keptRow = JSON.parse(telemetryEvent("up-2", session, 2, "orchestrator_message", {
    usage: { input: 7, output: 3, cost: 0.01 },
  }));
  keptRow.ts = "2026-07-15T00:00:00.000Z";
  writeFileSync(file, `${JSON.stringify(oldRow)}\n${JSON.stringify(keptRow)}\n`);
  runtime.addSource(file, { session_id: session });
  expect(runtime.sessionSummaries().find((row) => row.session_id === session)?.tokens).toBe(130);

  database.pruneOlderThan("2026-07-14T00:00:00.000Z");
  const summary = runtime.sessionSummaries().find((row) => row.session_id === session)!;
  expect(summary.tokens).toBe(10);
  expect(summary.cost).toBeCloseTo(0.01);
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
