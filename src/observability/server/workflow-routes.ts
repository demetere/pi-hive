import { createHash } from "node:crypto";
import { canonicalJson } from "../../config/snapshot-canonical";
import {
  WORKFLOW_DASHBOARD_API_VERSION,
  WORKFLOW_DASHBOARD_MAX_BODY_BYTES,
  WORKFLOW_DASHBOARD_MAX_PAGE_SIZE,
  type WorkflowDashboardResource,
  type WorkflowDashboardResourcePage,
} from "../../shared/dashboard-api";
import type {
  ProjectionStreamStatus,
  WorkflowCurrentPage,
  WorkflowCurrentPageQuery,
  WorkflowHistoryPage,
  WorkflowHistoryQuery,
  WorkflowProjectionCurrent,
  WorkflowProjectionUsageTotals,
  WorkflowUsageQuery,
} from "../projection";
import { applyBrowserSecurityHeaders, isAuthorizedCsrf, isAuthorizedWrite, isSameOriginRequest } from "../security";

export interface WorkflowProjectionApi {
  currentPage(query: WorkflowCurrentPageQuery): WorkflowCurrentPage;
  resourcePage?(resource: "projects" | "workflows", query: Omit<WorkflowCurrentPageQuery, "kind">): WorkflowCurrentPage;
  history(query: WorkflowHistoryQuery): WorkflowHistoryPage;
  usage(query: WorkflowUsageQuery): WorkflowProjectionUsageTotals;
  status(): Readonly<{ streams: readonly ProjectionStreamStatus[]; diagnostics: readonly unknown[] }>;
  stream(lastEventId?: string): Response;
  runOperation<T>(scope: string, operationId: string, requestHash: string, invoke: () => T | Promise<T>): Promise<T>;
  close(): void;
}

export interface WorkflowControlApi {
  readQuestion(input: Record<string, unknown>): unknown | Promise<unknown>;
  readCheckpoint(input: Record<string, unknown>): unknown | Promise<unknown>;
  readKnowledge(input: Record<string, unknown>): unknown | Promise<unknown>;
  answerQuestion(input: Record<string, unknown>): unknown | Promise<unknown>;
  decideCheckpoint(input: Record<string, unknown>): unknown | Promise<unknown>;
  decideKnowledge(input: Record<string, unknown>): unknown | Promise<unknown>;
  rebuildProjection(input: Record<string, unknown>): unknown | Promise<unknown>;
  pruneProjection(input: Record<string, unknown>): unknown | Promise<unknown>;
  pruneJournal(input: Record<string, unknown>): unknown | Promise<unknown>;
}

export interface WorkflowApiOptions {
  readonly token: string;
  readonly projection: WorkflowProjectionApi;
  readonly controls: WorkflowControlApi;
  readonly maxBodyBytes?: number;
  readonly maxRequestsPerWindow?: number;
  readonly rateWindowMs?: number;
  readonly now?: () => number;
}

const RESOURCE_KINDS: Readonly<Record<WorkflowDashboardResource, keyof WorkflowProjectionCurrent>> = Object.freeze({
  projects: "sessions", workflows: "sessions", sessions: "sessions", runs: "runs", nodes: "nodes", tasks: "tasks",
  artifacts: "workspaces", checkpoints: "approvals", questions: "questions", approvals: "approvals", knowledge: "knowledge",
});
const READ_PATH = /^\/api\/v1\/(projects|workflows|sessions|runs|nodes|tasks|artifacts|checkpoints|questions|approvals|knowledge)$/u;
const QUERY_BYTES = 8_192;
const QUERY_PARAMETERS = 16;
const RESOURCE_FILTERS: Readonly<Record<WorkflowDashboardResource, readonly string[]>> = Object.freeze({
  projects: ["projectId", "status"],
  workflows: ["projectId", "workflowId", "status"],
  sessions: ["projectId", "sessionId", "workflowId", "status"],
  runs: ["projectId", "sessionId", "workflowId", "runId", "status"],
  nodes: ["projectId", "sessionId", "workflowId", "runId", "nodeId", "status"],
  tasks: ["projectId", "sessionId", "workflowId", "runId", "nodeId", "taskId", "status"],
  artifacts: ["projectId", "sessionId", "workflowId", "runId", "nodeId", "taskId", "status"],
  checkpoints: ["projectId", "sessionId", "workflowId", "runId", "nodeId", "taskId", "status"],
  questions: ["projectId", "sessionId", "workflowId", "runId", "nodeId", "taskId", "status"],
  approvals: ["projectId", "sessionId", "workflowId", "runId", "nodeId", "taskId", "status"],
  knowledge: ["projectId", "sessionId", "workflowId", "runId", "nodeId", "taskId", "status"],
});

function response(data: unknown, status = 200): Response {
  return applyBrowserSecurityHeaders(new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }), "api");
}
function failure(code: string, message: string, status: number): Response {
  return response({ apiVersion: WORKFLOW_DASHBOARD_API_VERSION, error: { code, message: message.slice(0, 2_048) } }, status);
}
function exactObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be a JSON object");
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in record)) || Object.keys(record).some((key) => !allowed.has(key))) throw new Error("request body has missing or unknown fields");
  return record;
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function operationId(value: unknown): string { return identifier(value, "operationId"); }
function pageLimit(url: URL): number {
  const raw = url.searchParams.get("limit") ?? "100";
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new Error("limit must be an integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > WORKFLOW_DASHBOARD_MAX_PAGE_SIZE) throw new Error(`limit must be 1..${WORKFLOW_DASHBOARD_MAX_PAGE_SIZE}`);
  return value;
}
function queryValues(url: URL, supported: readonly string[]): Record<string, string> {
  if (Buffer.byteLength(url.search, "utf8") > QUERY_BYTES) throw new Error("raw query exceeds its byte limit");
  const parameters = [...url.searchParams.entries()];
  if (parameters.length > QUERY_PARAMETERS) throw new Error("query parameter count exceeds its limit");
  const allowed = new Set(["limit", ...supported]);
  const seen = new Set<string>();
  const output: Record<string, string> = {};
  for (const [key, value] of parameters) {
    if (!allowed.has(key)) throw new Error(`unsupported query parameter for this route: ${key}`);
    if (seen.has(key)) throw new Error(`duplicate query parameter is ambiguous: ${key}`);
    seen.add(key);
    if (key === "limit") continue;
    if (!value || Buffer.byteLength(value, "utf8") > 1_024) throw new Error(`${key} is invalid`);
    output[key] = value;
  }
  return output;
}
async function readBody(req: Request, maxBytes: number): Promise<unknown> {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw Object.assign(new Error("content-type must be application/json"), { status: 415, code: "UNSUPPORTED_MEDIA_TYPE" });
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) throw Object.assign(new Error("request body exceeds its byte limit"), { status: 413, code: "BODY_TOO_LARGE" });
  const reader = req.body?.getReader();
  if (!reader) throw new Error("request body is required");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new Error("request body stream is invalid");
      if (chunk.value.byteLength > maxBytes - total) {
        await reader.cancel("request body exceeds its byte limit");
        throw Object.assign(new Error("request body exceeds its byte limit"), { status: 413, code: "BODY_TOO_LARGE" });
      }
      total += chunk.value.byteLength;
      chunks.push(chunk.value);
    }
  } catch (error) {
    try { await reader.cancel(error); } catch { /* already closed */ }
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("request body is not valid UTF-8 JSON"); }
}
function statusFor(error: unknown): number {
  const explicit = Number((error as { status?: unknown })?.status);
  if (Number.isSafeInteger(explicit) && explicit >= 400 && explicit <= 599) return explicit;
  const message = error instanceof Error ? error.message : String(error);
  if (/already|CAS|conflict|stale|reuse|decided|pending state|identity mismatch/iu.test(message)) return 409;
  if (/\b(?:object is missing|is missing|not found)\b/iu.test(message)) return 404;
  if (/authentication|authorized|credential/iu.test(message)) return 401;
  return 400;
}
function codeFor(error: unknown, status: number): string {
  const explicit = (error as { code?: unknown })?.code;
  if (typeof explicit === "string" && /^[A-Z0-9_]{1,64}$/u.test(explicit)) return explicit;
  return status === 409 ? "CAS_CONFLICT" : status === 404 ? "NOT_FOUND" : status === 401 ? "UNAUTHORIZED" : "INVALID_REQUEST";
}
function publicMessageFor(error: unknown, status: number, code: string): string {
  const explicit = (error as { publicMessage?: unknown })?.publicMessage;
  if (typeof explicit === "string" && explicit.length && !/[\r\n]/u.test(explicit)) return explicit;
  if (status === 413) return "request exceeds a workflow API limit";
  if (status === 415) return "content-type must be application/json";
  if (status === 409) return `${code.toLowerCase().replaceAll("_", " ")} conflict`;
  if (status === 404) return "route or resource not found";
  if (status === 401) return "authentication required";
  if (status === 403) return "request forbidden";
  if (status === 405) return "method not allowed";
  if (status === 426) return `Dashboard API version ${WORKFLOW_DASHBOARD_API_VERSION} is required`;
  if (status === 429) return "authenticated request rate exceeded";
  if (status >= 500) return "workflow API request failed";
  return "workflow API request is invalid";
}

export function createWorkflowApi(options: WorkflowApiOptions): Readonly<{ handle(req: Request, url: URL): Promise<Response | null>; dispose(): void }> {
  if (!options.token || Buffer.byteLength(options.token, "utf8") < 32) throw new Error("Workflow API requires a high-entropy daemon token");
  const maxBodyBytes = options.maxBodyBytes ?? WORKFLOW_DASHBOARD_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > WORKFLOW_DASHBOARD_MAX_BODY_BYTES) throw new Error("Workflow API body limit is invalid");
  const maxRequests = options.maxRequestsPerWindow ?? 600;
  const rateWindowMs = options.rateWindowMs ?? 60_000;
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 100_000 || !Number.isSafeInteger(rateWindowMs) || rateWindowMs < 100 || rateWindowMs > 3_600_000) throw new Error("Workflow API rate limit is invalid");
  const now = options.now ?? Date.now;
  let rateWindowStarted = now();
  let rateCount = 0;
  let closed = false;

  const replay = async (scope: string, input: Record<string, unknown>, invoke: () => unknown | Promise<unknown>): Promise<unknown> => {
    const id = operationId(input.operationId);
    const hash = createHash("sha256").update("pi-hive-dashboard-operation-v1\0").update(scope).update("\0").update(canonicalJson(input)).digest("hex");
    return options.projection.runOperation(scope, id, hash, invoke);
  };

  return Object.freeze({
    dispose(): void {
      if (closed) return;
      closed = true;
      options.projection.close();
    },
    async handle(req: Request, url: URL): Promise<Response | null> {
      if (!url.pathname.startsWith("/api/v1/")) return null;
      if (closed) return failure("SERVICE_UNAVAILABLE", "workflow API is closed", 503);
      const version = req.headers.get("x-pi-hive-api-version");
      if (version !== String(WORKFLOW_DASHBOARD_API_VERSION)) return failure("INCOMPATIBLE_API_VERSION", `Dashboard API version ${WORKFLOW_DASHBOARD_API_VERSION} is required`, 426);
      if (!isSameOriginRequest(req, url)) return failure("CROSS_ORIGIN", "cross-origin request blocked", 403);
      if (!isAuthorizedWrite(req, options.token)) return failure("UNAUTHORIZED", "authentication required", 401);
      const requestTime = now();
      if (!Number.isFinite(requestTime)) return failure("CLOCK_INVALID", "rate-limit clock is invalid", 500);
      if (requestTime - rateWindowStarted >= rateWindowMs || requestTime < rateWindowStarted) { rateWindowStarted = requestTime; rateCount = 0; }
      rateCount += 1;
      if (rateCount > maxRequests) {
        const limited = failure("RATE_LIMITED", "authenticated request rate exceeded", 429);
        limited.headers.set("retry-after", String(Math.max(1, Math.ceil((rateWindowStarted + rateWindowMs - requestTime) / 1_000))));
        return limited;
      }
      try {
        if (req.method === "GET") {
          const resourceMatch = READ_PATH.exec(url.pathname);
          if (resourceMatch) {
            const resource = resourceMatch[1] as WorkflowDashboardResource;
            const values = queryValues(url, ["cursor", ...RESOURCE_FILTERS[resource]]);
            const page = (resource === "projects" || resource === "workflows") && options.projection.resourcePage
              ? options.projection.resourcePage(resource, { limit: pageLimit(url), ...values })
              : options.projection.currentPage({ kind: RESOURCE_KINDS[resource], limit: pageLimit(url), ...values });
            return response({ apiVersion: 1, resource, items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), hasMore: page.hasMore } satisfies WorkflowDashboardResourcePage);
          }
          if (url.pathname === "/api/v1/activity" || url.pathname === "/api/v1/history") {
            const values = queryValues(url, ["cursor", "projectId", "sessionId", "workflowId", "runId", "nodeId", "taskId", "eventType"]);
            const page = options.projection.history({ limit: pageLimit(url), ...values } as WorkflowHistoryQuery);
            return response({ apiVersion: 1, items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), hasMore: page.hasMore });
          }
          if (url.pathname === "/api/v1/usage") {
            const values = queryValues(url, ["projectId", "sessionId", "workflowId", "runId", "nodeId"]);
            return response({ apiVersion: 1, usage: options.projection.usage(values) });
          }
          if (url.pathname === "/api/v1/projection/status") {
            queryValues(url, []);
            return response({ apiVersion: 1, ...options.projection.status() });
          }
          if (url.pathname === "/api/v1/stream") {
            queryValues(url, []);
            const lastEventId = req.headers.get("last-event-id") ?? undefined;
            if (lastEventId !== undefined && Buffer.byteLength(lastEventId, "utf8") > 1_024) throw new Error("Last-Event-ID is invalid");
            return applyBrowserSecurityHeaders(options.projection.stream(lastEventId), "api");
          }
          const detail = /^\/api\/v1\/(questions|approvals|knowledge)\/([^/]+)$/u.exec(url.pathname);
          if (detail) {
            const values = queryValues(url, ["projectId", "sessionId", "runId"]);
            if (!values.projectId || !values.sessionId || !values.runId) throw new Error("detail query requires exact project/session/run identity");
            const objectId = decodeURIComponent(detail[2]);
            const input = detail[1] === "questions" ? { projectId: values.projectId, sessionId: values.sessionId, runId: values.runId, questionId: objectId }
              : detail[1] === "approvals" ? { projectId: values.projectId, sessionId: values.sessionId, runId: values.runId, requestId: objectId }
                : { projectId: values.projectId, sessionId: values.sessionId, runId: values.runId, proposalId: objectId };
            const object = detail[1] === "questions" ? await options.controls.readQuestion(input)
              : detail[1] === "approvals" ? await options.controls.readCheckpoint(input) : await options.controls.readKnowledge(input);
            return response({ apiVersion: 1, object });
          }
          return failure("NOT_FOUND", "route not found", 404);
        }
        if (req.method !== "POST") return failure("METHOD_NOT_ALLOWED", "method not allowed", 405);
        queryValues(url, []);
        if (!isAuthorizedCsrf(req, options.token)) return failure("CSRF", "CSRF proof required", 403);
        const raw = await readBody(req, maxBodyBytes);
        const credential = options.token;
        let result: unknown;
        if (url.pathname === "/api/v1/controls/questions/answer") {
          const input = exactObject(raw, ["projectId", "sessionId", "runId", "questionId", "expectedState", "value", "operationId", "claimedIdentity"]);
          result = await replay("question", input, () => options.controls.answerQuestion({ ...input, channel: "dashboard", credential }));
        } else if (url.pathname === "/api/v1/controls/approvals/decide") {
          const input = exactObject(raw, ["projectId", "sessionId", "runId", "requestId", "expectedRequestSequence", "digest", "expectedWorkspaceHash", "decision", "operationId"], ["feedback"]);
          result = await replay("approval", input, () => options.controls.decideCheckpoint({ ...input, credential }));
        } else if (url.pathname === "/api/v1/controls/knowledge/decide") {
          const input = exactObject(raw, ["projectId", "sessionId", "runId", "proposalId", "expectedState", "decision", "operationId", "claimedIdentity"]);
          result = await replay("knowledge", input, () => options.controls.decideKnowledge({ ...input, channel: "dashboard", credential }));
        } else if (url.pathname === "/api/v1/maintenance/projection/rebuild") {
          const input = exactObject(raw, ["operationId"]);
          result = await replay("projection-rebuild", input, () => options.controls.rebuildProjection(input));
        } else if (url.pathname === "/api/v1/maintenance/projection/prune") {
          const input = exactObject(raw, ["operationId", "cutoff"]);
          result = await replay("projection-prune", input, () => options.controls.pruneProjection(input));
        } else if (url.pathname === "/api/v1/maintenance/journals/prune") {
          const input = exactObject(raw, ["projectId", "sessionId", "operationId", "confirmIrrecoverable"]);
          result = await replay("journal-prune", input, () => options.controls.pruneJournal({ ...input, credential }));
        } else return failure("NOT_FOUND", "route not found", 404);
        return response({ apiVersion: 1, result });
      } catch (error) {
        const status = statusFor(error);
        const code = codeFor(error, status);
        return failure(code, publicMessageFor(error, status, code), status);
      }
    },
  });
}
