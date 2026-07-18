import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  authorizeFilesystemOperation,
  compileFilesystemPolicy,
  runQueuedFilesystemMutation,
  runQueuedSubsystemMutation,
} from "../../src/capabilities/filesystem.ts";
import { normalizeCapabilities } from "../../src/capabilities/policy.ts";
import type { EffectiveNodePolicy } from "../../src/capabilities/types.ts";
import { ChangeAccountingRuntime } from "../../src/workflows/change-accounting.ts";
import { AttemptRuntime } from "../../src/workflows/attempts.ts";

function policy(root: string) {
  const capabilities = normalizeCapabilities({ filesystem: [{ path: "workspace", operations: ["create", "update", "delete"] }] });
  const effective: EffectiveNodePolicy = {
    workflowId: "wf", nodeId: "worker", agentId: "agent", capabilities,
    provenance: {
      filesystem: ["agent-ceiling", "inherited"], shell: ["agent-ceiling", "inherited"], git: ["agent-ceiling", "inherited"],
      "external-network": ["agent-ceiling", "inherited"], "human-input": ["agent-ceiling", "inherited"], artifact: ["agent-ceiling", "inherited"], knowledge: ["agent-ceiling", "inherited"],
    },
    tools: ["write"], budgets: {}, skills: [], knowledge: [], directMemberIds: [],
  };
  return compileFilesystemPolicy({ projectRoot: root, effectivePolicy: effective });
}

test("queued generic mutation rechecks a missing target after an intermediate symlink swap", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-fs-race-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-hive-fs-race-outside-"));
  mkdirSync(join(root, "workspace", "safe"), { recursive: true });
  const compiled = policy(root);
  const request = { operation: "create" as const, path: "workspace/safe/new.txt" };
  assert.equal(authorizeFilesystemOperation(compiled, request).ok, true);

  let mutated = false;
  const result = await runQueuedFilesystemMutation(compiled, request, async (target) => {
    mutated = true;
    writeFileSync(target, "must not escape");
  }, async (_target, task) => {
    rmSync(join(root, "workspace", "safe"), { recursive: true });
    symlinkSync(outside, join(root, "workspace", "safe"));
    return task();
  });
  assert.equal(result.ok, false);
  assert.equal(mutated, false);
  assert.equal(existsSync(join(outside, "new.txt")), false);
});

test("queued generic mutation rechecks an existing target after a target symlink swap", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-fs-race-target-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-hive-fs-race-target-outside-"));
  mkdirSync(join(root, "workspace"), { recursive: true });
  writeFileSync(join(root, "workspace", "target.txt"), "inside");
  writeFileSync(join(outside, "outside.txt"), "outside");
  const compiled = policy(root);
  let mutated = false;
  const result = await runQueuedFilesystemMutation(compiled, { operation: "update", path: "workspace/target.txt" }, async () => {
    mutated = true;
  }, async (_target, task) => {
    rmSync(join(root, "workspace", "target.txt"));
    symlinkSync(join(outside, "outside.txt"), join(root, "workspace", "target.txt"));
    return task();
  });
  assert.equal(result.ok, false);
  assert.equal(mutated, false);
});

test("queued mutation preserves lexical symlink semantics after canonical authorization", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-fs-symlink-mutation-"));
  mkdirSync(join(root, "workspace", "actual"), { recursive: true });
  writeFileSync(join(root, "workspace", "actual", "target.txt"), "inside");
  symlinkSync(join(root, "workspace", "actual", "target.txt"), join(root, "workspace", "link.txt"));
  const compiled = policy(root);
  let callbackTarget = "";
  const result = await runQueuedFilesystemMutation(compiled, { operation: "delete", path: "workspace/link.txt" }, async (target) => {
    callbackTarget = target;
  }, async (_target, task) => task());
  assert.equal(result.ok, true);
  assert.equal(callbackTarget, join(root, "workspace", "link.txt"), "the mutation targets the authorized link, not its referent");
});

test("queued mutation emits harness before/after metadata through the W13 recorder", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-fs-accounting-"));
  mkdirSync(join(root, "workspace"), { recursive: true });
  writeFileSync(join(root, "workspace", "target.txt"), "before");
  const accounting = new ChangeAccountingRuntime({ projectRoot: root, projectId: "project", sessionId: "session", runId: "run" });
  accounting.captureBaseline();
  const result = await runQueuedFilesystemMutation(
    policy(root),
    { operation: "update", path: "workspace/target.txt" },
    async (target) => { writeFileSync(target, "after"); return "ok"; },
    async (_target, task) => task(),
    { attemptId: "write-attempt", recorder: accounting.mutationRecorder() },
  );
  assert.equal(result.ok, true);
  assert.equal(accounting.restore().mutations[0].attemptId, "write-attempt");
  assert.equal(accounting.reconcile().fileChanges[0].attribution, "recorded");
});

test("queued mutation re-hashes immediately inside the queue and does not attribute a queued external overwrite", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-fs-queued-overwrite-"));
  mkdirSync(join(root, "workspace"), { recursive: true });
  const target = join(root, "workspace", "target.txt");
  writeFileSync(target, "baseline");
  const changes = new ChangeAccountingRuntime({ projectRoot: root, projectId: "project", sessionId: "queued-overwrite", runId: "run" });
  changes.captureBaseline();
  const result = await runQueuedFilesystemMutation(
    policy(root),
    { operation: "update", path: "workspace/target.txt" },
    async (canonical) => { writeFileSync(canonical, "workflow"); },
    async (_target, task) => { writeFileSync(target, "external while queued"); return task(); },
    { attemptId: "queued-overwrite", recorder: changes.mutationRecorder() },
  );
  assert.equal(result.ok, true);
  const report = changes.reconcile();
  assert.equal(report.fileChanges[0].attribution, "conflicted");
  assert.match(report.issues.join(" "), /external|concurrent|conflict/i);
});

test("queue rejection and authorization recheck denial durably prove the attempt was not applied", async () => {
  const setup = (sessionId: string) => {
    const root = mkdtempSync(join(tmpdir(), "pi-hive-fs-not-applied-"));
    mkdirSync(join(root, "workspace"), { recursive: true });
    writeFileSync(join(root, "workspace", "target.txt"), "before");
    const changes = new ChangeAccountingRuntime({ projectRoot: root, projectId: "project", sessionId, runId: "run" });
    const attempts = new AttemptRuntime({ projectRoot: root, projectId: "project", sessionId, runId: "run" });
    changes.captureBaseline();
    return { root, changes, attempts };
  };
  const rejected = setup("queue-rejected");
  const queueResult = await runQueuedFilesystemMutation(
    policy(rejected.root), { operation: "update", path: "workspace/target.txt" }, async () => "must not run",
    async () => { throw new Error("queue unavailable"); },
    { attemptId: "queue-rejected", recorder: rejected.changes.mutationRecorder(), attempts: { runtime: rejected.attempts, correlationId: "queue-rejected", nodeId: "worker", operation: "write", input: {} } },
  );
  assert.equal(queueResult.ok, false);
  assert.equal(rejected.attempts.restore().attempts["queue-rejected"].status, "failed");
  assert.equal(rejected.attempts.restore().attempts["queue-rejected"].result?.effectNotApplied, true);
  assert.deepEqual(rejected.changes.restore().intents, {});
  assert.match(rejected.changes.restore().notApplied["queue-rejected"].diagnostic, /queue unavailable/i);

  const denied = setup("recheck-denied");
  const outside = mkdtempSync(join(tmpdir(), "pi-hive-fs-not-applied-outside-"));
  writeFileSync(join(outside, "outside.txt"), "outside");
  const deniedResult = await runQueuedFilesystemMutation(
    policy(denied.root), { operation: "update", path: "workspace/target.txt" }, async () => "must not run",
    async (_target, task) => {
      rmSync(join(denied.root, "workspace", "target.txt"));
      symlinkSync(join(outside, "outside.txt"), join(denied.root, "workspace", "target.txt"));
      return task();
    },
    { attemptId: "recheck-denied", recorder: denied.changes.mutationRecorder(), attempts: { runtime: denied.attempts, correlationId: "recheck-denied", nodeId: "worker", operation: "write", input: {} } },
  );
  assert.equal(deniedResult.ok, false);
  assert.equal(denied.attempts.restore().attempts["recheck-denied"].status, "failed");
  assert.equal(denied.attempts.restore().attempts["recheck-denied"].result?.effectNotApplied, true);
  assert.deepEqual(denied.changes.restore().intents, {});
  assert.match(denied.changes.restore().notApplied["recheck-denied"].diagnostic, /symlink|escape|outside|protected|denied|target/i);
});

test("queued mutation propagates recorder publication failures and leaves an unknown-effect attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-fs-recorder-fault-"));
  mkdirSync(join(root, "workspace"), { recursive: true });
  writeFileSync(join(root, "workspace", "target.txt"), "before");
  const changes = new ChangeAccountingRuntime({ projectRoot: root, projectId: "project", sessionId: "session", runId: "run" });
  const attempts = new AttemptRuntime({ projectRoot: root, projectId: "project", sessionId: "session", runId: "run" });
  changes.captureBaseline();
  const durable = changes.mutationRecorder();

  await assert.rejects(() => runQueuedFilesystemMutation(
    policy(root),
    { operation: "update", path: "workspace/target.txt" },
    async (target) => { writeFileSync(target, "after"); return "ok"; },
    async (_target, task) => task(),
    {
      attemptId: "write-fault",
      attempts: { runtime: attempts, correlationId: "write-fault-correlation", nodeId: "worker", operation: "write", input: { path: "workspace/target.txt" } },
      recorder: {
        begin: (attemptId, path) => durable.begin(attemptId, path),
        complete: () => { throw new Error("recorder publication failed"); },
      },
    },
  ), /recorder publication failed/);

  assert.equal(attempts.restore().attempts["write-fault"].status, "unknown_side_effect");
  assert.equal(changes.restore().intents["write-fault"] !== undefined, true);
});

test("artifact and knowledge writes succeed only through their dedicated queued facade", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-fs-subsystem-"));
  mkdirSync(join(root, "workspace"), { recursive: true });
  mkdirSync(join(root, "openspec", "changes", "x"), { recursive: true });
  mkdirSync(join(root, ".pi", "hive", "knowledge", "shared"), { recursive: true });
  const compiled = policy(root);
  assert.equal(authorizeFilesystemOperation(compiled, { operation: "create", path: "openspec/changes/x/tasks.md" }).ok, false);

  const queued: string[] = [];
  const queue = async <T>(target: string, task: () => Promise<T>): Promise<T> => { queued.push(target); return task(); };
  const artifact = await runQueuedSubsystemMutation({
    projectRoot: root, subsystem: "artifact", request: { operation: "create", path: "openspec/changes/x/tasks.md" }, queue,
    mutate: async (target) => { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, "tasks"); return "artifact-ok"; },
  });
  const knowledge = await runQueuedSubsystemMutation({
    projectRoot: root, subsystem: "knowledge", request: { operation: "create", path: ".pi/hive/knowledge/shared/new.md" }, queue,
    mutate: async (target) => { writeFileSync(target, "knowledge"); return "knowledge-ok"; },
  });
  assert.deepEqual([artifact.ok, artifact.value, knowledge.ok, knowledge.value], [true, "artifact-ok", true, "knowledge-ok"]);
  assert.equal(queued.length, 2);
  assert.equal(existsSync(join(root, "openspec", "changes", "x", "tasks.md")), true);
  assert.equal(existsSync(join(root, ".pi", "hive", "knowledge", "shared", "new.md")), true);

  const wrongFacade = await runQueuedSubsystemMutation({
    projectRoot: root, subsystem: "knowledge", request: { operation: "create", path: "openspec/changes/x/design.md" }, queue,
    mutate: async () => "must-not-run",
  });
  assert.equal(wrongFacade.ok, false);
});
