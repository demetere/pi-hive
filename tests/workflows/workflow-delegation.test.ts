import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import {
  DELEGATION_LIMITS,
  DelegationRuntime,
  createDelegationState,
  reduceDelegationState,
  type DelegationContextReference,
} from "../../src/workflows/delegation.ts";
import { createWorkflowEvent, sealWorkflowEvent } from "../../src/workflows/events.ts";
import { authorizeReferences, type ReferenceAuthorizationDecision } from "../../src/workflows/references.ts";
import { readWorkflowJournal } from "../../src/workflows/journal.ts";
import { replayWorkflowJournal } from "../../src/workflows/replay.ts";

function snapshot(): ActivationSnapshotFileV1 {
  return {
    snapshotHash: "a".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      project: { projectId: "project-1", rootRef: "." },
      workflow: {
        id: "delivery",
        team: {
          rootId: "root",
          nodes: [
            { id: "root", agentId: "lead", memberIds: ["api", "web"], depth: 1, responsibilities: [], skills: {}, knowledge: {}, budgets: {} },
            { id: "api", agentId: "builder", parentId: "root", memberIds: ["db"], depth: 2, responsibilities: [], skills: {}, knowledge: {}, budgets: {} },
            { id: "web", agentId: "builder", parentId: "root", memberIds: [], depth: 2, responsibilities: [], skills: {}, knowledge: {}, budgets: {} },
            { id: "db", agentId: "database", parentId: "api", memberIds: [], depth: 3, responsibilities: [], skills: {}, knowledge: {}, budgets: {} },
          ],
        },
      },
      authority: { capabilityContractVersion: 1, nodes: [] },
      agents: [], skills: [], knowledge: [], models: [], sources: [], versions: {} as never,
    },
  } as ActivationSnapshotFileV1;
}

function fixture(authorize?: (ref: DelegationContextReference, nodeId: string) => ReferenceAuthorizationDecision, runId = "run-1") {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-delegation-"));
  let id = 0;
  const runtime = new DelegationRuntime({
    projectRoot,
    projectId: "project-1",
    sessionId: "session-1",
    runId,
    snapshot: snapshot(),
    createTaskId: () => `task-${++id}`,
    now: () => "2026-01-01T00:00:00.000Z",
    referenceAuthorizer: authorize ? { authorize } : undefined,
  });
  return { projectRoot, runtime, root: runtime.rootExecutionContext() };
}

function startWorker(runtime: DelegationRuntime, taskId: string, attemptId = `attempt-${taskId}`) {
  runtime.start(taskId, attemptId);
  return runtime.workerExecutionContext(taskId, attemptId);
}

test("delegation derives caller identity and allows only direct members", () => {
  const { runtime, root } = fixture();
  const parent = runtime.accept(root, { targetNodeId: "api", objective: "Build API", deliverables: ["patch"] });
  const api = startWorker(runtime, parent.taskId);
  assert.throws(() => runtime.accept(api, { targetNodeId: "web", objective: "Cross team", deliverables: [] }), /direct member/i);
  assert.throws(() => runtime.accept(root, { targetNodeId: "db", objective: "Skip lead", deliverables: [] }), /direct member/i);
  assert.throws(() => runtime.accept(root, { targetNodeId: "missing", objective: "Unknown", deliverables: [] }), /unknown|direct member/i);
  assert.equal(runtime.accept(api, { targetNodeId: "db", objective: "Schema", deliverables: [] }).taskId, "task-2");

  const fake = { nodeId: "root", taskId: undefined } as never;
  assert.throws(() => runtime.accept(fake, { targetNodeId: "web", objective: "spoof", deliverables: [] }), /trusted execution context/i);
  runtime.suspend(parent.taskId, ["task-2"]);
  assert.throws(() => runtime.accept(api, { targetNodeId: "db", objective: "late recursive work", deliverables: [] }), /active worker task|current|active matching/i);
  assert.throws(() => runtime.status(api), /active|current|trusted/i);
  assert.throws(() => runtime.preparedResultDelivery(api), /active|current|trusted/i);
});

test("trusted worker contexts are revoked after terminal result publication", () => {
  const { runtime, root } = fixture();
  const accepted = runtime.accept(root, { targetNodeId: "api", objective: "terminal context", deliverables: [] });
  const api = startWorker(runtime, accepted.taskId);
  runtime.recordResult(accepted.taskId, { status: "completed", summary: "done" });
  assert.throws(() => runtime.status(api), /active matching|current/i);
  assert.throws(() => runtime.prepareResultDelivery(api, "stale-delivery"), /active matching|current/i);
});

test("delegation provenance and parent task identity are derived from trusted context", () => {
  const { runtime, root } = fixture();
  assert.throws(() => runtime.accept(root, {
    targetNodeId: "api", objective: "forged runtime", deliverables: [],
    provenance: { source: "runtime", parentTaskId: "forged" } as never,
  }), /provenance|unsupported|forg/i);
  const parent = runtime.accept(root, { targetNodeId: "api", objective: "parent", deliverables: [] });
  const api = startWorker(runtime, parent.taskId);
  const child = runtime.accept(api, {
    targetNodeId: "db", objective: "child", deliverables: [], provenance: { correlationId: "tool-call-1" },
  });
  assert.deepEqual(runtime.restore().tasks[child.taskId].provenance, {
    source: "delegate_agent", correlationId: "tool-call-1", parentTaskId: parent.taskId,
  });
});

test("acceptance and authorized context are durable, bounded, opaque on denial, and non-blocking", () => {
  const calls: string[] = [];
  const { projectRoot, runtime, root } = fixture((ref, nodeId) => {
    calls.push(`${nodeId}:${ref.kind}:${ref.id}`);
    if (ref.id === "secret") return { authorized: false, diagnostic: "recipient lacks attachment" };
    return { authorized: true, resolved: { excerpt: "bounded content" } };
  });
  const accepted = runtime.accept(root, {
    targetNodeId: "api",
    objective: "Inspect references without copying the parent transcript",
    contextRefs: [{ kind: "artifact", id: "change-1" }, { kind: "knowledge", id: "secret" }],
    deliverables: ["findings"],
    provenance: { correlationId: "call-1" },
  });
  assert.deepEqual(accepted, { accepted: true, queued: true, taskId: "task-1" });
  assert.deepEqual(calls, ["api:artifact:change-1", "api:knowledge:secret"]);
  const task = runtime.restore().tasks[accepted.taskId];
  assert.equal(task.creationSequence, 1);
  assert.equal(task.queueState, "queued");
  assert.deepEqual(task.contextRefs.map((entry) => entry.authorization), ["authorized", "denied"]);
  const denied = task.contextRefs[1];
  assert.equal(denied.authorization, "denied");
  if (denied.authorization === "denied") assert.equal(denied.diagnostic, "recipient lacks attachment");
  assert.equal("parentTranscript" in task, false);
  assert.equal(readWorkflowJournal(projectRoot, "session-1").at(-1)?.type, "task.accepted");

  const replayed = replayWorkflowJournal(
    readWorkflowJournal(projectRoot, "session-1"),
    createDelegationState("session-1", "run-1", snapshot()),
    reduceDelegationState,
  ).state;
  assert.deepEqual(replayed.tasks, runtime.restore().tasks);
  assert.throws(() => runtime.accept(root, {
    targetNodeId: "api", objective: "x".repeat(DELEGATION_LIMITS.objectiveBytes + 1), deliverables: [],
  }), /objective.*limit|objective.*large/i);
});

test("results are reauthorized for the parent and use durable prepared/accepted delivery", () => {
  const calls: string[] = [];
  const { projectRoot, runtime, root } = fixture((ref, nodeId) => {
    calls.push(`${nodeId}:${ref.id}`);
    return ref.id === "secret-output"
      ? { authorized: false, diagnostic: "sensitive backend detail" }
      : { authorized: true, resolved: { safe: ref.id } };
  });
  const parent = runtime.accept(root, { targetNodeId: "api", objective: "Coordinate schema", deliverables: ["result"] });
  const api = startWorker(runtime, parent.taskId, "attempt-parent");
  const child = runtime.accept(api, { targetNodeId: "db", objective: "Inspect DB", deliverables: ["report"] });
  runtime.suspend(parent.taskId, [child.taskId]);
  startWorker(runtime, child.taskId, "attempt-child");
  runtime.recordResult(child.taskId, {
    status: "completed",
    summary: "Schema inspected",
    outputRefs: [{ kind: "file", id: "schema.sql" }, { kind: "file", id: "secret-output" }],
    evidenceRefs: [{ kind: "tool-result", id: "verify-1" }],
    data: { rows: 4 },
  });

  let restored = runtime.restore();
  assert.equal(restored.tasks[child.taskId].queueState, "terminal");
  assert.equal(restored.tasks[parent.taskId].queueState, "suspended", "parent must not resume before durable delivery acceptance");
  assert.deepEqual(restored.tasks[child.taskId].result?.outputRefs.map((ref) => ref.authorization), ["authorized", "denied"]);
  assert.deepEqual(calls.slice(-3), ["api:schema.sql", "api:secret-output", "api:verify-1"]);

  const prepared = runtime.prepareResultDeliveryForSuspendedTask(parent.taskId, "delivery-child-1", { limit: 10 });
  assert.equal(prepared.items[0].taskId, child.taskId);
  assert.equal(readWorkflowJournal(projectRoot, "session-1").at(-1)?.type, "task.result.delivery.prepared");

  const restarted = new DelegationRuntime(runtime.options);
  assert.equal(restarted.restore().deliveries["delivery-child-1"].acceptedSequence, undefined, "a crash before provider acceptance must redeliver the prepared result");
  assert.equal(restarted.restore().tasks[parent.taskId].queueState, "suspended");
  restarted.deliverPendingResultsToSuspendedTask(parent.taskId, "delivery-child-1");
  restored = restarted.restore();
  assert.equal(restored.tasks[child.taskId].resultAcceptedSequence! > restored.tasks[child.taskId].result!.recordedSequence, true);
  assert.equal(restored.tasks[parent.taskId].queueState, "active", "parent resumes the same attempt only after durable result acceptance");
  assert.equal(readWorkflowJournal(projectRoot, "session-1").at(-1)?.type, "task.result.delivery.accepted");
});

test("delegation replay ignores other runs in the same session", () => {
  const { projectRoot, runtime, root } = fixture(undefined, "run-1");
  runtime.accept(root, { targetNodeId: "api", objective: "first run", deliverables: [] });
  const second = new DelegationRuntime({ ...runtime.options, runId: "run-2", createTaskId: () => "run-2-task" });
  const secondRoot = second.rootExecutionContext();
  second.accept(secondRoot, { targetNodeId: "web", objective: "second run", deliverables: [] });
  assert.deepEqual(Object.keys(second.restore().tasks), ["run-2-task"]);
  assert.deepEqual(Object.keys(runtime.restore().tasks), ["task-1"]);
  assert.deepEqual(readWorkflowJournal(projectRoot, "session-1").filter((event) => event.type === "task.accepted").map((event) => event.runId), ["run-1", "run-2"]);
});

test("delegation reducer validates exact versioned payloads", () => {
  const zero = createDelegationState("session-1", "run-1", snapshot());
  const malformed = sealWorkflowEvent(createWorkflowEvent({
    eventId: "event-1", projectId: "project-1", sessionId: "session-1", runId: "run-1",
    type: "task.accepted", producer: "runtime", timestamp: "2026-01-01T00:00:00.000Z",
    payload: { formatVersion: 2, taskId: "task-1", parentNodeId: "root", targetNodeId: "api", objective: "x", contextRefs: [], deliverables: [], provenance: { source: "runtime" }, extra: true },
  }), 1, null);
  assert.throws(() => reduceDelegationState(zero, malformed), /format version|unsupported field/i);
});

test("result events must match the journal-active attempt", () => {
  const { runtime, root } = fixture();
  const accepted = runtime.accept(root, { targetNodeId: "api", objective: "attempt bound", deliverables: [] });
  runtime.start(accepted.taskId, "actual-attempt");
  const mismatched = sealWorkflowEvent(createWorkflowEvent({
    eventId: "event-result", projectId: "project-1", sessionId: "session-1", runId: "run-1",
    type: "task.result.recorded", producer: "harness", timestamp: "2026-01-01T00:00:01.000Z",
    payload: { formatVersion: 1, taskId: accepted.taskId, result: { status: "completed", summary: "wrong", outputRefs: [], evidenceRefs: [], data: {}, attemptId: "forged-attempt" } },
  }), 999, null);
  assert.throws(() => reduceDelegationState(runtime.restore(), mismatched), /attempt/i);
});

test("delegation replay reapplies resolved reference item and aggregate JSON bounds", () => {
  const zero = createDelegationState("session-1", "run-1", snapshot());
  const acceptedEvent = (contextRefs: unknown[]) => sealWorkflowEvent(createWorkflowEvent({
    eventId: `event-${contextRefs.length}-${JSON.stringify(contextRefs).length}`,
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "task.accepted", producer: "runtime",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: { formatVersion: 1, taskId: "task-replay", parentNodeId: "root", targetNodeId: "api", objective: "replay", contextRefs: contextRefs as never, deliverables: [], provenance: { source: "delegate_agent" } },
  }), 1, null);
  const ref = (id: string, resolved: unknown) => ({ ref: { kind: "artifact", id }, authorization: "authorized", resolved });
  let deep: unknown = "value";
  for (let index = 0; index < 18; index++) deep = { child: deep };
  assert.throws(() => reduceDelegationState(zero, acceptedEvent([ref("deep", deep)])), /structural|limit|bound/i);
  assert.throws(() => reduceDelegationState(zero, acceptedEvent([ref("wide", Array.from({ length: 4_100 }, () => 1))])), /structural|limit|bound/i);
  assert.throws(() => reduceDelegationState(zero, acceptedEvent([ref("large", "x".repeat(65_537))])), /byte|limit|bound/i);
  assert.throws(() => reduceDelegationState(zero, acceptedEvent([
    ref("one", "x".repeat(45_000)), ref("two", "x".repeat(45_000)), ref("three", "x".repeat(45_000)),
  ])), /aggregate|limit|bound/i);
});

test("reference authorization applies iterative node/depth and UTF-8 diagnostic bounds", () => {
  const tooWide = Array.from({ length: 5_000 }, (_, index) => index);
  assert.deepEqual(authorizeReferences([{ kind: "artifact", id: "wide" }], "api", {
    authorize: () => ({ authorized: true, resolved: tooWide }),
  }).map((entry) => entry.authorization), ["denied"]);

  const denied = authorizeReferences([{ kind: "artifact", id: "secret" }], "api", {
    authorize: () => { throw new Error("🙂".repeat(2_000)); },
  })[0];
  assert.equal(denied.authorization, "denied");
  if (denied.authorization === "denied") {
    assert.ok(Buffer.byteLength(denied.diagnostic, "utf8") <= 2_048);
    assert.equal(denied.diagnostic.includes("�"), false);
  }
});

test("reference authorization fails closed for unavailable, malformed, and aggregate-bound edge cases", () => {
  const reference = { kind: "artifact", id: "change-1" };
  assert.deepEqual(authorizeReferences([reference], "api"), [{
    ref: reference,
    authorization: "denied",
    diagnostic: "No reference authorization service is available",
  }]);

  const thrown = authorizeReferences([reference], "api", {
    authorize: () => { throw "provider offline"; },
  })[0];
  assert.equal(thrown.authorization, "denied");
  if (thrown.authorization === "denied") assert.match(thrown.diagnostic, /provider offline/);

  const defaultDenial = authorizeReferences([reference], "api", {
    authorize: () => ({ authorized: false, diagnostic: "   " }),
  })[0];
  assert.equal(defaultDenial.authorization, "denied");
  if (defaultDenial.authorization === "denied") assert.equal(defaultDenial.diagnostic, "Recipient is not authorized for this reference");

  const unresolved = authorizeReferences([reference], "api", {
    authorize: () => ({ authorized: true }),
  })[0];
  assert.deepEqual(unresolved, { ref: reference, authorization: "authorized" });

  assert.throws(() => authorizeReferences({} as never, "api"), /reference limit/i);
  assert.throws(() => authorizeReferences(Array.from({ length: 129 }, () => reference), "api"), /reference limit/i);
  assert.throws(() => authorizeReferences([{ ...reference, extra: true }] as never, "api"), /closed shape/i);

  const aggregate = authorizeReferences([
    { kind: "artifact", id: "one" },
    { kind: "artifact", id: "two" },
    { kind: "artifact", id: "three" },
  ], "api", {
    authorize: () => ({ authorized: true, resolved: "x".repeat(45_000) }),
  });
  assert.deepEqual(aggregate.map((entry) => entry.authorization), ["authorized", "authorized", "denied"]);
});

test("status is identity-scoped, summarized, and cursor paginated", () => {
  const { runtime, root } = fixture();
  for (let index = 0; index < 4; index++) runtime.accept(root, { targetNodeId: index % 2 ? "web" : "api", objective: `task ${index}`, deliverables: [] });
  const first = runtime.status(root, { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.summary.queued, 4);
  assert.ok(first.nextCursor);
  const second = runtime.status(root, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual([...first.items, ...second.items].map((task) => task.taskId), ["task-1", "task-2", "task-3", "task-4"]);
  assert.throws(() => runtime.status({ nodeId: "root" } as never, { limit: 1 }), /trusted execution context/i);
});
