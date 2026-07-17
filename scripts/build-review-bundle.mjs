#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { readVerifiedReviewVendor } from "./check-review-vendor.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(root, "ui", "review", "src");
const distDir = join(root, "ui", "review", "dist");
const files = ["review.html", "review.css", "review.js"];

const vendor = readVerifiedReviewVendor(root);
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
const manifest = {
  version: 2,
  vendor: vendor.package,
  files: {},
};
for (const name of files) {
  const source = join(sourceDir, name);
  if (!existsSync(source)) throw new Error(`Missing review bundle source: ${source}`);
  const raw = readFileSync(source);
  const compressed = gzipSync(raw, { level: 9, mtime: 0 });
  const output = `${name}.gz`;
  writeFileSync(join(distDir, output), compressed);
  manifest.files[name] = {
    path: output,
    contentType: name.endsWith(".html") ? "text/html; charset=utf-8" : name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
    bytes: raw.byteLength,
    compressedBytes: compressed.byteLength,
    sourceSha256: createHash("sha256").update(raw).digest("hex"),
    sha256: createHash("sha256").update(compressed).digest("hex"),
  };
  console.log(`${basename(source)}: ${raw.byteLength} -> ${compressed.byteLength} bytes`);
}
writeFileSync(join(distDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
