#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REVIEW_SOURCE_FILES = ["review.html", "review.css", "review.js"];

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function verifyReviewVendor(root) {
  const failures = [];
  let vendor;
  let pkg;
  let lock;

  try {
    vendor = readJson(join(root, "ui", "review", "vendor.json"));
    pkg = readJson(join(root, "package.json"));
    lock = readJson(join(root, "package-lock.json"));
  } catch (error) {
    return [`could not read review vendor metadata: ${error instanceof Error ? error.message : String(error)}`];
  }

  if (vendor.schemaVersion !== 1) failures.push("ui/review/vendor.json must use schemaVersion 1");
  const packageName = vendor.package?.name;
  const expectedVersion = vendor.package?.version;
  const lockPath = `node_modules/${packageName}`;
  const lockEntry = lock.packages?.[lockPath];
  const declaredVersion = pkg.devDependencies?.[packageName];
  const lockedRootVersion = lock.packages?.[""]?.devDependencies?.[packageName];

  if (typeof packageName !== "string" || !packageName) failures.push("review vendor package name is missing");
  if (typeof expectedVersion !== "string" || !expectedVersion) failures.push("review vendor package version is missing");
  if (declaredVersion !== expectedVersion) failures.push(`package.json must pin ${packageName} to exactly ${expectedVersion}; found ${declaredVersion ?? "missing"}`);
  if (lockedRootVersion !== expectedVersion) failures.push(`package-lock root must pin ${packageName} to exactly ${expectedVersion}; found ${lockedRootVersion ?? "missing"}`);
  if (lockEntry?.version !== expectedVersion) failures.push(`package-lock resolved ${packageName} version ${lockEntry?.version ?? "missing"}; expected ${expectedVersion}`);
  if (lockEntry?.integrity !== vendor.package?.integrity) failures.push(`${packageName} lockfile integrity does not match ui/review/vendor.json`);

  const installedRoot = join(root, "node_modules", ...(typeof packageName === "string" ? packageName.split("/") : []));
  const installedManifest = join(installedRoot, "package.json");
  if (!existsSync(installedManifest)) {
    failures.push(`${packageName || "review vendor package"} is not installed; run npm ci`);
  } else {
    try {
      const installed = readJson(installedManifest);
      if (installed.version !== expectedVersion) failures.push(`installed ${packageName} version ${installed.version} does not match ${expectedVersion}`);
      const artifact = join(installedRoot, vendor.package?.artifact || "");
      if (!existsSync(artifact)) {
        failures.push(`installed vendor artifact is missing: ${vendor.package?.artifact ?? "unspecified"}`);
      } else if (sha256File(artifact) !== vendor.package?.artifactSha256) {
        failures.push(`installed ${packageName}/${vendor.package.artifact} hash does not match ui/review/vendor.json`);
      }
    } catch (error) {
      failures.push(`could not verify installed review vendor: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const name of REVIEW_SOURCE_FILES) {
    const source = join(root, "ui", "review", "src", name);
    if (!existsSync(source)) {
      failures.push(`review source is missing: ${name}`);
    } else if (sha256File(source) !== vendor.derivedSources?.[name]) {
      failures.push(`review source ${name} changed without refreshing ui/review/vendor.json`);
    }
  }

  return failures;
}

export function readVerifiedReviewVendor(root) {
  const failures = verifyReviewVendor(root);
  if (failures.length) throw new Error(failures.join("\n"));
  return readJson(join(root, "ui", "review", "vendor.json"));
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectRoot = process.argv[2] ? resolve(process.argv[2]) : root;
  const failures = verifyReviewVendor(projectRoot);
  if (failures.length) {
    console.error("✗ review vendor verification failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  const vendor = readJson(join(projectRoot, "ui", "review", "vendor.json"));
  console.log(`✓ review vendor matches ${vendor.package.name}@${vendor.package.version}, lockfile integrity, and source hashes`);
}
