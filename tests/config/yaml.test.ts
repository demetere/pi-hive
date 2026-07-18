import assert from "node:assert/strict";
import { test } from "node:test";
import { findUnquotedColon, parseYamlLite } from "../../src/core/yaml.ts";

test("findUnquotedColon ignores colons inside quoted scalars", () => {
  assert.equal(findUnquotedColon('path: value'), 4);
  assert.equal(findUnquotedColon('"inline: context"'), -1);
  assert.equal(findUnquotedColon("'inline: context'"), -1);
  assert.equal(findUnquotedColon('name: "inline: context"'), 4);
});

test("parseYamlLite keeps quoted list items containing colons as strings", () => {
  const parsed = parseYamlLite(`
shared_context:
  - "iMed is HIPAA-regulated: no TODOs, no placeholders"
  - 'Another inline note: still text'
`);

  assert.deepEqual(parsed.shared_context, [
    "iMed is HIPAA-regulated: no TODOs, no placeholders",
    "Another inline note: still text",
  ]);
});

test("parseYamlLite still parses unquoted list mappings", () => {
  const parsed = parseYamlLite(`
context:
  - path: .pi/hive/knowledge/foo.md
    use-when: Always
`);

  assert.deepEqual(parsed.context, [
    { path: ".pi/hive/knowledge/foo.md", useWhen: "Always" },
  ]);
});
