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

function walk(abs, acc) {
  let st;
  try { st = statSync(abs); } catch { return; }
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort()) walk(join(abs, name), acc);
  } else {
    acc.push([relative(WEB_DIR, abs), readFileSync(abs)]);
  }
}

export function dashboardSourceHash() {
  const files = [];
  for (const input of INPUTS) walk(join(WEB_DIR, input), files);
  files.sort((a, b) => a[0].localeCompare(b[0]));
  const h = createHash("sha256");
  for (const [rel, buf] of files) { h.update(rel); h.update("\0"); h.update(buf); h.update("\0"); }
  return h.digest("hex");
}

export const STAMP_PATH = join(WEB_DIR, "dist", ".build-hash");
