import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorkflowDashboard from "./workflow-dashboard";

type Json = Record<string, unknown>;
const page = (resource: string, items: unknown[], nextCursor?: string) => ({ apiVersion: 1, resource, items, ...(nextCursor ? { nextCursor } : {}), hasMore: Boolean(nextCursor) });

function responseFor(resource: string): Json {
  const common = { projectId: "project-1", sessionId: "session-1", workflowId: "custom-delivery", runId: "run-1" };
  if (resource === "activity" || resource === "history") return { apiVersion: 1, items: [
    { eventId: "evidence-event", eventType: "terminal.recorded", timestamp: "2026-01-01T00:00:00Z", producer: "harness", sequence: 1, refs: ["tool-call-7", `sha256:${"a".repeat(64)}`], dimensions: { ...common, modelId: "provider/model-a" } },
    { eventId: "plain-event", eventType: "run.started", timestamp: "2026-01-01T00:00:01Z", producer: "runtime", sequence: 2, refs: [], dimensions: common },
    { eventId: "model-a-confirmed", eventType: "budget.model.usage.recorded", timestamp: "2026-01-01T00:00:02Z", producer: "harness", sequence: 3, refs: [], dimensions: { ...common, modelId: "provider/model-a" }, usage: { inputTokens: 11, outputTokens: 3, costMicroUsd: 40, precision: "provider-confirmed" } },
    { eventId: "model-b-estimated", eventType: "budget.model.usage.recorded", timestamp: "2026-01-01T00:00:03Z", producer: "harness", sequence: 4, refs: [], dimensions: { ...common, modelId: "provider/model-b" }, usage: { inputTokens: 7, outputTokens: 2, costMicroUsd: 20, precision: "estimated" } },
  ], hasMore: false };
  const values: Record<string, unknown[]> = {
    projects: [{ projectId: "project-1", status: "active", projectRoot: "/must/not/render" }],
    workflows: [{ ...common, name: "Custom Delivery", description: "must-not-render-description", status: "active" }],
    sessions: [{ ...common, status: "current", activationHash: "secret-activation" }],
    runs: [{ ...common, status: "waiting_for_human" }],
    nodes: [{ ...common, nodeId: "root", parentNodeId: null, agentId: "coordinator", status: "running" }, { ...common, nodeId: "worker", parentNodeId: "root", agentId: "specialist", status: "waiting" }],
    tasks: [{ ...common, taskId: "task-1", nodeId: "worker", status: "running" }],
    artifacts: [{ ...common, workspaceId: "workspace-1", adapterId: "markdown-plan", status: "recorded", path: "/secret/workspace", content: "LEAK-CONTENT" }],
    checkpoints: [{ ...common, approvalId: "request-1", checkpointId: "review", status: "pending" }],
    questions: [{ ...common, questionId: "question-1", nodeId: "worker", status: "pending", prompt: "LEAK-PROMPT", raw: "LEAK-RAW", token: "LEAK-TOKEN" }],
    approvals: [{ ...common, approvalId: "request-1", checkpointId: "review", status: "pending" }],
    knowledge: [
      { ...common, knowledgeUpdateId: "bundle-1", status: "ready" },
      { ...common, knowledgeJobId: "job-1", status: "running", content: "LEAK-KNOWLEDGE", secret: "LEAK-SECRET" },
      { ...common, knowledgeProposalId: "proposal-1", knowledgeUpdateId: "update-1", status: "pending" },
      { ...common, status: "unknown" },
    ],
  };
  return page(resource, values[resource] ?? []);
}

function installFetch(options: { apiVersion?: number | undefined; streamFrames?: string[]; questionDefinition?: Json; postFailure?: { status: number; message: string } } = {}) {
  const frames = options.streamFrames ?? ["event: hello\ndata: {\"apiVersion\":1}\n\n"];
  let streamIndex = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url === "/bootstrap.json") return new Response(JSON.stringify({ token: "token", csrfToken: "csrf" }), { status: 200 });
    if (url.includes("/api/v1/stream")) return new Response(frames[Math.min(streamIndex++, frames.length - 1)], { status: 200, headers: { "content-type": "text/event-stream" } });
    if (init?.method === "POST") return options.postFailure
      ? new Response(JSON.stringify({ apiVersion: 1, error: { code: "CAS_CONFLICT", message: options.postFailure.message } }), { status: options.postFailure.status })
      : new Response(JSON.stringify({ apiVersion: 1, result: { ok: true } }), { status: 200 });
    if (url.includes("/api/v1/questions/question-1?")) return new Response(JSON.stringify({ apiVersion: 1, object: { questionId: "question-1", projectId: "project-1", sessionId: "session-1", runId: "run-1", state: "pending", definition: options.questionDefinition ?? { prompt: "LEAK-DETAIL-PROMPT", kind: "confirm", required: true } } }), { status: 200 });
    if (url.includes("/api/v1/approvals/request-1?")) return new Response(JSON.stringify({ apiVersion: 1, object: { requestId: "request-1", projectId: "project-1", sessionId: "session-1", runId: "run-1", requestSequence: 7, digest: `sha256:${"a".repeat(64)}`, requestWorkspaceHash: `sha256:${"b".repeat(64)}` } }), { status: 200 });
    if (url.includes("/api/v1/knowledge/proposal-1?")) return new Response(JSON.stringify({ apiVersion: 1, object: { proposalId: "proposal-1", projectId: "project-1", sessionId: "session-1", runId: "run-1", state: "pending", update: { conclusions: [{ text: "LEAK-DETAIL-CONTENT" }] } } }), { status: 200 });
    if (url.includes("/api/v1/usage")) return new Response(JSON.stringify({ apiVersion: 1, usage: { estimated: { inputTokens: 10, outputTokens: 2, costMicroUsd: 30 }, providerConfirmed: { inputTokens: 4, outputTokens: 1, costMicroUsd: 20 } } }), { status: 200 });
    const resource = url.split("/api/v1/")[1]?.split(/[?]/u)[0] ?? "projects";
    const body = responseFor(resource);
    if ("apiVersion" in options) body.apiVersion = options.apiVersion;
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  return calls;
}

describe("workflow dashboard API v1 client", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("uses only exact W25 read paths, including nodes, artifacts, and the usage object", async () => {
    const calls = installFetch(); const user = userEvent.setup();
    render(<WorkflowDashboard />);
    expect(await screen.findByRole("heading", { name: "Workflows" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Topology" }));
    const topology = await screen.findByRole("region", { name: "Topology hierarchy" });
    expect(topology.querySelector("[role='tree'], [role='treeitem']")).toBeNull();
    expect(topology.querySelectorAll("ul")).toHaveLength(2);
    expect(topology.querySelectorAll("li")).toHaveLength(2);
    expect(topology).toHaveTextContent(/root.*worker/s);
    await user.click(screen.getByRole("button", { name: "Artifacts" }));
    expect(await screen.findByRole("heading", { name: "workspace-1" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Usage" }));
    expect(await screen.findByText("provider confirmed input tokens")).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes("/api/v1/nodes?"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/api/v1/artifacts?"))).toBe(true);
    expect(calls.some((call) => call.url === "/api/v1/usage")).toBe(true);
    expect(calls.some((call) => call.url.includes("/api/v1/tree"))).toBe(false);
  });

  it("fails closed when a JSON response omits or changes apiVersion", async () => {
    installFetch({ apiVersion: undefined }); render(<WorkflowDashboard />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/API version/i);
  });

  it("never generic-renders sensitive or unknown API scalar fields", async () => {
    installFetch(); const user = userEvent.setup(); render(<WorkflowDashboard />);
    const views: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["Workflows", ["must-not-render-description", "secret-activation"]],
      ["Questions", ["LEAK-PROMPT", "LEAK-RAW", "LEAK-TOKEN", "LEAK-DETAIL-PROMPT"]],
      ["Artifacts", ["LEAK-CONTENT", "/secret/workspace"]],
      ["Knowledge jobs", ["LEAK-KNOWLEDGE", "LEAK-SECRET"]],
    ];
    for (const [name, leaks] of views) {
      await user.click(await screen.findByRole("button", { name }));
      await waitFor(() => expect(screen.getByRole("heading", { name: new RegExp(`^${name}$`, "u") })).toBeInTheDocument());
      const rendered = document.body.textContent ?? "";
      for (const leak of leaks) expect(rendered).not.toContain(leak);
    }
  });

  it("separates bundle, job, and proposal identities without unknown cross-view rows", async () => {
    installFetch(); const user = userEvent.setup(); render(<WorkflowDashboard />);
    for (const [view, present, absent] of [
      ["Knowledge bundles", "bundle-1", ["job-1", "proposal-1", "unknown"]],
      ["Knowledge jobs", "job-1", ["bundle-1", "proposal-1", "unknown"]],
      ["Knowledge proposals", "proposal-1", ["bundle-1", "job-1", "unknown"]],
    ] as const) {
      await user.click(await screen.findByRole("button", { name: view }));
      expect(await screen.findByRole("heading", { name: present })).toBeInTheDocument();
      for (const value of absent) expect(screen.queryByRole("heading", { name: value })).not.toBeInTheDocument();
    }
  });

  it("pages with hasMore and nextCursor only up to the 500-item display bound", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      if (url === "/bootstrap.json") return new Response(JSON.stringify({ token: "token", csrfToken: "csrf" }));
      if (url === "/api/v1/stream") return new Response("event: hello\ndata: {\"apiVersion\":1}\n\n", { headers: { "content-type": "text/event-stream" } });
      if (url.includes("/api/v1/tasks?")) {
        const cursor = new URL(url, "http://local").searchParams.get("cursor");
        const start = cursor ? Number(cursor) : 0;
        const items = Array.from({ length: 100 }, (_, offset) => ({ projectId: "project-1", sessionId: "session-1", runId: "run-1", taskId: `task-${start + offset}`, status: "running" }));
        return new Response(JSON.stringify({ apiVersion: 1, resource: "tasks", items, hasMore: true, nextCursor: String(start + 100) }));
      }
      return new Response(JSON.stringify(responseFor(url.split("/api/v1/")[1]?.split(/[?]/u)[0] ?? "workflows")));
    }));
    const user = userEvent.setup(); const view = render(<WorkflowDashboard />);
    await user.click(await screen.findByRole("button", { name: "Tasks" }));
    for (let pageIndex = 1; pageIndex < 5; pageIndex++) await user.click(await screen.findByRole("button", { name: /Load more Tasks/i }));
    expect(await screen.findByRole("button", { name: "Display limit reached" })).toBeDisabled();
    expect(screen.getAllByRole("article")).toHaveLength(500);
    expect(calls.filter((url) => url.includes("/api/v1/tasks?")).map((url) => new URL(url, "http://local").searchParams.get("cursor"))).toEqual([null, null, "100", "200", "300", "400"]);
    view.unmount();
  }, 15_000);

  it("renders evidence only from bounded history records carrying projected refs", async () => {
    const calls = installFetch(); const user = userEvent.setup(); render(<WorkflowDashboard />);
    await user.click(await screen.findByRole("button", { name: "Evidence" }));
    expect(await screen.findByRole("heading", { name: "evidence-event" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Evidence references" })).toHaveTextContent("tool-call-7");
    expect(screen.queryByRole("heading", { name: "plain-event" })).not.toBeInTheDocument();
    expect(calls.some((call) => call.url.includes("/api/v1/history?"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/api/v1/activity?") && call.url.includes("evidence"))).toBe(false);
  });

  it("renders explicit accessible cost and model-mix summaries from separated usage dimensions", async () => {
    const calls = installFetch(); const user = userEvent.setup(); render(<WorkflowDashboard />);
    await user.click(await screen.findByRole("button", { name: "Cost" }));
    expect(await screen.findByRole("heading", { name: "Provider-confirmed cost" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Estimated cost" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Cost summary" })).toHaveTextContent("$0.000020");
    await user.click(screen.getByRole("button", { name: "Model mix" }));
    const summary = await screen.findByRole("region", { name: "Model mix summary" });
    expect(summary).toHaveTextContent("provider/model-a"); expect(summary).toHaveTextContent("provider/model-b");
    expect(summary).toHaveTextContent("14"); expect(summary).toHaveTextContent("9");
    expect(calls.some((call) => call.url.includes("/api/v1/history?") && call.url.includes("eventType=budget.model.usage.recorded"))).toBe(true);
  });

  it("keeps exact question state and controls visible after CAS 409 without optimistic mutation", async () => {
    installFetch({ postFailure: { status: 409, message: "Question answer lost exact pending-state CAS" } }); const user = userEvent.setup(); render(<WorkflowDashboard />);
    await user.click(await screen.findByRole("button", { name: "Questions" })); await user.click(await screen.findByRole("button", { name: "Answer yes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/pending-state CAS/i);
    expect(screen.getByRole("heading", { name: "question-1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Answer yes" })).toBeEnabled();
  });

  it("submits every typed question kind with its exact typed value", async () => {
    const cases = [
      [{ kind: "confirm", required: true }, async (user: ReturnType<typeof userEvent.setup>) => user.click(await screen.findByRole("button", { name: "Answer no" })), false],
      [{ kind: "single", required: true, choices: [{ value: "alpha", label: "Alpha" }] }, async (user: ReturnType<typeof userEvent.setup>) => { await user.selectOptions(await screen.findByLabelText("Choice for question-1"), "alpha"); await user.click(screen.getByRole("button", { name: "Submit choice" })); }, "alpha"],
      [{ kind: "multi", required: true, choices: [{ value: "a", label: "Choice A" }, { value: "b", label: "Choice B" }] }, async (user: ReturnType<typeof userEvent.setup>) => { await user.click(await screen.findByLabelText("Choice A")); await user.click(screen.getByLabelText("Choice B")); await user.click(screen.getByRole("button", { name: "Submit choices" })); }, ["a", "b"]],
      [{ kind: "text", required: true, validation: { maxLength: 20 } }, async (user: ReturnType<typeof userEvent.setup>) => { await user.type(await screen.findByLabelText("Text answer for question-1"), "typed answer"); await user.click(screen.getByRole("button", { name: "Submit text" })); }, "typed answer"],
    ] as const;
    for (const [definition, answer, expected] of cases) {
      const calls = installFetch({ questionDefinition: definition }); const user = userEvent.setup(); const rendered = render(<WorkflowDashboard />);
      await user.click(await screen.findByRole("button", { name: "Questions" })); await answer(user);
      await waitFor(() => expect(calls.some((call) => call.url === "/api/v1/controls/questions/answer" && call.init?.method === "POST")).toBe(true));
      const mutation = calls.find((call) => call.url === "/api/v1/controls/questions/answer" && call.init?.method === "POST")!;
      expect(JSON.parse(String(mutation.init?.body)).value).toEqual(expected); rendered.unmount();
    }
  });

  it("submits typed question answers to the exact control endpoint and exact CAS DTO", async () => {
    const calls = installFetch(); const user = userEvent.setup(); render(<WorkflowDashboard />);
    await user.click(await screen.findByRole("button", { name: "Questions" }));
    await user.click(await screen.findByRole("button", { name: "Answer yes" }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/v1/controls/questions/answer" && call.init?.method === "POST")).toBe(true));
    const mutation = calls.find((call) => call.url === "/api/v1/controls/questions/answer" && call.init?.method === "POST")!;
    expect(JSON.parse(String(mutation.init?.body))).toEqual({ projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "question-1", expectedState: "pending", value: true, operationId: expect.any(String), claimedIdentity: "local-dashboard" });
  });

  it("handles resync-required SSE by reloading bounded API state before reconnect", async () => {
    const calls = installFetch({ streamFrames: ["event: resync-required\ndata: {\"apiVersion\":1,\"reason\":\"cursor-expired\"}\n\n", "event: hello\ndata: {\"apiVersion\":1}\n\n"] });
    const view = render(<WorkflowDashboard />);
    await waitFor(() => expect(calls.filter((call) => call.url === "/api/v1/stream").length).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    expect(calls.filter((call) => call.url.includes("/api/v1/workflows?")).length).toBeGreaterThanOrEqual(2);
    view.unmount();
  });

  it("renders a deep bounded topology without dropping descendants", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/bootstrap.json") return new Response(JSON.stringify({ token: "token", csrfToken: "csrf" }));
      if (url === "/api/v1/stream") return new Response("event: hello\ndata: {\"apiVersion\":1}\n\n", { headers: { "content-type": "text/event-stream" } });
      if (url.includes("/api/v1/nodes?")) return new Response(JSON.stringify(page("nodes", Array.from({ length: 120 }, (_, index) => ({ projectId: "project-1", sessionId: "session-1", runId: "run-1", nodeId: `deep-${index}`, ...(index ? { parentNodeId: `deep-${index - 1}` } : {}), status: "running" })))));
      return new Response(JSON.stringify(responseFor(url.split("/api/v1/")[1]?.split(/[?]/u)[0] ?? "workflows")));
    }));
    const user = userEvent.setup(); const view = render(<WorkflowDashboard />); await user.click(await screen.findByRole("button", { name: "Topology" }));
    const topology = await screen.findByRole("region", { name: "Topology hierarchy" });
    expect(topology.querySelectorAll("article")).toHaveLength(120); expect(topology).toHaveTextContent("deep-119"); view.unmount();
  });

  it("uses authenticated bounded fetch-stream SSE, validates hello, and reconnects with Last-Event-ID", async () => {
    const workflow = JSON.stringify({ schemaVersion: 1, eventId: "event-live", eventType: "task.started", timestamp: "2026-01-01T00:00:00Z", dimensions: { projectId: "project-1", sessionId: "session-1" } });
    const calls = installFetch({ streamFrames: [`event: hello\ndata: {"apiVersion":1}\n\nid: cursor-1\nevent: workflow\ndata: ${workflow}\n\n`, "event: hello\ndata: {\"apiVersion\":1}\n\n"] });
    const view = render(<WorkflowDashboard />);
    await waitFor(() => expect(calls.filter((call) => call.url === "/api/v1/stream").length).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    const streams = calls.filter((call) => call.url === "/api/v1/stream");
    const firstHeaders = new Headers(streams[0]!.init?.headers);
    expect(firstHeaders.get("authorization")).toBe("Bearer token");
    expect(firstHeaders.get("x-pi-hive-api-version")).toBe("1");
    expect(new Headers(streams[1]!.init?.headers).get("last-event-id")).toBe("cursor-1");
    view.unmount();
  });
});
