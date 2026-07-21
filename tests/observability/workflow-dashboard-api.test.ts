import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORKFLOW_DASHBOARD_API_VERSION,
  WORKFLOW_DASHBOARD_MAX_PAGE_SIZE,
} from "../../src/shared/dashboard-api.ts";

test("workflow dashboard DTO contract is versioned and bounded for W25 consumers", () => {
  assert.equal(WORKFLOW_DASHBOARD_API_VERSION, 1);
  assert.equal(WORKFLOW_DASHBOARD_MAX_PAGE_SIZE, 500);
});
