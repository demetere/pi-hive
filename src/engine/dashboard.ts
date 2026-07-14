import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { HiveState } from "../core/types";
import { withCrossProcessFileLockAsync } from "../core/file-lock";
import { hiveTelemetryRegistryPath } from "./observability";
import { killProcess, spawnManaged } from "./process";
import {
  daemonIdentity,
  isCompatibleDaemon,
  type DaemonHealth,
  type DaemonIdentity,
} from "../shared/daemon-protocol";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 43191;
const READY_TIMEOUT_MS = 7_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function dashboardRegistryPath(): string {
  return resolve(process.env.HIVE_TELEMETRY_REGISTRY || hiveTelemetryRegistryPath());
}

export function dashboardDbPath(): string {
  const base = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return resolve(process.env.HIVE_TELEMETRY_DB || join(base, "hive", "telemetry.db"));
}

export function daemonTokenPath(): string {
  return join(dirname(dashboardRegistryPath()), "daemon-token");
}

export function dashboardMetadataPath(): string {
  return join(dirname(dashboardRegistryPath()), "telemetry-server.json");
}

export function dashboardStartupLockPath(): string {
  return join(dirname(dashboardRegistryPath()), "daemon-startup");
}

function atomicPrivateWrite(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

function mintDaemonToken(): string {
  return (randomUUID() + randomUUID()).replace(/-/g, "");
}

export function readDaemonToken(): string | undefined {
  try { return readFileSync(daemonTokenPath(), "utf8").trim() || undefined; } catch { return undefined; }
}

export function dashboardHost(): string {
  const host = (process.env.HIVE_TELEMETRY_HOST || DEFAULT_HOST).trim();
  if (!host || host.includes("://") || /[\s/?#]/.test(host) || host.length > 253) {
    throw new Error(`Invalid HIVE_TELEMETRY_HOST: ${host || "<empty>"}`);
  }
  const normalized = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const loopback = normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
  if (!loopback && process.env.HIVE_TELEMETRY_ALLOW_NON_LOOPBACK !== "1") {
    throw new Error(`Refusing non-loopback dashboard host "${host}". Set HIVE_TELEMETRY_ALLOW_NON_LOOPBACK=1 only if you accept network exposure.`);
  }
  return normalized;
}

export function dashboardPort(): number {
  const raw = process.env.HIVE_TELEMETRY_PORT || String(DEFAULT_PORT);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid HIVE_TELEMETRY_PORT: ${raw}`);
  return port;
}

export function dashboardUrl(host = dashboardHost(), port = dashboardPort()): string {
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

export interface DashboardPidFile extends Partial<DaemonIdentity> {
  pid?: number;
  host?: string;
  port?: number;
  url?: string;
  cwd?: string;
  startedAt?: string;
}

function readDashboardPidFile(): DashboardPidFile | null {
  try { return JSON.parse(readFileSync(dashboardMetadataPath(), "utf8")) as DashboardPidFile; } catch { return null; }
}

function publishDaemonMetadata(info: DashboardPidFile, token: string): void {
  // Publish credentials and process identity only after the new listener has
  // answered a matching health probe. Both files are atomic and private.
  try {
    atomicPrivateWrite(daemonTokenPath(), `${token}\n`);
    atomicPrivateWrite(dashboardMetadataPath(), `${JSON.stringify(info, null, 2)}\n`);
  } catch (error) {
    try { rmSync(daemonTokenPath(), { force: true }); } catch { /* best effort */ }
    try { rmSync(dashboardMetadataPath(), { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function removeDashboardPidFile(): void {
  try { rmSync(dashboardMetadataPath(), { force: true }); } catch { /* noop */ }
}

function removePublishedDaemonMetadata(): void {
  removeDashboardPidFile();
  try { rmSync(daemonTokenPath(), { force: true }); } catch { /* noop */ }
}

function killPid(pid: number | undefined, killed: Set<number>): void {
  if (!Number.isFinite(pid) || !pid || pid <= 0 || pid === process.pid) return;
  try { process.kill(pid, "SIGTERM"); killed.add(pid); } catch { /* noop */ }
}

export interface DashboardProbe extends Partial<DaemonHealth> {
  ok: true;
  mode: "global";
  registryPath: string;
  dbPath: string;
}

function isCompleteHealth(health: DashboardProbe | null): health is DaemonHealth {
  return Boolean(health && typeof health.pid === "number"
    && typeof health.protocolVersion === "number" && typeof health.packageVersion === "string"
    && typeof health.buildHash === "string" && typeof health.startupNonce === "string");
}

export async function probeDashboard(host = dashboardHost(), port = dashboardPort()): Promise<DashboardProbe | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(`${dashboardUrl(host, port)}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const body = await response.json() as Partial<DaemonHealth> & { registry?: unknown; db?: unknown };
    const registryPath = typeof body.registryPath === "string" ? body.registryPath : typeof body.registry === "string" ? body.registry : "";
    const dbPath = typeof body.dbPath === "string" ? body.dbPath : typeof body.db === "string" ? body.db : "";
    // Accept the immediately-pre-versioned pi-hive health shape so upgrades can
    // identify and replace it. Arbitrary listeners without global mode + exact
    // storage paths are never treated as a daemon.
    if (body.ok !== true || body.mode !== "global" || !registryPath || !dbPath) return null;
    return { ...body, ok: true, mode: "global", registryPath, dbPath };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function isHiveDashboard(host = dashboardHost(), port = dashboardPort()): Promise<boolean> {
  return (await probeDashboard(host, port)) !== null;
}

export function bunAvailable(): boolean {
  try { execFileSync("bun", ["--version"], { stdio: ["ignore", "ignore", "ignore"] }); return true; } catch { return false; }
}

function serverPath(extensionRoot: string): string {
  return resolve(extensionRoot, "src", "observability", "server", "index.ts");
}

interface SpawnRequest { token: string; identity: DaemonIdentity; host: string; port: number }
interface SpawnResult { ok: boolean; pid?: number; error?: string }

function spawnDashboard(state: HiveState, ctx: ExtensionContext, extensionRoot: string, request: SpawnRequest): SpawnResult {
  if (!state.session) return { ok: false, error: "session not initialized" };
  const path = serverPath(extensionRoot);
  if (!existsSync(path)) return { ok: false, error: `missing observability server: ${path}` };
  const { proc } = spawnManaged("bun", [path], {
    cwd: ctx.cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HIVE_TELEMETRY_PORT: String(request.port),
      HIVE_TELEMETRY_HOST: request.host,
      HIVE_TELEMETRY_TOKEN: request.token,
      HIVE_TELEMETRY_REGISTRY: request.identity.registryPath,
      HIVE_TELEMETRY_DB: request.identity.dbPath,
      HIVE_DAEMON_PROTOCOL_VERSION: String(request.identity.protocolVersion),
      HIVE_DAEMON_PACKAGE_VERSION: request.identity.packageVersion,
      HIVE_DAEMON_BUILD_HASH: request.identity.buildHash,
      HIVE_DAEMON_STARTUP_NONCE: request.identity.startupNonce,
      HIVE_TELEMETRY_LOG: state.session.observabilityLog,
      HIVE_CONVERSATION_LOG: state.session.conversationLog,
      HIVE_SESSION_ID: state.session.sessionId,
      HIVE_PROJECT_CWD: ctx.cwd,
    },
  });
  proc.on("error", () => { /* readiness timeout surfaces startup failure */ });
  state.obsServer = { proc, url: dashboardUrl(request.host, request.port), port: request.port, host: request.host, adopted: false };
  return { ok: true, pid: proc.pid };
}

export interface EnsureResult {
  running: boolean;
  url: string;
  adopted: boolean;
  spawned: boolean;
  bunMissing?: boolean;
  error?: string;
}

export interface EnsureDeps {
  probe?: (host: string, port: number) => Promise<DashboardProbe | null>;
  bunAvailable?: () => boolean;
  spawn?: (state: HiveState, ctx: ExtensionContext, extensionRoot: string, request: SpawnRequest) => SpawnResult;
  stop?: (state: HiveState, host: string, port: number) => Promise<number[]>;
  waitForReady?: (host: string, port: number, expected: DaemonIdentity) => Promise<DaemonHealth | null>;
  withLock?: <T>(path: string, fn: () => Promise<T>) => Promise<T>;
  open?: (url: string) => void;
}

async function waitForReady(host: string, port: number, expected: DaemonIdentity, probe = probeDashboard): Promise<DaemonHealth | null> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const health = await probe(host, port);
    if (isCompleteHealth(health) && health.startupNonce === expected.startupNonce && isCompatibleDaemon(health, expected)) return health;
    await sleep(75);
  }
  return null;
}

export async function ensureDashboard(
  state: HiveState,
  ctx: ExtensionContext,
  extensionRoot: string,
  opts: { open?: boolean; forceRestart?: boolean } = {},
  deps: EnsureDeps = {},
): Promise<EnsureResult> {
  let host: string;
  let port: number;
  try {
    host = dashboardHost();
    port = dashboardPort();
  } catch (error: any) {
    return { running: false, url: "", adopted: false, spawned: false, error: error?.message || String(error) };
  }
  const url = dashboardUrl(host, port);
  const registryPath = dashboardRegistryPath();
  const dbPath = dashboardDbPath();
  const expectedBase = daemonIdentity(extensionRoot, registryPath, dbPath, "");
  const probe = deps.probe ?? probeDashboard;
  const hasBun = deps.bunAvailable ?? bunAvailable;
  const doSpawn = deps.spawn ?? spawnDashboard;
  const doStop = deps.stop ?? stopDashboard;
  const ready = deps.waitForReady ?? ((h, p, expected) => waitForReady(h, p, expected, probe));
  const lock = deps.withLock ?? ((path, fn) => withCrossProcessFileLockAsync(path, fn, { timeoutMs: 15_000, staleMs: 30_000 }));
  const doOpen = deps.open ?? ((target: string) => maybeOpen(target, true));

  try {
    const startupLockPath = dashboardStartupLockPath();
    mkdirSync(dirname(startupLockPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(startupLockPath), 0o700);
    return await lock(startupLockPath, async () => {
      let health = await probe(host, port);
      if (opts.forceRestart) {
        await doStop(state, host, port);
        health = null;
      } else if (health) {
        const sameStorage = resolve(health.registryPath) === registryPath && resolve(health.dbPath) === dbPath;
        if (!sameStorage) {
          return { running: false, url, adopted: false, spawned: false, error: `Dashboard on ${url} uses a different registry or database; refusing adoption.` };
        }
        if (isCompleteHealth(health) && isCompatibleDaemon(health, expectedBase) && readDaemonToken()) {
          if (!state.obsServer) state.obsServer = { url, port, host, adopted: true };
          if (opts.open) doOpen(url);
          return { running: true, url, adopted: true, spawned: false };
        }
        // Same storage but an old protocol/package/build: replace it so an
        // extension upgrade cannot silently adopt an incompatible daemon.
        await doStop(state, host, port);
        health = null;
      }

      if (!hasBun()) {
        return { running: false, url, adopted: false, spawned: false, bunMissing: true, error: "Bun is not installed; the dashboard needs Bun." };
      }

      // No verified listener exists. Clear stale credentials/process metadata so
      // this startup publishes nothing until the new nonce answers health.
      removePublishedDaemonMetadata();
      const token = mintDaemonToken();
      const identity = daemonIdentity(extensionRoot, registryPath, dbPath, randomUUID());
      const spawned = doSpawn(state, ctx, extensionRoot, { token, identity, host, port });
      if (!spawned.ok) return { running: false, url, adopted: false, spawned: false, error: spawned.error };
      const readyHealth = await ready(host, port, identity);
      if (!readyHealth || readyHealth.startupNonce !== identity.startupNonce || !isCompatibleDaemon(readyHealth, identity)) {
        if (state.obsServer?.proc) killProcess(state.obsServer.proc);
        state.obsServer = undefined;
        return { running: false, url, adopted: false, spawned: false, error: "Dashboard failed identity-checked health readiness." };
      }
      try {
        publishDaemonMetadata({
          pid: readyHealth.pid,
          host,
          port,
          url,
          cwd: ctx.cwd,
          startedAt: new Date().toISOString(),
          ...identity,
        }, token);
      } catch (error) {
        if (state.obsServer?.proc) killProcess(state.obsServer.proc);
        state.obsServer = undefined;
        throw error;
      }
      if (opts.open) doOpen(url);
      return { running: true, url, adopted: false, spawned: true };
    });
  } catch (error: any) {
    return { running: false, url, adopted: false, spawned: false, error: error?.message || String(error) };
  }
}

function maybeOpen(url: string, open?: boolean): void {
  if (!open || process.env.HIVE_TELEMETRY_NO_OPEN === "1" || process.platform !== "darwin") return;
  try { spawnManaged("open", [url], { detached: true, stdio: "ignore" }); } catch { /* noop */ }
}

// Explicit teardown remains centralized here. Process-identity strengthening and
// authenticated shutdown are handled by the following lifecycle remediation.
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
    } catch { /* no listener */ }
  }
  if (killed.size) {
    await sleep(300);
    removeDashboardPidFile();
  }
  return Array.from(killed);
}
