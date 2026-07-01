import { isSameOriginWrite } from "../security";
import { dashboardFile, dashboardHtml } from "../static";
import { BOOT_SESSION_ID, CONVERSATION_LOG, DB_PATH, HOST, PORT, REGISTRY_PATH } from "./config";
import { broadcastPing, encoder, eventFrame, subscribers } from "./sse";
import type { Subscriber } from "./types";
import {
  allEvents,
  allSnapshots,
  deleteProject,
  deleteSessions,
  readAgentLog,
  sessionSummaries,
  sourcePaths,
  startTelemetryRuntime,
} from "./runtime";
import { addApproval, addComment, listPlans, planDetail, planFile, resolveProjectCwd } from "./plans";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

startTelemetryRuntime();

// SSE heartbeat: send a comment line to every open stream every 15s. Without
// it, an idle /stream connection (no events for a while) gets closed by the
// browser/proxy, the client's EventSource fires `error`, and the dashboard
// flickers to "reconnecting". A comment (": ping") keeps the socket alive and
// is ignored by EventSource.
setInterval(broadcastPing, 15_000);

Bun.serve({
  hostname: HOST,
  port: PORT,
  // Disable the per-connection idle timeout. SSE (/stream) connections are
  // intentionally long-lived and silent between events; Bun's default idle
  // timeout (~10s) would otherwise close them, making the client reconnect and
  // the dashboard flicker "reconnecting". The 15s heartbeat above is the
  // secondary guard for any proxy in front of us.
  idleTimeout: 0,
  async fetch(req: Request) {
    const url = new URL(req.url);

    if (req.method === "POST") {
      if (!isSameOriginWrite(req, url)) return json({ error: "cross-origin write blocked" }, 403);
      // POST /plans/:changeId/comments  and  POST /plans/:changeId/approval
      const commentMatch = url.pathname.match(/^\/plans\/([^/]+)\/comments$/);
      const approvalMatch = url.pathname.match(/^\/plans\/([^/]+)\/approval$/);
      if (commentMatch || approvalMatch) {
        const changeId = decodeURIComponent((commentMatch || approvalMatch)![1]);
        const cwd = resolveProjectCwd(url.searchParams.get("cwd"));
        if (!cwd) return json({ error: "unknown project cwd" }, 400);
        let body: any = {};
        try { body = await req.json(); } catch { return json({ error: "invalid json body" }, 400); }
        const result = commentMatch ? addComment(cwd, changeId, body) : addApproval(cwd, changeId, body);
        return json(result, result.ok ? 200 : 400);
      }
      return json({ error: "not found" }, 404);
    }

    if (req.method === "DELETE") {
      if (!isSameOriginWrite(req, url)) return json({ error: "cross-origin write blocked" }, 403);
      // DELETE /sessions/:id  — purge one session's telemetry.
      const sessionMatch = url.pathname.match(/^\/sessions\/(.+)$/);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]);
        const deleted = deleteSessions([id]);
        return json({ ok: true, deleted, sessions: deleted });
      }
      // DELETE /projects/:name — purge every session in a project.
      const projectMatch = url.pathname.match(/^\/projects\/(.+)$/);
      if (projectMatch) {
        const name = decodeURIComponent(projectMatch[1]);
        const deleted = deleteProject(name);
        return json({ ok: true, project: name, sessions: deleted });
      }
      return json({ error: "not found" }, 404);
    }

    if (url.pathname === "/") return dashboardHtml();
    if (url.pathname.startsWith("/assets/") || url.pathname === "/favicon.ico") {
      const asset = dashboardFile(url.pathname);
      if (asset) return asset;
    }
    if (url.pathname === "/health") return json({
      ok: true,
      mode: "global",
      boot_session_id: BOOT_SESSION_ID,
      sessions: sessionSummaries().length,
      events: allEvents().length,
      registry: REGISTRY_PATH,
      db: DB_PATH,
      sources: sourcePaths(),
    });
    if (url.pathname === "/events") return json({ events: allEvents() });
    if (url.pathname === "/states") return json({ states: allSnapshots() });
    if (url.pathname === "/sessions") return json({ sessions: sessionSummaries() });

    // Plan store (read). All scoped to a known project cwd (?cwd=..., defaults
    // to the boot project); an unknown cwd is rejected so a caller cannot read
    // arbitrary filesystem paths.
    if (url.pathname === "/plans" || url.pathname.startsWith("/plans/")) {
      const cwd = resolveProjectCwd(url.searchParams.get("cwd"));
      if (!cwd) return json({ error: "unknown project cwd", plans: [] }, url.pathname === "/plans" ? 200 : 400);
      if (url.pathname === "/plans") return json({ cwd, plans: listPlans(cwd) });
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
        const detail = planDetail(cwd, changeId);
        return detail ? json(detail) : json({ error: "not found" }, 404);
      }
    }
    if (url.pathname === "/stream") {
      let sub: Subscriber | undefined;
      return new Response(new ReadableStream({
        start(controller) {
          sub = controller;
          subscribers.add(controller);
          controller.enqueue(encoder.encode(eventFrame("hello", { mode: "global", registry: REGISTRY_PATH })));
        },
        cancel() { if (sub) subscribers.delete(sub); },
      }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive", "access-control-allow-origin": "*" } });
    }
    if (url.pathname === "/conversation") return json({ path: CONVERSATION_LOG });
    if (url.pathname === "/agent-log") {
      const sessionId = url.searchParams.get("session") || "";
      const agent = url.searchParams.get("agent") || "";
      const offset = Number(url.searchParams.get("offset") || 0);
      const runId = url.searchParams.get("run") || "";
      return json(readAgentLog(sessionId, agent, offset, runId));
    }
    return json({ error: "not found" }, 404);
  },
});

console.log(`pi-hive telemetry dashboard: http://${HOST}:${PORT}`);
console.log(`registry: ${REGISTRY_PATH}`);
console.log(`sources: ${sourcePaths().length}`);
