import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withCrossProcessFileLockAsync } from "../core/file-lock";
import { DAEMON_PROTOCOL_VERSION, dashboardBuildHash, packageVersion } from "../shared/daemon-protocol";

const PORT = (() => {
  const value = Number(process.env.HIVE_TELEMETRY_PORT || "43191");
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error("Invalid workflow dashboard port");
  return value;
})();
export function workflowDashboardHost(): string {
  const raw = (process.env.HIVE_TELEMETRY_HOST || "127.0.0.1").trim().replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(raw)) throw new Error(`Refusing non-loopback dashboard host "${raw}"`);
  return raw;
}
const HOST = workflowDashboardHost();
const READY_MS = 7_000;
const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GLOBAL_DIR = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "hive");
const TOKEN_PATH = join(GLOBAL_DIR, "daemon-token");
const METADATA_PATH = join(GLOBAL_DIR, "workflow-daemon-v1.json");
const LOCK_PATH = join(GLOBAL_DIR, "workflow-daemon-startup");

interface Health { ok: true; mode: "workflow"; pid: number; protocolVersion: number; packageVersion: string; buildHash: string; startupNonce: string }

function url(): string { return `http://${HOST}:${PORT}`; }
function token(): string | undefined { try { return readFileSync(TOKEN_PATH, "utf8").trim() || undefined; } catch { return undefined; } }
function privateWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, content, { flag: "wx", mode: 0o600 }); renameSync(temporary, path); chmodSync(path, 0o600); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}
async function probe(): Promise<Health | undefined> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 700);
  try { const response = await fetch(`${url()}/health`, { signal: controller.signal }); if (!response.ok) return undefined; const value = await response.json() as Health; return value.ok === true && value.mode === "workflow" ? value : undefined; }
  catch { return undefined; } finally { clearTimeout(timer); }
}
function expected() { return { protocolVersion: DAEMON_PROTOCOL_VERSION, packageVersion: packageVersion(EXTENSION_ROOT), buildHash: dashboardBuildHash(EXTENSION_ROOT) }; }
function compatible(health: Health): boolean { const value = expected(); return health.protocolVersion === value.protocolVersion && health.packageVersion === value.packageVersion && health.buildHash === value.buildHash; }
async function requestShutdown(health: Health): Promise<boolean> {
  const credential = token(); if (!credential) return false;
  try { const response = await fetch(`${url()}/shutdown`, { method: "POST", headers: { authorization: `Bearer ${credential}`, origin: url(), "content-type": "application/json" }, body: JSON.stringify({ startupNonce: health.startupNonce }) }); return response.status === 202; }
  catch { return false; }
}
async function stopUnlocked(): Promise<boolean> {
  const health = await probe(); if (!health) { rmSync(METADATA_PATH, { force: true }); return false; }
  if (!await requestShutdown(health)) throw new Error("Dashboard refused authenticated nonce-bound shutdown");
  const deadline = Date.now() + 2_000; while (Date.now() < deadline && await probe()) await new Promise((resolve) => setTimeout(resolve, 50));
  if (await probe()) throw new Error("Dashboard did not stop within the bounded shutdown interval");
  rmSync(METADATA_PATH, { force: true }); rmSync(TOKEN_PATH, { force: true }); return true;
}

export async function workflowDashboardAvailable(): Promise<boolean> { return Boolean(await probe()); }

export async function startWorkflowDashboard(ctx: ExtensionCommandContext, open = true): Promise<string> {
  if (!ctx.isProjectTrusted()) throw new Error("Dashboard startup requires a trusted project");
  mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });
  return withCrossProcessFileLockAsync(LOCK_PATH, async () => {
    const current = await probe();
    if (current && compatible(current) && token()) return url();
    if (current) await stopUnlocked();
    const server = join(EXTENSION_ROOT, "src", "observability", "server", "index.ts");
    if (!existsSync(server)) throw new Error("Workflow dashboard server is missing from the package");
    const credential = (randomUUID() + randomUUID()).replaceAll("-", ""); const startupNonce = randomUUID(); const identity = expected();
    const child = spawn("bun", [server], { cwd: ctx.cwd, detached: true, stdio: "ignore", env: { ...process.env, HIVE_TELEMETRY_HOST: HOST, HIVE_TELEMETRY_PORT: String(PORT), HIVE_TELEMETRY_TOKEN: credential, HIVE_DAEMON_PROTOCOL_VERSION: String(identity.protocolVersion), HIVE_DAEMON_PACKAGE_VERSION: identity.packageVersion, HIVE_DAEMON_BUILD_HASH: identity.buildHash, HIVE_DAEMON_STARTUP_NONCE: startupNonce, HIVE_PROJECT_CWD: ctx.cwd } });
    child.unref();
    const deadline = Date.now() + READY_MS; let ready: Health | undefined;
    while (Date.now() < deadline) { ready = await probe(); if (ready?.startupNonce === startupNonce && compatible(ready)) break; await new Promise((resolve) => setTimeout(resolve, 75)); }
    if (!ready || ready.startupNonce !== startupNonce || !compatible(ready)) throw new Error("Workflow dashboard failed identity-checked readiness");
    privateWrite(TOKEN_PATH, `${credential}\n`); privateWrite(METADATA_PATH, `${JSON.stringify({ ...ready, url: url(), projectRoot: ctx.cwd })}\n`);
    if (open && process.platform === "darwin" && process.env.HIVE_TELEMETRY_NO_OPEN !== "1") spawn("open", [url()], { detached: true, stdio: "ignore" }).unref();
    return url();
  }, { timeoutMs: 15_000, staleMs: 30_000 });
}

export async function stopWorkflowDashboard(): Promise<boolean> {
  mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });
  return withCrossProcessFileLockAsync(LOCK_PATH, stopUnlocked, { timeoutMs: 15_000, staleMs: 30_000 });
}

export async function pruneWorkflowProjection(cutoff: string): Promise<unknown> {
  const credential = token(); if (!credential) throw new Error("Workflow dashboard is not running");
  const response = await fetch(`${url()}/api/v1/maintenance/projection/prune`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "x-pi-hive-api-version": "1", "x-pi-hive-csrf": credential, origin: url(), "content-type": "application/json" }, body: JSON.stringify({ operationId: `command-prune-${randomUUID()}`, cutoff }) });
  const body = await response.json() as { result?: unknown; error?: { message?: string } }; if (!response.ok) throw new Error(body.error?.message || `Projection prune failed (${response.status})`); return body.result;
}
