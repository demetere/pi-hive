import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfigCatalogs, loadConfigProject, resolveConfigWorkflows } from "../../src/config/index";

function project(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const legacyRuntimePaths = [
  "src/agents",
  "src/core/agent-type-audit.ts",
  "src/core/config.ts",
  "src/core/mental-model.ts",
  "src/core/types.ts",
  "src/engine",
  "src/integration/commands.ts",
  "src/integration/hooks.ts",
  "src/observability/server/plan-bridge.ts",
  "src/observability/server/plan-routes.ts",
  "src/ui/tui/widget.ts",
  "ui/web/src/tabs/Plans.tsx",
] as const;

const retiredSymbols = /\b(?:HiveMode|teamForMode|AgentType|plan_new|plan_select|plan_task_complete|hive_sdd_status|submit_review_verdict)\b|agent-type|mental-model/;
const retiredReleaseReferences = /ui\/review|reviewVendor/;

type CycloneDxSbom = {
  bomFormat: string;
  specVersion: string;
  serialNumber: string;
  metadata: { component: { name: string; version: string } };
};

type DependencyManifest = {
  schemaVersion: number;
  package: { name: string; version: string };
  commit: string;
  lockfiles: { "package-lock.json": string; "ui/web/package-lock.json": string };
  builds: { dashboardSourceSha256: string };
  sboms: string[];
};

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function productionFiles(path: string): string[] {
  const url = new URL(`../../${path}`, import.meta.url);
  if (!existsSync(url)) return [];
  if (!statSync(url).isDirectory()) return [path];
  return readdirSync(url).flatMap((name) => productionFiles(`${path}/${name}`));
}

test("production architecture contains only schema-v1 workflow runtime surfaces", () => {
  for (const path of legacyRuntimePaths) assert.equal(existsSync(new URL(`../../${path}`, import.meta.url)), false, `${path} must be removed`);
  const production = ["index.ts", "src/config", "src/capabilities", "src/workflows", "src/artifacts", "src/knowledge", "src/integration", "src/observability", "src/ui"]
    .flatMap(productionFiles).filter((path) => /\.(?:ts|tsx)$/u.test(path));
  for (const path of production) assert.doesNotMatch(project(path), retiredSymbols, `${path} must not retain retired architecture symbols`);
  const index = project("index.ts");
  assert.doesNotMatch(index, /legacy|fixed-mode/i);
  assert.match(index, /workflowToolDefinitionsWithRuntime/);
  assert.match(index, /registerWorkflowRunHooks/);
  assert.match(index, /createSelectedWorkflowToolPolicyHook/);
});

test("public package and docs describe the breaking workflow-only release", () => {
  const pkg = JSON.parse(project("package.json")) as { version: string; files: string[] };
  assert.equal(pkg.version, "1.0.0");
  assert.ok(pkg.files.includes("examples/"));
  const docs = ["README.md", "SETUP.md", "SECURITY.md", "CHANGELOG.md"].map(project).join("\n");
  assert.doesNotMatch(docs, /\/hive:(?:normal|plan-mode|toggle|execute|plan)\b/);
  assert.doesNotMatch(docs, /Ctrl\+Alt\+T|agent-type|mental-model YAML|planning:\s+block|hive:\s+block/i);
  for (const command of ["select", "status", "exit", "cancel", "reload", "checkpoints", "answer", "handoff-clear", "recover", "doctor", "observe", "observe-stop", "observe-prune"]) {
    assert.match(docs, new RegExp(`/hive:${command}\\b`), `docs must include /hive:${command}`);
  }
  assert.match(docs, /manual migration/i);
  assert.match(docs, /not (?:an )?OS sandbox/i);
});

test("checked-in examples cover and validate every first-release workflow shape", () => {
  const expected = new Map([
    ["artifact-free-debug", 1], ["combined-openspec-delivery", 1], ["markdown-plan-lifecycle", 1], ["split-openspec-handoff", 2],
  ]);
  for (const [name, count] of expected) {
    const root = new URL(`../../examples/${name}`, import.meta.url).pathname;
    const projectResult = loadConfigProject(root);
    assert.equal(projectResult.status, "configured", `${name} manifest must validate`);
    if (projectResult.status !== "configured") continue;
    const resolved = resolveConfigWorkflows(projectResult, loadConfigCatalogs(projectResult));
    assert.equal(resolved.diagnostics.length, 0, `${name} must have no workflow diagnostics`);
    assert.equal(resolved.workflows.length, count, `${name} must resolve every registered workflow`);
  }
  const invalid = loadConfigProject(new URL("../../examples/invalid-legacy-config", import.meta.url).pathname);
  assert.equal(invalid.status, "invalid");
  if (invalid.status === "invalid") assert.ok(invalid.diagnostics.some((entry) => entry.code === "SCHEMA_VERSION_MISSING"));
});

test("release automation contains no retired runtime or review bundle paths", () => {
  const automation = ["Justfile", ".github/workflows/ci.yml", "eslint.config.js", "scripts/check-critical-coverage.mjs", "scripts/check-bun-coverage.mjs", "scripts/verify-packed-install.mjs", "scripts/generate-release-artifacts.mjs"].map(project).join("\n");
  assert.doesNotMatch(automation, /ui\/review|reviewVendor|src\/engine|src\/agents|server\/(?:db|runtime|jsonl-reader|plan-bridge|plan-routes|review-wiring|topology-hash)\.ts|\/pl-review|\/plans(?:\b|\/)/);
});

test("release artifacts contain valid current SBOM and dependency metadata only", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "pi-hive-release-artifacts-"));
  try {
    execFileSync(process.execPath, [new URL("../../scripts/generate-release-artifacts.mjs", import.meta.url).pathname, "--output-dir", outputDir], { stdio: "pipe" });
    const packageJson = JSON.parse(project("package.json")) as { name: string; version: string };
    const pkg = { name: packageJson.name, version: packageJson.version };
    const packageSbomName = `pi-hive-${pkg.version}.sbom.cdx.json`;
    const dashboardSbomName = `pi-hive-dashboard-${pkg.version}.sbom.cdx.json`;
    const manifestName = `pi-hive-${pkg.version}.dependency-manifest.json`;
    const expectedFiles = ["SHA256SUMS", dashboardSbomName, manifestName, packageSbomName].sort();
    assert.deepEqual(readdirSync(outputDir).sort(), expectedFiles);

    const manifest = JSON.parse(readFileSync(join(outputDir, manifestName), "utf8")) as DependencyManifest;
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(manifest.package, pkg);
    assert.match(manifest.commit, /^[0-9a-f]{40}$/u);
    assert.deepEqual(Object.keys(manifest.lockfiles).sort(), ["package-lock.json", "ui/web/package-lock.json"]);
    for (const digest of Object.values(manifest.lockfiles)) assert.match(digest, /^[0-9a-f]{64}$/u);
    assert.deepEqual(Object.keys(manifest.builds), ["dashboardSourceSha256"]);
    assert.match(manifest.builds.dashboardSourceSha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(manifest.sboms, [packageSbomName, dashboardSbomName]);

    for (const name of manifest.sboms) {
      const sbom = JSON.parse(readFileSync(join(outputDir, name), "utf8")) as CycloneDxSbom;
      assert.equal(sbom.bomFormat, "CycloneDX");
      assert.match(sbom.specVersion, /^1\./u);
      assert.match(sbom.serialNumber, /^urn:uuid:/u);
      assert.equal(typeof sbom.metadata.component.name, "string");
      assert.equal(typeof sbom.metadata.component.version, "string");
    }

    const sums = readFileSync(join(outputDir, "SHA256SUMS"), "utf8").trim().split("\n");
    assert.deepEqual(sums, [packageSbomName, dashboardSbomName, manifestName].map((name) => `${sha256(join(outputDir, name))}  ${name}`));
    for (const name of expectedFiles) assert.doesNotMatch(readFileSync(join(outputDir, name), "utf8"), retiredReleaseReferences);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("contributor guide matches the enforced release toolchain", () => {
  const guide = project("CONTRIBUTING.md");
  assert.match(guide, /Node\.js.*≥ 20\.19\.0/u);
  assert.match(guide, /Bun.*≥ 1\.3\.14/u);
  assert.match(guide, /React.*Vite/u);
  assert.match(guide, /ESLint/u);
  assert.match(guide, /just verify/u);
  assert.match(guide, /just ci/u);
  assert.doesNotMatch(guide, /Solid \+ Vite|no ESLint\/Prettier gate/i);
});

test("Vite development proxy retains only current workflow server routes", () => {
  const vite = project("ui/web/vite.config.ts");
  for (const route of ["/health", "/bootstrap.json", "/shutdown", "/api/v1"]) assert.match(vite, new RegExp(`"${route.replace("/", "\\/")}"`, "u"));
  for (const route of ["/events", "/states", "/sessions", "/stream", "/agent-log", "/projects", "/topologies", "/models", "/delegations", "/tool-calls", "/storage", "/conversation", "/thinking", "/project-overrides", "/api"]) assert.equal(vite.includes(`"${route}"`), false, `legacy proxy route ${route} must be absent`);
});
