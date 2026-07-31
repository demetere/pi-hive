#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(root, "native");
const source = readFileSync(join(nativeRoot, "darwin-descriptor.c"));
const expected = readFileSync(join(nativeRoot, "darwin-descriptor.sha256"), "utf8").trim();
const actual = createHash("sha256").update(source).digest("hex");
if (!/^[0-9a-f]{64}$/u.test(expected) || expected !== actual) throw new Error("Darwin native source fingerprint is stale");
for (const architecture of ["arm64", "x64"]) {
  const binary = join(nativeRoot, `darwin-${architecture}.node`);
  if (!existsSync(binary) || !readFileSync(binary).includes(Buffer.from(expected, "ascii"))) throw new Error(`Darwin ${architecture} native helper is missing or stale`);
}
if (process.platform === "darwin") {
  if (process.arch !== "arm64" && process.arch !== "x64") throw new Error(`Unsupported Darwin architecture ${process.arch}`);
  const loaded = createRequire(import.meta.url)(join(nativeRoot, `darwin-${process.arch}.node`));
  if (loaded.sourceHash() !== expected) throw new Error("Loaded Darwin native helper identity differs from its source");
}
console.log(`✓ Darwin descriptor helpers match ${expected}`);
