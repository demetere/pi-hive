import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { withCrossProcessFileLock, withCrossProcessFileLockAsync } from "../core/file-lock";
import { currentBootNonce, currentProcessMarker, processIdentityIsDead } from "../core/process-identity";
import { resolveCanonicalPath } from "../core/safe-path";
import { isArtifactHash } from "./hashes";

export const WORKSPACE_LEASE_FORMAT_VERSION = 1 as const;
export const WORKSPACE_LEASE_TIMING = Object.freeze({
  heartbeatMs: 10_000,
  staleMs: 60_000,
  lockTimeoutMs: 5_000,
  lockStaleMs: 30_000,
});
const LEASE_FILE_BYTES = 16_384;

export interface WorkspaceLeaseOwnerV1 {
  readonly formatVersion: 1;
  readonly adapterId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly pid: number;
  readonly processMarker: string;
  readonly bootNonce: string;
  readonly ownerNonce: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}
export interface WorkspaceLeaseRuntimeOptions {
  readonly projectRoot: string;
  readonly adapterId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly ownerNonce?: string;
  readonly pid?: number;
  readonly processMarker?: string;
  readonly bootNonce?: string;
  readonly now?: () => number;
  readonly verifyDead?: (owner: WorkspaceLeaseOwnerV1) => boolean;
  readonly onHeartbeatLost?: (error: Error) => void;
}
export type WorkspaceLeaseAcquireResult =
  | Readonly<{ ok: false; reason: string; owner: WorkspaceLeaseOwnerV1 }>
  | Readonly<{ ok: true; reason: string; owner: WorkspaceLeaseOwnerV1; recovered: boolean; previousRunId?: string }>;
export type WorkspaceLeaseView =
  | Readonly<{ state: "available" }>
  | Readonly<{ state: "owned"; runId: string; heartbeatAt: string; expiresAt: string }>;
export interface WorkspaceLeaseRunIdentity {
  readonly sessionId: string;
  readonly runId: string;
}

function id(value: string, label: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > 256 || value.includes("/") || value.includes("\\") || value.includes("\0")) throw new Error(`${label} is invalid`);
  return value;
}
function leaseKey(adapterId: string, workspaceId: string): string {
  return createHash("sha256").update("pi-hive-artifact-lease-key-v1\0").update(adapterId).update("\0").update(workspaceId).digest("hex");
}
function leasePath(projectRoot: string, adapterId: string, workspaceId: string): string {
  const canonicalProject = resolveCanonicalPath(projectRoot);
  if (!canonicalProject?.exists) throw new Error("Artifact writer lease project root cannot be canonically resolved");
  return join(canonicalProject.canonicalPath, ".pi", "hive", "sessions", "workspace-leases", `${leaseKey(adapterId, workspaceId)}.json`);
}
function defaultDead(owner: WorkspaceLeaseOwnerV1): boolean {
  return processIdentityIsDead(owner);
}
function validDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function readLease(path: string): WorkspaceLeaseOwnerV1 | undefined {
  let fd: number | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("Artifact writer lease symlink is denied");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > LEASE_FILE_BYTES) throw new Error("Artifact writer lease file is invalid");
    const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Artifact writer lease record is invalid");
    const raw = parsed as Record<string, unknown>;
    const keys = ["formatVersion", "adapterId", "workspaceId", "sessionId", "runId", "pid", "processMarker", "bootNonce", "ownerNonce", "acquiredAt", "heartbeatAt", "expiresAt"] as const;
    if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(raw, key)) || raw.formatVersion !== 1
      || typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) || raw.pid < 1
      || !validDate(raw.acquiredAt) || !validDate(raw.heartbeatAt) || !validDate(raw.expiresAt)) throw new Error("Artifact writer lease record is invalid");
    for (const key of ["adapterId", "workspaceId", "sessionId", "runId", "processMarker", "bootNonce", "ownerNonce"] as const) {
      if (typeof raw[key] !== "string") throw new Error("Artifact writer lease record is invalid");
      id(raw[key], `Artifact writer lease ${key}`);
    }
    if (Date.parse(raw.expiresAt) !== Date.parse(raw.heartbeatAt) + WORKSPACE_LEASE_TIMING.staleMs) throw new Error("Artifact writer lease expiry is invalid");
    return Object.freeze(raw as unknown as WorkspaceLeaseOwnerV1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function writeAtomic(path: string, owner: WorkspaceLeaseOwnerV1): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(owner)}\n`);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    const dirFd = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(temporary); } catch { /* published or absent */ }
  }
}
function withLeaseLock<T>(path: string, callback: () => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withCrossProcessFileLock(path, callback, { timeoutMs: WORKSPACE_LEASE_TIMING.lockTimeoutMs, staleMs: WORKSPACE_LEASE_TIMING.lockStaleMs });
}

export function inspectWorkspaceLease(projectRoot: string, adapterId: string, workspaceId: string, _now = Date.now()): WorkspaceLeaseView {
  id(adapterId, "Artifact lease adapter ID"); id(workspaceId, "Artifact lease workspace ID");
  const owner = readLease(leasePath(projectRoot, adapterId, workspaceId));
  if (!owner) return Object.freeze({ state: "available" });
  // Expiry alone does not publish availability: acquisition must also prove death.
  return Object.freeze({ state: "owned", runId: owner.runId, heartbeatAt: owner.heartbeatAt, expiresAt: owner.expiresAt });
}

function assertRunLeaseOwner(path: string, identity: WorkspaceLeaseRunIdentity, now: number): void {
  const owner = readLease(path);
  if (!owner || owner.sessionId !== identity.sessionId || owner.runId !== identity.runId || now >= Date.parse(owner.expiresAt)) {
    throw new Error("Current run does not own the fresh artifact writer lease");
  }
}

/**
 * Serialize an approval/hash validation with artifact mutations, while proving
 * that the exact session/run still owns a fresh writer lease. This intentionally
 * reveals no owner nonce to dashboard/control callers.
 */
export async function withWorkspaceLeaseRunValidation<T>(
  projectRoot: string,
  adapterId: string,
  workspaceId: string,
  identity: WorkspaceLeaseRunIdentity,
  callback: () => T | Promise<T>,
): Promise<T> {
  id(adapterId, "Artifact lease adapter ID"); id(workspaceId, "Artifact lease workspace ID");
  id(identity.sessionId, "Artifact lease session ID"); id(identity.runId, "Artifact lease run ID");
  const path = leasePath(projectRoot, adapterId, workspaceId);
  return withCrossProcessFileLockAsync(`${path}.mutation`, async () => {
    withLeaseLock(path, () => assertRunLeaseOwner(path, identity, Date.now()));
    const result = await callback();
    withLeaseLock(path, () => assertRunLeaseOwner(path, identity, Date.now()));
    return result;
  }, { timeoutMs: WORKSPACE_LEASE_TIMING.lockTimeoutMs, staleMs: WORKSPACE_LEASE_TIMING.lockStaleMs });
}

export class WorkspaceLeaseRuntime {
  readonly options: WorkspaceLeaseRuntimeOptions;
  readonly ownerNonce: string;
  private readonly path: string;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatLost?: (error: Error) => void;
  constructor(options: WorkspaceLeaseRuntimeOptions) {
    id(options.adapterId, "Artifact lease adapter ID"); id(options.workspaceId, "Artifact lease workspace ID");
    id(options.sessionId, "Artifact lease session ID"); id(options.runId, "Artifact lease run ID");
    this.options = options;
    this.ownerNonce = id(options.ownerNonce ?? randomUUID(), "Artifact lease owner nonce");
    this.path = leasePath(options.projectRoot, options.adapterId, options.workspaceId);
  }
  private time(): number { return this.options.now?.() ?? Date.now(); }
  acquire(): WorkspaceLeaseAcquireResult {
    const result = withLeaseLock(this.path, () => {
      const now = this.time();
      const existing = readLease(this.path);
      if (existing?.ownerNonce === this.ownerNonce && existing.runId === this.options.runId && existing.sessionId === this.options.sessionId) {
        return Object.freeze({ ok: true, reason: "artifact writer lease already owned", owner: existing, recovered: false });
      }
      if (existing) {
        if (now < Date.parse(existing.expiresAt)) return Object.freeze({ ok: false, reason: "artifact writer lease heartbeat is fresh; it cannot be stolen", owner: existing });
        if (!(this.options.verifyDead ?? defaultDead)(existing)) return Object.freeze({ ok: false, reason: "expired artifact writer lease owner is not verified dead", owner: existing });
      }
      const pid = this.options.pid ?? process.pid;
      const timestamp = new Date(now).toISOString();
      const owner: WorkspaceLeaseOwnerV1 = Object.freeze({
        formatVersion: 1,
        adapterId: this.options.adapterId,
        workspaceId: this.options.workspaceId,
        sessionId: this.options.sessionId,
        runId: this.options.runId,
        pid,
        processMarker: id(this.options.processMarker ?? currentProcessMarker(pid), "Artifact lease process marker"),
        bootNonce: id(this.options.bootNonce ?? currentBootNonce(), "Artifact lease boot nonce"),
        ownerNonce: this.ownerNonce,
        acquiredAt: timestamp,
        heartbeatAt: timestamp,
        expiresAt: new Date(now + WORKSPACE_LEASE_TIMING.staleMs).toISOString(),
      });
      writeAtomic(this.path, owner);
      return Object.freeze({ ok: true, reason: existing ? "verified dead expired artifact writer lease recovered" : "artifact writer lease acquired", owner, recovered: Boolean(existing), ...(existing ? { previousRunId: existing.runId } : {}) });
    });
    if (result.ok) this.startHeartbeat();
    return result;
  }
  heartbeat(now = this.time()): boolean {
    return withLeaseLock(this.path, () => {
      const owner = readLease(this.path);
      if (!owner || owner.ownerNonce !== this.ownerNonce || owner.runId !== this.options.runId || owner.sessionId !== this.options.sessionId) return false;
      writeAtomic(this.path, Object.freeze({ ...owner, heartbeatAt: new Date(now).toISOString(), expiresAt: new Date(now + WORKSPACE_LEASE_TIMING.staleMs).toISOString() }));
      return true;
    });
  }
  assertOwned(): WorkspaceLeaseOwnerV1 {
    const owner = readLease(this.path);
    if (!owner || owner.ownerNonce !== this.ownerNonce || owner.runId !== this.options.runId || owner.sessionId !== this.options.sessionId
      || this.time() >= Date.parse(owner.expiresAt)) throw new Error("Current run does not own a fresh artifact writer lease");
    return owner;
  }
  async withOwnedMutation<T>(callback: () => T | Promise<T>): Promise<T> {
    return withCrossProcessFileLockAsync(`${this.path}.mutation`, async () => {
      this.assertOwned();
      try { return await callback(); }
      finally { this.assertOwned(); }
    }, { timeoutMs: WORKSPACE_LEASE_TIMING.lockTimeoutMs, staleMs: WORKSPACE_LEASE_TIMING.lockStaleMs });
  }
  release(): boolean {
    this.stopHeartbeat();
    return withLeaseLock(this.path, () => {
      const owner = readLease(this.path);
      if (!owner || owner.ownerNonce !== this.ownerNonce || owner.runId !== this.options.runId || owner.sessionId !== this.options.sessionId) return false;
      unlinkSync(this.path);
      return true;
    });
  }
  inspect(): WorkspaceLeaseView { return inspectWorkspaceLease(this.options.projectRoot, this.options.adapterId, this.options.workspaceId, this.time()); }
  startHeartbeat(onLost: ((error: Error) => void) | undefined = this.options.onHeartbeatLost): Readonly<{ stop(): void }> {
    if (onLost) this.heartbeatLost = onLost;
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        try {
          if (!this.heartbeat()) {
            const error = new Error("Artifact writer lease heartbeat lost ownership");
            this.stopHeartbeat();
            this.heartbeatLost?.(error);
          }
        } catch (error) {
          this.stopHeartbeat();
          this.heartbeatLost?.(error instanceof Error ? error : new Error(String(error)));
        }
      }, WORKSPACE_LEASE_TIMING.heartbeatMs);
      this.heartbeatTimer.unref?.();
    }
    return Object.freeze({ stop: () => { this.stopHeartbeat(); } });
  }
  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
  hasLiveHeartbeat(): boolean { return this.heartbeatTimer !== undefined; }
  releaseForLifecycle(reason: "pause" | "cancel" | "finish", finalWorkspaceHash: string): Readonly<{ reason: "pause" | "cancel" | "finish"; released: boolean; finalWorkspaceHash: string }> {
    if (!isArtifactHash(finalWorkspaceHash)) throw new Error("Artifact lifecycle final workspace hash is invalid");
    return Object.freeze({ reason, released: this.release(), finalWorkspaceHash });
  }
}
