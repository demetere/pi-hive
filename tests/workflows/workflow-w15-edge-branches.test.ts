import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readHandoffState } from "../../src/workflows/handoff.ts";
import { reloadWorkflowSession, resolveHandoffSource, selectWorkflowSession } from "../../src/workflows/navigation.ts";
import { releaseRuntimeOwnership } from "../../src/workflows/ownership.ts";
import { WorkflowRunLifecycle } from "../../src/workflows/runs.ts";
import { initializeNormalParent, listSessionLinks, replaceSessionLinks, type NormalSessionLink, type WorkflowSessionLink } from "../../src/workflows/sessions.ts";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const workflow = (workflowId: string, character: string) => ({
  workflowId,
  activationHash: character.repeat(64),
  source: "current" as const,
  resumable: true,
  freshEnabled: true,
  model: "provider/model",
  thinking: "medium",
  tools: ["read"],
});
const owner = (nonce: string) => ({ pid: 100, processMarker: `marker-${nonce}`, nonce, verifyDead: () => true });

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-w15-edges-"));
  initializeNormalParent({ configured: true, projectRoot, projectId: "project-1", piSessionId: "normal", piSessionFile: "/pi/normal", model: "provider/normal", thinking: "low", activeTools: ["read"] });
  let next = 0;
  let compensations = 0;
  const adapter = {
    async create() {
      next += 1;
      return { piSessionId: `pi-${next}`, piSessionFile: `/pi/${next}.jsonl` };
    },
    cleanup() { compensations += 1; },
    async switch(input: { withSession: (ctx: unknown) => Promise<void> | void }) {
      await input.withSession({});
      return { cancelled: false };
    },
  };
  return { projectRoot, adapter, compensations: () => compensations };
}

async function finishSource(projectRoot: string, sessionId: string, snapshotId: string) {
  const runtime = new WorkflowRunLifecycle({
    projectRoot,
    projectId: "project-1",
    sessionId,
    snapshotId,
    rootNodeId: "root",
    createRunId: () => "source-run",
    completion: {
      evidence: () => ({ state: "satisfied" }),
      artifacts: () => ({ state: "satisfied" }),
      projectState: () => ({ state: "satisfied", changeCoverage: "recorded", fileChanges: [] }),
    },
  });
  runtime.recordUserInput({ inputId: "source-input", text: "prepare handoff", source: "interactive" });
  const delivery = runtime.prepareInputDelivery("source-delivery");
  runtime.confirmInputDelivery(delivery.requestId);
  const result = await runtime.finish({
    status: "completed",
    summary: "source complete",
    artifactRefs: [],
    evidenceRefs: [{ kind: "test", claim: "source verified" }],
    data: { digest: digest("d") },
  }, { callerNodeId: "root", toolBatch: ["workflow_finish"] });
  assert.equal(result.ok, true);
}

test("W15 reload preserves a staged handoff and compensates navigation races after staging", async () => {
  const f = fixture();
  const source = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: "normal", workflow: workflow("plan", "a"), adapter: f.adapter, owner: owner("source") });
  await finishSource(f.projectRoot, source.link.workflowSessionId, source.link.activationHash);
  const packet = resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "project-1", runId: "source-run", currentPiSessionId: source.link.piSessionId });
  const target = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: source.link.piSessionId, workflow: workflow("build", "b"), fresh: true, stagedHandoff: packet, adapter: f.adapter, owner: owner("target") });

  const reloaded = await reloadWorkflowSession({
    projectRoot: f.projectRoot,
    projectId: "project-1",
    currentPiSessionId: target.link.piSessionId,
    adapter: f.adapter,
    owner: owner("target"),
    prepareActivation: () => ({ workflow: workflow("build", "c") }),
  });
  assert.equal(readHandoffState(f.projectRoot, reloaded.link.workflowSessionId).staged?.packetHash, packet.packetHash);

  assert.equal(releaseRuntimeOwnership(f.projectRoot, reloaded.link.workflowSessionId, "target"), true);
  const cancellingAdapter = { ...f.adapter, async switch() { return { cancelled: true }; } };
  await assert.rejects(() => selectWorkflowSession({
    projectRoot: f.projectRoot,
    projectId: "project-1",
    currentPiSessionId: reloaded.link.piSessionId,
    workflow: workflow("build", "c"),
    adapter: cancellingAdapter,
    owner: owner("cancelled-resume"),
  }), /switch cancelled/i);

  const current = listSessionLinks(f.projectRoot).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.workflowSessionId === reloaded.link.workflowSessionId)!;
  await assert.rejects(() => selectWorkflowSession({
    projectRoot: f.projectRoot,
    projectId: "project-1",
    currentPiSessionId: current.piSessionId,
    workflow: workflow("build", "d"),
    fresh: true,
    stagedHandoff: packet,
    adapter: f.adapter,
    owner: owner("handoff-race"),
    beforeCommit: () => {
      const links = listSessionLinks(f.projectRoot);
      const racer: WorkflowSessionLink = { ...current, workflowSessionId: "workflow-racer", piSessionId: "pi-racer", piSessionFile: "/pi/racer.jsonl", activationHash: "e".repeat(64), name: "hive:build:racer" };
      replaceSessionLinks(f.projectRoot, [...links.filter((entry) => entry.kind !== "workflow" || entry.workflowId !== "build"), racer]);
    },
  }), /concurrent workflow selection/i);
  assert.equal(f.compensations(), 1);
  assert.equal(readHandoffState(f.projectRoot, current.workflowSessionId).staged?.packetHash, packet.packetHash);
});

test("W15 reload accepts a durable current link whose journal has not recorded an event yet", async () => {
  const f = fixture();
  const normal = listSessionLinks(f.projectRoot).find((entry): entry is NormalSessionLink => entry.kind === "normal")!;
  const current: WorkflowSessionLink = {
    kind: "workflow",
    formatVersion: 1,
    workflowSessionId: "workflow-empty-journal",
    workflowId: "build",
    activationHash: "a".repeat(64),
    piSessionId: "pi-empty-journal",
    piSessionFile: "/pi/empty-journal.jsonl",
    normalParentId: normal.piSessionId,
    normalParentFile: normal.piSessionFile,
    status: "current",
    stale: false,
    model: "provider/model",
    thinking: "medium",
    tools: ["read"],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    name: "hive:build:empty",
  };
  replaceSessionLinks(f.projectRoot, [normal, current]);

  const reloaded = await reloadWorkflowSession({
    projectRoot: f.projectRoot,
    projectId: "project-1",
    currentPiSessionId: current.piSessionId,
    adapter: f.adapter,
    owner: owner("empty-journal"),
    prepareActivation: () => ({ workflow: workflow("build", "b") }),
  });
  assert.equal(reloaded.kind, "created");
  assert.equal(reloaded.link.activationHash, "b".repeat(64));
});
