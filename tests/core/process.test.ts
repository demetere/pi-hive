import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { killProcess, killProcessTree, spawnManaged } from "../../src/core/process.ts";
import { OwnedProcessRegistry } from "../../src/capabilities/process.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(20);
  }
  return predicate();
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const state = /\) ([A-Z]) /u.exec(readFileSync(`/proc/${pid}/stat`, "utf8"))?.[1];
      return state !== "Z";
    }
    return true;
  } catch {
    return false;
  }
}

test("managed processes expose identity and forward termination signals", () => {
  const managed = spawnManaged(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
    detached: true,
    stdio: "ignore",
  });
  assert.equal(typeof managed.pid, "number");
  assert.equal(managed.kill("SIGTERM"), true);
});

test("process cleanup handles child, managed, absent, and throwing handles", () => {
  const signals: Array<string | undefined> = [];
  const child = {
    pid: 123,
    killed: false,
    kill(signal?: string) { signals.push(signal); this.killed = true; return true; },
  } as any;
  assert.equal(killProcess(child, "SIGINT"), 123);
  assert.deepEqual(signals, ["SIGINT"]);
  assert.equal(killProcess(child), 123);
  assert.deepEqual(signals, ["SIGINT", "SIGTERM"], "a sent signal is not an observed exit");

  const nestedChild = {
    pid: 456,
    killed: false,
    kill(signal?: string) { if (signal) signals.push(signal); this.killed = true; return true; },
  } as any;
  assert.equal(killProcess({ proc: nestedChild, pid: 456, detached: false, kill: () => true }), 456);
  assert.equal(killProcess(undefined), undefined);

  const throwing = { pid: 789, killed: false, kill() { throw new Error("gone"); } } as any;
  assert.equal(killProcess(throwing), 789);
});

test("process-tree signaling requires minted owned-process authority", () => {
  const managed = spawnManaged(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { detached: true, stdio: "ignore" });
  const ownedSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  assert.equal(killProcessTree(managed, "SIGTERM", (pid, signal) => { ownedSignals.push({ pid, signal }); return true; }, () => true), managed.pid);
  assert.equal(killProcessTree(managed, "SIGKILL", (pid, signal) => { ownedSignals.push({ pid, signal }); return true; }, () => true), managed.pid);
  assert.equal(killProcessTree(managed, "SIGKILL", (pid, signal) => { ownedSignals.push({ pid, signal }); return true; }, () => true), managed.pid);
  assert.equal(killProcessTree(managed, "SIGKILL", (pid, signal) => { ownedSignals.push({ pid, signal }); return true; }, () => false), managed.pid);
  assert.equal(killProcessTree(managed, "SIGKILL", (pid, signal) => { ownedSignals.push({ pid, signal }); return true; }, () => true), managed.pid);
  assert.deepEqual(ownedSignals, [
    { pid: -managed.pid!, signal: "SIGTERM" },
    { pid: -managed.pid!, signal: "SIGKILL" },
    { pid: -managed.pid!, signal: "SIGKILL" },
  ], "minted authority remains retryable until group termination is confirmed");

  const retryable = spawnManaged(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { detached: true, stdio: "ignore" });
  const originalKill = retryable.proc.kill.bind(retryable.proc);
  let fallbackAttempts = 0;
  retryable.proc.kill = (() => { fallbackAttempts += 1; throw new Error("signal transport failed"); }) as typeof retryable.proc.kill;
  assert.equal(killProcessTree(retryable, "SIGKILL", () => { throw new Error("group signal failed"); }, () => true), retryable.pid);
  retryable.proc.kill = originalKill;
  const retrySignals: NodeJS.Signals[] = [];
  assert.equal(killProcessTree(retryable, "SIGKILL", (_pid, signal) => { retrySignals.push(signal); return true; }, () => true), retryable.pid);
  assert.equal(fallbackAttempts, 1);
  assert.deepEqual(retrySignals, ["SIGKILL"], "failed signaling must not consume minted termination authority");

  let fabricatedSignals = 0;
  const fabricatedChild = { pid: managed.pid, killed: false, exitCode: null, signalCode: null, kill() { fabricatedSignals += 1; return true; } } as any;
  const fabricated = { proc: fabricatedChild, pid: managed.pid, detached: true, kill: () => true };
  assert.equal(killProcessTree(fabricated, "SIGKILL", () => { fabricatedSignals += 1; return true; }, () => true), managed.pid);
  assert.equal(fabricatedSignals, 0, "a structurally fabricated managed process must have no signal authority");

  const attachedSignals: string[] = [];
  const attached = { pid: 99, killed: false, exitCode: null, signalCode: null, kill(signal: string) { attachedSignals.push(signal); this.killed = true; return true; } } as any;
  assert.equal(killProcessTree(attached, "SIGTERM"), 99);
  assert.equal(killProcessTree(attached, "SIGKILL"), 99);
  assert.deepEqual(attachedSignals, ["SIGTERM", "SIGKILL"], "SIGKILL escalation must not trust child.killed");

  attached.exitCode = 0;
  assert.equal(killProcessTree(attached, "SIGKILL"), 99);
  assert.deepEqual(attachedSignals, ["SIGTERM", "SIGKILL"], "an observed exit must suppress further signals");
  managed.proc.kill("SIGKILL");
  retryable.proc.kill("SIGKILL");
});

test("owned-process registry settles only package-minted process groups", { skip: process.platform === "win32" }, async () => {
  const registry = new OwnedProcessRegistry();
  const owned = registry.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  const foreign = spawnManaged(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "ignore" });
  try {
    assert.equal(registry.isSettled(), false);
    assert.equal(registry.terminateAll("SIGKILL"), 1);
    assert.equal(await waitFor(() => registry.isSettled()), true);
    assert.equal(isRunning(foreign.pid!), true, "foreign process must never enter registry kill authority");
    assert.equal(await waitFor(() => !isRunning(owned.pid)), true);
  } finally {
    killProcessTree(foreign, "SIGKILL");
    try { process.kill(-owned.pid, "SIGKILL"); } catch { /* already settled */ }
  }
});

test("SIGKILL escalation reaches a surviving descendant after the owned group leader exits", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-process-tree-"));
  const descendantPidFile = join(root, "descendant.pid");
  const leaderScript = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })",
    "writeFileSync(process.argv[1], String(child.pid))",
    "child.unref()",
  ].join(";");
  const managed = spawnManaged(process.execPath, ["-e", leaderScript, descendantPidFile], { detached: true, stdio: "ignore" });
  let descendantPid: number | undefined;

  try {
    assert.equal(await waitFor(() => {
      try { descendantPid = Number(readFileSync(descendantPidFile, "utf8")); return Number.isSafeInteger(descendantPid) && descendantPid! > 0; }
      catch { return false; }
    }), true, "leader must publish its descendant PID");
    assert.equal(await waitFor(() => managed.proc.exitCode !== null || managed.proc.signalCode !== null), true, "group leader must exit first");
    assert.equal(isRunning(descendantPid!), true, "descendant must survive the leader exit");
    assert.doesNotThrow(() => process.kill(-managed.pid!, 0), "the owned process group must still be live");

    assert.equal(killProcessTree(managed, "SIGKILL"), managed.pid);
    assert.equal(await waitFor(() => !isRunning(descendantPid!)), true, "SIGKILL escalation must terminate the surviving descendant");
  } finally {
    if (descendantPid && isRunning(descendantPid)) try { process.kill(descendantPid, "SIGKILL"); } catch { /* already settled */ }
    if (managed.pid) try { process.kill(-managed.pid, "SIGKILL"); } catch { /* group already settled */ }
    rmSync(root, { recursive: true, force: true });
  }
});
