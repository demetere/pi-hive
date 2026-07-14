import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBrowserSecurityHeaders, hasExpectedHost, isAuthorizedWrite, isSameOriginRequest, isSameOriginWrite, writeGateResponse } from "../src/observability/security.ts";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:43191/events", { headers });
}

// A request with an explicit method + optional headers, to drive the gate.
function reqM(method: string, headers: Record<string, string> = {}, path = "/events"): Request {
  return new Request(`http://127.0.0.1:43191${path}`, { method, headers });
}

const url = new URL("http://127.0.0.1:43191/events");

test("dashboard Host guard rejects alternate authorities and headerless requests", () => {
  assert.equal(hasExpectedHost(req({ host: "127.0.0.1:43191" }), "127.0.0.1:43191"), true);
  assert.equal(hasExpectedHost(req({ host: "localhost:43191" }), "127.0.0.1:43191"), false);
  assert.equal(hasExpectedHost(req({ host: "evil.example:43191" }), "127.0.0.1:43191"), false);
  assert.equal(hasExpectedHost(req(), "127.0.0.1:43191"), false);
});

test("dashboard same-origin guard allows local/direct requests", () => {
  assert.equal(isSameOriginRequest(req(), url), true);
  assert.equal(isSameOriginRequest(req({ origin: "http://127.0.0.1:43191" }), url), true);
  assert.equal(isSameOriginRequest(req({ "sec-fetch-site": "same-origin" }), url), true);
  assert.equal(isSameOriginWrite(req(), url), true);
});

test("dashboard same-origin guard blocks cross-origin browser requests", () => {
  assert.equal(isSameOriginRequest(req({ origin: "https://evil.example" }), url), false);
  assert.equal(isSameOriginRequest(req({ "sec-fetch-site": "cross-site" }), url), false);
  assert.equal(isSameOriginWrite(req({ origin: "https://evil.example" }), url), false);
});

test("write auth requires the daemon token (Phase D)", () => {
  const token = "a".repeat(64);
  // No Authorization header (e.g. curl) is rejected.
  assert.equal(isAuthorizedWrite(req(), token), false);
  // Wrong token rejected.
  assert.equal(isAuthorizedWrite(req({ authorization: "Bearer wrong" }), token), false);
  // Correct token accepted (case-insensitive scheme).
  assert.equal(isAuthorizedWrite(req({ authorization: `Bearer ${token}` }), token), true);
  assert.equal(isAuthorizedWrite(req({ authorization: `bearer ${token}` }), token), true);
  // Missing production credentials fail closed rather than disabling auth.
  assert.equal(isAuthorizedWrite(req(), ""), false);
});

test("write gate rejects any non-GET/HEAD method without a token (M8c/J7)", () => {
  const token = "a".repeat(64);
  const reject = (error: string, status: number) => new Response(JSON.stringify({ error }), { status });
  const gate = (r: Request) => writeGateResponse(r, new URL(r.url), token, reject);

  // GET / HEAD are safe reads — never gated (even to a would-be write path).
  assert.equal(gate(reqM("GET")), null);
  assert.equal(gate(reqM("HEAD")), null);

  // Every mutating method is gated by the SAME code path, so a future PUT/PATCH
  // is covered without a per-route check. Without a token → 401.
  for (const method of ["PUT", "PATCH", "POST", "DELETE"]) {
    const res = gate(reqM(method, {}, "/anything"));
    assert.ok(res, `${method} should be gated`);
    assert.equal(res!.status, 401);
  }

  // With the correct token, the gate lets the write proceed (null = continue).
  assert.equal(gate(reqM("PUT", { authorization: `Bearer ${token}` })), null);
  assert.equal(gate(reqM("PATCH", { authorization: `Bearer ${token}` })), null);
  // A separately validated narrow capability can authorize one route without
  // weakening empty-token behavior for ordinary writes.
  assert.equal(writeGateResponse(reqM("POST"), new URL(reqM("POST").url), "", reject, true), null);
  const opaqueCapability = reqM("POST", { origin: "null" });
  assert.equal(writeGateResponse(opaqueCapability, new URL(opaqueCapability.url), "", reject, true), null);
  const opaquePreflight = reqM("OPTIONS", { origin: "null", "access-control-request-method": "POST" });
  assert.equal(writeGateResponse(opaquePreflight, new URL(opaquePreflight.url), "", reject, true), null);

  // Cross-origin mutations are blocked at 403 before the token is even checked.
  const xorigin = gate(reqM("PUT", { origin: "https://evil.example" }));
  assert.ok(xorigin);
  assert.equal(xorigin!.status, 403);
});

test("browser security headers constrain framing, content, and local connections", () => {
  const dashboard = applyBrowserSecurityHeaders(new Response("ok"), "dashboard");
  const csp = dashboard.headers.get("content-security-policy") || "";
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(dashboard.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(dashboard.headers.get("x-content-type-options"), "nosniff");
  assert.equal(dashboard.headers.get("referrer-policy"), "same-origin");
  assert.equal(dashboard.headers.get("cross-origin-opener-policy"), "same-origin");

  const review = applyBrowserSecurityHeaders(new Response("ok"), "review", "abc123", "http://127.0.0.1:43191");
  const reviewCsp = review.headers.get("content-security-policy") || "";
  assert.match(reviewCsp, /default-src 'none'/);
  assert.match(reviewCsp, /script-src-attr 'none'/);
  assert.match(reviewCsp, /connect-src http:\/\/127\.0\.0\.1:43191/);
  assert.match(reviewCsp, /frame-src 'none'/);
  assert.equal(review.headers.get("referrer-policy"), "no-referrer");
});
