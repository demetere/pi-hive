import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { HiveState } from "../core/types";
import { hiveTelemetryRegistryPath, hiveTelemetryServerPidPath } from "./observability";
import { killProcess, spawnManaged } from "./process";

// Per-daemon bearer token for dashboard writes (Phase D). Minted at spawn,
// persisted 0600 to the registry dir, and required on every non-GET request.
// Rotated on each restart (new spawn = new token). Local-only binding stays;
// same-origin is kept as belt-and-braces.
export function daemonTokenPath(): string {
  return join(dirname(hiveTelemetryRegistryPath()), "daemon-token");
}

function mintDaemonToken(): string {
  // 256 bits of entropy as hex, without relying on Buffer types (tsconfig sets
  // types:[]). Two v4 UUIDs stripped of dashes = 64 hex chars.
  const token = (randomUUID() + randomUUID()).replace(/-/g, "");
  const path = daemonTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

// A session adopting an already-running daemon reads the token file to reach the
// running daemon (no protocol change needed).
export function readDaemonToken(): string | undefined {
  try { return readFileSync(daemonTokenPath(), "utf8").trim() || undefined; } catch { return undefined; }
}

// Control plane for the telemetry dashboard. The dashboard is a SHARED, GLOBAL
// daemon: one Bun.serve() process reads the machine-wide registry + SQLite under
// ~/.pi/agent/hive/ and serves every project's sessions. So it is started once
// (by the first hive session that finds none running), adopted by later
// sessions, and it SURVIVES an individual session shutdown. This module is the
// single place that decides adopt-vs-spawn so the auto-start hook and the
// /hive-observe command never diverge.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function dashboardHost(): string {
  return process.env.HIVE_TELEMETRY_HOST || "127.0.0.1";
}

export function dashboardPort(): number {
  return Number(process.env.HIVE_TELEMETRY_PORT || 43191);
}

export function dashboardUrl(host = dashboardHost(), port = dashboardPort()): string {
  return `http://${host}:${port}`;
}

type DashboardPidFile = { pid?: number; host?: string; port?: number; url?: string; cwd?: string; startedAt?: string };

function readDashboardPidFile(): DashboardPidFile | null {
  try { return JSON.parse(readFileSync(hiveTelemetryServerPidPath(), "utf8")) as DashboardPidFile; } catch { return null; }
}

function writeDashboardPidFile(info: DashboardPidFile) {
  const path = hiveTelemetryServerPidPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`);
}

function removeDashboardPidFile() {
  try { rmSync(hiveTelemetryServerPidPath(), { force: true }); } catch { /* noop */ }
}

function killPid(pid: number | undefined, killed: Set<number>): void {
  if (!Number.isFinite(pid) || !pid || pid <= 0 || pid === process.pid) return;
  try { process.kill(pid, "SIGTERM"); killed.add(pid); } catch { /* noop */ }
}

// Prove that whatever is listening on host:port is actually a pi-hive dashboard
// (a global-mode server exposing registry+db), not some unrelated local process.
export async function isHiveDashboard(host = dashboardHost(), port = dashboardPort()): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(`${dashboardUrl(host, port)}/health`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: boolean; mode?: string; registry?: string; db?: string };
    return body.ok === true && body.mode === "global" && typeof body.registry === "string" && typeof body.db === "string";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function bunAvailable(): boolean {
  try { execFileSync("bun", ["--version"], { stdio: ["ignore", "ignore", "ignore"] }); return true; } catch { return false; }
}

function serverPath(extensionRoot: string): string {
  return resolve(extensionRoot, "src", "observability", "server", "index.ts");
}

function spawnDashboard(state: HiveState, ctx: ExtensionContext, extensionRoot: string): { ok: boolean; error?: string } {
  if (!state.session) return { ok: false, error: "session not initialized" };
  const path = serverPath(extensionRoot);
  if (!existsSync(path)) return { ok: false, error: `missing observability server: ${path}` };
  const host = dashboardHost();
  const port = dashboardPort();
  const token = mintDaemonToken();
  const { proc } = spawnManaged("bun", [path], {
    cwd: ctx.cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HIVE_TELEMETRY_PORT: String(port),
      HIVE_TELEMETRY_HOST: host,
      HIVE_TELEMETRY_TOKEN: token,
      HIVE_TELEMETRY_LOG: state.session.observabilityLog,
      // Honor an explicit registry override (tests, custom setups); otherwise
      // the machine-wide global registry.
      HIVE_TELEMETRY_REGISTRY: process.env.HIVE_TELEMETRY_REGISTRY || hiveTelemetryRegistryPath(),
      HIVE_CONVERSATION_LOG: state.session.conversationLog,
      HIVE_SESSION_ID: state.session.sessionId,
      HIVE_PROJECT_CWD: ctx.cwd,
    },
  });
  proc.on("error", () => { /* surfaced by caller via ensure result / notify */ });
  state.obsServer = { proc, url: dashboardUrl(host, port), port, host, adopted: false };
  writeDashboardPidFile({ pid: proc.pid, host, port, url: dashboardUrl(host, port), cwd: ctx.cwd, startedAt: new Date().toISOString() });
  return { ok: true };
}

export interface EnsureResult {
  running: boolean;
  url: string;
  adopted: boolean;   // an already-running daemon was reused
  spawned: boolean;   // this call started a new daemon
  bunMissing?: boolean;
  error?: string;
}

// Injectable seams so the adopt/spawn/gate DECISION is unit-testable without
// real processes or sockets. Production passes none of these (the real
// implementations are used).
export interface EnsureDeps {
  isRunning?: (host: string, port: number) => Promise<boolean>;
  bunAvailable?: () => boolean;
  spawn?: (state: HiveState, ctx: ExtensionContext, extensionRoot: string) => { ok: boolean; error?: string };
  open?: (url: string) => void;
}

// Ensure a dashboard daemon is running. If one is already serving (health
// check), ADOPT it (record url/port for the header; no spawn). Otherwise spawn
// one, Bun-gated. forceRestart stops any existing daemon first (used by the
// explicit /hive-observe). open opens a browser tab (only /hive-observe passes
// this; auto-start never does).
export async function ensureDashboard(
  state: HiveState,
  ctx: ExtensionContext,
  extensionRoot: string,
  opts: { open?: boolean; forceRestart?: boolean } = {},
  deps: EnsureDeps = {},
): Promise<EnsureResult> {
  const isRunning = deps.isRunning ?? isHiveDashboard;
  const hasBun = deps.bunAvailable ?? bunAvailable;
  const doSpawn = deps.spawn ?? spawnDashboard;
  const doOpen = deps.open ?? ((url: string) => maybeOpen(url, true));
  const host = dashboardHost();
  const port = dashboardPort();
  const url = dashboardUrl(host, port);

  if (opts.forceRestart) {
    await stopDashboard(state);
  } else if (await isRunning(host, port)) {
    // A daemon is already up — adopt it. Record it for the header even though
    // this session did not spawn it (so it is not ours to kill on shutdown).
    if (!state.obsServer) state.obsServer = { url, port, host, adopted: true };
    if (opts.open) doOpen(url);
    return { running: true, url, adopted: true, spawned: false };
  }

  if (!hasBun()) {
    return { running: false, url, adopted: false, spawned: false, bunMissing: true, error: "Bun is not installed; the dashboard needs Bun." };
  }

  const spawn = doSpawn(state, ctx, extensionRoot);
  if (!spawn.ok) return { running: false, url, adopted: false, spawned: false, error: spawn.error };
  if (opts.open) doOpen(url);
  return { running: true, url, adopted: false, spawned: true };
}

function maybeOpen(url: string, open?: boolean) {
  if (!open) return;
  if (process.env.HIVE_TELEMETRY_NO_OPEN === "1") return;
  if (process.platform !== "darwin") return;
  try { spawnManaged("open", [url], { detached: true, stdio: "ignore" }); } catch { /* noop */ }
}

// Stop the dashboard daemon everywhere: this session's spawned proc (if any),
// the pid-file's process, and any pi-hive listener on the port (proven via
// health check so an unrelated process is never killed). Returns the pids
// stopped. This is the EXPLICIT teardown (/hive-observe-stop, or forceRestart);
// session shutdown must NOT call it — the daemon is shared and survives.
export async function stopDashboard(state: HiveState, host = dashboardHost(), port = dashboardPort()): Promise<number[]> {
  const killed = new Set<number>();

  if (state.obsServer?.proc && !state.obsServer.proc.killed) {
    const pid = killProcess(state.obsServer.proc);
    if (typeof pid === "number") killed.add(pid);
  }
  state.obsServer = undefined;

  const pidFile = readDashboardPidFile();
  if (pidFile?.port === port) killPid(pidFile.pid, killed);

  if (await isHiveDashboard(host, port)) {
    try {
      const out = execFileSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
      for (const raw of out.split("\n")) killPid(Number(raw.trim()), killed);
    } catch { /* lsof exits non-zero when nothing is listening */ }
  }

  if (killed.size) {
    await sleep(300);
    removeDashboardPidFile();
  }
  return Array.from(killed);
}
