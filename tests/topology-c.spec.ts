// Bun-only tests for Phase C: topology versioning + content-versioned models.
// Run: bun test tests/topology-c.spec.ts
import { expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_TELEMETRY_DB = join(mkdtempSync(join(tmpdir(), "pi-hive-topoc-")), "telemetry.db");

let hash: typeof import("../src/observability/server/topology-hash");
let db: typeof import("../src/observability/server/db");
let runtime: typeof import("../src/observability/server/runtime");

beforeAll(async () => {
  hash = await import("../src/observability/server/topology-hash");
  db = await import("../src/observability/server/db");
  runtime = await import("../src/observability/server/runtime");
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
    topologyHash: h, team, nodeId, parentId, name: node.name, agentType: (node as any).agentType,
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
    topologyHash: h, team, nodeId, parentId, name: node.name, agentType: (node as any).agentType,
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

test("thinking_levels backfills from model_versions via the model soft-join (C3)", () => {
  // A node whose model exists in model_versions but whose per-worker sidecar
  // never filled (no delegation) must backfill from the catalog's soft join.
  const topo = {
    active: "hive" as const,
    hive: {
      orchestrator: { name: "SoloLead", role: "orchestrator" as const, model: "vendor/reasoner", thinking: "high" },
      agents: [],
    },
    planning: { orchestrator: undefined, agents: [] },
  };
  const h = hash.topologyHash(topo as any);
  const nodes = hash.explodeTopology(topo as any).map(({ team, nodeId, parentId, node }) => ({
    topologyHash: h, team, nodeId, parentId, name: node.name, agentType: (node as any).agentType,
    model: node.model, thinking: node.thinking,
  }));
  db.upsertTopologyVersion({ hash: h, cwd: "/c3", topologyJson: hash.canonicalTopologyJson(topo as any), ts: "2026-07-02T04:00:00.000Z", nodes: nodes as any });
  // No sidecar yet.
  expect(db.topologyNodes(h).find((r) => r.name === "SoloLead")!.thinkingLevels).toBeUndefined();

  // Catalog lands (Workstream A path), then the backfill soft-joins by model.
  db.upsertModel({ provider: "vendor", modelId: "reasoner", reasoning: true, thinkingLevels: ["off", "low", "high"] }, "2026-07-02T04:01:00.000Z");
  const levelsByModel = new Map(db.listModels().map((m) => [`${m.provider}/${m.modelId}`, m.thinkingLevels] as const));
  for (const node of db.topologyNodes(h)) {
    if (node.model && (!node.thinkingLevels || !node.thinkingLevels.length)) {
      const lv = levelsByModel.get(node.model);
      if (lv?.length) db.fillNodeThinkingLevels(h, node.name, lv as string[]);
    }
  }
  expect(db.topologyNodes(h).find((r) => r.name === "SoloLead")!.thinkingLevels).toEqual(["off", "low", "high"]);
});

test("explode → topologyDetail reassembles the exact tree + canonical JSON (L2)", () => {
  const h = hash.topologyHash(TOPO as any);
  const nodes = hash.explodeTopology(TOPO as any).map(({ team, nodeId, parentId, node }) => ({
    topologyHash: h, team, nodeId, parentId, name: node.name, agentType: (node as any).agentType,
    model: node.model, thinking: node.thinking, domain: (node as any).domain, tools: (node as any).tools, commitAllowed: (node as any).commit === true,
  }));
  db.upsertTopologyVersion({ hash: h, cwd: "/l2", topologyJson: hash.canonicalTopologyJson(TOPO as any), ts: "2026-07-02T03:00:00.000Z", nodes: nodes as any });

  const detail = runtime.topologyDetail(h);
  expect(detail).toBeTruthy();
  // Adjacency/identity reassembles: Lead is the hive orchestrator with Coder +
  // Tester as its children; Planner is the planning orchestrator.
  expect(detail.hive.orchestrator.name).toBe("Lead");
  const childNames = (detail.hive.orchestrator.children || []).map((c: any) => c.name).sort();
  expect(childNames).toEqual(["Coder", "Tester"]);
  const coder = detail.hive.orchestrator.children.find((c: any) => c.name === "Coder");
  expect(coder.model).toBe("anthropic/sonnet");
  expect(coder.commit).toBe(false);
  expect(detail.hive.orchestrator.commit).toBe(true);
  expect(detail.hive.orchestrator.domain).toEqual(["src/**"]);
  expect(detail.planning.orchestrator.name).toBe("Planner");

  // The canonical JSON stored round-trips byte-for-byte, and re-hashing the
  // reassembled canonical form yields the SAME hash (stable identity).
  expect(detail.canonicalJson).toBe(hash.canonicalTopologyJson(TOPO as any));
  expect(hash.topologyHash(JSON.parse(detail.canonicalJson))).toBe(h);
});

test("hash is invariant under key insertion-order permutation (L2)", () => {
  const base = hash.topologyHash(TOPO as any);
  // Rebuild the SAME topology with keys inserted in a shuffled order at every
  // level. A canonical hash must be insertion-order independent.
  const shuffled = {
    hive: {
      agents: [
        { thinking: "medium", model: "anthropic/sonnet", tools: "read,edit", domain: ["src/app/**"], agentType: "coder", role: "member", name: "Coder" },
        { name: "Tester", thinking: "low", role: "member", agentType: "tester", model: "anthropic/sonnet" },
      ],
      orchestrator: { commit: true, domain: ["src/**"], thinking: "high", model: "anthropic/opus", role: "orchestrator", name: "Lead" },
    },
    planning: {
      agents: [],
      orchestrator: { thinking: "high", name: "Planner", model: "anthropic/opus", role: "orchestrator" },
    },
    active: "hive",
  };
  expect(hash.topologyHash(shuffled as any)).toBe(base);
  expect(hash.canonicalTopologyJson(shuffled as any)).toBe(hash.canonicalTopologyJson(TOPO as any));
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
