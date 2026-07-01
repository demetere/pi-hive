#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const extensionRoot = resolve(process.argv[2] || ".");
const port = Number(process.env.HIVE_TELEMETRY_PORT || 43191);
const host = process.env.HIVE_TELEMETRY_HOST || "127.0.0.1";
const url = `http://${host}:${port}`;
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const hiveDir = join(agentDir, "hive");
const pidFile = join(hiveDir, "telemetry-server.json");
const registryPath = process.env.HIVE_TELEMETRY_REGISTRY || join(hiveDir, "telemetry-sessions.jsonl");
const serverPath = join(extensionRoot, "src", "observability", "server", "index.ts");

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function readPidFile() {
  try { return JSON.parse(readFileSync(pidFile, "utf8")); } catch { return null; }
}

function killPid(pid, killed) {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, "SIGTERM");
    killed.add(pid);
  } catch {
    // Process already exited or is not ours.
  }
}

async function isHiveDashboard() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true && body?.mode === "global" && typeof body?.registry === "string" && typeof body?.db === "string";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function stopExistingDashboard() {
  const killed = new Set();
  const info = readPidFile();
  if (Number(info?.port) === port) killPid(Number(info.pid), killed);

  // Only kill a port listener after proving it is pi-hive. This avoids killing
  // unrelated local services that happen to use the configured port.
  if (await isHiveDashboard()) {
    const out = spawnSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (out.status === 0) {
      for (const raw of out.stdout.split("\n")) killPid(Number(raw.trim()), killed);
    }
  }

  if (killed.size) {
    await sleep(300);
    rmSync(pidFile, { force: true });
  }
  return Array.from(killed);
}

async function waitForHealth() {
  for (let i = 0; i < 20; i++) {
    if (await isHiveDashboard()) return true;
    await sleep(100);
  }
  return false;
}

if (!existsSync(serverPath)) {
  console.log(`Skipping dashboard restart: missing ${serverPath}`);
  process.exit(0);
}

const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
if (bun.error || bun.status !== 0) {
  console.log("Skipping dashboard restart: Bun is not available on PATH.");
  process.exit(0);
}

const killed = await stopExistingDashboard();
mkdirSync(hiveDir, { recursive: true });

const proc = spawn("bun", [serverPath], {
  cwd: process.cwd(),
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    HIVE_TELEMETRY_PORT: String(port),
    HIVE_TELEMETRY_HOST: host,
    HIVE_TELEMETRY_REGISTRY: registryPath,
    HIVE_PROJECT_CWD: process.cwd(),
  },
});
proc.unref();

writeFileSync(pidFile, `${JSON.stringify({
  pid: proc.pid,
  host,
  port,
  url,
  cwd: process.cwd(),
  startedAt: new Date().toISOString(),
}, null, 2)}\n`);

const healthy = await waitForHealth();
const stopped = killed.length ? ` (stopped ${killed.length} old process${killed.length === 1 ? "" : "es"})` : "";
console.log(`${healthy ? "Restarted" : "Started"} pi-hive telemetry dashboard: ${url}${stopped}`);
