import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { dashboardSourceHash } from "../../scripts/dashboard-hash.mjs";
import { verifyRelease } from "../../scripts/verify-release.mjs";

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
  writeJson(join(root, "package.json"), { name: "pi-hive", version });
  writeJson(join(root, "package-lock.json"), {
    name: "pi-hive", version, lockfileVersion: 3,
    packages: { "": { name: "pi-hive", version } },
  });
  write(join(root, "CHANGELOG.md"), `# Changelog\n\n## [${version}] - 2026-07-15\n\n- Tested release.\n`);

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

test("release verification binds version, tag, notes, dashboard build, and clean Git state", () => {
  const root = releaseFixture();
  assert.deepEqual(verifyRelease(root, "v1.2.3"), []);

  write(join(root, "ui", "web", "src", "main.ts"), "export const stale = true;\n");
  const failures = verifyRelease(root, "v1.2.3");
  assert.ok(failures.includes("dashboard build hash is missing or stale"));
  assert.ok(failures.includes("Git index and worktree must be clean before publishing"));
});

test("release verification rejects mismatched versions and any unbracketed or undated changelog heading", () => {
  const root = releaseFixture();
  const failures = verifyRelease(root, "v1.2.4");
  assert.ok(failures.some((failure) => failure.includes("does not match package version")));
  for (const heading of ["## 1.2.3", "## [1.2.3]", "## 1.2.3 - 2026-07-15", "## [1.2.3] - July 15, 2026"]) {
    write(join(root, "CHANGELOG.md"), `# Changelog\n\n${heading}\n\n- Invalid release heading.\n`);
    assert.ok(verifyRelease(root, "v1.2.3").some((failure) => failure.includes("bracketed version and ISO date")), heading);
  }
});

test("release workflow gates audits and coverage and validates artifacts before protected OIDC publishing", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  const contributing = readFileSync(new URL("../../CONTRIBUTING.md", import.meta.url), "utf8");
  const justfile = readFileSync(new URL("../../Justfile", import.meta.url), "utf8");
  const releasing = readFileSync(new URL("../../RELEASING.md", import.meta.url), "utf8");
  assert.match(workflow, /environment: npm/);
  assert.match(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /NPM_TOKEN/);
  assert.match(workflow, /npm publish --provenance --access public --ignore-scripts/);
  assert.match(workflow, /gh release view .*--json body/);
  assert.match(workflow, /gh release upload .*release-artifacts\/\*/);
  assert.match(workflow, /just release-gate/);
  assert.match(workflow, /just release-artifacts-verify/);
  const gate = workflow.indexOf("just release-gate");
  const artifacts = workflow.indexOf("just release-artifacts");
  const verifyArtifacts = workflow.indexOf("just release-artifacts-verify");
  const publish = workflow.indexOf("npm publish");
  const upload = workflow.indexOf("gh release upload");
  assert.ok(gate >= 0 && artifacts > gate && verifyArtifacts > artifacts && upload > verifyArtifacts && publish > upload, "all reversible gates, artifact validation, and artifact upload precede publish");
  assert.doesNotMatch(`${workflow}\n${contributing}`, /v0\.1\.0/);
  assert.match(contributing, /\[README quick start\]\(\.\/README\.md#quick-start\)/);
  assert.match(justfile, /release-gate: coverage ci audit-root audit-dashboard/);
  assert.match(justfile, /audit-root:[\s\S]*check-npm-audit\.mjs/);
  assert.match(justfile, /audit-dashboard:[\s\S]*npm audit --prefix ui\/web --audit-level=high/);
  assert.match(justfile, /prepublish: release-gate release-verify release-artifacts release-artifacts-verify/);
  assert.match(releasing, /just release-gate/);
  assert.match(releasing, /before npm publish/i);
});

test("every supported Node compatibility lane installs and loads the packed package", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const justfile = readFileSync(new URL("../../Justfile", import.meta.url), "utf8");
  assert.match(workflow, /node-version:\s*\n\s*- "20\.19\.x"\s*\n\s*- "lts\/\*"\s*\n\s*- "current"/u);
  const compatibilityJob = workflow.slice(workflow.indexOf("  compatibility:"), workflow.indexOf("\n  verify:"));
  assert.match(compatibilityJob, /run: just typecheck-core test-node-compat dashboard-typecheck dashboard-test-unit verify-node-package-compat/u);
  assert.match(justfile, /verify-node-package-compat: verify-package verify-packed-install/u);
});
