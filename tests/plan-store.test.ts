import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { approveGate, changeExists, createChange, hasTasks, isReadyToExecute, isSafeChangeId, listArtifacts, listChangeIds, readPlanMeta, resolveArtifact, toChangeId } from "../src/engine/plan-store.ts";
import { resolveHiveSddStatus } from "../src/engine/sdd.ts";
import { currentChangeId, runWithChange } from "../src/engine/session.ts";
import type { HiveState } from "../src/core/types.ts";

function emptyState(): HiveState {
  return {
    pi: {} as any, config: null, session: null, runtimes: new Map(),
    widgetCtx: null, activeRuns: 0, mode: "hive", normalToolNames: [],
    streamStartMs: 0, streamedChars: 0, lastTokPerSec: 0, sddStatus: null, obsSeq: 0,
  };
}

function project(): string {
  return mkdtempSync(join(tmpdir(), "pi-hive-plans-"));
}

function writePlan(cwd: string, id: string, files: Record<string, string>) {
  const dir = join(cwd, ".pi", "hive", "plans", id);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

// ── plan-store ─────────────────────────────────────────────────────────────

test("toChangeId slugs titles", () => {
  assert.equal(toChangeId("Add Auth Flow"), "add-auth-flow");
  assert.equal(toChangeId("Fix: retries!"), "fix-retries");
});

test("createChange scaffolds plan.yaml and is idempotent", async () => {
  const cwd = project();
  const first = await createChange(cwd, "Add Auth", "demetre");
  assert.equal(first.changeId, "add-auth");
  assert.equal(first.created, true);
  assert.ok(changeExists(cwd, "add-auth"));
  const meta = readPlanMeta(cwd, "add-auth");
  assert.equal(meta.title, "Add Auth");
  assert.equal(meta.owner, "demetre");
  assert.equal(meta.phase, "proposal");

  const second = await createChange(cwd, "Add Auth");
  assert.equal(second.created, false); // did not overwrite
});

test("listChangeIds and hasTasks reflect the store", () => {
  const cwd = project();
  writePlan(cwd, "beta", { "proposal.md": "# Beta" });
  writePlan(cwd, "alpha", { "proposal.md": "# Alpha", "tasks.md": "- [ ] do it" });
  assert.deepEqual(listChangeIds(cwd), ["alpha", "beta"]); // sorted
  assert.equal(hasTasks(cwd, "alpha"), true);
  assert.equal(hasTasks(cwd, "beta"), false);
  assert.deepEqual(listArtifacts(cwd, "alpha"), ["proposal.md", "tasks.md"]);
});

test("approveGate advances gates in order and marks tasks ready", async () => {
  const cwd = project();
  await createChange(cwd, "Add Auth");
  await assert.rejects(() => approveGate(cwd, "missing", "proposal"), /No change/);
  await assert.rejects(() => approveGate(cwd, "add-auth", "tasks"), /waiting for "proposal"/);

  assert.equal((await approveGate(cwd, "add-auth", "proposal")).phase, "requirements");
  assert.equal((await approveGate(cwd, "add-auth", "requirements")).phase, "design");
  assert.equal((await approveGate(cwd, "add-auth", "design")).phase, "tasks");
  const ready = await approveGate(cwd, "add-auth", "tasks");
  assert.equal(ready.status, "ready");
  assert.equal(ready.phase, "apply");
  assert.equal(isReadyToExecute(cwd, "add-auth"), true);
});

test("resolveArtifact guards against path traversal", () => {
  const cwd = project();
  writePlan(cwd, "x", { "design.md": "# D" });
  assert.ok(resolveArtifact(cwd, "x", "design.md")?.endsWith("/x/design.md"));
  assert.equal(resolveArtifact(cwd, "x", "../../../etc/passwd"), null);
  assert.equal(resolveArtifact(cwd, "x", "/etc/passwd"), null);
});

test("change IDs must be safe kebab-case path segments", async () => {
  const cwd = project();
  writePlan(cwd, "safe-id", { "proposal.md": "# Safe" });
  writePlan(cwd, "..", { "proposal.md": "# Unsafe" });

  assert.equal(isSafeChangeId("safe-id-1"), true);
  assert.equal(isSafeChangeId("../escape"), false);
  assert.equal(isSafeChangeId(""), false);
  assert.deepEqual(listChangeIds(cwd), ["safe-id"]);
  assert.equal(changeExists(cwd, "../escape"), false);
  assert.equal(readPlanMeta(cwd, "../escape").phase, undefined);
  assert.equal(resolveArtifact(cwd, "../escape", "proposal.md"), null);
  await assert.rejects(() => createChange(cwd, "!!!"), /Invalid change-id/);
  await assert.rejects(() => approveGate(cwd, "../escape", "proposal"), /Invalid change-id/);
});

// ── sdd phase derivation over the new layout ────────────────────────────────

test("resolveHiveSddStatus derives phases from .pi/hive/plans and counts requirements", () => {
  const cwd = project();
  writePlan(cwd, "add-auth", { "proposal.md": "# Add auth\nWhy we need it.", "requirements.md": "# Reqs" });
  const status = resolveHiveSddStatus(emptyState(), cwd);
  assert.equal(status.configured, true);
  const change = status.activeChanges.find((c) => c.name === "add-auth");
  assert.ok(change);
  // proposal + requirements present ⇒ next gate is design.
  assert.equal(change?.nextPhase, "design");
  assert.ok(change?.files.includes("proposal"));
  assert.ok(change?.files.includes("requirements"));
  assert.equal(change?.summary, "Why we need it.");
});

test("resolveHiveSddStatus marks a fully-gated change ready", () => {
  const cwd = project();
  writePlan(cwd, "done", {
    "proposal.md": "# p", "requirements.md": "# r", "design.md": "# d", "tasks.md": "# t",
    "apply-progress.md": "# a", "verify-report.md": "# v",
  });
  const status = resolveHiveSddStatus(emptyState(), cwd);
  assert.equal(status.activeChanges[0]?.nextPhase, "ready");
});

test("resolveHiveSddStatus reports not-configured with no plan store", () => {
  const cwd = project(); // no .pi/hive/plans
  const status = resolveHiveSddStatus(emptyState(), cwd);
  assert.equal(status.configured, false);
  assert.equal(status.activeChanges.length, 0);
});

// ── change-id AsyncLocalStorage plumbing ────────────────────────────────────

test("currentChangeId reflects the runWithChange scope and defaults undefined", () => {
  assert.equal(currentChangeId(), undefined);
  const seen = runWithChange("add-auth", () => currentChangeId());
  assert.equal(seen, "add-auth");
  // Nesting: an inner scope overrides; the outer value is restored after.
  const nested = runWithChange("outer", () => runWithChange("inner", () => currentChangeId()));
  assert.equal(nested, "inner");
  assert.equal(currentChangeId(), undefined); // scope ended
});

test("currentChangeId propagates across async boundaries within the scope", async () => {
  const result = await runWithChange("c1", async () => {
    await Promise.resolve();
    return currentChangeId();
  });
  assert.equal(result, "c1");
});
