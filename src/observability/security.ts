export function isSameOriginRequest(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return false;
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") return false;
  return true;
}

export const isSameOriginWrite = isSameOriginRequest;

// Phase D: per-daemon bearer token on writes. `curl` sends no Origin so the
// same-origin check alone lets any local process POST — an unauthenticated
// prompt-injection primitive. Requiring the token closes it; same-origin is
// kept as belt-and-braces. An empty configured token disables the check (tests
// / explicit local-only setups that never mint one).
export function isAuthorizedWrite(req: Request, token: string): boolean {
  if (!token) return true;
  const header = req.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? timingSafeEqualStr(match[1].trim(), token) : false;
}

// Constant-time-ish string compare to avoid leaking the token via timing. Length
// mismatch short-circuits (token length is not secret).
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
