#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardSourceHash, STAMP_PATH } from "./dashboard-hash.mjs";
import { verifyReviewVendor } from "./check-review-vendor.mjs";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const requiredPaths = [
  "index.ts",
  "src/agents/prompts.ts",
  "src/agents/tools.ts",
  "src/core/config.ts",
  "src/core/types.ts",
  "src/engine/dispatch.ts",
  "src/engine/session.ts",
  "src/integration/commands.ts",
  "src/integration/hooks.ts",
  "src/observability/server/index.ts",
  "src/ui/tui/widget.ts",
  "ui/web/dist/index.html",
  "ui/web/dist/.build-hash",
  "ui/review/src/review.html",
  "ui/review/src/review.css",
  "ui/review/src/review.js",
  "ui/review/vendor.json",
  "ui/review/dist/review.html.gz",
  "ui/review/dist/review.css.gz",
  "ui/review/dist/review.js.gz",
  "ui/review/dist/manifest.json",
  "scripts/build-review-bundle.mjs",
  "scripts/check-package-budgets.mjs",
  "scripts/check-review-vendor.mjs",
  "README.md",
  "SETUP.md",
];

const requiredPackageFileEntries = [
  "index.ts",
  "src/",
  "ui/web/dist/",
  "ui/review/src/",
  "ui/review/dist/",
  "ui/review/vendor.json",
  "scripts/build-review-bundle.mjs",
  "scripts/check-package-budgets.mjs",
  "scripts/check-review-vendor.mjs",
  "README.md",
  "SETUP.md",
];

const requiredPeerDeps = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

const failures = [];

for (const relativePath of requiredPaths) {
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    failures.push(`missing required file: ${relativePath}`);
  }
}

for (const entry of requiredPackageFileEntries) {
  if (!pkg.files?.includes(entry)) failures.push(`package.json files[] must include ${entry}`);
}
for (const entry of ["ui/web/src/", "ui/web/vendor/", "ui/web/package.json", "ui/web/index.html", "ui/web/tsconfig.json", "ui/web/vite.config.ts"]) {
  if (pkg.files?.includes(entry)) failures.push(`runtime package must not include dashboard build input: ${entry}`);
}
if (pkg.dependencies?.["@plannotator/pi-extension"]) {
  failures.push("the runtime package must not depend on the full Plannotator extension");
}
failures.push(...verifyReviewVendor(root));

try {
  const manifest = JSON.parse(readFileSync(join(root, "ui/review/dist/manifest.json"), "utf8"));
  const vendor = JSON.parse(readFileSync(join(root, "ui/review/vendor.json"), "utf8"));
  if (manifest.version !== 2 || JSON.stringify(manifest.vendor) !== JSON.stringify(vendor.package)) {
    failures.push("review dist vendor metadata is stale; run just review-build");
  }
  for (const name of ["review.html", "review.css", "review.js"]) {
    const source = readFileSync(join(root, "ui/review/src", name));
    const compressed = gzipSync(source, { level: 9, mtime: 0 });
    const entry = manifest.files?.[name];
    const hash = createHash("sha256").update(compressed).digest("hex");
    const sourceHash = createHash("sha256").update(source).digest("hex");
    if (!entry || entry.sha256 !== hash || entry.sourceSha256 !== sourceHash || entry.compressedBytes !== compressed.byteLength) failures.push(`review dist is stale for ${name}; run just review-build`);
  }
} catch (error) {
  failures.push(`review bundle manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
}

if (pkg.main !== "index.ts") failures.push("package.json main must be index.ts");
if (pkg.exports?.["."] !== "./index.ts") failures.push("package.json exports['.'] must be ./index.ts");
if (!Array.isArray(pkg.pi?.extensions) || !pkg.pi.extensions.includes("./index.ts")) {
  failures.push("package.json pi.extensions must include ./index.ts");
}

for (const dep of requiredPeerDeps) {
  if (pkg.peerDependencies?.[dep] !== "*") {
    failures.push(`peerDependency ${dep} must be present with '*' range`);
  }
}

if (!existsSync(STAMP_PATH)) {
  failures.push("dashboard dist build stamp is missing; run just dashboard-build");
} else {
  const stamped = readFileSync(STAMP_PATH, "utf8").trim();
  const current = dashboardSourceHash();
  if (stamped !== current) {
    failures.push("dashboard dist is stale relative to ui/web/src; run just dashboard-build");
  }
}

if (failures.length) {
  console.error("✗ package verification failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("✓ package files and manifest are ready to publish");
