import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CONFIG_CATALOG_LIMITS, loadConfigProject, loadSkillCatalog, type ConfiguredProject, type SkillLoadOperations } from "../../src/config/index.ts";

function temp(): string { return mkdtempSync(join(tmpdir(), "pi-hive-w03-skill-")); }
function write(path: string, value: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function project(setup: (root: string) => void): ConfiguredProject {
  const root = temp(); setup(root);
  write(join(root, ".pi/hive/hive-config.yaml"), "schema-version: 1\nagents: {}\nworkflows: {}\nskills:\n  docs: skills/docs/\n");
  const result = loadConfigProject(root); assert.equal(result.status, "configured"); return result as ConfiguredProject;
}

test("skill files load in deterministic code-unit order with canonical hashes and exact private text", () => {
  const first = project((root) => {
    write(join(root, ".pi/hive/skills/docs/z.md"), "z\r\n");
    write(join(root, ".pi/hive/skills/docs/Upper.md"), "upper\n");
    write(join(root, ".pi/hive/skills/docs/a.md"), "a\n");
    write(join(root, ".pi/hive/skills/docs/nested/b.md"), "b\n");
  });
  const node = loadSkillCatalog(first).skills[0];
  assert.equal(node.status, "available");
  if (node.status !== "available") return;
  assert.deepEqual(node.files.map((file) => file.relativePath), ["Upper.md", "a.md", "nested/b.md", "z.md"]);
  assert.equal(node.files[3]?.content, "z\r\n");
  assert.match(node.treeHash, /^[a-f0-9]{64}$/);

  const second = project((root) => {
    write(join(root, ".pi/hive/skills/docs/a.md"), "a\n");
    write(join(root, ".pi/hive/skills/docs/Upper.md"), "upper\n");
    write(join(root, ".pi/hive/skills/docs/nested/b.md"), "b\r\n");
    write(join(root, ".pi/hive/skills/docs/z.md"), "z\n");
  });
  const other = loadSkillCatalog(second).skills[0];
  assert.equal(other.status, "available");
  if (other.status === "available") assert.equal(other.treeHash, node.treeHash);
});

test("skill path hash frames preserve exact CR and LF filename bytes", () => {
  const cr = project((root) => write(join(root, ".pi/hive/skills/docs/a\rb.md"), "same\n"));
  const lf = project((root) => write(join(root, ".pi/hive/skills/docs/a\nb.md"), "same\n"));
  const crNode = loadSkillCatalog(cr).skills[0];
  const lfNode = loadSkillCatalog(lf).skills[0];
  assert.equal(crNode?.status, "available");
  assert.equal(lfNode?.status, "available");
  if (crNode?.status === "available" && lfNode?.status === "available") assert.notEqual(crNode.treeHash, lfNode.treeHash);
});

test("skill loader fails the node for empty, unsupported, reserved, escaping, and repeated targets", () => {
  const cases: Array<[(root: string) => void, string]> = [
    [(root) => mkdirSync(join(root, ".pi/hive/skills/docs"), { recursive: true }), "SKILL_EMPTY"],
    [(root) => write(join(root, ".pi/hive/skills/docs/file.txt"), "bad"), "SKILL_FILE_UNSUPPORTED"],
    [(root) => write(join(root, ".pi/hive/skills/docs/.gitignore"), "*.md"), "SKILL_FILE_UNSUPPORTED"],
    [(root) => { const outside = temp(); write(join(outside, "secret.md"), "secret"); mkdirSync(join(root, ".pi/hive/skills/docs"), { recursive: true }); symlinkSync(join(outside, "secret.md"), join(root, ".pi/hive/skills/docs/link.md")); }, "RESOURCE_PATH_ESCAPE"],
    [(root) => { write(join(root, ".pi/hive/skills/docs/a.md"), "a"); symlinkSync("a.md", join(root, ".pi/hive/skills/docs/b.md")); }, "SKILL_DUPLICATE_TARGET"],
  ];
  for (const [setup, code] of cases) {
    const node = loadSkillCatalog(project(setup)).skills[0];
    assert.equal(node.status, "failed", code);
    assert.equal(node.diagnosticCodes.includes(code as never), true, code);
  }
});

test("skill depth accepts exact N and rejects N+1", () => {
  const exact = project((root) => write(join(root, `.pi/hive/skills/docs/${"d/".repeat(CONFIG_CATALOG_LIMITS.skillDepth)}x.md`), "x"));
  assert.equal(loadSkillCatalog(exact).skills[0]?.status, "available");
  const deep = project((root) => write(join(root, `.pi/hive/skills/docs/${"d/".repeat(CONFIG_CATALOG_LIMITS.skillDepth + 1)}x.md`), "x"));
  assert.equal(loadSkillCatalog(deep).skills[0]?.diagnosticCodes.includes("SKILL_DEPTH_EXCEEDED"), true);
});

test("skill loader rejects excessive per-file bytes before exposing partial content", () => {
  const accepted = project((root) => write(join(root, ".pi/hive/skills/docs/x.md"), "x".repeat(CONFIG_CATALOG_LIMITS.skillFileBytes)));
  assert.equal(loadSkillCatalog(accepted).skills[0]?.status, "available");
  const large = project((root) => write(join(root, ".pi/hive/skills/docs/x.md"), "x".repeat(CONFIG_CATALOG_LIMITS.skillFileBytes + 1)));
  assert.equal(loadSkillCatalog(large).skills[0]?.diagnosticCodes.includes("CATALOG_FILE_TOO_LARGE"), true);
});

function virtualFiles(root: string, names: string[], bytes: number): SkillLoadOperations {
  const directory = join(root, ".pi/hive/skills/docs");
  const fake = (file: boolean): Stats => ({ size: file ? bytes : 0, isFile: () => file, isDirectory: () => !file } as Stats);
  return {
    readdir: (path) => path === directory ? names : [],
    lstat: (path) => fake(path !== directory),
    stat: (path) => fake(path !== directory),
    realpath: (path) => path,
    readFile: () => Buffer.alloc(bytes, 120),
  };
}

test("skill file-count, aggregate-byte, and relative-path limits accept N and reject N+1", () => {
  const configured = project((root) => write(join(root, ".pi/hive/skills/docs/seed.md"), "seed"));
  const root = configured.projectRoot;
  const names = (count: number) => Array.from({ length: count }, (_, i) => `f${String(i).padStart(4, "0")}.md`);
  assert.equal(loadSkillCatalog(configured, virtualFiles(root, names(CONFIG_CATALOG_LIMITS.skillFiles), 0)).skills[0]?.status, "available");
  assert.equal(loadSkillCatalog(configured, virtualFiles(root, names(CONFIG_CATALOG_LIMITS.skillFiles + 1), 0)).skills[0]?.diagnosticCodes.includes("SKILL_FILE_LIMIT_EXCEEDED"), true);

  const chunks = CONFIG_CATALOG_LIMITS.skillAggregateBytes / CONFIG_CATALOG_LIMITS.skillFileBytes;
  assert.equal(loadSkillCatalog(configured, virtualFiles(root, names(chunks), CONFIG_CATALOG_LIMITS.skillFileBytes)).skills[0]?.status, "available");
  let aggregateReads = 0;
  const aggregateOps = virtualFiles(root, names(chunks + 1), CONFIG_CATALOG_LIMITS.skillFileBytes);
  aggregateOps.readFile = () => { aggregateReads++; return Buffer.alloc(CONFIG_CATALOG_LIMITS.skillFileBytes, 120); };
  assert.equal(loadSkillCatalog(configured, aggregateOps).skills[0]?.diagnosticCodes.includes("CATALOG_AGGREGATE_TOO_LARGE"), true);
  assert.equal(aggregateReads, chunks, "predictable aggregate N+1 must fail before the excess read");

  const longNames = names(CONFIG_CATALOG_LIMITS.skillFiles).map((name) => `${name.slice(0, -3)}${"x".repeat(248)}.md`);
  assert.equal(longNames.reduce((sum, name) => sum + Buffer.byteLength(name), 0), CONFIG_CATALOG_LIMITS.skillPathBytes);
  assert.equal(loadSkillCatalog(configured, virtualFiles(root, longNames, 0)).skills[0]?.status, "available");
  const over = [...longNames, `z${"x".repeat(252)}.md`];
  assert.equal(loadSkillCatalog(configured, virtualFiles(root, over, 0)).skills[0]?.diagnosticCodes.includes("SKILL_PATH_BYTES_EXCEEDED"), true);
});

test("skill traversal revalidates identity after reads and distinguishes active cycles from sibling aliases", () => {
  const configured = project((root) => write(join(root, ".pi/hive/skills/docs/a.md"), "a"));
  const file = join(configured.projectRoot, ".pi/hive/skills/docs/a.md");
  const outside = join(temp(), "swapped.md");
  let read = false;
  const swapped = loadSkillCatalog(configured, {
    realpath: (path) => path === file && read ? outside : path,
    readFile: () => { read = true; return Buffer.from("a"); },
  }).skills[0];
  assert.deepEqual(swapped?.diagnosticCodes, ["RESOURCE_PATH_ESCAPE"]);

  const directory = join(configured.projectRoot, ".pi/hive/skills/docs");
  let listed = false;
  const swappedDirectory = loadSkillCatalog(configured, {
    readdir: () => { listed = true; return ["a.md"]; },
    realpath: (path) => path === directory && listed ? outside : path,
  }).skills[0];
  assert.deepEqual(swappedDirectory?.diagnosticCodes, ["RESOURCE_PATH_ESCAPE"]);

  const cycle = project((root) => {
    write(join(root, ".pi/hive/skills/docs/nested/a.md"), "a");
    symlinkSync("..", join(root, ".pi/hive/skills/docs/nested/back"));
  });
  assert.equal(loadSkillCatalog(cycle).skills[0]?.diagnosticCodes.includes("SKILL_CYCLE"), true);

  const aliases = project((root) => {
    write(join(root, ".pi/hive/skills/docs/shared/a.md"), "a");
    symlinkSync("shared", join(root, ".pi/hive/skills/docs/one"));
    symlinkSync("shared", join(root, ".pi/hive/skills/docs/two"));
  });
  const alias = loadSkillCatalog(aliases).skills[0];
  assert.equal(alias?.diagnosticCodes.includes("SKILL_DUPLICATE_TARGET"), true);
  assert.equal(alias?.diagnosticCodes.includes("SKILL_CYCLE"), false);
});

test("skill roots and canonical aliases into reserved Git metadata fail closed", () => {
  const rootAlias = project((root) => {
    write(join(root, ".pi/hive/skills/.git/secret.md"), "secret");
    symlinkSync(".git", join(root, ".pi/hive/skills/docs"));
  });
  assert.deepEqual(loadSkillCatalog(rootAlias).skills[0]?.diagnosticCodes, ["SKILL_FILE_UNSUPPORTED"]);

  const childAlias = project((root) => {
    write(join(root, ".pi/hive/skills/docs/.git/secret.md"), "secret");
    symlinkSync(".git/secret.md", join(root, ".pi/hive/skills/docs/innocent.md"));
  });
  const directory = join(childAlias.projectRoot, ".pi/hive/skills/docs");
  const result = loadSkillCatalog(childAlias, {
    readdir: (path) => path === directory ? ["innocent.md"] : [],
  });
  assert.deepEqual(result.skills[0]?.diagnosticCodes, ["SKILL_FILE_UNSUPPORTED"]);
});
