#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardSourceHash, STAMP_PATH } from "./dashboard-hash.mjs";

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
  "ui/web/vendor/plannotator.html",
  "ui/web/package.json",
  "README.md",
  "SETUP.md",
];

const requiredPackageFileEntries = [
  "index.ts",
  "src/",
  "ui/web/dist/",
  "ui/web/vendor/",
  "ui/web/package.json",
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
  if (!pkg.files?.includes(entry)) {
    failures.push(`package.json files[] must include ${entry}`);
  }
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
  failures.push("dashboard dist build stamp is missing; run just build-dashboard");
} else {
  const stamped = readFileSync(STAMP_PATH, "utf8").trim();
  const current = dashboardSourceHash();
  if (stamped !== current) {
    failures.push("dashboard dist is stale relative to ui/web/src; run just build-dashboard");
  }
}

if (failures.length) {
  console.error("✗ package verification failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("✓ package files and manifest are ready to publish");
