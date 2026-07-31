import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { createSelectedWorkflowToolPolicyHook } from "../../src/integration/workflow-tool-policy.ts";

function snapshot(): ActivationSnapshotFileV1 {
  return {
    snapshotHash: "a".repeat(64), createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      project: { projectId: "project-1", rootRef: "." },
      workflow: { id: "delivery", team: { rootId: "root", nodes: [{ id: "root", agentId: "lead", memberIds: [], responsibilities: [] }] } },
      authority: { capabilityContractVersion: 1, nodes: [{
        nodeId: "root",
        tools: ["bash", "read", "write", "workflow_status"],
        capabilities: { effective: {
          filesystem: [{ path: ".", operations: ["read", "create", "update", "delete"], include: ["**"], exclude: [], ceilingClause: 0 }],
          shell: ["inspect", "mutate"], git: false, "external-network": false, "human-input": false, artifact: [], knowledge: [],
        }, attachments: { skills: [], knowledge: [] }, directMemberIds: [] },
      }] },
      agents: [{ id: "lead", name: "Lead", tags: [], prompt: "lead" }], skills: [], knowledge: [],
      models: [{ nodeId: "root", modelId: "provider/model", thinking: "off", staticTokens: 1, dynamicReserve: 1, contextWindow: 100_000 }],
      sources: [], versions: {},
    },
  } as unknown as ActivationSnapshotFileV1;
}

function call(toolName: string, input: unknown) {
  return { type: "tool_call", toolCallId: "call-1", toolName, input } as never;
}

test("selected schema-v1 policy allows in-scope built-ins and denies path, network, and unknown authority", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-production-policy-"));
  writeFileSync(join(projectRoot, "README.md"), "allowed\n");
  writeFileSync(join(projectRoot, "created.txt"), "ok\n");
  const selected = { snapshot: snapshot(), nodeId: "root" };
  const hook = createSelectedWorkflowToolPolicyHook(projectRoot, () => selected);

  assert.equal(await hook(call("read", { path: "README.md" })), undefined);
  assert.equal(await hook(call("write", { path: "created.txt", content: "ok" })), undefined);
  assert.equal(await hook(call("edit", { path: "created.txt", oldText: "ok", newText: "green" })), undefined);
  assert.equal(await hook(call("bash", { command: "ls ./" })), undefined);
  assert.match((await hook(call("read", { path: "../outside.txt" })))!.reason ?? "", /denied|outside|escape/i);
  assert.match((await hook(call("bash", { command: "curl https://example.com" })))!.reason ?? "", /network|denied|classification/i);
  assert.match((await hook(call("unregistered_mutation", { path: "created.txt" })))!.reason ?? "", /outside immutable snapshot authority/i);
});

test("workflow denial reasons are bounded at exact UTF-8 N and N+1 byte boundaries", async () => {
  const limit = 2_048;
  const cases = [
    ["ASCII N", "a".repeat(limit), limit],
    ["ASCII N+1", "a".repeat(limit + 1), limit],
    ["multibyte N", "😀".repeat(limit / 4), limit],
    ["multibyte N+1", `${"😀".repeat(limit / 4 - 1)}x😀`, limit - 3],
  ] as const;
  for (const [label, reason, expectedBytes] of cases) {
    const selected = {
      snapshot: snapshot(), nodeId: "root",
      policy: { nodeId: "root", hook: async () => ({ block: true as const, reason }) },
    } as never;
    const denied = await createSelectedWorkflowToolPolicyHook(process.cwd(), () => selected)(call("read", { path: "README.md" }));
    assert.equal(Buffer.byteLength(denied?.reason ?? "", "utf8"), expectedBytes, label);
    assert.equal(denied?.reason?.includes("�"), false, `${label} must not split a code point`);
  }
});

test("ordinary chat has no workflow interception", async () => {
  const hook = createSelectedWorkflowToolPolicyHook(process.cwd(), () => undefined);
  assert.equal(await hook(call("read", { path: "../ordinary-chat.txt" })), undefined);
});
