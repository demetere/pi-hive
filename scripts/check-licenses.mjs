#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];

const allowedLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "ISC",
  "MIT",
  "MIT OR Apache-2.0",
  "MIT-0",
  "MPL-2.0",
  "OFL-1.1",
  "Python-2.0",
]);

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
}

function normalizedLicense(value) {
  return value === "apache-2.0" ? "Apache-2.0" : value;
}

function scanLockfile(relativePath) {
  let lock;
  try {
    lock = readJson(relativePath);
  } catch (error) {
    failures.push(`could not read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }

  let scanned = 0;
  for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
    if (!packagePath) continue;
    scanned += 1;
    const name = metadata.name ?? packagePath.slice(packagePath.lastIndexOf("node_modules/") + 13);
    const license = normalizedLicense(metadata.license);
    if (typeof license !== "string" || !license) {
      failures.push(`${relativePath}: ${name}@${metadata.version ?? "unknown"} has no declared license`);
    } else if (!allowedLicenses.has(license)) {
      failures.push(`${relativePath}: ${name}@${metadata.version ?? "unknown"} uses unreviewed license ${license}`);
    }
  }
  return scanned;
}

const expectedAssets = new Map([
  ["ui/web/public/fonts/hanken-grotesk-latin.woff2", "a1376a563717f1efa2f5286ab23da2b61ae8dec827a77b97adfa01cad4ec4ee2"],
  ["ui/web/public/fonts/dm-mono-latin-400.woff2", "7f8712cbbd64135f9e74a527475a97cd8c5a49d8e0a1de7a65f8e2c30c5214d9"],
  ["ui/web/public/fonts/dm-mono-latin-500.woff2", "e284f2a17fc9cca89cc30f496945bd9a2903010944a9469fb357924da21b6f6c"],
]);

for (const [relativePath, expectedHash] of expectedAssets) {
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath)) {
    failures.push(`licensed asset is missing: ${relativePath}`);
    continue;
  }
  const actualHash = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  if (actualHash !== expectedHash) failures.push(`${relativePath} changed; review its provenance and refresh THIRD_PARTY_NOTICES.md`);
}

let notices = "";
try {
  notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
} catch (error) {
  failures.push(`could not read THIRD_PARTY_NOTICES.md: ${error instanceof Error ? error.message : String(error)}`);
}

const requiredNoticeText = [
  "@plannotator/pi-extension` version 0.21.4",
  "Copyright (c) 2025 backnotprop",
  "MIT License",
  "Copyright 2021 The Hanken Grotesk Project Authors",
  "https://github.com/marcologous/hanken-grotesk",
  "Copyright 2020 The DM Mono Project Authors",
  "https://github.com/googlefonts/dm-mono",
  "SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007",
  ...expectedAssets.keys(),
];
for (const text of requiredNoticeText) {
  if (!notices.includes(text)) failures.push(`THIRD_PARTY_NOTICES.md is missing required attribution: ${text}`);
}

try {
  const vendor = readJson("ui/review/vendor.json");
  const packageName = vendor.package?.name;
  const version = vendor.package?.version;
  const lock = readJson("package-lock.json");
  const license = normalizedLicense(lock.packages?.[`node_modules/${packageName}`]?.license);
  if (packageName !== "@plannotator/pi-extension" || version !== "0.21.4") {
    failures.push("Plannotator vendor changed; refresh THIRD_PARTY_NOTICES.md and the license checks");
  }
  if (license !== "MIT OR Apache-2.0") failures.push(`unexpected Plannotator license: ${license ?? "missing"}`);
} catch (error) {
  failures.push(`could not verify Plannotator licensing: ${error instanceof Error ? error.message : String(error)}`);
}

const packageCount = scanLockfile("package-lock.json") + scanLockfile("ui/web/package-lock.json");

if (failures.length) {
  console.error("✗ third-party license verification failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`✓ verified notices, 3 vendored font files, and licenses for ${packageCount} locked packages`);
