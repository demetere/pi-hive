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
  if (!isSameOriginWrite(req, url)) return reject("cross-origin write blocked", 403);
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
