import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { currentBootNonce, currentProcessMarker, processIdentityIsDead } from "./process-identity";

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

interface FileLockOwner {
  readonly ownerNonce: string;
  readonly generation: string;
  readonly pid: number;
  readonly processMarker: string;
  readonly bootNonce: string;
  readonly acquiredAt: string;
}

interface FileLockIdentity {
  readonly fd: number;
  readonly owner: FileLockOwner;
  readonly stat: Stats;
}

function lockOwner(): FileLockOwner {
  return Object.freeze({
    ownerNonce: randomUUID(), generation: randomUUID(), pid: process.pid,
    processMarker: currentProcessMarker(process.pid), bootNonce: currentBootNonce(), acquiredAt: new Date().toISOString(),
  });
}

function generationPath(lockPath: string, owner: FileLockOwner): string {
  return `${lockPath}.generation-${owner.generation}`;
}

function readLockOwner(pathOrFd: string | number): FileLockOwner | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(pathOrFd, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const owner = value as Record<string, unknown>;
    if (typeof owner.ownerNonce !== "string" || !/^[0-9a-f-]{36}$/u.test(owner.ownerNonce)
      || typeof owner.generation !== "string" || !/^[0-9a-f-]{36}$/u.test(owner.generation)
      || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1 || typeof owner.processMarker !== "string" || !owner.processMarker
      || typeof owner.bootNonce !== "string" || !owner.bootNonce || typeof owner.acquiredAt !== "string" || !Number.isFinite(Date.parse(owner.acquiredAt))) return undefined;
    return owner as unknown as FileLockOwner;
  } catch {
    return undefined;
  }
}

function ownerMatches(left: FileLockOwner | undefined, right: FileLockOwner): boolean {
  return left?.ownerNonce === right.ownerNonce && left.generation === right.generation;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function observeLockIdentity(lockPath: string): FileLockIdentity | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, "r");
    const owner = readLockOwner(fd);
    if (!owner) return undefined;
    const observed = fstatSync(fd);
    const current = statSync(lockPath);
    const generation = statSync(generationPath(lockPath, owner));
    if (!sameFile(observed, current) || !sameFile(observed, generation) || !ownerMatches(readLockOwner(lockPath), owner)) return undefined;
    const identity = { fd, owner, stat: observed };
    fd = undefined;
    return identity;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function ownerIsLive(owner: FileLockOwner): boolean {
  return !processIdentityIsDead(owner);
}

// The generation hard link is an atomic, one-shot removal claim. Only the
// caller that removes the observed/acquired generation may unlink the public
// lock name. While it owns that claim, no conforming cleanup can remove the
// old public name and make room for a successor before the identity recheck.
function unlinkLockIfIdentityMatches(lockPath: string, identity: FileLockIdentity): boolean {
  const tokenPath = generationPath(lockPath, identity.owner);
  try {
    const token = statSync(tokenPath);
    if (!sameFile(identity.stat, token) || !ownerMatches(readLockOwner(tokenPath), identity.owner)) return false;
    unlinkSync(tokenPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  try {
    const current = statSync(lockPath);
    if (!sameFile(identity.stat, current) || !ownerMatches(readLockOwner(lockPath), identity.owner)) return false;
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function staleLockCanBeRecovered(lockPath: string, staleMs: number): boolean {
  const identity = observeLockIdentity(lockPath);
  if (!identity) return false;
  try {
    if (Date.now() - identity.stat.mtimeMs <= staleMs || ownerIsLive(identity.owner)) return false;
    return unlinkLockIfIdentityMatches(lockPath, identity);
  } finally {
    try { closeSync(identity.fd); } catch { /* best effort */ }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryAcquire(lockPath: string): FileLockIdentity {
  const owner = lockOwner();
  const tokenPath = generationPath(lockPath, owner);
  const fd = openSync(tokenPath, "wx+", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(owner)}\n`);
    linkSync(tokenPath, lockPath);
    return { fd, owner, stat: fstatSync(fd) };
  } catch (error) {
    try { closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(tokenPath); } catch { /* best effort */ }
    throw error;
  }
}

// Short cross-process critical sections for shared local metadata. The lock is
// an adjacent O_EXCL hard link, so unrelated resources do not block one another.
// Its per-acquisition generation link makes stale recovery and cleanup ABA-safe.
export function withCrossProcessFileLock<T>(resourcePath: string, fn: () => T, options: FileLockOptions = {}): T {
  const lockPath = `${resourcePath}.lock`;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const staleMs = options.staleMs ?? 30_000;
  const retryMs = options.retryMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  let identity: FileLockIdentity | undefined;

  while (!identity) {
    try {
      identity = tryAcquire(lockPath);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (staleLockCanBeRecovered(lockPath, staleMs)) continue;
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
    try { unlinkLockIfIdentityMatches(lockPath, identity); } catch { /* best effort */ }
    try { closeSync(identity.fd); } catch { /* best effort */ }
  }
}

// Async variant for startup/lifecycle critical sections. Retry waits yield the
// event loop, so concurrent callers in the same process cannot deadlock the
// lock holder while it awaits health checks or subprocess readiness.
export async function withCrossProcessFileLockAsync<T>(resourcePath: string, fn: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const lockPath = `${resourcePath}.lock`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const retryMs = options.retryMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let identity: FileLockIdentity | undefined;

  while (!identity) {
    try {
      identity = tryAcquire(lockPath);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (staleLockCanBeRecovered(lockPath, staleMs)) continue;
      } catch (statError: any) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      await sleep(retryMs);
    }
  }

  try {
    return await fn();
  } finally {
    try { unlinkLockIfIdentityMatches(lockPath, identity); } catch { /* best effort */ }
    try { closeSync(identity.fd); } catch { /* best effort */ }
  }
}
