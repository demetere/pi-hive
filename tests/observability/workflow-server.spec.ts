import { describe, expect, test } from "bun:test";
import type { WorkflowProjectionCurrentRow } from "../../src/observability/projection";
import { createWorkflowApi } from "../../src/observability/server/workflow-routes";

const token = "w".repeat(64);
const origin = "http://127.0.0.1:43191";
const row: WorkflowProjectionCurrentRow = Object.freeze({
  projectId: "project-1", projectRoot: "/project", sessionId: "session-1", workflowId: "build", runId: "run-1",
  eventId: "event-1", eventType: "run.started", timestamp: "2026-01-01T00:00:00.000Z", sequence: 1, status: "running",
});

function request(path: string, init: RequestInit = {}, auth = true): Request {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1:43191");
  if (!headers.has("x-pi-hive-api-version")) headers.set("x-pi-hive-api-version", "1");
  if (auth) headers.set("authorization", `Bearer ${token}`);
  return new Request(`${origin}${path}`, { ...init, headers });
}

function fixture(limits: { maxRequestsPerWindow?: number; rateWindowMs?: number; now?: () => number } = {}) {
  const calls: Array<{ name: string; value: unknown }> = [];
  const operations = new Map<string, { hash: string; result: unknown }>();
  const api = createWorkflowApi({
    token,
    projection: {
      currentPage(query) { calls.push({ name: "current", value: query }); return { items: [row], hasMore: false }; },
      history(query) { calls.push({ name: "history", value: query }); return { items: [], hasMore: false }; },
      usage(query) { calls.push({ name: "usage", value: query }); return { estimated: { inputTokens: 1, outputTokens: 2, costMicroUsd: 3 }, providerConfirmed: { inputTokens: 4, outputTokens: 5, costMicroUsd: 6 } }; },
      status() { return { streams: [], diagnostics: [] }; },
      stream(lastEventId) { calls.push({ name: "stream", value: lastEventId }); return new Response("event: hello\ndata: {\"apiVersion\":1}\n\n", { headers: { "content-type": "text/event-stream" } }); },
      async runOperation(scope, id, hash, invoke) {
        const key = `${scope}\0${id}`;
        const prior = operations.get(key);
        if (prior) {
          if (prior.hash !== hash) throw new Error("operation ID reuse conflict");
          return structuredClone(prior.result) as never;
        }
        const result = await invoke();
        operations.set(key, { hash, result: structuredClone(result) });
        return result;
      },
      close() {},
    },
    ...limits,
    controls: {
      readQuestion(input) { calls.push({ name: "question-detail", value: input }); return { questionId: "question-1", state: "pending", definition: { kind: "confirm", prompt: "Continue?" } }; },
      readCheckpoint(input) { calls.push({ name: "approval-detail", value: input }); return { requestId: "approval-1", digest: `sha256:${"a".repeat(64)}` }; },
      readKnowledge(input) { calls.push({ name: "knowledge-detail", value: input }); return { proposalId: "proposal-1", state: "pending" }; },
      answerQuestion(input) { calls.push({ name: "question", value: input }); return { state: "answered" }; },
      decideCheckpoint(input) { calls.push({ name: "approval", value: input }); return { decision: "approved" }; },
      decideKnowledge(input) { calls.push({ name: "knowledge", value: input }); return { state: "approved" }; },
      rebuildProjection(input) { calls.push({ name: "rebuild", value: input }); return { events: 10, streams: 2 }; },
      pruneProjection(input) { calls.push({ name: "prune", value: input }); return { removed: 8, retained: 2 }; },
      pruneJournal(input) { calls.push({ name: "journal", value: input }); return { deletedEvents: 5 }; },
    },
  });
  return { api, calls };
}

async function handle(api: ReturnType<typeof createWorkflowApi>, path: string, init: RequestInit = {}, auth = true) {
  const req = request(path, init, auth);
  return api.handle(req, new URL(req.url));
}

function write(body: unknown, extra: HeadersInit = {}): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", origin, "x-pi-hive-csrf": token, ...extra }, body: JSON.stringify(body) };
}

describe("workflow dashboard API v1", () => {
  test("protects every read, rejects incompatible clients, and exposes deterministic resource pages", async () => {
    const { api, calls } = fixture();
    expect((await handle(api, "/api/v1/runs", {}, false))?.status).toBe(401);
    expect((await handle(api, "/api/v1/runs", { headers: { "x-pi-hive-api-version": "2" } }))?.status).toBe(426);
    const response = await handle(api, "/api/v1/runs?limit=500&projectId=project-1&sessionId=session-1&runId=run-1&status=running");
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ apiVersion: 1, resource: "runs", items: [row], hasMore: false });
    expect(calls[0].value).toMatchObject({ kind: "runs", limit: 500, projectId: "project-1", sessionId: "session-1", runId: "run-1", status: "running" });
  });

  test("serves an authenticated bounded workflow stream for cursor catch-up", async () => {
    const { api, calls } = fixture();
    expect((await handle(api, "/api/v1/stream", {}, false))?.status).toBe(401);
    const response = await handle(api, "/api/v1/stream", { headers: { "last-event-id": "cursor-1" } });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("text/event-stream");
    expect(calls.at(-1)).toEqual({ name: "stream", value: "cursor-1" });
  });

  test("maps all generic views and bounded activity/usage filters without plan semantics", async () => {
    const { api, calls } = fixture();
    for (const name of ["projects", "workflows", "sessions", "runs", "nodes", "tasks", "artifacts", "checkpoints", "questions", "approvals", "knowledge"]) {
      expect((await handle(api, `/api/v1/${name}?limit=999999`))?.status, name).toBe(400);
      expect((await handle(api, `/api/v1/${name}?limit=1`))?.status, name).toBe(200);
    }
    expect((await handle(api, "/api/v1/activity?limit=2&workflowId=build&eventType=task.started"))?.status).toBe(200);
    expect((await handle(api, "/api/v1/usage?projectId=project-1&workflowId=build&runId=run-1&nodeId=node-1"))?.status).toBe(200);
    expect(calls.find((call) => call.name === "history")?.value).toMatchObject({ workflowId: "build", eventType: "task.started", limit: 2 });
    expect(calls.find((call) => call.name === "usage")?.value).toMatchObject({ projectId: "project-1", workflowId: "build", runId: "run-1", nodeId: "node-1" });
  });

  test("rejects route-specific unsupported, duplicate, excessive, and ambiguous query filters", async () => {
    const { api, calls } = fixture();
    expect((await handle(api, "/api/v1/runs?eventType=run.started"))?.status).toBe(400);
    expect((await handle(api, "/api/v1/projects?nodeId=node-1"))?.status).toBe(400);
    expect((await handle(api, "/api/v1/usage?taskId=task-1"))?.status).toBe(400);
    expect((await handle(api, "/api/v1/runs?runId=one&runId=two"))?.status).toBe(400);
    expect((await handle(api, `/api/v1/runs?${Array.from({ length: 17 }, (_, index) => `status=s${index}`).join("&")}`))?.status).toBe(400);
    expect((await handle(api, `/api/v1/runs?cursor=${"x".repeat(8_193)}`))?.status).toBe(400);
    expect((await handle(api, "/api/v1/tasks?runId=run-1&nodeId=node-1&taskId=task-1"))?.status).toBe(200);
    expect(calls.at(-1)?.value).toMatchObject({ runId: "run-1", nodeId: "node-1", taskId: "task-1" });
  });

  test("reads exact pending control objects from authoritative validators", async () => {
    const { api, calls } = fixture();
    const cases = [
      "/api/v1/questions/question-1?projectId=project-1&sessionId=session-1&runId=run-1",
      "/api/v1/approvals/approval-1?projectId=project-1&sessionId=session-1&runId=run-1",
      "/api/v1/knowledge/proposal-1?projectId=project-1&sessionId=session-1&runId=run-1",
    ];
    for (const path of cases) expect((await handle(api, path))?.status).toBe(200);
    expect((await handle(api, "/api/v1/knowledge/proposal-1?projectId=project-1&sessionId=session-1"))?.status).toBe(400);
    expect(calls.map((call) => call.name)).toEqual(["question-detail", "approval-detail", "knowledge-detail"]);
  });

  test("requires origin, bearer, CSRF, JSON content type, and bounded exact write DTOs", async () => {
    const { api, calls } = fixture();
    const body = { projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "question-1", expectedState: "pending", value: true, operationId: "op-1", claimedIdentity: "local-user" };
    expect((await handle(api, "/api/v1/controls/questions/answer", { ...write(body), headers: { "content-type": "application/json", origin } }))?.status).toBe(403);
    expect((await handle(api, "/api/v1/controls/questions/answer", { ...write(body), headers: { origin, "x-pi-hive-csrf": token, "content-type": "text/plain" } }))?.status).toBe(415);
    expect((await handle(api, "/api/v1/controls/questions/answer", { ...write({ ...body, extra: true }) }))?.status).toBe(400);
    const response = await handle(api, "/api/v1/controls/questions/answer", write(body));
    expect(response?.status).toBe(200);
    expect(calls.at(-1)?.value).toMatchObject({ ...body, credential: token, channel: "dashboard" });
    expect(JSON.stringify(calls)).not.toContain("plan");
  });

  test("routes exact checkpoint and knowledge CAS plus maintenance and journal prune", async () => {
    const { api, calls } = fixture();
    const cases: Array<[string, unknown, string]> = [
      ["/api/v1/controls/approvals/decide", { projectId: "project-1", sessionId: "session-1", runId: "run-1", requestId: "approval-1", expectedRequestSequence: 4, digest: `sha256:${"a".repeat(64)}`, expectedWorkspaceHash: `sha256:${"b".repeat(64)}`, decision: "approved", operationId: "op-a" }, "approval"],
      ["/api/v1/controls/knowledge/decide", { projectId: "project-1", sessionId: "session-1", runId: "run-1", proposalId: "proposal-1", expectedState: "pending", decision: "approve", operationId: "op-k", claimedIdentity: "local-user" }, "knowledge"],
      ["/api/v1/maintenance/projection/rebuild", { operationId: "op-r" }, "rebuild"],
      ["/api/v1/maintenance/projection/prune", { operationId: "op-p", cutoff: "2026-01-01T00:00:00.000Z" }, "prune"],
      ["/api/v1/maintenance/journals/prune", { projectId: "project-1", sessionId: "session-1", operationId: "op-j", confirmIrrecoverable: true }, "journal"],
    ];
    for (const [path, body, call] of cases) {
      const response = await handle(api, path, write(body));
      expect(response?.status, path).toBe(200);
      expect(calls.at(-1)?.name).toBe(call);
    }
    expect((await handle(api, "/api/v1/controls/knowledge/decide", write({ projectId: "project-1", sessionId: "session-1", proposalId: "proposal-1", expectedState: "pending", decision: "approve", operationId: "missing-run", claimedIdentity: "local-user" })))?.status).toBe(400);
  });

  test("streams request bodies with a hard cap and cancels overflow before full allocation", async () => {
    const { api, calls } = fixture();
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(40_000));
        if (pulls > 2) controller.close();
      },
      cancel() { cancelled = true; },
    });
    const response = await handle(api, "/api/v1/controls/questions/answer", {
      method: "POST", duplex: "half", headers: { "content-type": "application/json", origin, "x-pi-hive-csrf": token }, body: stream,
    } as RequestInit);
    expect(response?.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(calls.some((call) => call.name === "question")).toBe(false);
  });

  test("bounds authenticated request rate with deterministic retry metadata", async () => {
    const { api } = fixture({ maxRequestsPerWindow: 2, rateWindowMs: 1_000, now: () => 100 });
    expect((await handle(api, "/api/v1/runs?limit=1"))?.status).toBe(200);
    expect((await handle(api, "/api/v1/runs?limit=1"))?.status).toBe(200);
    const limited = await handle(api, "/api/v1/runs?limit=1");
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("retry-after")).toBe("1");
  });

  test("replays identical operation IDs and rejects conflicting reuse", async () => {
    const { api, calls } = fixture();
    const first = { operationId: "stable-op", cutoff: "2026-01-01T00:00:00.000Z" };
    expect((await handle(api, "/api/v1/maintenance/projection/prune", write(first)))?.status).toBe(200);
    expect((await handle(api, "/api/v1/maintenance/projection/prune", write(first)))?.status).toBe(200);
    expect(calls.filter((call) => call.name === "prune")).toHaveLength(1);
    expect((await handle(api, "/api/v1/maintenance/projection/prune", write({ ...first, cutoff: "2026-02-01T00:00:00.000Z" })))?.status).toBe(409);
  });
});
