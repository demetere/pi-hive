import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_LIMITS } from "../src/config/diagnostics.ts";
import { parseConfigYaml } from "../src/config/yaml.ts";

function firstDiagnostic(source: string) {
  const result = parseConfigYaml(source, "fixture.yaml");
  assert.equal(result.value, undefined);
  assert.ok(result.diagnostics.length > 0);
  return result.diagnostics[0];
}

test("strict YAML 1.2 parsing preserves literal and multiline data with a source map", () => {
  const source = [
    "values:",
    "  on: on",
    "  off: off",
    "  yes: yes",
    "  no: no",
    "instructions: |",
    "  ${HOME} $() `command` {{template}}",
    "tagged: !!str 1",
    'options: {"<<": literal}',
    "",
  ].join("\n");
  const result = parseConfigYaml(source, "fixture.yaml");

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.value?.data, {
    values: { on: "on", off: "off", yes: "yes", no: "no" },
    instructions: "${HOME} $() `command` {{template}}\n",
    tagged: "1",
    options: { "<<": "literal" },
  });
  assert.deepEqual(result.value?.sourceMap["/values/on"], {
    key: {
      start: { offset: 10, line: 2, column: 3 },
      end: { offset: 12, line: 2, column: 5 },
    },
    value: {
      start: { offset: 14, line: 2, column: 7 },
      end: { offset: 16, line: 2, column: 9 },
    },
  });
  assert.equal(result.value?.sourceMap["/instructions"].value.start.line, 6);
});

test("duplicate keys fail at the duplicate key's exact UTF-16 half-open range", () => {
  const diagnostic = firstDiagnostic("a: 1\na: 2\n");
  assert.equal(diagnostic.code, "YAML_DUPLICATE_KEY");
  assert.deepEqual(diagnostic.range, {
    start: { offset: 5, line: 2, column: 1 },
    end: { offset: 6, line: 2, column: 2 },
  });
});

test("strict YAML rejects unsafe or non-JSON constructs", () => {
  const cases: Array<[string, string]> = [
    ["a: &value 1\n", "YAML_ANCHOR_FORBIDDEN"],
    ["a: &value 1\nb: *value\n", "YAML_ANCHOR_FORBIDDEN"],
    ["a: *value\n", "YAML_ALIAS_FORBIDDEN"],
    ["<<: literal\n", "YAML_MERGE_KEY_FORBIDDEN"],
    ["a: !custom value\n", "YAML_TAG_FORBIDDEN"],
    ["a: !!timestamp 2026-01-01\n", "YAML_TAG_FORBIDDEN"],
    ["1: value\n", "YAML_NON_STRING_KEY"],
    ["a: .inf\n", "YAML_NON_FINITE_NUMBER"],
    ["a: .nan\n", "YAML_NON_FINITE_NUMBER"],
    ["a: 1\n---\nb: 2\n", "YAML_SYNTAX"],
    ["%YAML 1.1\n---\na: yes\n", "YAML_SYNTAX"],
    ["a: [\n", "YAML_SYNTAX"],
  ];

  for (const [source, code] of cases) {
    assert.equal(firstDiagnostic(source).code, code, source);
  }
});

test("byte, depth, and node guards reject bounded inputs", () => {
  const oversized = `value: ${"é".repeat(CONFIG_LIMITS.inputBytes / 2)}`;
  const sizeDiagnostic = firstDiagnostic(oversized);
  assert.equal(sizeDiagnostic.code, "CONFIG_INPUT_TOO_LARGE");
  assert.deepEqual(sizeDiagnostic.range.start, { offset: 0, line: 1, column: 1 });

  const deep = `${"[".repeat(CONFIG_LIMITS.maxDepth)}x${"]".repeat(CONFIG_LIMITS.maxDepth)}\n`;
  assert.equal(firstDiagnostic(deep).code, "YAML_MAX_DEPTH");

  const wide = `${Array.from({ length: CONFIG_LIMITS.maxNodes }, () => "- x").join("\n")}\n`;
  assert.equal(firstDiagnostic(wide).code, "YAML_MAX_NODES");

  const wideMap = `${Array.from(
    { length: CONFIG_LIMITS.maxNodes / 2 },
    (_, index) => `key-${index}: value`,
  ).join("\n")}\n`;
  assert.equal(firstDiagnostic(wideMap).code, "YAML_MAX_NODES");
});

test("YAML diagnostic floods remain within the shared diagnostic limit", () => {
  const source = `${Array.from({ length: 120 }, () => "duplicate: value").join("\n")}\n`;
  const result = parseConfigYaml(source, "flood.yaml");
  assert.equal(result.truncated, true);
  assert.equal(result.diagnostics.length, CONFIG_LIMITS.diagnostics);
  assert.equal(result.diagnostics.at(-1)?.code, "DIAGNOSTICS_TRUNCATED");
});
