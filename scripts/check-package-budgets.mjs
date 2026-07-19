#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const PACKAGE_BASELINES = Object.freeze({
  packedBytes: 605_461,
  unpackedBytes: 2_164_548,
  reviewRawBytes: 12_625,
  reviewCompressedBytes: 4_304,
});
export const MAX_REGRESSION_RATIO = 0.1;

const exactPackagePaths = new Set([
  "LICENSE",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
  "README.md",
  "SECURITY.md",
  "SETUP.md",
  "index.ts",
  "package.json",
  "scripts/build-review-bundle.mjs",
  "scripts/check-package-budgets.mjs",
  "scripts/check-review-vendor.mjs",
  "scripts/check-licenses.mjs",
  "ui/review/dist/manifest.json",
  "ui/review/dist/review.css.gz",
  "ui/review/dist/review.html.gz",
  "ui/review/dist/review.js.gz",
  "ui/review/src/review.css",
  "ui/review/src/review.html",
  "ui/review/src/review.js",
  "ui/review/vendor.json",
  "ui/web/dist/.build-hash",
  "ui/web/dist/index.html",
]);

const allowedPackagePatterns = [
  /^src\/(?:agents|artifacts|capabilities|config|core|engine|integration|observability|shared|ui\/tui|workflows)\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.ts$/,
  /^schemas\/hive-(?:manifest|agent-frontmatter|workflow)-v1\.schema\.json$/,
  /^ui\/web\/dist\/assets\/[A-Za-z0-9_-]+\.(?:css|js)$/,
  /^ui\/web\/dist\/fonts\/[a-z0-9-]+\.woff2$/,
];

export function regressionLimit(baseline) {
  return Math.ceil(baseline * (1 + MAX_REGRESSION_RATIO));
}

export function isAllowedPackagePath(path) {
  return exactPackagePaths.has(path) || allowedPackagePatterns.some((pattern) => pattern.test(path));
}

export function checkPackageBudgets(projectRoot = root) {
  const limits = Object.fromEntries(Object.entries(PACKAGE_BASELINES).map(([name, value]) => [name, regressionLimit(value)]));
  const failures = [];
  const manifest = JSON.parse(readFileSync(join(projectRoot, "ui", "review", "dist", "manifest.json"), "utf8"));
  const reviewFiles = Object.values(manifest.files || {});
  const reviewRaw = reviewFiles.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
  const reviewCompressed = reviewFiles.reduce((sum, file) => sum + Number(file.compressedBytes || 0), 0);
  if (reviewRaw > limits.reviewRawBytes) failures.push(`review bundle raw size ${reviewRaw} exceeds regression limit ${limits.reviewRawBytes} bytes`);
  if (reviewCompressed > limits.reviewCompressedBytes) failures.push(`review bundle compressed size ${reviewCompressed} exceeds regression limit ${limits.reviewCompressedBytes} bytes`);

  const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: projectRoot, encoding: "utf8" });
  if (packed.status !== 0) {
    failures.push(`npm pack dry-run failed: ${(packed.stderr || packed.stdout).trim()}`);
  } else {
    try {
      const result = JSON.parse(packed.stdout)[0];
      if (result.size > limits.packedBytes) failures.push(`packed package size ${result.size} exceeds regression limit ${limits.packedBytes} bytes`);
      if (result.unpackedSize > limits.unpackedBytes) failures.push(`unpacked package size ${result.unpackedSize} exceeds regression limit ${limits.unpackedBytes} bytes`);
      const unexpected = (result.files || []).map((file) => file.path).filter((path) => !isAllowedPackagePath(path));
      for (const path of unexpected) failures.push(`package contains non-allowlisted file: ${path}`);
      console.log(`package: ${result.size} packed / ${result.unpackedSize} unpacked bytes (${result.files?.length ?? 0} allowlisted files)`);
    } catch (error) {
      failures.push(`could not parse npm pack dry-run output: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`review bundle: ${reviewRaw} raw / ${reviewCompressed} compressed bytes`);
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkPackageBudgets(root);
  if (failures.length) {
    console.error("✗ package budget check failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`✓ package allowlist and ${MAX_REGRESSION_RATIO * 100}% size-regression budgets passed`);
}
