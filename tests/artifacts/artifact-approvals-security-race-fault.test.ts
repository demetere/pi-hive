import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointApprovalService, createCheckpointControlHandlers } from "../../src/artifacts/approvals.ts";
import { ARTIFACT_CONTRACT_VERSION, ARTIFACT_PROFILE_VERSION } from "../../src/artifacts/contracts.ts";
import { hashArtifactWorkspace } from "../../src/artifacts/hashes.ts";
import { WorkspaceLeaseRuntime } from "../../src/artifacts/leases.ts";
import type { ArtifactWorkspaceBinding } from "../../src/artifacts/types.ts";
import { readWorkflowJournal } from "../../src/workflows/journal.ts";
import { WorkflowRunLifecycle } from "../../src/workflows/runs.ts";

function fixture(
  label: string,
  fault?: (operation: "default" | "request" | "decision", stage: string) => void,
  createDecisionId?: () => string,
  onRunStatusChanged?: (runId: string, status: "running" | "waiting_for_human" | "paused", timestamp: string) => void,
) {
  const projectRoot = mkdtempSync(join(tmpdir(), `hive-approval-security-${label}-`));
  const workspacePath = join(projectRoot, "workspace");
  mkdirSync(workspacePath);
  writeFileSync(join(workspacePath, "declared.md"), "declared-v1\n");
  writeFileSync(join(workspacePath, "unrelated.md"), "unrelated-v1\n");
  const binding: ArtifactWorkspaceBinding = Object.freeze({
    schemaVersion: 1, contractVersion: ARTIFACT_CONTRACT_VERSION, adapterId: "fixture", adapterVersion: "1",
    profileId: "author", profileVersion: ARTIFACT_PROFILE_VERSION, binding: "existing", selection: "existing",
    workspace: Object.freeze({ id: "workspace", kind: "physical" as const }), path: workspacePath,
    workspaceHash: hashArtifactWorkspace(workspacePath).workspaceHash, writerLease: Object.freeze({ required: true }),
    checkpointIds: Object.freeze(["plan"]), actionIds: Object.freeze([]),
  });
  let requestId = 0;
  let decisionId = 0;
  const service = new CheckpointApprovalService({
    projectRoot, projectId: "project", sessionId: `session-${label}`,
    adapterId: "fixture", adapterVersion: "1", profileId: "author", profileVersion: "1", profileSchemaVersion: "1",
    checkpointPolicies: { plan: "required" },
    resolveDescriptor: () => ({
      formatVersion: 1, adapterId: "fixture", adapterVersion: "1", profileId: "author", profileVersion: "1", profileSchemaVersion: "1",
      checkpointId: "plan", checkpointVersion: "1", contributors: [{ kind: "file", path: "declared.md" }],
    }),
    authenticateControl: ({ credential, channel }) => credential === `${channel}:valid`
      ? { approverId: "human", authenticationId: `${channel}-auth`, mechanism: channel === "dashboard" ? "bearer" : "tui-confirmation" }
      : undefined,
    createRequestId: () => `request-${++requestId}`,
    createDecisionId: createDecisionId ?? (() => `decision-${++decisionId}`),
    fault: fault as any,
    onRunStatusChanged,
  });
  const lifecycle = new WorkflowRunLifecycle({
    projectRoot, projectId: "project", sessionId: `session-${label}`, snapshotId: "snapshot", rootNodeId: "root",
    createRunId: () => "run-1", createArtifactWorkspace: () => binding, checkpointSnapshots: service.runSnapshotProvider(),
  });
  lifecycle.recordUserInput({ inputId: "input", text: "prepare checkpoint", source: "interactive" });
  const lease = new WorkspaceLeaseRuntime({ projectRoot, adapterId: "fixture", workspaceId: "workspace", sessionId: `session-${label}`, runId: "run-1" });
  const currentHash = () => hashArtifactWorkspace(workspacePath).workspaceHash;
  const request = async (operationId = "request-op") => {
    let acquired = false;
    try { lease.assertOwned(); }
    catch {
      if (!lease.acquire().ok) throw new Error("Fixture could not acquire its request lease");
      acquired = true;
    }
    try { return await service.requestApproval({ operationId, checkpointId: "plan", expectedWorkspaceHash: currentHash() }); }
    finally { if (acquired) lease.release(); }
  };
  const decide = (approvalRequest: Awaited<ReturnType<typeof request>>, decision: "approved" | "denied", input: Partial<Parameters<typeof service.decide>[0]> = {}, context: Partial<Parameters<typeof service.decide>[1]> = {}) => service.decide({
    operationId: `${decision}-op`, requestId: approvalRequest.requestId, expectedRequestSequence: approvalRequest.requestSequence,
    digest: approvalRequest.digest, expectedWorkspaceHash: currentHash(), decision, ...input,
  }, { channel: "dashboard", mode: "headless", dashboardAvailable: true, credential: "dashboard:valid", ...context });
  return { projectRoot, workspacePath, service, lifecycle, lease, currentHash, request, decide };
}

test("only authenticated dashboard or dashboard-unavailable TUI human actions can decide an exact digest", async () => {
  const f = fixture("channels");
  const request = await f.request();
  assert.equal(f.lifecycle.restore().latestRun?.status, "waiting_for_human");

  for (const attempt of [
    f.decide(request, "approved", {}, { credential: "forged model text" }),
    f.decide(request, "approved", {}, { channel: "model" as any, credential: "dashboard:valid" }),
    f.decide(request, "approved", {}, { channel: "tool" as any, credential: "dashboard:valid" }),
    f.decide(request, "approved", {}, { channel: "tui", mode: "headless", dashboardAvailable: false, credential: "tui:valid" }),
    f.decide(request, "approved", {}, { channel: "tui", mode: "tui", dashboardAvailable: true, credential: "tui:valid" }),
    f.decide(request, "approved", {}, { channel: "dashboard", mode: "headless", dashboardAvailable: false, credential: "dashboard:valid" }),
  ]) await assert.rejects(attempt, /authenticated|channel|dashboard|tui|headless|unavailable/i);
  assert.equal(f.service.restore().requests[request.requestId].decision, undefined);

  assert.equal(f.lease.acquire().ok, true);
  const tuiDecision = await f.decide(request, "approved", {}, { channel: "tui", mode: "tui", dashboardAvailable: false, credential: "tui:valid" });
  assert.equal(tuiDecision.channel, "tui");
  assert.equal(tuiDecision.approverId, "human");
  assert.deepEqual(tuiDecision.provenance, { authenticationId: "tui-auth", mechanism: "tui-confirmation" });
  assert.deepEqual({
    projectId: tuiDecision.projectId, sessionId: tuiDecision.sessionId, runId: tuiDecision.runId,
    workspaceId: tuiDecision.workspaceId, adapterId: tuiDecision.adapterId, profileId: tuiDecision.profileId,
    checkpointId: tuiDecision.checkpointId, checkpointVersion: tuiDecision.checkpointVersion,
  }, {
    projectId: "project", sessionId: "session-channels", runId: "run-1", workspaceId: "workspace",
    adapterId: "fixture", profileId: "author", checkpointId: "plan", checkpointVersion: "1",
  });
  assert.equal(JSON.stringify(tuiDecision).includes("tui:valid"), false, "credentials are never returned or persisted");
  assert.equal(f.lifecycle.restore().latestRun?.status, "running");
  f.lease.release();

  const dashboard = fixture("dashboard-channel");
  const dashboardRequest = await dashboard.request();
  assert.equal(dashboard.lease.acquire().ok, true);
  const dashboardDecision = await dashboard.decide(dashboardRequest, "approved");
  assert.equal(dashboardDecision.channel, "dashboard");
  dashboard.lease.release();
});

test("request and decision validate current lease; decision also validates workspace hash, exact digest, and declared contributors", async () => {
  const f = fixture("validation");
  await assert.rejects(() => f.service.requestApproval({
    operationId: "request-without-lease",
    checkpointId: "plan",
    expectedWorkspaceHash: f.currentHash(),
  }), /lease|owner/i);
  const request = await f.request();
  await assert.rejects(() => f.decide(request, "approved"), /lease|owner/i);
  assert.equal(f.lease.acquire().ok, true);
  await assert.rejects(() => f.decide(request, "approved", { expectedWorkspaceHash: `sha256:${"0".repeat(64)}` }), /hash|conflict/i);
  await assert.rejects(() => f.decide(request, "approved", { digest: `sha256:${"f".repeat(64)}` }), /digest|exact|stale/i);

  writeFileSync(join(f.workspacePath, "unrelated.md"), "unrelated-v2\n");
  const unrelatedDecision = await f.decide(request, "approved");
  assert.equal(unrelatedDecision.digest, request.digest);
  f.lease.release();

  const changed = fixture("declared-change");
  const stale = await changed.request();
  assert.equal(changed.lease.acquire().ok, true);
  writeFileSync(join(changed.workspacePath, "declared.md"), "declared-v2\n");
  await assert.rejects(() => changed.decide(stale, "approved"), /digest|stale|changed/i);
  assert.equal(changed.service.restore().requests[stale.requestId].decision, undefined);
  changed.lease.release();
});

test("first valid approve/deny wins exact-state CAS; replay is idempotent and conflicting reuse/late decisions fail", async () => {
  const f = fixture("race");
  const request = await f.request();
  assert.equal(f.lease.acquire().ok, true);
  const settled = await Promise.allSettled([
    f.decide(request, "approved", { operationId: "race-approve" }),
    f.decide(request, "denied", { operationId: "race-deny" }),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(settled.filter((item) => item.status === "rejected").length, 1);
  const decision = f.service.restore().requests[request.requestId].decision!;
  assert.ok(decision.decision === "approved" || decision.decision === "denied");
  const replayed = await f.decide(request, decision.decision, { operationId: decision.operationId });
  assert.equal(replayed.decisionId, decision.decisionId);
  await assert.rejects(() => f.decide(request, decision.decision === "approved" ? "denied" : "approved", { operationId: decision.operationId }), /operation.*reuse|different|conflict/i);
  await assert.rejects(() => f.decide(request, decision.decision, { operationId: "late-operation" }), /already decided|first.*wins|immutable/i);
  const decisionEvents = readWorkflowJournal(f.projectRoot, "session-race").filter((event) => event.type === "approval.recorded" && (event.payload as any).operation === "decision");
  assert.equal(decisionEvents.length, 1);
  f.lease.release();
});

test("decision IDs remain globally unique across digest revisions", async () => {
  const f = fixture("decision-id", undefined, () => "decision-shared");
  const first = await f.request("first-request");
  assert.equal(f.lease.acquire().ok, true);
  await f.decide(first, "denied", { operationId: "first-denial" });
  writeFileSync(join(f.workspacePath, "declared.md"), "declared-v2\n");
  const second = await f.request("second-request");
  await assert.rejects(() => f.decide(second, "approved", { operationId: "second-approval" }), /decision ID.*duplicated|duplicate.*decision ID/i);
  assert.equal(f.service.restore().requests[second.requestId].decision, undefined);
  f.lease.release();
});

test("denial is immutable for one digest, reopens revision, and changed contributors create a fresh request", async () => {
  const f = fixture("revision");
  const first = await f.request("request-first");
  assert.equal(f.lease.acquire().ok, true);
  const denied = await f.decide(first, "denied", { operationId: "deny-first", feedback: "revise the declared artifact" });
  assert.equal(denied.decision, "denied");
  assert.equal(f.lifecycle.restore().latestRun?.status, "running");

  const exactAgain = await f.request("request-exact-again");
  assert.equal(exactAgain.requestId, first.requestId);
  assert.equal(exactAgain.decision?.decision, "denied");
  await assert.rejects(() => f.decide(first, "approved", { operationId: "overwrite-denial" }), /already decided|immutable|first.*wins/i);

  writeFileSync(join(f.workspacePath, "declared.md"), "declared-v2\n");
  const revised = await f.request("request-revision");
  assert.notEqual(revised.requestId, first.requestId);
  assert.notEqual(revised.digest, first.digest);
  assert.equal(revised.decision, undefined);
  const approved = await f.decide(revised, "approved", { operationId: "approve-revision" });
  assert.equal(approved.decision, "approved");
  f.lease.release();
});

test("request/decision publication faults recover replay-safely without duplicate authority records", async () => {
  const thrown = new Set<string>();
  const statuses: string[] = [];
  const f = fixture("fault", (operation, stage) => {
    if ((operation === "request" || operation === "decision") && stage === "afterRename" && !thrown.has(operation)) {
      thrown.add(operation);
      throw new Error(`crash after ${operation} rename`);
    }
  }, undefined, (_runId, status) => statuses.push(status));
  const request = await f.request("fault-request");
  assert.equal(request.requestId, "request-1");
  assert.equal(f.lease.acquire().ok, true);
  const decision = await f.decide(request, "approved", { operationId: "fault-decision" });
  assert.equal(decision.decision, "approved");
  assert.equal((await f.request("fault-request")).requestId, request.requestId);
  assert.equal((await f.decide(request, "approved", { operationId: "fault-decision" })).decisionId, decision.decisionId);
  assert.deepEqual(statuses, ["waiting_for_human", "running"], "durable status projection callbacks run exactly once, including after-rename recovery");
  const events = readWorkflowJournal(f.projectRoot, "session-fault").filter((event) => event.type === "approval.recorded");
  assert.equal(events.filter((event) => (event.payload as any).operation === "request").length, 1);
  assert.equal(events.filter((event) => (event.payload as any).operation === "decision").length, 1);
  f.lease.release();
});

test("an exact-existing request durably binds every caller operation and rejects differing reuse", async () => {
  const f = fixture("exact-binding");
  const first = await f.request("exact-first");
  assert.equal(f.lease.acquire().ok, true);
  const exact = await f.service.requestApproval({ operationId: "exact-second", checkpointId: "plan", expectedWorkspaceHash: f.currentHash() });
  assert.equal(exact.requestId, first.requestId);
  const operation = f.service.restore().operations["exact-second"];
  assert.equal(operation?.kind, "request");
  assert.equal(operation?.requestId, first.requestId);
  await assert.rejects(() => f.service.requestApproval({
    operationId: "exact-second", checkpointId: "plan", expectedWorkspaceHash: `sha256:${"0".repeat(64)}`,
  }), /operation.*reuse|different input/i);
  const bindings = readWorkflowJournal(f.projectRoot, "session-exact-binding")
    .filter((event) => event.type === "approval.recorded" && (event.payload as any).operation === "request-bind");
  assert.equal(bindings.length, 1);
  f.lease.release();
});

test("bounded control service handlers expose decisions/defaults without routes or credentials", async () => {
  const f = fixture("handlers");
  const handlers = createCheckpointControlHandlers(f.service);
  assert.deepEqual(handlers.listDefaults(), [{ checkpointId: "plan", policy: "required", enabled: true, defaultsRevision: 0 }]);
  const request = await f.request();
  assert.equal(f.lease.acquire().ok, true);
  const decision = await handlers.decide({
    operationId: "handler-decision", requestId: request.requestId, expectedRequestSequence: request.requestSequence,
    digest: request.digest, expectedWorkspaceHash: f.currentHash(), decision: "approved",
  }, { channel: "dashboard", mode: "headless", dashboardAvailable: true, credential: "dashboard:valid" });
  assert.equal(decision.decision, "approved");
  assert.ok(Buffer.byteLength(JSON.stringify(decision), "utf8") <= 65_536);
  assert.equal(JSON.stringify(decision).includes("dashboard:valid"), false);
  f.lease.release();
});

test("control request fields and feedback are strict and bounded", async () => {
  const f = fixture("bounds");
  const request = await f.request();
  assert.equal(f.lease.acquire().ok, true);
  await assert.rejects(() => f.service.decide({
    operationId: "oversized", requestId: request.requestId, expectedRequestSequence: request.requestSequence,
    digest: request.digest, expectedWorkspaceHash: f.currentHash(), decision: "denied", feedback: "x".repeat(9_000), extra: "forged",
  } as any, { channel: "dashboard", mode: "headless", dashboardAvailable: true, credential: "dashboard:valid" }), /field|feedback|limit|unsupported/i);
  assert.equal(f.service.restore().requests[request.requestId].decision, undefined);
  f.lease.release();
});
