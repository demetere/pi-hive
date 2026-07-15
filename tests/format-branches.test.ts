import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundedDiagnostics,
  clip,
  extractFinalAnswer,
  hexAnsi,
  safeJson,
  slug,
  tailLines,
  textFromMessage,
  textOfResult,
  truncateMiddle,
} from "../src/core/format.ts";

test("format helpers handle sparse, malformed, and circular values", () => {
  assert.equal(slug("!!!"), "agent");
  assert.equal(slug(" Hello, World! "), "hello-world");
  assert.equal(hexAnsi(undefined, "x"), null);
  assert.equal(hexAnsi("bad", "x"), null);
  assert.match(hexAnsi("#204060", "x") || "", /32;64;96/);
  assert.match(hexAnsi("204060", "x", true) || "", /16;32;48/);

  assert.equal(textFromMessage(null), "");
  assert.equal(textFromMessage({ content: "plain" }), "plain");
  assert.equal(textFromMessage({ content: [{ text: "a" }, { content: "b" }, null, {}] }), "a\nb");
  assert.equal(textFromMessage({ text: "fallback" }), "fallback");
  assert.equal(textFromMessage({ content: { nested: true } }), '{"nested":true}');
  const circular: any = {};
  circular.self = circular;
  assert.equal(textFromMessage(circular), "[object Object]");

  assert.equal(safeJson(undefined), "undefined");
  assert.equal(safeJson(circular), "[object Object]");
  assert.equal(textOfResult(null), "");
  assert.equal(textOfResult("result"), "result");
  assert.equal(textOfResult({ text: "text" }), "text");
  assert.equal(textOfResult({ content: [{ text: "a" }, { content: "b" }, null] }), "a\nb");
  assert.equal(textOfResult({ output: "output" }), "output");
  assert.equal(textOfResult({ ok: true }), '{"ok":true}');
});

test("bounded text helpers enforce safe fallback and ceiling behavior", () => {
  assert.equal(truncateMiddle("short", 10), "short");
  assert.match(truncateMiddle("x".repeat(100), 20), /truncated/);
  assert.equal(truncateMiddle("short", Number.NaN), "short");

  assert.deepEqual(clip("short", 10), { text: "short", truncated: false });
  assert.deepEqual(clip("abcdef", 3), { text: "abc", truncated: true });
  assert.deepEqual(clip("short", -1), { text: "short", truncated: false });
  assert.equal(tailLines("\na\n\nb\nc\n", 2), "b\nc");
  assert.equal(tailLines("a\nb", Number.POSITIVE_INFINITY), "a\nb");
  assert.equal(extractFinalAnswer("before <final_answer> done </final_answer> after"), "done");
  assert.equal(extractFinalAnswer("none"), null);
  assert.equal(extractFinalAnswer("<final_answer> </final_answer>"), null);
});

test("diagnostic bounding rejects absent and empty collections", () => {
  assert.equal(boundedDiagnostics(undefined), undefined);
  assert.equal(boundedDiagnostics([]), undefined);
  assert.equal(boundedDiagnostics([null, {}]), undefined);
});

test("diagnostic bounding keeps typed and error entries without undefined fields", () => {
  const diagnostics = boundedDiagnostics([
    null,
    {},
    { type: "warning" },
    { error: { message: "x".repeat(500) } },
    { type: "both", error: { message: "message" } },
  ], 2);
  assert.equal(diagnostics?.length, 2);
  assert.deepEqual(diagnostics?.[0], { type: "warning" });
  assert.equal(Object.hasOwn(diagnostics?.[0] || {}, "message"), false);
  assert.match(diagnostics?.[1].message || "", /truncated/);
  assert.equal(boundedDiagnostics([{ type: "one" }], Number.NaN)?.length, 1);
  assert.equal(boundedDiagnostics([{}, null]), undefined);
});
