import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface ManagedProcess {
  proc: ChildProcess;
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

export function spawnManaged(command: string, args: string[], options: SpawnOptions = {}): ManagedProcess {
  const proc = spawn(command, args, options);
  const managed: ManagedProcess = {
    proc,
    pid: proc.pid,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      try { return proc.kill(signal); } catch { return false; }
    },
  };
  if (options.detached) proc.unref();
  return managed;
}

export function killProcess(proc: ChildProcess | ManagedProcess | undefined, signal: NodeJS.Signals = "SIGTERM"): number | undefined {
  if (!proc) return undefined;
  const child = "proc" in proc ? proc.proc : proc;
  const pid = typeof child.pid === "number" ? child.pid : undefined;
  if (!child.killed) {
    try { child.kill(signal); } catch { /* noop */ }
  }
  return pid;
}
