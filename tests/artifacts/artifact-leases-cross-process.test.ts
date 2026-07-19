import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  WORKSPACE_LEASE_TIMING,
  WorkspaceLeaseRuntime,
  inspectWorkspaceLease,
} from "../../src/artifacts/leases.ts";

function childAcquire(projectRoot: string, runId: string, hold = false): Promise<{ ok: boolean; reason: string }> {
  const script = `
    import { WorkspaceLeaseRuntime } from './src/artifacts/leases.ts';
    const lease = new WorkspaceLeaseRuntime({ projectRoot: ${JSON.stringify(projectRoot)}, adapterId: 'fixture', workspaceId: 'shared', sessionId: 'child-session', runId: ${JSON.stringify(runId)} });
    const result = lease.acquire();
    console.log(JSON.stringify({ ok: result.ok, reason: result.reason }));
    ${hold ? "" : "if (result.ok) lease.release();"}
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`lease child exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
    });
  });
}

function runtime(projectRoot: string, runId = "run-parent") {
  return new WorkspaceLeaseRuntime({ projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId: "session-parent", runId });
}

test("one writer lease is enforced across Node processes while readers require no lease", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-lease-process-"));
  const owner = runtime(projectRoot);
  assert.equal(owner.acquire().ok, true);
  const competing = await childAcquire(projectRoot, "run-child");
  assert.equal(competing.ok, false);
  assert.match(competing.reason, /fresh|owned|writer/i);
  assert.equal(inspectWorkspaceLease(projectRoot, "fixture", "shared").state, "owned");
  assert.equal(owner.release(), true);
  assert.equal((await childAcquire(projectRoot, "run-child")).ok, true);
});

test("a live cross-process workspace mutation holder cannot be stale-stolen after the 30 second lock age", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-lease-long-mutation-"));
  const script = `
    import { WorkspaceLeaseRuntime } from './src/artifacts/leases.ts';
    const lease = new WorkspaceLeaseRuntime({ projectRoot: ${JSON.stringify("__PROJECT_ROOT__")}, adapterId: 'fixture', workspaceId: 'shared', sessionId: 'shared-session', runId: 'shared-run', ownerNonce: 'shared-owner' });
    const acquired = lease.acquire();
    if (!acquired.ok) throw new Error(acquired.reason);
    await lease.withOwnedMutation(async () => {
      console.log('mutation-held');
      await new Promise((resolve) => process.stdin.once('data', resolve));
      process.stdin.destroy();
    });
    lease.release();
  `.replace("__PROJECT_ROOT__", projectRoot.replaceAll("\\", "\\\\"));
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const held = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("mutation-held")) resolve(); });
    child.on("error", reject);
    child.on("exit", (code) => { if (code !== 0) reject(new Error(`mutation holder exited ${code}: ${stderr}`)); });
  });
  await held;
  const leaseDirectory = join(projectRoot, ".pi", "hive", "sessions", "workspace-leases");
  const mutationLock = join(leaseDirectory, readdirSync(leaseDirectory).find((name) => name.endsWith(".mutation.lock"))!);
  const olderThanStaleThreshold = new Date(Date.now() - WORKSPACE_LEASE_TIMING.lockStaleMs - 1_000);
  utimesSync(mutationLock, olderThanStaleThreshold, olderThanStaleThreshold);
  const sameLeaseOwner = new WorkspaceLeaseRuntime({
    projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId: "shared-session", runId: "shared-run", ownerNonce: "shared-owner",
  });
  let entered = false;
  let contenderError: unknown;
  try {
    await sameLeaseOwner.withOwnedMutation(() => { entered = true; });
  } catch (error) {
    contenderError = error;
  } finally {
    child.stdin.write("release\n");
  }
  await new Promise<void>((resolve, reject) => child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`mutation holder exited ${code}: ${stderr}`))));
  assert.match(String(contenderError instanceof Error ? contenderError.message : contenderError), /Timed out waiting for file lock/i);
  assert.equal(entered, false, "a live long mutation must retain the critical section despite an old lock mtime");
});

test("a writer process death still requires expiry before another process can recover the lease", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-lease-death-"));
  const crashed = await childAcquire(projectRoot, "run-crashed", true);
  assert.equal(crashed.ok, true);
  const fresh = runtime(projectRoot, "run-resume");
  assert.equal(fresh.acquire().ok, false);
  const recovered = new WorkspaceLeaseRuntime({
    projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId: "session-resume", runId: "run-resume",
    now: () => Date.now() + WORKSPACE_LEASE_TIMING.staleMs + 1,
  }).acquire();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.previousRunId, "run-crashed");
});

test("heartbeats extend expiry, owner nonce prevents release, and a fresh lease is never stolen", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-lease-heartbeat-"));
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const owner = new WorkspaceLeaseRuntime({ projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId: "session", runId: "run", ownerNonce: "owner", now: () => now });
  assert.equal(owner.acquire().ok, true);
  assert.equal(owner.heartbeat(now + WORKSPACE_LEASE_TIMING.heartbeatMs), true);
  const view = inspectWorkspaceLease(projectRoot, "fixture", "shared", now + WORKSPACE_LEASE_TIMING.heartbeatMs);
  assert.equal(view.state, "owned");
  assert.equal(view.runId, "run");

  const impostor = new WorkspaceLeaseRuntime({ projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId: "session", runId: "run", ownerNonce: "other", now: () => now + WORKSPACE_LEASE_TIMING.staleMs + 1, verifyDead: () => false });
  assert.equal(impostor.acquire().ok, false);
  assert.match(impostor.acquire().reason, /fresh|not verified dead|owner/i);
  assert.equal(impostor.release(), false);
  assert.equal(owner.release(), true);
});

test("dead-owner recovery requires conservative expiry; resume reacquires but never steals a live owner", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-lease-expiry-"));
  const started = Date.parse("2026-01-01T00:00:00.000Z");
  const crashed = new WorkspaceLeaseRuntime({ projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId: "session", runId: "run-resume", ownerNonce: "crashed", pid: 999_999, processMarker: "dead", bootNonce: "old", now: () => started });
  assert.equal(crashed.acquire().ok, true);

  const tooEarly = new WorkspaceLeaseRuntime({ projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId: "session", runId: "run-resume", ownerNonce: "resumed", now: () => started + WORKSPACE_LEASE_TIMING.staleMs - 1, verifyDead: () => true });
  assert.equal(tooEarly.acquire().ok, false);
  assert.match(tooEarly.acquire().reason, /fresh|not expired/i);

  const resumed = new WorkspaceLeaseRuntime({ projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId: "session", runId: "run-resume", ownerNonce: "resumed", now: () => started + WORKSPACE_LEASE_TIMING.staleMs, verifyDead: () => true });
  const recovered = resumed.acquire();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.previousRunId, "run-resume");

  const other = new WorkspaceLeaseRuntime({ projectRoot, adapterId: "fixture", workspaceId: "shared", sessionId: "other", runId: "other-run", ownerNonce: "other", now: () => started + WORKSPACE_LEASE_TIMING.staleMs * 2, verifyDead: () => false });
  assert.equal(other.acquire().ok, false);
  assert.equal(resumed.release(), true);
});

test("pause, cancel, and finish release the owned lease and preserve bounded final hash evidence", () => {
  for (const reason of ["pause", "cancel", "finish"] as const) {
    const projectRoot = mkdtempSync(join(tmpdir(), `hive-lease-${reason}-`));
    const lease = runtime(projectRoot, `run-${reason}`);
    assert.equal(lease.acquire().ok, true);
    const evidence = lease.releaseForLifecycle(reason, `sha256:${"a".repeat(64)}`);
    assert.deepEqual(evidence, { reason, released: true, finalWorkspaceHash: `sha256:${"a".repeat(64)}` });
    assert.equal(inspectWorkspaceLease(projectRoot, "fixture", "shared").state, "available");
  }
});
