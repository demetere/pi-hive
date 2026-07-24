import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function boundedCommand(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], { encoding: "utf8", timeout: 1_000, maxBuffer: 4_096, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C", LANG: "C" } });
  if (result.status !== 0 || result.error || !result.stdout?.trim()) throw new Error(`PROCESS_IDENTITY_PROBE_FAILED: ${command}`);
  return result.stdout.trim();
}
function linuxStartTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fieldsAfterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
  const startTime = fieldsAfterCommand[19];
  if (!startTime || !/^\d+$/u.test(startTime)) throw new Error("PROCESS_IDENTITY_START_TIME_INVALID");
  return startTime;
}
function darwinStartTime(pid: number): string {
  const value = boundedCommand("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
  return Buffer.from(value, "utf8").toString("base64url");
}

export function currentProcessMarker(pid: number, platform: NodeJS.Platform = process.platform): string {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("PROCESS_IDENTITY_PID_INVALID");
  if (platform === "linux") return `linux:pid:${pid}:start:${linuxStartTime(pid)}`;
  if (platform === "darwin") return `darwin:pid:${pid}:lstart:${darwinStartTime(pid)}`;
  throw new Error(`PROCESS_IDENTITY_PLATFORM_UNSUPPORTED: ${platform}`);
}
export function currentBootNonce(platform: NodeJS.Platform = process.platform): string {
  if (platform === "linux") {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!/^[0-9a-f-]{36}$/u.test(value)) throw new Error("PROCESS_IDENTITY_BOOT_INVALID");
    return `linux:boot:${value}`;
  }
  if (platform === "darwin") {
    const value = boundedCommand("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
    const seconds = /\bsec\s*=\s*(\d+)/u.exec(value)?.[1];
    if (!seconds) throw new Error("PROCESS_IDENTITY_BOOT_INVALID");
    return `darwin:boot:${seconds}`;
  }
  throw new Error(`PROCESS_IDENTITY_PLATFORM_UNSUPPORTED: ${platform}`);
}
export function processMarkerMatches(stored: string, pid: number, platform: NodeJS.Platform = process.platform): boolean {
  let current: string;
  try { current = currentProcessMarker(pid, platform); }
  catch { return false; }
  if (stored === current) return true;
  if (stored === `pid:${pid}` || stored === `pi-hive-${pid}`) return true;
  if (platform === "linux") {
    const startTime = current.slice(current.lastIndexOf(":") + 1);
    if (stored === `pid:${pid}:start:${startTime}`) return true;
    return stored.trim().split(/\s+/u).at(-1) === startTime;
  }
  return false;
}
export function bootNonceMatches(stored: string, platform: NodeJS.Platform = process.platform): boolean {
  if (stored === "unknown-boot") return true;
  let current: string;
  try { current = currentBootNonce(platform); }
  catch { return false; }
  if (stored === current) return true;
  return platform === "linux" && stored === current.slice("linux:boot:".length);
}
export function processIdentityIsDead(owner: Readonly<{ pid: number; processMarker: string; bootNonce: string }>, platform: NodeJS.Platform = process.platform): boolean {
  try {
    process.kill(owner.pid, 0);
    return !processMarkerMatches(owner.processMarker, owner.pid, platform) || !bootNonceMatches(owner.bootNonce, platform);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
