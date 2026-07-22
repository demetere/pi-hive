import type { Page, Route } from "@playwright/test";

export const PROJECT_ID = "project-1";
export const SESSION_ID = "session-20260715-abcdef";
export const RUN_ID = "run-1";
export const PROJECT_CWD = "/workspace/app";
const now = "2026-07-15T08:00:00.000Z";

export interface DashboardMock {
  mutations: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }>;
  workflowRequests: string[];
}
interface MockOptions { readonly paginatedTasks?: boolean }

const event = (cursor: number, type: string, payload: Record<string, unknown> = {}) => ({ event_id: `event-${cursor}`, cursor, ts: new Date(Date.parse(now) + cursor * 1000).toISOString(), type, session_id: SESSION_ID, project_id: PROJECT_ID, project_root: PROJECT_CWD, project_label: "App Project", cwd: PROJECT_CWD, actor: "System", pid: 1234, seq: cursor, payload });
const initialEvent = event(1, "session_start");
const snapshot = {
  updated_at: now, session_id: SESSION_ID, project_id: PROJECT_ID, project_root: PROJECT_CWD, project_label: "App Project", cwd: PROJECT_CWD, active_runs: 1,
  topologies: {
    active: "hive",
    hive: { orchestrator: { name: "Execution Lead", role: "orchestrator", agentType: "lead", model: "test/model" }, agents: [{ name: "Builder", role: "member", agentType: "coder", model: "test/model" }] },
    planning: { orchestrator: { name: "Planning Lead", role: "orchestrator", agentType: "planner", model: "test/model" }, agents: [{ name: "Spec Author", role: "member", agentType: "planner", model: "test/model" }] },
  },
  agents: [
    { name: "Execution Lead", role: "orchestrator", agentType: "lead", model: "test/model", status: "running", inputTokens: 100, outputTokens: 25, costUsd: 0.02 },
    { name: "Builder", role: "member", agentType: "coder", model: "test/model", status: "waiting", inputTokens: 200, outputTokens: 50, costUsd: 0.04, task: "Implement API" },
  ],
};
const sessionSummary = { session_id: SESSION_ID, project_id: PROJECT_ID, project_root: PROJECT_CWD, project_label: "App Project", cwd: PROJECT_CWD, first_ts: now, last_ts: now, event_count: 12, running: 1, tokens: 375, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0.06, usageStatus: "verified", topologyHash: "topology-hash-1" };
const planSummary = { changeId: "add-auth", status: "in-progress", completedTasks: 0, totalTasks: 2, lastModified: now, latestVerdict: null };
const planDetail = {
  changeId: "add-auth",
  artifacts: [
    { id: "proposal", displayLabel: "Proposal", outputPath: "proposal.md", status: "done", missingDeps: [], reviewOrder: 0 },
    { id: "design", displayLabel: "Design", outputPath: "design.md", status: "ready", missingDeps: [], reviewOrder: 1 },
    { id: "specs", displayLabel: "Specs", outputPath: "specs/**/*.md", status: "blocked", missingDeps: ["proposal"], reviewOrder: 2 },
    { id: "tasks", displayLabel: "Tasks", outputPath: "tasks.md", status: "blocked", missingDeps: ["design", "specs"], reviewOrder: 3 },
  ],
  artifactReview: [{ id: "proposal", authored: true, agentCleared: true, humanVerdict: null, humanReviewReady: true }], nextReady: "design", files: ["proposal.md"], validation: { passed: false, failed: 0, issues: [] }, readyToExecute: false, taskProgress: [], verdicts: [],
};

const common = { projectId: PROJECT_ID, sessionId: "session-1", workflowId: "custom-delivery", runId: RUN_ID };
const workflowResources: Record<string, Array<Record<string, unknown>>> = {
  projects: [{ projectId: PROJECT_ID, status: "active" }], workflows: [{ ...common, status: "active" }], sessions: [{ ...common, status: "current" }], runs: [{ ...common, status: "waiting_for_human" }],
  nodes: [{ ...common, nodeId: "root", agentId: "coordinator", status: "running" }, { ...common, nodeId: "worker", agentId: "specialist", parentNodeId: "root", status: "waiting" }],
  tasks: [{ ...common, taskId: "task-1", nodeId: "worker", status: "running" }], artifacts: [{ ...common, workspaceId: "workspace-1", adapterId: "markdown-plan", profileId: "author", status: "recorded" }],
  questions: [{ ...common, questionId: "question-1", nodeId: "worker", status: "pending" }], checkpoints: [{ ...common, approvalId: "approval-1", checkpointId: "review", workspaceId: "workspace-1", status: "pending" }], approvals: [{ ...common, approvalId: "approval-1", checkpointId: "review", workspaceId: "workspace-1", status: "pending" }],
  knowledge: [{ ...common, knowledgeUpdateId: "bundle-1", status: "ready" }, { ...common, knowledgeJobId: "job-1", status: "running" }, { ...common, knowledgeProposalId: "proposal-1", knowledgeUpdateId: "update-1", status: "pending" }, { ...common, status: "unknown" }],
};
const workflowEvents = [
  { schemaVersion: 1, streamId: `wfs1-${"a".repeat(64)}`, eventId: "evidence-event", eventType: "terminal.recorded", timestamp: "2026-07-20T00:00:00Z", producer: "harness", sequence: 1, refs: ["tool-call-7", `sha256:${"c".repeat(64)}`], dimensions: common },
  { schemaVersion: 1, streamId: `wfs1-${"a".repeat(64)}`, eventId: "model-confirmed", eventType: "budget.model.usage.recorded", timestamp: "2026-07-20T00:00:01Z", producer: "harness", sequence: 2, refs: [], dimensions: { ...common, modelId: "provider/model-a" }, usage: { inputTokens: 11, outputTokens: 3, costMicroUsd: 40, precision: "provider-confirmed" } },
  { schemaVersion: 1, streamId: `wfs1-${"a".repeat(64)}`, eventId: "model-estimated", eventType: "budget.model.usage.recorded", timestamp: "2026-07-20T00:00:02Z", producer: "harness", sequence: 3, refs: [], dimensions: { ...common, modelId: "provider/model-b" }, usage: { inputTokens: 7, outputTokens: 2, costMicroUsd: 20, precision: "estimated" } },
];

async function json(route: Route, body: unknown, status = 200, delay = 0): Promise<void> { if (delay) await new Promise((resolve) => setTimeout(resolve, delay)); await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function rejectUnknown(route: Route, message: string): Promise<never> { await route.abort("failed"); throw new Error(message); }

export async function installDashboardMock(page: Page, options: MockOptions = {}): Promise<DashboardMock> {
  const mutations: DashboardMock["mutations"] = []; const workflowRequests: string[] = [];
  await page.addInitScript(() => {
    class MockEventSource extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2; readyState = MockEventSource.CONNECTING; url: string; withCredentials = false;
      constructor(url: string | URL) { super(); this.url = String(url); (window as any).__eventSources ||= []; (window as any).__eventSources.push(this); setTimeout(() => this.triggerOpen(), 0); }
      triggerOpen() { this.readyState = MockEventSource.OPEN; this.dispatchEvent(new Event("open")); }
      triggerError() { this.readyState = MockEventSource.CONNECTING; this.dispatchEvent(new Event("error")); }
      close() { this.readyState = MockEventSource.CLOSED; }
    }
    Object.defineProperty(window, "EventSource", { value: MockEventSource, configurable: true });
    const nativeFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
      if (url.pathname === "/thinking") return Promise.resolve(new Response(JSON.stringify({ thinking: [] }), { status: 200, headers: { "content-type": "application/json" } }));
      if (url.pathname === "/delegations") return Promise.resolve(new Response(JSON.stringify({ delegations: [] }), { status: 200, headers: { "content-type": "application/json" } }));
      if (url.pathname === "/storage") return Promise.resolve(new Response(JSON.stringify({ bytes: 4096, events: 12, sessions: 1, database: { logicalBytes: 4096, fileBytes: 8192 }, sourceLogs: { bytes: 2048, files: 1 }, prune: { removeBytes: 1024, removeEvents: 3, removeSessions: 0, keepBytes: 3072, keepEvents: 9 } }), { status: 200, headers: { "content-type": "application/json" } }));
      if (["/api/v1/questions", "/api/v1/approvals", "/api/v1/knowledge"].includes(url.pathname)) {
        const common = { projectId: "project-1", sessionId: "session-1", workflowId: "custom-delivery", runId: "run-1" };
        const resource = url.pathname.slice("/api/v1/".length);
        const items = resource === "questions" ? [{ ...common, questionId: "question-1", nodeId: "worker", status: "pending" }]
          : resource === "approvals" ? [{ ...common, approvalId: "approval-1", checkpointId: "review", workspaceId: "workspace-1", status: "pending" }]
            : [{ ...common, knowledgeUpdateId: "bundle-1", status: "ready" }, { ...common, knowledgeJobId: "job-1", status: "running" }, { ...common, knowledgeProposalId: "proposal-1", knowledgeUpdateId: "update-1", status: "pending" }, { ...common, status: "unknown" }];
        return Promise.resolve(new Response(JSON.stringify({ apiVersion: 1, resource, items, hasMore: false }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      const detail = /^\/api\/v1\/(questions|approvals|knowledge)\/([^/]+)$/u.exec(url.pathname);
      if (detail) {
        const common = { projectId: "project-1", sessionId: "session-1", workflowId: "custom-delivery", runId: "run-1" };
        const object = detail[1] === "questions" ? { ...common, questionId: detail[2], state: "pending", definition: { prompt: "Not rendered", kind: "confirm", required: true } }
          : detail[1] === "approvals" ? { ...common, requestId: detail[2], requestSequence: 7, digest: `sha256:${"a".repeat(64)}`, requestWorkspaceHash: `sha256:${"b".repeat(64)}` }
            : { ...common, proposalId: detail[2], state: "pending", update: { conclusions: [{ text: "Not rendered" }] } };
        return Promise.resolve(new Response(JSON.stringify({ apiVersion: 1, object }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      if (url.pathname !== "/api/v1/stream") return nativeFetch(input, init);
      const encoder = new TextEncoder();
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("event: hello\ndata: {\"apiVersion\":1,\"catchUp\":\"/api/v1/history\"}\n\n"));
          init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    }) as typeof window.fetch;
  });
  // Context routing remains active for iframe requests and in-flight refreshes
  // while an individual Page is closing; no API request may fall through Vite.
  await page.context().route("**/*", async (route) => {
    const request = route.request(); const url = new URL(request.url()); const { pathname, searchParams } = url; const method = request.method();
    if (pathname === "/bootstrap.json") return json(route, { token: "browser-test-token", csrfToken: "csrf-test-token", bootCwd: PROJECT_CWD });

    if (pathname.startsWith("/api/v1/")) {
      workflowRequests.push(`${method} ${pathname}${url.search}`);
      if (method === "POST") {
        const allowed = new Set(["/api/v1/controls/questions/answer", "/api/v1/controls/approvals/decide", "/api/v1/controls/knowledge/decide"]);
        if (!allowed.has(pathname)) return rejectUnknown(route, `Unexpected workflow POST ${pathname}`);
        let body: unknown; try { body = request.postDataJSON(); } catch { body = request.postData(); }
        mutations.push({ method, path: pathname, headers: request.headers(), body }); return json(route, { apiVersion: 1, result: { ok: true } });
      }
      if (method !== "GET" && method !== "HEAD") return rejectUnknown(route, `Unexpected workflow method ${method} ${pathname}`);
      if (pathname === "/api/v1/stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: hello\ndata: {\"apiVersion\":1,\"catchUp\":\"/api/v1/history\"}\n\n" });
      if (pathname === "/api/v1/usage") return json(route, { apiVersion: 1, usage: { estimated: { inputTokens: 100, outputTokens: 20, costMicroUsd: 3000 }, providerConfirmed: { inputTokens: 90, outputTokens: 18, costMicroUsd: 2700 } } });
      const detail = /^\/api\/v1\/(questions|approvals|knowledge)\/([^/]+)$/u.exec(pathname);
      if (detail?.[1] === "questions") return json(route, { apiVersion: 1, object: { ...common, questionId: detail[2], state: "pending", definition: { prompt: "Not rendered", kind: "confirm", required: true } } });
      if (detail?.[1] === "approvals") return json(route, { apiVersion: 1, object: { ...common, requestId: detail[2], requestSequence: 7, digest: `sha256:${"a".repeat(64)}`, requestWorkspaceHash: `sha256:${"b".repeat(64)}` } });
      if (detail?.[1] === "knowledge") return json(route, { apiVersion: 1, object: { ...common, proposalId: detail[2], state: "pending", update: { conclusions: [{ text: "Not rendered" }] } } });
      const match = /^\/api\/v1\/(projects|workflows|sessions|runs|nodes|tasks|artifacts|checkpoints|questions|approvals|knowledge|activity|history)$/u.exec(pathname);
      if (!match) return rejectUnknown(route, `Unknown workflow API route ${pathname}`);
      const resource = match[1]!;
      if (resource === "tasks" && options.paginatedTasks) {
        const start = Number(searchParams.get("cursor") ?? 0); const items = Array.from({ length: 100 }, (_, offset) => ({ ...common, taskId: `task-${start + offset}`, status: "running" }));
        return json(route, { apiVersion: 1, resource, items, hasMore: true, nextCursor: String(start + 100) });
      }
      const items = resource === "activity" || resource === "history" ? workflowEvents : workflowResources[resource] ?? [];
      return json(route, { apiVersion: 1, ...(resource === "activity" || resource === "history" ? {} : { resource }), items, hasMore: false });
    }

    if (method !== "GET" && method !== "HEAD") {
      const allowed = method === "DELETE" && (pathname.startsWith("/sessions/") || pathname.startsWith("/projects/") || pathname.startsWith("/source-logs/projects/"))
        || method === "POST" && ["/review-sessions", "/prune"].includes(pathname);
      if (!allowed) return rejectUnknown(route, `Unexpected legacy mutation ${method} ${pathname}`);
      let body: unknown = null; try { body = request.postDataJSON(); } catch { body = request.postData(); }
      mutations.push({ method, path: pathname, headers: request.headers(), body });
    }
    if (pathname === "/events") {
      if (searchParams.has("session")) return json(route, { events: [initialEvent] });
      if (searchParams.has("after")) { const after = Number(searchParams.get("after") || 0); return after < 2 ? json(route, { events: [event(2, "assistant_message", { text: "reconnected" })], nextCursor: 2, highWaterCursor: 2, hasMore: false }, 200, 450) : json(route, { events: [], nextCursor: after, highWaterCursor: after, hasMore: false }); }
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
    if (pathname === "/storage") return json(route, { bytes: 4096, events: 12, sessions: 1, database: { logicalBytes: 4096, fileBytes: 8192 }, sourceLogs: { bytes: 2048, files: 1 }, prune: { removeBytes: 1024, removeEvents: 3, removeSessions: 0, keepBytes: 3072, keepEvents: 9 } });
    if (pathname === "/plans") return json(route, { cwd: PROJECT_CWD, plans: [planSummary] });
    if (pathname === "/plans/add-auth") return json(route, planDetail);
    if (pathname === "/review-sessions" && method === "POST") return json(route, { reviewUrl: "/pl-review/?cap=test", expiresAt: "2026-07-15T09:00:00.000Z" }, 201);
    if (pathname === "/pl-review/") return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Plan review</title><p>Secure review surface</p>" });
    if (pathname === "/prune" && method === "POST") return json(route, { ok: true, events: 3, sessions: 0 });
    if (pathname.startsWith("/projects/") && method === "DELETE") return json(route, { ok: true, sessions: 1 });
    if (pathname.startsWith("/source-logs/projects/") && method === "DELETE") return json(route, { ok: true, files: 1, bytes: 2048 });
    const looksLikeApi = ["/events", "/states", "/sessions", "/delegations", "/models", "/project-overrides", "/topologies", "/thinking", "/storage", "/plans", "/review-sessions", "/prune"].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
    if (looksLikeApi) return rejectUnknown(route, `Unknown legacy API route ${method} ${pathname}`);
    return route.continue();
  });
  return { mutations, workflowRequests };
}

export async function openDashboard(page: Page, options: MockOptions = {}): Promise<DashboardMock> {
  const mock = await installDashboardMock(page, options); await page.goto("/"); await page.getByText("Connected", { exact: true }).waitFor(); return mock;
}
export async function openWorkflowDashboard(page: Page, options: MockOptions = {}): Promise<DashboardMock> {
  const mock = await openDashboard(page, options); await page.getByRole("button", { name: "Workflows", exact: true }).click(); await page.getByRole("heading", { name: "Workflows", exact: true }).waitFor(); await page.getByRole("heading", { name: "custom-delivery" }).waitFor(); return mock;
}
