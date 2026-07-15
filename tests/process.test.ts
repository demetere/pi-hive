import assert from "node:assert/strict";
import { test } from "node:test";
import { killProcess, spawnManaged } from "../src/engine/process.ts";

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
  assert.deepEqual(signals, ["SIGINT"]);

  const nestedChild = {
    pid: 456,
    killed: false,
    kill(signal?: string) { if (signal) signals.push(signal); this.killed = true; return true; },
  } as any;
  assert.equal(killProcess({ proc: nestedChild, pid: 456, kill: () => true }), 456);
  assert.equal(killProcess(undefined), undefined);

  const throwing = { pid: 789, killed: false, kill() { throw new Error("gone"); } } as any;
  assert.equal(killProcess(throwing), 789);
});
