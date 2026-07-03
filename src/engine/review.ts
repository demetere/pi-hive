import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as openspec from "./openspec";

// Generic embed layer for self-hosting a prebuilt single-file review UI
// (Plannotator) on pi-hive's own dashboard server. It runs NO Plannotator
// process: it static-serves the vendored HTML and answers the small set of
// /api/* calls the review surface makes (proven by the endpoint spike:
// GET /api/plan + POST /api/approve|deny are load-bearing; the rest degrade on
// benign stubs).
//
// Multiplexing N parallel reviews with one origin-root mount is done by the
// REFERER header, because the prebuilt client hardcodes absolute /api/... paths
// with no base-href or runtime config. The iframe loads
//   /pl-review/?rid=<changeName#artifact>
// so every /api/* request from inside it carries
//   Referer: .../pl-review/?rid=<changeName#artifact>
// which we parse to know which review it belongs to. We set
// Referrer-Policy: same-origin on the HTML response so the query survives.
//
// The surface is transport-agnostic: SQLite verdict persistence and the
// dashboard-actions bridge (both Bun-only) are injected as callbacks by the
// server, so this module stays free of Bun imports and loads in the core.

export interface ReviewContext {
  // Absolute project cwd this review belongs to (already validated by the
  // server against known telemetry projects).
  cwd: string;
  // The OpenSpec change name.
  change: string;
  // The artifact within the change, e.g. "proposal.md" (defaults to proposal.md).
  artifact: string;
}

export interface ReviewHooks {
  // Resolve+validate the review context from a rid + the request's cwd param.
  // Returns null when the change is unknown or the cwd is not a known project.
  resolveContext(rid: string, cwdParam: string | null): ReviewContext | null;
  // Record an approve verdict (pi-hive owns the gate) and unblock the planner.
  onApprove(ctx: ReviewContext, input: ReviewInput): void;
  // Record a deny verdict and route feedback back to the planner; gate holds.
  onDeny(ctx: ReviewContext, input: ReviewInput): void;
}

// One inline annotation the human left on a specific span of the artifact.
export interface ReviewAnnotation {
  type?: string;    // comment | deletion | looks_good | …
  quote?: string;   // the anchored text span
  comment?: string; // the human's note on that span
}

// The reviewer's input on a decision: a top-level note plus any per-location
// inline annotations, so a denial can carry precise "line X: fix this" feedback.
export interface ReviewInput {
  feedback: string;
  annotations: ReviewAnnotation[];
}

// Render structured review input into the message a planner receives, so the
// anchored comments survive the round-trip to the agent.
export function renderReviewInput(input: ReviewInput): string {
  const parts: string[] = [];
  if (input.feedback.trim()) parts.push(input.feedback.trim());
  for (const a of input.annotations) {
    const note = (a.comment || "").trim();
    const quote = (a.quote || "").trim();
    if (!note && !quote) continue;
    parts.push(quote ? `- on "${quote.slice(0, 120)}": ${note || "(marked)"}` : `- ${note}`);
  }
  return parts.join("\n");
}

export interface ReviewSurface {
  mountPath: string; // e.g. "/pl-review/"
  htmlPath: string; // absolute path to the vendored single-file HTML
  hooks: ReviewHooks;
}

// ---------------------------------------------------------------------------
// rid parsing
// ---------------------------------------------------------------------------

export interface Rid {
  change: string;
  artifact: string;
}

// rid = "<changeName>#<artifact>". Artifact defaults to proposal.md.
export function parseRid(rid: string): Rid | null {
  const raw = (rid || "").trim();
  if (!raw) return null;
  const hash = raw.indexOf("#");
  const change = hash === -1 ? raw : raw.slice(0, hash);
  const artifact = hash === -1 ? "proposal.md" : raw.slice(hash + 1);
  if (!openspec.isSafeChangeId(change)) return null;
  return { change, artifact: artifact || "proposal.md" };
}

// Extract rid from a request Referer that points at a review mount, e.g.
// "http://127.0.0.1:43191/pl-review/?rid=add-auth%23proposal.md".
export function ridFromReferer(referer: string | null, mountPath: string): string | null {
  if (!referer) return null;
  let u: URL;
  try {
    u = new URL(referer);
  } catch {
    return null;
  }
  if (!u.pathname.startsWith(mountPath)) return null;
  return u.searchParams.get("rid");
}

// ---------------------------------------------------------------------------
// Vendored HTML resolution
// ---------------------------------------------------------------------------

let cachedHtmlPath: string | null | undefined;

// Locate the committed, vendored Plannotator HTML (ui/web/vendor/plannotator.html)
// by walking up from this module toward the extension root. Cached.
export function resolveVendoredHtml(): string | null {
  if (cachedHtmlPath !== undefined) return cachedHtmlPath;
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = process.cwd();
  }
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "ui", "web", "vendor", "plannotator.html");
    if (existsSync(candidate)) return (cachedHtmlPath = candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (cachedHtmlPath = null);
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function emptySse(): Response {
  // Keep-alive stub for the client's SSE probes (/api/external-annotations/stream
  // etc). One comment line then held open; the client tolerates no events.
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": pi-hive-review-stub\n\n"));
    },
  }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function serveHtml(htmlPath: string): Response {
  let html: string;
  try {
    html = readFileSync(htmlPath, "utf8");
  } catch {
    return new Response("review UI not vendored — run `just dashboard-vendor`", { status: 503 });
  }
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Keep the rid query on the Referer for the iframe's /api/* calls, but only
      // for our own origin.
      "referrer-policy": "same-origin",
      "cache-control": "no-cache",
    },
  });
}

// The minimal GET /api/plan payload the plan surface needs to render. Only
// `plan` (artifact markdown) is strictly required; the rest mirror the shape the
// prebuilt bundle expects (from Plannotator serverPlan.ts) so it boots cleanly.
function planPayload(ctx: ReviewContext): Response {
  const markdown = openspec.readArtifact(ctx.cwd, ctx.change, ctx.artifact);
  return json({
    plan: markdown || `# ${ctx.change}\n\n_Artifact ${ctx.artifact} is not yet authored._`,
    origin: "pi",
    permissionMode: "default",
    previousPlan: null,
    versionInfo: { current: 1, total: 1 },
    sharingEnabled: false,
    shareBaseUrl: null,
    pasteApiUrl: null,
    repoInfo: null,
    projectRoot: ctx.cwd,
    serverConfig: { displayName: "pi-hive", conventionalComments: false, diffOptions: {} },
  });
}

function parseReviewBody(body: Record<string, unknown>): ReviewInput {
  const feedback = typeof body?.feedback === "string" ? body.feedback : "";
  const annotations: ReviewAnnotation[] = Array.isArray(body?.annotations)
    ? body.annotations
        .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
        .map((a) => ({
          type: typeof a.type === "string" ? a.type : undefined,
          quote: typeof a.quote === "string" ? a.quote : typeof a.originalText === "string" ? a.originalText : undefined,
          comment: typeof a.comment === "string" ? a.comment : typeof a.body === "string" ? a.body : typeof a.note === "string" ? a.note : undefined,
        }))
    : [];
  return { feedback, annotations };
}

async function readReviewInput(req: Request): Promise<ReviewInput> {
  try {
    return parseReviewBody((await req.json()) as Record<string, unknown>);
  } catch {
    return { feedback: "", annotations: [] };
  }
}

async function readDecision(req: Request): Promise<{ approved: boolean; input: ReviewInput }> {
  try {
    const body = (await req.json()) as { approved?: unknown } & Record<string, unknown>;
    return { approved: body?.approved === true, input: parseReviewBody(body) };
  } catch {
    return { approved: false, input: { feedback: "", annotations: [] } };
  }
}

// Handle one request against a registered review surface. Returns null if the
// path does not belong to this surface (so the server continues its own
// routing). The server calls this EARLY — before its bearer-token write gate —
// so the prebuilt client (which cannot send our token) still reaches these
// handlers. The relaxed token policy is contained to same-origin review calls:
// the caller must apply its own same-origin guard.
export async function handleReviewSurface(surface: ReviewSurface, req: Request, url: URL): Promise<Response | null> {
  const { mountPath, htmlPath, hooks } = surface;

  // 1) The mount itself (and anything under it) -> serve the SPA shell.
  if (url.pathname === mountPath || url.pathname.startsWith(mountPath)) {
    return serveHtml(htmlPath);
  }

  // 2) /api/* — only claim it when the Referer is THIS surface, so the review
  // client's absolute /api/... calls route here while the dashboard's own API is
  // untouched.
  if (url.pathname.startsWith("/api/")) {
    const rid = ridFromReferer(req.headers.get("referer"), mountPath);
    if (rid === null) return null; // not from our iframe — let the server handle it
    const ctx = hooks.resolveContext(rid, url.searchParams.get("cwd"));

    const p = url.pathname;
    if (p === "/api/plan" && req.method === "GET") {
      if (!ctx) return json({ error: "unknown review" }, 404);
      return planPayload(ctx);
    }
    if (p === "/api/approve" && req.method === "POST") {
      if (!ctx) return json({ error: "unknown review" }, 404);
      hooks.onApprove(ctx, await readReviewInput(req));
      return json({ ok: true });
    }
    if (p === "/api/deny" && req.method === "POST") {
      if (!ctx) return json({ error: "unknown review" }, 404);
      hooks.onDeny(ctx, await readReviewInput(req));
      return json({ ok: true });
    }
    // The plan surface can also settle a decision via /api/feedback, which
    // carries an `approved` flag + annotations. Route it to the right hook.
    if (p === "/api/feedback" && req.method === "POST") {
      if (!ctx) return json({ error: "unknown review" }, 404);
      const { approved, input } = await readDecision(req);
      if (approved) hooks.onApprove(ctx, input);
      else hooks.onDeny(ctx, input);
      return json({ ok: true });
    }
    // Benign stubs for the boot probes + everything else the bundle may call.
    if (p.endsWith("/stream")) return emptySse();
    if (p === "/api/draft") return json({ draft: null });
    if (p === "/api/ai/capabilities") return json({ capabilities: {}, enabled: false });
    if (req.method === "GET") return json({});
    return json({ ok: true });
  }

  return null;
}

// Register a review surface, resolving its HTML path if not given. Returned
// object is handed to the server, which calls handleReviewSurface for each
// request. Generic so code review (review-editor.html at /pl-code/) plugs in
// later with the same shape.
export function registerReviewSurface(input: {
  mountPath: string;
  htmlPath?: string;
  hooks: ReviewHooks;
}): ReviewSurface | null {
  const htmlPath = input.htmlPath ?? resolveVendoredHtml();
  if (!htmlPath || !safeFile(htmlPath)) return null;
  return { mountPath: input.mountPath, htmlPath: resolve(htmlPath), hooks: input.hooks };
}

function safeFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
