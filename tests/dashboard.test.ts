import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  dashboardDbPath,
  dashboardHost,
  dashboardMetadataPath,
  dashboardPort,
  dashboardRegistryPath,
  dashboardUrl,
  daemonTokenPath,
  ensureDashboard,
  stopDashboard,
  type EnsureDeps,
} from "../src/engine/dashboard.ts";
import { daemonIdentity, type DaemonHealth, type DaemonIdentity } from "../src/shared/daemon-protocol.ts";
import type { HiveState } from "../src/core/types.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-hive-dashboard-agent-"));
delete process.env.HIVE_TELEMETRY_REGISTRY;
delete process.env.HIVE_TELEMETRY_DB;
delete process.env.HIVE_TELEMETRY_HOST;
delete process.env.HIVE_TELEMETRY_PORT;
delete process.env.HIVE_TELEMETRY_ALLOW_NON_LOOPBACK;

function state(): HiveState {
  return { session: { sessionId: "s1", sessionDir: "/tmp/s", observabilityLog: "/tmp/s/e", conversationLog: "/tmp/s/c" } } as any;
}
const ctx = { cwd: "/repo/proj", mode: "rpc", hasUI: false } as any;
const ROOT = process.cwd();

function healthy(identity: DaemonIdentity, over: Partial<DaemonHealth> = {}): DaemonHealth {
  return { ok: true, mode: "global", pid: 43210, ...identity, ...over };
}

function deps(over: Partial<EnsureDeps> = {}) {
  const calls = { spawned: 0, opened: 0, stopped: 0 };
  const base: EnsureDeps = {
    probe: async () => null,
    bunAvailable: () => true,
    spawn: (s, _ctx, _root, request) => {
      calls.spawned++;
      (s as any).obsServer = { url: dashboardUrl(), port: request.port, host: request.host, adopted: false, proc: { pid: 43210, killed: false, on() {} } };
      return { ok: true, pid: 43210 };
    },
    waitForReady: async (_host, _port, expected) => healthy(expected),
    stop: async () => { calls.stopped++; return []; },
    withLock: async (_path, fn) => fn(),
    open: () => { calls.opened++; },
    ...over,
  };
  return { deps: base, calls };
}

function installAdoptionToken(): void {
  mkdirSync(join(daemonTokenPath(), ".."), { recursive: true });
  writeFileSync(daemonTokenPath(), "adoption-token\n", { mode: 0o600 });
}

function expectedIdentity(nonce = "existing"): DaemonIdentity {
  return daemonIdentity(ROOT, dashboardRegistryPath(), dashboardDbPath(), nonce);
}

test("adopts only a compatible daemon with matching storage and token", async () => {
  installAdoptionToken();
  const s = state();
  const current = healthy(expectedIdentity());
  const { deps: d, calls } = deps({ probe: async () => current });
  const result = await ensureDashboard(s, ctx, ROOT, {}, d);
  assert.equal(result.adopted, true);
  assert.equal(result.spawned, false);
  assert.equal(calls.spawned, 0);
  assert.equal(s.obsServer?.adopted, true);
  assert.equal(s.obsServer?.proc, undefined);
});

test("spawns, waits for matching readiness, then atomically publishes private metadata", async () => {
  const s = state();
  const { deps: d, calls } = deps();
  const result = await ensureDashboard(s, ctx, ROOT, {}, d);
  assert.equal(result.spawned, true);
  assert.equal(calls.spawned, 1);
  const metadata = JSON.parse(readFileSync(dashboardMetadataPath(), "utf8"));
  assert.equal(metadata.pid, 43210);
  assert.equal(metadata.protocolVersion, expectedIdentity().protocolVersion);
  assert.equal(metadata.registryPath, dashboardRegistryPath());
  assert.ok(metadata.startupNonce);
  assert.match(readFileSync(daemonTokenPath(), "utf8"), /^[a-f0-9]{64}\n$/);
  assert.equal(statSync(dashboardMetadataPath()).mode & 0o777, 0o600);
  assert.equal(statSync(daemonTokenPath()).mode & 0o777, 0o600);
});

test("readiness failure publishes neither token nor PID metadata", async () => {
  const isolated = mkdtempSync(join(tmpdir(), "pi-hive-dashboard-unready-"));
  process.env.HIVE_TELEMETRY_REGISTRY = join(isolated, "registry.jsonl");
  try {
    const { deps: d } = deps({ waitForReady: async () => null });
    const result = await ensureDashboard(state(), ctx, ROOT, {}, d);
    assert.equal(result.running, false);
    assert.match(result.error || "", /health readiness/);
    assert.equal(existsSync(daemonTokenPath()), false);
    assert.equal(existsSync(dashboardMetadataPath()), false);
  } finally {
    delete process.env.HIVE_TELEMETRY_REGISTRY;
  }
});

test("refuses a healthy daemon backed by a different registry", async () => {
  const wrong = healthy({ ...expectedIdentity(), registryPath: "/other/registry.jsonl" });
  const { deps: d, calls } = deps({ probe: async () => wrong });
  const result = await ensureDashboard(state(), ctx, ROOT, {}, d);
  assert.equal(result.running, false);
  assert.match(result.error || "", /different registry or database/);
  assert.equal(calls.spawned, 0);
  assert.equal(calls.stopped, 0);
});

test("restarts a pre-versioned daemon on the same storage after an extension upgrade", async () => {
  const legacy = {
    ok: true as const,
    mode: "global" as const,
    registryPath: dashboardRegistryPath(),
    dbPath: dashboardDbPath(),
  };
  let probeCount = 0;
  const { deps: d, calls } = deps({ probe: async () => probeCount++ === 0 ? legacy : null });
  const result = await ensureDashboard(state(), ctx, ROOT, {}, d);
  assert.equal(result.spawned, true);
  assert.equal(calls.stopped, 1);
  assert.equal(calls.spawned, 1);
});

test("restarts an incompatible package/build daemon on the same storage", async () => {
  const old = healthy({ ...expectedIdentity(), packageVersion: "0.0.0-old" });
  let probeCount = 0;
  const { deps: d, calls } = deps({ probe: async () => probeCount++ === 0 ? old : null });
  const result = await ensureDashboard(state(), ctx, ROOT, {}, d);
  assert.equal(result.spawned, true);
  assert.equal(calls.stopped, 1);
  assert.equal(calls.spawned, 1);
});

test("concurrent startup calls serialize and spawn exactly one daemon", async () => {
  const isolated = mkdtempSync(join(tmpdir(), "pi-hive-dashboard-concurrent-"));
  process.env.HIVE_TELEMETRY_REGISTRY = join(isolated, "registry.jsonl");
  let running: DaemonHealth | null = null;
  let spawns = 0;
  let launchedToken = "";
  const shared: EnsureDeps = {
    probe: async () => running,
    bunAvailable: () => true,
    spawn: (s, _ctx, _root, request) => {
      spawns++;
      launchedToken = request.token;
      (s as any).obsServer = { url: dashboardUrl(), port: request.port, host: request.host, adopted: false, proc: { pid: 50000, killed: false, on() {} } };
      running = healthy(request.identity, { pid: 50000 });
      return { ok: true, pid: 50000 };
    },
    waitForReady: async () => running,
    stop: async () => [],
  };
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => ensureDashboard(state(), ctx, ROOT, {}, shared)));
    assert.equal(spawns, 1);
    assert.equal(results.filter((result) => result.spawned).length, 1);
    assert.equal(results.filter((result) => result.adopted).length, 19);
    assert.equal(new Set(results.map((result) => result.url)).size, 1);
    assert.equal(readFileSync(daemonTokenPath(), "utf8").trim(), launchedToken);
    assert.equal(JSON.parse(readFileSync(dashboardMetadataPath(), "utf8")).startupNonce, running?.startupNonce);
  } finally {
    delete process.env.HIVE_TELEMETRY_REGISTRY;
  }
});

test("is Bun-gated and browser opening remains explicit", async () => {
  const noBun = deps({ bunAvailable: () => false });
  const unavailable = await ensureDashboard(state(), ctx, ROOT, {}, noBun.deps);
  assert.equal(unavailable.bunMissing, true);
  assert.equal(noBun.calls.spawned, 0);

  const auto = deps();
  await ensureDashboard(state(), ctx, ROOT, { open: false }, auto.deps);
  assert.equal(auto.calls.opened, 0);
  const explicit = deps();
  await ensureDashboard(state(), ctx, ROOT, { open: true }, explicit.deps);
  assert.equal(explicit.calls.opened, 1);
});

test("stale PID metadata is never used as process-kill authority", async () => {
  const isolated = mkdtempSync(join(tmpdir(), "pi-hive-dashboard-stale-pid-"));
  process.env.HIVE_TELEMETRY_REGISTRY = join(isolated, "registry.jsonl");
  try {
    mkdirSync(isolated, { recursive: true });
    writeFileSync(dashboardMetadataPath(), JSON.stringify({ pid: 999_999, port: dashboardPort(), startupNonce: "stale" }));
    let shutdownCalls = 0;
    let managedKills = 0;
    const stopped = await stopDashboard(state(), dashboardHost(), dashboardPort(), {
      probe: async () => null,
      requestShutdown: async () => { shutdownCalls++; return true; },
      killManaged: () => { managedKills++; return 999_999; },
      withLock: async (_path, fn) => fn(),
    });
    assert.deepEqual(stopped, []);
    assert.equal(shutdownCalls, 0);
    assert.equal(managedKills, 0);
    assert.equal(existsSync(dashboardMetadataPath()), false);
  } finally {
    delete process.env.HIVE_TELEMETRY_REGISTRY;
  }
});

test("stops an adopted daemon only through token and startup-nonce authentication", async () => {
  installAdoptionToken();
  const current = healthy(expectedIdentity("exact-daemon"), { pid: 54321 });
  let running = true;
  let requestedNonce = "";
  const stopped = await stopDashboard(state(), dashboardHost(), dashboardPort(), {
    probe: async () => running ? current : null,
    requestShutdown: async (_host, _port, health, token) => {
      requestedNonce = health.startupNonce;
      assert.equal(token, "adoption-token");
      running = false;
      return true;
    },
    killManaged: () => { throw new Error("must not signal an adopted process"); },
    withLock: async (_path, fn) => fn(),
  });
  assert.deepEqual(stopped, [54321]);
  assert.equal(requestedNonce, "exact-daemon");
});

test("refuses to stop a daemon belonging to different storage", async () => {
  const other = healthy({ ...expectedIdentity(), registryPath: "/other/registry.jsonl" }, { pid: 65432 });
  let shutdownCalls = 0;
  const stopped = await stopDashboard(state(), dashboardHost(), dashboardPort(), {
    probe: async () => other,
    requestShutdown: async () => { shutdownCalls++; return true; },
    killManaged: () => { throw new Error("must not signal an unowned process"); },
    withLock: async (_path, fn) => fn(),
  });
  assert.deepEqual(stopped, []);
  assert.equal(shutdownCalls, 0);
});

test("host and port validation fail closed; non-loopback requires dangerous opt-in", () => {
  process.env.HIVE_TELEMETRY_PORT = "NaN";
  assert.throws(() => dashboardPort(), /Invalid HIVE_TELEMETRY_PORT/);
  process.env.HIVE_TELEMETRY_PORT = "70000";
  assert.throws(() => dashboardPort(), /Invalid HIVE_TELEMETRY_PORT/);
  delete process.env.HIVE_TELEMETRY_PORT;

  process.env.HIVE_TELEMETRY_HOST = "0.0.0.0";
  assert.throws(() => dashboardHost(), /Refusing non-loopback/);
  process.env.HIVE_TELEMETRY_ALLOW_NON_LOOPBACK = "1";
  assert.equal(dashboardHost(), "0.0.0.0");
  delete process.env.HIVE_TELEMETRY_ALLOW_NON_LOOPBACK;
  process.env.HIVE_TELEMETRY_HOST = "http://evil";
  assert.throws(() => dashboardHost(), /Invalid HIVE_TELEMETRY_HOST/);
  delete process.env.HIVE_TELEMETRY_HOST;
});
