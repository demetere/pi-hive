#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// W27 workflow-only tarball and dashboard baselines, measured from npm pack
// metadata rather than checkout size. A 10% regression margin remains explicit.
export const PACKAGE_BASELINES = Object.freeze({ packedBytes: 1_100_000, unpackedBytes: 4_500_000, dashboardBytes: 750_000 });
export const MAX_REGRESSION_RATIO = 0.1;
export function regressionLimit(baseline) { return Math.ceil(baseline * (1 + MAX_REGRESSION_RATIO)); }
const TOP_LEVEL_ALLOWLIST = Object.freeze(["package.json", "LICENSE", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md", "index.ts", "README.md", "SECURITY.md", "SETUP.md"]);
const PREFIX_ALLOWLIST = Object.freeze(["src/", "native/", "schemas/", "ui/web/dist/", "examples/", "scripts/build-darwin-native.mjs", "scripts/verify-darwin-native.mjs", "scripts/check-package-budgets.mjs", "scripts/check-licenses.mjs"]);
export function isAllowedPackagePath(path) { return TOP_LEVEL_ALLOWLIST.includes(path) || PREFIX_ALLOWLIST.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)); }
function bytes(path) { let total = 0; for (const name of readdirSync(path)) { const target = join(path, name); const stat = statSync(target); total += stat.isDirectory() ? bytes(target) : stat.size; } return total; }
function npmPack(projectRoot) {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const result = JSON.parse(output)[0];
  if (!result || !Array.isArray(result.files)) throw new Error("npm pack returned no file manifest");
  return result;
}
export function checkPackageBudgets(projectRoot = root) {
  const failures = []; let packed;
  try { packed = npmPack(projectRoot); } catch (error) { return { failures: [`npm pack dry-run failed: ${error instanceof Error ? error.message : String(error)}`], packed: 0, unpacked: 0, dashboard: 0 }; }
  const dashboard = bytes(join(projectRoot, "ui/web/dist"));
  if (packed.size > regressionLimit(PACKAGE_BASELINES.packedBytes)) failures.push(`npm tarball ${packed.size} exceeds ${regressionLimit(PACKAGE_BASELINES.packedBytes)} bytes`);
  if (packed.unpackedSize > regressionLimit(PACKAGE_BASELINES.unpackedBytes)) failures.push(`npm unpacked size ${packed.unpackedSize} exceeds ${regressionLimit(PACKAGE_BASELINES.unpackedBytes)} bytes`);
  if (dashboard > regressionLimit(PACKAGE_BASELINES.dashboardBytes)) failures.push(`dashboard dist ${dashboard} exceeds ${regressionLimit(PACKAGE_BASELINES.dashboardBytes)} bytes`);
  for (const entry of packed.files) if (!isAllowedPackagePath(entry.path)) failures.push(`unallowlisted npm package file: ${entry.path}`);
  return { failures, packed: packed.size, unpacked: packed.unpackedSize, dashboard };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkPackageBudgets();
  if (result.failures.length) { result.failures.forEach((failure) => console.error(`  - ${failure}`)); process.exit(1); }
  console.log(`✓ npm tarball ${result.packed} bytes; unpacked ${result.unpacked} bytes; dashboard ${result.dashboard} bytes`);
}
