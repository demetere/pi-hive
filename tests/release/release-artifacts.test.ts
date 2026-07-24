import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../..", import.meta.url);
const generateScript = new URL("../../scripts/generate-release-artifacts.mjs", import.meta.url);
const verifyScript = new URL("../../scripts/verify-release-artifacts.mjs", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; version: string };
const dashboardPkg = JSON.parse(readFileSync(new URL("../../ui/web/package.json", import.meta.url), "utf8")) as { name: string; version: string };
const rootSbomName = `pi-hive-${pkg.version}.sbom.cdx.json`;
const dashboardSbomName = `pi-hive-dashboard-${pkg.version}.sbom.cdx.json`;
const manifestName = `pi-hive-${pkg.version}.dependency-manifest.json`;

function run(script: URL, outputDir: string): string {
  return execFileSync(process.execPath, [script.pathname, "--output-dir", outputDir], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function failure(outputDir: string): string {
  try {
    run(verifyScript, outputDir);
  } catch (error) {
    const result = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.message ?? ""}`;
  }
  assert.fail("release artifact verification unexpectedly passed");
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function rewriteChecksums(outputDir: string): void {
  const names = [rootSbomName, dashboardSbomName, manifestName];
  writeFileSync(join(outputDir, "SHA256SUMS"), `${names.map((name) => `${sha256(join(outputDir, name))}  ${name}`).join("\n")}\n`);
}

function expectedComponent(manifest: { name: string; version: string }): Record<string, string> {
  return {
    name: manifest.name,
    version: manifest.version,
    purl: `pkg:npm/${manifest.name}@${manifest.version}`,
    type: "library",
  };
}

test("generated release artifacts carry exact root and dashboard CycloneDX component identities", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "pi-hive-release-artifacts-"));
  try {
    run(generateScript, outputDir);
    assert.match(run(verifyScript, outputDir), /verified release artifacts/u);
    for (const [name, manifest] of [[rootSbomName, pkg], [dashboardSbomName, dashboardPkg]] as const) {
      const component = readJson(join(outputDir, name)).metadata.component;
      assert.deepEqual(
        { name: component.name, version: component.version, purl: component.purl, type: component.type },
        expectedComponent(manifest),
      );
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("release artifact verifier rejects swapped or wrong SBOM identities and incomplete, corrupt, or stale artifact sets", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "pi-hive-release-artifacts-adversarial-"));
  try {
    run(generateScript, outputDir);
    const baseline = new Map(readdirSync(outputDir).map((name) => [name, readFileSync(join(outputDir, name))]));
    const restore = (): void => {
      for (const name of readdirSync(outputDir)) rmSync(join(outputDir, name), { recursive: true, force: true });
      for (const [name, content] of baseline) writeFileSync(join(outputDir, name), content);
    };
    const mutateComponent = (name: string, field: "name" | "version" | "purl" | "type", value: string): void => {
      const path = join(outputDir, name);
      const sbom = readJson(path);
      sbom.metadata.component[field] = value;
      writeJson(path, sbom);
      rewriteChecksums(outputDir);
      assert.match(failure(outputDir), /component identity/u, `${name} ${field}`);
      restore();
    };

    const rootComponent = readJson(join(outputDir, rootSbomName)).metadata.component;
    const dashboardComponent = readJson(join(outputDir, dashboardSbomName)).metadata.component;
    writeJson(join(outputDir, rootSbomName), { ...readJson(join(outputDir, rootSbomName)), metadata: { ...readJson(join(outputDir, rootSbomName)).metadata, component: dashboardComponent } });
    writeJson(join(outputDir, dashboardSbomName), { ...readJson(join(outputDir, dashboardSbomName)), metadata: { ...readJson(join(outputDir, dashboardSbomName)).metadata, component: rootComponent } });
    rewriteChecksums(outputDir);
    assert.match(failure(outputDir), /component identity/u, "swapped root/dashboard identities");
    restore();

    for (const name of [rootSbomName, dashboardSbomName]) {
      mutateComponent(name, "name", "wrong-package");
      mutateComponent(name, "version", "9.9.9");
      mutateComponent(name, "purl", "pkg:npm/wrong-package@9.9.9");
      mutateComponent(name, "type", "application");
    }

    writeFileSync(join(outputDir, "unexpected.txt"), "extra\n");
    assert.match(failure(outputDir), /missing, extra, or stale/u);
    restore();

    unlinkSync(join(outputDir, manifestName));
    assert.match(failure(outputDir), /missing, extra, or stale/u);
    restore();

    writeFileSync(join(outputDir, rootSbomName), "\n", { flag: "a" });
    assert.match(failure(outputDir), /checksum mismatch/u);
    restore();

    const manifestPath = join(outputDir, manifestName);
    const manifest = readJson(manifestPath);
    manifest.commit = "0".repeat(40);
    writeJson(manifestPath, manifest);
    rewriteChecksums(outputDir);
    assert.match(failure(outputDir), /manifest identity/u);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
