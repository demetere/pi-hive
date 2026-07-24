import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowEvent, sealWorkflowEvent } from "../../src/workflows/events.ts";
import {
  createEmptyRunLifecycleState,
  isOpenRunStatus,
  reduceRunLifecycle,
  type RunLifecycleState,
  type RunStatus,
} from "../../src/workflows/runs.ts";

const projectId = "project-1";
const sessionId = "session-1";
const runId = "run-1";

function event(type: any, payload: any, sequence = 1, run = runId, producer: any = "runtime") {
  return sealWorkflowEvent(createWorkflowEvent({
    projectId,
    sessionId,
    runId: run,
    type,
    payload,
    producer,
    eventId: `event-${sequence}-${type}-${payload.to ?? payload.status ?? "x"}`,
    timestamp: `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
  }), sequence, null);
}

function stateWith(status: RunStatus): RunLifecycleState {
  return {
    sessionId,
    latestRun: {
      runId,
      status,
      startedAt: "2026-01-01T00:00:00.000Z",
      inputs: [{
        sequence: 1,
        inputId: "input-1",
        kind: "initial",
        text: "do work",
        source: "interactive",
        receivedAt: "2026-01-01T00:00:00.000Z",
      }],
      deliveredThrough: 1,
      cancellationRequested: false,
      ...(status === "paused" ? { resumeStatus: "running" as const, pauseReleasePending: false } : {}),
    },
  };
}

const open: RunStatus[] = ["running", "waiting_for_human", "paused"];
const terminal: RunStatus[] = ["completed", "blocked", "failed", "cancelled"];

test("run reducer accepts the complete open-state transition table and rejects invalid or terminal transitions atomically", () => {
  for (const from of open) {
    for (const to of open) {
      const before = stateWith(from);
      const transition = event("run.transition", { from, to, reason: "test", ...(to === "paused" ? { resumeStatus: from } : {}) });
      if (from === to || from === "paused" && to !== "running") {
        assert.throws(() => reduceRunLifecycle(before, transition), /transition|resume|prior/i, `${from} -> ${to}`);
        assert.equal(before.latestRun?.status, from);
      } else {
        assert.equal(reduceRunLifecycle(before, transition).latestRun?.status, to, `${from} -> ${to}`);
      }
    }
  }

  for (const from of terminal) {
    for (const to of [...open, ...terminal]) {
      const before = stateWith(from);
      assert.throws(
        () => reduceRunLifecycle(before, event("run.transition", { from, to, reason: "invalid" })),
        /terminal|transition/i,
        `${from} -> ${to}`,
      );
      assert.deepEqual(before, stateWith(from), "invalid transition must not partially mutate input state");
    }
  }

  assert.deepEqual(open.map(isOpenRunStatus), [true, true, true]);
  assert.deepEqual(terminal.map(isOpenRunStatus), [false, false, false, false]);
  assert.deepEqual(createEmptyRunLifecycleState(sessionId), { sessionId });
});

function terminalPayload(status: "completed" | "blocked" | "failed" | "cancelled") {
  return {
    formatVersion: 1,
    status,
    summary: "terminal summary",
    fileChanges: [],
    changeCoverage: "recorded",
    artifactRefs: [],
    evidenceRefs: [],
    data: {},
    unsatisfiedGates: status === "completed" ? [] : ["durable reason"],
    closedQuestionIds: [],
    partialState: {},
    finishedByNodeId: status === "cancelled" ? "harness" : "root",
    finishedAt: "2026-01-01T00:00:01.000Z",
    snapshotId: "snapshot-1",
    runId,
  };
}

test("multiple approval requests and a question wait settle independently by request identity", () => {
  const approvalA = reduceRunLifecycle(stateWith("running"), event("approval.recorded", {
    subsystem: "checkpoint-approval", operation: "request", requestId: "approval-a",
  }, 1, runId, "harness"));
  const approvalB = reduceRunLifecycle(approvalA, event("approval.recorded", {
    subsystem: "checkpoint-approval", operation: "request", requestId: "approval-b",
  }, 2, runId, "harness"));
  assert.equal(approvalB.latestRun?.status, "waiting_for_human");
  assert.deepEqual(approvalB.latestRun?.pendingApprovalRequestIds, ["approval-a", "approval-b"]);
  assert.deepEqual(approvalB.latestRun?.waitCauses, ["approval"]);

  const simultaneous = reduceRunLifecycle(approvalB, event("run.transition", {
    from: "waiting_for_human", to: "waiting_for_human", reason: "question pending", waitCause: "question", waitOperation: "add",
  }, 3));
  assert.deepEqual(simultaneous.latestRun?.waitCauses, ["approval", "question"]);

  const decidedA = reduceRunLifecycle(simultaneous, event("approval.recorded", {
    subsystem: "checkpoint-approval", operation: "decision", requestId: "approval-a",
  }, 4, runId, "dashboard"));
  assert.equal(decidedA.latestRun?.status, "waiting_for_human");
  assert.deepEqual(decidedA.latestRun?.pendingApprovalRequestIds, ["approval-b"]);
  assert.deepEqual(decidedA.latestRun?.waitCauses, ["approval", "question"]);

  const answered = reduceRunLifecycle(decidedA, event("run.transition", {
    from: "waiting_for_human", to: "waiting_for_human", reason: "question answered", waitCause: "question", waitOperation: "remove",
  }, 5));
  assert.equal(answered.latestRun?.status, "waiting_for_human");
  assert.deepEqual(answered.latestRun?.waitCauses, ["approval"]);

  const approved = reduceRunLifecycle(answered, event("approval.recorded", {
    subsystem: "checkpoint-approval", operation: "decision", requestId: "approval-b",
  }, 6, runId, "dashboard"));
  assert.equal(approved.latestRun?.status, "running");
  assert.deepEqual(approved.latestRun?.pendingApprovalRequestIds, []);
  assert.deepEqual(approved.latestRun?.waitCauses, []);
});

test("run reducer rejects ordinary transitions once cancellation or terminal settlement begins", () => {
  const cancelling = { ...stateWith("running"), latestRun: { ...stateWith("running").latestRun!, cancellationRequested: true } };
  assert.throws(() => reduceRunLifecycle(cancelling, event("run.transition", { from: "running", to: "paused", resumeStatus: "running", pauseState: {} })), /cancel|immutable|final/i);

  const cancellingDelivery = { ...cancelling, latestRun: { ...cancelling.latestRun, deliveredThrough: 0, pendingDelivery: { requestId: "request-1", throughSequence: 1, preparedAt: "2026-01-01T00:00:00.000Z" } } };
  assert.throws(() => reduceRunLifecycle(cancellingDelivery, event("run.input.delivered", { requestId: "request-1" })), /cancel|immutable|final/i);

  const prepared = { ...stateWith("running"), latestRun: { ...stateWith("running").latestRun!, pendingTerminal: { ...terminalPayload("completed"), operationId: "terminal-1" } } } as any;
  assert.throws(() => reduceRunLifecycle(prepared, event("run.transition", { from: "running", to: "waiting_for_human" })), /terminal|immutable|final/i);
});

test("run reducer enforces authoritative producers and cancellation/delivery terminal prerequisites", () => {
  const started = {
    formatVersion: 1,
    input: { sequence: 1, inputId: "input", kind: "initial", text: "work", source: "interactive", receivedAt: "2026-01-01T00:00:00.000Z" },
  };
  assert.throws(() => reduceRunLifecycle(createEmptyRunLifecycleState(sessionId), event("run.started", started, 1, runId, "dashboard")), /producer|authority/i);
  assert.throws(() => reduceRunLifecycle(stateWith("running"), event("run.cancel.requested", { reason: "stop" }, 1, runId, "runtime")), /producer|authority/i);
  assert.throws(() => reduceRunLifecycle(stateWith("running"), event("terminal.recorded", terminalPayload("completed"), 1, runId, "runtime")), /producer|harness|authority/i);

  const undelivered = { ...stateWith("running"), latestRun: { ...stateWith("running").latestRun!, deliveredThrough: 0 } };
  assert.throws(() => reduceRunLifecycle(undelivered, event("terminal.recorded", terminalPayload("completed"), 1, runId, "harness")), /deliver|input/i);
  assert.throws(() => reduceRunLifecycle(stateWith("running"), event("terminal.recorded", terminalPayload("cancelled"), 1, runId, "harness")), /cancel.*request|prerequisite/i);

  const cancelling = { ...stateWith("running"), latestRun: { ...stateWith("running").latestRun!, cancellationRequested: true } };
  assert.throws(() => reduceRunLifecycle(cancelling, event("terminal.recorded", terminalPayload("completed"), 1, runId, "harness")), /cancel/i);
  assert.equal(reduceRunLifecycle(cancelling, event("terminal.recorded", terminalPayload("cancelled"), 1, runId, "harness")).latestRun?.status, "cancelled");
});

test("cancelled terminal replay must equal the question set frozen by cancellation", () => {
  const cancelling = {
    ...stateWith("running"),
    latestRun: { ...stateWith("running").latestRun!, cancellationRequested: true, cancellationQuestionIds: ["q-frozen"] },
  };
  assert.throws(
    () => reduceRunLifecycle(cancelling, event("terminal.recorded", { ...terminalPayload("cancelled"), closedQuestionIds: [] }, 1, runId, "harness")),
    /question|closure|cancel|frozen|match/i,
  );
  assert.equal(reduceRunLifecycle(cancelling, event("terminal.recorded", { ...terminalPayload("cancelled"), closedQuestionIds: ["q-frozen"] }, 1, runId, "harness")).latestRun?.status, "cancelled");
});

test("terminal envelopes are strictly and semantically validated during replay", () => {
  const cancelling = { ...stateWith("running"), latestRun: { ...stateWith("running").latestRun!, cancellationRequested: true } };
  const hash = `sha256:${"a".repeat(64)}`;
  for (const malformed of [
    { ...terminalPayload("cancelled"), extra: "forged" },
    { ...terminalPayload("cancelled"), fileChanges: [{ path: "x", operation: "overwrite", attribution: "recorded" }] },
    { ...terminalPayload("cancelled"), fileChanges: [{ path: "/absolute.ts", operation: "create", afterHash: hash, attribution: "recorded" }] },
    { ...terminalPayload("cancelled"), fileChanges: [{ path: "src/../escape.ts", operation: "create", afterHash: hash, attribution: "recorded" }] },
    { ...terminalPayload("cancelled"), fileChanges: [{ path: "src//file.ts", operation: "create", afterHash: hash, attribution: "recorded" }] },
    { ...terminalPayload("cancelled"), fileChanges: [{ path: "src\\file.ts", operation: "create", afterHash: hash, attribution: "recorded" }] },
    { ...terminalPayload("cancelled"), fileChanges: [{ path: "new.ts", operation: "create", beforeHash: hash, afterHash: hash, attribution: "recorded" }] },
    { ...terminalPayload("cancelled"), fileChanges: [{ path: "new.ts", operation: "create", attribution: "recorded" }] },
    { ...terminalPayload("cancelled"), fileChanges: [{ path: "changed.ts", operation: "update", beforeHash: hash, attribution: "recorded" }] },
    { ...terminalPayload("cancelled"), fileChanges: [{ path: "deleted.ts", operation: "delete", beforeHash: hash, afterHash: hash, attribution: "recorded" }] },
    { ...terminalPayload("cancelled"), fileChanges: [{ path: "deleted.ts", operation: "delete", beforeHash: "sha256:not-a-digest", attribution: "recorded" }] },
    { ...terminalPayload("cancelled"), artifactRefs: [{ workspaceId: "w", checkpoint: "tasks", digest: "sha256:not-a-digest" }] },
    { ...terminalPayload("cancelled"), changeCoverage: "partial-recorded" },
    { ...terminalPayload("cancelled"), closedQuestionIds: [42] },
    { ...terminalPayload("cancelled"), finishedAt: "not-a-date" },
  ]) {
    assert.throws(() => reduceRunLifecycle(cancelling, event("terminal.recorded", malformed, 1, runId, "harness")), /terminal|invalid|unsupported|path|hash|coverage|digest|require/i);
  }

  for (const fileChanges of [
    [{ path: "new.ts", operation: "create", afterHash: hash, attribution: "recorded" }],
    [{ path: "changed.ts", operation: "update", beforeHash: hash, afterHash: hash, attribution: "reconciled" }],
    [{ path: "deleted.ts", operation: "delete", beforeHash: hash, attribution: "unknown" }],
  ]) {
    assert.equal(reduceRunLifecycle(cancelling, event("terminal.recorded", { ...terminalPayload("cancelled"), fileChanges }, 1, runId, "harness")).latestRun?.status, "cancelled");
  }
});
