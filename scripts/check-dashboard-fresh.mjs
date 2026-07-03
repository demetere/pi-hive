// Fails (exit 1) if the committed dashboard dist/ is stale relative to its
// source — i.e. someone edited ui/web/src/ but did not rebuild. Use in a
// pre-commit hook or CI gate so stale UI never ships.
import { existsSync, readFileSync } from "node:fs";
import { dashboardSourceHash, STAMP_PATH } from "./dashboard-hash.mjs";

if (!existsSync(STAMP_PATH)) {
  console.error("✗ dashboard dist/ has no build stamp. Run: just dashboard-build");
  process.exit(1);
}

const stamped = readFileSync(STAMP_PATH, "utf8").trim();
const current = dashboardSourceHash();

if (stamped !== current) {
  console.error("✗ dashboard dist/ is STALE — ui/web/src changed since the last build.");
  console.error("  Rebuild before committing/packing: just dashboard-build");
  process.exit(1);
}

console.log("✓ dashboard dist/ is up to date with ui/web/src");
