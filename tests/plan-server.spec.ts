// Bun-only test for the dashboard plan endpoints' data layer, now OpenSpec-backed
// (server/plan-routes.ts + server/plan-bridge.ts + bun:sqlite).
// Run: bun test ./tests/plan-server.spec.ts
import { expect, test, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT = mkdtempSync(join(tmpdir(), "pi-hive-plansrv-"));
// server/config.ts reads these at import; point them at throwaway locations.
process.env.HIVE_PROJECT_CWD = PROJECT;
process.env.HIVE_TELEMETRY_DB = join(mkdtempSync(join(tmpdir(), "pi-hive-plansrv-db-")), "telemetry.db");

// Resolve the OpenSpec binary the same way src/engine/openspec.ts does; skip the
// CLI-dependent assertions when it is absent.
const OSX_BIN = join(process.cwd(), "node_modules", ".bin", "openspec");
const OSX = existsSync(OSX_BIN);
function osx(args: string[]) {
  execFileSync(OSX_BIN, args, { cwd: PROJECT, stdio: "ignore", env: { ...process.env, OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1" } });
}

let routes: typeof import("../src/observability/server/plan-routes");
let bridge: typeof import("../src/observability/server/plan-bridge");

beforeAll(async () => {
  if (OSX) {
    osx(["init", "--tools", "pi"]);
    osx(["new", "change", "add-auth"]);
    const dir = join(PROJECT, "openspec", "changes", "add-auth");
    writeFileSync(join(dir, "proposal.md"), "# Add auth\n\nWe need login.\n");
    writeFileSync(join(dir, "tasks.md"), "# Tasks\n\n- [x] one\n- [ ] two\n");
  } else {
    // Minimal on-disk change so the non-CLI path guards still exercise.
    mkdirSync(join(PROJECT, "openspec", "changes", "add-auth"), { recursive: true });
    writeFileSync(join(PROJECT, "openspec", "changes", "add-auth", "proposal.md"), "# Add auth\n\nWe need login.\n");
  }
  routes = await import("../src/observability/server/plan-routes");
  bridge = await import("../src/observability/server/plan-bridge");
});

test.if(OSX)("listPlans returns OpenSpec change summaries", () => {
  const list = routes.listPlans(PROJECT);
  expect(list.length).toBe(1);
  expect(list[0].changeId).toBe("add-auth");
  expect(list[0].totalTasks).toBe(2);
  expect(list[0].completedTasks).toBe(1);
  expect(list[0].status).toBe("in-progress");
});

test.if(OSX)("planDetail includes artifact graph + validation + empty verdicts", () => {
  const detail = routes.planDetail(PROJECT, "add-auth")!;
  expect(detail).not.toBeNull();
  expect(detail.artifacts.find((a) => a.id === "proposal")?.status).toBe("done");
  expect(detail.files).toContain("proposal.md");
  expect(detail.verdicts).toEqual([]);
  expect(typeof detail.validation.passed).toBe("boolean");
  expect(routes.planDetail(PROJECT, "nope")).toBeNull();
});

test("planFile reads an artifact and guards against traversal", () => {
  expect(routes.planFile(PROJECT, "add-auth", "proposal.md")?.content).toContain("We need login.");
  expect(routes.planFile(PROJECT, "add-auth", "../../../../etc/passwd")).toBeNull();
  expect(routes.planFile(PROJECT, "../escape", "proposal.md")).toBeNull();
  expect(routes.planDetail(PROJECT, "../escape")).toBeNull();
});

test("resolveProjectCwd rejects an unknown cwd and echoes a known one", () => {
  expect(bridge.resolveProjectCwd("/some/other/path")).toBeNull();
  const fallback = bridge.resolveProjectCwd(null);
  expect(typeof fallback).toBe("string");
  expect(bridge.resolveProjectCwd(fallback)).toBe(fallback);
});
