import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeNormalParent, listSessionLinks } from "../../src/workflows/sessions.ts";
import { exitWorkflowSession, selectWorkflowSession } from "../../src/workflows/navigation.ts";

function setup() { const projectRoot = mkdtempSync(join(tmpdir(), "hive-nav-")); initializeNormalParent({ configured: true, projectRoot, projectId: "p", piSessionId: "normal", piSessionFile: "/pi/normal", model: "provider/normal", thinking: "low", activeTools: ["read"] }); const calls: any[] = []; let next = 0; const adapter = { async create(input: any) { calls.push(["create", input]); next++; return { piSessionId: `child-${next}`, piSessionFile: `/pi/child-${next}` }; }, async switch(input: any) { calls.push(["switch", input.piSessionFile]); await input.withSession({ fresh: true, sessionId: input.piSessionFile }); return { cancelled: false }; } }; return { projectRoot, adapter, calls }; }
const workflow = { workflowId: "build", activationHash: "b".repeat(64), source: "current" as const, resumable: true, freshEnabled: true, model: "provider/model", thinking: "high", tools: ["bash", "write"] };

test("first selection creates a sibling, reselection resumes, and fresh archives", async () => {
  const f = setup();
  const first = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow, adapter: f.adapter, owner: { pid: 111, processMarker: "m", nonce: "owner-1", verifyDead: () => true } }); assert.equal(first.kind, "created");
  const resumed = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "child-1", workflow, adapter: f.adapter, owner: { pid: 111, processMarker: "m", nonce: "owner-1", verifyDead: () => true } }); assert.equal(resumed.kind, "resumed");
  const fresh = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "child-1", workflow, fresh: true, adapter: f.adapter, owner: { pid: 111, processMarker: "m", nonce: "owner-1", verifyDead: () => true } }); assert.equal(fresh.kind, "created");
  const children = listSessionLinks(f.projectRoot).filter((entry) => entry.kind === "workflow"); assert.equal(children.length, 2); const archived = children.find((entry) => entry.status === "archived"); assert.ok(archived); assert.match(archived.name, /^hive:build:[a-f0-9]+:archived:[a-f0-9]+$/); assert.equal(new Set(children.map((entry) => entry.normalParentId)).size, 1);
  assert.equal(f.calls.filter(([name]) => name === "create").every(([, input]) => input.parentSession === "/pi/normal"), true, "workflow selections are siblings even when selected inside a workflow");
});

test("stale compatible activation resumes but invalid source blocks fresh", async () => {
  const f = setup(); await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow, adapter: f.adapter, owner: { pid: 1, processMarker: "m", nonce: "o1", verifyDead: () => true } });
  const stale = { ...workflow, source: "stale" as const, freshEnabled: false };
  assert.equal((await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow: stale, adapter: f.adapter, owner: { pid: 1, processMarker: "m", nonce: "o1", verifyDead: () => true } })).kind, "resumed");
  await assert.rejects(() => selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow: { ...stale, source: "invalid" as const }, fresh: true, adapter: f.adapter, owner: { pid: 1, processMarker: "m", nonce: "o2", verifyDead: () => true } }), /fresh|source/i);
});

test("selection never starts a run, ownership rejects a second owner, exit restores normal baseline", async () => {
  const f = setup(); const selected = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow, adapter: f.adapter, owner: { pid: 1, processMarker: "m", nonce: "held", verifyDead: () => false } });
  assert.equal(f.calls.some(([name]) => name === "prompt" || name === "run"), false);
  await assert.rejects(() => selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow, adapter: f.adapter, owner: { pid: 2, processMarker: "x", nonce: "second", verifyDead: () => false } }), /owner|ownership/i);
  await assert.rejects(() => exitWorkflowSession({ projectRoot: f.projectRoot, currentPiSessionId: selected.link.piSessionId, ownerNonce: "wrong", adapter: f.adapter }), /ownership/i);
  const exited = await exitWorkflowSession({ projectRoot: f.projectRoot, currentPiSessionId: selected.link.piSessionId, ownerNonce: "held", adapter: f.adapter }); assert.deepEqual(exited.activeTools, ["read"]); assert.equal(exited.piSessionId, "normal");
});

test("failed fresh creation preserves the current activation and ownership", async () => {
  const f = setup();
  const first = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow, adapter: f.adapter, owner: { pid: 1, processMarker: "m", nonce: "original", verifyDead: () => false } });
  const failing = { ...f.adapter, async create() { throw new Error("create failed"); } };
  await assert.rejects(() => selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: first.link.piSessionId, workflow, fresh: true, adapter: failing, owner: { pid: 1, processMarker: "m", nonce: "original", verifyDead: () => false } }), /create failed/);
  const currentLinks = listSessionLinks(f.projectRoot).filter((entry) => entry.kind === "workflow" && entry.status === "current");
  assert.equal(currentLinks.length, 1);
  const current = currentLinks[0];
  assert.ok(current?.kind === "workflow");
  assert.equal(current.workflowSessionId, first.link.workflowSessionId);
  assert.equal((await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow, adapter: f.adapter, owner: { pid: 1, processMarker: "m", nonce: "original", verifyDead: () => false } })).kind, "resumed");
});
