import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CheckpointApprovalService,
  type CheckpointApprovalServiceOptions,
} from "../../src/artifacts/approvals.ts";
import { ARTIFACT_CONTRACT_VERSION, ARTIFACT_PROFILE_VERSION } from "../../src/artifacts/contracts.ts";
import { hashArtifactWorkspace } from "../../src/artifacts/hashes.ts";
import { WorkspaceLeaseRuntime } from "../../src/artifacts/leases.ts";
import type { ArtifactWorkspaceBinding } from "../../src/artifacts/types.ts";
import { createWorkflowEvent } from "../../src/workflows/events.ts";
import { appendWorkflowEvent, readWorkflowJournal } from "../../src/workflows/journal.ts";
import { WorkflowRunLifecycle, type FinishResult } from "../../src/workflows/runs.ts";

const POLICIES = { required: "required", optional: "optional", skipped: "none" } as const;
const rootBatch = { callerNodeId: "root", toolBatch: ["workflow_finish"] } as const;
const issues = (result: FinishResult) => result.ok ? "" : result.issues.join("\n");

function fixture(label: string, overrides: Partial<CheckpointApprovalServiceOptions> = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), `hive-approvals-${label}-`));
  const workspacePath = join(projectRoot, "workspace");
  mkdirSync(workspacePath);
  writeFileSync(join(workspacePath, "artifact.md"), "# Artifact\n\ninitial\n");
  const workspaceHash = hashArtifactWorkspace(workspacePath).workspaceHash;
  const binding: ArtifactWorkspaceBinding = Object.freeze({
    schemaVersion: 1,
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    adapterId: "fixture",
    adapterVersion: "1",
    profileId: "author",
    profileVersion: ARTIFACT_PROFILE_VERSION,
    binding: "existing",
    selection: "existing",
    workspace: Object.freeze({ id: "work", kind: "physical" as const }),
    path: workspacePath,
    workspaceHash,
    writerLease: Object.freeze({ required: true }),
    checkpointIds: Object.freeze(Object.keys(POLICIES)),
    actionIds: Object.freeze([]),
  });
  let requestNumber = 0;
  let decisionNumber = 0;
  let clock = 0;
  const options: CheckpointApprovalServiceOptions = {
    projectRoot,
    projectId: "project-1",
    sessionId: `session-${label}`,
    adapterId: "fixture",
    adapterVersion: "1",
    profileId: "author",
    profileVersion: "1",
    profileSchemaVersion: "1",
    checkpointPolicies: POLICIES,
    resolveDescriptor: ({ checkpointId }) => ({
      formatVersion: 1,
      adapterId: "fixture",
      adapterVersion: "1",
      profileId: "author",
      profileVersion: "1",
      profileSchemaVersion: "1",
      checkpointId,
      checkpointVersion: "1",
      contributors: [{ kind: "file", path: "artifact.md" }],
    }),
    authenticateControl: ({ credential, channel }) => credential === `${channel}-secret`
      ? { approverId: "human-1", authenticationId: `auth-${channel}`, mechanism: channel === "dashboard" ? "bearer" : "explicit-tui" }
      : undefined,
    createRequestId: () => `request-${++requestNumber}`,
    createDecisionId: () => `decision-${++decisionNumber}`,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
    ...overrides,
  };
  const service = new CheckpointApprovalService(options);
  let runNumber = 0;
  const lifecycle = new WorkflowRunLifecycle({
    projectRoot,
    projectId: "project-1",
    sessionId: `session-${label}`,
    snapshotId: "snapshot-1",
    rootNodeId: "root",
    createRunId: () => `run-${++runNumber}`,
    createArtifactWorkspace: () => binding,
    checkpointSnapshots: service.runSnapshotProvider(),
    completion: {
      approvals: () => service.completionGate({ expectedWorkspaceHash: hashArtifactWorkspace(workspacePath).workspaceHash }),
      evidence: (refs) => ({ state: refs.length ? "satisfied" : "not-present" }),
      artifacts: () => ({ state: "satisfied" }),
      projectState: () => ({ state: "satisfied", fileChanges: [], changeCoverage: "recorded" }),
      settleTerminal: () => {},
    },
  });
  const start = (inputId = `input-${runNumber + 1}`) => lifecycle.recordUserInput({ inputId, text: "work", source: "interactive" });
  const deliver = (id = `delivery-${runNumber}`) => { lifecycle.prepareInputDelivery(id); lifecycle.confirmInputDelivery(id); };
  const lease = (runId = lifecycle.restore().latestRun!.runId) => new WorkspaceLeaseRuntime({
    projectRoot, adapterId: "fixture", workspaceId: "work", sessionId: `session-${label}`, runId,
  });
  return { projectRoot, workspacePath, binding, service, lifecycle, start, deliver, lease };
}

async function approve(f: ReturnType<typeof fixture>, checkpointId: string, operation = checkpointId) {
  const currentHash = hashArtifactWorkspace(f.workspacePath).workspaceHash;
  const lease = f.lease();
  assert.equal(lease.acquire().ok, true);
  const request = await f.service.requestApproval({ operationId: `request-op-${operation}`, checkpointId, expectedWorkspaceHash: currentHash });
  const decision = await f.service.decide({
    operationId: `decision-op-${operation}`,
    requestId: request.requestId,
    expectedRequestSequence: request.requestSequence,
    digest: request.digest,
    expectedWorkspaceHash: currentHash,
    decision: "approved",
  }, { channel: "dashboard", mode: "headless", dashboardAvailable: true, credential: "dashboard-secret" });
  lease.release();
  return { request, decision };
}

test("required/optional/none defaults are explicit, idle-only, and frozen independently into each run", async () => {
  const initial = fixture("policy-initial-on");
  const initialRun = initial.start();
  assert.deepEqual(initial.lifecycle.restore().latestRun!.checkpointSnapshot!.enabledCheckpointIds, ["optional", "required"], "optional checkpoints fail safe to on until an idle default event disables them");
  assert.equal(initial.lifecycle.restore().latestRun!.checkpointSnapshot!.runId, initialRun.runId);

  const f = fixture("policy");
  assert.deepEqual(f.service.nextRunDefaults().map(({ checkpointId, policy, enabled }) => ({ checkpointId, policy, enabled })), [
    { checkpointId: "optional", policy: "optional", enabled: true },
    { checkpointId: "required", policy: "required", enabled: true },
    { checkpointId: "skipped", policy: "none", enabled: false },
  ]);
  assert.throws(() => f.service.setOptionalDefault({ operationId: "default-required", checkpointId: "required", enabled: false, expectedDefaultsRevision: 0 }), /required|optional/i);
  assert.throws(() => f.service.setOptionalDefault({ operationId: "default-none", checkpointId: "skipped", enabled: true, expectedDefaultsRevision: 0 }), /none|optional/i);
  const disabled = f.service.setOptionalDefault({ operationId: "default-disable", checkpointId: "optional", enabled: false, expectedDefaultsRevision: 0 });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.defaultsRevision, f.service.restore().defaultsRevision);

  const first = f.start();
  const firstSnapshot = f.lifecycle.restore().latestRun!.checkpointSnapshot!;
  assert.deepEqual(firstSnapshot.enabledCheckpointIds, ["required"]);
  assert.equal(firstSnapshot.runId, first.runId);
  assert.throws(() => f.service.setOptionalDefault({ operationId: "default-during-run", checkpointId: "optional", enabled: true, expectedDefaultsRevision: disabled.defaultsRevision }), /idle|open run/i);
  await assert.rejects(() => f.service.requestApproval({ operationId: "none-op", checkpointId: "skipped", expectedWorkspaceHash: hashArtifactWorkspace(f.workspacePath).workspaceHash }), /disabled|no human gate|enabled/i);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-policy").filter((event) => event.type === "approval.recorded" && (event.payload as any).operation === "request").length, 0);

  await approve(f, "required", "first-required");
  f.deliver();
  const completed = await f.lifecycle.finish({ status: "completed", summary: "first complete" }, rootBatch);
  assert.equal(completed.ok, true, issues(completed));

  f.service.setOptionalDefault({ operationId: "default-enable", checkpointId: "optional", enabled: true, expectedDefaultsRevision: f.service.restore().defaultsRevision });
  const second = f.start("second-input");
  const secondSnapshot = f.lifecycle.restore().latestRun!.checkpointSnapshot!;
  assert.deepEqual(secondSnapshot.enabledCheckpointIds, ["optional", "required"]);
  assert.equal(secondSnapshot.runId, second.runId);
  assert.deepEqual(firstSnapshot.enabledCheckpointIds, ["required"], "later defaults cannot mutate a prior frozen snapshot");
});

test("optional-default control uses caller operation CAS and lost-response replay never overwrites a later change", () => {
  let injected = false;
  const f = fixture("default-cas", {
    fault(operation, stage) {
      if (!injected && operation === "default" && stage === "afterRename") {
        injected = true;
        throw new Error("simulated lost default response");
      }
    },
  });
  const first = f.service.setOptionalDefault({ operationId: "default-first", checkpointId: "optional", enabled: false, expectedDefaultsRevision: 0 });
  assert.equal(first.enabled, false);
  assert.ok(first.defaultsRevision > 0);
  assert.throws(() => f.service.setOptionalDefault({ operationId: "default-stale", checkpointId: "optional", enabled: true, expectedDefaultsRevision: 0 }), /revision|CAS|stale/i);

  const later = f.service.setOptionalDefault({ operationId: "default-later", checkpointId: "optional", enabled: true, expectedDefaultsRevision: first.defaultsRevision });
  assert.equal(later.enabled, true);
  const replay = f.service.setOptionalDefault({ operationId: "default-first", checkpointId: "optional", enabled: false, expectedDefaultsRevision: 0 });
  assert.deepEqual(replay, first, "the original bounded result is replayed instead of reapplying the old value");
  assert.equal(f.service.nextRunDefaults().find((entry) => entry.checkpointId === "optional")?.enabled, true);
  assert.throws(() => f.service.setOptionalDefault({ operationId: "default-first", checkpointId: "optional", enabled: true, expectedDefaultsRevision: later.defaultsRevision }), /operation.*reuse|different input/i);
  const defaults = readWorkflowJournal(f.projectRoot, "session-default-cas")
    .filter((event) => event.type === "approval.recorded" && (event.payload as any).operation === "default-set");
  assert.equal(defaults.length, 2);
});

test("checkpoint replay ignores approval events owned by another subsystem", () => {
  const f = fixture("unrelated-approval");
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: "project-1",
    sessionId: "session-unrelated-approval",
    type: "approval.recorded",
    producer: "harness",
    payload: { formatVersion: 99, subsystem: "future-approval", operation: "record" },
  }));
  assert.deepEqual(f.service.nextRunDefaults().map(({ checkpointId, enabled }) => ({ checkpointId, enabled })), [
    { checkpointId: "optional", enabled: true },
    { checkpointId: "required", enabled: true },
    { checkpointId: "skipped", enabled: false },
  ]);
});

test("a run with no enabled human gates has a neutral completion result without workspace-hash authority", async () => {
  const f = fixture("no-gates", { checkpointPolicies: { required: "none", optional: "none", skipped: "none" } });
  f.start();
  assert.deepEqual(await f.service.completionGate({}), { state: "not-present" });
  assert.equal(readWorkflowJournal(f.projectRoot, "session-no-gates").some((event) => event.type === "approval.recorded" && (event.payload as any).operation === "request"), false);
});

test("completion requires every enabled exact-digest decision while blocked/failed persist unsatisfied checkpoint evidence", async () => {
  const completed = fixture("completion");
  completed.service.setOptionalDefault({ operationId: "default-completion", checkpointId: "optional", enabled: false, expectedDefaultsRevision: 0 });
  completed.start();
  completed.deliver();
  const missing = await completed.lifecycle.finish({ status: "completed", summary: "not actually complete" }, rootBatch);
  assert.equal(missing.ok, false);
  assert.match(issues(missing), /required.*missing|checkpoint|approval/i);
  await approve(completed, "required", "completion-required");
  const success = await completed.lifecycle.finish({ status: "completed", summary: "complete now" }, rootBatch);
  assert.equal(success.ok, true, issues(success));

  for (const status of ["blocked", "failed"] as const) {
    const f = fixture(`terminal-${status}`);
    f.service.setOptionalDefault({ operationId: `default-${status}`, checkpointId: "optional", enabled: false, expectedDefaultsRevision: 0 });
    f.start();
    f.deliver();
    const result = await f.lifecycle.finish({
      status,
      summary: `${status} due to external dependency`,
      evidenceRefs: [{ kind: "tool-result", claim: "dependency unavailable" }],
    }, rootBatch);
    assert.equal(result.ok, true, issues(result));
    if (!result.ok) continue;
    assert.ok(result.envelope.unsatisfiedGates.some((gate) => /required|checkpoint|approval/i.test(gate)));
  }
});

test("handoff approval references remain evidence only and never satisfy a target run", async () => {
  const source = fixture("handoff-source");
  source.service.setOptionalDefault({ operationId: "default-source", checkpointId: "optional", enabled: false, expectedDefaultsRevision: 0 });
  source.start();
  const { request } = await approve(source, "required", "source");

  const target = fixture("handoff-target");
  target.service.setOptionalDefault({ operationId: "default-target", checkpointId: "optional", enabled: false, expectedDefaultsRevision: 0 });
  target.start();
  target.deliver();
  const denied = await target.lifecycle.finish({
    status: "completed",
    summary: "forged carryover",
    artifactRefs: [{ workspaceId: "work", checkpoint: "required", digest: request.digest }],
  }, rootBatch);
  assert.equal(denied.ok, false);
  assert.match(issues(denied), /required|checkpoint|approval/i);
});
