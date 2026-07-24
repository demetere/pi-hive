#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("Darwin native helpers can only be built on macOS");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native", "darwin-descriptor.c");
const nodeHeaders = resolve(dirname(process.execPath), "..", "include", "node");
if (!existsSync(join(nodeHeaders, "node_api.h"))) throw new Error(`Node headers are unavailable at ${nodeHeaders}`);
mkdirSync(join(root, "native"), { recursive: true });
const sourceHash = createHash("sha256").update(readFileSync(source)).digest("hex");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${(result.stderr || result.stdout || "").trim()}`);
}

for (const architecture of ["arm64", "x86_64"]) {
  const destination = join(root, "native", `darwin-${architecture === "x86_64" ? "x64" : architecture}.node`);
  const temporary = `${destination}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  run("xcrun", ["clang", "-arch", architecture, "-mmacosx-version-min=12.0", "-bundle", "-undefined", "dynamic_lookup", "-DNAPI_VERSION=8", "-DNODE_GYP_MODULE_NAME=darwin_descriptor", `-DPI_HIVE_NATIVE_SOURCE_SHA256="${sourceHash}"`, `-I${nodeHeaders}`, "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", temporary]);
  run("codesign", ["--force", "--sign", "-", "--timestamp=none", temporary]);
  renameSync(temporary, destination);
  console.log(`built ${destination}`);
}
writeFileSync(join(root, "native", "darwin-descriptor.sha256"), `${sourceHash}\n`);
