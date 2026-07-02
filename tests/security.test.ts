import assert from "node:assert/strict";
import { test } from "node:test";
import { isAuthorizedWrite, isSameOriginRequest, isSameOriginWrite, writeGateResponse } from "../src/observability/security.ts";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:43191/events", { headers });
}

// A request with an explicit method + optional headers, to drive the gate.
function reqM(method: string, headers: Record<string, string> = {}, path = "/events"): Request {
  return new Request(`http://127.0.0.1:43191${path}`, { method, headers });
}

const url = new URL("http://127.0.0.1:43191/events");

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
  // An empty configured token disables the check (local-only / tests).
  assert.equal(isAuthorizedWrite(req(), ""), true);
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

  // Cross-origin mutations are blocked at 403 before the token is even checked.
  const xorigin = gate(reqM("PUT", { origin: "https://evil.example" }));
  assert.ok(xorigin);
  assert.equal(xorigin!.status, 403);
});
