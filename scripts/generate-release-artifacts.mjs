#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function releaseOutputDir(args) {
  if (args.length === 0) return join(root, "release-artifacts");
  if (args.length === 2 && args[0] === "--output-dir" && args[1]) return resolve(args[1]);
  throw new Error("Usage: generate-release-artifacts.mjs [--output-dir <path>]");
}

const outputDir = releaseOutputDir(process.argv.slice(2));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dashboardPkg = JSON.parse(readFileSync(join(root, "ui", "web", "package.json"), "utf8"));

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function npmSbom(cwd, manifest) {
  const raw = execFileSync("npm", ["sbom", "--sbom-format=cyclonedx"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
  });
  const sbom = JSON.parse(raw);
  if (!sbom.metadata?.component) throw new Error(`npm SBOM for ${manifest.name} has no metadata.component`);
  Object.assign(sbom.metadata.component, {
    name: manifest.name,
    version: manifest.version,
    purl: `pkg:npm/${manifest.name}@${manifest.version}`,
    type: "library",
  });
  return sbom;
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const packageSbomName = `pi-hive-${pkg.version}.sbom.cdx.json`;
const dashboardSbomName = `pi-hive-dashboard-${pkg.version}.sbom.cdx.json`;
writeFileSync(join(outputDir, packageSbomName), `${JSON.stringify(npmSbom(root, pkg), null, 2)}\n`);
writeFileSync(join(outputDir, dashboardSbomName), `${JSON.stringify(npmSbom(join(root, "ui", "web"), dashboardPkg), null, 2)}\n`);

const manifest = {
  schemaVersion: 1,
  package: { name: pkg.name, version: pkg.version },
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  lockfiles: {
    "package-lock.json": sha256(join(root, "package-lock.json")),
    "ui/web/package-lock.json": sha256(join(root, "ui", "web", "package-lock.json")),
  },
  builds: {
    dashboardSourceSha256: readFileSync(join(root, "ui", "web", "dist", ".build-hash"), "utf8").trim(),
  },
  sboms: [packageSbomName, dashboardSbomName],
};
const manifestName = `pi-hive-${pkg.version}.dependency-manifest.json`;
writeFileSync(join(outputDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);

const checksums = [packageSbomName, dashboardSbomName, manifestName]
  .map((name) => `${sha256(join(outputDir, name))}  ${name}`)
  .join("\n");
writeFileSync(join(outputDir, "SHA256SUMS"), `${checksums}\n`);
console.log(`✓ generated ${packageSbomName}, ${dashboardSbomName}, ${manifestName}, and SHA256SUMS`);
