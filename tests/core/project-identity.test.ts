import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { projectIdFromCanonicalRoot, resolveProjectIdentity } from "../../src/shared/project-identity";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-hive-project-id-"));
}

test("duplicate basenames remain distinct projects", () => {
  const root = tempRoot();
  const first = join(root, "one", "service");
  const second = join(root, "two", "service");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });

  const a = resolveProjectIdentity(first, { gitRoot: () => undefined });
  const b = resolveProjectIdentity(second, { gitRoot: () => undefined });
  assert.equal(a.displayLabel, "service");
  assert.equal(b.displayLabel, "service");
  assert.notEqual(a.projectId, b.projectId);
});

test("generic root names keep a useful display label without becoming identity", () => {
  const root = tempRoot();
  const app = join(root, "customer", "app");
  mkdirSync(app, { recursive: true });
  const identity = resolveProjectIdentity(app, { gitRoot: () => undefined });
  assert.equal(identity.displayLabel, "customer / app");
  assert.equal(identity.canonicalRoot, realpathSync.native(app));
});

test("Git subdirectories resolve to one canonical repository root", () => {
  const root = tempRoot();
  const repo = join(root, "repo");
  const nested = join(repo, "packages", "api");
  mkdirSync(nested, { recursive: true });
  const fromRoot = resolveProjectIdentity(repo, { gitRoot: () => repo });
  const fromNested = resolveProjectIdentity(nested, { gitRoot: () => repo });
  assert.equal(fromNested.canonicalRoot, fromRoot.canonicalRoot);
  assert.equal(fromNested.projectId, fromRoot.projectId);
});

test("Git worktrees receive distinct canonical project identities", (t) => {
  const root = tempRoot();
  const repo = join(root, "repo");
  const worktree = join(root, "repo-worktree");
  mkdirSync(repo);
  const run = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (run("init", "-q").status !== 0) return t.skip("git unavailable");
  run("config", "user.email", "test@example.invalid");
  run("config", "user.name", "pi-hive test");
  assert.equal(run("commit", "--allow-empty", "-qm", "initial").status, 0);
  assert.equal(run("worktree", "add", "-qb", "secondary", worktree).status, 0);

  const primary = resolveProjectIdentity(repo);
  const secondary = resolveProjectIdentity(worktree);
  assert.notEqual(primary.canonicalRoot, secondary.canonicalRoot);
  assert.notEqual(primary.projectId, secondary.projectId);
});

test("realpath canonicalization makes a symlink alias stable", () => {
  const root = tempRoot();
  const project = join(root, "project");
  const alias = join(root, "alias");
  mkdirSync(project);
  symlinkSync(project, alias, "dir");
  const direct = resolveProjectIdentity(project, { gitRoot: () => undefined });
  const linked = resolveProjectIdentity(alias, { gitRoot: () => undefined });
  assert.equal(linked.canonicalRoot, direct.canonicalRoot);
  assert.equal(linked.projectId, direct.projectId);
});

test("Windows identity keys normalize separators and case", () => {
  const upper = projectIdFromCanonicalRoot("C:\\Work\\App", "win32");
  const lower = projectIdFromCanonicalRoot("c:/work/app", "win32");
  assert.equal(upper, lower);

  const identity = resolveProjectIdentity("C:\\Work\\frontend", {
    platform: "win32",
    realpath: (value) => value,
    gitRoot: () => undefined,
  });
  assert.equal(identity.displayLabel, "Work / frontend");
});
