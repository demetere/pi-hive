import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { dashboardHost } from "../../src/engine/dashboard.ts";

const priorHost = process.env.HIVE_TELEMETRY_HOST;
const priorOverride = process.env.HIVE_TELEMETRY_ALLOW_NON_LOOPBACK;
afterEach(() => {
  if (priorHost === undefined) delete process.env.HIVE_TELEMETRY_HOST; else process.env.HIVE_TELEMETRY_HOST = priorHost;
  if (priorOverride === undefined) delete process.env.HIVE_TELEMETRY_ALLOW_NON_LOOPBACK; else process.env.HIVE_TELEMETRY_ALLOW_NON_LOOPBACK = priorOverride;
});

test("first-release dashboard binding cannot be widened by an environment override", () => {
  process.env.HIVE_TELEMETRY_HOST = "192.168.1.9";
  process.env.HIVE_TELEMETRY_ALLOW_NON_LOOPBACK = "1";
  assert.throws(() => dashboardHost(), /non-loopback/i);
});

test("dashboard accepts only explicit loopback host spellings", () => {
  for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
    process.env.HIVE_TELEMETRY_HOST = host;
    assert.ok(["127.0.0.1", "localhost", "::1"].includes(dashboardHost()));
  }
});
