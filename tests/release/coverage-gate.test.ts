import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const SCRIPT = resolve("scripts/check-critical-coverage.mjs");
const MODULES = [
  "src/integration/run-lifecycle.ts",
  "src/integration/workflow-command-service.ts",
  "src/integration/workflow-commands.ts",
  "src/integration/workflow-tools.ts",
  "src/workflows/runs.ts",
  "src/workflows/tools.ts",
];

function runCoverageGate(percentages: Record<string, number>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-critical-coverage-"));
  const summary = Object.fromEntries(Object.entries(percentages).map(([file, pct]) => [
    `/checkout/${file}`,
    { lines: { pct } },
  ]));
  const path = join(dir, "coverage-summary.json");
  writeFileSync(path, JSON.stringify({ total: { lines: { pct: 100 } }, ...summary }));
  return spawnSync(process.execPath, [SCRIPT, path], { encoding: "utf8" });
}

test("critical coverage gate accepts every required module at 90 percent", () => {
  const result = runCoverageGate(Object.fromEntries(MODULES.map((file) => [file, 90])));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Critical core coverage gate passed/);
});

test("critical coverage gate rejects low and missing modules", () => {
  const low = Object.fromEntries(MODULES.map((file) => [file, file.endsWith("workflow-commands.ts") ? 89.99 : 100]));
  const failed = runCoverageGate(low);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /workflow-commands\.ts: 89\.99% lines/);

  const missing = runCoverageGate(Object.fromEntries(MODULES.slice(1).map((file) => [file, 100])));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /run-lifecycle\.ts: missing/);
});
