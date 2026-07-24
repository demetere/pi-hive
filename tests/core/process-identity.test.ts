import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { bootNonceMatches, currentBootNonce, currentProcessMarker, processIdentityIsDead, processMarkerMatches } from "../../src/core/process-identity.ts";

test("supported platforms expose stable process-start and boot identities", () => {
  const marker = currentProcessMarker(process.pid);
  const boot = currentBootNonce();
  assert.match(marker, process.platform === "darwin" ? /^darwin:pid:\d+:lstart:[A-Za-z0-9_-]+$/u : /^linux:pid:\d+:start:\d+$/u);
  assert.match(boot, process.platform === "darwin" ? /^darwin:boot:\d+$/u : /^linux:boot:[0-9a-f-]{36}$/u);
  assert.equal(processMarkerMatches(marker, process.pid), true);
  assert.equal(bootNonceMatches(boot), true);
  assert.equal(processIdentityIsDead({ pid: process.pid, processMarker: marker, bootNonce: boot }), false);
  assert.equal(processMarkerMatches(`pid:${process.pid}`, process.pid), true, "legacy PID-only owners stay conservatively live");
  assert.equal(processMarkerMatches(`pi-hive-${process.pid}`, process.pid), true, "pre-Darwin workflow owners stay conservatively live");
});

test("terminated process identity is recoverably dead", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  assert.ok(child.pid);
  const owner = { pid: child.pid!, processMarker: currentProcessMarker(child.pid!), bootNonce: currentBootNonce() };
  assert.equal(processIdentityIsDead(owner), false);
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.equal(processIdentityIsDead(owner), true);
});
