import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const OWNED = new WeakSet<object>();
const TERMINATED = new WeakSet<object>();
const LAST_SIGNAL = new WeakMap<object, NodeJS.Signals>();
export interface OwnedProcessTree { readonly pid: number; readonly child: ChildProcess; readonly startedAt: number }

function hasObservedExit(child: ChildProcess): boolean {
  return child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined;
}

function processGroupIsLive(pid: number): boolean {
  if (process.platform === "win32") return false;
  if (process.platform === "linux") {
    try {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/u.test(entry)) continue;
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
          const tail = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
          if (Number(tail[2]) === pid && tail[0] !== "Z") return true;
        } catch { /* process exited during inspection */ }
      }
      return false;
    } catch { /* fall through to portable group probe */ }
  }
  try { process.kill(-pid, 0); return true; }
  catch { return false; }
}

export function spawnOwnedProcess(command: string, args: readonly string[], options: SpawnOptions = {}): OwnedProcessTree {
  if (!command || !Array.isArray(args) || args.length > 256) throw new Error("OWNED_PROCESS_INPUT_INVALID");
  const child = spawn(command, [...args], { ...options, detached: true });
  if (typeof child.pid !== "number") { try { child.kill(); } catch { /* best effort */ } throw new Error("OWNED_PROCESS_START_FAILED"); }
  const handle = Object.freeze({ pid: child.pid, child, startedAt: Date.now() });
  OWNED.add(handle);
  return handle;
}

/** A numeric PID is never authority: only a handle minted above can signal its verified-live process group. */
export function terminateOwnedProcess(
  handle: OwnedProcessTree | undefined,
  signal: NodeJS.Signals = "SIGTERM",
  signalProcess: (pid: number, signal: NodeJS.Signals) => boolean = process.kill,
  isProcessGroupLive: (pid: number) => boolean = processGroupIsLive,
): boolean {
  if (!handle || !OWNED.has(handle) || handle.child.pid !== handle.pid || TERMINATED.has(handle)) return false;
  const groupLive = process.platform !== "win32"
    ? isProcessGroupLive(handle.pid)
    : !hasObservedExit(handle.child);
  if (!groupLive) {
    TERMINATED.add(handle);
    return false;
  }
  if (signal !== "SIGKILL" && LAST_SIGNAL.get(handle) === signal) return false;

  let signalled = false;
  try {
    signalled = process.platform !== "win32"
      ? signalProcess(-handle.pid, signal)
      : handle.child.kill(signal);
  } catch {
    if (hasObservedExit(handle.child)) return false;
    try { signalled = handle.child.kill(signal); }
    catch { return false; }
  }
  if (!signalled) return false;
  LAST_SIGNAL.set(handle, signal);
  return true;
}

/** Run-scoped authority registry. It can contain only handles minted by spawnOwnedProcess. */
export class OwnedProcessRegistry {
  private readonly handles = new Set<OwnedProcessTree>();

  spawn(command: string, args: readonly string[], options: SpawnOptions = {}): OwnedProcessTree {
    const handle = spawnOwnedProcess(command, args, options);
    this.handles.add(handle);
    return handle;
  }

  isSettled(): boolean {
    for (const handle of this.handles) {
      const live = process.platform === "win32" ? !hasObservedExit(handle.child) : processGroupIsLive(handle.pid);
      if (live) return false;
      this.handles.delete(handle);
    }
    return true;
  }

  terminateAll(signal: NodeJS.Signals = "SIGKILL"): number {
    let signalled = 0;
    for (const handle of this.handles) if (terminateOwnedProcess(handle, signal)) signalled += 1;
    this.isSettled();
    return signalled;
  }
}
