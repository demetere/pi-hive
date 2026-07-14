import { closeSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

// Short cross-process critical sections for shared local metadata. The lock is
// an adjacent O_EXCL file, so unrelated resources do not block one another.
// Stale lock recovery handles a process dying between acquire and cleanup.
export function withCrossProcessFileLock<T>(resourcePath: string, fn: () => T, options: FileLockOptions = {}): T {
  const lockPath = `${resourcePath}.lock`;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const staleMs = options.staleMs ?? 30_000;
  const retryMs = options.retryMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  let fd: number | undefined;

  while (fd === undefined) {
    try {
      const candidate = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(candidate, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
        fd = candidate;
      } catch (error) {
        try { closeSync(candidate); } catch { /* best effort */ }
        try { unlinkSync(lockPath); } catch { /* best effort */ }
        throw error;
      }
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (statError: any) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      sleepSync(retryMs);
    }
  }

  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(lockPath); } catch { /* best effort */ }
  }
}
