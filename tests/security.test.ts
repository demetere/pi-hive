import assert from "node:assert/strict";
import { test } from "node:test";
import { isAuthorizedWrite, isSameOriginRequest, isSameOriginWrite } from "../src/observability/security.ts";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:43191/events", { headers });
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
