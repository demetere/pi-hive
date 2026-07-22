export type BrowserSecurityProfile = "dashboard" | "api";

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

export function applyBrowserSecurityHeaders(response: Response, _profile: BrowserSecurityProfile): Response {
  response.headers.set("content-security-policy", DASHBOARD_CSP);
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "same-origin");
  response.headers.set("cross-origin-opener-policy", "same-origin");
  response.headers.set("cross-origin-resource-policy", "same-origin");
  response.headers.set("x-frame-options", "SAMEORIGIN");
  response.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (_profile === "api" && !response.headers.has("cache-control")) response.headers.set("cache-control", "no-store");
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

/** Browser mutation proof. A custom header plus exact same-origin metadata prevents form CSRF. */
export function isAuthorizedCsrf(req: Request, token: string): boolean {
  const value = req.headers.get("x-pi-hive-csrf")?.trim() ?? "";
  return Boolean(token) && timingSafeEqualStr(value, token);
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
