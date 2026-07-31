import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  CONFIG_CATALOG_LIMITS,
  CONFIG_REGISTRY_LIMITS,
  loadAgentCatalog,
  loadConfigProject,
  type ConfiguredProject,
} from "../../src/config/index.ts";

function temp(): string { return mkdtempSync(join(tmpdir(), "pi-hive-w03-agent-")); }
function write(path: string, value: string | Buffer): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function project(agentSource: string | Buffer, extraManifest = ""): ConfiguredProject {
  const root = temp();
  write(join(root, ".pi/hive/agents/worker.md"), agentSource);
  write(join(root, ".pi/hive/workflows/build.yaml"), "name: Build\ndescription: Build\nuse-when: now\nartifact: {adapter: none, profile: default, binding: none}\nteam: {id: root, agent: worker}\ninstructions: {root: run}\n");
  write(join(root, ".pi/hive/hive-config.yaml"), `schema-version: 1\nagents:\n  worker: agents/worker.md\nworkflows:\n  build: workflows/build.yaml\n${extraManifest}`);
  const loaded = loadConfigProject(root);
  assert.equal(loaded.status, "configured");
  return loaded as ConfiguredProject;
}

const valid = "---\r\nname: Worker\r\nmodel: openai/gpt-5/codex\r\ncapabilities: {}\r\ntags: [worker]\r\n---\r\nKeep  exact spaces.\r\n";

test("agent frontmatter preserves full-file ranges and exact prompt while hashes normalize line endings", () => {
  const crlf = loadAgentCatalog(project(valid));
  const agent = crlf.agents[0];
  assert.equal(agent.status, "available");
  if (agent.status !== "available") return;
  assert.equal(agent.prompt, "Keep  exact spaces.\r\n");
  assert.equal(agent.ranges.source.start.offset, 0);
  assert.equal(agent.ranges.body.start.offset, valid.indexOf("Keep"));
  assert.equal(agent.ranges.body.end.offset, valid.length);
  assert.match(agent.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(agent.promptHash, /^[a-f0-9]{64}$/);

  const lf = loadAgentCatalog(project(valid.replaceAll("\r\n", "\n"))).agents[0];
  assert.equal(lf.status, "available");
  if (lf.status === "available") {
    assert.equal(lf.promptHash, agent.promptHash);
    assert.equal(lf.canonicalSourceHash, agent.canonicalSourceHash);
    assert.notEqual(lf.sourceHash, agent.sourceHash);
  }
});

test("frontmatter YAML and schema diagnostics translate to exact full-file ranges", () => {
  const source = "---\nname: Worker\ncapabilities: {}\nmystery: true\n---\nbody\n";
  const result = loadAgentCatalog(project(source));
  const diagnostic = result.diagnostics.find(({ code }) => code === "SCHEMA_INVALID");
  assert.ok(diagnostic);
  const start = source.indexOf("mystery");
  assert.deepEqual(diagnostic.range, {
    start: { offset: start, line: 4, column: 1 },
    end: { offset: start + "mystery".length, line: 4, column: 8 },
  });
});

test("agent split/decode failures use exact ranges local to the named agent file", () => {
  const missing = "name: Worker\n";
  const unterminated = "---\nname: Worker\ncapabilities: {}\n";
  const multiple = "---\nname: Worker\ncapabilities: {}\n---\n \n---\n---\nbody\n";
  const multipleCrlf = multiple.replaceAll("\n", "\r\n");
  const blockRange = (value: string): [number, number] => {
    const firstClose = value.indexOf("---", 4);
    const secondOpen = value.indexOf("---", firstClose + 3);
    const secondClose = value.indexOf("---", secondOpen + 3);
    return [secondOpen, secondClose + 3];
  };
  const cases: Array<[string | Buffer, string, number, number]> = [
    [missing, "AGENT_FRONTMATTER_MISSING", 0, 3],
    [`\ufeff---\nname: Worker\ncapabilities: {}\n---\nbody\n`, "AGENT_FRONTMATTER_MISSING", 0, 1],
    [unterminated, "AGENT_FRONTMATTER_UNTERMINATED", 0, unterminated.length],
    [multiple, "AGENT_FRONTMATTER_MULTIPLE", ...blockRange(multiple)],
    [multipleCrlf, "AGENT_FRONTMATTER_MULTIPLE", ...blockRange(multipleCrlf)],
    [Buffer.from([0xc3, 0x28]), "CATALOG_TEXT_INVALID_UTF8", 0, 0],
  ];
  for (const [source, code, start, end] of cases) {
    const result = loadAgentCatalog(project(source));
    const diagnostic = result.diagnostics.find((item) => item.code === code);
    assert.equal(diagnostic?.source, ".pi/hive/agents/worker.md", code);
    assert.equal(diagnostic?.range.start.offset, start, code);
    assert.equal(diagnostic?.range.end.offset, end, code);
  }

  const thematic = "---\nname: Worker\ncapabilities: {}\n---\nbody text\n---\nordinary rule\n";
  assert.equal(loadAgentCatalog(project(thematic)).agents[0]?.status, "available");
});

test("agent loader rejects invalid body/schema/model precisely", () => {
  const cases: Array<[string, string]> = [
    ["---\nname: Worker\ncapabilities: {}\n---\n   \n", "AGENT_BODY_EMPTY"],
    ["---\nname: Worker\n---\nbody\n", "SCHEMA_INVALID"],
    ["---\nname: Worker\ncapabilities: {}\nmodel: provider\n---\nbody\n", "SCHEMA_INVALID"],
  ];
  for (const [source, code] of cases) {
    const result = loadAgentCatalog(project(source));
    assert.equal(result.agents[0]?.status, "failed", code);
    assert.equal(result.agents[0]?.diagnosticCodes.includes(code as never), true, code);
  }
});

test("agent dependency edges stop at the shared graph safety limit", () => {
  const root = temp();
  const skills = Array.from({ length: CONFIG_CATALOG_LIMITS.agentSkills }, (_, i) => `s${i}`).join(", ");
  const knowledge = Array.from({ length: CONFIG_CATALOG_LIMITS.agentKnowledge }, (_, i) => `k${i}`).join(", ");
  const ids = Array.from({ length: 80 }, (_, i) => `agent-${i}`);
  for (const id of ids) write(join(root, `.pi/hive/agents/${id}.md`), `---\nname: ${id}\ncapabilities: {}\nskills: [${skills}]\nknowledge: [${knowledge}]\n---\nbody\n`);
  write(join(root, ".pi/hive/hive-config.yaml"), `schema-version: 1\nagents:\n${ids.map((id) => `  ${id}: agents/${id}.md`).join("\n")}\nworkflows: {}\n`);
  const configured = loadConfigProject(root); assert.equal(configured.status, "configured");
  const result = loadAgentCatalog(configured as ConfiguredProject);
  assert.ok(result.edges.length <= CONFIG_REGISTRY_LIMITS.dependencyEdges);
  assert.equal(result.agents.some((node) => node.diagnosticCodes.includes("DEPENDENCY_LIMIT_EXCEEDED")), true);
});

test("agent frontmatter, prompt, scalar, and list limits accept N and reject N+1 at exact ranges", () => {
  const base = "name: Worker\ncapabilities: {}\n";
  const exactYaml = `${base}#${"x".repeat(CONFIG_CATALOG_LIMITS.frontmatterBytes - Buffer.byteLength(base) - 2)}\n`;
  assert.equal(Buffer.byteLength(exactYaml), CONFIG_CATALOG_LIMITS.frontmatterBytes);
  assert.equal(loadAgentCatalog(project(`---\n${exactYaml}---\nbody\n`)).agents[0]?.status, "available");
  const overFrontmatter = `---\n${exactYaml.slice(0, -1)}x\n---\nbody\n`;
  const frontmatterResult = loadAgentCatalog(project(overFrontmatter));
  assert.equal(frontmatterResult.diagnostics.find(({ code }) => code === "CATALOG_FILE_TOO_LARGE")?.range.start.offset, 4);

  const atBodyLimit = `---\n${base}---\n${"x".repeat(CONFIG_CATALOG_LIMITS.promptBodyBytes)}`;
  assert.equal(loadAgentCatalog(project(atBodyLimit)).agents[0]?.status, "available");
  const overBody = `${atBodyLimit}x`;
  const bodyDiagnostic = loadAgentCatalog(project(overBody)).diagnostics.find(({ code }) => code === "CATALOG_FILE_TOO_LARGE");
  assert.equal(bodyDiagnostic?.range.start.offset, overBody.indexOf("x"));
  assert.equal(bodyDiagnostic?.range.end.offset, overBody.length);

  const scalar = (key: string, value: string) => key === "name"
    ? `---\nname: ${value}\ncapabilities: {}\n---\nbody\n`
    : `---\nname: Worker\ncapabilities: {}\n${key}: ${value}\n---\nbody\n`;
  for (const [key, limit, at, over] of [
    ["name", CONFIG_CATALOG_LIMITS.agentNameBytes, "n".repeat(CONFIG_CATALOG_LIMITS.agentNameBytes), "n".repeat(CONFIG_CATALOG_LIMITS.agentNameBytes + 1)],
    ["description", CONFIG_CATALOG_LIMITS.agentDescriptionBytes, "d".repeat(CONFIG_CATALOG_LIMITS.agentDescriptionBytes), "d".repeat(CONFIG_CATALOG_LIMITS.agentDescriptionBytes + 1)],
    ["model", CONFIG_CATALOG_LIMITS.agentModelBytes, `p/${"m".repeat(CONFIG_CATALOG_LIMITS.agentModelBytes - 2)}`, `p/${"m".repeat(CONFIG_CATALOG_LIMITS.agentModelBytes - 1)}`],
  ] as const) {
    assert.equal(loadAgentCatalog(project(scalar(key, at))).agents[0]?.status, "available", `${key} N`);
    const source = scalar(key, over);
    const diagnostic = loadAgentCatalog(project(source)).diagnostics.find(({ code }) => code === "CATALOG_FILE_TOO_LARGE");
    const valueStart = source.indexOf(over);
    assert.equal(diagnostic?.range.start.offset, valueStart, `${key} range start`);
    assert.equal(diagnostic?.range.end.offset, valueStart + over.length, `${key} range end`);
    assert.equal(Buffer.byteLength(at), limit);
  }

  const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(", ");
  for (const [key, limit, code] of [
    ["tags", CONFIG_CATALOG_LIMITS.agentTags, "SCHEMA_INVALID"],
    ["skills", CONFIG_CATALOG_LIMITS.agentSkills, "AGENT_ATTACHMENT_LIMIT_EXCEEDED"],
    ["knowledge", CONFIG_CATALOG_LIMITS.agentKnowledge, "AGENT_ATTACHMENT_LIMIT_EXCEEDED"],
  ] as const) {
    assert.equal(loadAgentCatalog(project(scalar(key, `[${ids(key[0], limit)}]`))).agents[0]?.status, "available", `${key} N`);
    const listValue = `[${ids(key[0], limit + 1)}]`;
    const source = scalar(key, listValue);
    const diagnostic = loadAgentCatalog(project(source)).diagnostics.find((item) => item.code === code);
    const valueStart = source.indexOf(listValue);
    assert.equal(diagnostic?.range.start.offset, valueStart, `${key} range start`);
    assert.equal(diagnostic?.range.end.offset, valueStart + listValue.length, `${key} range end`);
  }
  const combinedN = `---\n${base}skills: [${ids("s", CONFIG_CATALOG_LIMITS.agentSkills)}]\nknowledge: [${ids("k", CONFIG_CATALOG_LIMITS.agentKnowledge)}]\n---\nbody\n`;
  assert.equal(loadAgentCatalog(project(combinedN)).agents[0]?.status, "available");
  const combinedOver = combinedN.replace(`k${CONFIG_CATALOG_LIMITS.agentKnowledge - 1}]`, `k${CONFIG_CATALOG_LIMITS.agentKnowledge - 1}, k${CONFIG_CATALOG_LIMITS.agentKnowledge}]`);
  const combinedDiagnostic = loadAgentCatalog(project(combinedOver)).diagnostics.find(({ code }) => code === "AGENT_ATTACHMENT_LIMIT_EXCEEDED");
  const combinedStart = combinedOver.indexOf("[", combinedOver.indexOf("knowledge:"));
  const combinedEnd = combinedOver.indexOf("]", combinedStart) + 1;
  assert.equal(combinedDiagnostic?.range.start.offset, combinedStart, "combined attachment range start");
  assert.equal(combinedDiagnostic?.range.end.offset, combinedEnd, "combined attachment range end");
});
