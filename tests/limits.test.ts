import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clip, tailLines, truncateMiddle } from "../src/core/format.ts";
import { readIfSmall } from "../src/core/fs.ts";

test("truncation and tail helpers fail safely on non-finite and negative limits", () => {
  const text = "x".repeat(50_000);
  assert.ok(truncateMiddle(text, Number.NaN).length < 13_000);
  assert.equal(clip(text, Number.POSITIVE_INFINITY).text.length, 8_000);
  assert.equal(tailLines(Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n"), -1).split("\n").length, 80);
});

test("readIfSmall does not turn a NaN limit into an unbounded read", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pi-hive-limit-")), "large.txt");
  writeFileSync(file, "x".repeat(100_000));
  assert.equal(readIfSmall(file, Number.NaN), "");
});
