import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-hive-http-handler-"));
const fallbackProject = join(root, "project");
const fallbackAgentDir = join(root, "agent");
mkdirSync(fallbackProject, { recursive: true });
mkdirSync(fallbackAgentDir, { recursive: true });

// When run alone, keep all state in a temporary tree. In the combined Bun suite,
// reuse whichever config the shared server modules already loaded rather than
// replacing singleton DB/OpenSpec state underneath earlier specs.
const fallbackEnv: Record<string, string> = {
  HIVE_TELEMETRY_HOST: "127.0.0.1",
  HIVE_TELEMETRY_PORT: "43217",
  HIVE_TELEMETRY_TOKEN: "dashboard-handler-test-token",
  HIVE_DAEMON_STARTUP_NONCE: "dashboard-handler-startup",
  HIVE_PROJECT_CWD: fallbackProject,
  HIVE_TELEMETRY_DB: join(root, "telemetry.db"),
  HIVE_TELEMETRY_REGISTRY: join(root, "registry.jsonl"),
  PI_CODING_AGENT_DIR: fallbackAgentDir,
};
for (const [name, value] of Object.entries(fallbackEnv)) process.env[name] ||= value;

let handle: (request: Request) => Promise<Response>;
let origin: string;
let hostHeader: string;
let token: string;
let startupNonce: string;
let project: string;
let activityCount = 0;
let shutdownCount = 0;

function request(path: string, init: RequestInit = {}, authenticated = false): Request {
  const headers = new Headers(init.headers);
  headers.set("host", hostHeader);
  if (authenticated) {
    headers.set("origin", origin);
    headers.set("authorization", `Bearer ${token}`);
  }
  return new Request(`${origin}${path}`, { ...init, headers });
}

async function json(path: string, init: RequestInit = {}, authenticated = false): Promise<{ response: Response; body: any }> {
  const response = await handle(request(path, init, authenticated));
  return { response, body: await response.json() };
}

beforeAll(async () => {
  const config = await import("../src/observability/server/config");
  const { createDashboardHttpHandler } = await import("../src/observability/server/http-handler");
  hostHeader = config.expectedHostHeader();
  origin = `http://${config.HOST.includes(":") ? `[${config.HOST}]` : config.HOST}:${config.PORT}`;
  token = config.DAEMON_TOKEN;
  startupNonce = config.STARTUP_NONCE;
  project = config.PROJECT_CWD;
  handle = createDashboardHttpHandler({
    onActivity: () => { activityCount++; },
    scheduleServerStop: () => { shutdownCount++; },
  });
});

describe("dashboard HTTP handler", () => {
  test("is directly callable without binding a server and records activity", async () => {
    const before = activityCount;
    const { response, body } = await json("/health");
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(activityCount).toBe(before + 1);
  });

  test("rejects missing or alternate Host before routing", async () => {
    const missing = new Request(`${origin}/health`);
    expect((await handle(missing)).status).toBe(403);
    const alternateHost = hostHeader.startsWith("localhost:") ? hostHeader.replace("localhost", "127.0.0.1") : hostHeader.replace(/^\[[^\]]+\]|^[^:]+/, "localhost");
    expect((await handle(new Request(`${origin}/health`, { headers: { host: alternateHost } }))).status).toBe(403);
  });

  test("serves the app shell, static assets, and SPA fallback", async () => {
    const page = await handle(request("/"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");

    const assetName = readdirSync(join(process.cwd(), "ui", "web", "dist", "assets"))[0];
    const asset = await handle(request(`/assets/${assetName}`));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");

    const fallback = await handle(request("/sessions/route-in-the-spa", { headers: { accept: "text/html" } }));
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("content-type")).toContain("text/html");
  });

  test("covers every fleet read route with bounded empty responses", async () => {
    const cases: Array<[string, string, number]> = [
      ["/bootstrap.json", "token", 200],
      ["/health", "ok", 200],
      ["/events?limit=999999", "events", 200],
      ["/delegations?limit=10", "delegations", 200],
      ["/tool-calls?limit=10", "toolCalls", 200],
      ["/states?offset=-2&limit=9999", "states", 200],
      ["/sessions?offset=-2&limit=9999", "sessions", 200],
      ["/storage", "database", 200],
      ["/topologies", "topologies", 200],
      ["/models", "models", 200],
      ["/conversation", "path", 200],
      ["/agent-log?session=missing&agent=worker", "entries", 200],
      ["/thinking", "thinking", 200],
      ["/project-overrides", "overrides", 200],
    ];
    for (const [path, key, status] of cases) {
      const result = await json(path);
      expect(result.response.status, path).toBe(status);
      expect(result.body, path).toHaveProperty(key);
    }

    const states = await json("/states?offset=-2&limit=9999");
    expect(states.body.offset).toBe(0);
    const sessions = await json("/sessions?offset=-2&limit=9999");
    expect(sessions.body.offset).toBe(0);
  });

  test("covers plan and source-log reads without exposing unknown paths", async () => {
    const plans = await json(`/plans?cwd=${encodeURIComponent(project)}`);
    // A project without OpenSpec initialization exercises the translated CLI
    // failure response rather than leaking subprocess details.
    expect([200, 502, 503]).toContain(plans.response.status);
    if (plans.response.ok) expect(plans.body.plans).toEqual([]);
    else expect(plans.body).toHaveProperty("code");

    expect((await handle(request(`/plans/missing?cwd=${encodeURIComponent(project)}`))).status).toBe(404);
    expect((await handle(request(`/plans/missing/file?cwd=${encodeURIComponent(project)}&path=proposal.md`))).status).toBe(404);
    expect((await handle(request("/plans?cwd=%2Funknown"))).status).toBe(200);
    expect((await handle(request("/source-logs/sessions/missing"))).status).toBe(404);
  });

  test("creates and cancels the SSE stream directly", async () => {
    const response = await handle(request("/stream"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: hello");
    await reader.cancel();
  });

  test("requires same-origin bearer authentication for every mutation method", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await handle(request("/not-a-route", { method }))).status, method).toBe(401);
      expect((await handle(request("/not-a-route", { method, headers: { origin: "https://evil.example", authorization: `Bearer ${token}` } }))).status, method).toBe(403);
      expect((await handle(request("/not-a-route", { method }, true))).status, method).toBe(404);
    }
  });

  test("validates mutation bodies and exact shutdown identity", async () => {
    const invalidJson = await handle(request("/prune", { method: "POST", body: "{" }, true));
    expect(invalidJson.status).toBe(400);

    const invalidDays = await json("/prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ olderThanDays: -1 }),
    }, true);
    expect(invalidDays.response.status).toBe(400);

    const unknownProject = await json("/project-overrides", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "missing", label: "Name" }),
    }, true);
    expect(unknownProject.response.status).toBe(404);

    const wrongShutdown = await json("/shutdown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startupNonce: "wrong" }),
    }, true);
    expect(wrongShutdown.response.status).toBe(409);
    expect(shutdownCount).toBe(0);

    const shutdown = await json("/shutdown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startupNonce }),
    }, true);
    expect(shutdown.response.status).toBe(202);
    expect(shutdownCount).toBe(1);
  });

  test("covers delete routes and confirmation checks", async () => {
    const sourceLogs = await json("/source-logs/projects/missing", { method: "DELETE" }, true);
    expect(sourceLogs.response.status).toBe(400);

    const unknownSourceLogs = await json("/source-logs/projects/missing?confirm=delete-source-logs", { method: "DELETE" }, true);
    expect(unknownSourceLogs.response.status).toBe(404);

    const session = await json("/sessions/missing", { method: "DELETE" }, true);
    expect(session.response.status).toBe(200);
    expect(session.body.deleted).toBe(1);

    const projectDelete = await json("/projects/missing", { method: "DELETE" }, true);
    expect(projectDelete.response.status).toBe(200);
    expect(projectDelete.body.sessions).toBe(0);
  });

  test("blocks cross-origin data reads and returns JSON 404s", async () => {
    const hostile = await handle(request("/health", { headers: { origin: "https://evil.example" } }));
    expect(hostile.status).toBe(403);
    const missing = await json("/missing");
    expect(missing.response.status).toBe(404);
    expect(missing.body.error).toBe("not found");
  });
});
