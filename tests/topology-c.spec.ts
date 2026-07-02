// Bun-only tests for Phase C: topology versioning + content-versioned models.
// Run: bun test tests/topology-c.spec.ts
import { expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_TELEMETRY_DB = join(mkdtempSync(join(tmpdir(), "pi-hive-topoc-")), "telemetry.db");

let hash: typeof import("../src/observability/server/topology-hash");
let db: typeof import("../src/observability/server/db");

beforeAll(async () => {
  hash = await import("../src/observability/server/topology-hash");
  db = await import("../src/observability/server/db");
});

const TOPO = {
  active: "hive" as const,
  hive: {
    orchestrator: { name: "Lead", role: "orchestrator" as const, model: "anthropic/opus", thinking: "high", domain: ["src/**"], commit: true },
    agents: [
      { name: "Coder", role: "member" as const, agentType: "coder", model: "anthropic/sonnet", thinking: "medium", domain: ["src/app/**"], tools: "read,edit" },
      { name: "Tester", role: "member" as const, agentType: "tester", model: "anthropic/sonnet", thinking: "low" },
    ],
  },
  planning: {
    orchestrator: { name: "Planner", role: "orchestrator" as const, model: "anthropic/opus", thinking: "high" },
    agents: [],
  },
};

test("hash is invariant under runtime-counter changes and key ordering (C1)", () => {
  const base = hash.topologyHash(TOPO as any);
  // Add volatile runtime fields — hash must not change.
  const withRuntime = JSON.parse(JSON.stringify(TOPO));
  withRuntime.hive.orchestrator.status = "running";
  withRuntime.hive.orchestrator.inputTokens = 999;
  withRuntime.hive.agents[0].costUsd = 1.23;
  withRuntime.hive.agents[0].thinkingLevels = ["off", "low", "high"]; // sidecar, excluded
  expect(hash.topologyHash(withRuntime as any)).toBe(base);
});

test("hash changes when an identity field changes (C1)", () => {
  const base = hash.topologyHash(TOPO as any);
  const renamed = JSON.parse(JSON.stringify(TOPO));
  renamed.hive.agents[0].name = "Coder2";
  expect(hash.topologyHash(renamed as any)).not.toBe(base);

  const remodeled = JSON.parse(JSON.stringify(TOPO));
  remodeled.hive.agents[0].model = "anthropic/haiku";
  expect(hash.topologyHash(remodeled as any)).not.toBe(base);
});

test("explode -> version -> reassemble round-trips the tree (C2/C5)", () => {
  const h = hash.topologyHash(TOPO as any);
  const nodes = hash.explodeTopology(TOPO as any).map(({ team, nodeId, parentId, node }) => ({
    topologyHash: h, team, nodeId, parentId, name: node.name, role: node.role, agentType: (node as any).agentType,
    model: node.model, thinking: node.thinking, domain: (node as any).domain, tools: (node as any).tools, commitAllowed: (node as any).commit === true,
  }));
  db.upsertTopologyVersion({ hash: h, cwd: "/proj", topologyJson: hash.canonicalTopologyJson(TOPO as any), ts: "2026-07-02T00:00:00.000Z", nodes: nodes as any });

  const rows = db.topologyNodes(h);
  // 3 hive nodes (Lead+Coder+Tester) + 1 planning (Planner) = 4.
  expect(rows.length).toBe(4);
  const lead = rows.find((r) => r.name === "Lead")!;
  const coder = rows.find((r) => r.name === "Coder")!;
  expect(lead.parentId).toBeNull();
  expect(coder.parentId).toBe(lead.nodeId); // Coder is a child of Lead
  expect(coder.model).toBe("anthropic/sonnet");
  expect(coder.commitAllowed).toBe(false);
  expect(lead.commitAllowed).toBe(true);
  expect(lead.domain).toEqual(["src/**"]);
});

test("version insert is hash-idempotent — no duplicate rows on re-ingest (C3)", () => {
  const h = hash.topologyHash(TOPO as any);
  const before = db.topologyNodes(h).length;
  db.upsertTopologyVersion({ hash: h, cwd: "/proj", topologyJson: hash.canonicalTopologyJson(TOPO as any), ts: "2026-07-02T01:00:00.000Z", nodes: [] as any });
  // Re-inserting an existing hash must not add nodes (immutable) or duplicate the version.
  expect(db.topologyNodes(h).length).toBe(before);
  expect(db.listTopologies("/proj").filter((t) => t.hash === h).length).toBe(1);
});

test("upsertTopologyVersion self-heals a partial node tree on re-ingest (I2)", () => {
  const h = hash.topologyHash(TOPO as any);
  const nodes = hash.explodeTopology(TOPO as any).map(({ team, nodeId, parentId, node }) => ({
    topologyHash: h, team, nodeId, parentId, name: node.name, role: node.role, agentType: (node as any).agentType,
    model: node.model, thinking: node.thinking, domain: (node as any).domain, tools: (node as any).tools, commitAllowed: (node as any).commit === true,
  }));
  const full = db.topologyNodes(h).length;
  expect(full).toBe(4);
  // Simulate a pre-fix crash mid-explode: version row exists but only half its
  // nodes are present. Deleting rows directly leaves the tree partial.
  db.db.run(`DELETE FROM topology_nodes WHERE topology_hash = ? AND name IN ('Coder', 'Tester')`, [h]);
  expect(db.topologyNodes(h).length).toBe(2);
  // Re-ingesting the same hash must detect the mismatch and re-explode to full.
  db.upsertTopologyVersion({ hash: h, cwd: "/proj", topologyJson: hash.canonicalTopologyJson(TOPO as any), ts: "2026-07-02T02:00:00.000Z", nodes: nodes as any });
  expect(db.topologyNodes(h).length).toBe(4);
  const coder = db.topologyNodes(h).find((r) => r.name === "Coder")!;
  expect(coder.model).toBe("anthropic/sonnet"); // healed row carries full data
});

test("thinking_levels sidecar fills without changing the hash (C3/A10)", () => {
  const h = hash.topologyHash(TOPO as any);
  db.fillNodeThinkingLevels(h, "Coder", ["off", "low", "medium", "high"]);
  const coder = db.topologyNodes(h).find((r) => r.name === "Coder")!;
  expect(coder.thinkingLevels).toEqual(["off", "low", "medium", "high"]);
  // The hash source is unchanged.
  expect(hash.topologyHash(TOPO as any)).toBe(h);
});

test("models are content-versioned: a price change mints a new immutable row", () => {
  const base = { provider: "anthropic", modelId: "opus", reasoning: true, thinkingLevels: ["off", "low", "high"], contextWindow: 200000, costRates: { input: 15, output: 75 } };
  const h1 = db.upsertModel(base, "2026-07-02T00:00:00.000Z");
  const h1Again = db.upsertModel(base, "2026-07-02T00:05:00.000Z");
  expect(h1).toBe(h1Again); // same capabilities -> same hash, idempotent

  const priceChanged = { ...base, costRates: { input: 20, output: 80 } };
  const h2 = db.upsertModel(priceChanged, "2026-07-02T01:00:00.000Z");
  expect(h2).not.toBe(h1); // new pricing -> new version

  const all = db.listModels(true).filter((m) => m.provider === "anthropic" && m.modelId === "opus");
  expect(all.length).toBe(2); // both versions retained
  const latest = db.listModels(false).filter((m) => m.provider === "anthropic" && m.modelId === "opus");
  expect(latest.length).toBe(1); // latest view collapses to newest
  expect(latest[0].costRates.input).toBe(20);
});
