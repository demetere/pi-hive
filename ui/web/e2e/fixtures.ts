import type { Page, Route } from "@playwright/test";

export interface DashboardMock {
  mutations: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }>;
  workflowRequests: string[];
}
interface MockOptions { readonly paginatedTasks?: boolean }

const common = { projectId: "project-1", sessionId: "session-1", workflowId: "custom-delivery", runId: "run-1" };
const resources: Record<string, Array<Record<string, unknown>>> = {
  projects: [{ projectId: "project-1", status: "active" }],
  workflows: [{ ...common, status: "active" }], sessions: [{ ...common, status: "current" }], runs: [{ ...common, status: "waiting_for_human" }],
  nodes: [{ ...common, nodeId: "root", agentId: "coordinator", status: "running" }, { ...common, nodeId: "worker", agentId: "specialist", parentNodeId: "root", status: "waiting" }],
  tasks: [{ ...common, taskId: "task-1", nodeId: "worker", status: "running" }],
  artifacts: [{ ...common, workspaceId: "workspace-1", adapterId: "markdown-plan", profileId: "author", status: "recorded" }],
  questions: [{ ...common, questionId: "question-1", nodeId: "worker", status: "pending" }],
  checkpoints: [{ ...common, approvalId: "approval-1", checkpointId: "review", workspaceId: "workspace-1", status: "pending" }],
  approvals: [{ ...common, approvalId: "approval-1", checkpointId: "review", workspaceId: "workspace-1", status: "pending" }],
  knowledge: [{ ...common, knowledgeUpdateId: "bundle-1", status: "ready" }, { ...common, knowledgeJobId: "job-1", status: "running" }, { ...common, knowledgeProposalId: "proposal-1", knowledgeUpdateId: "update-1", status: "pending" }],
};
const events = [
  { schemaVersion: 1, streamId: `wfs1-${"a".repeat(64)}`, eventId: "evidence-event", eventType: "terminal.recorded", timestamp: "2026-07-20T00:00:00Z", producer: "harness", sequence: 1, refs: ["tool-call-7", `sha256:${"c".repeat(64)}`], dimensions: common },
  { schemaVersion: 1, streamId: `wfs1-${"a".repeat(64)}`, eventId: "model-confirmed", eventType: "budget.model.usage.recorded", timestamp: "2026-07-20T00:00:01Z", producer: "harness", sequence: 2, refs: [], dimensions: { ...common, modelId: "provider/model-a" }, usage: { inputTokens: 11, outputTokens: 3, costMicroUsd: 40, precision: "provider-confirmed" } },
  { schemaVersion: 1, streamId: `wfs1-${"a".repeat(64)}`, eventId: "model-estimated", eventType: "budget.model.usage.recorded", timestamp: "2026-07-20T00:00:02Z", producer: "harness", sequence: 3, refs: [], dimensions: { ...common, modelId: "provider/model-b" }, usage: { inputTokens: 7, outputTokens: 2, costMicroUsd: 20, precision: "estimated" } },
];

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export async function installDashboardMock(page: Page, options: MockOptions = {}): Promise<DashboardMock> {
  const mutations: DashboardMock["mutations"] = []; const workflowRequests: string[] = [];
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
      if (url.pathname !== "/api/v1/stream") return nativeFetch(input, init);
      const bytes = new TextEncoder().encode("event: hello\ndata: {\"apiVersion\":1,\"catchUp\":\"/api/v1/history\"}\n\n");
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); init?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    }) as typeof window.fetch;
  });
  await page.context().route("**/*", async (route) => {
    const request = route.request(); const url = new URL(request.url()); const { pathname, searchParams } = url; const method = request.method();
    if (pathname === "/bootstrap.json") return json(route, { token: "browser-test-token", csrfToken: "csrf-test-token" });
    if (!pathname.startsWith("/api/v1/")) return route.continue();
    workflowRequests.push(`${method} ${pathname}${url.search}`);
    if (method === "POST") {
      const allowed = new Set(["/api/v1/controls/questions/answer", "/api/v1/controls/approvals/decide", "/api/v1/controls/knowledge/decide"]);
      if (!allowed.has(pathname)) return route.abort("failed");
      let body: unknown; try { body = request.postDataJSON(); } catch { body = request.postData(); }
      mutations.push({ method, path: pathname, headers: request.headers(), body });
      return json(route, { apiVersion: 1, result: { ok: true } });
    }
    if (pathname === "/api/v1/usage") return json(route, { apiVersion: 1, usage: { estimated: { inputTokens: 100, outputTokens: 20, costMicroUsd: 3000 }, providerConfirmed: { inputTokens: 90, outputTokens: 18, costMicroUsd: 2700 } } });
    const detail = /^\/api\/v1\/(questions|approvals|knowledge)\/([^/]+)$/u.exec(pathname);
    if (detail?.[1] === "questions") return json(route, { apiVersion: 1, object: { ...common, questionId: detail[2], state: "pending", definition: { prompt: "Continue?", kind: "confirm", required: true } } });
    if (detail?.[1] === "approvals") return json(route, { apiVersion: 1, object: { ...common, requestId: detail[2], requestSequence: 7, digest: `sha256:${"a".repeat(64)}`, requestWorkspaceHash: `sha256:${"b".repeat(64)}` } });
    if (detail?.[1] === "knowledge") return json(route, { apiVersion: 1, object: { ...common, proposalId: detail[2], state: "pending", update: { conclusions: [{ text: "Bounded conclusion" }] } } });
    const match = /^\/api\/v1\/(projects|workflows|sessions|runs|nodes|tasks|artifacts|checkpoints|questions|approvals|knowledge|activity|history)$/u.exec(pathname);
    if (!match) return route.abort("failed");
    const resource = match[1]!;
    if (resource === "tasks" && options.paginatedTasks) {
      const start = Number(searchParams.get("cursor") ?? 0); const items = Array.from({ length: 100 }, (_, offset) => ({ ...common, taskId: `task-${start + offset}`, status: "running" }));
      return json(route, { apiVersion: 1, resource, items, hasMore: true, nextCursor: String(start + 100) });
    }
    const items = resource === "activity" || resource === "history" ? events : resources[resource] ?? [];
    return json(route, { apiVersion: 1, ...(resource === "activity" || resource === "history" ? {} : { resource }), items, hasMore: false });
  });
  return { mutations, workflowRequests };
}

export async function openDashboard(page: Page, options: MockOptions = {}): Promise<DashboardMock> {
  const mock = await installDashboardMock(page, options);
  await page.goto("/");
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await page.locator(".overview-workflow-list").getByText("custom-delivery", { exact: true }).waitFor();
  return mock;
}
