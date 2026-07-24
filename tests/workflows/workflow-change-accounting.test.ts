import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChangeAccountingRuntime } from "../../src/workflows/change-accounting.ts";
import { analyzeCommand } from "../../src/capabilities/command.ts";
import { canonicalJson } from "../../src/config/snapshot-canonical.ts";
import { WORKFLOW_EVENT_LIMITS } from "../../src/workflows/events.ts";
import { readWorkflowJournal } from "../../src/workflows/journal.ts";

function fixture(git = false) {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-changes-"));
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: projectRoot });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: projectRoot });
  }
  let tick = 0;
  const runtime = new ChangeAccountingRuntime({
    projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1",
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  });
  return { projectRoot, runtime };
}

function commit(root: string) {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
}

test("clean Git baseline derives create/update/delete/rename and git-reconciled coverage", () => {
  const { projectRoot, runtime } = fixture(true);
  mkdirSync(join(projectRoot, "src"));
  writeFileSync(join(projectRoot, "src/update.ts"), "before\n");
  writeFileSync(join(projectRoot, "src/delete.ts"), "delete\n");
  writeFileSync(join(projectRoot, "src/rename.ts"), "rename\n");
  commit(projectRoot);
  runtime.captureBaseline();

  writeFileSync(join(projectRoot, "src/update.ts"), "after\n");
  rmSync(join(projectRoot, "src/delete.ts"));
  renameSync(join(projectRoot, "src/rename.ts"), join(projectRoot, "src/renamed.ts"));
  writeFileSync(join(projectRoot, "src/new.ts"), "new\n");

  const report = runtime.reconcile();
  assert.equal(report.state, "satisfied");
  assert.equal(report.changeCoverage, "git-reconciled");
  assert.deepEqual(new Set(report.fileChanges.map((change) => change.operation)), new Set(["create", "update", "delete", "rename"]));
  const rename = report.fileChanges.find((change) => change.operation === "rename");
  assert.equal(rename?.previousPath, "src/rename.ts");
  assert.equal(rename?.path, "src/renamed.ts");
});

test("dirty Git baseline preserves pre-existing edits and does not falsely attribute unchanged dirt", () => {
  const { projectRoot, runtime } = fixture(true);
  writeFileSync(join(projectRoot, "dirty.txt"), "clean\n");
  writeFileSync(join(projectRoot, "run.txt"), "clean\n");
  commit(projectRoot);
  writeFileSync(join(projectRoot, "dirty.txt"), "user edit\n");
  runtime.captureBaseline();
  writeFileSync(join(projectRoot, "run.txt"), "workflow edit\n");

  const report = runtime.reconcile();
  assert.equal(report.preExistingChanges.some((change) => change.path === "dirty.txt"), true);
  assert.equal(report.fileChanges.some((change) => change.path === "dirty.txt"), false);
  assert.equal(report.fileChanges.some((change) => change.path === "run.txt"), true);
});

test("direct mutation ledger records before/after hashes and detects a concurrent external overwrite", () => {
  const { projectRoot, runtime } = fixture(false);
  writeFileSync(join(projectRoot, "file.txt"), "before\n");
  runtime.captureBaseline();
  const intent = runtime.beginMutation("attempt-write", "file.txt");
  writeFileSync(join(projectRoot, "file.txt"), "recorded\n");
  runtime.completeMutation(intent, "file.txt");
  let report = runtime.reconcile();
  assert.equal(report.fileChanges[0].attribution, "recorded");
  assert.equal(report.changeCoverage, "recorded");

  writeFileSync(join(projectRoot, "file.txt"), "external-after-record\n");
  report = runtime.reconcile();
  assert.equal(report.state, "unsatisfied");
  assert.equal(report.fileChanges[0].attribution, "conflicted");
  assert.match(report.issues.join(" "), /conflict|external/i);
});

test("contiguous repeated mutation ledgers reconcile the full A to B to C path chain", () => {
  const { projectRoot, runtime } = fixture(false);
  writeFileSync(join(projectRoot, "chain.txt"), "A");
  runtime.captureBaseline();
  const first = runtime.beginMutation("chain-a-b", "chain.txt");
  writeFileSync(join(projectRoot, "chain.txt"), "B");
  runtime.completeMutation(first);
  const second = runtime.beginMutation("chain-b-c", "chain.txt");
  writeFileSync(join(projectRoot, "chain.txt"), "C");
  runtime.completeMutation(second);
  const report = runtime.reconcile();
  assert.equal(report.state, "satisfied");
  assert.equal(report.fileChanges[0].attribution, "recorded");
  assert.equal(report.changeCoverage, "recorded");
});

test("trusted known shell mutation metadata records change attribution against its attempt", () => {
  const { projectRoot, runtime } = fixture(false);
  runtime.captureBaseline();
  const command = runtime.beginCommandAttempt("shell-touch", analyzeCommand("touch created.txt"));
  writeFileSync(join(projectRoot, "created.txt"), "created");
  runtime.completeCommandAttempt(command);
  const report = runtime.reconcile();
  assert.equal(report.fileChanges[0].attribution, "recorded");
  assert.equal(runtime.restore().commandAttempts["shell-touch"].status, "completed");
});

test("known rm -rf directory effects use a bounded tree digest and attribute every deleted file", () => {
  const { projectRoot, runtime } = fixture(false);
  mkdirSync(join(projectRoot, "generated", "nested"), { recursive: true });
  writeFileSync(join(projectRoot, "generated", "one.txt"), "one");
  writeFileSync(join(projectRoot, "generated", "nested", "two.txt"), "two");
  runtime.captureBaseline();
  const command = runtime.beginCommandAttempt("shell-rm-tree", analyzeCommand("rm -rf generated"));
  assert.equal(command.mutations[0].beforeKind, "directory");
  rmSync(join(projectRoot, "generated"), { recursive: true });
  runtime.completeCommandAttempt(command);
  const report = runtime.reconcile();
  assert.equal(report.state, "satisfied");
  assert.deepEqual(report.fileChanges.map((change) => change.path), ["generated/nested/two.txt", "generated/one.txt"]);
  assert.equal(report.fileChanges.every((change) => change.operation === "delete" && change.attribution === "recorded"), true);
});

test("known directory creation and update effects attribute their bounded child trees", () => {
  const created = fixture(false);
  created.runtime.captureBaseline();
  const create = created.runtime.beginCommandAttempt("copy-tree", analyzeCommand("cp source copied"));
  mkdirSync(join(created.projectRoot, "copied", "nested"), { recursive: true });
  writeFileSync(join(created.projectRoot, "copied", "nested", "new.txt"), "new");
  const createdRecord = created.runtime.completeCommandAttempt(create);
  assert.equal(createdRecord.status, "completed");
  assert.equal(created.runtime.restore().mutations[0].afterKind, "directory");
  assert.equal(created.runtime.reconcile().fileChanges[0].attribution, "recorded");

  const updated = fixture(false);
  mkdirSync(join(updated.projectRoot, "tree"));
  writeFileSync(join(updated.projectRoot, "tree", "before.txt"), "before");
  updated.runtime.captureBaseline();
  const update = updated.runtime.beginCommandAttempt("update-tree", analyzeCommand("cp source tree"));
  writeFileSync(join(updated.projectRoot, "tree", "after.txt"), "after");
  updated.runtime.completeCommandAttempt(update);
  const mutation = updated.runtime.restore().mutations[0];
  assert.equal(mutation.beforeKind, "directory");
  assert.equal(mutation.afterKind, "directory");
  assert.equal(updated.runtime.reconcile().fileChanges.find((change) => change.path === "tree/after.txt")?.attribution, "recorded");
});

test("directory effect accounting fails closed when its scoped inventory exceeds bounds", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-changes-tree-bound-"));
  mkdirSync(join(projectRoot, "tree"));
  writeFileSync(join(projectRoot, "tree", "one.txt"), "1");
  writeFileSync(join(projectRoot, "tree", "two.txt"), "2");
  const runtime = new ChangeAccountingRuntime({ projectRoot, projectId: "p", sessionId: "s", runId: "r", limits: { maxFiles: 1 } });
  runtime.captureBaseline();
  assert.throws(() => runtime.beginCommandAttempt("bounded-tree", analyzeCommand("rm -rf tree")), /directory.*incomplete|bound/i);
});

test("trusted command recovery can durably resolve a proven-not-applied effect", () => {
  const { projectRoot, runtime } = fixture(false);
  writeFileSync(join(projectRoot, "kept.txt"), "before");
  runtime.captureBaseline();
  runtime.beginCommandAttempt("shell-rm-crash", analyzeCommand("rm kept.txt"));
  runtime.reconcileCommandAttempt("shell-rm-crash", "not-applied");
  const state = runtime.restore();
  assert.equal(state.commandAttempts["shell-rm-crash"].status, "completed");
  assert.equal(state.notApplied["shell-rm-crash-effect-1"] !== undefined, true);
  assert.equal(runtime.reconcile().state, "satisfied");
});

test("non-Git inventory reports scoped reconciliation and hidden interpreter-style writes as unattributed", () => {
  const { projectRoot, runtime } = fixture(false);
  writeFileSync(join(projectRoot, "base.txt"), "base\n");
  runtime.captureBaseline();
  writeFileSync(join(projectRoot, "hidden.txt"), "written outside mutation API\n");
  const report = runtime.reconcile();
  assert.equal(report.state, "satisfied");
  assert.equal(report.changeCoverage, "scoped-reconciled");
  assert.equal(report.fileChanges[0].path, "hidden.txt");
  assert.equal(report.fileChanges[0].attribution, "unattributed");
});

test("unexplained protected-path drift blocks completion while harness session journal changes are excluded", () => {
  const { projectRoot, runtime } = fixture(false);
  mkdirSync(join(projectRoot, ".pi", "hive"), { recursive: true });
  writeFileSync(join(projectRoot, ".pi", "hive", "hive-config.yaml"), "schema-version: 1\n");
  runtime.captureBaseline();
  writeFileSync(join(projectRoot, ".pi", "hive", "hive-config.yaml"), "schema-version: 2\n");
  mkdirSync(join(projectRoot, ".pi", "hive", "sessions", "session-1"), { recursive: true });
  writeFileSync(join(projectRoot, ".pi", "hive", "sessions", "session-1", "runtime.tmp"), "runtime\n");
  const report = runtime.reconcile();
  assert.equal(report.state, "unsatisfied");
  assert.match(report.issues.join(" "), /protected|authority-config/i);
  assert.equal(report.fileChanges.some((change) => change.path.includes("sessions")), false);
});

test("direct ledgers cover create/delete and reject no-op creates or mismatched completion paths", () => {
  const { projectRoot, runtime } = fixture(false);
  writeFileSync(join(projectRoot, "delete.txt"), "delete");
  runtime.captureBaseline();
  const create = runtime.beginMutation("create", "create.txt");
  writeFileSync(join(projectRoot, "create.txt"), "created");
  assert.equal(runtime.completeMutation(create).operation, "create");
  const deletion = runtime.beginMutation("delete", "delete.txt");
  rmSync(join(projectRoot, "delete.txt"));
  assert.equal(runtime.completeMutation(deletion).operation, "delete");
  const noEffect = runtime.beginMutation("no-effect", "absent.txt");
  assert.throws(() => runtime.completeMutation(noEffect), /no observable/i);
  assert.throws(() => runtime.completeMutation(create, "other.txt"), /differs/i);
  assert.deepEqual(new Set(runtime.reconcile().fileChanges.map((change) => change.operation)), new Set(["create", "delete"]));
});

test("direct mutation accounting refuses symlink targets instead of inventing a file hash", () => {
  const { projectRoot, runtime } = fixture(false);
  writeFileSync(join(projectRoot, "target.txt"), "target");
  symlinkSync("target.txt", join(projectRoot, "link.txt"));
  runtime.captureBaseline();
  assert.throws(() => runtime.beginMutation("symlink-write", "link.txt"), /regular file or directory/i);
});

test("ambiguous same-content moves stay honest delete/create and unsupported symlinks make coverage partial", () => {
  const { projectRoot, runtime } = fixture(false);
  writeFileSync(join(projectRoot, "a.txt"), "same");
  writeFileSync(join(projectRoot, "b.txt"), "same");
  runtime.captureBaseline();
  rmSync(join(projectRoot, "a.txt"));
  rmSync(join(projectRoot, "b.txt"));
  writeFileSync(join(projectRoot, "c.txt"), "same");
  assert.deepEqual(new Set(runtime.reconcile().fileChanges.map((change) => change.operation)), new Set(["create", "delete"]));

  const second = fixture(false);
  writeFileSync(join(second.projectRoot, "target.txt"), "target");
  symlinkSync("target.txt", join(second.projectRoot, "link.txt"));
  const baseline = second.runtime.captureBaseline();
  assert.equal(baseline.partial, true);
  assert.match(baseline.diagnostics.join(" "), /unsupported/i);
  assert.equal(second.runtime.captureBaseline().recordedSequence, baseline.recordedSequence, "baseline capture is replay-idempotent");
});

test("missing inventory scopes declare partial diagnostics", () => {
  const { projectRoot } = fixture(false);
  const runtime = new ChangeAccountingRuntime({ projectRoot, projectId: "p", sessionId: "missing-scope", runId: "run", scopes: ["missing"] });
  const baseline = runtime.captureBaseline();
  assert.equal(baseline.partial, true);
  assert.match(baseline.diagnostics.join(" "), /unavailable/i);
});

test("bounded inventories declare partial coverage instead of claiming completeness", () => {
  const { projectRoot } = fixture(false);
  writeFileSync(join(projectRoot, "one.txt"), "1");
  writeFileSync(join(projectRoot, "two.txt"), "2");
  const runtime = new ChangeAccountingRuntime({ projectRoot, projectId: "project-1", sessionId: "session-2", runId: "run-2", limits: { maxFiles: 1 } });
  runtime.captureBaseline();
  writeFileSync(join(projectRoot, "three.txt"), "3");
  const report = runtime.reconcile();
  assert.equal(report.changeCoverage, "partial");
  assert.equal(report.partial, true);
});

test("large Git baselines fit one bounded event and preserve dirty-path evidence first", () => {
  const { projectRoot, runtime } = fixture(true);
  mkdirSync(join(projectRoot, "bulk"));
  for (let index = 0; index < 1_300; index++) writeFileSync(join(projectRoot, "bulk", `${String(index).padStart(4, "0")}-${"x".repeat(80)}.txt`), `${index}\n`);
  writeFileSync(join(projectRoot, "zz-dirty.txt"), "clean\n");
  commit(projectRoot);
  writeFileSync(join(projectRoot, "zz-dirty.txt"), "pre-existing edit\n");

  const baseline = runtime.captureBaseline();
  assert.equal(baseline.partial, true);
  assert.match(baseline.diagnostics.join(" "), /payload bound/i);
  assert.match(baseline.dirty.find((change) => change.path === "zz-dirty.txt")?.baselineHash ?? "", /^sha256:/u);
  const event = readWorkflowJournal(projectRoot, "session-1").find((candidate) => candidate.type === "change.baseline.recorded");
  assert.ok(event);
  assert.ok(Buffer.byteLength(canonicalJson(event.payload), "utf8") <= WORKFLOW_EVENT_LIMITS.payloadBytes);
});

test("Git index-only protected drift is detected even when the worktree hash returns to baseline", () => {
  const { projectRoot, runtime } = fixture(true);
  mkdirSync(join(projectRoot, ".pi", "hive"), { recursive: true });
  const config = join(projectRoot, ".pi", "hive", "hive-config.yaml");
  writeFileSync(config, "schema-version: 1\n");
  commit(projectRoot);
  runtime.captureBaseline();

  writeFileSync(config, "schema-version: 2\n");
  execFileSync("git", ["add", ".pi/hive/hive-config.yaml"], { cwd: projectRoot });
  writeFileSync(config, "schema-version: 1\n");

  const report = runtime.reconcile();
  assert.equal(report.state, "unsatisfied");
  assert.match(report.issues.join(" "), /protected.*(?:index|staged)|(?:index|staged).*protected/i);
  assert.equal(report.fileChanges.length, 0, "unchanged worktree content must not be fabricated as a file delta");
});

test("protected index blob drift is detected when porcelain XY status is unchanged", () => {
  const { projectRoot, runtime } = fixture(true);
  mkdirSync(join(projectRoot, ".pi", "hive"), { recursive: true });
  const config = join(projectRoot, ".pi", "hive", "hive-config.yaml");
  writeFileSync(config, "schema-version: 1\n");
  commit(projectRoot);
  writeFileSync(config, "schema-version: 2\n");
  execFileSync("git", ["add", ".pi/hive/hive-config.yaml"], { cwd: projectRoot });
  runtime.captureBaseline();

  writeFileSync(config, "schema-version: 3\n");
  execFileSync("git", ["add", ".pi/hive/hive-config.yaml"], { cwd: projectRoot });
  const report = runtime.reconcile();
  assert.deepEqual((report.partialState!.git as { statusChangedPaths: string[] }).statusChangedPaths, []);
  assert.equal(report.state, "unsatisfied");
  assert.match(report.issues.join(" "), /protected.*(?:index|blob|staged)|(?:index|blob|staged).*protected/i);
});

test("Git HEAD changes and status-backed paths are reconciled while ignored inventory-only paths stay unattributed", () => {
  const { projectRoot, runtime } = fixture(true);
  writeFileSync(join(projectRoot, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(projectRoot, "tracked.txt"), "before\n");
  commit(projectRoot);
  runtime.captureBaseline();

  writeFileSync(join(projectRoot, "tracked.txt"), "after\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: projectRoot });
  execFileSync("git", ["commit", "-qm", "workflow commit"], { cwd: projectRoot });
  writeFileSync(join(projectRoot, "ignored.txt"), "hidden from Git status\n");

  const report = runtime.reconcile();
  assert.equal(report.fileChanges.find((change) => change.path === "tracked.txt")?.attribution, "git-reconciled");
  assert.equal(report.fileChanges.find((change) => change.path === "ignored.txt")?.attribution, "unattributed");
  assert.equal(report.changeCoverage, "scoped-reconciled", "mixed Git and inventory evidence must not overstate Git coverage");
  assert.match(JSON.stringify(report.partialState), /head/i);
});
