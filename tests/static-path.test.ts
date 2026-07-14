import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardFile } from "../src/observability/static.ts";

test("dashboard documents and assets carry secure cache and browser headers", async () => {
  const html = dashboardFile("/index.html");
  assert.ok(html);
  assert.equal(html.headers.get("cache-control"), "no-store");
  assert.equal(html.headers.get("x-content-type-options"), "nosniff");
  assert.equal(html.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(html.headers.get("content-security-policy") || "", /frame-ancestors 'self'/);

  // The exact hashed filename changes with dashboard builds; validate an asset
  // referenced by the committed index.
  const path = /(?:src|href)="(\/assets\/[^"]+)"/.exec(await html.text())?.[1];
  assert.ok(path);
  const asset = dashboardFile(path!);
  assert.ok(asset);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
});

test("dashboard static files reject traversal and sibling-prefix paths", () => {
  assert.equal(dashboardFile("/../package.json"), null);
  assert.equal(dashboardFile("/../../ui/web/package.json"), null);
  assert.equal(dashboardFile("/assets/../../../SECURITY.md"), null);
});
