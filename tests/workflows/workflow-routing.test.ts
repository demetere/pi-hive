import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { routeDirectMembers } from "../../src/workflows/routing.ts";

function snapshot(): ActivationSnapshotFileV1 {
  const caps = (shell: string[] = [], git = false) => ({
    effective: { filesystem: [], shell, git, "external-network": false, "human-input": false, artifact: [], knowledge: [] },
    provenance: {}, budgets: {}, attachments: { skills: [], knowledge: [] }, directMemberIds: [],
  });
  return {
    snapshotHash: "b".repeat(64), createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      project: { projectId: "project-1", rootRef: "." },
      workflow: { id: "delivery", team: { rootId: "root", nodes: [
        { id: "root", agentId: "lead", memberIds: ["alpha", "beta", "gamma"], depth: 1, responsibilities: [] },
        { id: "alpha", agentId: "shared", parentId: "root", memberIds: [], depth: 2, role: "API builder", responsibilities: ["database migrations"], consultWhen: "service schema failures" },
        { id: "beta", agentId: "shared", parentId: "root", memberIds: [], depth: 2, role: "UI builder", responsibilities: ["React components"], consultWhen: "browser layout failures" },
        { id: "gamma", agentId: "reviewer", parentId: "root", memberIds: [], depth: 2, role: "Review", responsibilities: ["inspect API security"], consultWhen: "permission failures" },
      ] } },
      agents: [
        { id: "lead", name: "Lead", tags: [], frontmatter: {}, prompt: "", sourceHash: "", canonicalSourceHash: "", promptHash: "" },
        { id: "shared", name: "Reusable Builder", description: "implementation specialist", tags: ["implementation", "typescript"], frontmatter: {}, prompt: "", sourceHash: "", canonicalSourceHash: "", promptHash: "" },
        { id: "reviewer", name: "Reviewer", description: "security analysis", tags: ["security", "audit"], frontmatter: {}, prompt: "", sourceHash: "", canonicalSourceHash: "", promptHash: "" },
      ],
      authority: { capabilityContractVersion: 1, nodes: [
        { nodeId: "root", capabilities: caps(), tools: [] },
        { nodeId: "alpha", capabilities: caps(["inspect", "execute-code"], true), tools: [] },
        { nodeId: "beta", capabilities: caps(["inspect", "execute-code"]), tools: [] },
        { nodeId: "gamma", capabilities: caps(["inspect"]), tools: [] },
      ] },
      skills: [], knowledge: [], models: [], sources: [], versions: {} as never,
    },
  } as unknown as ActivationSnapshotFileV1;
}

test("routing is direct-member-only, capability filtered, deterministic, and explains token matches", () => {
  const input = snapshot();
  const first = routeDirectMembers(input, "root", {
    objective: "Inspect API service schema database migrations and implementation",
    requiredCapabilities: { shell: ["inspect"] },
    limit: 10,
  });
  const second = routeDirectMembers(input, "root", {
    objective: "Inspect API service schema database migrations and implementation",
    requiredCapabilities: { shell: ["inspect"] },
    limit: 10,
  });
  assert.deepEqual(first, second);
  assert.equal(first[0].nodeId, "alpha");
  assert.ok(first[0].reasons.some((reason) => reason.startsWith("role:")));
  assert.ok(first[0].reasons.some((reason) => reason.startsWith("responsibility:")));
  assert.equal(first.every((result) => ["alpha", "beta", "gamma"].includes(result.nodeId)), true);

  const gitOnly = routeDirectMembers(input, "root", { objective: "implementation", requiredCapabilities: { git: true } });
  assert.deepEqual(gitOnly.map((entry) => entry.nodeId), ["alpha"]);
  assert.throws(() => routeDirectMembers(input, "alpha", { objective: "anything" }), /no direct members|direct member/i);
  assert.throws(() => routeDirectMembers(input, "missing", { objective: "anything" }), /unknown node/i);
  assert.throws(() => routeDirectMembers(input, "root", { objective: "anything", requiredCapabilities: { shell: ["unknown-power"] } as any }), /capability.*invalid|unknown.*capability/i);
  assert.throws(() => routeDirectMembers(input, "root", { objective: "anything", requiredCapabilities: { hiddenAuthority: true } as any }), /capability.*invalid|unknown.*capability/i);
});

test("routing has stable node-ID tie breaks and no semantic name/type bonus", () => {
  const input = snapshot();
  const tied = routeDirectMembers(input, "root", { objective: "unmatched tokens", includeUnmatched: true });
  assert.deepEqual(tied.map((entry) => entry.nodeId), ["alpha", "beta", "gamma"]);
  assert.deepEqual(tied.map((entry) => entry.score), [0, 0, 0]);

  const security = routeDirectMembers(input, "root", { objective: "security audit" });
  assert.equal(security[0].nodeId, "gamma");
  assert.equal(security[0].reasons.some((reason) => /type|planner|coder/i.test(reason)), false);
});
