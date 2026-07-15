#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CRITICAL_CORE_MODULES = [
  "src/engine/dashboard.ts",
  "src/engine/process.ts",
  "src/engine/review.ts",
  "src/integration/commands.ts",
  "src/integration/hooks.ts",
  "src/observability/agent-log.ts",
];

export const CRITICAL_LINE_THRESHOLD = 90;

export function checkCriticalCoverage(summary, modules = CRITICAL_CORE_MODULES, threshold = CRITICAL_LINE_THRESHOLD) {
  const entries = Object.entries(summary).filter(([file]) => file !== "total");
  const failures = [];
  const results = [];

  for (const modulePath of modules) {
    const match = entries.find(([file]) => file.replaceAll("\\", "/").endsWith(`/${modulePath}`));
    if (!match) {
      failures.push(`${modulePath}: missing from coverage report`);
      continue;
    }
    const pct = Number(match[1]?.lines?.pct);
    results.push({ modulePath, pct });
    if (!Number.isFinite(pct) || pct < threshold) failures.push(`${modulePath}: ${Number.isFinite(pct) ? pct : "invalid"}% lines (requires ${threshold}%)`);
  }

  return { results, failures };
}

function main() {
  const summaryPath = resolve(process.argv[2] || "coverage/core/coverage-summary.json");
  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (error) {
    console.error(`Critical coverage check could not read ${summaryPath}: ${error?.message || error}`);
    process.exitCode = 1;
    return;
  }

  const { results, failures } = checkCriticalCoverage(summary);
  for (const result of results) console.log(`${result.modulePath}: ${result.pct}% lines`);
  if (failures.length) {
    console.error(`Critical coverage gate failed:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Critical core coverage gate passed (${CRITICAL_LINE_THRESHOLD}% lines per module).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
