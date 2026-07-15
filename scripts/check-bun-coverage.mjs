#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BUN_LINE_THRESHOLDS = {
  "src/observability/server/config.ts": 90,
  "src/observability/server/db.ts": 90,
  "src/observability/server/http-handler.ts": 90,
  "src/observability/server/jsonl-reader.ts": 90,
  "src/observability/server/plan-routes.ts": 90,
  "src/observability/server/runtime.ts": 80,
  "src/observability/server/topology-hash.ts": 90,
};

export function parseLcovLines(lcov) {
  const results = new Map();
  for (const block of lcov.split("end_of_record")) {
    const file = /^SF:(.+)$/m.exec(block)?.[1]?.replaceAll("\\", "/");
    if (!file) continue;
    const found = Number(/^LF:(\d+)$/m.exec(block)?.[1]);
    const hit = Number(/^LH:(\d+)$/m.exec(block)?.[1]);
    results.set(file, { found, hit, pct: found > 0 ? (hit / found) * 100 : 100 });
  }
  return results;
}

export function checkBunCoverage(lcov, thresholds = BUN_LINE_THRESHOLDS) {
  const coverage = parseLcovLines(lcov);
  const results = [];
  const failures = [];
  for (const [modulePath, threshold] of Object.entries(thresholds)) {
    const match = Array.from(coverage.entries()).find(([file]) => file === modulePath || file.endsWith(`/${modulePath}`));
    if (!match) {
      failures.push(`${modulePath}: missing from coverage report`);
      continue;
    }
    const pct = match[1].pct;
    results.push({ modulePath, pct, threshold });
    if (!Number.isFinite(pct) || pct < threshold) failures.push(`${modulePath}: ${Number.isFinite(pct) ? pct.toFixed(2) : "invalid"}% lines (requires ${threshold}%)`);
  }
  return { results, failures };
}

function main() {
  const lcovPath = resolve(process.argv[2] || "coverage/bun/lcov.info");
  let lcov;
  try {
    lcov = readFileSync(lcovPath, "utf8");
  } catch (error) {
    console.error(`Bun coverage check could not read ${lcovPath}: ${error?.message || error}`);
    process.exitCode = 1;
    return;
  }
  const { results, failures } = checkBunCoverage(lcov);
  for (const result of results) console.log(`${result.modulePath}: ${result.pct.toFixed(2)}% lines (requires ${result.threshold}%)`);
  if (failures.length) {
    console.error(`Bun coverage gate failed:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("Bun server coverage gates passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
