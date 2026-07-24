import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSnapshotModels, SNAPSHOT_CONTEXT_POLICY } from "../../src/config/snapshot-model.ts";

const registry = {
  defaultModel: "provider/default",
  defaultThinking: "high",
  find(modelId: string) {
    if (modelId === "provider/default") return { id: modelId, contextWindow: 50_000, maxTokens: 10_000, thinking: ["off", "high"] };
    if (modelId === "provider/small") return { id: modelId, contextWindow: 21_000, maxTokens: 1_000, thinking: ["off"] };
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
  assert.equal(result.nodes[0].outputReserve, SNAPSHOT_CONTEXT_POLICY.minimumOutputReserve);
  assert.equal(result.nodes[1].dynamicReserve, SNAPSHOT_CONTEXT_POLICY.minimumDynamicReserve);
  assert.equal(result.nodes[1].outputReserve, 10_000);
});

test("model preflight rejects unavailable models, unsupported thinking, and context N+1 without fallback", () => {
  assert.deepEqual(validateSnapshotModels([{ nodeId: "root", model: "provider/missing", thinking: "off", staticText: "" }], registry).codes, ["SNAPSHOT_MODEL_UNAVAILABLE"]);
  assert.deepEqual(validateSnapshotModels([{ nodeId: "root", model: "provider/small", thinking: "high", staticText: "" }], registry).codes, ["SNAPSHOT_THINKING_UNSUPPORTED"]);
  const exact = "x".repeat(21_000 - SNAPSHOT_CONTEXT_POLICY.harnessReserve - SNAPSHOT_CONTEXT_POLICY.minimumOutputReserve - SNAPSHOT_CONTEXT_POLICY.minimumDynamicReserve);
  assert.equal(validateSnapshotModels([{ nodeId: "root", model: "provider/small", thinking: "off", staticText: exact }], registry).ok, true);
  assert.deepEqual(validateSnapshotModels([{ nodeId: "root", model: "provider/small", thinking: "off", staticText: `${exact}x` }], registry).codes, ["SNAPSHOT_CONTEXT_INSUFFICIENT"]);
});

test("model preflight records a preferred dynamic cap and enforces an explicit minimum", () => {
  let estimatedText = "";
  const compressible = { ...registry, estimateTokens(text: string) { estimatedText = text; return text === "static" ? 6 : 1; } };
  const result = validateSnapshotModels([{ nodeId: "root", model: "provider/default", thinking: "off", staticText: "static", dynamicTokenReserve: 12_000 }], compressible);
  assert.equal(result.ok, true);
  assert.equal(result.nodes[0].dynamicReserve, 12_000);
  assert.equal(estimatedText, "static", "dynamic reserve must not tokenize a compressible sample");
  assert.equal(result.nodes[0].staticTokens + result.nodes[0].dynamicReserve + (result.nodes[0].outputReserve ?? 0) <= result.nodes[0].contextWindow, true);
  const adapted = validateSnapshotModels([{ nodeId: "root", model: "provider/small", thinking: "off", staticText: "", dynamicTokenReserve: 12_000 }], registry);
  assert.equal(adapted.ok, true);
  assert.equal(adapted.nodes[0].dynamicReserve, 21_000 - SNAPSHOT_CONTEXT_POLICY.harnessReserve - SNAPSHOT_CONTEXT_POLICY.minimumOutputReserve);
  assert.deepEqual(validateSnapshotModels([{ nodeId: "root", model: "provider/small", thinking: "off", staticText: "", dynamicTokenReserve: 12_000, minimumDynamicTokenReserve: 12_000 }], registry).codes, ["SNAPSHOT_CONTEXT_INSUFFICIENT"]);
});

test("model preflight rejects invalid numeric model metadata", () => {
  for (const invalid of [NaN, Infinity, -1, 1.5]) {
    const adapter = { ...registry, find: () => ({ id: "provider/default", contextWindow: 50_000, maxTokens: invalid, thinking: ["off", "high"] }) };
    assert.deepEqual(validateSnapshotModels([{ nodeId: "root", thinking: "off", staticText: "" }], adapter).codes, ["SNAPSHOT_CONTEXT_INVALID"]);
  }
  const fractionalContext = { ...registry, find: () => ({ id: "provider/default", contextWindow: 50_000.5, maxTokens: 1000, thinking: ["off"] }) };
  assert.deepEqual(validateSnapshotModels([{ nodeId: "root", thinking: "off", staticText: "" }], fractionalContext).codes, ["SNAPSHOT_CONTEXT_INVALID"]);
});
