import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

test("Pi package manifest keeps the public workflow entrypoint, major, and supported OS boundary", () => {
  assert.equal(pkg.version, "1.0.0");
  assert.deepEqual(pkg.os, ["linux", "darwin"]);
  assert.equal(pkg.main, "index.ts");
  assert.equal(pkg.exports["."], "./index.ts");
  assert.deepEqual(pkg.pi.extensions, ["./index.ts"]);
});

test("package includes runtime schemas, examples, docs, and prebuilt dashboard", () => {
  for (const entry of ["index.ts", "src/", "native/", "schemas/", "examples/", "ui/web/dist/", "CHANGELOG.md", "README.md", "SETUP.md", "SECURITY.md"]) assert.ok(pkg.files.includes(entry), `files[] should include ${entry}`);
  assert.equal(pkg.files.some((entry: string) => entry.includes("review")), false);
});

test("Pi runtime dependencies stay wildcard peer dependencies", () => {
  for (const dep of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) assert.equal(pkg.peerDependencies[dep], "*");
});

test("runtime dependencies are pinned", () => {
  assert.equal(pkg.dependencies.yaml, "2.9.0");
  assert.equal(pkg.dependencies["@fission-ai/openspec"], "1.6.0");
});

test("package scripts delegate to Justfile commands", () => {
  assert.equal(pkg.scripts.test, "just test");
  assert.equal(pkg.scripts["build:darwin-native"], "just darwin-native-build");
  assert.equal(pkg.scripts["verify:darwin-native"], "just darwin-native-verify");
  assert.equal(pkg.scripts["verify:dashboard"], "just dashboard-verify");
  assert.equal(pkg.scripts["verify:config-schemas"], "just config-schema-verify");
  assert.equal(pkg.scripts["verify:package"], "just verify-package");
  assert.equal(pkg.scripts.ci, "just ci");
  assert.equal(pkg.scripts.prepack, "just prepack");
  assert.equal(pkg.scripts.prepublishOnly, "just prepublish");
});
