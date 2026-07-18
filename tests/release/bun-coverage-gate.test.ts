import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const SCRIPT = resolve("scripts/check-bun-coverage.mjs");
const THRESHOLDS: Record<string, number> = {
  "src/observability/server/config.ts": 90,
  "src/observability/server/db.ts": 90,
  "src/observability/server/http-handler.ts": 90,
  "src/observability/server/jsonl-reader.ts": 90,
  "src/observability/server/plan-bridge.ts": 90,
  "src/observability/server/plan-routes.ts": 90,
  "src/observability/server/review-wiring.ts": 90,
  "src/observability/server/runtime.ts": 90,
  "src/observability/server/sse.ts": 90,
  "src/observability/server/topology-hash.ts": 90,
};

function run(percentages: Record<string, number>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-bun-coverage-"));
  const lcov = Object.entries(percentages).map(([file, pct]) => {
    const hit = Math.floor(pct);
    return `SF:${file}\nLF:100\nLH:${hit}\nend_of_record\n`;
  }).join("");
  const path = join(dir, "lcov.info");
  writeFileSync(path, lcov);
  return spawnSync(process.execPath, [SCRIPT, path], { encoding: "utf8" });
}

test("Bun server coverage gate accepts every enforced threshold", () => {
  const result = run(Object.fromEntries(Object.entries(THRESHOLDS).map(([file, threshold]) => [file, threshold])));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Bun server coverage gates passed/);
});

test("Bun server coverage gate rejects low and missing runtime coverage", () => {
  const low = { ...THRESHOLDS, "src/observability/server/runtime.ts": 89 };
  const failed = run(low);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /runtime\.ts: 89\.00% lines/);

  const { "src/observability/server/runtime.ts": _missing, ...withoutRuntime } = THRESHOLDS;
  const missing = run(withoutRuntime);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /runtime\.ts: missing/);
});
