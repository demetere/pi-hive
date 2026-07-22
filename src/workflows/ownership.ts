import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withCrossProcessFileLock } from "../core/file-lock";
import { workflowSessionDirectory, appendWorkflowEvent } from "./journal";
import { createWorkflowEvent } from "./events";

export const RUNTIME_OWNERSHIP_FORMAT_VERSION = 1 as const;
export const RUNTIME_OWNERSHIP_TIMING = Object.freeze({ heartbeatMs: 10_000, staleMs: 60_000, appendLockTimeoutMs: 5_000 });
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export interface RuntimeOwner { readonly formatVersion: 1; readonly sessionId: string; readonly pid: number; readonly processMarker: string; readonly bootNonce: string; readonly ownerNonce: string; readonly generation: string; readonly acquiredAt: string; readonly heartbeatAt: string }
export interface AcquireOwnershipOptions { readonly pid?: number; readonly processMarker?: string; readonly now?: number; readonly nonce?: string; readonly bootNonce?: string; readonly verifyDead?: (owner: RuntimeOwner) => boolean }
export interface OwnershipResult { readonly ok: boolean; readonly reason: string; readonly owner?: RuntimeOwner; readonly recovered?: boolean; readonly previousOwner?: RuntimeOwner }
function pathFor(root: string, id: string) { return join(workflowSessionDirectory(root, id), "runtime-owner.json"); }
function readOwner(path: string): RuntimeOwner | undefined { let fd: number | undefined; try { if (lstatSync(path).isSymbolicLink()) throw new Error("Runtime owner symlink denied"); fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const stat = fstatSync(fd); if (!stat.isFile() || stat.size <= 0 || stat.size > 16_384) throw new Error("Runtime owner size invalid"); const value = JSON.parse(readFileSync(fd, "utf8")) as RuntimeOwner; if (value.formatVersion !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 || !value.ownerNonce || !UUID_V4_PATTERN.test(value.generation) || !Number.isFinite(Date.parse(value.heartbeatAt))) throw new Error("Runtime owner invalid"); return value; } catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; } finally { if (fd !== undefined) closeSync(fd); } }
function writeAtomic(path: string, value: RuntimeOwner): void { const dir = dirname(path); mkdirSync(dir, { recursive: true, mode: 0o700 }); const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; let fd: number | undefined; try { fd = openSync(temp, "wx", 0o600); writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path); const dirFd = openSync(dir, constants.O_RDONLY); try { fsyncSync(dirFd); } finally { closeSync(dirFd); } } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ } try { unlinkSync(temp); } catch { /* published or absent */ } } }
function defaultProcessMarker(pid: number): string { try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ").slice(0, 22).join(" "); } catch { return `pid:${pid}`; } }
function defaultBootNonce(): string { try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return "unknown-boot"; } }
function defaultDead(owner: RuntimeOwner): boolean { try { process.kill(owner.pid, 0); return defaultProcessMarker(owner.pid) !== owner.processMarker || defaultBootNonce() !== owner.bootNonce; } catch (error: any) { return error?.code === "ESRCH"; } }
export function acquireRuntimeOwnership(root: string, sessionId: string, options: AcquireOwnershipOptions = {}): OwnershipResult {
  const path = pathFor(root, sessionId); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withCrossProcessFileLock(path, () => {
    const now = options.now ?? Date.now(); const existing = readOwner(path);
    if (existing) { const stale = now - Date.parse(existing.heartbeatAt) >= RUNTIME_OWNERSHIP_TIMING.staleMs; if (!stale) return Object.freeze({ ok: false, reason: "runtime ownership heartbeat is fresh", owner: existing }); const dead = (options.verifyDead ?? defaultDead)(existing); if (!dead) return Object.freeze({ ok: false, reason: "stale owner is not verified dead", owner: existing }); }
    const pid = options.pid ?? process.pid; const timestamp = new Date(now).toISOString(); const owner = Object.freeze({ formatVersion: 1 as const, sessionId, pid, processMarker: options.processMarker ?? defaultProcessMarker(pid), bootNonce: options.bootNonce ?? defaultBootNonce(), ownerNonce: options.nonce ?? randomUUID(), generation: randomUUID(), acquiredAt: timestamp, heartbeatAt: timestamp }); writeAtomic(path, owner); return Object.freeze({ ok: true, reason: existing ? "verified dead stale owner recovered" : "runtime ownership acquired", owner, recovered: Boolean(existing), ...(existing ? { previousOwner: existing } : {}) });
  }, { timeoutMs: 5_000, staleMs: 30_000 });
}
export function heartbeatRuntimeOwnership(root: string, sessionId: string, nonce: string, now = Date.now()): boolean { const path = pathFor(root, sessionId); return withCrossProcessFileLock(path, () => { const owner = readOwner(path); if (!owner || owner.ownerNonce !== nonce) return false; writeAtomic(path, Object.freeze({ ...owner, heartbeatAt: new Date(now).toISOString() })); return true; }); }
export function heartbeatCurrentRuntimeOwnership(root: string, sessionId: string, nonce: string, now = Date.now()): boolean { const path = pathFor(root, sessionId); return withCrossProcessFileLock(path, () => { const owner = readOwner(path); if (!owner || owner.ownerNonce !== nonce || owner.pid !== process.pid) return false; writeAtomic(path, Object.freeze({ ...owner, heartbeatAt: new Date(now).toISOString() })); return true; }); }
export function releaseRuntimeOwnership(root: string, sessionId: string, nonce: string): boolean { const path = pathFor(root, sessionId); return withCrossProcessFileLock(path, () => { const owner = readOwner(path); if (!owner || owner.ownerNonce !== nonce) return false; unlinkSync(path); return true; }); }
function sameOwnershipGeneration(actual: RuntimeOwner, expected: RuntimeOwner): boolean {
  return actual.formatVersion === expected.formatVersion
    && actual.sessionId === expected.sessionId
    && actual.pid === expected.pid
    && actual.processMarker === expected.processMarker
    && actual.bootNonce === expected.bootNonce
    && actual.ownerNonce === expected.ownerNonce
    && actual.generation === expected.generation
    && actual.acquiredAt === expected.acquiredAt;
}
/**
 * Settle release of one captured acquisition. Absence is accepted because Pi's
 * native session_shutdown may already have released it. A foreign owner or a
 * later acquisition (including one reusing the process-global nonce) is never
 * removed or treated as success.
 */
export function settleRuntimeOwnershipRelease(root: string, sessionId: string, expected: RuntimeOwner): boolean {
  if (expected.sessionId !== sessionId) return false;
  const path = pathFor(root, sessionId);
  return withCrossProcessFileLock(path, () => {
    const owner = readOwner(path);
    if (!owner) return true;
    if (!sameOwnershipGeneration(owner, expected)) return false;
    unlinkSync(path);
    return true;
  });
}
export function captureRuntimeOwnership(root: string, sessionId: string, nonce: string): RuntimeOwner | undefined {
  const path = pathFor(root, sessionId);
  return withCrossProcessFileLock(path, () => {
    const owner = readOwner(path);
    return owner?.ownerNonce === nonce ? Object.freeze({ ...owner }) : undefined;
  });
}
export function markWorkflowOrphaned(root: string, sessionId: string, projectId: string, reason: string): void { appendWorkflowEvent(root, createWorkflowEvent({ projectId, sessionId, type: "session.orphaned", payload: { reason: reason.slice(0, 2_048) }, producer: "recovery" })); }
