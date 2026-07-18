import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeNetworkTargets, classifyNetworkTarget } from "../src/capabilities/network.ts";

test("public network requires an explicit grant", () => {
  assert.equal(authorizeNetworkTargets(["https://example.com"], false).ok, false);
  assert.equal(authorizeNetworkTargets(["https://example.com"], true).ok, true);
});

test("protected network zones remain denied regardless of grant", () => {
  for (const target of ["http://127.0.0.1:43191", "http://localhost", "http://[::1]", "http://10.1.2.3", "http://172.16.1.1", "http://192.168.1.1", "http://169.254.169.254/latest/meta-data", "http://metadata.google.internal", "unix:///tmp/socket", "ssh://user@localhost"])
    assert.equal(classifyNetworkTarget(target).zone, "protected", target);
});

test("host resolution evidence fails closed on private rebinding results", () => {
  assert.equal(authorizeNetworkTargets(["https://public.example"], true, { "public.example": ["203.0.113.4"] }).ok, true);
  assert.equal(authorizeNetworkTargets(["https://public.example"], true, { "public.example": ["127.0.0.1"] }).ok, false);
  assert.equal(authorizeNetworkTargets(["not a target"], true).ok, false);
});
