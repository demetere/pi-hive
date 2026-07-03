import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as openspec from "../src/engine/openspec.ts";
import { parseRid, ridFromReferer } from "../src/engine/review.ts";
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

test("hasTasks detects checkbox items only", () => {
  const cwd = scratch();
  const dir = join(cwd, "openspec", "changes", "add-auth");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tasks.md"), "# Tasks\n\nno checkboxes here\n");
  assert.equal(openspec.hasTasks(cwd, "add-auth"), false);
  writeFileSync(join(dir, "tasks.md"), "# Tasks\n\n- [ ] one\n- [x] two\n");
  assert.equal(openspec.hasTasks(cwd, "add-auth"), true);
});

test("execution approval sidecar round-trips and gates execution", () => {
  const cwd = scratch();
  const dir = join(cwd, "openspec", "changes", "add-auth");
  mkdirSync(dir, { recursive: true });
  assert.equal(openspec.isApprovedForExecution(cwd, "add-auth"), false);
  openspec.setExecutionApproval(cwd, "add-auth", true);
  assert.equal(openspec.isApprovedForExecution(cwd, "add-auth"), true);
  openspec.setExecutionApproval(cwd, "add-auth", false);
  assert.equal(openspec.isApprovedForExecution(cwd, "add-auth"), false);
});

// --- review rid parsing ---

test("parseRid splits change#artifact and defaults artifact", () => {
  assert.deepEqual(parseRid("add-auth#tasks.md"), { change: "add-auth", artifact: "tasks.md" });
  assert.deepEqual(parseRid("add-auth"), { change: "add-auth", artifact: "proposal.md" });
  assert.equal(parseRid("../evil#x"), null);
  assert.equal(parseRid(""), null);
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
