#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const extensionRoot = resolve(process.argv[2] || ".");
const port = Number(process.env.HIVE_TELEMETRY_PORT || 43191);
const host = process.env.HIVE_TELEMETRY_HOST || "127.0.0.1";
const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
const url = `http://${urlHost}:${port}`;
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const hiveDir = join(agentDir, "hive");
const metadataPath = join(hiveDir, "telemetry-server.json");
const tokenPath = join(hiveDir, "daemon-token");
const registryPath = resolve(process.env.HIVE_TELEMETRY_REGISTRY || join(hiveDir, "telemetry-sessions.jsonl"));
const dbPath = resolve(process.env.HIVE_TELEMETRY_DB || join(hiveDir, "telemetry.db"));
const serverPath = join(extensionRoot, "src", "observability", "server", "index.ts");
const protocolVersion = 1;
const packageVersion = JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8")).version || "unknown";
let buildHash = "unknown";
try { buildHash = readFileSync(join(extensionRoot, "ui", "web", "dist", ".build-hash"), "utf8").trim() || "unknown"; } catch { /* use unknown */ }

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function readToken() {
  try { return readFileSync(tokenPath, "utf8").trim(); } catch { return ""; }
}

async function probe() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.ok === true && body?.mode === "global" ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function stopExistingDashboard() {
  const health = await probe();
  if (!health) return undefined;
  if (resolve(String(health.registryPath || "")) !== registryPath || resolve(String(health.dbPath || "")) !== dbPath) {
    throw new Error("A dashboard using different telemetry storage is running; refusing to stop it.");
  }
  const token = readToken();
  if (!token || typeof health.startupNonce !== "string") {
    throw new Error("A dashboard is running but lacks authenticated shutdown metadata; refusing unsafe PID-based termination.");
  }
  const response = await fetch(`${url}/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: url },
    body: JSON.stringify({ startupNonce: health.startupNonce }),
  });
  if (response.status !== 202) throw new Error(`Dashboard refused authenticated shutdown (HTTP ${response.status}).`);
  for (let i = 0; i < 40; i++) {
    if (!(await probe())) return Number(health.pid) || undefined;
    await sleep(50);
  }
  throw new Error("Dashboard acknowledged shutdown but did not exit.");
}

function atomicPrivateWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

if (!existsSync(serverPath)) {
  console.log(`Skipping dashboard restart: missing ${serverPath}`);
  process.exit(0);
}
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid HIVE_TELEMETRY_PORT: ${port}`);

const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
if (bun.error || bun.status !== 0) {
  console.log("Skipping dashboard restart: Bun is not available on PATH.");
  process.exit(0);
}

const stoppedPid = await stopExistingDashboard();
rmSync(metadataPath, { force: true });
rmSync(tokenPath, { force: true });
mkdirSync(hiveDir, { recursive: true, mode: 0o700 });
chmodSync(hiveDir, 0o700);

const token = (randomUUID() + randomUUID()).replace(/-/g, "");
const startupNonce = randomUUID();
const proc = spawn("bun", [serverPath], {
  cwd: process.cwd(),
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    HIVE_TELEMETRY_PORT: String(port),
    HIVE_TELEMETRY_HOST: host,
    HIVE_TELEMETRY_TOKEN: token,
    HIVE_TELEMETRY_REGISTRY: registryPath,
    HIVE_TELEMETRY_DB: dbPath,
    HIVE_DAEMON_PROTOCOL_VERSION: String(protocolVersion),
    HIVE_DAEMON_PACKAGE_VERSION: packageVersion,
    HIVE_DAEMON_BUILD_HASH: buildHash,
    HIVE_DAEMON_STARTUP_NONCE: startupNonce,
    HIVE_PROJECT_CWD: process.cwd(),
  },
});
proc.unref();

let health = null;
for (let i = 0; i < 70; i++) {
  const candidate = await probe();
  if (candidate?.startupNonce === startupNonce
    && candidate.protocolVersion === protocolVersion
    && candidate.packageVersion === packageVersion
    && candidate.buildHash === buildHash
    && resolve(candidate.registryPath) === registryPath
    && resolve(candidate.dbPath) === dbPath) {
    health = candidate;
    break;
  }
  await sleep(100);
}
if (!health) {
  // This ChildProcess handle identifies the process spawned above; no persisted
  // PID is trusted as termination authority.
  try { proc.kill("SIGTERM"); } catch { /* already exited */ }
  throw new Error("Dashboard failed identity-checked health readiness; no metadata was published.");
}

atomicPrivateWrite(tokenPath, `${token}\n`);
atomicPrivateWrite(metadataPath, `${JSON.stringify({
  pid: health.pid,
  host,
  port,
  url,
  cwd: process.cwd(),
  startedAt: new Date().toISOString(),
  protocolVersion,
  packageVersion,
  buildHash,
  registryPath,
  dbPath,
  startupNonce,
}, null, 2)}\n`);

const stopped = stoppedPid ? ` (stopped authenticated daemon ${stoppedPid})` : "";
console.log(`Restarted pi-hive telemetry dashboard: ${url}${stopped}`);
