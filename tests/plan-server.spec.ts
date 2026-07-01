// Bun-only test for the dashboard plan endpoints' data layer (server/plans.ts →
// bun:sqlite + fs). Run: bun test ./tests/plan-server.spec.ts
import { expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT = mkdtempSync(join(tmpdir(), "pi-hive-plansrv-"));
// server/config.ts reads these at import; point them at throwaway locations.
process.env.HIVE_PROJECT_CWD = PROJECT;
process.env.HIVE_TELEMETRY_DB = join(mkdtempSync(join(tmpdir(), "pi-hive-plansrv-db-")), "telemetry.db");

function writePlan(id: string, files: Record<string, string>) {
  const dir = join(PROJECT, ".pi", "hive", "plans", id);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

let plans: typeof import("../src/observability/server/plans");

beforeAll(async () => {
  writePlan("add-auth", {
    "plan.yaml": 'title: "Add auth"\nstatus: planning\nphase: design\nowner: "demetre"\n',
    "proposal.md": "# Add auth\nWe need login.",
    "requirements.md": "# Requirements\n- users can log in",
  });
  plans = await import("../src/observability/server/plans");
});

test("listPlans returns derived phase + metadata for the project", () => {
  const list = plans.listPlans(PROJECT);
  expect(list.length).toBe(1);
  expect(list[0].changeId).toBe("add-auth");
  expect(list[0].title).toBe("Add auth");
  expect(list[0].phase).toBe("design"); // proposal+requirements present ⇒ next gate design
  expect(list[0].owner).toBe("demetre");
});

test("planDetail includes gates, artifacts, and empty timelines initially", () => {
  const detail = plans.planDetail(PROJECT, "add-auth")!;
  expect(detail).not.toBeNull();
  expect(detail.gates.find((g) => g.gate === "proposal")?.present).toBe(true);
  expect(detail.gates.find((g) => g.gate === "design")?.present).toBe(false);
  expect(detail.artifacts).toContain("proposal.md");
  expect(detail.verdicts).toEqual([]);
  expect(detail.approvals).toEqual([]);
  expect(detail.comments).toEqual([]);
  expect(plans.planDetail(PROJECT, "nope")).toBeNull();
});

test("planFile reads an artifact and guards against traversal", () => {
  expect(plans.planFile(PROJECT, "add-auth", "proposal.md")?.content).toContain("We need login.");
  expect(plans.planFile(PROJECT, "add-auth", "../../../../etc/passwd")).toBeNull();
  expect(plans.planFile(PROJECT, "../escape", "proposal.md")).toBeNull();
  expect(plans.planDetail(PROJECT, "../escape")).toBeNull();
});

test("addComment and addApproval round-trip and appear in planDetail", () => {
  const c = plans.addComment(PROJECT, "add-auth", { file: "requirements.md", anchor: "users", author: "demetre", body: "add SSO too" });
  expect(c.ok).toBe(true);
  const a = plans.addApproval(PROJECT, "add-auth", { phase: "requirements", actor: "demetre" });
  expect(a.ok).toBe(true);

  const detail = plans.planDetail(PROJECT, "add-auth")!;
  expect(detail.comments.length).toBe(1);
  expect(detail.comments[0].body).toBe("add SSO too");
  expect(detail.comments[0].file).toBe("requirements.md");
  expect(detail.approvals.length).toBe(1);
  expect(detail.approvals[0].phase).toBe("requirements");
  expect(detail.approvals[0].approvedBy).toBe("ui");
});

test("addComment rejects empty body; addApproval rejects a bad phase", () => {
  expect(plans.addComment(PROJECT, "add-auth", { body: "   " }).ok).toBe(false);
  expect(plans.addApproval(PROJECT, "add-auth", { phase: "ship" }).ok).toBe(false);
  expect(plans.addComment(PROJECT, "missing-change", { body: "x" }).ok).toBe(false);
});

test("resolveProjectCwd rejects an unknown cwd and echoes a known one", () => {
  // PROJECT_CWD is captured at server/config.ts import time. When specs share a
  // Bun process it may be the repo root rather than this temp PROJECT, so assert
  // the security-relevant behavior rather than a specific fallback value: an
  // arbitrary path is rejected, and null falls back to a non-null known cwd.
  expect(plans.resolveProjectCwd("/some/other/path")).toBeNull();
  const fallback = plans.resolveProjectCwd(null);
  expect(typeof fallback).toBe("string");
  // Whatever the fallback is, it is itself a known cwd (idempotent).
  expect(plans.resolveProjectCwd(fallback)).toBe(fallback);
});
