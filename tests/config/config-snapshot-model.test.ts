import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSnapshotModels, SNAPSHOT_CONTEXT_POLICY } from "../../src/config/snapshot-model.ts";

const registry = {
  defaultModel: "provider/default",
  defaultThinking: "high",
  find(modelId: string) {
    if (modelId === "provider/default") return { id: modelId, contextWindow: 50_000, maxTokens: 10_000, thinking: ["off", "high"] };
    if (modelId === "provider/small") return { id: modelId, contextWindow: 20_000, maxTokens: 1_000, thinking: ["off"] };
    return undefined;
  },
  canActivate(modelId: string) { return modelId !== "provider/blocked"; },
  estimateTokens(text: string) { return Buffer.byteLength(text, "utf8"); },
};

test("model preflight resolves model and thinking inheritance exactly and records deterministic reserves", () => {
  const result = validateSnapshotModels([
    { nodeId: "root", model: "inherit", thinking: "inherit", staticText: "abc" },
    { nodeId: "child", model: "provider/small", thinking: "off", staticText: "abcd" },
  ], registry);
  assert.equal(result.ok, true);
  assert.deepEqual(result.nodes.map((node) => node.nodeId), ["child", "root"]);
  assert.deepEqual(result.nodes.map((node) => node.modelId), ["provider/small", "provider/default"]);
  assert.deepEqual(result.nodes.map((node) => node.thinking), ["off", "high"]);
  assert.equal(result.nodes[0].dynamicReserve, SNAPSHOT_CONTEXT_POLICY.minimumDynamicReserve);
  assert.equal(result.nodes[1].dynamicReserve, 10_000);
});

test("model preflight rejects unavailable models, unsupported thinking, and context N+1 without fallback", () => {
  assert.deepEqual(validateSnapshotModels([{ nodeId: "root", model: "provider/missing", thinking: "off", staticText: "" }], registry).codes, ["SNAPSHOT_MODEL_UNAVAILABLE"]);
  assert.deepEqual(validateSnapshotModels([{ nodeId: "root", model: "provider/small", thinking: "high", staticText: "" }], registry).codes, ["SNAPSHOT_THINKING_UNSUPPORTED"]);
  const exact = "x".repeat(20_000 - SNAPSHOT_CONTEXT_POLICY.harnessReserve - SNAPSHOT_CONTEXT_POLICY.minimumDynamicReserve);
  assert.equal(validateSnapshotModels([{ nodeId: "root", model: "provider/small", thinking: "off", staticText: exact }], registry).ok, true);
  assert.deepEqual(validateSnapshotModels([{ nodeId: "root", model: "provider/small", thinking: "off", staticText: `${exact}x` }], registry).codes, ["SNAPSHOT_CONTEXT_INSUFFICIENT"]);
});

test("model preflight rejects invalid numeric model metadata", () => {
  for (const invalid of [NaN, Infinity, -1, 1.5]) {
    const adapter = { ...registry, find: () => ({ id: "provider/default", contextWindow: 50_000, maxTokens: invalid, thinking: ["off", "high"] }) };
    assert.deepEqual(validateSnapshotModels([{ nodeId: "root", thinking: "off", staticText: "" }], adapter).codes, ["SNAPSHOT_CONTEXT_INVALID"]);
  }
  const fractionalContext = { ...registry, find: () => ({ id: "provider/default", contextWindow: 50_000.5, maxTokens: 1000, thinking: ["off"] }) };
  assert.deepEqual(validateSnapshotModels([{ nodeId: "root", thinking: "off", staticText: "" }], fractionalContext).codes, ["SNAPSHOT_CONTEXT_INVALID"]);
});
