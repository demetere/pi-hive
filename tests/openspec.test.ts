import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as openspec from "../src/engine/openspec.ts";
import { parseRid, renderReviewInput, ridFromReferer } from "../src/engine/review.ts";
import { resolveHiveSddStatus } from "../src/engine/sdd.ts";
import type { HiveState } from "../src/core/types.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-hive-approval-agent-"));

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pi-hive-osx-"));
}

function changeDir(cwd: string, name = "add-auth"): string {
  const dir = join(cwd, "openspec", "changes", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function clearAndApprove(cwd: string, name: string, artifact: string, actor = "Human Reviewer"): void {
  openspec.setAgentReviewVerdict(cwd, name, artifact, "green", "Plan Reviewer");
  openspec.setArtifactApproval(cwd, name, artifact, "green", actor);
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

test("resolveArtifact rejects symlink escapes", () => {
  const cwd = scratch();
  const outside = scratch();
  mkdirSync(join(cwd, "openspec/changes/add-auth"), { recursive: true });
  writeFileSync(join(outside, "proposal.md"), "secret");
  symlinkSync(join(outside, "proposal.md"), join(cwd, "openspec/changes/add-auth/proposal.md"));
  symlinkSync(outside, join(cwd, "openspec/changes/escaped-change"));

  assert.equal(openspec.resolveArtifact(cwd, "add-auth", "proposal.md"), null);
  assert.equal(openspec.readArtifact(cwd, "add-auth", "proposal.md"), "");
  assert.equal(openspec.resolveArtifact(cwd, "escaped-change", "proposal.md"), null);
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

test("content-bound automated and human records are separate and versioned", () => {
  const cwd = scratch();
  const dir = changeDir(cwd);
  writeFileSync(join(dir, "proposal.md"), "# p\n");

  assert.throws(() => openspec.setArtifactApproval(cwd, "add-auth", "proposal", "green"), /no current eligible automated review/);
  openspec.setAgentReviewVerdict(cwd, "add-auth", "proposal", "green", "Plan Reviewer");
  writeFileSync(join(dir, "proposal.md"), "# changed after review\n");
  assert.throws(() => openspec.setArtifactApproval(cwd, "add-auth", "proposal", "green"), /no current eligible automated review/);
  clearAndApprove(cwd, "add-auth", "proposal");

  const automatedPath = openspec.approvalRecordPath(cwd, "add-auth", "proposal", "automated-review")!;
  const humanPath = openspec.approvalRecordPath(cwd, "add-auth", "proposal", "human")!;
  assert.notEqual(automatedPath, humanPath);
  assert.ok(existsSync(automatedPath));
  assert.ok(existsSync(humanPath));
  const automated = JSON.parse(readFileSync(automatedPath, "utf8"));
  const human = JSON.parse(readFileSync(humanPath, "utf8"));
  assert.equal(automated.schemaVersion, openspec.APPROVAL_SCHEMA_VERSION);
  assert.equal(automated.authority, "automated-review");
  assert.equal(human.authority, "human");
  assert.equal(human.projectId, automated.projectId);
  assert.equal(human.canonicalRoot, cwd);
  assert.equal(human.changeId, "add-auth");
  assert.equal(human.artifactId, "proposal");
  assert.equal(human.actor, "Human Reviewer");
  assert.match(human.artifactHash, /^[a-f0-9]{64}$/);
  assert.match(human.automatedReviewHash, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(human.timestamp)));
});

test("legacy project sidecars never open execution", () => {
  const cwd = scratch();
  const dir = changeDir(cwd);
  writeFileSync(join(dir, ".pi-hive-approval.json"), JSON.stringify({ approved: true, artifacts: { tasks: "green" } }));
  assert.equal(openspec.isApprovedForExecution(cwd, "add-auth"), false);
  assert.equal(openspec.artifactVerdict(cwd, "add-auth", "tasks"), null);
});

test("editing approved bytes invalidates that artifact and downstream approvals", () => {
  const cwd = scratch();
  const dir = changeDir(cwd);
  writeFileSync(join(dir, "proposal.md"), "# p\n");
  writeFileSync(join(dir, "design.md"), "# d\n");
  mkdirSync(join(dir, "specs", "auth"), { recursive: true });
  writeFileSync(join(dir, "specs", "auth", "spec.md"), "# s\n");
  writeFileSync(join(dir, "tasks.md"), "# tasks\n- [ ] one\n");
  for (const artifact of openspec.ARTIFACT_ORDER) clearAndApprove(cwd, "add-auth", artifact);
  assert.equal(openspec.isApprovedForExecution(cwd, "add-auth"), true);

  writeFileSync(join(dir, "tasks.md"), "# tasks revised\n- [ ] one\n");
  assert.equal(openspec.isApprovedForExecution(cwd, "add-auth"), false);
  clearAndApprove(cwd, "add-auth", "tasks");
  assert.equal(openspec.isApprovedForExecution(cwd, "add-auth"), true);

  writeFileSync(join(dir, "proposal.md"), "# changed\n");
  assert.equal(openspec.artifactVerdict(cwd, "add-auth", "proposal"), null);
  assert.equal(openspec.artifactVerdict(cwd, "add-auth", "design"), null);
  assert.equal(openspec.artifactVerdict(cwd, "add-auth", "specs"), null);
  assert.equal(openspec.artifactVerdict(cwd, "add-auth", "tasks"), null);
  assert.equal(openspec.isApprovedForExecution(cwd, "add-auth"), false);
});

test("denying an upstream artifact removes downstream human records", () => {
  const cwd = scratch();
  const dir = changeDir(cwd);
  writeFileSync(join(dir, "proposal.md"), "# p\n");
  writeFileSync(join(dir, "design.md"), "# d\n");
  mkdirSync(join(dir, "specs", "auth"), { recursive: true });
  writeFileSync(join(dir, "specs", "auth", "spec.md"), "# s\n");
  writeFileSync(join(dir, "tasks.md"), "# tasks\n- [ ] one\n");
  for (const artifact of openspec.ARTIFACT_ORDER) clearAndApprove(cwd, "add-auth", artifact);
  openspec.setArtifactApproval(cwd, "add-auth", "proposal", "red", "Human Reviewer");
  assert.equal(openspec.artifactVerdict(cwd, "add-auth", "proposal"), "red");
  for (const artifact of ["design", "specs", "tasks"] as const) {
    assert.equal(openspec.artifactVerdict(cwd, "add-auth", artifact), null);
    assert.equal(existsSync(openspec.approvalRecordPath(cwd, "add-auth", artifact, "human")!), false);
  }
});

test("spec aggregate hash is stable across creation order and changes on membership", () => {
  const cwd = scratch();
  const first = changeDir(cwd, "first");
  const second = changeDir(cwd, "second");
  for (const dir of [first, second]) mkdirSync(join(dir, "specs"), { recursive: true });
  writeFileSync(join(first, "specs", "b.md"), "B\n");
  writeFileSync(join(first, "specs", "a.md"), "A\n");
  writeFileSync(join(second, "specs", "a.md"), "A\n");
  writeFileSync(join(second, "specs", "b.md"), "B\n");
  assert.equal(openspec.artifactHash(cwd, "first", "specs"), openspec.artifactHash(cwd, "second", "specs"));
  const before = openspec.artifactHash(cwd, "first", "specs");
  writeFileSync(join(first, "specs", "c.md"), "C\n");
  assert.notEqual(openspec.artifactHash(cwd, "first", "specs"), before);
});

test("concurrent automated and human writers do not overwrite one another", async () => {
  const cwd = scratch();
  const dir = changeDir(cwd);
  writeFileSync(join(dir, "proposal.md"), "# p\n");
  openspec.setAgentReviewVerdict(cwd, "add-auth", "proposal", "green", "Initial Reviewer");
  const modulePath = join(process.cwd(), "src", "engine", "openspec.ts");
  const loaderPath = join(process.cwd(), "tests", "register-ts-loader.mjs");
  const run = (expression: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", loaderPath, "--input-type=module", "-e", expression], {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code: number | null) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  });
  const imported = JSON.stringify(modulePath);
  const project = JSON.stringify(cwd);
  await Promise.all([
    run(`const o=await import(${imported});o.setAgentReviewVerdict(${project},"add-auth","proposal","green","Concurrent Reviewer")`),
    run(`const o=await import(${imported});o.setArtifactApproval(${project},"add-auth","proposal","green","Concurrent Human")`),
  ]);
  assert.ok(existsSync(openspec.approvalRecordPath(cwd, "add-auth", "proposal", "automated-review")!));
  assert.ok(existsSync(openspec.approvalRecordPath(cwd, "add-auth", "proposal", "human")!));
});

test("approval persistence failures propagate", () => {
  const cwd = scratch();
  const dir = changeDir(cwd);
  writeFileSync(join(dir, "proposal.md"), "# p\n");
  const prior = process.env.PI_CODING_AGENT_DIR;
  const blocked = join(scratch(), "not-a-directory");
  writeFileSync(blocked, "file");
  process.env.PI_CODING_AGENT_DIR = blocked;
  try {
    assert.throws(() => openspec.setAgentReviewVerdict(cwd, "add-auth", "proposal", "green"));
  } finally {
    process.env.PI_CODING_AGENT_DIR = prior;
  }
});

test("isAwaitingHumanApproval halts the pipeline until the human decides", () => {
  const cwd = scratch();
  const dir = changeDir(cwd);
  assert.equal(openspec.isAwaitingHumanApproval(cwd, "add-auth"), null);
  writeFileSync(join(dir, "proposal.md"), "# p\n");
  assert.equal(openspec.isAwaitingHumanApproval(cwd, "add-auth"), "proposal");
  clearAndApprove(cwd, "add-auth", "proposal");
  assert.equal(openspec.isAwaitingHumanApproval(cwd, "add-auth"), null);
  writeFileSync(join(dir, "design.md"), "# d\n");
  assert.equal(openspec.isAwaitingHumanApproval(cwd, "add-auth"), "design");
  openspec.setArtifactApproval(cwd, "add-auth", "design", "red");
  assert.equal(openspec.isAwaitingHumanApproval(cwd, "add-auth"), null);
});

test("agent reviewer red unlocks same-artifact revision without human denial", () => {
  const cwd = scratch();
  const dir = changeDir(cwd);
  writeFileSync(join(dir, "proposal.md"), "# p\n");
  assert.equal(openspec.isAwaitingHumanApproval(cwd, "add-auth"), "proposal");
  openspec.setAgentReviewVerdict(cwd, "add-auth", "proposal.md", "red", "Plan Reviewer");
  assert.equal(openspec.agentReviewVerdict(cwd, "add-auth", "proposal.md"), "red");
  assert.equal(openspec.isAwaitingHumanApproval(cwd, "add-auth"), null);
});

test("canAuthorArtifact enforces current upstream approval", () => {
  const cwd = scratch();
  const dir = changeDir(cwd);
  assert.equal(openspec.canAuthorArtifact(cwd, "add-auth", "proposal"), true);
  assert.equal(openspec.canAuthorArtifact(cwd, "add-auth", "design"), false);
  assert.equal(openspec.nextAuthorableArtifact(cwd, "add-auth"), "proposal");
  writeFileSync(join(dir, "proposal.md"), "# p\n");
  clearAndApprove(cwd, "add-auth", "proposal");
  assert.equal(openspec.canAuthorArtifact(cwd, "add-auth", "design"), true);
  assert.equal(openspec.nextAuthorableArtifact(cwd, "add-auth"), "design");
  writeFileSync(join(dir, "proposal.md"), "# revised\n");
  assert.equal(openspec.canAuthorArtifact(cwd, "add-auth", "design"), false);
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
