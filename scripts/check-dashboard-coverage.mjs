#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CRITICAL_DASHBOARD_MODULES = [
  "ui/web/src/components/ConfirmModal.tsx",
  "ui/web/src/components/Sidebar.tsx",
  "ui/web/src/store/event-ring.ts",
  "ui/web/src/store/history.ts",
  "ui/web/src/store/identity.ts",
  "ui/web/src/store/status.ts",
  "ui/web/src/store/topology.ts",
];

export const DASHBOARD_LINE_THRESHOLD = 90;

export function checkDashboardCoverage(summary, modules = CRITICAL_DASHBOARD_MODULES, threshold = DASHBOARD_LINE_THRESHOLD) {
  const entries = Object.entries(summary).filter(([file]) => file !== "total");
  const results = [];
  const failures = [];
  for (const modulePath of modules) {
    const normalized = modulePath.replaceAll("\\", "/");
    const match = entries.find(([file]) => {
      const candidate = file.replaceAll("\\", "/");
      return candidate === normalized || candidate.endsWith(`/${normalized}`);
    });
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
  const summaryPath = resolve(process.argv[2] || "coverage/dashboard/coverage-summary.json");
  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (error) {
    console.error(`Dashboard coverage check could not read ${summaryPath}: ${error?.message || error}`);
    process.exitCode = 1;
    return;
  }
  const { results, failures } = checkDashboardCoverage(summary);
  for (const result of results) console.log(`${result.modulePath}: ${result.pct}% lines`);
  if (failures.length) {
    console.error(`Dashboard coverage gate failed:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Critical dashboard coverage gate passed (${DASHBOARD_LINE_THRESHOLD}% lines per module).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
