#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardSourceHash, dashboardStampPath } from "./dashboard-hash.mjs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function verifyRelease(root, requestedTag) {
  const failures = []; let pkg; let lock;
  try { pkg = readJson(join(root, "package.json")); lock = readJson(join(root, "package-lock.json")); }
  catch (error) { return [`could not read release metadata: ${error instanceof Error ? error.message : String(error)}`]; }
  const expectedTag = `v${pkg.version}`; const releaseTag = requestedTag || expectedTag;
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseTag)) failures.push(`release tag must be a v-prefixed semantic version; found ${releaseTag || "missing"}`);
  if (releaseTag !== expectedTag) failures.push(`tag ${releaseTag} does not match package version ${pkg.version}`);
  if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) failures.push(`package-lock.json version must match package.json version ${pkg.version}`);
  const changelogPath = join(root, "CHANGELOG.md");
  if (!existsSync(changelogPath)) failures.push("CHANGELOG.md is missing");
  else {
    const match = readFileSync(changelogPath, "utf8").match(new RegExp(`^## \\[${escapeRegExp(pkg.version)}\\] - (\\d{4}-\\d{2}-\\d{2})$`, "m"));
    const date = match?.[1];
    const validDate = date && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
    if (!validDate) failures.push(`CHANGELOG.md release notes for ${pkg.version} require a bracketed version and ISO date: ## [${pkg.version}] - YYYY-MM-DD`);
  }
  const webDir = join(root, "ui", "web"); const stampPath = dashboardStampPath(webDir); const stampedHash = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : "";
  if (!stampedHash || stampedHash !== dashboardSourceHash(webDir)) failures.push("dashboard build hash is missing or stale");
  try { if (releaseTag === expectedTag && /^v\d/.test(releaseTag)) { const head = git(root, ["rev-parse", "HEAD"]); const tagged = git(root, ["rev-parse", `refs/tags/${releaseTag}^{commit}`]); if (head !== tagged) failures.push(`tag ${releaseTag} does not point at HEAD`); } if (git(root, ["status", "--porcelain=v1", "--untracked-files=all"])) failures.push("Git index and worktree must be clean before publishing"); }
  catch (error) { failures.push(`could not verify Git release state: ${error instanceof Error ? error.message : String(error)}`); }
  return failures;
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { const index = process.argv.indexOf("--tag"); const failures = verifyRelease(root, index >= 0 ? process.argv[index + 1] : process.env.RELEASE_TAG); if (failures.length) { console.error("✗ release verification failed:"); for (const failure of failures) console.error(`  - ${failure}`); process.exit(1); } console.log("✓ verified release metadata, dashboard hash, tag, and clean Git state"); }
