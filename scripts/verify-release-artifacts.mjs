#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = process.argv.length === 2
  ? join(root, "release-artifacts")
  : process.argv.length === 4 && process.argv[2] === "--output-dir" && process.argv[3]
    ? resolve(process.argv[3])
    : (() => { throw new Error("Usage: verify-release-artifacts.mjs [--output-dir <path>]"); })();
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const pkg = readJson(join(root, "package.json"));
const dashboardPkg = readJson(join(root, "ui", "web", "package.json"));
const packageSbom = `pi-hive-${pkg.version}.sbom.cdx.json`;
const dashboardSbom = `pi-hive-dashboard-${pkg.version}.sbom.cdx.json`;
const manifestName = `pi-hive-${pkg.version}.dependency-manifest.json`;
const expected = ["SHA256SUMS", dashboardSbom, manifestName, packageSbom].sort();
if (!existsSync(outputDir) || JSON.stringify(readdirSync(outputDir).sort()) !== JSON.stringify(expected)) throw new Error("Release artifact set is missing, extra, or stale");
for (const [name, manifest] of [[packageSbom, pkg], [dashboardSbom, dashboardPkg]]) {
  const sbom = readJson(join(outputDir, name));
  if (sbom.bomFormat !== "CycloneDX" || typeof sbom.specVersion !== "string" || !sbom.metadata || !Array.isArray(sbom.components)) throw new Error(`Release SBOM ${name} is not valid CycloneDX JSON`);
  const component = sbom.metadata.component;
  const expectedComponent = {
    name: manifest.name,
    version: manifest.version,
    purl: `pkg:npm/${manifest.name}@${manifest.version}`,
    type: "library",
  };
  if (!component || Object.entries(expectedComponent).some(([field, value]) => component[field] !== value)) throw new Error(`Release SBOM ${name} metadata.component identity does not match ${manifest.name}@${manifest.version}`);
}
const manifest = readJson(join(outputDir, manifestName));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dashboardHash = readFileSync(join(root, "ui", "web", "dist", ".build-hash"), "utf8").trim();
if (manifest.schemaVersion !== 1 || manifest.package?.name !== pkg.name || manifest.package?.version !== pkg.version || manifest.commit !== commit) throw new Error("Release dependency manifest identity does not match the checkout");
if (manifest.lockfiles?.["package-lock.json"] !== sha256(join(root, "package-lock.json")) || manifest.lockfiles?.["ui/web/package-lock.json"] !== sha256(join(root, "ui", "web", "package-lock.json"))) throw new Error("Release dependency manifest lockfile hashes are stale");
if (manifest.builds?.dashboardSourceSha256 !== dashboardHash || JSON.stringify(manifest.sboms) !== JSON.stringify([packageSbom, dashboardSbom])) throw new Error("Release dependency manifest build or SBOM identity is stale");
const lines = readFileSync(join(outputDir, "SHA256SUMS"), "utf8").trim().split("\n");
const checksums = new Map(lines.map((line) => { const match = line.match(/^([0-9a-f]{64}) {2}([^/]+)$/u); if (!match) throw new Error("SHA256SUMS contains a malformed entry"); return [match[2], match[1]]; }));
for (const name of [packageSbom, dashboardSbom, manifestName]) if (checksums.get(name) !== sha256(join(outputDir, name))) throw new Error(`Release checksum mismatch for ${name}`);
if (checksums.size !== 3) throw new Error("SHA256SUMS contains an unexpected entry");
console.log(`✓ verified release artifacts for ${pkg.name}@${pkg.version}`);
