import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardFile } from "../src/observability/static.ts";

test("dashboard static files reject traversal and sibling-prefix paths", () => {
  assert.equal(dashboardFile("/../package.json"), null);
  assert.equal(dashboardFile("/../../ui/web/package.json"), null);
  assert.equal(dashboardFile("/assets/../../../SECURITY.md"), null);
});
