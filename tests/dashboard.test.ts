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
  bunAvailable,
  ensureDashboard,
  isHiveDashboard,
  probeDashboard,
  readDaemonToken,
  requestDaemonShutdown,
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

test("default startup path validates session and server before spawning", async () => {
  assert.equal(bunAvailable(), true);
  const base: EnsureDeps = {
    probe: async () => null,
    stop: async () => [],
    waitForReady: async () => null,
    withLock: async (_path: string, fn: () => Promise<any>) => fn(),
  };
  const noSession = await ensureDashboard({} as any, ctx, ROOT, {}, base);
  assert.match(noSession.error || "", /session not initialized/);
  const missingRoot = mkdtempSync(join(tmpdir(), "pi-hive-dashboard-missing-server-"));
  const missingServer = await ensureDashboard(state(), ctx, missingRoot, {}, base);
  assert.match(missingServer.error || "", /missing observability server/);
});

test("default spawn forwards bounded telemetry settings and is explicitly cleaned up", async () => {
  const isolated = mkdtempSync(join(tmpdir(), "pi-hive-dashboard-real-spawn-"));
  const original = {
    registry: process.env.HIVE_TELEMETRY_REGISTRY,
    port: process.env.HIVE_TELEMETRY_PORT,
  };
  process.env.HIVE_TELEMETRY_REGISTRY = join(isolated, "registry.jsonl");
  process.env.HIVE_TELEMETRY_PORT = String(48_000 + Math.floor(Math.random() * 1_000));
  const s = state();
  s.config = { settings: { telemetry: { retentionDays: 7, maxLogBytes: 123_456, captureThinking: true } } } as any;
  try {
    const result = await ensureDashboard(s, { ...ctx, cwd: isolated }, ROOT, {}, {
      probe: async () => null,
      stop: async () => [],
      waitForReady: async (_host, _port, identity) => healthy(identity, { pid: s.obsServer?.proc?.pid || 1 }),
      withLock: async (_path, fn) => fn(),
    });
    assert.equal(result.spawned, true);
    assert.equal(typeof s.obsServer?.proc?.pid, "number");
  } finally {
    try { s.obsServer?.proc?.kill("SIGTERM"); } catch { /* best effort */ }
    if (original.registry === undefined) delete process.env.HIVE_TELEMETRY_REGISTRY; else process.env.HIVE_TELEMETRY_REGISTRY = original.registry;
    if (original.port === undefined) delete process.env.HIVE_TELEMETRY_PORT; else process.env.HIVE_TELEMETRY_PORT = original.port;
  }
});

test("default readiness polling accepts the exact spawned identity", async () => {
  let identity: DaemonIdentity | undefined;
  const s = state();
  const result = await ensureDashboard(s, ctx, ROOT, {}, {
    probe: async () => identity ? healthy(identity) : null,
    bunAvailable: () => true,
    spawn: (current, _ctx, _root, request) => {
      identity = request.identity;
      current.obsServer = { url: dashboardUrl(), port: request.port, host: request.host, adopted: false };
      return { ok: true, pid: 43210 };
    },
    stop: async () => [],
    withLock: async (_path, fn) => fn(),
  });
  assert.equal(result.running, true);
  assert.equal(result.spawned, true);
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

test("dashboard paths and loopback host normalization honor explicit environment values", () => {
  const original = {
    registry: process.env.HIVE_TELEMETRY_REGISTRY,
    db: process.env.HIVE_TELEMETRY_DB,
    host: process.env.HIVE_TELEMETRY_HOST,
  };
  const isolated = mkdtempSync(join(tmpdir(), "pi-hive-dashboard-paths-"));
  try {
    process.env.HIVE_TELEMETRY_REGISTRY = join(isolated, "custom-registry.jsonl");
    process.env.HIVE_TELEMETRY_DB = join(isolated, "custom.db");
    assert.equal(dashboardRegistryPath(), join(isolated, "custom-registry.jsonl"));
    assert.equal(dashboardDbPath(), join(isolated, "custom.db"));
    for (const [raw, expected] of [["localhost", "localhost"], ["[::1]", "::1"], ["::1", "::1"]]) {
      process.env.HIVE_TELEMETRY_HOST = raw;
      assert.equal(dashboardHost(), expected);
    }
  } finally {
    if (original.registry === undefined) delete process.env.HIVE_TELEMETRY_REGISTRY; else process.env.HIVE_TELEMETRY_REGISTRY = original.registry;
    if (original.db === undefined) delete process.env.HIVE_TELEMETRY_DB; else process.env.HIVE_TELEMETRY_DB = original.db;
    if (original.host === undefined) delete process.env.HIVE_TELEMETRY_HOST; else process.env.HIVE_TELEMETRY_HOST = original.host;
  }
});

test("health probing accepts migration fields and rejects unrelated listeners", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: true, mode: "global", registry: dashboardRegistryPath(), db: dashboardDbPath(),
    }), { status: 200 }) as any;
    assert.deepEqual(await probeDashboard(), {
      ok: true, mode: "global", registry: dashboardRegistryPath(), db: dashboardDbPath(),
      registryPath: dashboardRegistryPath(), dbPath: dashboardDbPath(),
    });
    assert.equal(await isHiveDashboard(), true);

    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: true, mode: "global", registryPath: dashboardRegistryPath(), dbPath: dashboardDbPath(),
      pid: 1, protocolVersion: 1, packageVersion: "x", buildHash: "x", startupNonce: "x",
    })) as any;
    assert.equal((await probeDashboard())?.registryPath, dashboardRegistryPath());
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, mode: "global", registry: dashboardRegistryPath() })) as any;
    assert.equal(await probeDashboard(), null);
    globalThis.fetch = async () => new Response("not json") as any;
    assert.equal(await probeDashboard(), null);

    globalThis.fetch = async () => new Response("no", { status: 503 }) as any;
    assert.equal(await probeDashboard(), null);
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, mode: "other" })) as any;
    assert.equal(await probeDashboard(), null);
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal(await probeDashboard(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticated shutdown validates token, response, and network failures", async () => {
  const originalFetch = globalThis.fetch;
  const health = healthy(expectedIdentity("shutdown"));
  try {
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
      assert.deepEqual(JSON.parse(String(init?.body)), { startupNonce: "shutdown" });
      return new Response(null, { status: 202 });
    };
    assert.equal(await requestDaemonShutdown(dashboardHost(), dashboardPort(), health, ""), false);
    assert.equal(calls, 0);
    assert.equal(await requestDaemonShutdown(dashboardHost(), dashboardPort(), health, "secret"), true);
    globalThis.fetch = async () => new Response(null, { status: 403 });
    assert.equal(await requestDaemonShutdown(dashboardHost(), dashboardPort(), health, "secret"), false);
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal(await requestDaemonShutdown(dashboardHost(), dashboardPort(), health, "secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("startup failures never report a daemon as running", async () => {
  const invalidPort = process.env.HIVE_TELEMETRY_PORT;
  process.env.HIVE_TELEMETRY_PORT = "bad";
  assert.match((await ensureDashboard(state(), ctx, ROOT)).error || "", /Invalid HIVE_TELEMETRY_PORT/);
  if (invalidPort === undefined) delete process.env.HIVE_TELEMETRY_PORT;
  else process.env.HIVE_TELEMETRY_PORT = invalidPort;

  const current = healthy(expectedIdentity());
  const force = deps({ probe: async () => current, stop: async () => [] });
  assert.match((await ensureDashboard(state(), ctx, ROOT, { forceRestart: true }, force.deps)).error || "", /still running/);

  let probes = 0;
  const incompatible = deps({
    probe: async () => (++probes <= 2 ? healthy({ ...expectedIdentity(), packageVersion: "old" }) : null),
    stop: async () => [],
  });
  assert.match((await ensureDashboard(state(), ctx, ROOT, {}, incompatible.deps)).error || "", /Incompatible dashboard is still running/);

  const spawnFailure = deps({ spawn: () => ({ ok: false, error: "spawn denied" }) });
  assert.equal((await ensureDashboard(state(), ctx, ROOT, {}, spawnFailure.deps)).error, "spawn denied");

  const wrongReady = deps({ waitForReady: async (_host, _port, identity) => healthy({ ...identity, startupNonce: "wrong" }) });
  assert.match((await ensureDashboard(state(), ctx, ROOT, {}, wrongReady.deps)).error || "", /identity-checked/);

  const lockFailure = deps({ withLock: async () => { throw new Error("lock denied"); } });
  assert.equal((await ensureDashboard(state(), ctx, ROOT, {}, lockFailure.deps)).error, "lock denied");
});

test("stop falls back only to its live managed child handle", async () => {
  const managed = { pid: 777, killed: false, kill() { this.killed = true; return true; }, on() {} } as any;
  const s = state();
  s.obsServer = { proc: managed, url: dashboardUrl(), port: dashboardPort(), host: dashboardHost(), adopted: false };
  let kills = 0;
  const stopped = await stopDashboard(s, dashboardHost(), dashboardPort(), {
    probe: async () => null,
    killManaged: () => { kills++; return 777; },
    withLock: async (_path, fn) => fn(),
  });
  assert.deepEqual(stopped, [777]);
  assert.equal(kills, 1);
  assert.equal(s.obsServer, undefined);
});

test("managed child fallback requires exact live daemon identity", async () => {
  const health = healthy(expectedIdentity("managed"), { pid: 888 });
  const managed = { pid: 888, killed: false, kill() { this.killed = true; return true; }, on() {} } as any;
  const s = state();
  s.obsServer = { proc: managed, url: dashboardUrl(), port: dashboardPort(), host: dashboardHost(), adopted: false };
  let kills = 0;
  let running = true;
  const stopped = await stopDashboard(s, dashboardHost(), dashboardPort(), {
    probe: async () => running ? health : null,
    requestShutdown: async () => false,
    killManaged: () => { kills++; running = false; return 888; },
    withLock: async (_path, fn) => fn(),
  });
  assert.deepEqual(stopped, [888]);
  assert.equal(kills, 1);

  const alreadyKilled = state();
  alreadyKilled.obsServer = { proc: { ...managed, killed: true }, url: dashboardUrl(), port: dashboardPort(), host: dashboardHost(), adopted: false } as any;
  const none = await stopDashboard(alreadyKilled, dashboardHost(), dashboardPort(), {
    probe: async () => null,
    killManaged: () => { throw new Error("must not kill twice"); },
    withLock: async (_path, fn) => fn(),
  });
  assert.deepEqual(none, []);
});

test("token reads and IPv6 dashboard URLs fail safely", () => {
  const isolated = mkdtempSync(join(tmpdir(), "pi-hive-dashboard-token-"));
  process.env.HIVE_TELEMETRY_REGISTRY = join(isolated, "registry.jsonl");
  try {
    assert.equal(readDaemonToken(), undefined);
    mkdirSync(isolated, { recursive: true });
    writeFileSync(daemonTokenPath(), "\n");
    assert.equal(readDaemonToken(), undefined);
    writeFileSync(daemonTokenPath(), " token \n");
    assert.equal(readDaemonToken(), "token");
    assert.equal(dashboardUrl("::1", 1234), "http://[::1]:1234");
  } finally {
    delete process.env.HIVE_TELEMETRY_REGISTRY;
  }
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
