import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { test } from "node:test";
import { hasForeignAbsoluteSyntax, isPathInside, resolveContainedPath, resolveProjectPath } from "../src/core/safe-path.ts";

test("segment-aware containment rejects sibling prefixes and traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-safe-path-"));
  const sibling = `${root}-sibling`;
  mkdirSync(sibling);
  assert.equal(isPathInside(root, root), true);
  assert.equal(isPathInside(root, join(root, "src/file.ts")), true);
  assert.equal(isPathInside(root, sibling), false);
  assert.equal(resolveProjectPath(root, "../outside.txt", { allowMissing: true }), null);
  assert.equal(resolveProjectPath(root, join(sibling, "outside.txt"), { allowMissing: true }), null);
});

test("existing paths use realpath and reject symlink escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-safe-path-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-hive-safe-outside-"));
  mkdirSync(join(root, "inside"));
  writeFileSync(join(root, "inside/file.txt"), "inside");
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(root, "inside/file.txt"), join(root, "inside-link"));
  symlinkSync(join(outside, "secret.txt"), join(root, "escape-link"));

  const inside = resolveProjectPath(root, "inside-link");
  assert.equal(inside?.canonicalPath, join(root, "inside/file.txt"));
  assert.equal(resolveProjectPath(root, "escape-link"), null);
  assert.equal(resolveContainedPath(root, join(root, "escape-link")), null);
});

test("new targets resolve through their nearest existing parent", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-safe-path-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-hive-safe-outside-"));
  mkdirSync(join(root, "inside"));
  symlinkSync(join(root, "inside"), join(root, "inside-dir-link"));
  symlinkSync(outside, join(root, "escape-dir-link"));

  const safeNew = resolveProjectPath(root, "inside-dir-link/new/deep.txt", { allowMissing: true });
  assert.equal(safeNew?.canonicalPath, join(root, "inside/new/deep.txt"));
  assert.equal(safeNew?.exists, false);
  assert.equal(resolveProjectPath(root, "escape-dir-link/new.txt", { allowMissing: true }), null);
  assert.equal(resolveProjectPath(root, "missing.txt"), null);
});

test("broken symlinks and foreign absolute syntax fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-safe-path-"));
  symlinkSync(join(root, "does-not-exist"), join(root, "broken"));
  assert.equal(resolveProjectPath(root, "broken", { allowMissing: true }), null);
  if (process.platform !== "win32") {
    assert.equal(hasForeignAbsoluteSyntax("C:\\outside\\secret.txt"), true);
    assert.equal(resolveProjectPath(root, "C:\\outside\\secret.txt", { allowMissing: true }), null);
  }
});

test("Windows containment uses path segments rather than string prefixes", () => {
  assert.equal(isPathInside("C:\\work\\app", "C:\\work\\app\\src\\x.ts", win32), true);
  assert.equal(isPathInside("C:\\work\\app", "C:\\work\\application\\x.ts", win32), false);
  assert.equal(isPathInside("C:\\work\\app", "D:\\work\\app\\x.ts", win32), false);
  assert.equal(isPathInside("C:\\work\\app", "C:\\work\\app\\..\\secret.txt", win32), false);
});
