import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as openspec from "./openspec";
import { applyBrowserSecurityHeaders } from "../observability/security";

// Generic embed layer for the compact review-only UI on pi-hive's dashboard
// server. It runs no per-review process: production streams deterministic gzip
// assets and answers the narrow Plannotator-compatible API contract
// (GET /api/plan + POST /api/approve|deny).
//
// Multiplexing N parallel reviews uses a short-lived capability minted by the
// authenticated dashboard. The iframe URL carries rid, cwd, and a random nonce;
// the vendored client's /api/* calls preserve them in the same-origin Referer.
// Every mutation validates exact Host/Origin/Referer metadata plus the nonce's
// project/change/artifact/hash binding before a hook can run.
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

export type ReviewHookResult = { ok: true } | { ok: false; error: string };

export interface ReviewHooks {
  // Resolve+validate the review context from a rid + the request's cwd param.
  // Returns null when the change is unknown or the cwd is not a known project.
  resolveContext(rid: string, cwdParam: string | null): ReviewContext | null;
  // A non-ok result means the artifact is not ready and maps to HTTP 409.
  onApprove(ctx: ReviewContext, input: ReviewInput, expectedArtifactHash: string, signal?: AbortSignal): ReviewHookResult | Promise<ReviewHookResult>;
  onDeny(ctx: ReviewContext, input: ReviewInput, expectedArtifactHash: string, signal?: AbortSignal): ReviewHookResult | Promise<ReviewHookResult>;
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

interface ReviewSession {
  nonce: string;
  cwd: string;
  change: string;
  artifact: string;
  artifactHash: string;
  expiresAt: number;
  used: boolean;
}

interface ReviewAsset {
  path: string;
  contentType: string;
  etag: string;
}

export interface ReviewSurface {
  mountPath: string; // e.g. "/pl-review/"
  // htmlPath is retained for focused tests and downstream custom surfaces.
  // Production uses the compressed review-only asset map.
  htmlPath?: string;
  assets?: Map<string, ReviewAsset>;
  hooks: ReviewHooks;
  sessions: Map<string, ReviewSession>;
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

// Extract a query parameter from a request Referer that points at a review
// mount, e.g. "http://127.0.0.1:43191/pl-review/?rid=add-auth%23proposal.md".
function reviewParamFromReferer(referer: string | null, mountPath: string, key: string): string | null {
  if (!referer) return null;
  let u: URL;
  try {
    u = new URL(referer);
  } catch {
    return null;
  }
  if (!u.pathname.startsWith(mountPath)) return null;
  return u.searchParams.get(key);
}

export function ridFromReferer(referer: string | null, mountPath: string): string | null {
  return reviewParamFromReferer(referer, mountPath, "rid");
}

export function cwdFromReferer(referer: string | null, mountPath: string): string | null {
  return reviewParamFromReferer(referer, mountPath, "cwd");
}

export function nonceFromReferer(referer: string | null, mountPath: string): string | null {
  return reviewParamFromReferer(referer, mountPath, "nonce");
}

const CAPABILITY_QUERY = {
  rid: "__hive_rid",
  cwd: "__hive_cwd",
  nonce: "__hive_nonce",
} as const;

function reviewRequestParams(req: Request, url: URL, mountPath: string): { rid: string | null; cwd: string | null; nonce: string | null; queryBound: boolean } {
  const referer = req.headers.get("referer");
  const queryValues = {
    rid: url.searchParams.get(CAPABILITY_QUERY.rid),
    cwd: url.searchParams.get(CAPABILITY_QUERY.cwd),
    nonce: url.searchParams.get(CAPABILITY_QUERY.nonce),
  };
  const queryBound = Boolean(queryValues.rid && queryValues.cwd && queryValues.nonce);
  return queryBound
    ? { ...queryValues, queryBound }
    : {
        rid: ridFromReferer(referer, mountPath),
        cwd: cwdFromReferer(referer, mountPath),
        nonce: nonceFromReferer(referer, mountPath),
        queryBound: false,
      };
}

// ---------------------------------------------------------------------------
// Vendored HTML resolution
// ---------------------------------------------------------------------------

let cachedReviewAssets: Map<string, ReviewAsset> | null | undefined;

// Locate the committed, reproducible review-only bundle. Only gzip artifacts
// ship at runtime; manifest hashes become strong ETags without reading the
// bundle into memory on each request.
export function resolveReviewAssets(): Map<string, ReviewAsset> | null {
  if (cachedReviewAssets !== undefined) return cachedReviewAssets;
  let dir: string;
  try { dir = dirname(fileURLToPath(import.meta.url)); } catch { dir = process.cwd(); }
  for (let i = 0; i < 8; i++) {
    const dist = join(dir, "ui", "review", "dist");
    const manifestPath = join(dist, "manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: Record<string, { path?: string; contentType?: string; sha256?: string }> };
        const assets = new Map<string, ReviewAsset>();
        for (const [name, entry] of Object.entries(manifest.files || {})) {
          const assetPath = resolve(dist, String(entry.path || ""));
          if (!entry.path || !entry.contentType || !entry.sha256 || !assetPath.startsWith(`${resolve(dist)}/`) || !safeFile(assetPath)) continue;
          assets.set(name, { path: assetPath, contentType: entry.contentType, etag: `"sha256-${entry.sha256}"` });
        }
        if (assets.has("review.html") && assets.has("review.css") && assets.has("review.js")) return (cachedReviewAssets = assets);
      } catch { /* malformed bundle falls through to unavailable */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (cachedReviewAssets = null);
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

const REVIEW_SESSION_TTL_MS = 10 * 60_000;
const MAX_REVIEW_SESSIONS = 256;
const MAX_REVIEW_BODY_BYTES = 64_000;
const MAX_ANNOTATIONS = 100;
const MAX_FEEDBACK_CHARS = 4_000;
const MAX_QUOTE_CHARS = 1_000;
const MAX_COMMENT_CHARS = 4_000;
const MAX_TYPE_CHARS = 64;
const REVIEW_MUTATION_PATHS = new Set(["/api/approve", "/api/deny", "/api/feedback"]);

function json(data: unknown, status = 200, noStore = false): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (noStore) headers["cache-control"] = "no-store";
  return applyBrowserSecurityHeaders(new Response(JSON.stringify(data), { status, headers }), "api");
}

function exactOriginMetadata(req: Request, url: URL, refererPath: string, queryBound = false): boolean {
  if (req.headers.get("host") !== url.host) return false;
  const origin = req.headers.get("origin");
  // A sandbox without allow-same-origin intentionally sends Origin: null. It is
  // accepted only when the request carries the complete content-bound review
  // capability; ordinary dashboard mutations still require the exact origin.
  if (origin !== url.origin && !(queryBound && origin === "null")) return false;
  if (queryBound) return true;
  const rawReferer = req.headers.get("referer");
  if (!rawReferer) return false;
  try {
    const referer = new URL(rawReferer);
    return referer.origin === url.origin && referer.pathname === refererPath;
  } catch {
    return false;
  }
}

function sessionContextMatches(session: ReviewSession, ctx: ReviewContext): boolean {
  return session.cwd === ctx.cwd && session.change === ctx.change && session.artifact === ctx.artifact;
}

function activeSession(surface: ReviewSurface, nonce: string | null, ctx: ReviewContext): ReviewSession | null {
  if (!nonce) return null;
  const session = surface.sessions.get(nonce);
  if (!session || session.used || session.expiresAt <= Date.now() || !sessionContextMatches(session, ctx)) return null;
  return session;
}

function sessionIsCurrent(session: ReviewSession): boolean {
  return openspec.artifactHash(session.cwd, session.change, session.artifact) === session.artifactHash;
}

function pruneReviewSessions(surface: ReviewSurface): void {
  const now = Date.now();
  for (const [nonce, session] of surface.sessions) {
    if (session.used || session.expiresAt <= now) surface.sessions.delete(nonce);
  }
  while (surface.sessions.size >= MAX_REVIEW_SESSIONS) {
    const oldest = surface.sessions.keys().next().value as string | undefined;
    if (!oldest) break;
    surface.sessions.delete(oldest);
  }
}

// Called by the server's method gate. It recognizes only an already-minted,
// correctly bound review capability. Artifact freshness is intentionally checked
// later so an authenticated stale request reaches the handler and receives 409.
export function isAuthorizedReviewMutation(surface: ReviewSurface, req: Request, url: URL): boolean {
  const requestedMethod = req.method === "OPTIONS" ? req.headers.get("access-control-request-method") : req.method;
  if (requestedMethod !== "POST" || !REVIEW_MUTATION_PATHS.has(url.pathname)) return false;
  const params = reviewRequestParams(req, url, surface.mountPath);
  if (!exactOriginMetadata(req, url, surface.mountPath, params.queryBound) || !params.rid) return false;
  const ctx = surface.hooks.resolveContext(params.rid, params.cwd);
  return !!ctx && !!activeSession(surface, params.nonce, ctx);
}

function emptySse(): Response {
  // Keep-alive stub for the client's SSE probes (/api/external-annotations/stream
  // etc). One comment line then held open; the client tolerates no events.
  return applyBrowserSecurityHeaders(new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": pi-hive-review-stub\n\n"));
    },
  }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } }), "api");
}

function serveCompressedAsset(asset: ReviewAsset, req: Request, connectOrigin?: string): Response {
  const headers: Record<string, string> = {
    "content-type": asset.contentType,
    "content-encoding": "gzip",
    "cache-control": asset.contentType.startsWith("text/html") ? "private, no-cache" : "public, max-age=31536000, immutable",
    etag: asset.etag,
    vary: "Accept-Encoding",
  };
  if (req.headers.get("if-none-match") === asset.etag) {
    return applyBrowserSecurityHeaders(new Response(null, { status: 304, headers }), "review", undefined, connectOrigin);
  }
  if (req.method === "HEAD") return applyBrowserSecurityHeaders(new Response(null, { headers }), "review", undefined, connectOrigin);
  const bun = (globalThis as any).Bun;
  const body = bun?.file ? bun.file(asset.path) : readFileSync(asset.path);
  return applyBrowserSecurityHeaders(new Response(body, { headers }), "review", undefined, connectOrigin);
}

// Legacy raw single-file support for focused tests/downstream integrations.
function serveHtml(htmlPath: string, connectOrigin: string): Response {
  let html: string;
  try {
    html = readFileSync(htmlPath, "utf8");
  } catch {
    return applyBrowserSecurityHeaders(new Response("custom review UI is unavailable", { status: 503, headers: { "cache-control": "no-store" } }), "review");
  }
  // A sandboxed frame has an opaque origin and intentionally sends no useful
  // Referer. Install this tiny bootstrap before the vendored module so its local
  // /api/* fetch/EventSource calls carry the already-minted capability in their
  // query string. No capability is attached to external destinations.
  const scriptNonce = randomUUID().replace(/-/g, "");
  const bootstrap = `<script nonce="${scriptNonce}">(()=>{const p=new URLSearchParams(location.search),k={rid:"${CAPABILITY_QUERY.rid}",cwd:"${CAPABILITY_QUERY.cwd}",nonce:"${CAPABILITY_QUERY.nonce}"};function u(v){const x=new URL(v,location.href);if(x.protocol===location.protocol&&x.host===location.host&&x.pathname.startsWith("/api/")){x.searchParams.set(k.rid,p.get("rid")||"");x.searchParams.set(k.cwd,p.get("cwd")||"");x.searchParams.set(k.nonce,p.get("nonce")||"")}return x}const f=window.fetch.bind(window);window.fetch=(v,o)=>v instanceof Request?f(new Request(u(v.url),v),o):f(u(String(v)),o);const E=window.EventSource;window.EventSource=class extends E{constructor(v,o){super(u(String(v)),o)}}})();</script>`;
  html = /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${bootstrap}`) : `${bootstrap}${html}`;
  // The pinned single-file vendor bundle has one executable module tag. Give it
  // the same nonce; script-looking strings inside syntax-highlighter code must
  // not be rewritten.
  html = html.replace(/<script type="module" crossorigin>/i, `<script type="module" crossorigin nonce="${scriptNonce}">`);
  return applyBrowserSecurityHeaders(new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  }), "review", scriptNonce, connectOrigin);
}

// The minimal GET /api/plan payload the plan surface needs to render. Only
// `plan` is the artifact markdown. The compatibility fields preserve the narrow
// Plannotator plan API contract for downstream custom review surfaces.
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
  }, 200, true);
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readBoundedJson(req: Request): Promise<ParseResult<Record<string, unknown>>> {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return { ok: false, error: "content-type must be application/json" };
  const declared = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_REVIEW_BODY_BYTES) return { ok: false, error: "request body too large" };
  if (!req.body) return { ok: false, error: "json body required" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REVIEW_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, error: "request body too large" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return plainRecord(parsed) ? { ok: true, value: parsed } : { ok: false, error: "json body must be an object" };
  } catch {
    return { ok: false, error: "invalid json body" };
  }
}

function optionalString(body: Record<string, unknown>, keys: string[], max: number): ParseResult<string | undefined> {
  for (const key of keys) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string") return { ok: false, error: `${key} must be a string` };
    const value = body[key] as string;
    if (value.length > max) return { ok: false, error: `${key} is too long` };
    return { ok: true, value };
  }
  return { ok: true, value: undefined };
}

function parseReviewBody(body: Record<string, unknown>): ParseResult<ReviewInput> {
  const feedback = optionalString(body, ["feedback"], MAX_FEEDBACK_CHARS);
  if (feedback.ok === false) return { ok: false, error: feedback.error };
  if (body.annotations !== undefined && !Array.isArray(body.annotations)) return { ok: false, error: "annotations must be an array" };
  const rawAnnotations = (body.annotations || []) as unknown[];
  if (rawAnnotations.length > MAX_ANNOTATIONS) return { ok: false, error: "too many annotations" };
  const annotations: ReviewAnnotation[] = [];
  for (let i = 0; i < rawAnnotations.length; i++) {
    const raw = rawAnnotations[i];
    if (!plainRecord(raw)) return { ok: false, error: `annotations[${i}] must be an object` };
    const type = optionalString(raw, ["type"], MAX_TYPE_CHARS);
    const quote = optionalString(raw, ["quote", "originalText"], MAX_QUOTE_CHARS);
    const comment = optionalString(raw, ["comment", "body", "note"], MAX_COMMENT_CHARS);
    if (type.ok === false) return { ok: false, error: type.error };
    if (quote.ok === false) return { ok: false, error: quote.error };
    if (comment.ok === false) return { ok: false, error: comment.error };
    annotations.push({ type: type.value, quote: quote.value, comment: comment.value });
  }
  return { ok: true, value: { feedback: feedback.value || "", annotations } };
}

// Handle one request against a registered review surface. Mutations reach this
// only after the server's method gate accepts either the daemon bearer token
// (`POST /review-sessions`) or a bound review capability (decision endpoints).
export async function handleReviewSurface(surface: ReviewSurface, req: Request, url: URL): Promise<Response | null> {
  const { mountPath, htmlPath, assets, hooks } = surface;

  // Authenticated dashboard endpoint: mint a bounded capability for exactly the
  // current project/change/artifact bytes. The generic server gate verifies the
  // daemon bearer before this route; strict browser metadata prevents headerless
  // local callers from using a stolen bearer alone.
  if (url.pathname === "/review-sessions" && req.method === "POST") {
    if (!exactOriginMetadata(req, url, "/")) return json({ error: "invalid request origin" }, 403, true);
    const body = await readBoundedJson(req);
    if (body.ok === false) return json({ error: body.error }, 400, true);
    const rid = body.value.rid;
    const cwd = body.value.cwd;
    if (typeof rid !== "string" || !rid || rid.length > 1_000) return json({ error: "rid required" }, 400, true);
    if (cwd !== undefined && (typeof cwd !== "string" || cwd.length > 4_096)) return json({ error: "cwd must be a string" }, 400, true);
    const ctx = hooks.resolveContext(rid, typeof cwd === "string" ? cwd : null);
    if (!ctx) return json({ error: "unknown review" }, 404, true);
    const artifactHash = openspec.artifactHash(ctx.cwd, ctx.change, ctx.artifact);
    if (!artifactHash) return json({ error: "artifact is not reviewable" }, 409, true);
    pruneReviewSessions(surface);
    const nonce = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
    const expiresAt = Date.now() + REVIEW_SESSION_TTL_MS;
    surface.sessions.set(nonce, { nonce, ...ctx, artifactHash, expiresAt, used: false });
    const query = new URLSearchParams({ rid, cwd: ctx.cwd, nonce });
    return json({ nonce, expiresAt: new Date(expiresAt).toISOString(), reviewUrl: `${mountPath}?${query}` }, 201, true);
  }

  // Static review assets contain no capability and are immutable/content-
  // addressed. The HTML remains capability-gated below.
  if (assets && url.pathname.startsWith(`${mountPath}assets/`)) {
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405, true);
    const name = url.pathname.slice(`${mountPath}assets/`.length);
    const asset = assets.get(name);
    return asset ? serveCompressedAsset(asset, req) : json({ error: "not found" }, 404, true);
  }

  // The review HTML is itself capability-gated. A copied/stale URL cannot load
  // artifact content, and the capability never enters the static response body.
  if (url.pathname === mountPath || url.pathname === mountPath.slice(0, -1)) {
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405, true);
    const rid = url.searchParams.get("rid");
    const ctx = rid ? hooks.resolveContext(rid, url.searchParams.get("cwd")) : null;
    if (!ctx) return json({ error: "unknown review" }, 404, true);
    const session = activeSession(surface, url.searchParams.get("nonce"), ctx);
    if (!session) return json({ error: "invalid or expired review session" }, 401, true);
    if (!sessionIsCurrent(session)) return json({ error: "review artifact changed" }, 409, true);
    const bundleHtml = assets?.get("review.html");
    if (bundleHtml) return serveCompressedAsset(bundleHtml, req, url.origin);
    if (htmlPath) return serveHtml(htmlPath, url.origin);
    return applyBrowserSecurityHeaders(new Response("review UI not built — run `just review-build`", { status: 503 }), "review");
  }

  // The vendored client hardcodes absolute /api/* paths. The sandbox bootstrap
  // adds the content-bound capability to those local URLs; legacy/new-tab loads
  // may still provide it through an exact same-origin Referer.
  if (url.pathname.startsWith("/api/")) {
    const params = reviewRequestParams(req, url, mountPath);
    const opaqueCors = params.queryBound && req.headers.get("origin") === "null";
    const respond = (response: Response): Response => {
      if (!opaqueCors) return response;
      response.headers.set("access-control-allow-origin", "null");
      response.headers.set("cross-origin-resource-policy", "cross-origin");
      response.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
      response.headers.set("access-control-allow-headers", "content-type");
      response.headers.append("vary", "Origin");
      return response;
    };
    const requestedMethod = req.method === "OPTIONS" ? req.headers.get("access-control-request-method") : req.method;
    const dedicatedMutation = REVIEW_MUTATION_PATHS.has(url.pathname) && requestedMethod === "POST";
    const rejectOrFallThrough = () => dedicatedMutation ? respond(json({ error: "invalid review request metadata" }, 403, true)) : null;
    if (req.headers.get("host") !== url.host || !params.rid) return rejectOrFallThrough();
    if (!params.queryBound) {
      const refererRaw = req.headers.get("referer");
      let referer: URL;
      try { referer = new URL(refererRaw || ""); } catch { return rejectOrFallThrough(); }
      if (referer.origin !== url.origin || referer.pathname !== mountPath) return rejectOrFallThrough();
    }
    const ctx = hooks.resolveContext(params.rid, params.cwd);
    if (!ctx) return respond(json({ error: "unknown review" }, 404, true));
    const session = activeSession(surface, params.nonce, ctx);
    if (!session) return respond(json({ error: "invalid or expired review session" }, 401, true));
    if (!sessionIsCurrent(session)) return respond(json({ error: "review artifact changed" }, 409, true));

    const p = url.pathname;
    if (req.method === "OPTIONS") {
      const requestedHeaders = (req.headers.get("access-control-request-headers") || "").toLowerCase().split(",").map((header) => header.trim()).filter(Boolean);
      if (!opaqueCors || requestedMethod !== "POST" || requestedHeaders.some((header) => header !== "content-type")) {
        return respond(json({ error: "invalid review preflight" }, 403, true));
      }
      return respond(new Response(null, { status: 204, headers: { "cache-control": "no-store" } }));
    }
    if (p === "/api/plan" && req.method === "GET") return respond(planPayload(ctx));

    if (REVIEW_MUTATION_PATHS.has(p) && req.method === "POST") {
      if (!exactOriginMetadata(req, url, mountPath, params.queryBound)) return respond(json({ error: "invalid request origin" }, 403, true));
      const body = await readBoundedJson(req);
      if (body.ok === false) return respond(json({ error: body.error }, 400, true));
      const parsed = parseReviewBody(body.value);
      if (parsed.ok === false) return respond(json({ error: parsed.error }, 400, true));
      let approve: boolean;
      if (p === "/api/feedback") {
        if (typeof body.value.approved !== "boolean") return respond(json({ error: "approved must be a boolean" }, 400, true));
        approve = body.value.approved;
      } else {
        approve = p === "/api/approve";
      }
      try {
        // Recheck after the asynchronous body read, then pass the expected hash
        // into persistence to close the external-writer race between validation
        // and the atomic approval write.
        if (!sessionIsCurrent(session)) return respond(json({ error: "review artifact changed" }, 409, true));
        const result = await (approve
          ? hooks.onApprove(ctx, parsed.value, session.artifactHash, req.signal)
          : hooks.onDeny(ctx, parsed.value, session.artifactHash, req.signal));
        if (result.ok === false) return respond(json({ error: result.error }, 409, true));
        session.used = true;
        return respond(json({ ok: true }, 200, true));
      } catch (error) {
        if (error instanceof openspec.StaleArtifactApprovalError) return respond(json({ error: error.message }, 409, true));
        if (error instanceof openspec.OpenSpecCommandError) {
          const status = error.code === "timeout" ? 504 : error.code === "cancelled" ? 499 : error.code === "unavailable" ? 503 : 502;
          return respond(json({ error: error.message, code: error.code }, status, true));
        }
        return respond(json({ error: "review persistence failed" }, 500, true));
      }
    }

    // Read-only boot probes used by the vendored client.
    if (req.method !== "GET") return respond(json({ error: "not found" }, 404, true));
    if (p.endsWith("/stream")) return respond(emptySse());
    if (p === "/api/draft") return respond(json({ draft: null }, 200, true));
    if (p === "/api/ai/capabilities") return respond(json({ capabilities: {}, enabled: false }, 200, true));
    return respond(json({}, 200, true));
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
  const htmlPath = input.htmlPath && safeFile(input.htmlPath) ? resolve(input.htmlPath) : undefined;
  const assets = htmlPath ? undefined : resolveReviewAssets() || undefined;
  if (!htmlPath && !assets) return null;
  return { mountPath: input.mountPath, htmlPath, assets, hooks: input.hooks, sessions: new Map() };
}

function safeFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
