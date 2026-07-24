import { applyBrowserSecurityHeaders, hasExpectedHost, writeGateResponse } from "../security";
import { dashboardFile, dashboardHtml } from "../static";
import { BUILD_HASH, DAEMON_TOKEN, DB_PATH, PACKAGE_VERSION, PROTOCOL_VERSION, REGISTRY_PATH, STARTUP_NONCE, WORKFLOW_DB_PATH, expectedHostHeader } from "./config";
import { createWorkflowApi, type WorkflowApiOptions } from "./workflow-routes";
import { createProductionWorkflowApiOptions } from "./workflow-service";

function json(data: unknown, status = 200): Response {
  return applyBrowserSecurityHeaders(new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }), "api");
}

export interface DashboardHttpHandlerOptions { onActivity?: () => void; scheduleServerStop?: () => void; workflowApiOptions?: WorkflowApiOptions }
export type DashboardHttpHandler = ((request: Request) => Promise<Response>) & Readonly<{ dispose(): void }>;

/** Workflow-only dashboard surface. Historical telemetry files remain untouched and are never read. */
export function createDashboardHttpHandler(options: DashboardHttpHandlerOptions = {}): DashboardHttpHandler {
  const workflowApi = createWorkflowApi(options.workflowApiOptions ?? createProductionWorkflowApiOptions());
  const handle = async (request: Request): Promise<Response> => {
    options.onActivity?.();
    const url = new URL(request.url);
    if (!hasExpectedHost(request, expectedHostHeader())) return json({ error: "invalid host" }, 403);
    const gated = writeGateResponse(request, url, DAEMON_TOKEN, (error, status) => json({ error }, status));
    if (gated) return gated;
    const workflow = await workflowApi.handle(request, url);
    if (workflow) return workflow;
    if (request.method === "POST" && url.pathname === "/shutdown") {
      let body: unknown; try { body = await request.json(); } catch { return json({ error: "invalid json body" }, 400); }
      if (!body || typeof body !== "object" || (body as { startupNonce?: unknown }).startupNonce !== STARTUP_NONCE) return json({ error: "daemon identity mismatch" }, 409);
      workflowApi.dispose(); options.scheduleServerStop?.(); return json({ ok: true, pid: process.pid, startupNonce: STARTUP_NONCE }, 202);
    }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/health") return json({ ok: true, mode: "workflow", pid: process.pid, protocolVersion: PROTOCOL_VERSION, packageVersion: PACKAGE_VERSION, buildHash: BUILD_HASH, startupNonce: STARTUP_NONCE, workflowDbPath: WORKFLOW_DB_PATH, legacyTelemetryPreserved: [DB_PATH, REGISTRY_PATH] });
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/bootstrap.json") return json({ token: DAEMON_TOKEN, csrfToken: DAEMON_TOKEN });
    if (request.method === "GET" && url.pathname === "/") return dashboardHtml();
    if (request.method === "GET" && (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/fonts/") || url.pathname === "/favicon.ico")) return dashboardFile(url.pathname) ?? json({ error: "not found" }, 404);
    if (request.method === "GET" && request.headers.get("accept")?.includes("text/html")) return dashboardHtml();
    return json({ error: "not found" }, 404);
  };
  return Object.assign(handle, { dispose(): void { workflowApi.dispose(); } });
}
