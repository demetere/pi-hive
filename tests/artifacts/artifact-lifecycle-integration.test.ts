import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_PROFILE_VERSION,
} from "../../src/artifacts/contracts.ts";
import { hashArtifactWorkspace } from "../../src/artifacts/hashes.ts";
import { WorkspaceLeaseRuntime, inspectWorkspaceLease } from "../../src/artifacts/leases.ts";
import type { ArtifactWorkspaceBinding } from "../../src/artifacts/types.ts";
import { acquireRuntimeOwnership } from "../../src/workflows/ownership.ts";
import { WorkflowRunLifecycle } from "../../src/workflows/runs.ts";

function fixture(label: string) {
  const projectRoot = mkdtempSync(join(tmpdir(), `hive-artifact-lifecycle-${label}-`));
  const workspacePath = join(projectRoot, "workspace");
  mkdirSync(workspacePath);
  writeFileSync(join(workspacePath, "state.txt"), "initial");
  const hash = hashArtifactWorkspace(workspacePath).workspaceHash;
  const binding: ArtifactWorkspaceBinding = Object.freeze({
    schemaVersion: 1, contractVersion: ARTIFACT_CONTRACT_VERSION, adapterId: "fixture", adapterVersion: "1",
    profileId: "author", profileVersion: ARTIFACT_PROFILE_VERSION, binding: "existing", selection: "existing",
    workspace: Object.freeze({ id: "shared", kind: "physical" as const }), path: workspacePath, workspaceHash: hash,
    writerLease: Object.freeze({ required: true }), checkpointIds: Object.freeze([]), actionIds: Object.freeze([]),
  });
  const lifecycle = new WorkflowRunLifecycle({
    projectRoot, projectId: "project-1", sessionId: `session-${label}`, snapshotId: "snapshot-1", rootNodeId: "root", createRunId: () => `run-${label}`,
    ...(label === "cancel" ? { runtimeOwnerNonce: "runtime-owner" } : {}),
  });
  lifecycle.recordUserInput({ inputId: `input-${label}`, text: "work", source: "interactive" });
  lifecycle.bindArtifactWorkspace(binding);
  const lease = new WorkspaceLeaseRuntime({ projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId: `session-${label}`, runId: `run-${label}` });
  assert.equal(lease.acquire().ok, true);
  return { projectRoot, workspacePath, binding, lifecycle, lease };
}

function release(f: ReturnType<typeof fixture>, reason: "pause" | "cancel" | "finish") {
  return f.lease.releaseForLifecycle(reason, hashArtifactWorkspace(f.workspacePath).workspaceHash);
}

test("pause releases the physical writer lease and resume reacquires only after unchanged hash validation", async () => {
  const f = fixture("pause");
  await f.lifecycle.pause("pause", {
    captureState: () => ({ workspaceHash: hashArtifactWorkspace(f.workspacePath).workspaceHash }),
    releaseLeases: () => { release(f, "pause"); },
  });
  assert.equal(inspectWorkspaceLease(f.projectRoot, "fixture", "shared").state, "available");

  let rollback = 0;
  const resumed = await f.lifecycle.resume({
    acquireOwnership: () => {},
    acquireLeases: () => { const acquired = f.lease.acquire(); if (!acquired.ok) throw new Error(acquired.reason); },
    revalidateHashes: (state) => state.workspaceHash === hashArtifactWorkspace(f.workspacePath).workspaceHash,
    rollbackAuthority: () => { rollback++; f.lease.release(); },
  });
  assert.equal(resumed, true);
  assert.equal(rollback, 0);
  assert.equal(f.lifecycle.restore().latestRun?.status, "running");
  assert.equal(f.lease.hasLiveHeartbeat(), true, "resume acquisition restarts writer heartbeat");
  assert.equal(f.lease.release(), true);
  assert.equal(f.lease.hasLiveHeartbeat(), false);
});

test("resume stays paused on changed hashes or another fresh writer and never steals or auto-forks", async () => {
  const changed = fixture("changed");
  await changed.lifecycle.pause("pause", {
    captureState: () => ({ workspaceHash: hashArtifactWorkspace(changed.workspacePath).workspaceHash }),
    releaseLeases: () => { release(changed, "pause"); },
  });
  writeFileSync(join(changed.workspacePath, "state.txt"), "external change");
  let changedRollback = 0;
  await assert.rejects(() => changed.lifecycle.resume({
    acquireOwnership: () => {},
    acquireLeases: () => { const acquired = changed.lease.acquire(); if (!acquired.ok) throw new Error(acquired.reason); },
    revalidateHashes: (state) => state.workspaceHash === hashArtifactWorkspace(changed.workspacePath).workspaceHash,
    rollbackAuthority: () => { changedRollback++; changed.lease.release(); },
  }), /hash.*revalidation/i);
  assert.equal(changedRollback, 1);
  assert.equal(changed.lifecycle.restore().latestRun?.status, "paused");

  const conflict = fixture("conflict");
  await conflict.lifecycle.pause("pause", {
    captureState: () => ({ workspaceHash: hashArtifactWorkspace(conflict.workspacePath).workspaceHash }),
    releaseLeases: () => { release(conflict, "pause"); },
  });
  const other = new WorkspaceLeaseRuntime({ projectRoot: conflict.projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId: "other-session", runId: "other-run" });
  assert.equal(other.acquire().ok, true);
  let conflictRollback = 0;
  await assert.rejects(() => conflict.lifecycle.resume({
    acquireOwnership: () => {},
    acquireLeases: () => { const acquired = conflict.lease.acquire(); if (!acquired.ok) throw new Error(acquired.reason); },
    revalidateHashes: () => true,
    rollbackAuthority: () => { conflictRollback++; conflict.lease.release(); },
  }), /fresh|stolen|writer/i);
  assert.equal(conflictRollback, 1);
  assert.equal(conflict.lifecycle.restore().latestRun?.status, "paused");
  assert.equal(other.release(), true);
});

test("cancel and successful finish release leases with final hash evidence", async () => {
  const cancelled = fixture("cancel");
  assert.equal(acquireRuntimeOwnership(cancelled.projectRoot, "session-cancel", { nonce: "runtime-owner" }).ok, true);
  const cancelledResult = await cancelled.lifecycle.cancel("stop", {
    waitForSettlement: () => true,
    terminateProcessTrees: () => {},
    releaseLeases: () => { assert.equal(release(cancelled, "cancel").released, true); },
  });
  assert.equal(cancelledResult.envelope.status, "cancelled");
  assert.equal(inspectWorkspaceLease(cancelled.projectRoot, "fixture", "shared").state, "available");

  const finished = fixture("finish");
  const runtime = new WorkflowRunLifecycle({
    ...finished.lifecycle.options,
    completion: {
      adapter: () => ({ state: "satisfied" }),
      projectState: () => ({ state: "satisfied", changeCoverage: "recorded", fileChanges: [] }),
      settleTerminal: () => { assert.equal(release(finished, "finish").released, true); },
    },
  });
  runtime.prepareInputDelivery("delivery-finish");
  runtime.confirmInputDelivery("delivery-finish");
  const result = await runtime.finish({ status: "completed", summary: "done" }, { callerNodeId: "root", toolBatch: ["workflow_finish"] });
  assert.equal(result.ok, true);
  assert.equal(inspectWorkspaceLease(finished.projectRoot, "fixture", "shared").state, "available");
});
