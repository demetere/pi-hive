import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withCrossProcessFileLock } from "../src/core/file-lock.ts";

function runWriter(resource: string, value: string): Promise<void> {
  const script = `
    import { appendFileSync } from 'node:fs';
    import { withCrossProcessFileLock } from './src/core/file-lock.ts';
    withCrossProcessFileLock(${JSON.stringify(resource)}, () => appendFileSync(${JSON.stringify(resource)}, ${JSON.stringify(`${value}\n`)}), { timeoutMs: 5000 });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--import", "./tests/register-ts-loader.mjs", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: unknown) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code: number | null) => code === 0 ? resolve() : reject(new Error(`writer exited ${code}: ${stderr}`)));
  });
}

test("cross-process file lock preserves every concurrent registry-style append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-"));
  const resource = join(dir, "registry.jsonl");
  writeFileSync(resource, "");
  await Promise.all(Array.from({ length: 8 }, (_, index) => runWriter(resource, `row-${index}`)));
  const rows = readFileSync(resource, "utf8").trim().split("\n").sort();
  assert.deepEqual(rows, Array.from({ length: 8 }, (_, index) => `row-${index}`).sort());
});

test("cross-process file lock recovers stale locks and times out on active locks", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-stale-"));
  const resource = join(dir, "registry.jsonl");
  const lock = `${resource}.lock`;
  writeFileSync(lock, "stale");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(withCrossProcessFileLock(resource, () => "recovered", { staleMs: 1_000 }), "recovered");

  const fd = openSync(lock, "wx");
  try {
    assert.throws(() => withCrossProcessFileLock(resource, (): void => undefined, { timeoutMs: 20, retryMs: 5 }), /Timed out waiting for file lock/);
  } finally {
    closeSync(fd);
  }
});
