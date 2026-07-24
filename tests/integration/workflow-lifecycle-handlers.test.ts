import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkflowLifecycleServiceHandlers } from "../../src/integration/workflow-lifecycle-handlers.ts";
import { initializeNormalParent } from "../../src/workflows/sessions.ts";

test("schema-v1 lifecycle service handlers expose control operations without registering or invoking legacy commands", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-lifecycle-handlers-"));
  initializeNormalParent({ configured: true, projectRoot, projectId: "project-1", piSessionId: "normal", piSessionFile: "/pi/normal", model: "provider/normal", thinking: "low", activeTools: [] });
  let currentPiSessionId = "normal";
  let created = 0;
  const adapter = {
    async create() { created += 1; return { piSessionId: `pi-${created}`, piSessionFile: `/pi/${created}` }; },
    async switch(input: { piSessionFile: string; withSession: (ctx: unknown) => Promise<void> | void }) { await input.withSession({}); return { cancelled: false }; },
  };
  const handlers = createWorkflowLifecycleServiceHandlers({
    projectRoot,
    projectId: "project-1",
    currentPiSessionId: () => currentPiSessionId,
    adapter,
    owner: () => ({ pid: 123, processMarker: "marker", nonce: "owner", verifyDead: () => true }),
  });
  assert.deepEqual(Object.keys(handlers).sort(), ["clearHandoff", "detectOrphans", "recover", "reload", "select"]);
  const selected = await handlers.select({ workflow: { workflowId: "build", activationHash: "a".repeat(64), source: "current", resumable: true, freshEnabled: true, model: "provider/model", thinking: "medium", tools: [] } });
  currentPiSessionId = selected.link.piSessionId;
  assert.equal(selected.kind, "created");
  assert.equal(created, 1);
  assert.equal(handlers.clearHandoff(selected.link.workflowSessionId).cleared, false);
  assert.deepEqual(handlers.detectOrphans(), [{ workflowSessionId: selected.link.workflowSessionId, workflowId: "build", piSessionId: selected.link.piSessionId, piSessionFile: selected.link.piSessionFile, orphaned: true }]);
  assert.throws(() => handlers.recover(selected.link.workflowSessionId, { validateActivation: () => ({ ok: true, codes: [] }) }), /mandatory runtime.*navigation dependencies/i);
  assert.equal(created, 1, "public recovery blocks before Pi navigation when mandatory dependencies are absent");
});

test("lifecycle handlers forward optional selectors, fresh reloads, CAS clears, and recovery dependency faults", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-lifecycle-edges-"));
  initializeNormalParent({ configured: true, projectRoot, projectId: "project-1", piSessionId: "normal", piSessionFile: "/pi/normal", model: "provider/normal", thinking: "low", activeTools: [] });
  let currentPiSessionId = "normal";
  let next = 0;
  const adapter = {
    async create() { next += 1; return { piSessionId: `pi-${next}`, piSessionFile: `/pi/${next}` }; },
    async switch(input: { withSession: (ctx: unknown) => Promise<void> | void }) { await input.withSession({}); return { cancelled: false }; },
  };
  const base = {
    projectRoot, projectId: "project-1", currentPiSessionId: () => currentPiSessionId, adapter,
    owner: () => ({ pid: 123, processMarker: "marker", nonce: "owner", verifyDead: () => true }),
  };
  const workflow = { workflowId: "build", activationHash: "a".repeat(64), source: "current" as const, resumable: true, freshEnabled: true, model: "provider/model", thinking: "medium", tools: [] };
  const handlers = createWorkflowLifecycleServiceHandlers(base);
  await assert.rejects(() => handlers.select({ workflow, from: "last", packet: {} as never }), /either a source selector/i);
  await assert.rejects(() => handlers.select({ workflow, from: "missing" }), /source run is missing/i);
  await assert.rejects(() => handlers.select({ workflow, packet: {} as never }), /handoff packet.*(?:invalid|missing)/i);

  const selected = await handlers.select({ workflow, fresh: true });
  currentPiSessionId = selected.link.piSessionId;
  assert.equal(handlers.clearHandoff(selected.link.workflowSessionId, "f".repeat(64)).cleared, false);
  const reloaded = await handlers.reload(() => ({ workflow, validateBeforeCommit: () => {} }));
  currentPiSessionId = reloaded.link.piSessionId;
  assert.equal(reloaded.kind, "created");

  const noRuntime = createWorkflowLifecycleServiceHandlers({ ...base, recovery: { runtime: () => undefined as never, currentPiSessionFile: () => "/pi/normal" } });
  assert.throws(() => noRuntime.recover(reloaded.link.workflowSessionId), /dependencies are incomplete/i);
  const noRestore = createWorkflowLifecycleServiceHandlers({ ...base, recovery: { runtime: () => ({}) as never, currentPiSessionFile: () => "" } });
  assert.throws(() => noRestore.recover(reloaded.link.workflowSessionId), /dependencies are incomplete/i);
});
