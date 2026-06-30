import * as fs from "node:fs";
import * as path from "node:path";

// The dashboard is a prebuilt Solid SPA under ui/web/dist. We serve its
// index.html at "/" and its hashed assets from "/assets/*". If the build is
// missing (developer hasn't run `just build-dashboard`), we fall back to a short
// instructional page rather than a blank screen.
export const DASHBOARD_DIR = path.resolve(import.meta.dir, "..", "..", "ui", "web", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function dashboardFile(relPath: string): Response | null {
  // Resolve safely inside DASHBOARD_DIR (no path traversal).
  const target = path.resolve(DASHBOARD_DIR, "." + (relPath.startsWith("/") ? relPath : "/" + relPath));
  if (!target.startsWith(DASHBOARD_DIR)) return null;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  const body = fs.readFileSync(target);
  const ext = path.extname(target).toLowerCase();
  const cacheable = relPath.startsWith("/assets/");
  return new Response(body, {
    headers: {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": cacheable ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}

export function dashboardHtml() {
  const index = dashboardFile("/index.html");
  if (index) return index;
  return new Response(
    `<!doctype html><meta charset="utf-8"><body style="font:14px ui-monospace,monospace;background:#0a0b10;color:#dbe4ef;padding:40px">
     <h2 style="color:#7c6cff">pi-hive dashboard not built</h2>
     <p>The dashboard bundle is missing at <code>${DASHBOARD_DIR}</code>.</p>
     <p>Build it once from the pi-hive repository root:</p>
     <pre style="background:#12141c;padding:12px;border-radius:8px">just build-dashboard</pre>
     <p>Then reload this page.</p></body>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
