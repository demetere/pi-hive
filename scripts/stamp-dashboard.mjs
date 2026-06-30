// Writes the current source hash into dist/.build-hash. Run right after a
// successful `vite build` so the committed dist/ records which sources produced
// it. The freshness check (check-dashboard-fresh.mjs) compares against this.
import { writeFileSync } from "node:fs";
import { dashboardSourceHash, STAMP_PATH } from "./dashboard-hash.mjs";

writeFileSync(STAMP_PATH, dashboardSourceHash() + "\n");
console.log("stamped dashboard build:", STAMP_PATH);
