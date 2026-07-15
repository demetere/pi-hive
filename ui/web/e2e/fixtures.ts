import type { Page, Route } from "@playwright/test";

export const SESSION_ID = "session-20260715-abcdef";
export const PROJECT_ID = "project-1";
export const PROJECT_CWD = "/workspace/app";

const now = "2026-07-15T08:00:00.000Z";
const event = (cursor: number, type: string, payload: Record<string, unknown> = {}) => ({
  event_id: `event-${cursor}`,
  cursor,
  ts: new Date(Date.parse(now) + cursor * 1000).toISOString(),
  type,
  session_id: SESSION_ID,
  project_id: PROJECT_ID,
  project_root: PROJECT_CWD,
  project_label: "App Project",
  cwd: PROJECT_CWD,
  actor: "System",
  pid: 1234,
  seq: cursor,
  payload,
});

const initialEvent = event(1, "session_start");
const reconnectEvent = event(2, "assistant_message", { text: "reconnected" });
const snapshot = {
  updated_at: now,
  session_id: SESSION_ID,
  project_id: PROJECT_ID,
  project_root: PROJECT_CWD,
  project_label: "App Project",
  cwd: PROJECT_CWD,
  active_runs: 1,
  topologies: {
    active: "hive",
    hive: {
      orchestrator: { name: "Execution Lead", role: "orchestrator", agentType: "lead", model: "test/model" },
      agents: [{ name: "Builder", role: "member", agentType: "coder", model: "test/model" }],
    },
    planning: {
      orchestrator: { name: "Planning Lead", role: "orchestrator", agentType: "planner", model: "test/model" },
      agents: [{ name: "Spec Author", role: "member", agentType: "planner", model: "test/model" }],
    },
  },
  agents: [
    { name: "Execution Lead", role: "orchestrator", agentType: "lead", model: "test/model", status: "running", inputTokens: 100, outputTokens: 25, costUsd: 0.02 },
    { name: "Builder", role: "member", agentType: "coder", model: "test/model", status: "waiting", inputTokens: 200, outputTokens: 50, costUsd: 0.04, task: "Implement API" },
  ],
};

const sessionSummary = {
  session_id: SESSION_ID,
  project_id: PROJECT_ID,
  project_root: PROJECT_CWD,
  project_label: "App Project",
  cwd: PROJECT_CWD,
  first_ts: now,
  last_ts: now,
  event_count: 12,
  running: 1,
  tokens: 375,
  cacheReadTokens: 50,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  cost: 0.06,
  usageStatus: "verified",
  topologyHash: "topology-hash-1",
};

const planSummary = {
  changeId: "add-auth",
  status: "in-progress",
  completedTasks: 0,
  totalTasks: 2,
  lastModified: now,
  latestVerdict: null,
};

const planDetail = {
  changeId: "add-auth",
  artifacts: [
    { id: "proposal", displayLabel: "Proposal", outputPath: "proposal.md", status: "done", missingDeps: [], reviewOrder: 0 },
    { id: "design", displayLabel: "Design", outputPath: "design.md", status: "ready", missingDeps: [], reviewOrder: 1 },
    { id: "specs", displayLabel: "Specs", outputPath: "specs/**/*.md", status: "blocked", missingDeps: ["proposal"], reviewOrder: 2 },
    { id: "tasks", displayLabel: "Tasks", outputPath: "tasks.md", status: "blocked", missingDeps: ["design", "specs"], reviewOrder: 3 },
  ],
  artifactReview: [{ id: "proposal", authored: true, agentCleared: true, humanVerdict: null, humanReviewReady: true }],
  nextReady: "design",
  files: ["proposal.md"],
  validation: { passed: false, failed: 0, issues: [] },
  readyToExecute: false,
  taskProgress: [],
  verdicts: [],
};

export interface DashboardMock {
  mutations: Array<{ method: string; path: string; body: unknown }>;
}

async function json(route: Route, body: unknown, status = 200, delay = 0): Promise<void> {
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export async function installDashboardMock(page: Page): Promise<DashboardMock> {
  const mutations: DashboardMock["mutations"] = [];
  await page.addInitScript(() => {
    class MockEventSource extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      readyState = MockEventSource.CONNECTING;
      url: string;
      withCredentials = false;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
        (window as any).__eventSources ||= [];
        (window as any).__eventSources.push(this);
        setTimeout(() => this.triggerOpen(), 0);
      }
      triggerOpen() { this.readyState = MockEventSource.OPEN; this.dispatchEvent(new Event("open")); }
      triggerError() { this.readyState = MockEventSource.CONNECTING; this.dispatchEvent(new Event("error")); }
      close() { this.readyState = MockEventSource.CLOSED; }
    }
    Object.defineProperty(window, "EventSource", { value: MockEventSource, configurable: true });
  });

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname, searchParams } = url;
    const method = request.method();
    if (method !== "GET" && method !== "HEAD") {
      let body: unknown = null;
      try { body = request.postDataJSON(); } catch { body = request.postData(); }
      mutations.push({ method, path: `${pathname}${url.search}`, body });
    }

    if (pathname === "/bootstrap.json") return json(route, { token: "browser-test-token", bootCwd: PROJECT_CWD });
    if (pathname === "/events") {
      if (searchParams.has("session")) return json(route, { events: [initialEvent] });
      if (searchParams.has("after")) {
        const after = Number(searchParams.get("after") || 0);
        return after < 2
          ? json(route, { events: [reconnectEvent], nextCursor: 2, highWaterCursor: 2, hasMore: false }, 200, 450)
          : json(route, { events: [], nextCursor: after, highWaterCursor: after, hasMore: false });
      }
      return json(route, { events: [initialEvent], nextCursor: 1, highWaterCursor: 1, hasMore: false });
    }
    if (pathname === "/states") return json(route, { states: [snapshot] });
    if (pathname === "/sessions" && method === "GET") return json(route, { sessions: [sessionSummary] });
    if (pathname.startsWith("/sessions/") && method === "DELETE") return json(route, { ok: true, deleted: 1, sessions: 1 });
    if (pathname === "/delegations") return json(route, { delegations: [] });
    if (pathname === "/models") return json(route, { models: [] });
    if (pathname === "/project-overrides" && method === "GET") return json(route, { overrides: [] });
    if (pathname === "/topologies") return json(route, { topologies: [{ hash: "topology-hash-1", firstSeenAt: now, lastSeenAt: now, sessionCount: 1 }] });
    if (pathname === "/topologies/topology-hash-1") return json(route, { hash: "topology-hash-1", cwd: PROJECT_CWD, firstSeenAt: now, lastSeenAt: now, ...snapshot.topologies });
    if (pathname === "/thinking") return json(route, { thinking: [] });
    if (pathname === "/storage") return json(route, {
      bytes: 4096,
      events: 12,
      sessions: 1,
      database: { logicalBytes: 4096, fileBytes: 8192 },
      sourceLogs: { bytes: 2048, files: 1 },
      prune: { removeBytes: 1024, removeEvents: 3, removeSessions: 0, keepBytes: 3072, keepEvents: 9 },
    });
    if (pathname === "/plans") return json(route, { cwd: PROJECT_CWD, plans: [planSummary] });
    if (pathname === "/plans/add-auth") return json(route, planDetail);
    if (pathname === "/review-sessions" && method === "POST") return json(route, { reviewUrl: "/pl-review/?cap=test", expiresAt: "2026-07-15T09:00:00.000Z" }, 201);
    if (pathname === "/pl-review/") return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Plan review</title><p>Secure review surface</p>" });
    if (pathname === "/prune" && method === "POST") return json(route, { ok: true, events: 3, sessions: 0 });
    if (pathname.startsWith("/projects/") && method === "DELETE") return json(route, { ok: true, sessions: 1 });
    if (pathname.startsWith("/source-logs/projects/") && method === "DELETE") return json(route, { ok: true, files: 1, bytes: 2048 });
    return route.continue();
  });

  return { mutations };
}

export async function openDashboard(page: Page): Promise<DashboardMock> {
  const mock = await installDashboardMock(page);
  await page.goto("/");
  await page.getByText("Connected", { exact: true }).waitFor();
  return mock;
}
