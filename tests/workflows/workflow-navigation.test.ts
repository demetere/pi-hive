import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeNormalParent, listSessionLinks } from "../../src/workflows/sessions.ts";
import { WorkflowRunLifecycle } from "../../src/workflows/runs.ts";
import { releaseRuntimeOwnership } from "../../src/workflows/ownership.ts";
import { exitWorkflowSession, reloadWorkflowSession, selectWorkflowSession } from "../../src/workflows/navigation.ts";

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

test("selection rejects missing parents, project mismatches, and each incompatible resume condition", async () => {
  const empty = mkdtempSync(join(tmpdir(), "hive-nav-empty-"));
  await assert.rejects(() => selectWorkflowSession({ projectRoot: empty, projectId: "p", currentPiSessionId: "normal", workflow, adapter: setup().adapter, owner: { pid: 1, processMarker: "m", nonce: "o", verifyDead: () => true } }), /normal parent.*missing/i);

  const mismatch = setup();
  await assert.rejects(() => selectWorkflowSession({ projectRoot: mismatch.projectRoot, projectId: "other", currentPiSessionId: "normal", workflow, adapter: mismatch.adapter, owner: { pid: 1, processMarker: "m", nonce: "o", verifyDead: () => true } }), /project identity/i);

  for (const candidate of [{ ...workflow, resumable: false }, { ...workflow, activationHash: "c".repeat(64) }]) {
    const f = setup();
    await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow, adapter: f.adapter, owner: { pid: 1, processMarker: "m", nonce: "held", verifyDead: () => false } });
    await assert.rejects(() => selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow: candidate, adapter: f.adapter, owner: { pid: 1, processMarker: "m", nonce: "held", verifyDead: () => false } }), /not resumable|compatible/i);
  }
});

test("cancelled resume and fresh-source gates fail before publishing selection events", async () => {
  const cancelled = setup();
  await selectWorkflowSession({ projectRoot: cancelled.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow, adapter: cancelled.adapter, owner: { pid: 1, processMarker: "m", nonce: "held", verifyDead: () => false } });
  const cancellingAdapter = { ...cancelled.adapter, async switch() { return { cancelled: true }; } };
  await assert.rejects(() => selectWorkflowSession({ projectRoot: cancelled.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow, adapter: cancellingAdapter, owner: { pid: 1, processMarker: "m", nonce: "held", verifyDead: () => false } }), /switch cancelled/i);

  for (const candidate of [{ ...workflow, source: "missing" as const }, { ...workflow, freshEnabled: false }]) {
    const f = setup();
    await assert.rejects(() => selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow: candidate, fresh: true, adapter: f.adapter, owner: { pid: 1, processMarker: "m", nonce: "fresh", verifyDead: () => true } }), /fresh selection blocked/i);
  }
});

test("fresh selection compensates pre-commit faults and reports compensation failure", async () => {
  for (const compensateFails of [false, true, "non-error"] as const) {
    const f = setup();
    let compensated = 0;
    const adapter = {
      ...f.adapter,
      async create(input: any) {
        await f.adapter.create(input);
        return {
          piSessionId: "candidate", piSessionFile: "/pi/candidate",
          async compensate() { compensated += 1; if (compensateFails === true) throw new Error("compensate failed"); if (compensateFails === "non-error") throw "compensate failed"; },
        };
      },
    };
    const selection = selectWorkflowSession({
      projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "unknown", workflow, adapter,
      owner: { pid: 1, processMarker: "m", nonce: "candidate-owner", verifyDead: () => true },
      beforeCommit: () => { throw new Error("commit probe failed"); },
    });
    await assert.rejects(() => selection, compensateFails === false ? /commit probe failed/i : /compensation was incomplete/i);
    assert.equal(compensated, 1);
    assert.equal(listSessionLinks(f.projectRoot).some((entry) => entry.kind === "workflow"), false);
  }
});

test("reload rejects normal chat, open runs, and every invalid prepared activation dimension", async () => {
  const normal = setup();
  await assert.rejects(() => reloadWorkflowSession({ projectRoot: normal.projectRoot, projectId: "p", currentPiSessionId: "normal", adapter: normal.adapter, owner: { pid: 1, processMarker: "m", nonce: "o", verifyDead: () => true }, prepareActivation: () => ({ workflow }) }), /currently selected workflow/i);

  const open = setup();
  const selected = await selectWorkflowSession({ projectRoot: open.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow, adapter: open.adapter, owner: { pid: 1, processMarker: "m", nonce: "held", verifyDead: () => false } });
  const runtime = new WorkflowRunLifecycle({ projectRoot: open.projectRoot, projectId: "p", sessionId: selected.link.workflowSessionId, snapshotId: selected.link.activationHash, rootNodeId: "root", createRunId: () => "open" });
  runtime.recordUserInput({ inputId: "input", text: "work", source: "interactive" });
  await assert.rejects(() => reloadWorkflowSession({ projectRoot: open.projectRoot, projectId: "p", currentPiSessionId: selected.link.piSessionId, adapter: open.adapter, owner: { pid: 1, processMarker: "m", nonce: "held", verifyDead: () => false }, prepareActivation: () => ({ workflow }) }), /idle workflow/i);

  for (const candidate of [{ ...workflow, workflowId: "other" }, { ...workflow, source: "stale" as const }, { ...workflow, freshEnabled: false }]) {
    const f = setup();
    const current = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow, adapter: f.adapter, owner: { pid: 1, processMarker: "m", nonce: "held", verifyDead: () => false } });
    await assert.rejects(() => reloadWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: current.link.piSessionId, adapter: f.adapter, owner: { pid: 1, processMarker: "m", nonce: "held", verifyDead: () => false }, prepareActivation: () => ({ workflow: candidate }) }), /fresh-compatible workflow/i);
  }
});

test("fresh creation releases newly acquired prior ownership when the adapter fails", async () => {
  const f = setup();
  const selected = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow, adapter: f.adapter, owner: { pid: 1, processMarker: "m", nonce: "original", verifyDead: () => true } });
  assert.equal(releaseRuntimeOwnership(f.projectRoot, selected.link.workflowSessionId, "original"), true);
  const failing = { ...f.adapter, async create() { throw new Error("fresh create failed"); } };
  await assert.rejects(() => selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: selected.link.piSessionId, workflow, fresh: true, adapter: failing, owner: { pid: 2, processMarker: "m2", nonce: "replacement", verifyDead: () => true } }), /fresh create failed/i);
  const reacquired = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow, adapter: f.adapter, owner: { pid: 3, processMarker: "m3", nonce: "after-fault", verifyDead: () => true } });
  assert.equal(reacquired.kind, "resumed");
});

test("corrupt ownership state is not mistaken for an absent owner", async () => {
  const f = setup();
  const selected = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow, adapter: f.adapter, owner: { pid: 1, processMarker: "m", nonce: "owner", verifyDead: () => true } });
  writeFileSync(join(f.projectRoot, ".pi/hive/sessions", selected.link.workflowSessionId, "runtime-owner.json"), "not-json");
  await assert.rejects(() => selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: selected.link.piSessionId, workflow, adapter: f.adapter, owner: { pid: 2, processMarker: "m2", nonce: "other", verifyDead: () => true } }), /Unexpected|JSON|owner/i);
});

test("exit from normal chat does not require workflow ownership and cancellation stays fail-closed", async () => {
  const f = setup();
  assert.equal((await exitWorkflowSession({ projectRoot: f.projectRoot, currentPiSessionId: "normal", ownerNonce: "none", adapter: f.adapter })).piSessionId, "normal");
  const cancelledAdapter = { ...f.adapter, async switch() { return { cancelled: true }; } };
  await assert.rejects(() => exitWorkflowSession({ projectRoot: f.projectRoot, currentPiSessionId: "normal", ownerNonce: "none", adapter: cancelledAdapter }), /switch cancelled/i);

  const selected = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "p", currentPiSessionId: "normal", workflow, adapter: f.adapter, owner: { pid: 1, processMarker: "m", nonce: "exit-owner", verifyDead: () => true } });
  const releasingAdapter = {
    ...f.adapter,
    async switch(input: any) {
      await input.withSession({});
      assert.equal(releaseRuntimeOwnership(f.projectRoot, selected.link.workflowSessionId, "exit-owner"), true);
      return { cancelled: false };
    },
  };
  await assert.rejects(() => exitWorkflowSession({ projectRoot: f.projectRoot, currentPiSessionId: selected.link.piSessionId, ownerNonce: "exit-owner", adapter: releasingAdapter }), /ownership release failed/i);
});
