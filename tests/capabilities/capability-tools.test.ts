import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCapabilities } from "../../src/capabilities/policy.ts";
import { classifyTrustedTool, classifyTrustedToolRegistration, deriveNodeTools, isTrustedToolDescriptor, routeMetadataForDirectMembers, TRUSTED_TOOL_DESCRIPTORS } from "../../src/capabilities/tools.ts";

const all = normalizeCapabilities({
  filesystem: [{ path: ".", operations: ["read", "create", "update"] }],
  shell: ["inspect"], git: true, "human-input": true,
  artifact: ["read", "write", "review"], knowledge: ["read", "propose"],
});

test("trusted descriptors are closed, bounded, and declare mutation queue requirements", () => {
  assert.equal(classifyTrustedTool("foreign_mcp_tool"), undefined);
  assert.equal(classifyTrustedTool("knowledge_propose"), undefined, "W23 must explicitly register its mutation contract before this tool can be frozen");
  assert.equal(TRUSTED_TOOL_DESCRIPTORS.some((item) => item.name === "knowledge_propose"), false);
  assert.equal(TRUSTED_TOOL_DESCRIPTORS.every((item) => item.maxOutputBytes > 0 && item.maxOutputBytes <= 262_144), true);
  assert.equal(classifyTrustedTool("write")?.requiresMutationQueue, true);
  assert.equal(classifyTrustedTool("artifact_action")?.requiresMutationQueue, true);
  assert.equal(isTrustedToolDescriptor(classifyTrustedTool("read")), true);
  const trustedRead = classifyTrustedTool("read");
  const collidingForeignRead = { ...trustedRead };
  assert.equal(isTrustedToolDescriptor(collidingForeignRead), false, "matching names and fields do not establish trusted registration identity");
  assert.equal(classifyTrustedToolRegistration("read", collidingForeignRead), undefined);
  assert.equal(classifyTrustedToolRegistration("read", trustedRead), trustedRead);
  const bash = classifyTrustedTool("bash");
  assert.ok(bash?.capability && bash.capability.group === "command");
  assert.equal(Object.isFrozen(bash.capability.anyOf), true);
});

test("tool derivation follows root/direct-member/leaf topology and every prerequisite", () => {
  const root = deriveNodeTools({ capabilities: all, root: true, directMemberIds: ["lead"], artifactAvailable: true, knowledgeAvailable: true, knowledgeAttached: true, questionsAvailable: true });
  assert.equal(root.includes("workflow_finish"), true);
  assert.equal(root.includes("delegate_agent"), true);
  assert.equal(root.includes("human_question"), true);
  const parent = deriveNodeTools({ capabilities: all, root: false, directMemberIds: ["leaf"], artifactAvailable: true, knowledgeAvailable: true, knowledgeAttached: true, questionsAvailable: true });
  assert.equal(parent.includes("workflow_finish"), false);
  assert.equal(parent.includes("delegate_agent"), true);
  const leaf = deriveNodeTools({ capabilities: all, root: false, directMemberIds: [], artifactAvailable: false, knowledgeAvailable: false, knowledgeAttached: false, questionsAvailable: false });
  assert.equal(leaf.includes("delegate_agent"), false);
  assert.equal(leaf.includes("artifact_action"), false);
  assert.equal(leaf.includes("knowledge_read"), false);
  assert.equal(leaf.includes("human_question"), false);
  assert.deepEqual(leaf, [...leaf].sort());

  const gitOnly = normalizeCapabilities({ git: true });
  assert.equal(deriveNodeTools({ capabilities: gitOnly, root: false, directMemberIds: [], artifactAvailable: false, knowledgeAvailable: false, knowledgeAttached: false, questionsAvailable: false }).includes("bash"), true);

  const proposeOnly = normalizeCapabilities({ knowledge: ["propose"] });
  assert.deepEqual(deriveNodeTools({ capabilities: proposeOnly, root: false, directMemberIds: [], artifactAvailable: false, knowledgeAvailable: true, knowledgeAttached: true, questionsAvailable: false }), []);
  const readAndPropose = normalizeCapabilities({ knowledge: ["read", "propose"] });
  assert.deepEqual(deriveNodeTools({ capabilities: readAndPropose, root: false, directMemberIds: [], artifactAvailable: false, knowledgeAvailable: true, knowledgeAttached: true, questionsAvailable: false }), ["knowledge_read", "knowledge_search"]);
});

test("trusted tool matrix independently requires capability, topology, attachment, and subsystem gates", () => {
  const derive = (capabilities: Parameters<typeof deriveNodeTools>[0]["capabilities"], overrides: Partial<Parameters<typeof deriveNodeTools>[0]> = {}) => deriveNodeTools({
    capabilities, root: false, directMemberIds: [], artifactAvailable: true, knowledgeAvailable: true, knowledgeAttached: true, questionsAvailable: true, ...overrides,
  });
  const none = normalizeCapabilities({});
  const cases: Array<{ name: string; denied: readonly string[]; allowed: readonly string[] }> = [
    { name: "read", denied: derive(none), allowed: derive(normalizeCapabilities({ filesystem: [{ path: ".", operations: ["read"] }] })) },
    { name: "write", denied: derive(normalizeCapabilities({ filesystem: [{ path: ".", operations: ["read"] }] })), allowed: derive(normalizeCapabilities({ filesystem: [{ path: ".", operations: ["update"] }] })) },
    { name: "bash", denied: derive(none), allowed: derive(normalizeCapabilities({ shell: ["inspect"] })) },
    { name: "bash", denied: derive(none), allowed: derive(normalizeCapabilities({ git: true })) },
    { name: "delegate_agent", denied: derive(none, { directMemberIds: [] }), allowed: derive(none, { directMemberIds: ["child"] }) },
    { name: "workflow_finish", denied: derive(none, { root: false }), allowed: derive(none, { root: true }) },
    { name: "artifact_status", denied: derive(normalizeCapabilities({ artifact: ["read"] }), { artifactAvailable: false }), allowed: derive(normalizeCapabilities({ artifact: ["read"] }), { artifactAvailable: true }) },
    { name: "artifact_status", denied: derive(none), allowed: derive(normalizeCapabilities({ artifact: ["read"] })) },
    { name: "knowledge_read", denied: derive(normalizeCapabilities({ knowledge: ["read"] }), { knowledgeAvailable: false }), allowed: derive(normalizeCapabilities({ knowledge: ["read"] }), { knowledgeAvailable: true }) },
    { name: "knowledge_read", denied: derive(normalizeCapabilities({ knowledge: ["read"] }), { knowledgeAttached: false }), allowed: derive(normalizeCapabilities({ knowledge: ["read"] }), { knowledgeAttached: true }) },
    { name: "knowledge_read", denied: derive(none), allowed: derive(normalizeCapabilities({ knowledge: ["read"] })) },
    { name: "human_question", denied: derive(normalizeCapabilities({ "human-input": true }), { questionsAvailable: false }), allowed: derive(normalizeCapabilities({ "human-input": true }), { questionsAvailable: true }) },
    { name: "human_question", denied: derive(none), allowed: derive(normalizeCapabilities({ "human-input": true })) },
  ];
  for (const row of cases) {
    assert.equal(row.denied.includes(row.name), false, `${row.name} denied gate`);
    assert.equal(row.allowed.includes(row.name), true, `${row.name} allowed gate`);
  }
});

test("route metadata contains direct members only and no semantic-name scoring", () => {
  const metadata = routeMetadataForDirectMembers("root", [
    { nodeId: "direct", parentId: "root", role: "General", responsibilities: ["deliver"], consultWhen: "needed", description: "helper", tags: ["support"], capabilities: all },
    { nodeId: "deep", parentId: "direct", role: "Planner coder security", responsibilities: [], tags: ["planner"], capabilities: all },
  ]);
  assert.deepEqual(metadata.map((item) => item.nodeId), ["direct"]);
  assert.equal(JSON.stringify(metadata).includes("score"), false);
});
