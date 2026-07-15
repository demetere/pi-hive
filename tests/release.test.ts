import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { dashboardSourceHash } from "../scripts/dashboard-hash.mjs";
import { verifyRelease } from "../scripts/verify-release.mjs";

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeJson(path: string, value: unknown): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function releaseFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-release-"));
  const version = "1.2.3";
  const packageName = "@plannotator/pi-extension";
  const vendorArtifact = "upstream review";
  const integrity = "sha512-test-integrity";
  const sources = {
    "review.html": "<main>review</main>",
    "review.css": "main { color: green; }",
    "review.js": "console.log('review');",
  };
  const vendorPackage = {
    name: packageName,
    version: "0.23.1",
    integrity,
    artifact: "plannotator.html",
    artifactSha256: sha256(vendorArtifact),
  };

  writeJson(join(root, "package.json"), {
    name: "pi-hive",
    version,
    devDependencies: { [packageName]: vendorPackage.version },
  });
  writeJson(join(root, "package-lock.json"), {
    name: "pi-hive",
    version,
    lockfileVersion: 3,
    packages: {
      "": { name: "pi-hive", version, devDependencies: { [packageName]: vendorPackage.version } },
      [`node_modules/${packageName}`]: { version: vendorPackage.version, integrity },
    },
  });
  write(join(root, "CHANGELOG.md"), `# Changelog\n\n## [${version}] - 2026-07-15\n\n- Tested release.\n`);
  writeJson(join(root, "node_modules", packageName, "package.json"), { name: packageName, version: vendorPackage.version });
  write(join(root, "node_modules", packageName, "plannotator.html"), vendorArtifact);

  const derivedSources: Record<string, string> = {};
  const manifestFiles: Record<string, unknown> = {};
  for (const [name, content] of Object.entries(sources)) {
    const output = Buffer.from(`compressed:${content}`);
    write(join(root, "ui", "review", "src", name), content);
    write(join(root, "ui", "review", "dist", `${name}.gz`), output);
    derivedSources[name] = sha256(content);
    manifestFiles[name] = { path: `${name}.gz`, sourceSha256: sha256(content), sha256: sha256(output) };
  }
  writeJson(join(root, "ui", "review", "vendor.json"), { schemaVersion: 1, package: vendorPackage, derivedSources });
  writeJson(join(root, "ui", "review", "dist", "manifest.json"), { version: 2, vendor: vendorPackage, files: manifestFiles });

  const webDir = join(root, "ui", "web");
  writeJson(join(webDir, "package.json"), { name: "dashboard", version });
  writeJson(join(webDir, "package-lock.json"), { name: "dashboard", version, lockfileVersion: 3, packages: {} });
  write(join(webDir, "src", "main.ts"), "export {};\n");
  write(join(webDir, "dist", ".build-hash"), `${dashboardSourceHash(webDir)}\n`);

  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Release Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "release@example.test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "release"], { cwd: root });
  execFileSync("git", ["tag", `v${version}`], { cwd: root });
  return root;
}

test("release verification binds version, tag, notes, builds, vendor, and clean Git state", () => {
  const root = releaseFixture();
  assert.deepEqual(verifyRelease(root, "v1.2.3"), []);

  write(join(root, "ui", "web", "src", "main.ts"), "export const stale = true;\n");
  const failures = verifyRelease(root, "v1.2.3");
  assert.ok(failures.includes("dashboard build hash is missing or stale"));
  assert.ok(failures.includes("Git index and worktree must be clean before publishing"));
});

test("release verification rejects mismatched versions and release notes", () => {
  const root = releaseFixture();
  const failures = verifyRelease(root, "v1.2.4");
  assert.ok(failures.some((failure) => failure.includes("does not match package version")));
});

test("release workflow uses protected OIDC publishing and attaches manifests", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const justfile = readFileSync(new URL("../Justfile", import.meta.url), "utf8");
  assert.match(workflow, /environment: npm/);
  assert.match(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /NPM_TOKEN/);
  assert.match(workflow, /npm publish --provenance --access public/);
  assert.match(workflow, /gh release view .*--json body/);
  assert.match(workflow, /gh release upload .*release-artifacts\/\*/);
  assert.match(justfile, /prepublish:.*typecheck.*test-db.*release-verify/);
});
