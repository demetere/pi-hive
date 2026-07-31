import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { readWorkflowJournal } from "../../src/workflows/journal.ts";
import { WorkflowRunLifecycle } from "../../src/workflows/runs.ts";
import { DelegationRuntime } from "../../src/workflows/delegation.ts";
import { QUESTION_LIMITS, validateQuestionAnswer } from "../../src/workflows/question-validation.ts";
import { AttemptRuntime, attemptDescriptorForModel } from "../../src/workflows/attempts.ts";
import {
  LOSSLESS_DYNAMIC_DELIVERY_LIMITS,
  ROOT_LOSSLESS_DYNAMIC_DELIVERY_LIMITS,
  losslessDynamicPromptInputs,
  measureLosslessDynamicPromptDelivery,
} from "../../src/workflows/prompts.ts";
import {
  QuestionService,
  deriveQuestionRunStatus,
  type QuestionAnswerRequest,
} from "../../src/workflows/questions.ts";

function snapshot(humanInput = true): ActivationSnapshotFileV1 {
  return { snapshotHash: "q".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", payload: {
    project: { projectId: "project-1", rootRef: "." },
    workflow: { id: "delivery", team: { rootId: "root", nodes: [
      { id: "root", agentId: "lead", memberIds: ["worker"], depth: 1 },
      { id: "worker", agentId: "builder", parentId: "root", memberIds: [], depth: 2 },
    ] } },
    authority: { capabilityContractVersion: 1, nodes: [
      { nodeId: "root", capabilities: { effective: { "human-input": humanInput } }, tools: humanInput ? ["human_question"] : [] },
      { nodeId: "worker", capabilities: { effective: { "human-input": humanInput } }, tools: humanInput ? ["human_question"] : [] },
    ] },
    agents: [{ id: "lead", name: "Lead", prompt: "lead" }, { id: "builder", name: "Builder", prompt: "builder" }],
    skills: [], knowledge: [], models: [], sources: [], versions: {} as never,
  } } as unknown as ActivationSnapshotFileV1;
}

function fixture(options: { humanInput?: boolean; createQuestionId?: () => string } = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-questions-"));
  let tick = 0;
  if (options.humanInput ?? true) {
    const runtime = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: snapshot(true), createTaskId: () => "task-1" });
    runtime.accept(runtime.rootExecutionContext(), { targetNodeId: "worker", objective: "question fixture", deliverables: [] });
    runtime.start("task-1", "attempt-1");
  }
  const service = new QuestionService({
    projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1",
    snapshot: snapshot(options.humanInput ?? true), createQuestionId: options.createQuestionId ?? (() => "question-1"),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
  });
  return { projectRoot, service };
}

const definition = { prompt: "Which database?", kind: "single" as const, choices: [
  { value: "postgres", label: "PostgreSQL" }, { value: "sqlite", label: "SQLite" },
], required: true };
const create = (service: QuestionService, overrides: Record<string, unknown> = {}) => service.create({
  nodeId: "worker", taskId: "task-1", definition,
  provenance: { source: "human_question", toolCallId: "call-1" }, ...overrides,
});
const answer = (overrides: Partial<QuestionAnswerRequest> = {}): QuestionAnswerRequest => ({
  projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "question-1", expectedState: "pending",
  value: "postgres", channel: "dashboard", claimedIdentity: "human@example.test", credential: "secret", operationId: "answer-1", ...overrides,
});

test("questions require immutable human-input capability and persist full typed pending identity", () => {
  const denied = fixture({ humanInput: false });
  assert.throws(() => create(denied.service), /human-input|capability|not enabled/i);
  assert.equal(readWorkflowJournal(denied.projectRoot, "session-1").length, 0);

  const f = fixture();
  const question = create(f.service);
  assert.deepEqual({ projectId: question.projectId, sessionId: question.sessionId, runId: question.runId, nodeId: question.nodeId, taskId: question.taskId, state: question.state }, {
    projectId: "project-1", sessionId: "session-1", runId: "run-1", nodeId: "worker", taskId: "task-1", state: "pending",
  });
  assert.equal(question.definition.kind, "single");
  assert.deepEqual(question.provenance, { source: "human_question", toolCallId: "call-1", agentId: "builder" });
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").at(-1)?.type, "question.transition");
});

test("root and worker answers enforce the exact post-escaping N/N+1 delivery bound before persistence across restart", () => {
  const prompt = "\"".repeat(QUESTION_LIMITS.promptBytes);
  for (const scope of ["root", "worker"] as const) {
    const deliveryLimits = scope === "root" ? ROOT_LOSSLESS_DYNAMIC_DELIVERY_LIMITS : LOSSLESS_DYNAMIC_DELIVERY_LIMITS;
    const deliveryMeasurement = (answerLength: number) => measureLosslessDynamicPromptDelivery(losslessDynamicPromptInputs({
      provenance: "human-answer:question-1:dashboard:human@example.test",
      content: {
        questionId: "question-1",
        definition: { prompt, kind: "text", required: true },
        answer: {
          value: "\"".repeat(answerLength), channel: "dashboard", identity: "human@example.test", operationId: "answer-1",
          inputHash: `sha256:${"0".repeat(64)}`, answeredAt: "2026-01-01T00:00:01.000Z",
        },
      },
      ref: scope === "root"
        ? "run:run-1/node:root/question:question-1"
        : "run:run-1/node:worker/task:task-1/question:question-1",
    }));
    let low = 0;
    let high = QUESTION_LIMITS.textAnswerBytes;
    while (low < high) {
      const candidate = Math.ceil((low + high) / 2);
      if (deliveryMeasurement(candidate).encodedBytes <= deliveryLimits.encodedBytes) low = candidate;
      else high = candidate - 1;
    }
    assert.ok(deliveryMeasurement(low).encodedBytes <= deliveryLimits.encodedBytes, "N must fit the exact encoded-byte limit");
    assert.ok(deliveryMeasurement(low + 1).encodedBytes > deliveryLimits.encodedBytes, "N+1 must cross the exact post-escaping limit");
    assert.equal(deliveryMeasurement(low + 1).encodedBytes - deliveryMeasurement(low).encodedBytes, 4);

    const accepted = fixture();
    accepted.service.create({
      nodeId: scope, ...(scope === "worker" ? { taskId: "task-1" } : {}),
      definition: { prompt, kind: "text", required: true }, provenance: { source: "human_question", toolCallId: `bound-${scope}` },
    });
    const acceptedAnswer = accepted.service.answer(answer({ value: "\"".repeat(low) }));
    assert.equal(acceptedAnswer.state, "answered");
    const acceptedRestart = new QuestionService({ ...accepted.service.options });
    assert.equal(acceptedRestart.restore().questions["question-1"].answer?.value, "\"".repeat(low));

    const rejected = fixture();
    rejected.service.create({
      nodeId: scope, ...(scope === "worker" ? { taskId: "task-1" } : {}),
      definition: { prompt, kind: "text", required: true }, provenance: { source: "human_question", toolCallId: `bound-over-${scope}` },
    });
    const before = readWorkflowJournal(rejected.projectRoot, "session-1").length;
    assert.throws(() => rejected.service.answer(answer({ value: "\"".repeat(low + 1) })), /lossless delivery page bound|encoded bytes/i);
    assert.equal(readWorkflowJournal(rejected.projectRoot, "session-1").length, before, "N+1 rejection must append no answer event");
    const rejectedRestart = new QuestionService({ ...rejected.service.options });
    assert.equal(rejectedRestart.restore().questions["question-1"].state, "pending");
  }
});

test("task delivery preparation, receipt, and acceptance reject a newer delegation attempt", () => {
  const moveToNewAttempt = (projectRoot: string): void => {
    const runtime = new DelegationRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: snapshot() });
    runtime.pauseAdmission("force stale question attempt");
    runtime.interrupt("task-1", "force stale question attempt");
    runtime.resumeAdmission();
    runtime.start("task-1", "attempt-2");
  };
  const answered = (): ReturnType<typeof fixture> => {
    const f = fixture();
    create(f.service);
    f.service.answer(answer());
    return f;
  };

  const beforePreparation = answered();
  moveToNewAttempt(beforePreparation.projectRoot);
  assert.throws(() => beforePreparation.service.prepareTaskAnswerDeliveries("task-1"), /attempt|stale|exact/i);

  const beforeReceipt = answered();
  const [receiptDelivery] = beforeReceipt.service.prepareTaskAnswerDeliveries("task-1");
  moveToNewAttempt(beforeReceipt.projectRoot);
  assert.throws(() => beforeReceipt.service.recordTaskAnswerDeliveryReceipt(receiptDelivery, {
    promptHash: "1".repeat(64), attemptId: "consumer-attempt", transcriptRef: "run:run-1/node:worker/task:task-1/transcript",
  }), /attempt|stale|exact/i);

  const beforeAcceptance = answered();
  const [acceptedDelivery] = beforeAcceptance.service.prepareTaskAnswerDeliveries("task-1");
  beforeAcceptance.service.recordTaskAnswerDeliveryReceipt(acceptedDelivery, {
    promptHash: "2".repeat(64), attemptId: "consumer-attempt", transcriptRef: "run:run-1/node:worker/task:task-1/transcript",
  });
  moveToNewAttempt(beforeAcceptance.projectRoot);
  assert.throws(() => beforeAcceptance.service.acceptTaskAnswerDelivery(acceptedDelivery), /attempt|stale|exact/i);
});

test("task-bound creation rejects stale task identities and paused task races before publication", () => {
  const f = fixture();
  const before = readWorkflowJournal(f.projectRoot, "session-1").length;
  for (const overrides of [{ taskId: "missing-task" }, { nodeId: "root" }]) {
    assert.throws(() => create(f.service, overrides), /task|active|node|admission|exact/i);
    assert.equal(readWorkflowJournal(f.projectRoot, "session-1").length, before);
  }

  const runtime = new DelegationRuntime({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: snapshot() });
  runtime.pauseAdmission("pause won create CAS");
  const pausedCount = readWorkflowJournal(f.projectRoot, "session-1").length;
  assert.throws(() => create(f.service), /paused|admission|active|scheduler/i);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").length, pausedCount);
  assert.doesNotThrow(() => runtime.restore(), "rejected question creation must not poison delegation replay");
});

test("multiple questions on one task remain suspended until every answer across restart", () => {
  let next = 0;
  const f = fixture({ createQuestionId: () => `question-${++next}` });
  const first = create(f.service, { provenance: { source: "human_question", toolCallId: "call-first" } });
  const second = create(f.service, { provenance: { source: "human_question", toolCallId: "call-second" } });
  const replayed = new DelegationRuntime({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: snapshot() });
  assert.deepEqual(replayed.restore().tasks["task-1"].suspendedOnQuestionIds, [first.questionId, second.questionId]);
  f.service.answer(answer({ questionId: second.questionId, operationId: "answer-second" }));
  assert.equal(new DelegationRuntime(replayed.options).restore().tasks["task-1"].queueState, "suspended");
  f.service.answer(answer({ questionId: first.questionId, operationId: "answer-first" }));
  const resumed = new DelegationRuntime(replayed.options).restore().tasks["task-1"];
  assert.equal(resumed.queueState, "active");
  assert.equal(resumed.resumedByQuestionSequence !== undefined, true);
  assert.deepEqual(resumed.suspendedOnQuestionIds, undefined);
});

test("pending is durable before live presentation, restart-safe, and a live answer records provenance", async () => {
  const f = fixture();
  let pendingSeen = false;
  const result = await f.service.createAndPresent({
    nodeId: "worker", taskId: "task-1", definition,
    provenance: { source: "human_question", toolCallId: "call-live" },
  }, async (pending) => {
    pendingSeen = f.service.restore().questions[pending.questionId]?.state === "pending";
    return { value: "sqlite", claimedIdentity: "tui-user", credential: "secret", operationId: "live-1" };
  });
  assert.equal(pendingSeen, true);
  assert.equal(result.state, "answered");
  assert.deepEqual({ ...result.answer, inputHash: undefined }, { value: "sqlite", channel: "live", identity: "tui-user", operationId: "live-1", inputHash: undefined, answeredAt: "2026-01-01T00:00:01.000Z" });
  assert.match(result.answer?.inputHash ?? "", /^sha256:[0-9a-f]{64}$/u);

  const restarted = new QuestionService({ ...f.service.options, createQuestionId: () => "question-2" });
  assert.equal(restarted.restore().questions["question-1"].answer?.value, "sqlite");
});

test("a dashboard winner aborts and settles a losing non-cooperative live presenter with the durable answer", async () => {
  const f = fixture();
  let presented!: (questionId: string) => void;
  const started = new Promise<string>((resolve) => { presented = resolve; });
  const live = f.service.createAndPresent({
    nodeId: "worker", taskId: "task-1", definition,
    provenance: { source: "human_question", toolCallId: "call-live-race" },
  }, async (question) => {
    presented(question.questionId);
    return new Promise(() => {});
  });
  const questionId = await started;
  const winner = f.service.answer(answer({ questionId, operationId: "dashboard-winner" }));
  assert.equal(winner.answer?.channel, "dashboard");
  const settled = await Promise.race([
    live,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("losing live presenter did not settle")), 100)),
  ]);
  assert.equal(settled.answer?.operationId, "dashboard-winner");
  assert.equal(f.service.hasLiveHandles(), false);
});

test("a separately constructed dashboard service settles a live runtime presenter from the durable winner", async () => {
  const f = fixture();
  const dashboard = new QuestionService({ ...f.service.options });
  let presented!: (questionId: string) => void;
  const started = new Promise<string>((resolve) => { presented = resolve; });
  const live = f.service.createAndPresent({
    nodeId: "worker", taskId: "task-1", definition,
    provenance: { source: "human_question", toolCallId: "cross-instance-live-race" },
  }, async (question) => {
    presented(question.questionId);
    return new Promise(() => {});
  });
  const questionId = await started;
  dashboard.answer(answer({ questionId, operationId: "cross-instance-dashboard-winner" }));
  const settled = await Promise.race([
    live,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cross-instance live presenter did not observe durable settlement")), 250)),
  ]);
  assert.equal(settled.answer?.operationId, "cross-instance-dashboard-winner");
  assert.equal(f.service.hasLiveHandles(), false);
  assert.equal(dashboard.hasLiveHandles(), false);
});

test("published question and answer events reconcile after an after-rename fault without duplicate effects", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-questions-fault-"));
  let faults = 2;
  const service = new QuestionService({
    projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: snapshot(),
    createQuestionId: () => "question-1", authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
    journalFault: (_type, stage) => { if (stage === "afterRename" && faults-- > 0) throw new Error("simulated crash after publication"); },
  });
  const pending = create(service, { nodeId: "root", taskId: undefined });
  assert.equal(pending.state, "pending");
  const request = answer();
  const answered = service.answer(request);
  assert.equal(answered.state, "answered");
  assert.deepEqual(service.answer(request), answered, "a client retry after durable publication replays the recorded operation");
  assert.equal(readWorkflowJournal(projectRoot, "session-1").filter((event) => event.type === "question.transition").length, 2);
});

test("invalid or unauthenticated answers append nothing and first valid live/dashboard/command CAS wins", async () => {
  const f = fixture(); create(f.service);
  const before = readWorkflowJournal(f.projectRoot, "session-1").length;
  assert.throws(() => f.service.answer(answer({ credential: "wrong" })), /authenticate|authorized/i);
  assert.throws(() => f.service.answer(answer({ value: "mysql", operationId: "invalid" })), /choice|answer/i);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").length, before);

  const contenders = [
    answer({ channel: "live", value: "sqlite", claimedIdentity: "tui", operationId: "live" }),
    answer({ channel: "dashboard", value: "postgres", claimedIdentity: "web", operationId: "dashboard" }),
    answer({ channel: "command", value: "sqlite", claimedIdentity: "cli", operationId: "command" }),
  ];
  const settled = await Promise.allSettled(contenders.map(async (request) => f.service.answer(request)));
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(settled.filter((entry) => entry.status === "rejected").length, 2);
  const durable = f.service.restore().questions["question-1"];
  assert.equal(durable.state, "answered");
  assert.equal(["live", "dashboard", "command"].includes(durable.answer!.channel), true);
  assert.deepEqual(f.service.answer(contenders.find((request) => request.operationId === durable.answer!.operationId)!), durable, "the exact winning operation is replay-safe");
});

test("answer controls bind exact durable identity and expected state with replay-safe input hashes", () => {
  const f = fixture();
  const authenticated: any[] = [];
  const service = new QuestionService({
    ...f.service.options,
    authenticateControl: (request) => {
      authenticated.push(request);
      return request.credential === "secret" ? request.claimedIdentity : undefined;
    },
  });
  create(service);
  const exact = {
    projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "question-1", expectedState: "pending",
    value: "postgres", channel: "dashboard", claimedIdentity: "human@example.test", credential: "secret", operationId: "answer-replay",
  } as const;
  const answered = service.answer(exact);
  assert.match(answered.answer?.inputHash ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(service.answer(exact), answered, "an after-publication client retry returns the immutable recorded answer");
  assert.deepEqual(
    { projectId: authenticated[0].projectId, sessionId: authenticated[0].sessionId, runId: authenticated[0].runId, questionId: authenticated[0].questionId, expectedState: authenticated[0].expectedState },
    { projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "question-1", expectedState: "pending" },
  );
  for (const changed of [
    { ...exact, projectId: "other" },
    { ...exact, sessionId: "other" },
    { ...exact, runId: "other" },
    { ...exact, expectedState: "answered" },
    { ...exact, value: "sqlite" },
    { ...exact, channel: "command" },
  ]) assert.throws(() => service.answer(changed as any), /identity|expected|operation|input|state|reuse/i);
  assert.throws(() => service.answer({ ...exact, operationId: "late-other-channel", channel: "command" }), /answered|pending|late|CAS/i);
});

test("stale run services cannot create or answer questions against a different current run", () => {
  const f = fixture();
  const lifecycle = new WorkflowRunLifecycle({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshotId: "snapshot-1", rootNodeId: "root", createRunId: () => "run-current" });
  lifecycle.recordUserInput({ inputId: "input-current", text: "work", source: "interactive" });
  const stale = new QuestionService({ ...f.service.options, runId: "run-stale", createQuestionId: () => "stale-question" });
  assert.throws(() => create(stale), /current run|stale|identity/i);
  assert.equal(stale.restore().questions["stale-question"], undefined);
});

test("ordinary root chat remains steering and cannot satisfy a structured question", () => {
  const f = fixture(); create(f.service);
  const lifecycle = new WorkflowRunLifecycle({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshotId: "snapshot-1", rootNodeId: "root", createRunId: () => "run-1" });
  lifecycle.recordUserInput({ inputId: "chat-1", text: "postgres", source: "interactive" });
  assert.equal(f.service.restore().questions["question-1"].state, "pending");
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").some((event) => event.type === "run.input.recorded" || event.type === "run.started"), true);
});

test("terminal close and late answer race serialize atomically and retain an auditable closure", async () => {
  for (const closeFirst of [true, false]) {
    const f = fixture(); create(f.service);
    const close = async () => f.service.closePending({ reason: "run cancelled", operationId: "terminal-1" });
    const submit = async () => f.service.answer(answer());
    const results = closeFirst ? await Promise.allSettled([close(), submit()]) : await Promise.allSettled([submit(), close()]);
    const question = f.service.restore().questions["question-1"];
    assert.equal(question.state === "closed" || question.state === "answered", true);
    if (question.state === "closed") {
      assert.equal(question.closure?.reason, "run cancelled");
      assert.equal(results.some((entry) => entry.status === "rejected"), true);
      assert.throws(() => f.service.answer(answer({ operationId: "late" })), /closed|pending|late/i);
    } else {
      assert.equal(question.answer?.value, "postgres");
      assert.deepEqual(f.service.closePending({ reason: "run cancelled", operationId: "terminal-2" }).closedQuestionIds, []);
    }
  }
});

test("terminal closure replay is idempotent only for the exact operation, IDs, and reason", () => {
  const f = fixture();
  create(f.service);
  const expectedQuestionIds = ["question-1"];
  assert.deepEqual(f.service.closePending({ reason: "run failed", operationId: "terminal-retry", expectedQuestionIds }).closedQuestionIds, expectedQuestionIds);
  assert.deepEqual(f.service.closePending({ reason: "run failed", operationId: "terminal-retry", expectedQuestionIds }).closedQuestionIds, expectedQuestionIds);
  assert.throws(() => f.service.closePending({ reason: "different", operationId: "terminal-retry", expectedQuestionIds }), /conflict|reason|closure/i);
  assert.throws(() => f.service.closePending({ reason: "run failed", operationId: "other-operation", expectedQuestionIds }), /conflict|operation|closure/i);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").filter((event) => event.type === "question.transition" && (event.payload as any).operation === "close-pending").length, 1);
});

test("a live root tool answer is prepared but not acknowledged before its containing transcript turn", async () => {
  const f = fixture();
  const answered = await f.service.createAndPresent({
    nodeId: "root", definition: { prompt: "Proceed?", kind: "confirm", required: true },
    provenance: { source: "human_question", toolCallId: "root-live" },
  }, async () => ({ value: true, claimedIdentity: "root-user", credential: "secret", operationId: "root-live-answer" }));
  assert.equal(answered.answer?.value, true);
  const prepared = f.service.prepareRootAnswerDelivery("root");
  assert.deepEqual(prepared?.questionIds, [answered.questionId], "tool completion alone must leave a durable delivery for containing-turn acceptance");
  f.service.recordRootAnswerDeliveryReceipt(prepared!, { promptHash: "a".repeat(64), attemptId: "root-attempt", transcriptRef: "run:run-1/node:root/transcript" });
  f.service.acceptRootAnswerDelivery(prepared!);
  assert.equal(f.service.prepareRootAnswerDelivery("root"), undefined, "containing transcript acceptance excludes later duplicate injection");
});

test("delivery preparation and containing-turn acceptance reconcile after publication faults without duplicate markers", () => {
  const f = fixture();
  const question = create(f.service);
  f.service.answer(answer());
  let faults = 2;
  const faulted = new QuestionService({
    ...f.service.options,
    journalFault: (_eventType, stage) => {
      if (stage === "afterRename" && faults-- > 0) throw new Error("simulated delivery marker publication fault");
    },
  });
  const [prepared] = faulted.prepareTaskAnswerDeliveries("task-1");
  assert.deepEqual(prepared.questionIds, [question.questionId]);
  faulted.recordTaskAnswerDeliveryReceipt(prepared, { promptHash: "b".repeat(64), attemptId: "task-attempt", transcriptRef: "run:run-1/node:worker/task:task-1/transcript" });
  faulted.acceptTaskAnswerDelivery(prepared);
  assert.deepEqual(new QuestionService({ ...f.service.options }).prepareTaskAnswerDeliveries("task-1"), []);
  const operations = readWorkflowJournal(f.projectRoot, "session-1")
    .filter((event) => event.type === "question.transition")
    .map((event) => (event.payload as any).operation);
  assert.equal(operations.filter((operation) => operation === "task-delivery-prepared").length, 1);
  assert.equal(operations.filter((operation) => operation === "task-delivery-accepted").length, 1);
});

test("completion gate includes answered-undelivered descendant task questions until their exact transcript accepts them", () => {
  const f = fixture();
  const question = create(f.service);
  f.service.answer(answer());
  const blocked = f.service.completionGate();
  assert.equal(blocked.state, "unsatisfied");
  assert.match(blocked.issues?.join(" ") ?? "", /owning.*task transcript|answered/i);
  const [delivery] = f.service.prepareTaskAnswerDeliveries("task-1");
  f.service.recordTaskAnswerDeliveryReceipt(delivery, { promptHash: "c".repeat(64), attemptId: "attempt-1", transcriptRef: "run:run-1/node:worker/task:task-1/transcript" });
  f.service.acceptTaskAnswerDelivery(delivery);
  assert.deepEqual(f.service.completionGate(), { state: "satisfied" });
  assert.ok(f.service.restore().questions[question.questionId].taskDeliveryAcceptedSequence);
});

test("completed worker attempt reconstructs a missing before-publication receipt across service restart", () => {
  const f = fixture();
  const question = create(f.service);
  f.service.answer(answer());
  const [delivery] = f.service.prepareTaskAnswerDeliveries("task-1");
  const attempts = new AttemptRuntime({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1" });
  attempts.begin({
    attemptId: "containing-attempt", correlationId: "containing-correlation", nodeId: "worker", operation: "worker.provider.prompt",
    input: { taskId: "task-1" }, descriptor: attemptDescriptorForModel(),
    consumerReceipt: { deliveryIds: [delivery.deliveryId], promptHash: "f".repeat(64), transcriptRef: "run:run-1/node:worker/task:task-1/transcript" },
  });
  attempts.complete("containing-attempt", { ok: true, value: "provider completed" });
  let faulted = false;
  const interrupted = new QuestionService({ ...f.service.options, journalFault: (_type, stage) => {
    if (!faulted && stage === "beforeRename") { faulted = true; throw new Error("worker receipt before-publication fault"); }
  } });
  assert.throws(() => interrupted.reconcileAnswerDeliveryReceipts(), /before-publication/i);
  assert.equal(f.service.restore().questions[question.questionId].taskDeliveryReceipt, undefined);

  const restarted = new QuestionService({ ...f.service.options });
  restarted.reconcileAnswerDeliveryReceipts();
  const restored = restarted.restore().questions[question.questionId];
  assert.equal(restored.taskDeliveryReceipt?.attemptId, "containing-attempt");
  assert.ok(restored.taskDeliveryAcceptedSequence);
});

test("answer delivery paginates beyond 64 questions and preserves a maximum UTF-8 answer losslessly", () => {
  let next = 0;
  const f = fixture({ createQuestionId: () => `page-question-${++next}` });
  const questions = [];
  for (let index = 0; index < 65; index++) {
    questions.push(f.service.create({
      nodeId: "worker", taskId: "task-1",
      definition: index === 64
        ? { prompt: "界".repeat(Math.floor(QUESTION_LIMITS.promptBytes / 3)), kind: "text", validation: { maxLength: QUESTION_LIMITS.textAnswerBytes }, required: true }
        : { prompt: `Question ${index}?`, kind: "confirm", required: true },
      provenance: { source: "human_question", toolCallId: `page-call-${index}` },
    }));
  }
  for (let index = 0; index < questions.length; index++) {
    f.service.answer({
      projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: questions[index].questionId, expectedState: "pending",
      value: index === 64 ? "界".repeat(Math.floor(QUESTION_LIMITS.textAnswerBytes / 3)) : true,
      channel: "dashboard", claimedIdentity: "human", credential: "secret", operationId: `page-answer-${index}`,
    });
  }

  const first = f.service.prepareTaskAnswerDeliveries("task-1");
  assert.equal(first.length, 1);
  assert.equal(first[0].questionIds.length, 1, "one lossless answer page must not acknowledge omitted answers");
  f.service.recordTaskAnswerDeliveryReceipt(first[0], { promptHash: "d".repeat(64), attemptId: "page-attempt-1", transcriptRef: "run:run-1/node:worker/task:task-1/transcript" });
  f.service.acceptTaskAnswerDelivery(first[0]);
  let restored = f.service.restore();
  assert.equal(Object.values(restored.questions).filter((question) => question.taskDeliveryAcceptedSequence !== undefined).length, 1);
  assert.equal(f.service.acceptedAnswersForTask("task-1").length, 64, "the 64 omitted values remain resumable and unconsumed");

  const [second] = f.service.prepareTaskAnswerDeliveries("task-1");
  assert.equal(second.questionIds.length, 1);
  assert.notEqual(second.questionIds[0], first[0].questionIds[0], "the continuation page must progress");
  restored = f.service.restore();
  assert.equal(Object.values(restored.questions).filter((question) => question.taskDeliveryAcceptedSequence !== undefined).length, 1);
  assert.equal(restored.questions[questions[64].questionId].answer?.value, "界".repeat(Math.floor(QUESTION_LIMITS.textAnswerBytes / 3)));
});

test("terminal closure replay requires equality with the complete original operation set", () => {
  let next = 0;
  const f = fixture({ createQuestionId: () => `question-${++next}` });
  create(f.service, { provenance: { source: "human_question", toolCallId: "close-1" } });
  create(f.service, { provenance: { source: "human_question", toolCallId: "close-2" } });
  assert.deepEqual(f.service.closePending({ reason: "run failed", operationId: "close-all", expectedQuestionIds: ["question-1", "question-2"] }).closedQuestionIds, ["question-1", "question-2"]);
  assert.throws(
    () => f.service.closePending({ reason: "run failed", operationId: "close-all", expectedQuestionIds: ["question-1"] }),
    /exact|set|operation|conflict/i,
  );
});

test("offline dashboard append never invokes a model and owner resume data targets the same task/transcript", () => {
  const f = fixture(); create(f.service);
  let modelExecutions = 0;
  f.service.answer(answer());
  assert.equal(modelExecutions, 0, "answer persistence has no model callback");
  const resumable = f.service.acceptedAnswersForTask("task-1");
  assert.equal(resumable.length, 1);
  assert.deepEqual({ taskId: resumable[0].taskId, questionId: resumable[0].questionId, value: resumable[0].answer.value }, { taskId: "task-1", questionId: "question-1", value: "postgres" });
  assert.equal(resumable[0].transcriptRef, "run:run-1/node:worker/task:task-1/question:question-1");
  modelExecutions += 0;
});

test("waiting status treats root steering as runnable only when the root transcript is not question-suspended", () => {
  assert.equal(deriveQuestionRunStatus({ pendingQuestions: 1, activeExecutions: 0, runnableTasks: 0, pendingRootInputs: 0, rootQuestionSuspended: true }), "waiting_for_human");
  assert.equal(deriveQuestionRunStatus({ pendingQuestions: 1, activeExecutions: 0, runnableTasks: 0, pendingRootInputs: 1, rootQuestionSuspended: true }), "waiting_for_human", "ordinary steering cannot run through a root-local question gate");
  for (const input of [
    { pendingQuestions: 1, activeExecutions: 1, runnableTasks: 0, pendingRootInputs: 1, rootQuestionSuspended: true },
    { pendingQuestions: 1, activeExecutions: 0, runnableTasks: 1, pendingRootInputs: 1, rootQuestionSuspended: true },
    { pendingQuestions: 1, activeExecutions: 0, runnableTasks: 0, pendingRootInputs: 1, rootQuestionSuspended: false },
    { pendingQuestions: 0, activeExecutions: 0, runnableTasks: 0, pendingRootInputs: 0, rootQuestionSuspended: false },
  ]) assert.equal(deriveQuestionRunStatus(input), "running");
});

test("question count is bounded before append so terminal closure cannot poison replay", () => {
  let id = 0;
  const f = fixture({ createQuestionId: () => `bounded-${++id}` });
  for (let index = 0; index < QUESTION_LIMITS.questions; index++) create(f.service, { provenance: { source: "human_question", toolCallId: `bounded-call-${index}` } });
  const before = readWorkflowJournal(f.projectRoot, "session-1").length;
  assert.throws(
    () => create(f.service, { provenance: { source: "human_question", toolCallId: "overflow" } }),
    /questions.*limit|limit.*questions/i,
  );
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").length, before);
  assert.equal(f.service.closePending({ reason: "run cancelled", operationId: "close-bounded" }).closedQuestionIds.length, QUESTION_LIMITS.questions);
});

test("bounded exact detail DTO exposes enough definition data to answer every kind without identity leakage", () => {
  let next = 0;
  const f = fixture({ createQuestionId: () => `detail-${++next}` });
  const definitions = [
    definition,
    { prompt: "Select targets", kind: "multi" as const, choices: [{ value: "api", label: "API" }, { value: "web", label: "Web" }], validation: { minItems: 1, maxItems: 2 }, required: true },
    { prompt: "Release name", kind: "text" as const, validation: { minLength: 3, maxLength: 12, pattern: "^[a-z-]+$" }, required: true },
    { prompt: "Proceed?", kind: "confirm" as const, required: true },
  ];
  const values = ["postgres", ["api"], "release-one", true] as const;
  for (const [index, input] of definitions.entries()) {
    const question = create(f.service, { definition: input, provenance: { source: "human_question", toolCallId: `detail-call-${index}` } });
    const pages: any[] = [];
    let cursor: string | undefined;
    do {
      const page = (f.service as any).detail({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: question.questionId, ...(cursor ? { cursor } : {}) });
      assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= QUESTION_LIMITS.dtoBytes);
      assert.equal(JSON.stringify(page).includes("human@example.test"), false);
      assert.equal("answer" in page, false);
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor);
    const reconstructed = {
      prompt: pages.map((page) => page.promptChunk).join(""), kind: pages[0].kind,
      ...(pages.some((page) => page.choices.length) ? { choices: pages.flatMap((page) => page.choices) } : {}),
      ...(pages[0].validation ? { validation: pages[0].validation } : {}), required: pages[0].required,
    };
    assert.deepEqual(reconstructed, input);
    assert.doesNotThrow(() => validateQuestionAnswer(reconstructed as any, values[index]));
  }
  assert.throws(() => (f.service as any).detail({ projectId: "other", sessionId: "session-1", runId: "run-1", questionId: "detail-1" }), /identity|project/i);
  assert.throws(() => (f.service as any).detail({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "detail-1", cursor: "999:0:0" }), /cursor|stale/i);
});

test("status and detail pagination progress under worst-case UTF-8 and escaping bounds", () => {
  let next = 0;
  const f = fixture({ createQuestionId: () => `q-${String(++next).padStart(3, "0")}-${"i".repeat(220)}` });
  const large = {
    prompt: `${"😀\"".repeat(2_000)}tail`, kind: "single" as const,
    choices: Array.from({ length: 32 }, (_, index) => ({ value: `v${index}-${"\\\"".repeat(80)}`, label: `L${index}-${"😀\"".repeat(80)}` })), required: true,
  };
  for (let index = 0; index < 40; index++) create(f.service, { definition: large, provenance: { source: "human_question", toolCallId: `worst-${index}` } });
  let cursor: string | undefined;
  let seen = 0;
  do {
    const page = f.service.status({ limit: 40, ...(cursor ? { cursor } : {}) });
    assert.ok(page.items.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= QUESTION_LIMITS.dtoBytes);
    seen += page.items.length;
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen, 40);
  assert.throws(() => f.service.status({ limit: 40, cursor: "999" }), /cursor|stale/i);

  const id = f.service.status({ limit: 1 }).items[0].questionId;
  const first = (f.service as any).detail({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: id, choiceLimit: 4 });
  assert.ok(first.nextCursor, "large prompt/choices require a progressing bounded cursor");
});

test("filtered question status cursor remains stable when an earlier queue item changes state", () => {
  let next = 0;
  const f = fixture({ createQuestionId: () => `question-${++next}` });
  create(f.service, { provenance: { source: "human_question", toolCallId: "cursor-1" } });
  create(f.service, { provenance: { source: "human_question", toolCallId: "cursor-2" } });
  create(f.service, { provenance: { source: "human_question", toolCallId: "cursor-3" } });
  const first = f.service.status({ state: "pending", limit: 1 });
  assert.equal(first.items[0].questionId, "question-1");
  f.service.answer(answer({ questionId: "question-1", operationId: "cursor-answer" }));
  const second = f.service.status({ state: "pending", limit: 1, cursor: first.nextCursor });
  assert.equal(second.items[0].questionId, "question-2", "queue mutation must not shift q2 behind the cursor");
  assert.throws(() => f.service.status({ state: "answered", limit: 1, cursor: first.nextCursor }), /cursor|filter|stale/i, "a cursor is bound to its filter");
});

test("non-cooperative presentation settles on shutdown and handle truth remains live until settlement", async () => {
  let next = 0;
  const f = fixture({ createQuestionId: () => `noncoop-${++next}` });
  const toolPromise = f.service.createAndPresent({ nodeId: "worker", taskId: "task-1", definition, provenance: { source: "human_question", toolCallId: "noncoop" } }, async () => new Promise(() => {}));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.service.hasLiveHandles(), true);
  let shutdownResolved = false;
  const shuttingDown = f.service.shutdown().then(() => { shutdownResolved = true; });
  assert.equal(f.service.hasLiveHandles(), true, "shutdown must report the tracked wrapper until its abort race settles");
  assert.equal(shutdownResolved, false);
  await Promise.race([
    shuttingDown,
    new Promise((_, reject) => setTimeout(() => reject(new Error("question shutdown timed out")), 250)),
  ]);
  const result = await Promise.race([
    toolPromise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("question tool did not settle")), 250)),
  ]);
  assert.equal(result.state, "pending");
  assert.equal(f.service.hasLiveHandles(), false);
});

test("a pre-aborted non-cooperative presenter settles and cannot hang shutdown", async () => {
  const f = fixture();
  const caller = new AbortController();
  caller.abort("already cancelled");
  const presentation = f.service.createAndPresent({
    nodeId: "worker", taskId: "task-1", definition,
    provenance: { source: "human_question", toolCallId: "pre-aborted" },
  }, async () => new Promise(() => {}), caller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.race([
    f.service.shutdown(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pre-aborted shutdown timed out")), 100)),
  ]);
  const restored = await presentation;
  assert.equal(restored.state, "pending");
  assert.equal(f.service.hasLiveHandles(), false);
});

test("question queue DTO is cursor-paginated and bounded and shutdown clears presentation handles", async () => {
  let id = 0;
  const f = fixture({ createQuestionId: () => `question-${++id}` });
  for (let index = 0; index < 45; index++) create(f.service, { provenance: { source: "human_question", toolCallId: `call-${index}` } });
  const first = f.service.status({ state: "pending", limit: 40 });
  assert.equal(first.items.length, 40);
  assert.deepEqual(
    { projectId: first.items[0].projectId, sessionId: first.items[0].sessionId, runId: first.items[0].runId },
    { projectId: "project-1", sessionId: "session-1", runId: "run-1" },
    "dashboard controls need every exact durable identity, not only the object ID",
  );
  assert.equal(first.total, 45);
  assert.match(first.nextCursor ?? "", /^pending:[1-9][0-9]*$/u);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= 65_536);
  const second = f.service.status({ state: "pending", limit: 40, cursor: first.nextCursor });
  assert.equal(second.items.length, 5);

  let releasePresenter!: () => void;
  const presenterGate = new Promise<void>((resolve) => { releasePresenter = resolve; });
  const presentation = f.service.createAndPresent({ nodeId: "worker", taskId: "task-1", definition, provenance: { source: "human_question", toolCallId: "shutdown" } }, async () => {
    await presenterGate; // deliberately ignores AbortSignal
    return undefined;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.service.hasLiveHandles(), true);
  await f.service.shutdown();
  const settled = await Promise.race([presentation.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25))]);
  assert.equal(settled, true, "shutdown must settle the tool promise even when the UI presenter ignores abort");
  assert.equal(f.service.hasLiveHandles(), false);
  releasePresenter();
});
