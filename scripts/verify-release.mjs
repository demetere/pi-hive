#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardSourceHash, dashboardStampPath } from "./dashboard-hash.mjs";
import { verifyReviewVendor } from "./check-review-vendor.mjs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function verifyRelease(root, requestedTag) {
  const failures = [];
  let pkg;
  let lock;
  let vendor;
  let reviewManifest;
  try {
    pkg = readJson(join(root, "package.json"));
    lock = readJson(join(root, "package-lock.json"));
    vendor = readJson(join(root, "ui", "review", "vendor.json"));
    reviewManifest = readJson(join(root, "ui", "review", "dist", "manifest.json"));
  } catch (error) {
    return [`could not read release metadata: ${error instanceof Error ? error.message : String(error)}`];
  }

  const expectedTag = `v${pkg.version}`;
  const releaseTag = requestedTag || expectedTag;
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseTag)) {
    failures.push(`release tag must be a v-prefixed semantic version; found ${releaseTag || "missing"}`);
  }
  if (releaseTag !== expectedTag) failures.push(`tag ${releaseTag} does not match package version ${pkg.version}`);
  if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) {
    failures.push(`package-lock.json version must match package.json version ${pkg.version}`);
  }

  const changelogPath = join(root, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    failures.push("CHANGELOG.md is missing");
  } else {
    const changelog = readFileSync(changelogPath, "utf8");
    if (!new RegExp(`^## \\[${escapeRegExp(pkg.version)}\\](?:\\s|$)`, "m").test(changelog)) {
      failures.push(`CHANGELOG.md has no release notes for ${pkg.version}`);
    }
  }

  const webDir = join(root, "ui", "web");
  const stampPath = dashboardStampPath(webDir);
  const stampedHash = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : "";
  const currentHash = dashboardSourceHash(webDir);
  if (!stampedHash || stampedHash !== currentHash) failures.push("dashboard build hash is missing or stale");

  failures.push(...verifyReviewVendor(root));
  if (JSON.stringify(reviewManifest.vendor) !== JSON.stringify(vendor.package)) {
    failures.push("review bundle vendor metadata does not match ui/review/vendor.json");
  }
  for (const [name, metadata] of Object.entries(reviewManifest.files ?? {})) {
    const source = join(root, "ui", "review", "src", name);
    const output = join(root, "ui", "review", "dist", metadata.path ?? "");
    if (!existsSync(source) || sha256File(source) !== metadata.sourceSha256) failures.push(`review source hash mismatch: ${name}`);
    if (!existsSync(output) || sha256File(output) !== metadata.sha256) failures.push(`review build hash mismatch: ${name}`);
  }

  try {
    if (releaseTag === expectedTag && /^v\d/.test(releaseTag)) {
      const head = git(root, ["rev-parse", "HEAD"]);
      const tagged = git(root, ["rev-parse", `refs/tags/${releaseTag}^{commit}`]);
      if (head !== tagged) failures.push(`tag ${releaseTag} does not point at HEAD`);
    }
    const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status) failures.push("Git index and worktree must be clean before publishing");
  } catch (error) {
    failures.push(`could not verify Git release state: ${error instanceof Error ? error.message : String(error)}`);
  }

  return failures;
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tagArgIndex = process.argv.indexOf("--tag");
  const requestedTag = tagArgIndex >= 0 ? process.argv[tagArgIndex + 1] : process.env.RELEASE_TAG;
  const failures = verifyRelease(root, requestedTag);
  if (failures.length) {
    console.error("✗ release verification failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  const pkg = readJson(join(root, "package.json"));
  console.log(`✓ verified v${pkg.version}, release notes, build/vendor hashes, and clean Git state`);
}
