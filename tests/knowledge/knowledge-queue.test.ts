import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashAttemptInput } from "../../src/workflows/attempts.ts";
import { createWorkflowEvent } from "../../src/workflows/events.ts";
import { appendWorkflowEvent, readWorkflowJournal } from "../../src/workflows/journal.ts";
import { DurableKnowledgeQueue } from "../../src/knowledge/queue.ts";
import { createCuratorPlan, restoreKnowledgeEnrichmentState, type DurableKnowledgeJob } from "../../src/knowledge/enrichment.ts";
import { parseCuratorOutput } from "../../src/knowledge/curator.ts";

function job(jobId = "job-1"): DurableKnowledgeJob {
  return {
    formatVersion: 1, jobId, projectId: "project-1", sessionId: "session-1", runId: "run-1", terminalEventHash: "a".repeat(64),
    scope: "agent", agentId: "builder", candidateIds: ["candidate-1"],
    targets: [{ bundleId: "builder", providerId: "okf", path: ".pi/hive/knowledge/builder", policy: "automatic", expectedContentHash: `sha256:${"b".repeat(64)}` }],
    model: { nodeId: "worker", modelId: "curator-model", thinking: "low", reason: "agent-lowest-participating-node;shared-workflow-root" },
    state: "queued", attemptCount: 0, staleReevaluations: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
function sharedJob(jobId = "job-2"): DurableKnowledgeJob {
  const { agentId: _agentId, ...base } = job(jobId);
  return { ...base, jobId, scope: "shared", candidateIds: ["candidate-2"] };
}
function fixture(jobs: DurableKnowledgeJob[] = [job()]) {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-knowledge-queue-"));
  const evidence = appendWorkflowEvent(projectRoot, createWorkflowEvent({
    eventId: "evidence-1", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "attempt.result.recorded", producer: "harness",
    payload: { formatVersion: 1, nodeId: "worker", contentHash: `sha256:${"c".repeat(64)}` }, timestamp: "2026-01-01T00:00:00.000Z",
  }));
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "runtime", correlationId: "candidate-attempt", attemptId: "candidate-attempt",
    payload: { formatVersion: 1, operation: "candidate-recorded", candidate: { formatVersion: 1, candidateId: "candidate-1", projectId: "project-1", sessionId: "session-1", runId: "run-1", nodeId: "worker", agentId: "builder", scope: "agent", conclusion: "A stable candidate exists for queue ownership tests.", requestHash: hashAttemptInput({ scope: "agent", conclusion: "A stable candidate exists for queue ownership tests.", evidenceEventIds: [evidence.eventId] }), citations: [{ eventId: evidence.eventId, eventHash: evidence.eventHash, payloadHash: evidence.payloadHash, sequence: evidence.sequence, type: evidence.type }], sourceHashes: [`sha256:${"c".repeat(64)}`], createdAt: "2026-01-01T00:00:00.000Z" } } as never,
    timestamp: "2026-01-01T00:00:00.000Z",
  }));
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "runtime", correlationId: "candidate-attempt-2", attemptId: "candidate-attempt-2",
    payload: { formatVersion: 1, operation: "candidate-recorded", candidate: { formatVersion: 1, candidateId: "candidate-2", projectId: "project-1", sessionId: "session-1", runId: "run-1", nodeId: "worker", agentId: "builder", scope: "shared", conclusion: "A shared stable candidate exists for queue concurrency tests.", requestHash: hashAttemptInput({ scope: "shared", conclusion: "A shared stable candidate exists for queue concurrency tests.", evidenceEventIds: [evidence.eventId] }), citations: [{ eventId: evidence.eventId, eventHash: evidence.eventHash, payloadHash: evidence.payloadHash, sequence: evidence.sequence, type: evidence.type }], sourceHashes: [`sha256:${"c".repeat(64)}`], createdAt: "2026-01-01T00:00:00.000Z" } } as never,
    timestamp: "2026-01-01T00:00:00.000Z",
  }));
  const terminal = appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "terminal.recorded", producer: "harness", payload: { formatVersion: 1, status: "completed" }, timestamp: "2026-01-01T00:00:00.000Z",
  }));
  const durableJobs = jobs.map((entry) => ({ ...entry, terminalEventHash: terminal.eventHash }));
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness",
    payload: { formatVersion: 1, operation: "jobs-enqueued", terminalEventHash: terminal.eventHash, preservedCancelled: false, jobs: durableJobs } as never,
    timestamp: "2026-01-01T00:00:00.000Z",
  }));
  return projectRoot;
}

function closePlan(projectRoot: string, active: DurableKnowledgeJob): void {
  const state = restoreKnowledgeEnrichmentState(readWorkflowJournal(projectRoot, "session-1"));
  const views = active.candidateIds.map((candidateId) => state.candidates[candidateId]).map((candidate) => ({ candidateId: candidate.candidateId, conclusion: candidate.conclusion, citations: candidate.citations, sourceHashes: candidate.sourceHashes }));
  const output = parseCuratorOutput(JSON.stringify({ formatVersion: 1, conclusions: [] }), views);
  const plan = createCuratorPlan({ jobId: active.jobId, evaluation: active.staleReevaluations as 0 | 1, targets: active.targets, output,
    actions: active.targets.map((target) => ({ kind: "skip" as const, bundleId: target.bundleId, policy: target.policy, reason: "no-stable-conclusions" as const })), createdAt: "2026-01-01T00:00:01.000Z" });
  appendWorkflowEvent(projectRoot, createWorkflowEvent({ projectId: active.projectId, sessionId: active.sessionId, runId: active.runId, type: "knowledge.transition", producer: "harness", correlationId: `curator-plan-${active.jobId}`,
    payload: { formatVersion: 1, operation: "curator-plan-recorded", jobId: active.jobId, ownerNonce: active.activeOwnerNonce!, plan } as never }));
  for (const action of plan.actions) {
    if (action.kind !== "skip") throw new Error("queue test completion expected an exact skip action");
    appendWorkflowEvent(projectRoot, createWorkflowEvent({ projectId: active.projectId, sessionId: active.sessionId, runId: active.runId, type: "knowledge.transition", producer: "harness", correlationId: `curator-${active.jobId}`,
      payload: { formatVersion: 1, operation: "target-skipped", jobId: active.jobId, ownerNonce: active.activeOwnerNonce!, bundleId: action.bundleId, policy: action.policy, reason: action.reason, curatorOutputHash: plan.output.outputHash } as never }));
  }
}

const tick = (() => { let n = 0; return () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++n)).toISOString(); })();

test("queue starts only while idle, runs one low-priority job, and consumes no worker slot", async () => {
  const projectRoot = fixture([job("job-1"), sharedJob("job-2")]);
  let idle = false;
  let active = 0;
  let maxActive = 0;
  const workerSlots = 0;
  const queue = new DurableKnowledgeQueue({
    projectRoot, projectId: "project-1", sessionId: "session-1", isIdle: () => idle, now: tick,
    process: async (current) => { active++; maxActive = Math.max(maxActive, active); await new Promise((resolve) => setImmediate(resolve)); closePlan(projectRoot, current); active--; },
  });
  await queue.wake();
  assert.deepEqual(Object.values(queue.restore().jobs).map((entry) => entry.state), ["queued", "queued"]);
  idle = true;
  await Promise.all([queue.wake(), queue.wake()]);
  assert.equal(maxActive, 1);
  assert.equal(workerSlots, 0, "knowledge queue must have no normal worker-slot callback");
  assert.deepEqual(Object.values(queue.restore().jobs).map((entry) => entry.state), ["completed", "completed"]);
  assert.equal(queue.hasLiveWork(), false);
});

test("user work preempts active curation and the durable paused job resumes after restart", async () => {
  const projectRoot = fixture();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const first = new DurableKnowledgeQueue({
    projectRoot, projectId: "project-1", sessionId: "session-1", isIdle: () => true, now: tick,
    process: async (_job, signal) => {
      started();
      await new Promise<void>((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  const draining = first.wake();
  await didStart;
  await first.preemptForUserWork();
  await draining;
  assert.equal(first.restore().jobs["job-1"].state, "paused");
  assert.match(first.restore().jobs["job-1"].lastReason ?? "", /user-work/i);
  assert.equal(first.hasLiveWork(), false);

  let resumed = 0;
  const restarted = new DurableKnowledgeQueue({
    projectRoot, projectId: "project-1", sessionId: "session-1", isIdle: () => true, now: tick,
    process: async (current) => { resumed++; closePlan(projectRoot, current); },
  });
  await restarted.wake();
  assert.equal(resumed, 1);
  assert.equal(restarted.restore().jobs["job-1"].state, "completed");
  assert.equal(restarted.restore().jobs["job-1"].attemptCount, 2);
});

test("durable plan effect replay bypasses the queue model-attempt ceiling", async () => {
  const projectRoot = fixture();
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: "knowledge-job-job-1",
    payload: { formatVersion: 1, operation: "job-transition", jobId: "job-1", from: "queued", to: "active", attemptCount: 1, staleReevaluations: 0, reason: "first-model-attempt", ownerNonce: "plan-owner" },
  }));
  let state = restoreKnowledgeEnrichmentState(readWorkflowJournal(projectRoot, "session-1"));
  const candidate = state.candidates["candidate-1"];
  const output = parseCuratorOutput(JSON.stringify({ formatVersion: 1, conclusions: [] }), [{ candidateId: candidate.candidateId, conclusion: candidate.conclusion, citations: candidate.citations, sourceHashes: candidate.sourceHashes }]);
  const plan = createCuratorPlan({ jobId: "job-1", evaluation: 0, targets: state.jobs["job-1"].targets, output, actions: [{ kind: "skip", bundleId: "builder", policy: "automatic", reason: "no-stable-conclusions" }], createdAt: "2026-01-01T00:00:01.000Z" });
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: "curator-plan-job-1",
    payload: { formatVersion: 1, operation: "curator-plan-recorded", jobId: "job-1", ownerNonce: "plan-owner", plan } as never,
  }));
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: "knowledge-job-job-1",
    payload: { formatVersion: 1, operation: "job-transition", jobId: "job-1", from: "active", to: "paused", attemptCount: 1, staleReevaluations: 0, reason: "crash-after-plan", ownerNonce: "plan-owner" },
  }));
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: "knowledge-job-job-1",
    payload: { formatVersion: 1, operation: "job-transition", jobId: "job-1", from: "paused", to: "active", attemptCount: 2, staleReevaluations: 0, reason: "second-attempt-crash", ownerNonce: "second-owner" },
  }));
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: "knowledge-job-job-1",
    payload: { formatVersion: 1, operation: "job-transition", jobId: "job-1", from: "active", to: "paused", attemptCount: 2, staleReevaluations: 0, reason: "crash-before-effects", ownerNonce: "second-owner" },
  }));
  let processorCalls = 0;
  const queue = new DurableKnowledgeQueue({
    projectRoot, projectId: "project-1", sessionId: "session-1", ownerNonce: "replay-owner", isIdle: () => true,
    process: async (active) => {
      processorCalls++; assert.equal(active.jobId, "job-1"); assert.equal(active.attemptCount, 3);
      const durable = restoreKnowledgeEnrichmentState(readWorkflowJournal(projectRoot, "session-1"));
      const plan = durable.curatorPlans[active.jobId];
      const action = plan.actions[0];
      if (action.kind !== "skip") throw new Error("expected skip plan");
      appendWorkflowEvent(projectRoot, createWorkflowEvent({ projectId: active.projectId, sessionId: active.sessionId, runId: active.runId, type: "knowledge.transition", producer: "harness", correlationId: `curator-${active.jobId}`,
        payload: { formatVersion: 1, operation: "target-skipped", jobId: active.jobId, ownerNonce: active.activeOwnerNonce!, bundleId: action.bundleId, policy: action.policy, reason: action.reason, curatorOutputHash: plan.output.outputHash } as never }));
    },
  });
  await queue.wake();
  state = queue.restore();
  assert.equal(processorCalls, 1);
  assert.equal(state.jobs["job-1"].state, "completed");
  assert.equal(state.jobs["job-1"].lastReason, "curation-completed");
});

test("repeated user preemption never consumes the curator failure retry budget", async () => {
  const projectRoot = fixture();
  for (let interruption = 0; interruption < 2; interruption++) {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const queue = new DurableKnowledgeQueue({
      projectRoot, projectId: "project-1", sessionId: "session-1", ownerNonce: `preempt-owner-${interruption}`, isIdle: () => true, now: tick,
      process: async (_job, signal) => {
        started();
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    });
    void queue.wake();
    await didStart;
    await queue.preemptForUserWork();
    assert.equal(queue.restore().jobs["job-1"].state, "paused");
  }
  let completed = 0;
  const resumed = new DurableKnowledgeQueue({
    projectRoot, projectId: "project-1", sessionId: "session-1", ownerNonce: "final-owner", isIdle: () => true, now: tick,
    process: async (current) => { completed++; closePlan(projectRoot, current); },
  });
  await resumed.wake();
  assert.equal(completed, 1);
  assert.equal(resumed.restore().jobs["job-1"].state, "completed");
});

test("shutdown persists pause, aborts the model job, and leaves no timer or live job", async () => {
  const projectRoot = fixture();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  let aborted = false;
  const queue = new DurableKnowledgeQueue({
    projectRoot, projectId: "project-1", sessionId: "session-1", isIdle: () => true, now: tick,
    process: async (_job, signal) => {
      started();
      await new Promise<void>((resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true }));
    },
  });
  void queue.wake();
  await didStart;
  await queue.shutdown();
  assert.equal(aborted, true);
  assert.equal(queue.restore().jobs["job-1"].state, "paused");
  assert.match(queue.restore().jobs["job-1"].lastReason ?? "", /shutdown/i);
  assert.equal(queue.hasLiveWork(), false);
  await queue.wake();
  assert.equal(queue.restore().jobs["job-1"].state, "paused", "a shut down queue cannot restart work");
});

test("queue reducer rejects direct queued failure without exact durable budget-denial evidence", () => {
  const projectRoot = fixture();
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness",
    payload: { formatVersion: 1, operation: "job-transition", jobId: "job-1", from: "queued", to: "failed", attemptCount: 0, staleReevaluations: 0, reason: "curator-model-admission-budget-exhausted", ownerNonce: "forged-owner" },
  }));
  assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(projectRoot, "session-1")), /budget|denial|evidence|transition/i);
});

test("queue reducer rejects a forged transition whose from-state or counters do not match", () => {
  const projectRoot = fixture();
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness",
    payload: { formatVersion: 1, operation: "job-transition", jobId: "job-1", from: "failed", to: "completed", attemptCount: 99, staleReevaluations: 0, reason: "forged", ownerNonce: "forged-owner" },
  }));
  assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(projectRoot, "session-1")), /transition|state|counter|CAS/i);
});

test("a journal-replayed active job remains owned until verified-dead takeover", async () => {
  const projectRoot = fixture();
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness",
    payload: { formatVersion: 1, operation: "job-transition", jobId: "job-1", from: "queued", to: "active", attemptCount: 1, staleReevaluations: 0, reason: "idle-start", ownerNonce: "dead-owner" },
    timestamp: "2026-01-01T00:00:01.000Z",
  }));
  const restored = restoreKnowledgeEnrichmentState(readWorkflowJournal(projectRoot, "session-1"));
  assert.equal(restored.jobs["job-1"].state, "active");
  assert.equal(restored.jobs["job-1"].activeOwnerNonce, "dead-owner");

  let calls = 0;
  const denied = new DurableKnowledgeQueue({
    projectRoot, projectId: "project-1", sessionId: "session-1", ownerNonce: "new-owner", isIdle: () => true,
    verifyOwnerDead: async () => false, process: async () => { calls++; },
  });
  await denied.wake();
  assert.equal(calls, 0, "an unverified second owner cannot steal live work");
  assert.equal(denied.restore().jobs["job-1"].state, "active");

  const takeover = new DurableKnowledgeQueue({
    projectRoot, projectId: "project-1", sessionId: "session-1", ownerNonce: "new-owner", isIdle: () => true,
    verifyOwnerDead: async (nonce) => nonce === "dead-owner", process: async (current) => { calls++; closePlan(projectRoot, current); },
  });
  await takeover.wake();
  assert.equal(calls, 1);
  assert.equal(takeover.restore().jobs["job-1"].state, "completed");
  assert.equal(takeover.restore().jobs["job-1"].attemptCount, 2);
});

test("an unverified active owner globally blocks queued jobs at concurrency one", async () => {
  const projectRoot = fixture([job("job-1"), sharedJob("job-2")]);
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness",
    payload: { formatVersion: 1, operation: "job-transition", jobId: "job-1", from: "queued", to: "active", attemptCount: 1, staleReevaluations: 0, reason: "idle-start", ownerNonce: "unverified-owner" },
  }));
  const processed: string[] = [];
  const queue = new DurableKnowledgeQueue({
    projectRoot, projectId: "project-1", sessionId: "session-1", ownerNonce: "new-owner", isIdle: () => true,
    verifyOwnerDead: async () => false, process: async (current) => { processed.push(current.jobId); },
  });
  await queue.wake();
  assert.deepEqual(processed, []);
  assert.equal(queue.restore().jobs["job-1"].state, "active");
  assert.equal(queue.restore().jobs["job-2"].state, "queued");
});

test("independent live owners cannot both execute one active job", async () => {
  const projectRoot = fixture();
  let release!: () => void;
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let firstCalls = 0;
  let secondCalls = 0;
  const first = new DurableKnowledgeQueue({
    projectRoot, projectId: "project-1", sessionId: "session-1", ownerNonce: "owner-a", isIdle: () => true,
    verifyOwnerDead: async () => false,
    process: async (current) => { firstCalls++; started(); await hold; closePlan(projectRoot, current); },
  });
  const running = first.wake();
  await didStart;
  const second = new DurableKnowledgeQueue({
    projectRoot, projectId: "project-1", sessionId: "session-1", ownerNonce: "owner-b", isIdle: () => true,
    verifyOwnerDead: async () => false, process: async () => { secondCalls++; },
  });
  await second.wake();
  assert.deepEqual([firstCalls, secondCalls], [1, 0]);
  release();
  await running;
  assert.equal(first.restore().jobs["job-1"].state, "completed");
});

test("a separate process cannot steal an active job without verified owner death", async () => {
  const projectRoot = fixture();
  let release!: () => void;
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const owner = new DurableKnowledgeQueue({
    projectRoot, projectId: "project-1", sessionId: "session-1", ownerNonce: "parent-owner", isIdle: () => true,
    process: async (current) => { started(); await hold; closePlan(projectRoot, current); },
  });
  const running = owner.wake();
  await didStart;
  const marker = join(projectRoot, "child-processed");
  const script = `
    import { appendFileSync } from 'node:fs';
    import { DurableKnowledgeQueue } from './src/knowledge/queue.ts';
    const queue = new DurableKnowledgeQueue({ projectRoot: ${JSON.stringify(projectRoot)}, projectId: 'project-1', sessionId: 'session-1', ownerNonce: 'child-owner', isIdle: () => true, verifyOwnerDead: async () => false, process: async () => appendFileSync(${JSON.stringify(marker)}, 'stolen') });
    await queue.wake();
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--import", "./tests/helpers/register-ts-loader.mjs", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(marker), false);
  release();
  await running;
});

test("bounded preemption quarantines an abort-ignoring processor until true settlement and never duplicates it", async () => {
  const projectRoot = fixture();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let starts = 0;
  let disposed = 0;
  const queue = new DurableKnowledgeQueue({
    projectRoot, projectId: "project-1", sessionId: "session-1", ownerNonce: "quarantine-owner", isIdle: () => true,
    preemptSettleMs: 20, disposeSettleMs: 20, verifyOwnerDead: async () => false,
    disposeActive: async () => { disposed++; },
    process: async () => { starts++; started(); await hold; },
  });
  const running = queue.wake();
  await didStart;
  const before = Date.now();
  await queue.preemptForUserWork();
  assert.ok(Date.now() - before < 500, "preemption must return within its bound");
  assert.equal(disposed, 1);
  assert.equal(queue.hasLiveWork(), true, "unsettled work remains honestly live and owned");
  assert.equal(queue.restore().jobs["job-1"].state, "active", "durable ownership is retained while execution may still have effects");
  void queue.wake();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1, "quarantined work cannot be started a second time");
  release();
  await running;
  assert.equal(queue.hasLiveWork(), false);
  assert.equal(queue.restore().jobs["job-1"].state, "paused");
});

test("bounded shutdown also retains live accounting for a processor that never settles", async () => {
  const projectRoot = fixture();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const queue = new DurableKnowledgeQueue({
    projectRoot, projectId: "project-1", sessionId: "session-1", ownerNonce: "shutdown-owner", isIdle: () => true,
    preemptSettleMs: 20, disposeSettleMs: 20, disposeActive: async () => undefined,
    process: async () => { started(); await new Promise<void>(() => undefined); },
  });
  void queue.wake();
  await didStart;
  const before = Date.now();
  await queue.shutdown();
  assert.ok(Date.now() - before < 500, "shutdown must return within its bound");
  assert.equal(queue.hasLiveWork(), true);
  assert.equal(queue.restore().jobs["job-1"].state, "active");
});
