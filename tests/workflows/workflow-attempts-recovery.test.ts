import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AttemptRuntime,
  attemptDescriptorForModel,
  attemptDescriptorFromCommandMetadata,
  attemptDescriptorFromTrustedTool,
  executeWithConservativeRetry,
  type AttemptDescriptor,
} from "../../src/workflows/attempts.ts";
import { analyzeCommand } from "../../src/capabilities/command.ts";
import { classifyTrustedTool } from "../../src/capabilities/tools.ts";
import { reconcileExpectedHashes, recoverUnknownSideEffects } from "../../src/workflows/recovery.ts";

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-attempts-"));
  let tick = 0;
  const runtime = new AttemptRuntime({
    projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1",
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  });
  return { projectRoot, runtime };
}

const readonlyTool: AttemptDescriptor = { effect: "tool", readOnly: true, idempotent: true };
const mutation: AttemptDescriptor = { effect: "filesystem", readOnly: false, idempotent: false };
const trustedRead = () => attemptDescriptorFromTrustedTool(classifyTrustedTool("read")!);
const trustedWrite = () => attemptDescriptorFromTrustedTool(classifyTrustedTool("write")!);

test("completed same attempt ID replays its bounded result while different input is rejected", () => {
  const { runtime } = fixture();
  const begun = runtime.begin({ attemptId: "attempt-1", correlationId: "correlation-1", nodeId: "worker", operation: "read", input: { path: "src/a.ts" }, descriptor: readonlyTool });
  assert.equal(begun.state, "started");
  runtime.complete("attempt-1", { ok: true, value: { hash: "abc" } });
  const replay = runtime.begin({ attemptId: "attempt-1", correlationId: "correlation-1", nodeId: "worker", operation: "read", input: { path: "src/a.ts" }, descriptor: readonlyTool });
  assert.equal(replay.state, "completed");
  if (replay.state === "completed") assert.deepEqual(replay.result, { ok: true, value: { hash: "abc" } });
  assert.throws(() => runtime.begin({ attemptId: "attempt-1", correlationId: "correlation-1", nodeId: "worker", operation: "read", input: { path: "src/b.ts" }, descriptor: readonlyTool }), /different input|reuse/i);
});

test("successful model result atomically binds deliveries created during that exact attempt before receipt settlement", async () => {
  const { projectRoot, runtime } = fixture();
  let providerCalls = 0;
  let receiptFaults = 0;
  const input = {
    correlationId: "dynamic-consumer", nodeId: "worker", operation: "provider.request", input: { promptHash: "a".repeat(64) },
    descriptor: attemptDescriptorForModel(),
    consumerReceipt: { deliveryIds: [], promptHash: "a".repeat(64), transcriptRef: "run:run-1/node:worker/task:task-1/transcript" },
    consumerReceiptAfterDispatch: () => ({ deliveryIds: ["dynamic-delivery"], promptHash: "a".repeat(64), transcriptRef: "run:run-1/node:worker/task:task-1/transcript" }),
    dispatch: async () => { providerCalls++; return "provider result"; },
    onConsumerCompleted: () => { if (receiptFaults++ === 0) throw new Error("persistent process stop before receipt"); },
  } as const;
  await assert.rejects(() => executeWithConservativeRetry(runtime, input), /before receipt/i);
  const completed = Object.values(runtime.restore().attempts)[0];
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.consumerReceipt?.deliveryIds, ["dynamic-delivery"]);
  assert.deepEqual(completed.intentConsumerReceipt?.deliveryIds, []);

  const restarted = new AttemptRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1" });
  assert.equal(await executeWithConservativeRetry(restarted, input), "provider result");
  assert.equal(providerCalls, 1, "durable successful result must replay without provider redispatch");
});

test("completed consumer replay exposes only its exact durable final delivery binding to settlement", async () => {
  const { projectRoot, runtime } = fixture();
  const durableBinding = { deliveryIds: ["delivery-old"], promptHash: "a".repeat(64), transcriptRef: "run:run-1/node:worker/task:task-1/transcript" } as const;
  runtime.begin({
    attemptId: "consumer-replay", correlationId: "consumer-replay-correlation", nodeId: "worker", operation: "provider.request",
    input: { promptHash: durableBinding.promptHash }, replayInput: { taskId: "task-1" }, descriptor: attemptDescriptorForModel(), consumerReceipt: durableBinding,
  });
  runtime.complete("consumer-replay", { ok: true, value: "old result" }, durableBinding);

  let settledBinding: unknown;
  const restarted = new AttemptRuntime({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1" });
  const result = await executeWithConservativeRetry(restarted, {
    correlationId: "reused-correlation", nodeId: "worker", operation: "provider.request",
    input: { promptHash: "b".repeat(64) }, replayInput: { taskId: "task-1" }, descriptor: attemptDescriptorForModel(),
    recoveryAttemptId: "consumer-replay", recoveryConsumerReceipt: durableBinding,
    consumerReceipt: { deliveryIds: ["delivery-old", "delivery-new"], promptHash: "b".repeat(64), transcriptRef: durableBinding.transcriptRef },
    dispatch: async () => "must not run",
    onConsumerCompleted: (_attemptId, binding) => { settledBinding = binding; },
  });
  assert.equal(result, "old result");
  assert.deepEqual(settledBinding, durableBinding);
});

test("model retries at most twice only before output/tool calls and every provider attempt is durable", async () => {
  const { runtime } = fixture();
  let calls = 0;
  const delays: number[] = [];
  const result = await executeWithConservativeRetry(runtime, {
    correlationId: "model-request", nodeId: "worker", operation: "provider.request", input: { promptHash: "p" },
    descriptor: attemptDescriptorForModel(),
    dispatch: async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("temporary transport"), { transient: true, assistantOutputObserved: false, toolCallObserved: false });
      return { ok: true };
    },
    sleep: async (ms) => { delays.push(ms); }, random: () => 0.5,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
  assert.equal(Object.keys(runtime.restore().attempts).length, 3);

  let outputCalls = 0;
  await assert.rejects(() => executeWithConservativeRetry(runtime, {
    correlationId: "model-output", nodeId: "worker", operation: "provider.request", input: {},
    descriptor: attemptDescriptorForModel(),
    dispatch: async () => { outputCalls++; throw Object.assign(new Error("late failure"), { transient: true, assistantOutputObserved: true }); },
    sleep: async () => {},
  }), /late failure/);
  assert.equal(outputCalls, 1);
});

test("retry classification trusts package descriptor identity and W08-produced command metadata", () => {
  assert.deepEqual(trustedRead(), readonlyTool);
  assert.throws(() => attemptDescriptorFromTrustedTool({ ...classifyTrustedTool("read")! }), /trusted|identity/i);
  assert.deepEqual(attemptDescriptorFromCommandMetadata(analyzeCommand("git status")), { effect: "git", readOnly: true, idempotent: true });
  assert.deepEqual(attemptDescriptorFromCommandMetadata(analyzeCommand("curl https://example.com")), { effect: "network", readOnly: true, idempotent: false });
  assert.deepEqual(attemptDescriptorFromCommandMetadata(analyzeCommand("unknown-command")), { effect: "shell", readOnly: false, idempotent: false });
  assert.throws(() => attemptDescriptorFromCommandMetadata({ ...analyzeCommand("git status") }), /trusted|identity/i);
});

test("read-only idempotent tool retries once; policy denial, mutation, shell, Git and network never retry", async () => {
  for (const [name, descriptor, denied] of [
    ["read", trustedRead(), false],
    ["denied-read", trustedRead(), true],
    ["mutation", trustedWrite(), false],
    ["shell", attemptDescriptorFromCommandMetadata(analyzeCommand("touch file.txt")), false],
    ["git", attemptDescriptorFromCommandMetadata(analyzeCommand("git add file.txt")), false],
    ["network", attemptDescriptorFromCommandMetadata(analyzeCommand("curl https://example.com")), false],
  ] as const) {
    const { runtime } = fixture();
    let calls = 0;
    const execute = executeWithConservativeRetry(runtime, {
      correlationId: name, nodeId: "worker", operation: name, input: {}, descriptor,
      dispatch: async () => { calls++; throw Object.assign(new Error("transient"), { transient: true, policyDenied: denied }); },
      sleep: async () => {}, random: () => 0.5,
    });
    await assert.rejects(() => execute, /transient/);
    assert.equal(calls, name === "read" ? 2 : 1, name);
  }
});

test("crash intent without result reconciles mutations or pauses unknown_side_effect and never redispatches", async () => {
  const { runtime } = fixture();
  runtime.begin({ attemptId: "fs-applied", correlationId: "fs", nodeId: "worker", operation: "write", input: { path: "a" }, descriptor: mutation });
  runtime.begin({ attemptId: "git-unknown", correlationId: "git", nodeId: "worker", operation: "git", input: {}, descriptor: { effect: "git", readOnly: false, idempotent: false } });
  runtime.begin({ attemptId: "network-unknown", correlationId: "net", nodeId: "worker", operation: "post", input: {}, descriptor: { effect: "network", readOnly: false, idempotent: false } });
  let pauses = 0;
  let dispatched = 0;
  const report = await recoverUnknownSideEffects(runtime, {
    reconcilers: {
      filesystem: async () => ({ state: "applied", result: { ok: true, value: { afterHash: "known" } } }),
      git: async () => ({ state: "unknown", diagnostic: "index and worktree diverged" }),
    },
    pauseUnknownSideEffect: async (diagnostics) => { pauses++; assert.match(diagnostics.join(" "), /git-unknown|network-unknown/); },
    redispatch: async () => { dispatched++; },
  });
  assert.equal(dispatched, 0);
  assert.equal(pauses, 1);
  assert.equal(report.reconciled.length, 1);
  assert.deepEqual(new Set(report.unresolved), new Set(["git-unknown", "network-unknown"]));
  assert.equal(runtime.restore().attempts["fs-applied"].status, "completed");
  assert.equal(runtime.restore().attempts["git-unknown"].status, "unknown_side_effect");
});

test("hash recovery proves applied/not-applied and otherwise remains unknown", () => {
  assert.deepEqual(reconcileExpectedHashes({ expectedBeforeHash: "before", expectedAfterHash: "after", currentHash: "after" }), {
    state: "applied", result: { ok: true, value: { afterHash: "after" } },
  });
  assert.deepEqual(reconcileExpectedHashes({ expectedBeforeHash: "before", expectedAfterHash: "after", currentHash: "before" }), {
    state: "not-applied", result: { ok: false, error: "effect was proven not applied" },
  });
  assert.equal(reconcileExpectedHashes({ expectedBeforeHash: "before", expectedAfterHash: "after", currentHash: "other" }).state, "unknown");
  assert.deepEqual(reconcileExpectedHashes({ expectedAfterHash: "after", currentHash: "after", appliedResult: { custom: true } }), {
    state: "applied", result: { ok: true, value: { custom: true } },
  });
  assert.equal(reconcileExpectedHashes({ currentHash: "untracked" }).state, "unknown");
  assert.equal(reconcileExpectedHashes({}).state, "not-applied");
});

test("recovery with no pending effects is a no-op and never pauses", async () => {
  const { runtime } = fixture();
  let pauses = 0;
  const report = await recoverUnknownSideEffects(runtime, { pauseUnknownSideEffect: () => { pauses++; } });
  assert.deepEqual(report, { reconciled: [], safeRetry: [], unresolved: [], diagnostics: [], paused: false });
  assert.equal(pauses, 0);
});

test("recovery supplies a bounded fallback when a reconciler returns an empty diagnostic", async () => {
  const { runtime } = fixture();
  runtime.begin({ attemptId: "empty-diagnostic", correlationId: "empty", nodeId: "worker", operation: "write", input: {}, descriptor: mutation });
  const report = await recoverUnknownSideEffects(runtime, {
    reconcilers: { filesystem: () => ({ state: "unknown", diagnostic: "" }) },
    pauseUnknownSideEffect: () => {},
  });
  assert.match(report.diagnostics[0], /no diagnostic/);
  assert.equal(report.paused, true);
});

test("recovery bounds the final composed diagnostic before durable unknown marking", async () => {
  const { runtime } = fixture();
  runtime.begin({ attemptId: "long-unknown", correlationId: "long", nodeId: "worker", operation: "write", input: {}, descriptor: mutation });
  let paused = false;
  const report = await recoverUnknownSideEffects(runtime, {
    reconcilers: { filesystem: () => ({ state: "unknown", diagnostic: "ø".repeat(10_000) }) },
    pauseUnknownSideEffect: () => { paused = true; },
  });
  assert.equal(paused, true);
  assert.equal(report.paused, true);
  assert.ok(Buffer.byteLength(report.diagnostics[0], "utf8") <= 8_192);
  assert.equal(runtime.restore().attempts["long-unknown"].status, "unknown_side_effect");
});

test("recovery handles trusted not-applied proof and reconciler faults without redispatch", async () => {
  const { runtime } = fixture();
  runtime.begin({ attemptId: "artifact-not-applied", correlationId: "artifact", nodeId: "worker", operation: "update", input: {}, descriptor: { effect: "artifact", readOnly: false, idempotent: false } });
  runtime.begin({ attemptId: "shell-reconciler-fault", correlationId: "shell", nodeId: "worker", operation: "bash", input: {}, descriptor: { effect: "shell", readOnly: false, idempotent: false } });
  const paused: string[][] = [];
  const report = await recoverUnknownSideEffects(runtime, {
    reconcilers: {
      artifact: () => ({ state: "not-applied", result: { ok: false, error: "not applied" } }),
      shell: () => { throw new Error("probe crashed"); },
    },
    pauseUnknownSideEffect: (diagnostics) => { paused.push([...diagnostics]); },
  });
  assert.deepEqual(report.reconciled, ["artifact-not-applied"]);
  assert.deepEqual(report.unresolved, ["shell-reconciler-fault"]);
  assert.match(paused[0][0], /probe crashed/);
  assert.equal(runtime.restore().attempts["artifact-not-applied"].status, "failed");
});

test("attempt completion is idempotent only for the exact result and unknown marking is idempotent", () => {
  const { runtime } = fixture();
  runtime.begin({ attemptId: "mutation", correlationId: "mutation-c", nodeId: "worker", operation: "write", input: {}, descriptor: mutation });
  runtime.markUnknown("mutation", "needs inspection");
  runtime.markUnknown("mutation", "needs inspection");
  runtime.reconcile("mutation", "applied", { ok: true, value: "done" });
  assert.deepEqual(runtime.complete("mutation", { ok: true, value: "done" }), { ok: true, value: "done" });
  assert.throws(() => runtime.complete("mutation", { ok: true, value: "different" }), /conflict/i);
  assert.throws(() => runtime.markUnknown("mutation", "late"), /unresolved/i);
});

test("closed trusted factories classify subsystem tools and dispatch rejects copied descriptors", async () => {
  assert.deepEqual(attemptDescriptorFromTrustedTool(classifyTrustedTool("artifact_action")!), { effect: "artifact", readOnly: false, idempotent: false });
  assert.deepEqual(attemptDescriptorFromTrustedTool(classifyTrustedTool("human_question")!), { effect: "question", readOnly: false, idempotent: false });
  assert.deepEqual(attemptDescriptorFromTrustedTool(classifyTrustedTool("delegate_agent")!), { effect: "delegation", readOnly: false, idempotent: false });
  const { runtime } = fixture();
  await assert.rejects(() => executeWithConservativeRetry(runtime, {
    correlationId: "forged", nodeId: "worker", operation: "read", input: {},
    descriptor: { ...trustedRead() }, dispatch: async () => "must not run",
  }), /package-branded|trusted/i);
});

test("invalid trusted descriptors and non-finite retry jitter fail closed or stay bounded", async () => {
  assert.throws(() => attemptDescriptorFromCommandMetadata(null as never), /trusted|invalid/i);
  assert.throws(() => attemptDescriptorFromTrustedTool({ name: "write" } as never), /trusted|identity/i);
  const { runtime } = fixture();
  const delays: number[] = [];
  let calls = 0;
  await assert.rejects(() => executeWithConservativeRetry(runtime, {
    correlationId: "nan-jitter", nodeId: "worker", operation: "read", input: {}, descriptor: trustedRead(),
    dispatch: async () => { calls++; throw Object.assign(new Error("temporary"), { transient: true }); },
    random: () => Number.NaN, sleep: (delay) => { delays.push(delay); },
  }), /temporary/);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [100]);
});

test("uncertain mutating dispatch failures remain unresolved instead of being recorded conclusively failed", async () => {
  const { runtime } = fixture();
  await assert.rejects(() => executeWithConservativeRetry(runtime, {
    correlationId: "lost-write", nodeId: "worker", operation: "write", input: { path: "file.txt" }, descriptor: trustedWrite(),
    dispatch: async () => { throw Object.assign(new Error("transport lost after dispatch"), { transient: true }); },
  }), /transport lost/);
  const attempt = Object.values(runtime.restore().attempts)[0];
  assert.equal(attempt.status, "unknown_side_effect");
  assert.equal(attempt.result, undefined);
  assert.equal(attempt.recovery, "reconcile-required");

  const proven = fixture().runtime;
  await assert.rejects(() => executeWithConservativeRetry(proven, {
    correlationId: "denied-write", nodeId: "worker", operation: "write", input: {}, descriptor: trustedWrite(),
    dispatch: async () => { throw Object.assign(new Error("denied"), { policyDenied: true, effectNotApplied: true }); },
  }), /denied/);
  assert.equal(Object.values(proven.restore().attempts)[0].status, "failed");
});

test("pending read intent is retryable after restart but pending model/mutation intents require reconciliation", async () => {
  const { runtime } = fixture();
  runtime.begin({ attemptId: "read-pending", correlationId: "read", nodeId: "worker", operation: "read", input: {}, descriptor: readonlyTool });
  runtime.begin({ attemptId: "model-pending", correlationId: "model", nodeId: "worker", operation: "provider.request", input: {}, descriptor: { effect: "model", readOnly: true, idempotent: true } });
  runtime.begin({ attemptId: "write-pending", correlationId: "write", nodeId: "worker", operation: "write", input: {}, descriptor: mutation });
  const restarted = new AttemptRuntime(runtime.options);
  const state = restarted.restore();
  assert.equal(state.attempts["read-pending"].recovery, "safe-retry");
  assert.equal(state.attempts["model-pending"].recovery, "reconcile-required");
  assert.equal(state.attempts["write-pending"].recovery, "reconcile-required");
  const report = await recoverUnknownSideEffects(restarted, { pauseUnknownSideEffect: () => {} });
  assert.deepEqual(report.safeRetry, ["read-pending"]);
  assert.deepEqual(new Set(report.unresolved), new Set(["model-pending", "write-pending"]));
  assert.equal(restarted.restore().attempts["model-pending"].status, "unknown_side_effect");
});

test("trusted read-only artifact status retries and successful undefined results remain completed", async () => {
  const artifactStatus = attemptDescriptorFromTrustedTool(classifyTrustedTool("artifact_status")!);
  assert.deepEqual(artifactStatus, { effect: "artifact", readOnly: true, idempotent: true });
  const { runtime } = fixture();
  let calls = 0;
  const value = await executeWithConservativeRetry(runtime, {
    correlationId: "artifact-status", nodeId: "worker", operation: "artifact.status", input: {}, descriptor: artifactStatus,
    dispatch: async () => { calls++; if (calls === 1) throw Object.assign(new Error("transport"), { transient: true, effectNotApplied: true }); return undefined; },
    sleep: () => {},
  });
  assert.equal(value, undefined);
  assert.equal(calls, 2);
  const attempts = Object.values(runtime.restore().attempts);
  assert.equal(attempts[0].status, "failed");
  assert.equal(attempts[1].status, "completed");
  assert.deepEqual(attempts[1].result, { ok: true });
});

test("budget exhaustion metadata is durably bounded on a failed attempt", async () => {
  const { runtime } = fixture();
  await assert.rejects(() => executeWithConservativeRetry(runtime, {
    correlationId: "budget-denial", nodeId: "root", operation: "root.finalize", input: {}, descriptor: attemptDescriptorForModel(),
    dispatch: async () => { throw Object.assign(new Error("reserve exhausted"), { policyDenied: true, effectNotApplied: true, budgetExhausted: ["root finalization model reserve"] }); },
  }), /reserve exhausted/);
  const attempt = Object.values(runtime.restore().attempts)[0];
  assert.equal(attempt.status, "failed");
  assert.deepEqual(attempt.result?.budgetExhausted, ["root finalization model reserve"]);
});
