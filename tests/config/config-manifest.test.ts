import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  CONFIG_LIMITS,
  CONFIG_REGISTRY_LIMITS,
  buildManifestRegistries,
  loadConfigProject,
  resolveRegistryTarget,
  validateDeclaredResourcePath,
  type RawManifestV1,
} from "../../src/config/index.ts";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "pi-hive-w02-"));
}

function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function manifest(root: string, body = "schema-version: 1\nagents: {}\nworkflows: {}\n"): string {
  const path = join(root, ".pi/hive/hive-config.yaml");
  write(path, body);
  return path;
}

function validManifest(extra = ""): string {
  return `schema-version: 1\nagents:\n  worker: agents/worker.md\nworkflows:\n  build: workflows/build.yaml\n${extra}`;
}

test("unconfigured discovery has no side effects and nearest physical configured ancestor wins", () => {
  const root = temp();
  const nested = join(root, "packages/app/src");
  mkdirSync(nested, { recursive: true });
  const before = readFileSync("package.json", "utf8");
  assert.deepEqual(loadConfigProject(nested), { status: "unconfigured" });
  assert.equal(readFileSync("package.json", "utf8"), before);

  manifest(root);
  const child = join(root, "packages/app");
  manifest(child);
  const result = loadConfigProject(nested);
  assert.equal(result.status, "configured");
  if (result.status === "configured") assert.equal(result.projectRoot, realpathSync.native(child));

  const link = join(temp(), "linked");
  symlinkSync(child, link, "dir");
  const linked = loadConfigProject(join(link, "src"));
  assert.equal(linked.status, "configured");
  if (linked.status === "configured") assert.equal(linked.projectRoot, realpathSync.native(child));
});

test("an invalid nearest marker blocks fallback to a valid parent", () => {
  const root = temp();
  manifest(root);
  const child = join(root, "child");
  manifest(child, "schema-version: 2\nagents: {}\nworkflows: {}\n");
  const result = loadConfigProject(child);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") {
    assert.equal(result.projectRoot, realpathSync.native(child));
    assert.equal(result.diagnostics[0]?.code, "SCHEMA_VERSION_UNSUPPORTED");
    assert.equal(result.diagnostics[0]?.source, ".pi/hive/hive-config.yaml");
  }
});

test("manifest symlinks are allowed only when the target remains in the configured root", () => {
  const root = temp();
  const config = join(root, ".pi/hive");
  mkdirSync(config, { recursive: true });
  write(join(config, "manifest-real.yaml"), "schema-version: 1\nagents: {}\nworkflows: {}\n");
  symlinkSync("manifest-real.yaml", join(config, "hive-config.yaml"));
  assert.equal(loadConfigProject(root).status, "configured");

  const relocated = temp();
  write(join(relocated, ".pi/hive/agents/worker.md"), "worker");
  write(join(relocated, "manifest-real.yaml"), "schema-version: 1\nagents:\n  worker: agents/worker.md\nworkflows: {}\n");
  symlinkSync("../../manifest-real.yaml", join(relocated, ".pi/hive/hive-config.yaml"));
  const relocatedResult = loadConfigProject(relocated);
  assert.equal(relocatedResult.status, "configured");
  if (relocatedResult.status === "configured") assert.equal(relocatedResult.registries.agents[0]?.status, "available");

  const outside = temp();
  write(join(outside, "manifest.yaml"), "schema-version: 1\nagents: {}\nworkflows: {}\n");
  const escaped = temp();
  mkdirSync(join(escaped, ".pi/hive"), { recursive: true });
  symlinkSync(join(outside, "manifest.yaml"), join(escaped, ".pi/hive/hive-config.yaml"));
  const result = loadConfigProject(escaped);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.diagnostics[0]?.code, "MANIFEST_PATH_ESCAPE");
});

test("portable declared path grammar accepts design directory slashes and rejects ambiguity", () => {
  assert.deepEqual(validateDeclaredResourcePath("skills", "skills/orchestration/"), {
    ok: true,
    normalized: "skills/orchestration",
  });
  assert.deepEqual(validateDeclaredResourcePath("knowledge", "knowledge/project-architecture/"), {
    ok: true,
    normalized: "knowledge/project-architecture",
  });
  for (const value of [
    "/agents/a.md",
    "agents//a.md",
    "./agents/a.md",
    "agents/../a.md",
    "agents\\a.md",
    "agents/a.md/",
    "C:agents/a.md",
    "agents/a:stream.md",
    "agents/a\nb.md",
    "agents/a\u0007b.md",
  ]) {
    assert.equal(validateDeclaredResourcePath("agents", value).ok, false, value);
  }
  for (const value of ["skills//x/", "skills/./x/", "skills/x//"])
    assert.equal(validateDeclaredResourcePath("skills", value).ok, false, value);

  for (const value of [
    "agents/CON", "agents/con.md", "agents/PRN.txt", "agents/AUX", "agents/NUL.json",
    "agents/COM1.md", "agents/com9", "agents/LPT1.txt", "agents/lpt9.log",
    "agents/COM¹.md", "agents/com²", "agents/CoM³.log",
    "agents/LPT¹.txt", "agents/lpt²", "agents/LpT³.log",
    "agents/name.", "agents/name ", "agents/bad<name.md", "agents/bad>name.md",
    "agents/bad:name.md", "agents/bad\"name.md", "agents/bad|name.md",
    "agents/bad?name.md", "agents/bad*name.md",
  ]) assert.equal(validateDeclaredResourcePath("agents", value).ok, false, value);
  for (const value of ["agents/COM0.md", "agents/COM10.md", "agents/console.md", "skills/conventional/"])
    assert.equal(validateDeclaredResourcePath(value.startsWith("skills/") ? "skills" : "agents", value).ok, true, value);
});

test("manifest allocation is bounded by stat size before the loader reads bytes", () => {
  const root = temp();
  manifest(root, "x".repeat(CONFIG_LIMITS.inputBytes + 1));
  let reads = 0;
  const oversized = loadConfigProject(root, {
    readFile(path) {
      reads++;
      return readFileSync(path, "utf8");
    },
  });
  assert.equal(oversized.status, "invalid");
  if (oversized.status === "invalid") assert.equal(oversized.diagnostics[0]?.code, "CONFIG_INPUT_TOO_LARGE");
  assert.equal(reads, 0);

  manifest(root);
  assert.equal(loadConfigProject(root, {
    readFile(path) {
      reads++;
      return readFileSync(path, "utf8");
    },
  }).status, "configured");
  assert.equal(reads, 1);
});

test("manifest registries are sorted, retain IDs/ranges, and isolate resource failures", () => {
  const root = temp();
  write(join(root, ".pi/hive/agents/worker.md"), "---\nname: Worker\n---\n");
  write(join(root, ".pi/hive/workflows/build.yaml"), "name: Build\n");
  mkdirSync(join(root, ".pi/hive/skills/orchestration"), { recursive: true });
  manifest(root, validManifest("skills:\n  orchestration: skills/orchestration/\n  missing: skills/missing/\n"));
  const result = loadConfigProject(root);
  assert.equal(result.status, "configured");
  if (result.status !== "configured") return;
  assert.deepEqual(result.registries.agents.map(({ id }) => id), ["worker"]);
  assert.deepEqual(result.registries.skills.map(({ id }) => id), ["missing", "orchestration"]);
  assert.equal(result.registries.agents[0]?.declaredPath, "agents/worker.md");
  assert.equal(result.registries.agents[0]?.sourceRange.start.line, 3);
  assert.equal(result.registries.skills[0]?.status, "failed");
  assert.equal(result.registries.skills[1]?.status, "available");
  assert.equal(result.diagnostics.some(({ code, resourceId }) => code === "RESOURCE_NOT_FOUND" && resourceId === "missing"), true);
});

test("resource containment rejects symlink and missing-tail escapes while preserving in-root links", () => {
  const root = temp();
  const outside = temp();
  write(join(outside, "worker.md"), "outside");
  mkdirSync(join(root, ".pi/hive/agents"), { recursive: true });
  symlinkSync(join(outside, "worker.md"), join(root, ".pi/hive/agents/escaped.md"));
  symlinkSync(outside, join(root, ".pi/hive/agents/escaped-dir"), "dir");
  write(join(root, ".pi/hive/agents/inside.md"), "inside");
  symlinkSync("inside.md", join(root, ".pi/hive/agents/linked.md"));
  symlinkSync("missing.md", join(root, ".pi/hive/agents/broken.md"));
  manifest(root, "schema-version: 1\nagents:\n  broken: agents/broken.md\n  escaped: agents/escaped.md\n  missing-tail: agents/escaped-dir/missing.md\n  linked: agents/linked.md\nworkflows: {}\n");
  const result = loadConfigProject(root);
  assert.equal(result.status, "configured");
  if (result.status !== "configured") return;
  assert.deepEqual(result.registries.agents.map(({ id, status }) => [id, status]), [
    ["broken", "failed"],
    ["escaped", "failed"],
    ["linked", "available"],
    ["missing-tail", "failed"],
  ]);
  assert.equal(result.registries.agents[0]?.diagnosticCodes[0], "RESOURCE_NOT_FOUND");
  assert.equal(result.diagnostics.filter(({ code }) => code === "RESOURCE_PATH_ESCAPE").length, 2);

  const thrown = resolveRegistryTarget(root, join(root, ".pi/hive"), "agents", "agents/inside.md", {
    resolveContained() {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
  });
  assert.deepEqual(thrown, { ok: false, code: "RESOURCE_ACCESS_FAILED" });
  const vanished = resolveRegistryTarget(root, join(root, ".pi/hive"), "agents", "agents/inside.md", {
    resolveContained() {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    },
  });
  assert.deepEqual(vanished, { ok: false, code: "RESOURCE_NOT_FOUND" });
});

test("malformed root manifests fail globally with project-relative exact diagnostics", () => {
  const root = temp();
  manifest(root, "schema-version: 1\nagents: []\nworkflows: {}\n");
  const schema = loadConfigProject(root);
  assert.equal(schema.status, "invalid");
  if (schema.status === "invalid") {
    assert.equal(schema.diagnostics[0]?.code, "SCHEMA_INVALID");
    assert.equal(schema.diagnostics[0]?.source, ".pi/hive/hive-config.yaml");
    assert.equal(schema.diagnostics[0]?.range.start.line, 2);
  }
  manifest(root, "schema-version: 1\na: [\n");
  const syntax = loadConfigProject(root);
  assert.equal(syntax.status, "invalid");
  if (syntax.status === "invalid") assert.equal(syntax.diagnostics[0]?.code, "YAML_SYNTAX");
});

test("workflow paths must be direct nonempty yaml children and canonical duplicate targets fail globally", () => {
  const root = temp();
  write(join(root, ".pi/hive/workflows/build.yaml"), "name: Build\n");
  manifest(root, "schema-version: 1\nagents: {}\nworkflows:\n  one: workflows/build.yaml\n  two: workflows/nested/build.yaml\n");
  const configured = loadConfigProject(root);
  assert.equal(configured.status, "configured");
  if (configured.status === "configured") assert.equal(configured.registries.workflows[1]?.status, "failed");

  manifest(root, "schema-version: 1\nagents: {}\nworkflows:\n  wrong: workflows/build.yml\n  empty: workflows/.yaml\n");
  const empty = loadConfigProject(root);
  assert.equal(empty.status, "configured");
  if (empty.status === "configured") {
    assert.equal(empty.registries.workflows[0]?.diagnosticCodes[0], "WORKFLOW_PATH_INVALID");
    assert.equal(empty.registries.workflows[1]?.diagnosticCodes[0], "WORKFLOW_PATH_INVALID");
  }

  manifest(root, "schema-version: 1\nagents: {}\nworkflows:\n  one: workflows/build.yaml\n  two: workflows/build.yaml\n");
  const duplicate = loadConfigProject(root);
  assert.equal(duplicate.status, "invalid");
  if (duplicate.status === "invalid") assert.equal(duplicate.diagnostics.some(({ code }) => code === "REGISTRY_DUPLICATE_TARGET"), true);
});

test("knowledge path diagnostics use the nested path value range", () => {
  const root = temp();
  manifest(root, "schema-version: 1\nagents: {}\nworkflows: {}\nknowledge:\n  docs:\n    provider: okf\n    path: ../escape\n    updates: reviewed\n");
  const result = loadConfigProject(root);
  assert.equal(result.status, "configured");
  if (result.status !== "configured") return;
  const diagnostic = result.diagnostics.find(({ resourceId }) => resourceId === "docs");
  assert.equal(diagnostic?.code, "CONFIG_PATH_INVALID");
  assert.equal(diagnostic?.range.start.line, 7);
  assert.deepEqual(diagnostic?.range, result.sourceMap["/knowledge/docs/path"]?.value);
});

test("wrong resource filesystem types become failed nodes", () => {
  const root = temp();
  mkdirSync(join(root, ".pi/hive/agents/not-file.md"), { recursive: true });
  write(join(root, ".pi/hive/skills/not-directory"), "file");
  manifest(root, "schema-version: 1\nagents:\n  wrong-agent: agents/not-file.md\nworkflows: {}\nskills:\n  wrong-skill: skills/not-directory\n");
  const result = loadConfigProject(root);
  assert.equal(result.status, "configured");
  if (result.status === "configured") {
    assert.equal(result.registries.agents[0]?.diagnosticCodes[0], "RESOURCE_TYPE_MISMATCH");
    assert.equal(result.registries.skills[0]?.diagnosticCodes[0], "RESOURCE_TYPE_MISMATCH");
  }
});

test("registry public types preserve kind-specific declaration data", () => {
  const root = temp();
  write(join(root, ".pi/hive/agents/worker.md"), "worker");
  mkdirSync(join(root, ".pi/hive/knowledge/docs"), { recursive: true });
  manifest(root, "schema-version: 1\nagents:\n  worker: agents/worker.md\nworkflows: {}\nknowledge:\n  docs:\n    provider: okf\n    path: knowledge/docs/\n    updates: reviewed\n");
  const result = loadConfigProject(root);
  assert.equal(result.status, "configured");
  if (result.status !== "configured") return;
  const agentDeclaration: string = result.registries.agents[0]!.declaredData;
  const knowledgeDeclaration: NonNullable<RawManifestV1["knowledge"]>[string] = result.registries.knowledge[0]!.declaredData;
  assert.equal(agentDeclaration, "agents/worker.md");
  assert.equal(knowledgeDeclaration.provider, "okf");
  assert.equal(result.registries.agents[0]!.kind, "agents");
  assert.equal(result.registries.knowledge[0]!.kind, "knowledge");
});

test("same basename under distinct canonical agent targets preserves manifest IDs", () => {
  const root = temp();
  write(join(root, ".pi/hive/agents/a/worker.md"), "a");
  write(join(root, ".pi/hive/agents/b/worker.md"), "b");
  manifest(root, "schema-version: 1\nagents:\n  first: agents/a/worker.md\n  second: agents/b/worker.md\nworkflows: {}\n");
  const result = loadConfigProject(root);
  assert.equal(result.status, "configured");
  if (result.status === "configured") assert.deepEqual(result.registries.agents.map(({ id, status }) => [id, status]), [["first", "available"], ["second", "available"]]);
});

test("registry count, aggregate path bytes, path bytes, and path depth enforce N/N+1 safety ceilings", () => {
  assert.equal(validateDeclaredResourcePath("agents", "a".repeat(CONFIG_REGISTRY_LIMITS.declaredPathBytes)).ok, true);
  const tooLong = validateDeclaredResourcePath("agents", "a".repeat(CONFIG_REGISTRY_LIMITS.declaredPathBytes + 1));
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.code, "CONFIG_PATH_TOO_LONG");
  assert.equal(validateDeclaredResourcePath("skills", `${"a/".repeat(CONFIG_REGISTRY_LIMITS.pathSegments - 1)}a`).ok, true);
  const tooDeep = validateDeclaredResourcePath("skills", `${"a/".repeat(CONFIG_REGISTRY_LIMITS.pathSegments)}a`);
  assert.equal(tooDeep.ok, false);
  if (!tooDeep.ok) assert.equal(tooDeep.code, "CONFIG_PATH_TOO_DEEP");

  const root = temp();
  const entries = Array.from({ length: CONFIG_REGISTRY_LIMITS.registryEntries + 1 }, (_, index) => `  id-${index}: agents/missing-${index}.md`).join("\n");
  manifest(root, `schema-version: 1\nagents:\n${entries}\nworkflows: {}\n`);
  const overLimit = loadConfigProject(root);
  assert.equal(overLimit.status, "invalid");
  if (overLimit.status === "invalid") assert.equal(overLimit.diagnostics.some(({ code }) => code === "REGISTRY_LIMIT_EXCEEDED"), true);
});

function fixedPath(index: number, bytes: number): string {
  const prefix = `agents/${index}-`;
  return `${prefix}${"x".repeat(bytes - Buffer.byteLength(prefix))}`;
}

function directManifest(entries: number, aggregateBytes: number): RawManifestV1 {
  const agents: Record<string, string> = {};
  let remaining = aggregateBytes;
  for (let index = 0; index < entries; index++) {
    const slots = entries - index;
    const bytes = Math.floor(remaining / slots);
    agents[`id-${index}`] = fixedPath(index, bytes);
    remaining -= bytes;
  }
  return { "schema-version": 1, agents, workflows: {} };
}

test("registry total and aggregate declared path limits accept N and reject N+1 directly", () => {
  const root = temp();
  const sourceMap = {};
  const atCount = buildManifestRegistries(root, join(root, ".pi/hive"), directManifest(CONFIG_REGISTRY_LIMITS.registryEntries, 100_000), sourceMap, ".pi/hive/hive-config.yaml");
  assert.equal(atCount.globalDiagnostics.some(({ code }) => code === "REGISTRY_LIMIT_EXCEEDED"), false);
  const overCount = buildManifestRegistries(root, join(root, ".pi/hive"), directManifest(CONFIG_REGISTRY_LIMITS.registryEntries + 1, 100_000), sourceMap, ".pi/hive/hive-config.yaml");
  assert.equal(overCount.globalDiagnostics.some(({ code }) => code === "REGISTRY_LIMIT_EXCEEDED"), true);

  const atBytes = buildManifestRegistries(root, join(root, ".pi/hive"), directManifest(256, CONFIG_REGISTRY_LIMITS.aggregateDeclaredPathBytes), sourceMap, ".pi/hive/hive-config.yaml");
  assert.equal(atBytes.globalDiagnostics.some(({ code }) => code === "REGISTRY_LIMIT_EXCEEDED"), false);
  const overBytes = buildManifestRegistries(root, join(root, ".pi/hive"), directManifest(256, CONFIG_REGISTRY_LIMITS.aggregateDeclaredPathBytes + 1), sourceMap, ".pi/hive/hive-config.yaml");
  assert.equal(overBytes.globalDiagnostics.some(({ code }) => code === "REGISTRY_LIMIT_EXCEEDED"), true);

  const duplicateAgents = Object.fromEntries(Array.from({ length: CONFIG_LIMITS.diagnostics + 2 }, (_, index) => [`duplicate-${index}`, "agents/shared.md"]));
  const boundedGlobals = buildManifestRegistries(root, join(root, ".pi/hive"), { "schema-version": 1, agents: duplicateAgents, workflows: {} }, sourceMap, ".pi/hive/hive-config.yaml");
  assert.ok(boundedGlobals.globalDiagnostics.length <= CONFIG_LIMITS.diagnostics);
  assert.equal(boundedGlobals.globalDiagnostics.at(-1)?.code, "DIAGNOSTICS_TRUNCATED");
});

test("global registry causes survive saturated resource diagnostics", () => {
  const root = temp();
  write(join(root, ".pi/hive/agents/shared.md"), "shared");
  const missing = Array.from({ length: CONFIG_LIMITS.diagnostics + 5 }, (_, index) => `  missing-${index}: agents/missing-${index}.md`).join("\n");
  manifest(root, `schema-version: 1\nagents:\n${missing}\n  zz-duplicate-one: agents/shared.md\n  zz-duplicate-two: agents/shared.md\nworkflows: {}\n`);
  const result = loadConfigProject(root);
  assert.equal(result.status, "invalid");
  if (result.status !== "invalid") return;
  assert.equal(result.truncated, true);
  assert.ok(result.diagnostics.length <= CONFIG_LIMITS.diagnostics);
  assert.equal(result.diagnostics.some(({ code }) => code === "REGISTRY_DUPLICATE_TARGET"), true);
  assert.equal(result.diagnostics.some(({ code }) => code === "DIAGNOSTICS_TRUNCATED"), true);
});
