import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = server.port; server.stop(true); if (!port) throw new Error("ephemeral port reservation failed"); return port;
}

async function ready(origin: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { const response = await fetch(`${origin}/health`); if (response.ok) return await response.json() as Record<string, unknown>; }
    catch { /* starting */ }
    await sleep(50);
  }
  throw new Error("daemon readiness timed out");
}

test("managed workflow daemon serializes startup, replaces incompatible identity, protects browser traffic, and preserves archives", async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), "pi-hive-daemon-e2e-"));
  const agentDir = join(root, "agent"); const hiveDir = join(agentDir, "hive"); const projectRoot = join(root, "project");
  mkdirSync(hiveDir, { recursive: true, mode: 0o700 }); mkdirSync(projectRoot, { recursive: true });
  const legacyDb = join(hiveDir, "telemetry.db"); const legacyRegistry = join(hiveDir, "telemetry-sessions.jsonl");
  const dbSentinel = Buffer.from([0, 255, 17, 99, 3, 4]); const registrySentinel = Buffer.from("legacy-archive-sentinel\n");
  writeFileSync(legacyDb, dbSentinel); writeFileSync(legacyRegistry, registrySentinel);
  writeFileSync(join(hiveDir, "workflow-daemon-v1.json"), JSON.stringify({ pid: 999999, startupNonce: "stale-pid" }), { mode: 0o600 });

  const oldToken = "o".repeat(64); const origin = `http://127.0.0.1:${port}`;
  writeFileSync(join(hiveDir, "daemon-token"), `${oldToken}\n`, { mode: 0o600 }); chmodSync(join(hiveDir, "daemon-token"), 0o600);
  const incompatible = Bun.spawn(["bun", "src/observability/server/index.ts"], {
    cwd: process.cwd(), stdout: "ignore", stderr: "ignore",
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, HIVE_TELEMETRY_HOST: "127.0.0.1", HIVE_TELEMETRY_PORT: String(port), HIVE_TELEMETRY_TOKEN: oldToken, HIVE_DAEMON_PROTOCOL_VERSION: "999", HIVE_DAEMON_PACKAGE_VERSION: "conflict", HIVE_DAEMON_BUILD_HASH: "conflict", HIVE_DAEMON_STARTUP_NONCE: "incompatible", HIVE_DAEMON_IDLE_TIMEOUT_MS: "60000", HIVE_PROJECT_CWD: projectRoot },
  });
  await ready(origin);

  const priorEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, host: process.env.HIVE_TELEMETRY_HOST, port: process.env.HIVE_TELEMETRY_PORT, noOpen: process.env.HIVE_TELEMETRY_NO_OPEN };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HIVE_TELEMETRY_HOST = "127.0.0.1";
  process.env.HIVE_TELEMETRY_PORT = String(port);
  process.env.HIVE_TELEMETRY_NO_OPEN = "1";
  const service = await import(`../../src/integration/workflow-dashboard-service.ts?daemon=${Date.now()}`);
  const ctx = { cwd: projectRoot, isProjectTrusted: () => true } as never;
  try {
    const starts = await Promise.all([service.startWorkflowDashboard(ctx, false), service.startWorkflowDashboard(ctx, false)]);
    expect(starts).toEqual([origin, origin]);
    await incompatible.exited;
    const health = await ready(origin);
    expect(health.protocolVersion).not.toBe(999);
    expect(health.startupNonce).not.toBe("incompatible");
    const tokenPath = join(hiveDir, "daemon-token");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    const token = readFileSync(tokenPath, "utf8").trim();

    const hostile = await fetch(`${origin}/health`, { headers: { host: `127.0.0.1.${port}.attacker.example` } });
    expect(hostile.status).toBe(403);
    const page = await fetch(`${origin}/`);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const assetName = (await page.text()).match(/\/assets\/[^"']+\.js/u)?.[0];
    if (assetName) expect((await fetch(`${origin}${assetName}`)).headers.get("cache-control")).toContain("immutable");

    const writeHeaders = { authorization: `Bearer ${token}`, origin, "content-type": "application/json", "x-pi-hive-api-version": "1", "x-pi-hive-csrf": token };
    for (const [path, body] of [["/api/v1/maintenance/projection/rebuild", { operationId: "archive-rebuild" }], ["/api/v1/maintenance/projection/prune", { operationId: "archive-prune", cutoff: "2026-01-01T00:00:00.000Z" }]] as const) {
      const response = await fetch(`${origin}${path}`, { method: "POST", headers: writeHeaders, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
    }
    expect(readFileSync(legacyDb)).toEqual(dbSentinel);
    expect(readFileSync(legacyRegistry)).toEqual(registrySentinel);

    const before = Date.now();
    expect(await service.stopWorkflowDashboard()).toBe(true);
    expect(Date.now() - before).toBeLessThan(3_000);
    expect(await service.workflowDashboardAvailable()).toBe(false);
  } finally {
    try { await service.stopWorkflowDashboard(); } catch { /* already stopped */ }
    if (incompatible.exitCode === null) incompatible.kill("SIGKILL");
    await incompatible.exited;
    for (const [key, value] of [["PI_CODING_AGENT_DIR", priorEnv.agentDir], ["HIVE_TELEMETRY_HOST", priorEnv.host], ["HIVE_TELEMETRY_PORT", priorEnv.port], ["HIVE_TELEMETRY_NO_OPEN", priorEnv.noOpen]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
