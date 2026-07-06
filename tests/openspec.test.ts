import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as openspec from "../src/engine/openspec.ts";
import { parseRid, renderReviewInput, ridFromReferer } from "../src/engine/review.ts";
import { resolveHiveSddStatus } from "../src/engine/sdd.ts";
import type { HiveState } from "../src/core/types.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pi-hive-osx-"));
}

function emptyState(): HiveState {
  return {
    pi: {} as any, config: null, session: null, runtimes: new Map(),
    widgetCtx: null, activeRuns: 0, mode: "normal", normalToolNames: [],
    sddStatus: null, obsSeq: 0,
  };
}

// --- pure helpers (no CLI needed) ---

test("isSafeChangeId enforces kebab-case", () => {
  assert.ok(openspec.isSafeChangeId("add-auth"));
  assert.ok(openspec.isSafeChangeId("a1-b2-c3"));
  assert.ok(!openspec.isSafeChangeId("../evil"));
  assert.ok(!openspec.isSafeChangeId("Add_Auth"));
  assert.ok(!openspec.isSafeChangeId(""));
});

test("toChangeId normalizes to kebab", () => {
  assert.equal(openspec.toChangeId("Add Auth!"), "add-auth");
  assert.equal(openspec.toChangeId("  Multi   Word  "), "multi-word");
});

test("resolveArtifact blocks traversal outside the change dir", () => {
  const cwd = scratch();
  assert.equal(openspec.resolveArtifact(cwd, "add-auth", "../../etc/passwd"), null);
  assert.equal(openspec.resolveArtifact(cwd, "../evil", "proposal.md"), null);
  const ok = openspec.resolveArtifact(cwd, "add-auth", "proposal.md");
  assert.ok(ok && ok.endsWith("/openspec/changes/add-auth/proposal.md"));
});

test("hasTasks detects checklist and sprint-plan tasks", () => {
  const cwd = scratch();
  const dir = join(cwd, "openspec", "changes", "add-auth");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tasks.md"), "# Tasks\n\nno checkboxes or sprint sections here\n");
  assert.equal(openspec.hasTasks(cwd, "add-auth"), false);
  writeFileSync(join(dir, "tasks.md"), "# Tasks\n\n- [ ] one\n- [x] two\n");
  assert.equal(openspec.hasTasks(cwd, "add-auth"), true);
  writeFileSync(join(dir, "tasks.md"), "# Tasks: add-auth\n\n## 1. Sprint 1 — Foundation\n\n**Acceptance criteria:**\n\n- Foundation is reviewer-testable.\n");
  assert.equal(openspec.hasTasks(cwd, "add-auth"), true);
});

test("specs glob expands to concrete spec markdown for review", () => {
  const cwd = scratch();
  const dir = join(cwd, "openspec", "changes", "add-auth");
  mkdirSync(join(dir, "specs", "auth"), { recursive: true });
  writeFileSync(join(dir, "proposal.md"), "# Proposal\n");
  writeFileSync(join(dir, "specs", "auth", "spec.md"), "# Auth spec\n\n## ADDED Requirements\n");
  assert.deepEqual(openspec.listArtifacts(cwd, "add-auth"), ["proposal.md", "specs/auth/spec.md"]);
  const bundled = openspec.readArtifact(cwd, "add-auth", "specs/**/*.md");
  assert.match(bundled, /## specs\/auth\/spec\.md/);
  assert.match(bundled, /ADDED Requirements/);
  assert.equal(openspec.readArtifact(cwd, "add-auth", "specs/*.md"), bundled);
  assert.match(openspec.readArtifact(cwd, "add-auth", "specs/auth"), /ADDED Requirements/);
});

test("per-artifact approval ledger round-trips and gates execution", () => {
  const cwd = scratch();
  const dir = join(cwd, "openspec", "changes", "add-auth");
  mkdirSync(dir, { recursive: true });
  assert.equal(openspec.isApprovedForExecution(cwd, "add-auth"), false);
  openspec.setArtifactApproval(cwd, "add-auth", "tasks.md", "green");
  assert.equal(openspec.isArtifactApproved(cwd, "add-auth", "tasks"), true);
  assert.equal(openspec.isApprovedForExecution(cwd, "add-auth"), true);
  openspec.setArtifactApproval(cwd, "add-auth", "tasks", "red");
  assert.equal(openspec.isApprovedForExecution(cwd, "add-auth"), false);
});

test("legacy flat sidecar {approved:true} maps to tasks green", () => {
  const cwd = scratch();
  const dir = join(cwd, "openspec", "changes", "add-auth");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".pi-hive-approval.json"), JSON.stringify({ approved: true }));
  assert.equal(openspec.isApprovedForExecution(cwd, "add-auth"), true);
});

test("denying an upstream artifact invalidates everything downstream", () => {
  const cwd = scratch();
  const dir = join(cwd, "openspec", "changes", "add-auth");
  mkdirSync(dir, { recursive: true });
  // Approve the whole chain.
  for (const a of ["proposal", "design", "specs", "tasks"]) openspec.setArtifactApproval(cwd, "add-auth", a, "green");
  assert.equal(openspec.isApprovedForExecution(cwd, "add-auth"), true);
  // Deny design — only tasks depends on design (specs is a sibling), so tasks is
  // revoked but specs and proposal are untouched.
  openspec.setArtifactApproval(cwd, "add-auth", "design", "red");
  assert.equal(openspec.artifactVerdict(cwd, "add-auth", "design"), "red");
  assert.equal(openspec.artifactVerdict(cwd, "add-auth", "tasks"), null);
  assert.equal(openspec.artifactVerdict(cwd, "add-auth", "specs"), "green"); // sibling, untouched
  assert.equal(openspec.artifactVerdict(cwd, "add-auth", "proposal"), "green"); // upstream, untouched
  assert.equal(openspec.isApprovedForExecution(cwd, "add-auth"), false);

  // Deny proposal — everything downstream (design, specs, tasks) is revoked.
  for (const a of ["proposal", "design", "specs", "tasks"]) openspec.setArtifactApproval(cwd, "add-auth", a, "green");
  openspec.setArtifactApproval(cwd, "add-auth", "proposal", "red");
  assert.equal(openspec.artifactVerdict(cwd, "add-auth", "design"), null);
  assert.equal(openspec.artifactVerdict(cwd, "add-auth", "specs"), null);
  assert.equal(openspec.artifactVerdict(cwd, "add-auth", "tasks"), null);
});

test("isAwaitingHumanApproval halts the pipeline until the human decides", () => {
  const cwd = scratch();
  const dir = join(cwd, "openspec", "changes", "add-auth");
  mkdirSync(dir, { recursive: true });
  // Nothing authored yet → nothing pending.
  assert.equal(openspec.isAwaitingHumanApproval(cwd, "add-auth"), null);
  // Author proposal, no human verdict yet → pipeline awaits approval of proposal.
  writeFileSync(join(dir, "proposal.md"), "# p\n");
  assert.equal(openspec.isAwaitingHumanApproval(cwd, "add-auth"), "proposal");
  // Human approves proposal → no longer awaiting.
  openspec.setArtifactApproval(cwd, "add-auth", "proposal", "green");
  assert.equal(openspec.isAwaitingHumanApproval(cwd, "add-auth"), null);
  // Author design, then human DENIES it → a denied artifact does NOT block
  // (revising it is the intended next planner action).
  writeFileSync(join(dir, "design.md"), "# d\n");
  assert.equal(openspec.isAwaitingHumanApproval(cwd, "add-auth"), "design");
  openspec.setArtifactApproval(cwd, "add-auth", "design", "red");
  assert.equal(openspec.isAwaitingHumanApproval(cwd, "add-auth"), null);
});

test("agent reviewer red unlocks same-artifact revision without human denial", () => {
  const cwd = scratch();
  const dir = join(cwd, "openspec", "changes", "add-auth");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proposal.md"), "# p\n");
  assert.equal(openspec.isAwaitingHumanApproval(cwd, "add-auth"), "proposal");
  openspec.setAgentReviewVerdict(cwd, "add-auth", "proposal.md", "red", "Plan Reviewer");
  assert.equal(openspec.agentReviewVerdict(cwd, "add-auth", "proposal.md"), "red");
  assert.equal(openspec.isAwaitingHumanApproval(cwd, "add-auth"), null);
});

test("canAuthorArtifact enforces upstream approval; nextAuthorable walks the pipeline", () => {
  const cwd = scratch();
  const dir = join(cwd, "openspec", "changes", "add-auth");
  mkdirSync(dir, { recursive: true });
  // Nothing approved: only proposal (no upstream deps) is authorable.
  assert.equal(openspec.canAuthorArtifact(cwd, "add-auth", "proposal"), true);
  assert.equal(openspec.canAuthorArtifact(cwd, "add-auth", "design"), false);
  assert.equal(openspec.nextAuthorableArtifact(cwd, "add-auth"), "proposal");
  // Author + approve proposal → design and specs become authorable.
  writeFileSync(join(dir, "proposal.md"), "# p\n");
  openspec.setArtifactApproval(cwd, "add-auth", "proposal", "green");
  assert.equal(openspec.canAuthorArtifact(cwd, "add-auth", "design"), true);
  assert.equal(openspec.nextAuthorableArtifact(cwd, "add-auth"), "design");
});

// --- review rid parsing ---

test("parseRid splits change#artifact and defaults artifact", () => {
  assert.deepEqual(parseRid("add-auth#tasks.md"), { change: "add-auth", artifact: "tasks.md" });
  assert.deepEqual(parseRid("add-auth"), { change: "add-auth", artifact: "proposal.md" });
  assert.equal(parseRid("../evil#x"), null);
  assert.equal(parseRid(""), null);
});

test("renderReviewInput threads inline annotations into anchored feedback", () => {
  const out = renderReviewInput({
    feedback: "Overall: tighten the scope.",
    annotations: [
      { type: "comment", quote: "session cookies", comment: "specify SameSite" },
      { type: "comment", quote: "", comment: "add a rollback plan" },
      { type: "looks_good", quote: "", comment: "" }, // empty → skipped
    ],
  });
  assert.match(out, /Overall: tighten the scope\./);
  assert.match(out, /on "session cookies": specify SameSite/);
  assert.match(out, /- add a rollback plan/);
  // The empty annotation contributes nothing.
  assert.equal(out.split("\n").length, 3);
});

test("ridFromReferer extracts rid only for the review mount", () => {
  assert.equal(ridFromReferer("http://127.0.0.1:43191/pl-review/?rid=add-auth%23tasks.md", "/pl-review/"), "add-auth#tasks.md");
  assert.equal(ridFromReferer("http://127.0.0.1:43191/other/?rid=x", "/pl-review/"), null);
  assert.equal(ridFromReferer(null, "/pl-review/"), null);
});

// --- sdd adapter graceful degradation ---

test("resolveHiveSddStatus degrades when OpenSpec is not initialized", () => {
  const cwd = scratch(); // no openspec/ tree
  const status = resolveHiveSddStatus(emptyState(), cwd);
  assert.equal(status.configured, false);
  assert.deepEqual(status.activeChanges, []);
  assert.ok(Array.isArray(status.suggestedRouting));
});

// --- CLI-backed (skipped when the openspec binary is absent) ---

test("listChanges + changeDetail + validate against a real scaffolded change", { skip: openspec.isAvailable() ? false : "openspec CLI not installed" }, () => {
  const cwd = scratch();
  assert.ok(openspec.ensureInit(cwd), "ensureInit should initialize");
  assert.equal(openspec.listChanges(cwd).length, 0);
  const created = openspec.newChange(cwd, "Add Auth");
  assert.ok(created && created.changeId === "add-auth");
  const changes = openspec.listChanges(cwd);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].name, "add-auth");

  const detail = openspec.changeDetail(cwd, "add-auth");
  assert.ok(detail, "changeDetail should resolve");
  // A freshly scaffolded change has proposal ready as the next node.
  assert.equal(detail!.nextReady, "proposal");

  // No deltas yet -> validation fails -> not ready to execute.
  assert.equal(openspec.isReadyToExecute(cwd, "add-auth"), false);
});
