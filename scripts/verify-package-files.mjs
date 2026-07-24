#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardSourceHash, dashboardStampPath } from "./dashboard-hash.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const posix = (value) => value.split(sep).join("/");

for (const path of ["index.ts", "schemas/hive-manifest-v1.schema.json", "schemas/hive-agent-frontmatter-v1.schema.json", "schemas/hive-workflow-v1.schema.json", "ui/web/dist/index.html", "README.md", "SETUP.md", "SECURITY.md", "CHANGELOG.md", "examples/combined-openspec-delivery/.pi/hive/hive-config.yaml", "examples/split-openspec-handoff/.pi/hive/hive-config.yaml", "examples/markdown-plan-lifecycle/.pi/hive/hive-config.yaml", "examples/artifact-free-debug/.pi/hive/hive-config.yaml"]) {
  if (!existsSync(join(root, path))) failures.push(`required package file is missing: ${path}`);
}
const exactManifestFiles = ["LICENSE", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md", "index.ts", "src/", "native/", "schemas/", "ui/web/dist/", "examples/", "scripts/build-darwin-native.mjs", "scripts/verify-darwin-native.mjs", "scripts/check-package-budgets.mjs", "scripts/check-licenses.mjs", "README.md", "SECURITY.md", "SETUP.md"];
if (JSON.stringify(pkg.files) !== JSON.stringify(exactManifestFiles)) failures.push("package files[] must match the reviewed positive allowlist exactly");
for (const dependency of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) if (pkg.peerDependencies?.[dependency] !== "*") failures.push(`${dependency} must be a wildcard peer dependency`);
if (pkg.main !== "index.ts" || pkg.exports?.["."] !== "./index.ts" || JSON.stringify(pkg.pi?.extensions) !== JSON.stringify(["./index.ts"])) failures.push("Pi extension entrypoint contract is invalid");
const stamp = dashboardStampPath(join(root, "ui/web"));
if (!existsSync(stamp) || readFileSync(stamp, "utf8").trim() !== dashboardSourceHash(join(root, "ui/web"))) failures.push("dashboard dist is stale; run just dashboard-build");

function diskFiles(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [posix(relative(root, path))];
  return readdirSync(path).sort().flatMap((name) => diskFiles(join(path, name)));
}

let packed;
try {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  packed = JSON.parse(output)[0];
} catch (error) {
  failures.push(`npm pack dry-run failed: ${error instanceof Error ? error.message : String(error)}`);
}
if (packed) {
  const actual = packed.files.map((entry) => entry.path).sort();
  const expected = [...new Set(["package.json", ...pkg.files.flatMap((entry) => diskFiles(join(root, entry.replace(/\/$/u, ""))))])].sort();
  const unintended = actual.filter((path) => !expected.includes(path));
  const missing = expected.filter((path) => !actual.includes(path));
  if (unintended.length) failures.push(`npm pack contains unintended files: ${unintended.join(", ")}`);
  if (missing.length) failures.push(`npm pack omitted allowlisted files: ${missing.join(", ")}`);
  const sourceDisk = diskFiles(join(root, "src")).sort();
  const sourcePacked = actual.filter((path) => path.startsWith("src/")).sort();
  if (JSON.stringify(sourcePacked) !== JSON.stringify(sourceDisk)) failures.push("npm pack must contain every src file and no unreviewed src path");
  if (!Number.isSafeInteger(packed.size) || packed.size <= 0 || !Number.isSafeInteger(packed.unpackedSize) || packed.unpackedSize <= 0) failures.push("npm pack did not report valid tarball size metadata");
}

if (failures.length) {
  console.error("✗ package verification failed:");
  failures.forEach((failure) => console.error(`  - ${failure}`));
  process.exit(1);
}
console.log(`✓ verified exact npm pack file list (${packed.files.length} files, ${packed.size} packed bytes, ${packed.unpackedSize} unpacked bytes)`);
