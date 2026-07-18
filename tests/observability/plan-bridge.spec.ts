import { beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_TELEMETRY_DB ||= join(mkdtempSync(join(tmpdir(), "pi-hive-plan-bridge-db-")), "telemetry.db");

let runtime: typeof import("../../src/observability/server/runtime");
let bridge: typeof import("../../src/observability/server/plan-bridge");

beforeAll(async () => {
  runtime = await import("../../src/observability/server/runtime");
  bridge = await import("../../src/observability/server/plan-bridge");
});

function addSnapshot(root: string, cwd: string, sessionId: string, updatedAt: string, withSessionDir = true) {
  const dir = join(root, sessionId);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "events.jsonl");
  const stateFile = join(dir, "hive-state.json");
  writeFileSync(log, "");
  writeFileSync(stateFile, JSON.stringify({
    updated_at: updatedAt,
    session_id: sessionId,
    project_id: `project-${cwd.split("/").at(-1)}`,
    project_root: cwd,
    cwd,
    session_dir: withSessionDir ? dir : undefined,
    agents: [],
  }));
  runtime.addSource(log, { session_id: sessionId, cwd, session_dir: withSessionDir ? dir : undefined, state_file: stateFile });
  return dir;
}

test("plan bridge targets an owner session then falls back to the newest project session", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-plan-bridge-"));
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  const older = addSnapshot(root, cwd, "bridge-older", "2026-07-15T01:00:00.000Z");
  const newer = addSnapshot(root, cwd, "bridge-newer", "2026-07-15T02:00:00.000Z");

  expect(bridge.knownCwds()).toContain(cwd);
  expect(bridge.resolveProjectCwd(cwd)).toBe(cwd);
  expect(bridge.resolveProjectCwd(join(root, "unknown"))).toBeNull();

  expect(bridge.enqueueDashboardAction(cwd, { type: "owner" }, "bridge-older")).toBe(true);
  expect(readFileSync(join(older, "dashboard-actions.jsonl"), "utf8")).toContain('"type":"owner"');

  expect(bridge.enqueueDashboardAction(cwd, { type: "newest" }, "missing-owner")).toBe(true);
  expect(readFileSync(join(newer, "dashboard-actions.jsonl"), "utf8")).toContain('"type":"newest"');
});

test("plan bridge fails closed when the matching session has no writable directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-plan-bridge-no-dir-"));
  const cwd = join(root, "project-no-dir");
  mkdirSync(cwd, { recursive: true });
  addSnapshot(root, cwd, "bridge-no-dir", "2026-07-15T03:00:00.000Z", false);
  expect(bridge.enqueueDashboardAction(cwd, { type: "ignored" })).toBe(false);
  expect(existsSync(join(root, "dashboard-actions.jsonl"))).toBe(false);
});
