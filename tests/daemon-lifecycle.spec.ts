import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("shutdown requires the bearer token and exact startup nonce", async () => {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port;
  reservation.stop(true);

  const dir = mkdtempSync(join(tmpdir(), "pi-hive-daemon-lifecycle-"));
  const token = "t".repeat(64);
  const startupNonce = "daemon-lifecycle-test";
  const origin = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(["bun", "src/observability/server/index.ts"], {
    cwd: process.cwd(),
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      HIVE_TELEMETRY_PORT: String(port),
      HIVE_TELEMETRY_TOKEN: token,
      HIVE_DAEMON_STARTUP_NONCE: startupNonce,
      HIVE_DAEMON_IDLE_TIMEOUT_MS: "60000",
      HIVE_TELEMETRY_REGISTRY: join(dir, "registry.jsonl"),
      HIVE_TELEMETRY_DB: join(dir, "telemetry.db"),
    },
  });

  const shutdown = (authorization: string | undefined, nonce: string) => fetch(`${origin}/shutdown`, {
    method: "POST",
    headers: {
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify({ startupNonce: nonce }),
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const response = await fetch(`${origin}/health`);
        if (response.ok) { ready = true; break; }
      } catch { /* server is still starting */ }
      await sleep(50);
    }
    expect(ready).toBe(true);
    expect((await shutdown(undefined, startupNonce)).status).toBe(401);
    expect((await shutdown(token, "wrong-daemon")).status).toBe(409);
    expect((await shutdown(token, startupNonce)).status).toBe(202);

    const exitCode = await Promise.race([
      proc.exited,
      sleep(2_000).then(() => null),
    ]);
    expect(exitCode).not.toBeNull();
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await proc.exited;
  }
});
