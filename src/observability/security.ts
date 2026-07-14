export type BrowserSecurityProfile = "dashboard" | "review" | "api";

const DASHBOARD_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self' blob:",
].join("; ");

// The vendored review bundle is a single HTML file with inline module/style
// payloads. Each legitimate script element receives a per-response nonce;
// event-handler attributes remain forbidden so hostile Markdown cannot execute
// `onerror`-style script. Network, nested frames, forms, objects, and base-URL
// changes stay local or disabled; external font/update/share probes fail closed.
function reviewCsp(scriptNonce?: string, connectOrigin?: string): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'none'",
    `script-src ${scriptNonce ? `'nonce-${scriptNonce}' 'strict-dynamic' 'wasm-unsafe-eval'` : "'none'"}`,
    "script-src-attr 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectOrigin || "'none'"}`,
    "frame-src 'none'",
    "worker-src blob:",
  ].join("; ");
}

export function applyBrowserSecurityHeaders(response: Response, profile: BrowserSecurityProfile, scriptNonce?: string, connectOrigin?: string): Response {
  response.headers.set("content-security-policy", profile === "review" ? reviewCsp(scriptNonce, connectOrigin) : DASHBOARD_CSP);
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", profile === "review" ? "no-referrer" : "same-origin");
  response.headers.set("cross-origin-opener-policy", "same-origin");
  response.headers.set("cross-origin-resource-policy", "same-origin");
  response.headers.set("x-frame-options", "SAMEORIGIN");
  response.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (profile === "api" && !response.headers.has("cache-control")) response.headers.set("cache-control", "no-store");
  return response;
}

export function hasExpectedHost(req: Request, expectedHost: string): boolean {
  const actual = req.headers.get("host")?.trim().toLowerCase();
  return Boolean(actual) && actual === expectedHost.trim().toLowerCase();
}

export function isSameOriginRequest(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return false;
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") return false;
  return true;
}

export const isSameOriginWrite = isSameOriginRequest;

// Per-daemon bearer token on writes. `curl` sends no Origin so the same-origin
// check alone lets any local process POST. Empty/missing credentials always fail
// closed; production must never silently turn authentication off.
export function isAuthorizedWrite(req: Request, token: string): boolean {
  if (!token) return false;
  const header = req.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? timingSafeEqualStr(match[1].trim(), token) : false;
}

// The method-based write gate (J7/Decision 3), factored out of the server's
// fetch handler so it is unit-testable in isolation (M8c). Any method other than
// GET/HEAD is a mutation and must clear same-origin + the bearer token, exactly
// once, before routing — this closes the hole where a future PUT/PATCH endpoint
// would land outside a per-route check. Returns a rejection Response, or null to
// proceed. `reject` builds the error body so the server keeps its json() shape.
export function writeGateResponse(
  req: Request,
  url: URL,
  token: string,
  reject: (error: string, status: number) => Response,
  capabilityAuthorized = false,
): Response | null {
  const isWrite = req.method !== "GET" && req.method !== "HEAD";
  if (!isWrite) return null;
  // A review iframe deliberately runs with an opaque sandbox origin. Its narrow,
  // content-bound capability performs its own Host/origin/nonce checks and may
  // therefore pass without the dashboard bearer. All ordinary writes still
  // require both same-origin metadata and the bearer token.
  if (!capabilityAuthorized && !isSameOriginWrite(req, url)) return reject("cross-origin write blocked", 403);
  if (!capabilityAuthorized && !isAuthorizedWrite(req, token)) return reject("unauthorized", 401);
  return null;
}

// Constant-time-ish string compare to avoid leaking the token via timing. Length
// mismatch short-circuits (token length is not secret).
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
