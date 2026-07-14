#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const limits = {
  packedBytes: 600 * 1024,
  unpackedBytes: 1536 * 1024,
  reviewRawBytes: 32 * 1024,
  reviewCompressedBytes: 10 * 1024,
};
const failures = [];
const manifest = JSON.parse(readFileSync(join(root, "ui", "review", "dist", "manifest.json"), "utf8"));
const reviewFiles = Object.values(manifest.files || {});
const reviewRaw = reviewFiles.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
const reviewCompressed = reviewFiles.reduce((sum, file) => sum + Number(file.compressedBytes || 0), 0);
if (reviewRaw > limits.reviewRawBytes) failures.push(`review bundle raw size ${reviewRaw} exceeds ${limits.reviewRawBytes} bytes`);
if (reviewCompressed > limits.reviewCompressedBytes) failures.push(`review bundle compressed size ${reviewCompressed} exceeds ${limits.reviewCompressedBytes} bytes`);

const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
if (packed.status !== 0) {
  failures.push(`npm pack dry-run failed: ${(packed.stderr || packed.stdout).trim()}`);
} else {
  try {
    const result = JSON.parse(packed.stdout)[0];
    if (result.size > limits.packedBytes) failures.push(`packed package size ${result.size} exceeds ${limits.packedBytes} bytes`);
    if (result.unpackedSize > limits.unpackedBytes) failures.push(`unpacked package size ${result.unpackedSize} exceeds ${limits.unpackedBytes} bytes`);
    console.log(`package: ${result.size} packed / ${result.unpackedSize} unpacked bytes`);
  } catch (error) {
    failures.push(`could not parse npm pack dry-run output: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`review bundle: ${reviewRaw} raw / ${reviewCompressed} compressed bytes`);
if (failures.length) {
  console.error("✗ package budget check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("✓ package and review bundle budgets are within limits");
