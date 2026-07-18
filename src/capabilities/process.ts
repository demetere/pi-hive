import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const OWNED = new WeakSet<object>();
const TERMINATED = new WeakSet<object>();
export interface OwnedProcessTree { readonly pid: number; readonly child: ChildProcess; readonly startedAt: number }

export function spawnOwnedProcess(command: string, args: readonly string[], options: SpawnOptions = {}): OwnedProcessTree {
  if (!command || !Array.isArray(args) || args.length > 256) throw new Error("OWNED_PROCESS_INPUT_INVALID");
  const child = spawn(command, [...args], { ...options, detached: true });
  if (typeof child.pid !== "number") { try { child.kill(); } catch { /* best effort */ } throw new Error("OWNED_PROCESS_START_FAILED"); }
  const handle = Object.freeze({ pid: child.pid, child, startedAt: Date.now() });
  OWNED.add(handle);
  return handle;
}

/** A numeric PID is never authority: only a live handle minted above can signal its process group. */
export function terminateOwnedProcess(handle: OwnedProcessTree | undefined, signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (!handle || !OWNED.has(handle) || TERMINATED.has(handle) || handle.child.pid !== handle.pid) return false;
  TERMINATED.add(handle);
  try {
    if (process.platform !== "win32") process.kill(-handle.pid, signal);
    else handle.child.kill(signal);
    return true;
  } catch {
    try { return handle.child.kill(signal); } catch { return false; }
  }
}
