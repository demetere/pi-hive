import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CONFIG_CATALOG_LIMITS, loadAgentCatalog, loadConfigProject, loadKnowledgeCatalog, type ConfiguredProject, type KnowledgeLoadOperations } from "../src/config/index.ts";

function temp(): string { return mkdtempSync(join(tmpdir(), "pi-hive-w03-knowledge-")); }
function write(path: string, value: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function project(knowledge: string, setup?: (root: string) => void): ConfiguredProject {
  const root = temp();
  write(join(root, ".pi/hive/agents/worker.md"), "---\nname: Worker\ncapabilities: {}\nknowledge: [owned]\n---\nwork\n");
  mkdirSync(join(root, ".pi/hive/knowledge/shared"), { recursive: true });
  mkdirSync(join(root, ".pi/hive/knowledge/owned"), { recursive: true });
  setup?.(root);
  write(join(root, ".pi/hive/hive-config.yaml"), `schema-version: 1\nagents:\n  worker: agents/worker.md\nworkflows: {}\nknowledge:\n${knowledge}`);
  const result = loadConfigProject(root); assert.equal(result.status, "configured"); return result as ConfiguredProject;
}

test("knowledge metadata defaults policies and fingerprints direct names without reading content", () => {
  const configured = project("  shared: {provider: okf, path: knowledge/shared/}\n  owned: {provider: okf, path: knowledge/owned/, owner: worker}\n", (root) => {
    write(join(root, ".pi/hive/knowledge/shared/a.md"), "SECRET-A");
    mkdirSync(join(root, ".pi/hive/knowledge/shared/nested"), { recursive: true });
    write(join(root, ".pi/hive/knowledge/shared/nested/hidden.md"), "SECRET-B");
  });
  const agents = loadAgentCatalog(configured).agents;
  const result = loadKnowledgeCatalog(configured, agents);
  assert.equal(result.knowledge.find((node) => node.id === "shared")?.updates, "reviewed");
  assert.equal(result.knowledge.find((node) => node.id === "owned")?.updates, "automatic");
  for (const node of result.knowledge) if (node.status === "available") {
    assert.match(node.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(node).includes("SECRET"), false);
  }
  assert.equal(result.edges.some((edge) => edge.from === "knowledge:owned" && edge.target === "agent:worker"), true);
});

test("unknown and failed owners fail only their knowledge nodes", () => {
  const unknown = project("  shared: {provider: okf, path: knowledge/shared/}\n  owned: {provider: okf, path: knowledge/owned/, owner: missing}\n");
  const unknownResult = loadKnowledgeCatalog(unknown, loadAgentCatalog(unknown).agents);
  assert.equal(unknownResult.knowledge.find((node) => node.id === "owned")?.diagnosticCodes.includes("KNOWLEDGE_OWNER_UNKNOWN"), true);
  const ownerDiagnostic = unknownResult.diagnostics.find(({ code }) => code === "KNOWLEDGE_OWNER_UNKNOWN");
  assert.equal(ownerDiagnostic?.source, ".pi/hive/hive-config.yaml");
  assert.deepEqual(ownerDiagnostic?.range, unknown.sourceMap["/knowledge/owned/owner"]?.value);
  assert.equal(unknownResult.knowledge.find((node) => node.id === "shared")?.status, "available");

  const failed = project("  owned: {provider: okf, path: knowledge/owned/, owner: worker}\n", (root) => write(join(root, ".pi/hive/agents/worker.md"), "broken"));
  const failedResult = loadKnowledgeCatalog(failed, loadAgentCatalog(failed).agents);
  assert.equal(failedResult.knowledge[0]?.diagnosticCodes.includes("KNOWLEDGE_OWNER_FAILED"), true);
});

test("knowledge fingerprint rejects escaping direct symlinks", () => {
  const configured = project("  shared: {provider: okf, path: knowledge/shared/}\n", (root) => {
    const outside = temp(); write(join(outside, "secret.md"), "secret");
    symlinkSync(join(outside, "secret.md"), join(root, ".pi/hive/knowledge/shared/link"));
  });
  const node = loadKnowledgeCatalog(configured, loadAgentCatalog(configured).agents).knowledge[0];
  assert.equal(node?.status, "failed");
  assert.equal(node?.diagnosticCodes.includes("RESOURCE_PATH_ESCAPE"), true);
});

function virtualEntries(root: string, names: string[]): KnowledgeLoadOperations {
  const directory = join(root, ".pi/hive/knowledge/shared");
  const fake = (file: boolean): Stats => ({ size: 0, isFile: () => file, isDirectory: () => !file } as Stats);
  return {
    readdir: (path) => path === directory ? names : [],
    lstat: (path) => fake(path !== directory),
    stat: (path) => fake(path !== directory),
    realpath: (path) => path,
  };
}

test("knowledge shallow entry and name-byte limits accept N and reject N+1 before child filesystem operations", () => {
  const configured = project("  shared: {provider: okf, path: knowledge/shared/}\n");
  const agents = loadAgentCatalog(configured).agents;
  const names = Array.from({ length: CONFIG_CATALOG_LIMITS.knowledgeEntries }, (_, i) => `n${String(i).padStart(4, "0")}`);
  assert.equal(loadKnowledgeCatalog(configured, agents, virtualEntries(configured.projectRoot, names)).knowledge[0]?.status, "available");
  let entryOps = 0;
  const tooMany = virtualEntries(configured.projectRoot, [...names, "overflow"]);
  tooMany.lstat = () => { entryOps++; return ({ isFile: () => true, isDirectory: () => false } as Stats); };
  assert.equal(loadKnowledgeCatalog(configured, agents, tooMany).knowledge[0]?.diagnosticCodes.includes("KNOWLEDGE_FINGERPRINT_LIMIT_EXCEEDED"), true);
  assert.equal(entryOps, 0);

  const exactName = "x".repeat(CONFIG_CATALOG_LIMITS.knowledgeFingerprintNameBytes);
  assert.equal(loadKnowledgeCatalog(configured, agents, virtualEntries(configured.projectRoot, [exactName])).knowledge[0]?.status, "available");
  let nameOps = 0;
  const tooLong = virtualEntries(configured.projectRoot, [`${exactName}x`]);
  tooLong.lstat = () => { nameOps++; return ({ isFile: () => true, isDirectory: () => false } as Stats); };
  assert.equal(loadKnowledgeCatalog(configured, agents, tooLong).knowledge[0]?.diagnosticCodes.includes("KNOWLEDGE_FINGERPRINT_LIMIT_EXCEEDED"), true);
  assert.equal(nameOps, 0);
});
