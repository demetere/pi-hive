import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkflowEvent } from "../../src/workflows/events.ts";
import { appendWorkflowEvent, readWorkflowJournal } from "../../src/workflows/journal.ts";
import { WorkflowRunLifecycle } from "../../src/workflows/runs.ts";

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-run-chat-"));
  let nextRun = 0;
  let now = 0;
  const options = {
    projectRoot,
    projectId: "project-1",
    sessionId: "session-1",
    snapshotId: "snapshot-1",
    rootNodeId: "root",
    createRunId: () => `run-${++nextRun}`,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, now++)).toISOString(),
  };
  return { projectRoot, options };
}

test("idle input creates one run, later input steers it, duplicate callbacks are idempotent, and delivery is two-phase", () => {
  const f = fixture();
  const lifecycle = new WorkflowRunLifecycle(f.options);
  assert.equal(lifecycle.restore().latestRun, undefined, "selection alone must not create a run");

  const first = lifecycle.recordUserInput({ inputId: "callback-1", text: "build it", source: "interactive" });
  assert.deepEqual({ created: first.created, duplicate: first.duplicate, sequence: first.input.sequence }, { created: true, duplicate: false, sequence: 1 });

  const duplicate = lifecycle.recordUserInput({ inputId: "callback-1", text: "build it", source: "interactive" });
  assert.deepEqual({ created: duplicate.created, duplicate: duplicate.duplicate, sequence: duplicate.input.sequence }, { created: false, duplicate: true, sequence: 1 });

  const steering = lifecycle.recordUserInput({ inputId: "callback-2", text: "also cover the race", source: "rpc" });
  assert.equal(steering.created, false);
  assert.equal(steering.runId, first.runId);
  assert.equal(steering.input.kind, "steering");
  assert.equal(steering.input.sequence, 2);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").length, 2, "duplicate callback must not append");

  const prepared = lifecycle.prepareInputDelivery("root-request-1");
  assert.equal(prepared.requestId, "root-request-1");
  assert.deepEqual(prepared.inputs.map((input) => input.sequence), [1, 2]);
  assert.equal(lifecycle.restore().latestRun?.deliveredThrough, 0, "preparation alone is not delivery");

  const replayedBeforeProvider = new WorkflowRunLifecycle(f.options);
  assert.deepEqual(replayedBeforeProvider.pendingInputs().map((input) => input.sequence), [1, 2], "a crash before provider submission retries pending input");
  assert.equal(replayedBeforeProvider.preparedInputDelivery()?.requestId, "root-request-1", "prepared request identity must survive a crash");
  replayedBeforeProvider.confirmInputDelivery("root-request-1");
  assert.equal(replayedBeforeProvider.restore().latestRun?.deliveredThrough, 2);
  assert.deepEqual(replayedBeforeProvider.pendingInputs(), []);
});

test("a crash fault after publishing delivery preparation is reconciled from the durable request", () => {
  const f = fixture();
  const lifecycle = new WorkflowRunLifecycle(f.options);
  const started = lifecycle.recordUserInput({ inputId: "one", text: "initial", source: "interactive" });
  assert.throws(() => appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: "project-1",
    sessionId: "session-1",
    runId: started.runId,
    type: "run.input.delivery.prepared",
    payload: { formatVersion: 1, requestId: "crash-request", throughSequence: 1 },
    producer: "runtime",
    timestamp: "2026-01-01T00:00:10.000Z",
  }), { fault(stage) { if (stage === "afterRename") throw new Error("simulated crash"); } }), /simulated crash/);

  const replayed = new WorkflowRunLifecycle(f.options);
  assert.equal(replayed.preparedInputDelivery()?.requestId, "crash-request");
  assert.deepEqual(replayed.preparedInputDelivery()?.inputs.map((input) => input.sequence), [1]);
  replayed.confirmInputDelivery("crash-request");
  assert.equal(replayed.restore().latestRun?.deliveredThrough, 1);
});

test("delivery preparation and confirmation reject overlap and stale callbacks without appending invalid events", () => {
  const f = fixture();
  const lifecycle = new WorkflowRunLifecycle(f.options);
  lifecycle.recordUserInput({ inputId: "one", text: "initial", source: "interactive" });
  lifecycle.prepareInputDelivery("request-one");
  const preparedCount = readWorkflowJournal(f.projectRoot, "session-1").length;

  assert.throws(() => lifecycle.prepareInputDelivery("request-overlap"), /pending|overlap|prepared/i);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").length, preparedCount);

  lifecycle.confirmInputDelivery("request-one");
  const confirmedCount = readWorkflowJournal(f.projectRoot, "session-1").length;
  assert.throws(() => lifecycle.confirmInputDelivery("request-one"), /stale|prepared|delivery/i);
  assert.throws(() => lifecycle.confirmInputDelivery("request-never-prepared"), /stale|prepared|delivery/i);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").length, confirmedCount);
});

test("duplicate input identity is idempotent only when payload and source are identical", () => {
  const f = fixture();
  const lifecycle = new WorkflowRunLifecycle(f.options);
  lifecycle.recordUserInput({ inputId: "collision", text: "first", source: "interactive" });
  assert.equal(lifecycle.recordUserInput({ inputId: "collision", text: "first", source: "interactive" }).duplicate, true);
  assert.throws(() => lifecycle.recordUserInput({ inputId: "collision", text: "different", source: "interactive" }), /identity|payload|reuse|collision/i);
  assert.throws(() => lifecycle.recordUserInput({ inputId: "collision", text: "first", source: "rpc" }), /identity|source|reuse|collision/i);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").length, 1);
});

test("run creation and steering replay deterministically after restart", () => {
  const f = fixture();
  const firstProcess = new WorkflowRunLifecycle(f.options);
  firstProcess.recordUserInput({ inputId: "one", text: "initial", source: "interactive" });
  firstProcess.recordUserInput({ inputId: "two", text: "steer", source: "interactive" });

  const afterCrash = new WorkflowRunLifecycle(f.options).restore().latestRun;
  assert.equal(afterCrash?.runId, "run-1");
  assert.equal(afterCrash?.status, "running");
  assert.deepEqual(afterCrash?.inputs.map(({ inputId, sequence, kind }) => ({ inputId, sequence, kind })), [
    { inputId: "one", sequence: 1, kind: "initial" },
    { inputId: "two", sequence: 2, kind: "steering" },
  ]);
});
