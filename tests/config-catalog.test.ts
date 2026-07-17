import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CONFIG_CATALOG_LIMITS, buildCatalogSummary, loadConfigCatalogs, loadConfigProject, type AgentCatalogNode, type ConfiguredProject } from "../src/config/index.ts";

function temp(): string { return mkdtempSync(join(tmpdir(), "pi-hive-w03-catalog-")); }
function write(path: string, value: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function configured(): ConfiguredProject {
  const root = temp();
  write(join(root, ".pi/hive/agents/good.md"), "---\nname: Good\ncapabilities: {}\nskills: [docs]\nknowledge: [owned]\n---\nTOP SECRET PROMPT\n");
  write(join(root, ".pi/hive/agents/bad.md"), "broken");
  write(join(root, ".pi/hive/skills/docs/readme.md"), "TOP SECRET SKILL\n");
  mkdirSync(join(root, ".pi/hive/knowledge/owned"), { recursive: true });
  write(join(root, ".pi/hive/hive-config.yaml"), "schema-version: 1\nagents:\n  bad: agents/bad.md\n  good: agents/good.md\nworkflows: {}\nskills:\n  docs: skills/docs/\nknowledge:\n  owned: {provider: okf, path: knowledge/owned/, owner: good}\n");
  const project = loadConfigProject(root); assert.equal(project.status, "configured"); return project as ConfiguredProject;
}

test("catalog orchestration isolates failures, permits self-owned attachments, and emits content-free summaries", () => {
  const result = loadConfigCatalogs(configured());
  assert.equal(result.status, "available");
  assert.equal(result.agents.find((node) => node.id === "good")?.status, "available");
  assert.equal(result.agents.find((node) => node.id === "bad")?.status, "failed");
  assert.equal(result.skills[0]?.status, "available");
  assert.equal(result.knowledge[0]?.status, "available");
  assert.equal(result.edges.some((edge) => edge.from === "agent:good" && edge.target === "knowledge:owned"), true);
  const summary = JSON.stringify(result.summary);
  assert.equal(summary.includes("TOP SECRET"), false);
  assert.equal(summary.includes(result.projectRoot), false);
  assert.deepEqual(result.summary.items.map((item) => `${item.kind}:${item.id}`), ["agent:bad", "agent:good", "knowledge:owned", "skill:docs"]);
});

test("attachment quarantine is followed by deterministic owner revalidation", () => {
  const project = configured();
  const good = project.registries.agents.find((entry) => entry.id === "good")!;
  write(good.canonicalPath!, "---\nname: Good\ncapabilities: {}\nskills: [missing]\n---\nbody\n");
  const result = loadConfigCatalogs(project);
  assert.equal(result.agents.find((node) => node.id === "good")?.diagnosticCodes.includes("CATALOG_DEPENDENCY_MISSING"), true);
  const dependency = result.diagnostics.find(({ code }) => code === "CATALOG_DEPENDENCY_MISSING");
  assert.equal(dependency?.source, ".pi/hive/agents/good.md");
  assert.equal(dependency?.range.start.line, 4);
  assert.equal(result.skills[0]?.status, "available");
  assert.equal(result.knowledge[0]?.status, "failed");
  assert.equal(result.knowledge[0]?.diagnosticCodes.includes("KNOWLEDGE_OWNER_FAILED"), true);
  const owner = result.diagnostics.find(({ code }) => code === "KNOWLEDGE_OWNER_FAILED");
  assert.equal(owner?.source, ".pi/hive/hive-config.yaml");
  assert.equal(owner?.dependencyChain?.join(" -> "), "knowledge:owned -> agent:good");
});

test("aggregate content exhaustion marks current and remaining IDs failed without further reads", () => {
  const root = temp();
  const ids = Array.from({ length: 66 }, (_, i) => `agent-${String(i).padStart(2, "0")}`);
  for (const id of ids) write(join(root, `.pi/hive/agents/${id}.md`), "x");
  write(join(root, ".pi/hive/hive-config.yaml"), `schema-version: 1\nagents:\n${ids.map((id) => `  ${id}: agents/${id}.md`).join("\n")}\nworkflows: {}\n`);
  const project = loadConfigProject(root); assert.equal(project.status, "configured");
  const bytes = Buffer.alloc(CONFIG_CATALOG_LIMITS.agentFileBytes);
  let reads = 0;
  const stats = { size: 0, isFile: () => true } as Stats;
  const result = loadConfigCatalogs(project as ConfiguredProject, { agents: { stat: () => stats, readFile: () => { reads++; return bytes; } } });
  assert.equal(reads, 65);
  assert.equal(result.agents[64]?.diagnosticCodes.includes("CATALOG_AGGREGATE_TOO_LARGE"), true);
  assert.equal(result.agents[65]?.diagnosticCodes.includes("CATALOG_AGGREGATE_TOO_LARGE"), true);
});

test("catalog summaries bound item count, entry bytes, and aggregate bytes before exposing content", () => {
  const many: AgentCatalogNode[] = Array.from({ length: CONFIG_CATALOG_LIMITS.summaryItems + 1 }, (_, i) => ({
    kind: "agent", id: `agent-${String(i).padStart(4, "0")}`, status: "failed", diagnosticCodes: ["SCHEMA_INVALID"],
  }));
  const bounded = buildCatalogSummary(many);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.items.length <= CONFIG_CATALOG_LIMITS.summaryItems);
  assert.ok(bounded.bytes <= CONFIG_CATALOG_LIMITS.summaryBytes);

  const verbose: AgentCatalogNode = {
    kind: "agent", id: "verbose", status: "available", diagnosticCodes: [], name: "Verbose",
    tags: Array.from({ length: CONFIG_CATALOG_LIMITS.agentTags }, (_, i) => `tag-${i}-${"x".repeat(100)}`),
    frontmatter: { name: "Verbose", capabilities: {} }, prompt: "secret", ranges: manyRanges(),
    sourceHash: "a".repeat(64), canonicalSourceHash: "b".repeat(64), promptHash: "c".repeat(64), sourceBytes: 6,
  };
  const item = buildCatalogSummary([verbose]).items[0]!;
  assert.ok(Buffer.byteLength(JSON.stringify(item)) <= CONFIG_CATALOG_LIMITS.summaryEntryBytes);
  assert.equal(JSON.stringify(item).includes("secret"), false);
});

function manyRanges() {
  const range = { start: { offset: 0, line: 1, column: 1 }, end: { offset: 0, line: 1, column: 1 } };
  return { source: range, frontmatter: range, openingDelimiter: range, closingDelimiter: range, body: range };
}

test("catalog loaders accept representative fixtures and import no legacy semantic types", () => {
  const fixture = join(import.meta.dirname, "fixtures/workflow-configs/combined-delivery");
  const loaded = loadConfigProject(fixture);
  assert.equal(loaded.status, "configured");
  const catalogs = loadConfigCatalogs(loaded as ConfiguredProject);
  assert.equal(catalogs.agents.every((node) => node.status === "available"), true);
  assert.equal(catalogs.skills.every((node) => node.status === "available"), true);
  assert.equal(catalogs.knowledge.every((node) => node.status === "available"), true);

  for (const file of ["agents.ts", "catalog-hash.ts", "catalog-types.ts", "catalogs.ts", "knowledge.ts", "skills.ts"]) {
    const source = readFileSync(join(import.meta.dirname, "../src/config", file), "utf8");
    for (const forbidden of ["AgentType", "agent-type", "planner", "mental-model", "DefaultResourceLoader", "allowOutsideProject"])
      assert.equal(source.includes(forbidden), false, `${file}: ${forbidden}`);
  }
});
