// Bun-only test for the dashboard plan endpoints' data layer, now OpenSpec-backed
// (server/plan-routes.ts + server/plan-bridge.ts + bun:sqlite).
// Run: bun test ./tests/plan-server.spec.ts
import { expect, test, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT = mkdtempSync(join(tmpdir(), "pi-hive-plansrv-"));
// server/config.ts reads these at import; point them at throwaway locations.
process.env.HIVE_PROJECT_CWD = PROJECT;
process.env.HIVE_TELEMETRY_DB = join(mkdtempSync(join(tmpdir(), "pi-hive-plansrv-db-")), "telemetry.db");
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-hive-plansrv-agent-"));

// Resolve the OpenSpec binary the same way src/engine/openspec.ts does; skip the
// CLI-dependent assertions when it is absent.
const OSX_BIN = join(process.cwd(), "node_modules", ".bin", "openspec");
const OSX = existsSync(OSX_BIN);
function osx(args: string[]) {
  execFileSync(OSX_BIN, args, { cwd: PROJECT, stdio: "ignore", env: { ...process.env, OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1" } });
}

let routes: typeof import("../src/observability/server/plan-routes");
let bridge: typeof import("../src/observability/server/plan-bridge");
let review: typeof import("../src/observability/server/review-wiring");
let db: typeof import("../src/observability/server/db");
let openspec: typeof import("../src/engine/openspec");

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
  review = await import("../src/observability/server/review-wiring");
  db = await import("../src/observability/server/db");
  openspec = await import("../src/engine/openspec");
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

const REVIEW_ORIGIN = "http://127.0.0.1:43191";
const REVIEW_HEADERS = { host: "127.0.0.1:43191", origin: REVIEW_ORIGIN };

async function approveProposal(changeId: string, activeProject: string) {
  const rid = `${changeId}#proposal.md`;
  const mint = new Request(`${REVIEW_ORIGIN}/review-sessions`, {
    method: "POST",
    headers: { ...REVIEW_HEADERS, "content-type": "application/json", referer: `${REVIEW_ORIGIN}/` },
    body: JSON.stringify({ rid, cwd: activeProject }),
  });
  const minted = await review.handlePlanReview(mint, new URL(mint.url));
  expect(minted?.status).toBe(201);
  const { reviewUrl } = await minted!.json() as { reviewUrl: string };
  const req = new Request(`${REVIEW_ORIGIN}/api/approve`, {
    method: "POST",
    headers: { ...REVIEW_HEADERS, "content-type": "application/json", referer: `${REVIEW_ORIGIN}${reviewUrl}` },
    body: JSON.stringify({ feedback: "looks good" }),
  });
  return review.handlePlanReview(req, new URL(req.url));
}

test("review approval ignores legacy SQLite-only agent verdicts", async () => {
  const activeProject = bridge.resolveProjectCwd(null)!;
  const changeId = "legacy-agent-green";
  const dir = join(activeProject, "openspec", "changes", changeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proposal.md"), "# Legacy agent green\n\nReady.\n");
  db.insertPlanVerdict({
    id: "legacy-agent-green-verdict",
    changeId,
    reviewer: "Plan Reviewer",
    verdict: "green",
    summary: "ready for human review",
    cwd: activeProject,
    createdAt: new Date().toISOString(),
  });

  try {
    const res = await approveProposal(changeId, activeProject);
    expect(res?.status).toBe(409);
    expect(openspec.artifactVerdict(activeProject, changeId, "proposal.md")).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review approval accepts a current content-bound automated verdict", async () => {
  const activeProject = bridge.resolveProjectCwd(null)!;
  const changeId = "current-agent-green";
  const dir = join(activeProject, "openspec", "changes", changeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proposal.md"), "# Current agent green\n\nReady.\n");
  openspec.setAgentReviewVerdict(activeProject, changeId, "proposal", "green", "Plan Reviewer");

  try {
    const res = await approveProposal(changeId, activeProject);
    expect(res?.status).toBe(200);
    expect(openspec.artifactVerdict(activeProject, changeId, "proposal")).toBe("green");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review approval does not borrow SQLite verdicts for another artifact", async () => {
  const activeProject = bridge.resolveProjectCwd(null)!;
  const changeId = "sidecar-mismatch";
  const dir = join(activeProject, "openspec", "changes", changeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proposal.md"), "# Sidecar mismatch\n\nReady.\n");
  db.insertPlanVerdict({
    id: "sidecar-mismatch-green-verdict",
    changeId,
    reviewer: "Plan Reviewer",
    verdict: "green",
    summary: "change-level green should not clear proposal when sidecar exists for tasks",
    cwd: activeProject,
    createdAt: new Date().toISOString(),
  });

  try {
    const res = await approveProposal(changeId, activeProject);
    expect(res?.status).toBe(409);
    expect(openspec.artifactVerdict(activeProject, changeId, "proposal.md")).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.if(OSX)("planDetail does not show review-now for artifacts missing authoritative verdicts", () => {
  const changeId = "sidecar-mismatch-detail";
  osx(["new", "change", changeId]);
  const dir = join(PROJECT, "openspec", "changes", changeId);
  writeFileSync(join(dir, "proposal.md"), "# Sidecar mismatch detail\n\nReady.\n");
  db.insertPlanVerdict({
    id: "sidecar-mismatch-detail-green-verdict",
    changeId,
    reviewer: "Plan Reviewer",
    verdict: "green",
    summary: "legacy change-level green",
    cwd: PROJECT,
    createdAt: new Date().toISOString(),
  });

  try {
    const detail = routes.planDetail(PROJECT, changeId)!;
    const proposal = detail.artifactReview.find((a) => a.id === "proposal")!;
    expect(proposal.authored).toBe(true);
    expect(proposal.agentCleared).toBe(false);
    expect(proposal.humanReviewReady).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
