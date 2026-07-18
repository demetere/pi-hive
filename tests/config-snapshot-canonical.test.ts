import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, hashActivationPayload } from "../src/config/snapshot-canonical.ts";
import { issueEffectiveAuthoritySnapshotV1 } from "../src/config/snapshot-authority.ts";

test("canonical JSON sorts objects but preserves array order and rejects unsafe values", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: ["b", "a"], fraction: 1.5 } }), '{"a":{"fraction":1.5,"x":["b","a"],"y":2},"z":1}');
  for (const value of [undefined, NaN, Infinity, 1n, Object.create({ polluted: true })]) {
    assert.throws(() => canonicalJson(value), /canonical/i);
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cycle/i);
  const accessor = {};
  Object.defineProperty(accessor, "secret", { enumerable: true, get: () => "x" });
  assert.throws(() => canonicalJson(accessor), /accessor/i);
  const sparse = Array(2);
  assert.throws(() => canonicalJson(sparse), /sparse/i);
});

test("activation hash is domain separated and enumeration independent", () => {
  const first = hashActivationPayload({ workflowId: "debug", tags: ["a", "b"], nested: { z: 1, a: 2 } });
  const second = hashActivationPayload({ nested: { a: 2, z: 1 }, tags: ["a", "b"], workflowId: "debug" });
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, hashActivationPayload({ workflowId: "debug", tags: ["b", "a"], nested: { z: 1, a: 2 } }));
});

test("effective authority issuer freezes a complete workflow-matching branded record", () => {
  const authority = issueEffectiveAuthoritySnapshotV1("workflow", [
    { nodeId: "root", capabilities: { git: false }, tools: ["read", "bash"] },
    { nodeId: "child", capabilities: {}, tools: [] },
  ]);
  assert.equal(Object.isFrozen(authority), true);
  assert.deepEqual(authority.nodes.map((node) => node.nodeId), ["child", "root"]);
  assert.deepEqual(authority.nodes[1].tools, ["bash", "read"]);
  assert.throws(() => issueEffectiveAuthoritySnapshotV1("workflow", [{ nodeId: "root", capabilities: {}, tools: [] }, { nodeId: "root", capabilities: {}, tools: [] }]), /duplicate/i);
});
