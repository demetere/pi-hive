import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FILESYSTEM_GLOB_LIMITS,
  compileFilesystemGlob,
  compileFilesystemGlobList,
  matchFilesystemGlob,
  normalizeFilesystemRelativePath,
} from "../src/capabilities/glob.ts";

test("filesystem glob grammar has deterministic segment semantics", () => {
  const vectors: Array<[string, string, boolean]> = [
    ["**", ".", true],
    ["**", ".env", true],
    ["src/**", "src", true],
    ["src/**", "src/deep/file.ts", true],
    ["src/**/file.ts", "src/file.ts", true],
    ["src/**/file.ts", "src/deep/file.ts", true],
    ["**/*.ts", "root.ts", true],
    ["**/*.ts", "src/root.ts", true],
    ["src/*.ts", "src/root.ts", true],
    ["src/*.ts", "src/deep/root.ts", false],
    ["src/?.ts", "src/é.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["src/.*", "src/.env", true],
    ["README.md", "readme.md", false],
  ];
  for (const [pattern, value, expected] of vectors) {
    assert.equal(matchFilesystemGlob(compileFilesystemGlob(pattern), value), expected, `${pattern} :: ${value}`);
  }
});

test("filesystem glob normalization is NFC, POSIX-only, and rejects ambiguous grammar", () => {
  assert.equal(compileFilesystemGlob("cafe\u0301/**").pattern, "café/**");
  assert.equal(normalizeFilesystemRelativePath("cafe\u0301/file.txt"), "café/file.txt");
  assert.equal(matchFilesystemGlob(compileFilesystemGlob("café/**"), "cafe\u0301/file.txt"), true);

  for (const pattern of ["", ".", "./src/**", "/src/**", "!src/**", "src\\**", "src//**", "src/../x", "src/./x", "src/**x", "src/[ab]", "src/{a,b}", "src/(a)", "src/\u0000x"]) {
    assert.throws(() => compileFilesystemGlob(pattern), /FILESYSTEM_GLOB_INVALID/, pattern);
  }
  for (const value of ["../x", "/x", "src\\x", "src//x", "src/./x", "C:\\x"])
    assert.throws(() => normalizeFilesystemRelativePath(value), /FILESYSTEM_PATH_INVALID/, value);
});

test("filesystem glob compilation and evaluation are bounded", () => {
  assert.throws(
    () => compileFilesystemGlobList(Array.from({ length: FILESYSTEM_GLOB_LIMITS.patterns + 1 }, (_, index) => `p${index}/**`)),
    /FILESYSTEM_GLOB_LIMIT_EXCEEDED/,
  );
  assert.throws(() => compileFilesystemGlob(`${"a".repeat(FILESYSTEM_GLOB_LIMITS.patternBytes)}/**`), /FILESYSTEM_GLOB_LIMIT_EXCEEDED/);
  assert.throws(() => compileFilesystemGlob(`${Array.from({ length: FILESYSTEM_GLOB_LIMITS.segments + 1 }, () => "a").join("/")}`), /FILESYSTEM_GLOB_LIMIT_EXCEEDED/);
  const compiled = compileFilesystemGlobList(["src/**", "tests/**", "docs/**"]);
  assert.equal(compiled.length, 3);
  assert.equal(Object.isFrozen(compiled), true);
});
