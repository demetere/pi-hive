import { applyBrowserSecurityHeaders, hasExpectedHost, isSameOriginRequest, writeGateResponse } from "../security";
import { dashboardFile, dashboardHtml } from "../static";
import {
  BOOT_SESSION_ID, BUILD_HASH, CONVERSATION_LOG, DAEMON_TOKEN, DB_PATH, HOST,
  IDLE_TIMEOUT_MS, PACKAGE_VERSION, PORT, PROJECT_CWD, PROTOCOL_VERSION, REGISTRY_PATH,
  STARTUP_NONCE, expectedHostHeader,
} from "./config";
import { broadcastPing, encoder, eventFrame, SSE_BUFFER_BYTES, subscribers } from "./sse";
import type { Subscriber } from "./types";
import {
  allSnapshots,
  deleteProject,
  deleteProjectSourceLogs,
  deleteSessions,
  ingestionHealth,
  listModels,
  listTopologies,
  maxEventCursor,
  pruneTelemetry,
  queryDelegations,
  queryEvents,
  queryToolCalls,
  readAgentLog,
  recentEvents,
  recentThinking,
  sessionSummaries,
  sourceLogForSession,
  sourcePaths,
  startTelemetryRuntime,
  telemetryStorage,
  topologyDetail,
} from "./runtime";
import { listPlans, planDetail, planFile } from "./plan-routes";
import { resolveProjectCwd } from "./plan-bridge";
import { handlePlanReview, isAuthorizedPlanReviewMutation } from "./review-wiring";
import { clearProjectOverride, listProjectOverrides, setProjectOverride } from "./db";
import { OpenSpecCommandError } from "../../engine/openspec";

function json(data: unknown, status = 200) {
  return applyBrowserSecurityHeaders(new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  }), "api");
}

function openSpecFailure(error: unknown): Response {
  if (error instanceof OpenSpecCommandError) {
    const status = error.code === "timeout" ? 504
      : error.code === "cancelled" ? 499
        : error.code === "unavailable" ? 503
          : error.code === "output-limit" ? 413
            : 502;
    return json({ error: error.message, code: error.code }, status);
  }
  return json({ error: "OpenSpec request failed", code: "failed" }, 500);
}

function fleetPage(url: URL): { offset: number; limit: number } {
  const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
  const limit = Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 250)));
  return { offset, limit };
}

startTelemetryRuntime();

// SSE heartbeat: send a comment line to every open stream every 15s. Without
// it, an idle /stream connection (no events for a while) gets closed by the
// browser/proxy, the client's EventSource fires `error`, and the dashboard
// flickers to "reconnecting". A comment (": ping") keeps the socket alive and
// is ignored by EventSource.
const heartbeatTimer = setInterval(broadcastPing, 15_000);
let lastActivityAt = Date.now();
let shuttingDown = false;
let idleTimer: ReturnType<typeof setInterval>;

function scheduleServerStop(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => {
    clearInterval(heartbeatTimer);
    clearInterval(idleTimer);
    server.stop(true);
    process.exit(0);
  }, 50);
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  // Disable the per-connection idle timeout. SSE (/stream) connections are
  // intentionally long-lived and silent between events; Bun's default idle
  // timeout (~10s) would otherwise close them, making the client reconnect and
  // the dashboard flicker "reconnecting". The 15s heartbeat above is the
  // secondary guard for any proxy in front of us.
  idleTimeout: 0,
  async fetch(req: Request) {
    lastActivityAt = Date.now();
    const url = new URL(req.url);

    // Reject DNS-rebinding and alternate-host requests before any route,
    // including health/bootstrap and static assets. The configured listener
    // origin is the only accepted Host authority.
    if (!hasExpectedHost(req, expectedHostHeader())) return json({ error: "invalid host" }, 403);

    // Method-based write gate: every mutation clears authentication before any
    // route hook runs. Review decisions may use a previously bearer-minted,
    // content-bound capability; there is no pre-gate review API bypass.
    const reviewCapability = isAuthorizedPlanReviewMutation(req, url);

    // Method-based write gate (J7/Decision 3), in one testable helper (M8c): any
    // method other than GET/HEAD must clear same-origin + the bearer token, once,
    // before any routing — closing the hole where a future PUT/PATCH endpoint
    // would land outside a per-route check.
    const gated = writeGateResponse(req, url, DAEMON_TOKEN, (error, status) => json({ error }, status), reviewCapability);
    if (gated) return gated;

    if (req.method === "POST" && url.pathname === "/shutdown") {
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "invalid json body" }, 400); }
      if (body?.startupNonce !== STARTUP_NONCE) return json({ error: "daemon identity mismatch" }, 409);
      // Return the acknowledgement before closing the listener. The bearer token
      // and startup nonce jointly prove authority over this exact daemon instance.
      scheduleServerStop();
      return json({ ok: true, pid: process.pid, startupNonce: STARTUP_NONCE }, 202);
    }

    // Review HTML, session minting, and the vendored client's /api/* requests
    // are routed only after the method gate. Non-review /api requests fall through.
    const review = await handlePlanReview(req, url);
    if (review) return review;

    if (req.method === "POST") {
      // POST /prune  { olderThanDays }  — explicit age-based cleanup (J1).
      if (url.pathname === "/prune") {
        let body: any = {};
        try { body = await req.json(); } catch { return json({ error: "invalid json body" }, 400); }
        const days = Number(body.olderThanDays);
        if (!Number.isFinite(days) || days < 0) return json({ error: "olderThanDays must be a non-negative number" }, 400);
        const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
        const result = pruneTelemetry(cutoff);
        return json({ ok: true, ...result, cutoff });
      }
      // Plan annotations/approvals now happen inside the self-hosted Plannotator
      // review surface (/pl-review/ -> /api/approve|deny), not via these routes.
      // POST /project-overrides { projectId, label } — rename a display label
      // without allowing a caller-controlled cwd to become project authority.
      if (url.pathname === "/project-overrides") {
        let body: any = {};
        try { body = await req.json(); } catch { return json({ error: "invalid json body" }, 400); }
        const projectId = String(body.projectId || "").trim();
        const label = String(body.label || "").trim();
        if (!projectId) return json({ error: "projectId required" }, 400);
        const project = sessionSummaries().find((session) => session.project_id === projectId);
        if (!project) return json({ error: "unknown project" }, 404);
        if (!label) { clearProjectOverride(projectId); return json({ ok: true, projectId, cleared: true }); }
        const savedLabel = label.slice(0, 120);
        setProjectOverride(projectId, project.project_root, savedLabel, new Date().toISOString());
        return json({ ok: true, projectId, label: savedLabel });
      }
      return json({ error: "not found" }, 404);
    }

    if (req.method === "DELETE") {
      // Source logs are separate project files. Require an exact canonical
      // project ID plus an explicit confirmation phrase; DB deletion never
      // reaches this path.
      const sourceProjectMatch = url.pathname.match(/^\/source-logs\/projects\/(.+)$/);
      if (sourceProjectMatch) {
        if (url.searchParams.get("confirm") !== "delete-source-logs") return json({ error: "explicit source-log confirmation required" }, 400);
        const projectId = decodeURIComponent(sourceProjectMatch[1]);
        if (!sessionSummaries().some((session) => session.project_id === projectId)) return json({ error: "unknown project" }, 404);
        return json({ ok: true, projectId, ...deleteProjectSourceLogs(projectId) });
      }
      // DELETE /sessions/:id  — purge one session's telemetry.
      const sessionMatch = url.pathname.match(/^\/sessions\/(.+)$/);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]);
        const deleted = deleteSessions([id]);
        return json({ ok: true, deleted, sessions: deleted });
      }
      // DELETE /projects/:projectId — purge only sessions carrying this exact
      // canonical identity. Display labels and cwd basenames are never accepted.
      const projectMatch = url.pathname.match(/^\/projects\/(.+)$/);
      if (projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1]);
        const deleted = deleteProject(projectId);
        return json({ ok: true, projectId, sessions: deleted });
      }
      return json({ error: "not found" }, 404);
    }

    if (url.pathname === "/") return dashboardHtml();

    const sourceExportMatch = url.pathname.match(/^\/source-logs\/sessions\/(.+)$/);
    if (req.method === "GET" && sourceExportMatch) {
      const sessionId = decodeURIComponent(sourceExportMatch[1]);
      const file = sourceLogForSession(sessionId);
      if (!file) return json({ error: "source log not found" }, 404);
      const response = new Response(Bun.file(file), { headers: {
        "content-type": "application/x-ndjson",
        "content-disposition": `attachment; filename="pi-hive-${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl"`,
        "cache-control": "no-store",
      } });
      return applyBrowserSecurityHeaders(response, "api");
    }
    if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/fonts/") || url.pathname === "/favicon.ico") {
      const asset = dashboardFile(url.pathname);
      if (asset) return asset;
    }

    // SPA history fallback: a top-level browser navigation/refresh (GET with an
    // HTML Accept) to any client route — including ones that collide with API
    // paths like /sessions or /plans — must serve the app shell, not the JSON
    // API. The dashboard's own data fetches use fetch() (Accept: */*), so they
    // still reach the JSON endpoints below. Handled before the API reads so the
    // collision resolves in favor of the SPA for real navigations.
    if (req.method === "GET" && url.pathname !== "/stream" && req.headers.get("accept")?.includes("text/html")) {
      return dashboardHtml();
    }

    if (!isSameOriginRequest(req, url)) return json({ error: "cross-origin read blocked" }, 403);

    // Same-origin bootstrap: hand the write token to the app (Phase D). Safe as
    // a same-origin GET — the token never appears in a URL or in cached HTML.
    // The browser attaches it as the Bearer header on POST/DELETE.
    if (url.pathname === "/bootstrap.json") {
      const response = json({ token: DAEMON_TOKEN || null, bootCwd: PROJECT_CWD || null });
      response.headers.set("cache-control", "no-store");
      return response;
    }

    if (url.pathname === "/health") return json({
      ok: true,
      mode: "global",
      boot_session_id: BOOT_SESSION_ID,
      sessions: sessionSummaries().length,
      events: maxEventCursor(),
      cursor: maxEventCursor(),
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION,
      packageVersion: PACKAGE_VERSION,
      buildHash: BUILD_HASH,
      registryPath: REGISTRY_PATH,
      dbPath: DB_PATH,
      startupNonce: STARTUP_NONCE,
      // Legacy display aliases; adoption uses the versioned fields above.
      registry: REGISTRY_PATH,
      db: DB_PATH,
      sources: sourcePaths(),
      ingestion: ingestionHealth(),
    });
    // Paginated, cursor-ordered event feed (B5). `?after=<cursor>` returns only
    // newer events (lossless SSE catch-up); no more single 20k-event body.
    // Omitting `after` returns the most recent `limit` events (initial load).
    if (url.pathname === "/events") {
      const session = url.searchParams.get("session") || undefined;
      const cwd = url.searchParams.get("cwd") || undefined;
      const type = url.searchParams.get("type") || undefined;
      const limit = Math.min(5000, Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 1000)));
      const afterParam = url.searchParams.get("after");
      const beforeParam = url.searchParams.get("before");
      const after = afterParam != null && Number.isFinite(Number(afterParam)) ? Math.max(0, Math.floor(Number(afterParam))) : undefined;
      const before = beforeParam != null && Number.isFinite(Number(beforeParam)) ? Math.max(0, Math.floor(Number(beforeParam))) : undefined;
      const currentHighWater = maxEventCursor();
      const highWaterParam = url.searchParams.get("highWater");
      const requestedHighWater = highWaterParam != null ? Number(highWaterParam) : Number.NaN;
      // Freeze a reconnect drain at the high-water mark returned by its first
      // page. New live events can continue over SSE without making catch-up an
      // endless chase of a moving tail.
      const highWaterCursor = after != null && Number.isFinite(requestedHighWater) && requestedHighWater >= after
        ? Math.min(currentHighWater, Math.floor(requestedHighWater))
        : currentHighWater;
      const events = after != null || before != null || type
        ? queryEvents({ session, cwd, type, after, before, through: after != null ? highWaterCursor : undefined, limit })
        : recentEvents(limit, { session, cwd });
      const nextCursor = Number(events[events.length - 1]?.cursor ?? after ?? 0);
      const unfilteredCatchUp = after != null && !session && !cwd && !type && before == null;
      const hasMore = unfilteredCatchUp ? nextCursor < highWaterCursor : events.length >= limit;
      return json({ events, cursor: nextCursor, nextCursor, highWaterCursor, hasMore });
    }
    // Single source for cost/token series (E2) and per-session tool detail.
    if (url.pathname === "/delegations") {
      const session = url.searchParams.get("session") || undefined;
      const cwd = url.searchParams.get("cwd") || undefined;
      const after = url.searchParams.get("after");
      const limit = Number(url.searchParams.get("limit") || 1000);
      // deltasOnly=1: exclude legacy cumulative rows so cost/token SUMs are safe
      // (Decision 1). The Activity feed omits it to see every delegation row.
      const deltasOnly = url.searchParams.get("deltasOnly") === "1";
      return json({ delegations: queryDelegations({ session, cwd, after: after != null ? Number(after) : undefined, limit, deltasOnly }) });
    }
    // ACCEPTED DESCOPE (Round 3 decision): the dashboard UI does NOT consume this
    // endpoint. Deep per-tool history is reachable via `/events?before=` paging
    // (which pages in the underlying worker_tool_start/end raw events), and
    // per-agent tool COUNTS come from the snapshot runtime.toolCount — so nothing
    // in the UI needs a second parallel tool-history source. The endpoint + its
    // tool_calls materialization are kept (cheap, idempotent) for external/API
    // consumers and possible future use. Known limit not worth wiring the UI for:
    // tool counts for fresh-re-run agents in dead sessions outside the loaded event
    // window are undercounted, and the `delegations` projection carries no tool
    // count. Revisit if a UI feature genuinely needs untruncated per-tool history.
    if (url.pathname === "/tool-calls") {
      const session = url.searchParams.get("session") || undefined;
      const after = url.searchParams.get("after");
      const limit = Number(url.searchParams.get("limit") || 1000);
      return json({ toolCalls: queryToolCalls({ session, after: after != null ? Number(after) : undefined, limit }) });
    }
    if (url.pathname === "/states") {
      const { offset, limit } = fleetPage(url);
      const rows = allSnapshots({ offset, limit: limit + 1 });
      const hasMore = rows.length > limit;
      const states = hasMore ? rows.slice(0, limit) : rows;
      return json({ states, offset, nextOffset: offset + states.length, hasMore });
    }
    if (url.pathname === "/sessions") {
      const { offset, limit } = fleetPage(url);
      const rows = sessionSummaries({ offset, limit: limit + 1 });
      const hasMore = rows.length > limit;
      const sessions = hasMore ? rows.slice(0, limit) : rows;
      return json({ sessions, offset, nextOffset: offset + sessions.length, hasMore });
    }

    // Storage usage + prune preview. Project scope is an exact canonical ID;
    // omit it for fleet-wide storage.
    if (url.pathname === "/storage") {
      const projectId = url.searchParams.get("projectId") || undefined;
      const daysRaw = url.searchParams.get("olderThanDays");
      const days = daysRaw != null ? Number(daysRaw) : undefined;
      return json(telemetryStorage(projectId, days));
    }

    // Versioned topology (Phase C). List versions for a project, or fetch one
    // reassembled tree by hash. /models is the capability lookup for the dial.
    if (url.pathname === "/topologies") {
      const cwd = url.searchParams.get("cwd") || undefined;
      return json({ topologies: listTopologies(cwd) });
    }
    const topoMatch = url.pathname.match(/^\/topologies\/([^/]+)$/);
    if (topoMatch) {
      const detail = topologyDetail(decodeURIComponent(topoMatch[1]));
      return detail ? json(detail) : json({ error: "not found" }, 404);
    }
    if (url.pathname === "/models") {
      const all = url.searchParams.get("all") === "1" || url.searchParams.get("all") === "true";
      return json({ models: listModels(all) });
    }

    // Plan store (read). All scoped to a known project cwd (?cwd=..., defaults
    // to the boot project); an unknown cwd is rejected so a caller cannot read
    // arbitrary filesystem paths.
    if (url.pathname === "/plans" || url.pathname.startsWith("/plans/")) {
      const cwd = resolveProjectCwd(url.searchParams.get("cwd"));
      if (!cwd) return json({ error: "unknown project cwd", plans: [] }, url.pathname === "/plans" ? 200 : 400);
      if (url.pathname === "/plans") {
        try { return json({ cwd, plans: await listPlans(cwd, { signal: req.signal }) }); }
        catch (error) { return openSpecFailure(error); }
      }
      const fileMatch = url.pathname.match(/^\/plans\/([^/]+)\/file$/);
      if (fileMatch) {
        const changeId = decodeURIComponent(fileMatch[1]);
        const rel = url.searchParams.get("path") || "";
        const file = planFile(cwd, changeId, rel);
        return file ? json(file) : json({ error: "not found" }, 404);
      }
      const detailMatch = url.pathname.match(/^\/plans\/([^/]+)$/);
      if (detailMatch) {
        const changeId = decodeURIComponent(detailMatch[1]);
        try {
          const detail = await planDetail(cwd, changeId, { signal: req.signal });
          return detail ? json(detail) : json({ error: "not found" }, 404);
        } catch (error) { return openSpecFailure(error); }
      }
    }
    if (url.pathname === "/stream") {
      let sub: Subscriber | undefined;
      return applyBrowserSecurityHeaders(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          sub = controller;
          subscribers.add(controller);
          controller.enqueue(encoder.encode(eventFrame("hello", { mode: "global", registry: REGISTRY_PATH, cursor: maxEventCursor() })));
        },
        cancel() { if (sub) subscribers.delete(sub); },
      }, {
        highWaterMark: SSE_BUFFER_BYTES,
        size(chunk) { return chunk.byteLength; },
      }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" } }), "api");
    }
    if (url.pathname === "/conversation") return json({ path: CONVERSATION_LOG });
    if (url.pathname === "/agent-log") {
      const sessionId = url.searchParams.get("session") || "";
      const agent = url.searchParams.get("agent") || "";
      const offset = Number(url.searchParams.get("offset") || 0);
      const beforeRaw = url.searchParams.get("before");
      const before = beforeRaw != null && Number.isFinite(Number(beforeRaw)) ? Math.max(0, Number(beforeRaw)) : undefined;
      const runId = url.searchParams.get("run") || "";
      return json(readAgentLog(sessionId, agent, offset, runId, before));
    }
    if (url.pathname === "/thinking") {
      const sessionId = url.searchParams.get("session") || "";
      if (!sessionId) return json({ thinking: [] });
      return json({ thinking: recentThinking(sessionId) });
    }
    if (url.pathname === "/project-overrides") return json({ overrides: listProjectOverrides() });

    return json({ error: "not found" }, 404);
  },
});

// The daemon is shared across Pi sessions, so a single session shutdown cannot
// safely terminate it. Bound its lifetime instead: no active browser stream and
// no HTTP activity for the configured interval triggers graceful self-shutdown.
idleTimer = setInterval(() => {
  if (subscribers.size === 0 && Date.now() - lastActivityAt >= IDLE_TIMEOUT_MS) scheduleServerStop();
}, Math.min(60_000, Math.max(1_000, Math.floor(IDLE_TIMEOUT_MS / 4))));

console.log(`pi-hive telemetry dashboard: http://${HOST}:${PORT}`);
console.log(`registry: ${REGISTRY_PATH}`);
console.log(`sources: ${sourcePaths().length}`);
