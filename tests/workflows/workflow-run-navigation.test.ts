import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerWorkflowRunHooks } from "../../src/integration/run-lifecycle.ts";
import { WorkflowRunLifecycle } from "../../src/workflows/runs.ts";

function fixture(sessionId = "s", lifecycleOptions: Record<string, unknown> = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-run-navigation-"));
  let tick = 0;
  const lifecycle = new WorkflowRunLifecycle({ projectRoot, projectId: "p", sessionId, snapshotId: "snap", rootNodeId: "root", createRunId: () => `run-${sessionId}`, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(), ...lifecycleOptions });
  lifecycle.recordUserInput({ inputId: `initial-${sessionId}`, text: "work", source: "interactive" });
  return lifecycle;
}

test("pause persists hashes before navigation releases authority and resume requires owner/lease/hash checks", async () => {
  const lifecycle = fixture();
  const order: string[] = [];
  await lifecycle.pause("workflow switch", {
    suspendOwnedWork: async () => { order.push("suspend"); },
    captureState: async () => { order.push("capture"); return { workspaceHash: "sha256:paused" }; },
    releaseLeases: async () => { order.push(`leases:${lifecycle.restore().latestRun?.status}`); },
    releaseOwnership: async () => { order.push(`owner:${lifecycle.restore().latestRun?.status}`); },
  });
  assert.deepEqual(order, ["suspend", "capture", "leases:paused", "owner:paused"]);
  assert.equal(lifecycle.restore().latestRun?.pauseState?.workspaceHash, "sha256:paused");

  const failedOrder: string[] = [];
  await assert.rejects(() => lifecycle.resume({
    acquireOwnership: async () => { failedOrder.push("owner"); },
    acquireLeases: async () => { failedOrder.push("leases"); },
    revalidateHashes: async (state) => { failedOrder.push(String(state.workspaceHash)); return false; },
    rollbackAuthority: async () => { failedOrder.push("rollback"); },
  }), /hash/i);
  assert.deepEqual(failedOrder, ["owner", "leases", "sha256:paused", "rollback"]);
  assert.equal(lifecycle.restore().latestRun?.status, "paused");

  await lifecycle.resume({ acquireOwnership: async () => {}, acquireLeases: async () => {}, revalidateHashes: async () => true, rollbackAuthority: async () => {} });
  assert.equal(lifecycle.restore().latestRun?.status, "running");
});

test("incomplete pause authority release stays durable, blocks navigation, and retries on an already-paused run", async () => {
  const lifecycle = fixture("release-retry");
  let releaseAttempts = 0;
  const handlers = new Map<string, (event: any) => any>();
  const pi = { on(name: string, handler: (event: any) => any) { handlers.set(name, handler); } } as any;
  registerWorkflowRunHooks(pi, {
    resolveLifecycle: () => lifecycle,
    pauseCoordinator: {
      releaseLeases: async () => { releaseAttempts += 1; },
      releaseOwnership: async () => { if (releaseAttempts === 1) throw new Error("owner registry unavailable"); },
    },
    resumeCoordinator: {
      acquireOwnership: async () => {},
      acquireLeases: async () => {},
      revalidateHashes: async () => true,
      rollbackAuthority: async () => {},
    },
  });

  assert.deepEqual(await handlers.get("session_before_switch")!({ reason: "new" }), { cancel: true });
  assert.equal(lifecycle.restore().latestRun?.status, "paused", "pause state must precede authority release");
  assert.equal(lifecycle.restore().latestRun?.pauseReleasePending, true);
  await assert.rejects(() => lifecycle.resume({ acquireOwnership: async () => {}, acquireLeases: async () => {}, revalidateHashes: async () => true, rollbackAuthority: async () => {} }), /release|paused/i);

  assert.deepEqual(await handlers.get("session_before_switch")!({ reason: "new" }), { cancel: false });
  assert.equal(releaseAttempts, 2, "an already-paused run must retry incomplete idempotent release");
  assert.equal(lifecycle.restore().latestRun?.pauseReleasePending, false);
});

test("pause release confirmation reconciles a publication fault after rename", async () => {
  let injected = false;
  const lifecycle = fixture("release-publication", {
    journalFault(eventType: string, stage: string) {
      if (!injected && eventType === "run.pause.release.confirmed" && stage === "afterRename") {
        injected = true;
        throw new Error("simulated publication fault");
      }
    },
  });
  let releases = 0;
  assert.equal(await lifecycle.pause("navigate", {
    releaseLeases: async () => { releases += 1; },
    releaseOwnership: async () => { releases += 1; },
  }), true);
  assert.equal(injected, true);
  assert.equal(releases, 2, "published confirmation must be restored instead of repeating release in-process");
  assert.equal(lifecycle.restore().latestRun?.pauseReleasePending, false);
});

test("resume reconciles journal publication at every append fault stage before deciding authority rollback", async () => {
  const cases = [
    { stage: "beforeWrite", published: false },
    { stage: "afterFileFsync", published: false },
    { stage: "beforeRename", published: false },
    { stage: "afterRename", published: true },
    { stage: "beforeDirFsync", published: true },
  ] as const;

  for (const expected of cases) {
    let armed = false;
    let injected = false;
    const lifecycle = fixture(`resume-${expected.stage}`, {
      journalFault(eventType: string, stage: string) {
        if (armed && !injected && eventType === "run.transition" && stage === expected.stage) {
          injected = true;
          throw new Error(`simulated ${expected.stage} fault`);
        }
      },
    });
    await lifecycle.pause("navigate", {});
    armed = true;
    let authorityHeld = false;
    let rollbacks = 0;
    const resume = () => lifecycle.resume({
      acquireOwnership: async () => { authorityHeld = true; },
      acquireLeases: async () => {},
      revalidateHashes: async () => true,
      rollbackAuthority: async () => { rollbacks += 1; authorityHeld = false; },
    });

    if (expected.published) {
      assert.equal(await resume(), true, expected.stage);
      assert.equal(lifecycle.restore().latestRun?.status, "running", expected.stage);
      assert.equal(authorityHeld, true, `${expected.stage} must retain acquired authority`);
      assert.equal(rollbacks, 0, `${expected.stage} must not roll back a durable transition`);
    } else {
      await assert.rejects(resume, new RegExp(expected.stage));
      assert.equal(lifecycle.restore().latestRun?.status, "paused", expected.stage);
      assert.equal(authorityHeld, false, `${expected.stage} must release unpublished authority`);
      assert.equal(rollbacks, 1, `${expected.stage} must roll back exactly once`);
    }
    assert.equal(injected, true, expected.stage);
  }
});

test("pause remembers waiting_for_human and resume automatically rolls back authority after append races", async () => {
  const lifecycle = fixture("waiting");
  const run = lifecycle.restore().latestRun!;
  // Exercise the public transition reducer through the journal-backed pause path.
  await lifecycle.transitionToWaitingForHuman("question pending");
  await lifecycle.pause("navigate", {});
  assert.equal(lifecycle.restore().latestRun?.resumeStatus, "waiting_for_human");
  await lifecycle.resume({ acquireOwnership: async () => {}, acquireLeases: async () => {}, revalidateHashes: async () => true, rollbackAuthority: async () => {} });
  assert.equal(lifecycle.restore().latestRun?.status, "waiting_for_human");
  assert.equal(run.runId, lifecycle.restore().latestRun?.runId);
});

test("session_start resumes the current workflow session before input and provider preparation", async () => {
  const lifecycle = fixture("session-start-resume");
  await lifecycle.pause("navigate away", {
    captureState: async () => ({ workspaceHash: "sha256:paused" }),
  });
  const order: string[] = [];
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    async fire(name: string, event: any, ctx: any = {}) { let result; for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx); return result; },
  } as any;
  registerWorkflowRunHooks(pi, {
    resolveLifecycle: () => lifecycle,
    pauseCoordinator: {},
    resumeCoordinator: {
      acquireOwnership: async () => { order.push("owner"); },
      acquireLeases: async () => { order.push("leases"); },
      revalidateHashes: async (state) => { order.push(`hash:${String(state.workspaceHash)}`); return true; },
      rollbackAuthority: async () => { order.push("rollback"); },
    },
  });

  await pi.fire("session_start", { reason: "resume" });
  assert.deepEqual(order, ["owner", "leases", "hash:sha256:paused"]);
  assert.equal(lifecycle.restore().latestRun?.status, "running");
  await pi.fire("input", { text: "steer after resume", source: "interactive" });
  await pi.fire("context", { messages: [] });
  await pi.fire("before_provider_request", { payload: {} });
  assert.equal(lifecycle.restore().latestRun?.inputs.length, 2);
});

test("failed current-session resume rolls back authority and blocks workflow input and provider execution", async () => {
  const lifecycle = fixture("session-start-block");
  await lifecycle.pause("navigate away", {
    captureState: async () => ({ workspaceHash: "sha256:paused" }),
  });
  let rollbackCount = 0;
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    async fire(name: string, event: any, ctx: any = {}) { let result; for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx); return result; },
  } as any;
  registerWorkflowRunHooks(pi, {
    resolveLifecycle: () => lifecycle,
    pauseCoordinator: {},
    resumeCoordinator: {
      acquireOwnership: async () => {},
      acquireLeases: async () => {},
      revalidateHashes: async () => false,
      rollbackAuthority: async () => { rollbackCount += 1; },
    },
  });

  await assert.rejects(() => pi.fire("session_start", { reason: "resume" }), /resume|hash/i);
  await assert.rejects(() => pi.fire("input", { text: "must not record", source: "interactive" }), /resume|hash/i);
  await assert.rejects(() => pi.fire("context", { messages: [] }), /resume|hash/i);
  await assert.rejects(() => pi.fire("before_provider_request", { payload: {} }), /resume|hash/i);
  assert.equal(lifecycle.restore().latestRun?.status, "paused");
  assert.equal(lifecycle.restore().latestRun?.inputs.length, 1);
  assert.equal(lifecycle.preparedInputDelivery(), undefined);
  assert.equal(rollbackCount, 4, "each blocked callback must roll back its failed authority attempt");
});

test("a current root model tool call confirms its exact prepared input before tool policy and finish execution", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-run-tool-delivery-"));
  let tick = 0;
  const lifecycle = new WorkflowRunLifecycle({
    projectRoot,
    projectId: "p",
    sessionId: "tool-delivery",
    snapshotId: "snap",
    rootNodeId: "root",
    createRunId: () => "run-tool-delivery",
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  });
  const order: string[] = [];
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    async fire(name: string, event: any, ctx: any = {}) {
      let result;
      for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
      return result;
    },
  } as any;
  registerWorkflowRunHooks(pi, {
    resolveLifecycle: () => lifecycle,
    nextInputId: () => "first-ordinary-input",
    pauseCoordinator: {},
    resumeCoordinator: {
      acquireOwnership: async () => {},
      acquireLeases: async () => {},
      revalidateHashes: async () => true,
      rollbackAuthority: async () => {},
    },
  });
  pi.on("tool_call", async () => {
    order.push("tool-policy");
    assert.equal(lifecycle.restore().latestRun?.deliveredThrough, 1, "delivery must be durable before tool policy runs");
  });

  order.push("input");
  await pi.fire("input", { text: "finish this ordinary request", source: "interactive" });
  order.push("context");
  await pi.fire("context", { messages: [{ role: "user", content: "finish this ordinary request", timestamp: 0 }] });
  const prepared = lifecycle.preparedInputDelivery();
  assert.ok(prepared);
  order.push("provider-dispatch");
  await pi.fire("before_provider_request", { payload: {} });

  const red = await lifecycle.finish(
    { status: "completed", summary: "The ordinary request is complete." },
    { callerNodeId: "root", toolBatch: ["workflow_finish"] },
  );
  assert.equal(red.ok, false);
  if (!red.ok) assert.match(red.issues.join("\n"), /every input is delivered/i);

  order.push("model-tool-call");
  await pi.fire("tool_call", { type: "tool_call", toolCallId: "finish-current-attempt", toolName: "workflow_finish", input: { status: "completed", summary: "The ordinary request is complete." } });
  order.push("tool-execute");
  const finished = await lifecycle.finish(
    { status: "completed", summary: "The ordinary request is complete." },
    { callerNodeId: "root", toolBatch: ["workflow_finish"] },
  );
  assert.equal(finished.ok, true, finished.ok ? undefined : finished.issues.join("\n"));
  assert.equal(lifecycle.restore().latestRun?.status, "completed");
  await pi.fire("after_provider_response", { status: 200, headers: {} });
  assert.deepEqual(order, ["input", "context", "provider-dispatch", "model-tool-call", "tool-policy", "tool-execute"]);
});

test("tool-call delivery proof rejects foreign lifecycle, wrong request, and replayed call identities", async () => {
  const first = fixture("tool-proof-first");
  const second = fixture("tool-proof-second");
  let lifecycle: WorkflowRunLifecycle | undefined = first;
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    async fire(name: string, event: any, ctx: any = {}) { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); },
  } as any;
  registerWorkflowRunHooks(pi, {
    resolveLifecycle: () => lifecycle,
    pauseCoordinator: {},
    resumeCoordinator: { acquireOwnership: async () => {}, acquireLeases: async () => {}, revalidateHashes: async () => true, rollbackAuthority: async () => {} },
  });

  await pi.fire("context", { messages: [] });
  await pi.fire("before_provider_request", { payload: {} });
  lifecycle = second;
  const foreign = { type: "tool_call", toolCallId: "foreign-or-replayed", toolName: "workflow_finish", input: {} };
  await pi.fire("tool_call", foreign);
  assert.equal(first.restore().latestRun?.deliveredThrough, 0, "a call under foreign lifecycle authority cannot confirm delivery");
  lifecycle = first;
  await pi.fire("tool_call", { ...foreign });
  assert.equal(first.restore().latestRun?.deliveredThrough, 0, "replaying a previously rejected call cannot forge delivery");

  const originalRequest = first.preparedInputDelivery()!;
  first.confirmInputDelivery(originalRequest.requestId);
  first.recordUserInput({ inputId: "replacement-input", text: "new pending input", source: "interactive" });
  first.prepareInputDelivery("replacement-request");
  await pi.fire("tool_call", { type: "tool_call", toolCallId: "stale-attempt-new-call", toolName: "workflow_finish", input: {} });
  assert.equal(first.restore().latestRun?.deliveredThrough, 1, "a stale attempt cannot confirm a different prepared request");
  assert.equal(first.preparedInputDelivery()?.requestId, "replacement-request");
});

test("a policy-denied current model call still proves delivery but cannot be replayed for a later request", async () => {
  const lifecycle = fixture("denied-tool-proof");
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    async fire(name: string, event: any, ctx: any = {}) { let result; for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx); return result; },
  } as any;
  registerWorkflowRunHooks(pi, {
    resolveLifecycle: () => lifecycle,
    pauseCoordinator: {},
    resumeCoordinator: { acquireOwnership: async () => {}, acquireLeases: async () => {}, revalidateHashes: async () => true, rollbackAuthority: async () => {} },
  });
  pi.on("tool_call", async () => ({ block: true, reason: "denied by immutable policy" }));

  await pi.fire("context", { messages: [] });
  await pi.fire("before_provider_request", { payload: {} });
  const denied = { type: "tool_call", toolCallId: "denied-current-call", toolName: "write", input: { path: "outside" } };
  assert.deepEqual(await pi.fire("tool_call", denied), { block: true, reason: "denied by immutable policy" });
  assert.equal(lifecycle.restore().latestRun?.deliveredThrough, 1, "model emission proves provider delivery even when policy blocks execution");

  lifecycle.recordUserInput({ inputId: "later-input", text: "later work", source: "interactive" });
  await pi.fire("context", { messages: [] });
  await pi.fire("before_provider_request", { payload: {} });
  await pi.fire("tool_call", { ...denied });
  assert.equal(lifecycle.restore().latestRun?.deliveredThrough, 1, "a denied call identity cannot be replayed to confirm later input");
});

test("schema-v1 integration hooks dynamically resolve linked sessions and confirm only accepted provider requests", async () => {
  const first = fixture("first");
  const second = fixture("second");
  let lifecycle: WorkflowRunLifecycle | undefined = first;
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const pi = { on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, async fire(name: string, event: any, ctx: any = {}) { let result; for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx); return result; } } as any;
  registerWorkflowRunHooks(pi, {
    resolveLifecycle: () => lifecycle,
    pauseCoordinator: {},
    resumeCoordinator: {
      acquireOwnership: async () => {},
      acquireLeases: async () => {},
      revalidateHashes: async () => true,
      rollbackAuthority: async () => {},
    },
  });

  const current = () => lifecycle!;

  const slash = { text: "/hive:status", source: "interactive" };
  await pi.fire("input", slash);
  assert.equal(current().restore().latestRun?.inputs.length, 1);
  const steeringEvent = { text: "steer now", source: "interactive", streamingBehavior: "steer" };
  await pi.fire("input", steeringEvent);
  await pi.fire("input", steeringEvent);
  assert.equal(current().restore().latestRun?.inputs.length, 2, "duplicate callback object is idempotent");
  assert.match(current().restore().latestRun!.inputs[1].inputId, /^input-callback-[0-9a-f-]{36}$/u);

  const context = await pi.fire("context", { messages: [{ role: "user", content: "work", timestamp: 0 }] });
  assert.ok(context.messages.some((message: any) => message.customType === "pi-hive-run-input-v1" && /steer now/.test(String(message.content))));
  assert.equal(current().restore().latestRun?.deliveredThrough, 0);
  await pi.fire("before_provider_request", { payload: {} });
  assert.equal(current().restore().latestRun?.deliveredThrough, 0, "building a provider request is not durable acceptance");
  await pi.fire("after_provider_response", { status: 503, headers: {} });
  await pi.fire("tool_call", { type: "tool_call", toolCallId: "call-after-provider-failure", toolName: "workflow_finish", input: {} });
  assert.equal(current().restore().latestRun?.deliveredThrough, 0, "a rejected provider attempt and any late call must remain pending");

  const replayedContext = await pi.fire("context", { messages: context.messages });
  assert.ok(replayedContext.messages.some((message: any) => message.customType === "pi-hive-run-input-v1"));
  await pi.fire("before_provider_request", { payload: {} });
  await pi.fire("after_provider_response", { status: 200, headers: {} });
  assert.equal(current().restore().latestRun?.deliveredThrough, 2);

  lifecycle = second;
  await pi.fire("input", { text: "second session steering", source: "rpc" });
  assert.equal(second.restore().latestRun?.inputs.length, 2);
  assert.equal(first.restore().latestRun?.inputs.length, 2, "callbacks must not retain the originally linked lifecycle");

  assert.deepEqual(await pi.fire("session_before_fork", {}), { cancel: true });
  assert.deepEqual(await pi.fire("session_before_tree", {}), { cancel: true });
  assert.deepEqual(await pi.fire("session_before_switch", { reason: "new" }), { cancel: false });
  assert.equal(second.restore().latestRun?.status, "paused");
  await pi.fire("session_shutdown", {});
  assert.equal(second.restore().latestRun?.status, "paused");
  lifecycle = undefined;
  assert.equal(await pi.fire("session_before_fork", {}), undefined);
});
