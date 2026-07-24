import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { RunOrchestrationService } from "../../src/workflows/orchestration.ts";
import { acquireRuntimeOwnership } from "../../src/workflows/ownership.ts";

function snapshot(): ActivationSnapshotFileV1 {
  return {
    snapshotHash: "c".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      project: { projectId: "project-1", rootRef: "." },
      workflow: {
        id: "chat",
        artifact: { adapter: "none", adapterVersion: "1", profile: "default", profileVersion: "1", binding: "none", options: {}, optionsSchemaVersion: "1", contractVersion: "pi-hive-artifact-contract-v1", checkpoints: [], actionIds: [], viewVersion: 1, approvals: {} },
        team: { rootId: "root", nodes: [{ id: "root", agentId: "lead", memberIds: [], depth: 1, responsibilities: [] }] },
      },
      authority: { capabilityContractVersion: 1, nodes: [{ nodeId: "root", capabilities: { effective: { artifact: [] }, budgets: {}, attachments: { skills: [], knowledge: [] }, directMemberIds: [] }, tools: ["workflow_finish", "workflow_status"], model: "model", thinking: "low" }] },
      agents: [{ id: "lead", name: "Lead", tags: [], prompt: "lead" }],
      skills: [], knowledge: [], models: [{ nodeId: "root", modelId: "model", thinking: "low", staticTokens: 1, dynamicReserve: 1, contextWindow: 100_000 }], sources: [], versions: {},
    },
  } as unknown as ActivationSnapshotFileV1;
}

test("none binds atomically at run creation and permits standard completion without artifact refs", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-none-run-"));
  assert.equal(acquireRuntimeOwnership(projectRoot, "session-1", { nonce: "owner-1" }).ok, true);
  const service = new RunOrchestrationService({
    projectRoot,
    projectId: "project-1",
    sessionId: "session-1",
    snapshot: snapshot(),
    runtimeOwnerNonce: "owner-1",
    maxParallel: 1,
    workerFactory: async () => ({ linkedSessionId: "unused", prompt: async () => "unused", dispose() {} }),
    createRunId: () => "run-1",
    pauseAuthority: { captureState: () => ({}), releaseLeases: () => {}, releaseOwnership: () => {} },
    resumeAuthority: { acquireOwnership: () => {}, acquireLeases: () => {}, revalidateHashes: () => true, rollbackAuthority: () => {} },
    cancellationAuthority: { terminateProcessTrees: () => {}, capturePartialState: () => ({}), releaseLeases: () => {} },
  });

  service.lifecycle.recordUserInput({ inputId: "input-1", text: "answer", source: "interactive" });
  const run = service.lifecycle.restore().latestRun!;
  assert.deepEqual(run.artifactWorkspace?.workspace, { id: "none", kind: "logical-empty" });
  assert.equal(run.artifactWorkspace?.path, undefined);
  assert.deepEqual(run.artifactWorkspace?.actionIds, []);
  assert.deepEqual(run.artifactWorkspace?.checkpointIds, []);

  service.lifecycle.prepareInputDelivery("delivery-1");
  service.lifecycle.confirmInputDelivery("delivery-1");
  const completed = await service.lifecycle.finish(
    { status: "completed", summary: "Done.", artifactRefs: [], evidenceRefs: [], data: {} },
    { callerNodeId: "root", toolBatch: ["workflow_finish"] },
  );
  assert.equal(completed.ok, true, completed.ok ? undefined : completed.issues.join("; "));
  assert.equal(service.lifecycle.restore().latestRun?.status, "completed");
});
