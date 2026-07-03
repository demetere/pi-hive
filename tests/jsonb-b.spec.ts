// Bun-only tests for Workstream B: JSONB storage migration. Verifies that new
// rows store JSONB BLOBs, that legacy TEXT-JSON rows still read via json(), and
// that both coexist and round-trip. Run: bun test tests/jsonb-b.spec.ts
import { expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_TELEMETRY_DB = join(mkdtempSync(join(tmpdir(), "pi-hive-jsonb-")), "telemetry.db");

let db: typeof import("../src/observability/server/db");

beforeAll(async () => {
  db = await import("../src/observability/server/db");
});

function storageType(sql: string, params: any = {}): string {
  const row = db.db.query(sql).get(params) as any;
  return row?.t;
}

test("event payloads store as JSONB BLOB and read back as parsed JSON", () => {
  db.insertEvent.run(db.dbEventRow({
    event_id: "jb-e1", session_id: "jb", seq: 0, ts: "2026-07-03T00:00:00.000Z",
    type: "user_message", actor: "User", pid: 1, cwd: "/jb", payload: { text: "hello", n: 42 },
  }));
  // Storage is a BLOB (jsonb encoding), not TEXT.
  expect(storageType(`SELECT typeof(payload_json) AS t FROM events WHERE event_id = 'jb-e1'`)).toBe("blob");
  // Reads decode to the original object via json() → JSON.parse.
  const ev = db.recentEvents(1, { session: "jb" })[0];
  expect((ev.payload as any).text).toBe("hello");
  expect((ev.payload as any).n).toBe(42);
});

test("legacy TEXT-JSON event rows still read via json()", () => {
  // Simulate a pre-migration row: write TEXT JSON directly, bypassing jsonb().
  db.db.run(
    `INSERT INTO events (event_id, session_id, seq, ts, type, actor, pid, cwd, telemetry_log, payload_json)
     VALUES ('jb-legacy', 'jb', 1, '2026-07-03T00:00:01.000Z', 'user_message', 'User', 1, '/jb', NULL, $p)`,
    { $p: JSON.stringify({ text: "legacy", n: 7 }) } as any,
  );
  expect(storageType(`SELECT typeof(payload_json) AS t FROM events WHERE event_id = 'jb-legacy'`)).toBe("text");
  const legacy = db.queryEvents({ session: "jb" }).find((e) => e.event_id === "jb-legacy")!;
  expect((legacy.payload as any).text).toBe("legacy");
  expect((legacy.payload as any).n).toBe(7);
});

test("model thinking_levels store as JSONB and round-trip through listModels", () => {
  db.upsertModel({ provider: "vendor", modelId: "m1", reasoning: true, thinkingLevels: ["off", "low", "high"] }, "2026-07-03T00:01:00.000Z");
  expect(storageType(`SELECT typeof(thinking_levels) AS t FROM model_versions WHERE provider = 'vendor' AND model_id = 'm1'`)).toBe("blob");
  const m = db.listModels().find((x) => x.provider === "vendor" && x.modelId === "m1")!;
  expect(m.thinkingLevels).toEqual(["off", "low", "high"]);
});

test("plan verdict JSON arrays store as JSONB and read back as arrays", () => {
  db.insertPlanVerdict({
    id: "jb-v1", changeId: "jb-change", reviewer: "R", verdict: "approve", summary: "ok",
    evidence: ["e1", "e2"], concerns: ["c1"], blockers: [], cwd: "/jb", createdAt: "2026-07-03T00:02:00.000Z",
  });
  expect(storageType(`SELECT typeof(evidence_json) AS t FROM plan_verdicts WHERE id = 'jb-v1'`)).toBe("blob");
  const v = db.latestVerdict("jb-change", "/jb")!;
  expect(v.evidence).toEqual(["e1", "e2"]);
  expect(v.concerns).toEqual(["c1"]);
  expect(v.blockers).toEqual([]);
});

test("topology node JSON columns store as JSONB; tools_json stays raw TEXT", () => {
  const topologyHash = "jb-topo-hash";
  db.upsertTopologyVersion({
    hash: topologyHash, cwd: "/jb", topologyJson: JSON.stringify({ active: "hive" }), ts: "2026-07-03T00:03:00.000Z",
    nodes: [{
      topologyHash, team: "hive", nodeId: 0, parentId: null, name: "Lead",
      agentType: "lead", model: "vendor/m1", thinking: "high", thinkingLevels: ["off", "high"],
      domain: ["src/**"], stages: ["build"], routingTags: ["core"], responsibilities: "own the core",
      tools: "read,edit", commitAllowed: true,
    }],
  });
  // topology_json itself is JSONB.
  expect(storageType(`SELECT typeof(topology_json) AS t FROM topology_versions WHERE hash = '${topologyHash}'`)).toBe("blob");
  // Migrated node columns are JSONB; tools_json stays TEXT (raw comma-string).
  expect(storageType(`SELECT typeof(thinking_levels) AS t FROM topology_nodes WHERE topology_hash = '${topologyHash}'`)).toBe("blob");
  expect(storageType(`SELECT typeof(domain_json) AS t FROM topology_nodes WHERE topology_hash = '${topologyHash}'`)).toBe("blob");
  expect(storageType(`SELECT typeof(routing_tags_json) AS t FROM topology_nodes WHERE topology_hash = '${topologyHash}'`)).toBe("blob");
  expect(storageType(`SELECT typeof(tools_json) AS t FROM topology_nodes WHERE topology_hash = '${topologyHash}'`)).toBe("text");
  // Reads decode correctly.
  const node = db.topologyNodes(topologyHash).find((n) => n.name === "Lead")!;
  expect(node.thinkingLevels).toEqual(["off", "high"]);
  expect(node.domain).toEqual(["src/**"]);
  expect(node.routingTags).toEqual(["core"]);
  expect(node.responsibilities).toBe("own the core");
  expect(node.tools).toBe("read,edit");
});

test("legacy TEXT node columns coexist with JSONB rows and both read (topologyDetail)", async () => {
  const runtime = await import("../src/observability/server/runtime");
  const topologyHash = "jb-mixed-hash";
  // JSONB row via the normal writer.
  db.upsertTopologyVersion({
    hash: topologyHash, cwd: "/jb", topologyJson: JSON.stringify({ active: "hive" }), ts: "2026-07-03T00:04:00.000Z",
    nodes: [{
      topologyHash, team: "hive", nodeId: 0, parentId: null, name: "Root",
      agentType: "lead", model: "vendor/m1", thinkingLevels: ["off", "low"], domain: ["a/**"], commitAllowed: false,
    }],
  });
  // Legacy TEXT node written directly (bypassing jsonb()), same hash, different node.
  db.db.run(
    `INSERT INTO topology_nodes (topology_hash, team, node_id, parent_id, name, agent_type, model, thinking_levels, domain_json, commit_allowed)
     VALUES ('${topologyHash}', 'hive', 1, 0, 'Legacy', 'coder', 'vendor/m1', $tl, $dj, 0)`,
    { $tl: JSON.stringify(["off", "medium"]), $dj: JSON.stringify(["b/**"]) } as any,
  );
  expect(storageType(`SELECT typeof(thinking_levels) AS t FROM topology_nodes WHERE topology_hash = '${topologyHash}' AND name = 'Legacy'`)).toBe("text");
  const detail = runtime.topologyDetail(topologyHash);
  const root = detail.hive.orchestrator;
  expect(root.name).toBe("Root");
  expect(root.thinkingLevels).toEqual(["off", "low"]);
  const legacy = root.children.find((c: any) => c.name === "Legacy");
  expect(legacy.thinkingLevels).toEqual(["off", "medium"]); // legacy TEXT decoded via json()
  expect(legacy.domain).toEqual(["b/**"]);
});
