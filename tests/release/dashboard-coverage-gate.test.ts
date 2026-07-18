import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const SCRIPT = resolve("scripts/check-dashboard-coverage.mjs");
const MODULES = [
  "ui/web/src/components/ConfirmModal.tsx",
  "ui/web/src/components/Sidebar.tsx",
  "ui/web/src/store/event-ring.ts",
  "ui/web/src/store/history.ts",
  "ui/web/src/store/identity.ts",
  "ui/web/src/store/status.ts",
  "ui/web/src/store/topology.ts",
];

function run(percentages: Record<string, number>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-dashboard-coverage-"));
  const summary = Object.fromEntries(Object.entries(percentages).map(([file, pct]) => [
    `/checkout/${file}`,
    { lines: { pct } },
  ]));
  const path = join(dir, "coverage-summary.json");
  writeFileSync(path, JSON.stringify({ total: { lines: { pct: 100 } }, ...summary }));
  return spawnSync(process.execPath, [SCRIPT, path], { encoding: "utf8" });
}

test("dashboard coverage gate accepts critical stores and components at 90 percent", () => {
  const result = run(Object.fromEntries(MODULES.map((file) => [file, 90])));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Critical dashboard coverage gate passed/);
});

test("dashboard coverage gate rejects low and missing critical modules", () => {
  const low = Object.fromEntries(MODULES.map((file) => [file, file.endsWith("status.ts") ? 89.99 : 100]));
  const failed = run(low);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /status\.ts: 89\.99% lines/);

  const missing = run(Object.fromEntries(MODULES.slice(1).map((file) => [file, 100])));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ConfirmModal\.tsx: missing/);
});
