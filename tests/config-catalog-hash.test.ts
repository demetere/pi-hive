import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATALOG_HASH_VERSION,
  canonicalCatalogText,
  decodeCatalogText,
  hashCatalogFrames,
} from "../src/config/catalog-hash.ts";

test("catalog hashes use versioned length framing and canonicalize only line endings", () => {
  assert.equal(CATALOG_HASH_VERSION, "pi-hive-catalog-hash-v1");
  assert.equal(canonicalCatalogText("a\r\nb\rc\n"), "a\nb\nc\n");
  assert.notEqual(hashCatalogFrames("skill-file", ["ab", "c"]), hashCatalogFrames("skill-file", ["a", "bc"]));
  assert.equal(hashCatalogFrames("agent-prompt", ["a\r\nb"]), hashCatalogFrames("agent-prompt", ["a\nb"]));
  assert.notEqual(hashCatalogFrames("agent-source", ["a\r\nb"]), hashCatalogFrames("agent-source", ["a\nb"]));
  assert.match(hashCatalogFrames("knowledge-root-metadata", ["x"]), /^[a-f0-9]{64}$/);
});

test("catalog text decoding is fatal for malformed UTF-8", () => {
  assert.equal(decodeCatalogText(Buffer.from("hello")), "hello");
  assert.throws(() => decodeCatalogText(Buffer.from([0xc3, 0x28])), /UTF-8/);
});
