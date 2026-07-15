import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const reviewVendor = JSON.parse(readFileSync(new URL("../ui/review/vendor.json", import.meta.url), "utf8"));

test("Pi package manifest keeps a safe extension entrypoint", () => {
  assert.equal(pkg.main, "index.ts");
  assert.equal(pkg.exports["."], "./index.ts");
  assert.deepEqual(pkg.pi.extensions, ["./index.ts"]);
});

test("package includes runtime assets, prebuilt UIs, and review provenance", () => {
  for (const entry of ["index.ts", "src/", "ui/web/dist/", "ui/review/dist/", "ui/review/vendor.json", "scripts/check-review-vendor.mjs"]) {
    assert.ok(pkg.files.includes(entry), `files[] should include ${entry}`);
  }
});

test("Pi runtime dependencies stay peer dependencies with wildcard ranges", () => {
  for (const dep of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
    assert.equal(pkg.peerDependencies[dep], "*");
  }
});

test("Plannotator is pinned only as a reproducibility dependency", () => {
  assert.equal(pkg.devDependencies["@plannotator/pi-extension"], reviewVendor.package.version);
  assert.equal(pkg.dependencies?.["@plannotator/pi-extension"], undefined);
});

test("package scripts delegate to Justfile commands", () => {
  assert.equal(pkg.scripts.test, "just test");
  assert.equal(pkg.scripts["verify:dashboard"], "just dashboard-verify");
  assert.equal(pkg.scripts["verify:package"], "just verify-package");
  assert.equal(pkg.scripts.ci, "just ci");
  assert.equal(pkg.scripts.prepack, "just prepack");
  assert.equal(pkg.scripts.prepublishOnly, "just prepublish");
});
