import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const VENDOR_SCRIPT = resolve("scripts/check-review-vendor.mjs");
const BUDGET_SCRIPT = new URL("../../scripts/check-package-budgets.mjs", import.meta.url).href;

function sha256(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeVendorFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-vendor-"));
  const packageName = "@plannotator/pi-extension";
  const version = "0.21.4";
  const integrity = "sha512-test-integrity";
  const artifact = "upstream review";
  const sources = {
    "review.html": "<main>review</main>",
    "review.css": "main { display: block; }",
    "review.js": "export {};",
  };
  mkdirSync(join(root, "ui", "review", "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "@plannotator", "pi-extension"), { recursive: true });
  writeJson(join(root, "package.json"), { devDependencies: { [packageName]: version } });
  writeJson(join(root, "package-lock.json"), {
    packages: {
      "": { devDependencies: { [packageName]: version } },
      "node_modules/@plannotator/pi-extension": { version, integrity },
    },
  });
  writeJson(join(root, "node_modules", "@plannotator", "pi-extension", "package.json"), { name: packageName, version });
  writeFileSync(join(root, "node_modules", "@plannotator", "pi-extension", "plannotator.html"), artifact);
  for (const [name, content] of Object.entries(sources)) writeFileSync(join(root, "ui", "review", "src", name), content);
  writeJson(join(root, "ui", "review", "vendor.json"), {
    schemaVersion: 1,
    package: {
      name: packageName,
      version,
      integrity,
      artifact: "plannotator.html",
      artifactSha256: sha256(artifact),
    },
    derivedSources: Object.fromEntries(Object.entries(sources).map(([name, content]) => [name, sha256(content)])),
  });
  return root;
}

function runVendorCheck(root: string) {
  return spawnSync(process.execPath, [VENDOR_SCRIPT, root], { encoding: "utf8" });
}

test("review vendor verification binds package, lockfile, upstream artifact, and derived sources", (t) => {
  const root = makeVendorFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const valid = runVendorCheck(root);
  assert.equal(valid.status, 0, valid.stderr);

  writeJson(join(root, "package.json"), { devDependencies: { "@plannotator/pi-extension": "0.21.5" } });
  const changedDependency = runVendorCheck(root);
  assert.equal(changedDependency.status, 1);
  assert.match(changedDependency.stderr, /must pin .* exactly 0\.21\.4/);

  writeJson(join(root, "package.json"), { devDependencies: { "@plannotator/pi-extension": "0.21.4" } });
  writeFileSync(join(root, "ui", "review", "src", "review.js"), "changed");
  const changedSource = runVendorCheck(root);
  assert.equal(changedSource.status, 1);
  assert.match(changedSource.stderr, /changed without refreshing ui\/review\/vendor\.json/);
});

test("package allowlist rejects build inputs, maps, and unrelated files", () => {
  const expression = `
    import { isAllowedPackagePath, regressionLimit } from ${JSON.stringify(BUDGET_SCRIPT)};
    const paths = process.argv.slice(1);
    console.log(JSON.stringify({ allowed: paths.map(isAllowedPackagePath), limit: regressionLimit(1000) }));
  `;
  const paths = [
    "src/engine/session.ts",
    "src/artifacts/contracts.ts",
    "ui/web/dist/assets/index-AbC_123.js",
    "ui/review/vendor.json",
    "ui/web/src/App.tsx",
    "ui/web/dist/assets/index.js.map",
    "notes/private.txt",
  ];
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", expression, ...paths], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.allowed, [true, true, true, true, false, false, false]);
  assert.equal(output.limit, 1100);
});
