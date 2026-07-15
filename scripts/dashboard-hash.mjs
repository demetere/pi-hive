// Computes a stable hash of the dashboard's source inputs (everything that
// affects the build output). Shared by the build-stamp and the freshness check
// so both agree on what "the source" is.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "web");

// Files/dirs whose contents determine the built output. Lockfile included so a
// dependency bump invalidates the stamp; node_modules and dist are excluded.
const INPUTS = ["src", "index.html", "vite.config.ts", "tsconfig.json", "package.json", "package-lock.json"];

function walk(abs, acc, webDir) {
  let st;
  try { st = statSync(abs); } catch { return; }
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort()) walk(join(abs, name), acc, webDir);
  } else {
    acc.push([relative(webDir, abs), readFileSync(abs)]);
  }
}

export function dashboardSourceHash(webDir = WEB_DIR) {
  const files = [];
  for (const input of INPUTS) walk(join(webDir, input), files, webDir);
  files.sort((a, b) => a[0].localeCompare(b[0]));
  const h = createHash("sha256");
  for (const [rel, buf] of files) { h.update(rel); h.update("\0"); h.update(buf); h.update("\0"); }
  return h.digest("hex");
}

export function dashboardStampPath(webDir = WEB_DIR) {
  return join(webDir, "dist", ".build-hash");
}

export const STAMP_PATH = dashboardStampPath();
