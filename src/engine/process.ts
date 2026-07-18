import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { spawnOwnedProcess, terminateOwnedProcess, type OwnedProcessTree } from "../capabilities/process";

export interface ManagedProcess {
  proc: ChildProcess;
  pid?: number;
  detached: boolean;
  kill(signal?: NodeJS.Signals): boolean;
}

const OWNED_PROCESS_TREES = new WeakMap<ManagedProcess, OwnedProcessTree>();

export function spawnManaged(command: string, args: string[], options: SpawnOptions = {}): ManagedProcess {
  const ownedTree = options.detached === true ? spawnOwnedProcess(command, args, options) : undefined;
  const proc = ownedTree?.child ?? spawn(command, args, options);
  const managed: ManagedProcess = {
    proc,
    pid: proc.pid,
    detached: options.detached === true,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      try { return proc.kill(signal); } catch { return false; }
    },
  };
  if (ownedTree) OWNED_PROCESS_TREES.set(managed, ownedTree);
  if (options.detached) proc.unref();
  return managed;
}

function hasObservedExit(child: ChildProcess): boolean {
  return child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined;
}

export function killProcess(proc: ChildProcess | ManagedProcess | undefined, signal: NodeJS.Signals = "SIGTERM"): number | undefined {
  if (!proc) return undefined;
  const child = "proc" in proc ? proc.proc : proc;
  const pid = typeof child.pid === "number" ? child.pid : undefined;
  if (!hasObservedExit(child)) {
    try { child.kill(signal); } catch { /* noop */ }
  }
  return pid;
}

/** Signal a detached process group only through package-minted owned-process authority. */
export function killProcessTree(
  proc: ChildProcess | ManagedProcess | undefined,
  signal: NodeJS.Signals = "SIGTERM",
  signalProcess: (pid: number, signal: NodeJS.Signals) => boolean = process.kill,
  isProcessGroupLive: (pid: number) => boolean = (pid) => {
    try { process.kill(-pid, 0); return true; } catch { return false; }
  },
): number | undefined {
  if (!proc) return undefined;
  if ("proc" in proc) {
    const child = proc.proc;
    const pid = typeof child.pid === "number" && child.pid > 0 ? child.pid : undefined;
    if (!pid) return undefined;
    const authority = OWNED_PROCESS_TREES.get(proc);
    if (authority && authority.child === child && authority.pid === pid) {
      terminateOwnedProcess(authority, signal, signalProcess, isProcessGroupLive);
    }
    return pid;
  }
  const pid = typeof proc.pid === "number" && proc.pid > 0 ? proc.pid : undefined;
  if (!pid) return undefined;
  if (!hasObservedExit(proc)) {
    try { proc.kill(signal); } catch { /* child already settled */ }
  }
  return pid;
}
