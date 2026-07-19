import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdtempSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withCrossProcessFileLock, withCrossProcessFileLockAsync } from "../../src/core/file-lock.ts";

interface TestLockOwner {
  ownerNonce: string;
  generation: string;
  pid: number;
  processMarker: string;
  bootNonce: string;
  acquiredAt: string;
}

function marker(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const startTime = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u)[19];
    return startTime ? `pid:${pid}:start:${startTime}` : `pid:${pid}`;
  } catch { return `pid:${pid}`; }
}

function newOwner(pid: number, overrides: Partial<TestLockOwner> = {}): TestLockOwner {
  return {
    ownerNonce: randomUUID(), generation: randomUUID(), pid, processMarker: marker(pid),
    bootNonce: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), acquiredAt: new Date().toISOString(),
    ...overrides,
  };
}

function createLockForOwner(lock: string, owner: TestLockOwner): void {
  const token = `${lock}.generation-${owner.generation}`;
  writeFileSync(token, `${JSON.stringify(owner)}\n`);
  linkSync(token, lock);
}

function createCompleteLock(lock: string, pid: number): TestLockOwner {
  const owner = newOwner(pid);
  createLockForOwner(lock, owner);
  return owner;
}

const mutableFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;

function installFsOverrides(overrides: Record<string, unknown>): () => void {
  const originals = new Map<string, unknown>();
  for (const [name, replacement] of Object.entries(overrides)) {
    originals.set(name, mutableFs[name]);
    mutableFs[name] = replacement;
  }
  syncBuiltinESMExports();
  return () => {
    for (const [name, original] of originals) mutableFs[name] = original;
    syncBuiltinESMExports();
  };
}

function withFsOverrides<T>(overrides: Record<string, unknown>, fn: () => T): T {
  const restore = installFsOverrides(overrides);
  try { return fn(); }
  finally { restore(); }
}

async function withFsOverridesAsync<T>(overrides: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const restore = installFsOverrides(overrides);
  try { return await fn(); }
  finally { restore(); }
}

function removeCompleteLock(lock: string, owner: TestLockOwner): void {
  try { unlinkSync(lock); } catch { /* best effort */ }
  try { unlinkSync(`${lock}.generation-${owner.generation}`); } catch { /* best effort */ }
}

function runWriter(resource: string, value: string): Promise<void> {
  const script = `
    import { appendFileSync } from 'node:fs';
    import { withCrossProcessFileLock } from './src/core/file-lock.ts';
    withCrossProcessFileLock(${JSON.stringify(resource)}, () => appendFileSync(${JSON.stringify(resource)}, ${JSON.stringify(`${value}\n`)}), { timeoutMs: 5000 });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--import", "./tests/helpers/register-ts-loader.mjs", "--input-type=module", "-e", script], {
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

test("async file lock serializes same-process awaiters without blocking the holder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-async-"));
  const resource = join(dir, "daemon-startup");
  const order: number[] = [];
  await Promise.all(Array.from({ length: 10 }, (_, index) =>
    withCrossProcessFileLockAsync(resource, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      order.push(index);
    }, { timeoutMs: 2_000 })));
  assert.equal(order.length, 10);
  assert.equal(new Set(order).size, 10);
});

test("cross-process file lock recovers stale complete locks and times out on active locks", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-stale-"));
  const resource = join(dir, "registry.jsonl");
  const lock = `${resource}.lock`;
  createCompleteLock(lock, 2_147_483_647);
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

test("stale reclaimer never unlinks a replacement lock after observing the stale generation", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-reclaim-race-"));
  const resource = join(dir, "registry.jsonl");
  const lock = `${resource}.lock`;
  const stalePid = 2_147_483_647;
  const stale = createCompleteLock(lock, stalePid);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);

  const originalKill = process.kill;
  let successor: TestLockOwner | undefined;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid !== stalePid) return originalKill(pid, signal as NodeJS.Signals | number);
    unlinkSync(lock);
    successor = createCompleteLock(lock, process.pid);
    throw Object.assign(new Error("stale owner exited"), { code: "ESRCH" });
  }) as typeof process.kill;
  try {
    assert.throws(
      () => withCrossProcessFileLock(resource, (): void => undefined, { timeoutMs: 20, staleMs: 0, retryMs: 5 }),
      /Timed out waiting for file lock/,
    );
    assert.ok(successor);
    assert.equal((JSON.parse(readFileSync(lock, "utf8")) as TestLockOwner).generation, successor.generation);
    assert.equal(existsSync(`${lock}.generation-${stale.generation}`), false);
  } finally {
    process.kill = originalKill;
    if (successor) removeCompleteLock(lock, successor);
  }
});

test("successful callback cleanup never unlinks a successor generation", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-cleanup-race-"));
  const resource = join(dir, "registry.jsonl");
  const lock = `${resource}.lock`;
  let displaced: TestLockOwner | undefined;
  let successor: TestLockOwner | undefined;

  assert.equal(withCrossProcessFileLock(resource, () => {
    displaced = JSON.parse(readFileSync(lock, "utf8")) as TestLockOwner;
    unlinkSync(lock);
    successor = createCompleteLock(lock, process.pid);
    return "complete";
  }), "complete");

  assert.ok(displaced);
  assert.ok(successor);
  assert.equal((JSON.parse(readFileSync(lock, "utf8")) as TestLockOwner).ownerNonce, successor.ownerNonce);
  assert.equal(existsSync(`${lock}.generation-${displaced.generation}`), false);
  removeCompleteLock(lock, successor);
});

test("malformed and incomplete lock records are retained instead of reclaimed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-malformed-"));
  const resource = join(dir, "registry.jsonl");
  const lock = `${resource}.lock`;
  const owner = newOwner(2_147_483_647);
  const malformedRecords = ["{", JSON.stringify([]), JSON.stringify({ ...owner, acquiredAt: "not-a-date" })];

  for (const record of malformedRecords) {
    writeFileSync(lock, record);
    assert.throws(
      () => withCrossProcessFileLock(resource, (): void => undefined, { timeoutMs: 0, staleMs: 0 }),
      /Timed out waiting for file lock/,
    );
    assert.equal(readFileSync(lock, "utf8"), record);
    unlinkSync(lock);
  }

  writeFileSync(lock, JSON.stringify(owner));
  assert.throws(
    () => withCrossProcessFileLock(resource, (): void => undefined, { timeoutMs: 0, staleMs: 0 }),
    /Timed out waiting for file lock/,
  );
  assert.equal(existsSync(lock), true);
  unlinkSync(lock);

  writeFileSync(lock, JSON.stringify(owner));
  writeFileSync(`${lock}.generation-${owner.generation}`, JSON.stringify(owner));
  assert.throws(
    () => withCrossProcessFileLock(resource, (): void => undefined, { timeoutMs: 0, staleMs: 0 }),
    /Timed out waiting for file lock/,
  );
  assert.equal(existsSync(lock), true);
  removeCompleteLock(lock, owner);
});

test("lock owner creation falls back safely when proc metadata is unavailable", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-proc-fallback-"));
  const resource = join(dir, "registry.jsonl");
  const lock = `${resource}.lock`;
  const realReadFileSync = readFileSync;

  withFsOverrides({
    readFileSync: (pathOrFd: string | number, encoding: BufferEncoding) => {
      if (pathOrFd === `/proc/${process.pid}/stat`) return "1 (node) S";
      if (pathOrFd === "/proc/sys/kernel/random/boot_id") throw Object.assign(new Error("unavailable"), { code: "EACCES" });
      return realReadFileSync(pathOrFd, encoding);
    },
  }, () => withCrossProcessFileLock(resource, () => {
    const owner = JSON.parse(realReadFileSync(lock, "utf8")) as TestLockOwner;
    assert.equal(owner.processMarker, `pid:${process.pid}`);
    assert.equal(owner.bootNonce, "unknown-boot");
  }));

  assert.equal(existsSync(lock), false);
});

test("stale recovery handles live-owner markers, permission denial, and boot mismatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-owner-liveness-"));
  const resource = join(dir, "registry.jsonl");
  const lock = `${resource}.lock`;
  const old = new Date(Date.now() - 60_000);
  const canonicalMarker = marker(process.pid);
  const legacyMarker = canonicalMarker.split(":").at(-1) ?? canonicalMarker;

  const legacyOwner = newOwner(process.pid, { processMarker: legacyMarker });
  createLockForOwner(lock, legacyOwner);
  utimesSync(lock, old, old);
  assert.throws(
    () => withCrossProcessFileLock(resource, (): void => undefined, { timeoutMs: 0, staleMs: 0 }),
    /Timed out waiting for file lock/,
  );
  removeCompleteLock(lock, legacyOwner);

  const deniedPid = 2_147_483_646;
  const deniedOwner = newOwner(deniedPid);
  createLockForOwner(lock, deniedOwner);
  utimesSync(lock, old, old);
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === deniedPid) throw Object.assign(new Error("denied"), { code: "EPERM" });
    return originalKill(pid, signal as NodeJS.Signals | number);
  }) as typeof process.kill;
  try {
    assert.throws(
      () => withCrossProcessFileLock(resource, (): void => undefined, { timeoutMs: 0, staleMs: 0 }),
      /Timed out waiting for file lock/,
    );
  } finally {
    process.kill = originalKill;
    removeCompleteLock(lock, deniedOwner);
  }

  const rebootedOwner = newOwner(process.pid, { bootNonce: "different-boot" });
  createLockForOwner(lock, rebootedOwner);
  utimesSync(lock, old, old);
  assert.equal(
    withCrossProcessFileLock(resource, () => "recovered", { timeoutMs: 100, staleMs: 0 }),
    "recovered",
  );
});

test("cleanup retains the public lock when its generation identity changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-token-identity-"));

  for (const mode of ["different-inode", "different-owner", "missing"] as const) {
    const resource = join(dir, `registry-${mode}.jsonl`);
    const lock = `${resource}.lock`;
    let acquired: TestLockOwner | undefined;
    withCrossProcessFileLock(resource, () => {
      acquired = JSON.parse(readFileSync(lock, "utf8")) as TestLockOwner;
      const token = `${lock}.generation-${acquired.generation}`;
      if (mode === "different-owner") writeFileSync(token, JSON.stringify(newOwner(process.pid)));
      else {
        unlinkSync(token);
        if (mode === "different-inode") writeFileSync(token, JSON.stringify(acquired));
      }
    });
    assert.ok(acquired);
    assert.equal(existsSync(lock), true);
    removeCompleteLock(lock, acquired);
  }
});

test("cleanup claim cannot unlink a same-inode lock whose owner changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-owner-change-"));
  const resource = join(dir, "registry.jsonl");
  const lock = `${resource}.lock`;
  const realUnlinkSync = unlinkSync;
  let acquired: TestLockOwner | undefined;
  let token = "";

  withFsOverrides({
    unlinkSync: (path: string) => {
      realUnlinkSync(path);
      if (path === token) writeFileSync(lock, JSON.stringify(newOwner(process.pid)));
    },
  }, () => withCrossProcessFileLock(resource, () => {
    acquired = JSON.parse(readFileSync(lock, "utf8")) as TestLockOwner;
    token = `${lock}.generation-${acquired.generation}`;
  }));

  assert.ok(acquired);
  assert.equal(existsSync(lock), true);
  assert.notEqual((JSON.parse(readFileSync(lock, "utf8")) as TestLockOwner).ownerNonce, acquired.ownerNonce);
  realUnlinkSync(lock);
});

test("cleanup tolerates disappearance and filesystem errors after claiming a generation", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-cleanup-errors-"));
  const realUnlinkSync = unlinkSync;
  const realStatSync = statSync;

  for (const mode of ["missing", "stat-error", "unlink-error"] as const) {
    const resource = join(dir, mode);
    const lock = `${resource}.lock`;
    let token = "";
    let claimed = false;
    withFsOverrides({
      statSync: (path: string) => {
        if (mode === "stat-error" && claimed && path === lock) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return realStatSync(path);
      },
      unlinkSync: (path: string) => {
        if (path === token) {
          if (mode === "unlink-error") throw Object.assign(new Error("denied"), { code: "EACCES" });
          realUnlinkSync(path);
          claimed = true;
          if (mode === "missing") realUnlinkSync(lock);
          return;
        }
        realUnlinkSync(path);
      },
    }, () => withCrossProcessFileLock(resource, () => {
      const owner = JSON.parse(readFileSync(lock, "utf8")) as TestLockOwner;
      token = `${lock}.generation-${owner.generation}`;
    }));
    if (existsSync(lock)) realUnlinkSync(lock);
    if (existsSync(token)) realUnlinkSync(token);
  }
});

test("acquisition rollback and final cleanup tolerate best-effort close failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-close-errors-"));
  const resource = join(dir, "registry.jsonl");
  const lock = `${resource}.lock`;
  const realCloseSync = closeSync;
  const realUnlinkSync = unlinkSync;
  writeFileSync(lock, "");

  withFsOverrides({
    closeSync: (fd: number) => {
      realCloseSync(fd);
      throw Object.assign(new Error("close failed"), { code: "EIO" });
    },
    unlinkSync: (path: string) => {
      realUnlinkSync(path);
      if (path.includes(".generation-")) throw Object.assign(new Error("unlink failed"), { code: "EIO" });
    },
  }, () => assert.throws(
    () => withCrossProcessFileLock(resource, (): void => undefined, { timeoutMs: 0, staleMs: 0 }),
    /Timed out waiting for file lock/,
  ));
  realUnlinkSync(lock);

  withFsOverrides({
    closeSync: (fd: number) => {
      realCloseSync(fd);
      throw Object.assign(new Error("close failed"), { code: "EIO" });
    },
  }, () => assert.equal(withCrossProcessFileLock(resource, () => "complete"), "complete"));
  assert.equal(existsSync(lock), false);
});

test("sync recovery propagates a non-racing generation removal error", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-recovery-error-"));
  const resource = join(dir, "registry.jsonl");
  const lock = `${resource}.lock`;
  const stale = createCompleteLock(lock, 2_147_483_647);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const token = `${lock}.generation-${stale.generation}`;
  const realUnlinkSync = unlinkSync;

  withFsOverrides({
    unlinkSync: (path: string) => {
      if (path === token) throw Object.assign(new Error("denied"), { code: "EACCES" });
      realUnlinkSync(path);
    },
  }, () => assert.throws(
    () => withCrossProcessFileLock(resource, (): void => undefined, { timeoutMs: 100, staleMs: 0 }),
    { code: "EACCES" },
  ));
  removeCompleteLock(lock, stale);
});

test("stale recovery and async finalization tolerate close failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-async-close-"));
  const resource = join(dir, "registry.jsonl");
  const lock = `${resource}.lock`;
  createCompleteLock(lock, 2_147_483_647);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const realCloseSync = closeSync;

  await withFsOverridesAsync({
    closeSync: (fd: number) => {
      realCloseSync(fd);
      throw Object.assign(new Error("close failed"), { code: "EIO" });
    },
  }, () => withCrossProcessFileLockAsync(resource, async () => "recovered", { timeoutMs: 100, staleMs: 0 }));
  assert.equal(existsSync(lock), false);
});

test("async contention covers timeout and stale-generation error handling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-async-edges-"));
  const timeoutResource = join(dir, "timeout");
  const timeoutLock = `${timeoutResource}.lock`;
  const live = createCompleteLock(timeoutLock, process.pid);
  await assert.rejects(
    withCrossProcessFileLockAsync(timeoutResource, async (): Promise<void> => undefined, { timeoutMs: 0, staleMs: 60_000 }),
    /Timed out waiting for file lock/,
  );
  removeCompleteLock(timeoutLock, live);

  const errorResource = join(dir, "error");
  const errorLock = `${errorResource}.lock`;
  const stale = createCompleteLock(errorLock, 2_147_483_647);
  const old = new Date(Date.now() - 60_000);
  utimesSync(errorLock, old, old);
  const token = `${errorLock}.generation-${stale.generation}`;
  const realUnlinkSync = unlinkSync;
  await withFsOverridesAsync({
    unlinkSync: (path: string) => {
      if (path === token) throw Object.assign(new Error("denied"), { code: "EACCES" });
      realUnlinkSync(path);
    },
  }, () => assert.rejects(
    withCrossProcessFileLockAsync(errorResource, async (): Promise<void> => undefined, { timeoutMs: 100, staleMs: 0 }),
    { code: "EACCES" },
  ));
  removeCompleteLock(errorLock, stale);
});

test("async cleanup treats a failed generation unlink as best effort", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-async-cleanup-"));
  const resource = join(dir, "registry.jsonl");
  const lock = `${resource}.lock`;
  const realUnlinkSync = unlinkSync;
  let token = "";

  await withFsOverridesAsync({
    unlinkSync: (path: string) => {
      if (path === token) throw Object.assign(new Error("denied"), { code: "EACCES" });
      realUnlinkSync(path);
    },
  }, () => withCrossProcessFileLockAsync(resource, async () => {
    const owner = JSON.parse(readFileSync(lock, "utf8")) as TestLockOwner;
    token = `${lock}.generation-${owner.generation}`;
  }));
  assert.equal(existsSync(lock), true);
  realUnlinkSync(lock);
  realUnlinkSync(token);
});

test("sync and async acquisition propagate non-contention errors and release after callback errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-lock-propagation-"));
  const missingResource = join(dir, "missing", "registry.jsonl");
  assert.throws(() => withCrossProcessFileLock(missingResource, (): void => undefined), { code: "ENOENT" });
  await assert.rejects(withCrossProcessFileLockAsync(missingResource, async (): Promise<void> => undefined), { code: "ENOENT" });

  const syncResource = join(dir, "sync");
  assert.throws(() => withCrossProcessFileLock(syncResource, () => { throw new Error("callback failed"); }), /callback failed/);
  assert.equal(existsSync(`${syncResource}.lock`), false);

  const asyncResource = join(dir, "async");
  await assert.rejects(
    withCrossProcessFileLockAsync(asyncResource, async () => { throw new Error("async callback failed"); }),
    /async callback failed/,
  );
  assert.equal(existsSync(`${asyncResource}.lock`), false);
});
