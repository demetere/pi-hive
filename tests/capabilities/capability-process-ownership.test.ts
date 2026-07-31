import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnOwnedProcess, terminateOwnedProcess } from "../../src/capabilities/process.ts";

test("owned process termination signals only a live handle-created process tree", async () => {
  const owned = spawnOwnedProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
  assert.equal(typeof owned.pid, "number");
  assert.equal(terminateOwnedProcess(owned, "SIGTERM"), true);
  assert.equal(terminateOwnedProcess(owned, "SIGTERM"), false);
});

test("unowned or stale PID-shaped values are never kill authority", () => {
  assert.equal(terminateOwnedProcess({ pid: process.pid } as never), false);
  assert.equal(terminateOwnedProcess(undefined), false);
});
