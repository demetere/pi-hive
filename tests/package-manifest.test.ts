import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("Pi package manifest keeps a safe extension entrypoint", () => {
  assert.equal(pkg.main, "index.ts");
  assert.equal(pkg.exports["."], "./index.ts");
  assert.deepEqual(pkg.pi.extensions, ["./index.ts"]);
});

test("package includes runtime assets and prebuilt dashboard", () => {
  for (const entry of ["index.ts", "src/", "ui/web/dist/"]) {
    assert.ok(pkg.files.includes(entry), `files[] should include ${entry}`);
  }
});

test("Pi runtime dependencies stay peer dependencies with wildcard ranges", () => {
  for (const dep of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
    assert.equal(pkg.peerDependencies[dep], "*");
  }
});

test("package scripts delegate to Justfile commands", () => {
  assert.equal(pkg.scripts.test, "just test");
  assert.equal(pkg.scripts["verify:dashboard"], "just dashboard-verify");
  assert.equal(pkg.scripts["verify:package"], "just verify-package");
  assert.equal(pkg.scripts.ci, "just ci");
  assert.equal(pkg.scripts.prepack, "just prepack");
  assert.equal(pkg.scripts.prepublishOnly, "just prepublish");
});
