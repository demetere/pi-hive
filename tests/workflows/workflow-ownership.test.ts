import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireRuntimeOwnership, heartbeatRuntimeOwnership, markWorkflowOrphaned, releaseRuntimeOwnership, RUNTIME_OWNERSHIP_TIMING, settleRuntimeOwnershipRelease } from "../../src/workflows/ownership.ts";
import { appendWorkflowEvent } from "../../src/workflows/journal.ts";
import { createWorkflowEvent } from "../../src/workflows/events.ts";

function root() { return mkdtempSync(join(tmpdir(), "hive-owner-")); }

test("fresh runtime ownership is exclusive and only verified dead stale owner can be recovered", () => {
  const project = root(); const now = Date.parse("2026-01-01T00:00:00Z");
  const first = acquireRuntimeOwnership(project, "s1", { pid: 111, processMarker: "a", now, nonce: "n1", verifyDead: () => false }); assert.equal(first.ok, true);
  assert.equal(acquireRuntimeOwnership(project, "s1", { pid: 222, processMarker: "b", now: now + 1000, nonce: "n2", verifyDead: () => true }).ok, false);
  assert.equal(acquireRuntimeOwnership(project, "s1", { pid: 222, processMarker: "b", now: now + 120_000, nonce: "n2", verifyDead: () => false }).ok, false);
  const takeover = acquireRuntimeOwnership(project, "s1", { pid: 222, processMarker: "b", now: now + 120_000, nonce: "n2", verifyDead: () => true }); assert.equal(takeover.ok, true);
  assert.equal(takeover.previousOwner?.heartbeatAt, new Date(now).toISOString(), "takeover exposes the verified dead owner's heartbeat for active-clock reconciliation");
  assert.equal(heartbeatRuntimeOwnership(project, "s1", "n1", now + 121_000), false); assert.equal(heartbeatRuntimeOwnership(project, "s1", "n2", now + 121_000), true);
  assert.equal(releaseRuntimeOwnership(project, "s1", "n1"), false); assert.equal(releaseRuntimeOwnership(project, "s1", "n2"), true);
});

test("exact ownership release settlement rejects a byte-identical-marker same-millisecond successor", () => {
  const project = root();
  const sessionId = "settlement";
  const ownerPath = join(project, ".pi/hive/sessions", sessionId, "runtime-owner.json");
  const exactMarkers = { pid: 111, processMarker: "same-process", bootNonce: "same-boot", now: 1_700_000_000_000, nonce: "process-global", verifyDead: () => true };
  const original = acquireRuntimeOwnership(project, sessionId, exactMarkers);
  assert.ok(original.ok && original.owner);
  assert.match(original.owner.generation, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(releaseRuntimeOwnership(project, sessionId, "process-global"), true, "native shutdown releases the exact generation first");
  assert.equal(settleRuntimeOwnershipRelease(project, sessionId, original.owner), true, "absence under the ownership lock is an idempotent exact settlement");

  const successor = acquireRuntimeOwnership(project, sessionId, exactMarkers);
  assert.ok(successor.ok && successor.owner);
  assert.notEqual(successor.owner.generation, original.owner.generation, "every acquisition has an independent random generation");
  const { generation: _originalGeneration, ...originalMarkers } = original.owner;
  const { generation: _successorGeneration, ...successorMarkers } = successor.owner;
  assert.deepEqual(successorMarkers, originalMarkers, "the regression forces every prior ownership marker to be identical");
  assert.equal(settleRuntimeOwnershipRelease(project, sessionId, original.owner), false, "captured old settlement cannot delete the live successor");
  assert.equal(heartbeatRuntimeOwnership(project, sessionId, "process-global", exactMarkers.now), true, "rejected settlement preserves the successor");
  assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).generation, successor.owner.generation, "heartbeat preserves the acquisition generation");
  assert.equal(releaseRuntimeOwnership(project, sessionId, "process-global"), true);
});

test("runtime ownership records without an acquisition generation fail closed", () => {
  const project = root();
  const sessionId = "old-owner";
  const ownerPath = join(project, ".pi/hive/sessions", sessionId, "runtime-owner.json");
  const acquired = acquireRuntimeOwnership(project, sessionId, { nonce: "old-nonce" });
  assert.ok(acquired.ok && acquired.owner);
  const { generation: _generation, ...oldOwner } = acquired.owner;
  writeFileSync(ownerPath, `${JSON.stringify(oldOwner)}\n`);

  assert.throws(() => acquireRuntimeOwnership(project, sessionId, { nonce: "replacement", now: Date.now() + RUNTIME_OWNERSHIP_TIMING.staleMs }), /runtime owner invalid/i);
  assert.throws(() => heartbeatRuntimeOwnership(project, sessionId, "old-nonce"), /runtime owner invalid/i);
  assert.throws(() => releaseRuntimeOwnership(project, sessionId, "old-nonce"), /runtime owner invalid/i);
  assert.equal(existsSync(ownerPath), true, "invalid legacy ownership is never overwritten or deleted");
});

test("live cross-process runtime ownership contends, heartbeats, and permits takeover only after death plus expiry", async () => {
  const project = root();
  const sessionId = "cross-process-session";
  const script = `
    import { acquireRuntimeOwnership, heartbeatCurrentRuntimeOwnership } from './src/workflows/ownership.ts';
    const projectRoot = ${JSON.stringify(project)};
    const sessionId = ${JSON.stringify(sessionId)};
    const acquired = acquireRuntimeOwnership(projectRoot, sessionId, { nonce: 'child-owner' });
    if (!acquired.ok) throw new Error(acquired.reason);
    console.log(JSON.stringify({ type: 'acquired', owner: acquired.owner }));
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (input) => {
      if (!input.includes('heartbeat')) return;
      const ok = heartbeatCurrentRuntimeOwnership(projectRoot, sessionId, 'child-owner');
      const owner = JSON.parse(readFileSync(projectRoot + '/.pi/hive/sessions/' + sessionId + '/runtime-owner.json', 'utf8'));
      console.log(JSON.stringify({ type: 'heartbeat', ok, owner }));
    });
    setInterval(() => {}, 1_000);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { readFileSync } from 'node:fs';\n${script}`], {
    cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NODE_V8_COVERAGE: "" },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const messages: any[] = [];
  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += String(chunk);
    const lines = buffered.split("\n"); buffered = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
  });
  const waitMessage = async (type: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const found = messages.find((message) => message.type === type);
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`runtime owner child exited ${child.exitCode}: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for child ${type}: ${stderr}`);
  };
  try {
    const acquired = await waitMessage("acquired");
    assert.equal(acquired.owner.pid, child.pid);
    const contender = acquireRuntimeOwnership(project, sessionId, { nonce: "parent-contender" });
    assert.equal(contender.ok, false);
    assert.equal(contender.owner?.ownerNonce, "child-owner");

    await new Promise((resolve) => setTimeout(resolve, 20));
    child.stdin.write("heartbeat\n");
    const heartbeat = await waitMessage("heartbeat");
    assert.equal(heartbeat.ok, true);
    assert.ok(Date.parse(heartbeat.owner.heartbeatAt) > Date.parse(acquired.owner.heartbeatAt));
    assert.equal(acquireRuntimeOwnership(project, sessionId, { nonce: "parent-before-death" }).ok, false);

    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.equal(acquireRuntimeOwnership(project, sessionId, { nonce: "parent-before-expiry" }).ok, false, "verified death alone cannot bypass the fresh heartbeat");
    const persisted = JSON.parse(readFileSync(join(project, ".pi/hive/sessions", sessionId, "runtime-owner.json"), "utf8"));
    const takeover = acquireRuntimeOwnership(project, sessionId, {
      nonce: "parent-after-expiry", now: Date.parse(persisted.heartbeatAt) + RUNTIME_OWNERSHIP_TIMING.staleMs,
    });
    assert.equal(takeover.ok, true);
    assert.equal(takeover.recovered, true);
    assert.equal(takeover.previousOwner?.pid, child.pid);
    assert.equal(releaseRuntimeOwnership(project, sessionId, "parent-after-expiry"), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
});

test("short dashboard append does not acquire runtime ownership and missing Pi session preserves journal as orphan", () => {
  const project = root(); appendWorkflowEvent(project, createWorkflowEvent({ projectId: "p", sessionId: "s", type: "control.requested", payload: {}, producer: "dashboard", eventId: "e" }));
  assert.equal(existsSync(join(project, ".pi/hive/sessions/s/runtime-owner.json")), false);
  markWorkflowOrphaned(project, "s", "p", "missing-pi-session");
  assert.equal(existsSync(join(project, ".pi/hive/sessions/s/journal")), true);
});
