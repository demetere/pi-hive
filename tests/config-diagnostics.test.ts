import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIG_LIMITS,
  createDiagnosticCollector,
  sourceRange,
  type ConfigDiagnostic,
} from "../src/config/diagnostics.ts";

function diagnostic(index: number): ConfigDiagnostic {
  return {
    code: "SCHEMA_INVALID",
    severity: "error",
    message: `diagnostic ${index}`,
    source: "config.yaml",
    range: sourceRange(index, 1, index + 1, index + 1, 1, index + 2),
  };
}

test("config limits and source positions use the frozen W01 contract", () => {
  assert.deepEqual(CONFIG_LIMITS, {
    inputBytes: 524_288,
    maxDepth: 64,
    maxNodes: 20_000,
    diagnostics: 100,
    related: 16,
    dependencyChain: 16,
    messageBytes: 2_048,
  });
  assert.deepEqual(sourceRange(2, 1, 3, 5, 2, 4), {
    start: { offset: 2, line: 1, column: 3 },
    end: { offset: 5, line: 2, column: 4 },
  });
});

test("diagnostic collection is deterministic and reserves one truncation marker", () => {
  const collector = createDiagnosticCollector();
  for (let index = 0; index < 105; index++) collector.add(diagnostic(index));
  const result = collector.result();

  assert.equal(result.truncated, true);
  assert.equal(result.diagnostics.length, CONFIG_LIMITS.diagnostics);
  assert.equal(result.diagnostics[0].message, "diagnostic 0");
  assert.equal(result.diagnostics[98].message, "diagnostic 98");
  assert.equal(result.diagnostics[99].code, "DIAGNOSTICS_TRUNCATED");
});

test("diagnostic fields are independently bounded without splitting UTF-8", () => {
  const collector = createDiagnosticCollector();
  collector.add({
    ...diagnostic(0),
    message: "😀".repeat(600),
    dependencyChain: Array.from({ length: 20 }, (_, index) => `resource-${index}`),
    related: Array.from({ length: 20 }, (_, index) => ({
      message: `related ${index}`,
      source: "related.yaml",
      range: sourceRange(index, 1, index + 1, index + 1, 1, index + 2),
    })),
  });

  const [bounded] = collector.result().diagnostics;
  assert.ok(Buffer.byteLength(bounded.message, "utf8") <= CONFIG_LIMITS.messageBytes);
  assert.equal(bounded.message.endsWith("…"), true);
  assert.equal(bounded.dependencyChain?.length, CONFIG_LIMITS.dependencyChain);
  assert.equal(bounded.related?.length, CONFIG_LIMITS.related);
});
