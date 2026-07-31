import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildActivationSnapshot, buildActivationSummary } from "../../src/config/snapshot.ts";
import { loadConfigCatalogs, loadConfigProject, resolveConfigWorkflows } from "../../src/config/index.ts";
import { issueEffectiveAuthoritySnapshotForTest } from "../../src/config/snapshot-authority.ts";
import { resolveWorkflowCapabilities } from "../../src/capabilities/resolve.ts";
import { readActivationSnapshot, writeActivationSnapshot } from "../../src/config/snapshot-store.ts";
import type { ValidWorkflowDefinition } from "../../src/config/resolver.ts";
import type { ConfigCatalogResult } from "../../src/config/catalogs.ts";
import type { ConfiguredProject } from "../../src/config/manifest.ts";
import { copyWorkflowFixture } from "../helpers/workflow-fixtures.ts";

function fixture() {
  const workflow = {
    id: "debug", status: "valid", name: "Debug", description: "Debug things", useWhen: "Debug", tags: ["debug"], examples: ["one", "two"], suggestedNext: [], adapter: "none", profile: "default", diagnosticCodes: [], diagnostics: [],
    artifact: { adapter: "none", profile: "default", binding: "none", options: {}, contractVersion: "pi-hive-artifact-contract-v1", contract: { adapter: "none", profile: "default", bindings: ["none"], checkpoints: [] } }, approvals: {}, instructions: { shared: "Shared", root: "Root" },
    team: { rootId: "root", nodes: [{ id: "root", agentId: "agent", memberIds: [], depth: 1, responsibilities: ["Own"], capabilityStatus: "none", skills: { base: ["skill"], add: [], remove: [], resolved: ["skill"] }, knowledge: { base: ["knowledge"], add: [], remove: [], resolved: ["knowledge"] }, budgets: { run: {}, node: {}, invalidFields: [] }, range: { start: { offset: 0, line: 1, column: 1 }, end: { offset: 1, line: 1, column: 2 } } }] }, budgets: { run: {}, node: {}, invalidFields: [] }, source: ".pi/hive/workflows/debug.yaml", sourceMap: {}, rawSource: "workflow",
  } as unknown as ValidWorkflowDefinition;
  const catalogs = { status: "available", projectRoot: "/tmp/project", diagnostics: [], truncated: false, edges: [], summary: { items: [], truncated: false, bytes: 2 }, agents: [{ kind: "agent", id: "agent", status: "available", diagnosticCodes: [], name: "Agent", tags: [], frontmatter: { name: "Agent", model: "provider/model", thinking: "off", capabilities: {}, skills: ["skill"], knowledge: ["knowledge"] }, prompt: "Identity", ranges: {} as never, sourceHash: "a".repeat(64), canonicalSourceHash: "b".repeat(64), promptHash: "c".repeat(64), sourceBytes: 10 }], skills: [{ kind: "skill", id: "skill", status: "available", diagnosticCodes: [], files: [{ relativePath: "README.md", content: "Skill", bytes: 5, hash: "d".repeat(64) }], fileCount: 1, totalBytes: 5, treeHash: "e".repeat(64) }], knowledge: [{ kind: "knowledge", id: "knowledge", status: "available", diagnosticCodes: [], updates: "reviewed", canonicalPath: "/tmp/project/.pi/hive/knowledge/k", fingerprint: "f".repeat(64), entryCount: 1, metadataBytes: 5 }], } as unknown as ConfigCatalogResult;
  const project = { status: "configured", projectRoot: "/tmp/project", manifestPath: "/tmp/project/.pi/hive/hive-config.yaml", manifestSource: ".pi/hive/hive-config.yaml", rawSource: "manifest\n", manifest: { "schema-version": 1, agents: {}, workflows: {} }, sourceMap: {}, diagnostics: [], truncated: false, registries: { agents: [{ id: "agent", kind: "agents", status: "available", declaredPath: "agents/agent.md", projectPath: ".pi/hive/agents/agent.md", sourceRange: {} as never, diagnosticCodes: [], declaredData: "agents/agent.md", canonicalPath: "/tmp/project/.pi/hive/agents/agent.md" }], workflows: [{ id: "debug", kind: "workflows", status: "available", declaredPath: "workflows/debug.yaml", projectPath: ".pi/hive/workflows/debug.yaml", sourceRange: {} as never, diagnosticCodes: [], declaredData: "workflows/debug.yaml", canonicalPath: "/tmp/project/.pi/hive/workflows/debug.yaml" }], skills: [{ id: "skill", kind: "skills", status: "available", declaredPath: "skills/skill/", projectPath: ".pi/hive/skills/skill", sourceRange: {} as never, diagnosticCodes: [], declaredData: "skills/skill/", canonicalPath: "/tmp/project/.pi/hive/skills/skill" }], knowledge: [{ id: "knowledge", kind: "knowledge", status: "available", declaredPath: "knowledge/k/", projectPath: ".pi/hive/knowledge/k", sourceRange: {} as never, diagnosticCodes: [], declaredData: { provider: "okf", path: "knowledge/k/" }, canonicalPath: "/tmp/project/.pi/hive/knowledge/k" }] } } as unknown as ConfiguredProject;
  return { workflow, catalogs, project };
}
const models = { defaultModel: "provider/model", defaultThinking: "off", find: (id: string) => id === "provider/model" ? { id, contextWindow: 1_000_000, maxTokens: 8_000, thinking: ["off", "medium"] } : undefined, canActivate: () => true, estimateTokens: (text: string) => Buffer.byteLength(text) };
function authorityNode(nodeId = "root", model = "provider/model", thinking = "off") {
  return {
    nodeId,
    capabilities: {
      effective: { filesystem: [], shell: [], git: false, "external-network": false, "human-input": false, artifact: [], knowledge: [] },
      provenance: { filesystem: ["agent-ceiling", "inherited"], shell: ["agent-ceiling", "inherited"], git: ["agent-ceiling", "inherited"], "external-network": ["agent-ceiling", "inherited"], "human-input": ["agent-ceiling", "inherited"], artifact: ["agent-ceiling", "inherited"], knowledge: ["agent-ceiling", "inherited"] },
      budgets: {}, attachments: { skills: [], knowledge: [] }, directMemberIds: [],
    },
    tools: [] as string[], model, thinking,
  };
}
function testAuthority(workflowId = "debug", nodes = [authorityNode()]) {
  return issueEffectiveAuthoritySnapshotForTest(workflowId, nodes);
}
test("builder requires branded complete matching authority and produces stable reachable-only identity", () => {
  const { workflow, catalogs, project } = fixture();
  const authority = testAuthority();
  const input = { project, workflow, catalogs, authority, models, packageVersion: "0.1.0", createdAt: "2026-01-01T00:00:00.000Z" } as const;
  const first = buildActivationSnapshot(input);
  const second = buildActivationSnapshot({ ...input, createdAt: "2027-01-01T00:00:00.000Z" });
  assert.equal(first.snapshotHash, second.snapshotHash);
  assert.equal(first.payload.models[0].dynamicReserve >= 266_240, true, "activation records the complete bounded dynamic prompt reserve");
  assert.notEqual(first.createdAt, second.createdAt);
  assert.equal(first.payload.project.rootRef, ".");
  assert.deepEqual(first.payload.subsystems, { knowledge: true });
  assert.equal(JSON.stringify(first).includes("/tmp/project"), false);
  assert.equal(first.payload.knowledge[0].metadataFingerprint, "f".repeat(64));
  assert.equal(JSON.stringify(first).includes("Skill"), true);
  assert.throws(() => buildActivationSnapshot({ ...input, authority: {} as never }), /authority/i);
  assert.throws(() => buildActivationSnapshot({ ...input, authority: testAuthority("other") }), /workflow/i);
  assert.throws(() => buildActivationSnapshot({ ...input, authority: testAuthority("debug", []) }), /node coverage/i);
});

test("curator topology accepts the exact frozen static plus fixed I/O context boundary and rejects one token less", () => {
  const build = (contextWindow: number) => {
    const base = fixture();
    const node = authorityNode();
    (node.capabilities.effective as any).knowledge = ["curate", "propose"];
    node.tools = ["knowledge_propose"];
    const authority = testAuthority("debug", [node]);
    const boundaryModels = {
      defaultModel: "provider/model", defaultThinking: "off",
      find: (id: string) => id === "provider/model" ? { id, contextWindow, maxTokens: 8_192, thinking: ["off"] } : undefined,
      canActivate: () => true,
      estimateTokens: () => 0,
    };
    return buildActivationSnapshot({ ...base, authority, models: boundaryModels, packageVersion: "0.1.0" });
  };
  const exact = build(204_800);
  assert.equal(exact.payload.models[0].contextWindow, 204_800);
  assert.equal(exact.payload.models[0].staticTokens + exact.payload.models[0].dynamicReserve + (exact.payload.models[0].outputReserve ?? 0), 204_800);
  assert.throws(() => build(204_799), /curator|context|input|output|static|preflight/i);
});

test("activation freezes a model-adaptive dynamic page for a 272K inherited model", () => {
  const base = fixture();
  const adaptiveModels = {
    defaultModel: "provider/model", defaultThinking: "off",
    find: (id: string) => id === "provider/model" ? { id, contextWindow: 272_000, maxTokens: 128_000, thinking: ["off"] } : undefined,
    canActivate: () => true,
    estimateTokens: (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 4),
  };
  const snapshot = buildActivationSnapshot({ ...base, authority: testAuthority(), models: adaptiveModels, packageVersion: "0.1.0" });
  const model = snapshot.payload.models[0];
  assert.equal(model.outputReserve, 54_400);
  assert.ok(model.dynamicReserve < 266_240);
  assert.equal(model.staticTokens + model.dynamicReserve + (model.outputReserve ?? 0), model.contextWindow);
});

test("snapshot model preflight consumes frozen authority instead of re-resolving mutable source defaults", () => {
  const base = fixture();
  const authority = testAuthority();
  (base.workflow.team.nodes[0] as any).model = "provider/changed-after-resolution";
  (base.catalogs.agents[0] as any).frontmatter.model = "provider/also-changed";
  const snapshot = buildActivationSnapshot({ ...base, authority, models, packageVersion: "0.1.0" });
  assert.equal(snapshot.payload.authority.nodes[0].model, "provider/model");
  assert.equal(snapshot.payload.models[0].modelId, "provider/model");
});

test("builder identity is invariant to unordered catalog, registry, and skill enumeration", () => {
  const base = fixture();
  const authority = testAuthority();
  const input = { ...base, authority, models, packageVersion: "0.1.0", createdAt: "2026-01-01T00:00:00.000Z" };
  const first = buildActivationSnapshot(input);
  base.catalogs.agents.reverse();
  base.catalogs.skills.reverse();
  base.catalogs.knowledge.reverse();
  base.project.registries.agents.reverse();
  base.project.registries.skills.reverse();
  base.project.registries.knowledge.reverse();
  base.project.registries.workflows.reverse();
  (base.catalogs.skills[0] as any).files.reverse();
  assert.equal(buildActivationSnapshot(input).snapshotHash, first.snapshotHash);
});

test("prompt, team, capability, adapter, and config source changes alter identity", () => {
  const build = (mutate: (value: ReturnType<typeof fixture>, authority: any) => void) => {
    const value = fixture();
    const authority = authorityNode();
    mutate(value, authority);
    return buildActivationSnapshot({ ...value, authority: testAuthority("debug", [authority]), models, packageVersion: "0.1.0", createdAt: "2026-01-01T00:00:00.000Z" }).snapshotHash;
  };
  const base = build(() => undefined);
  assert.notEqual(build((value) => { (value.catalogs.agents[0] as any).prompt = "Changed prompt"; }), base);
  assert.notEqual(build((value) => { (value.workflow.team.nodes[0] as any).responsibilities = ["Changed team role"]; }), base);
  assert.notEqual(build((_value, authority) => { authority.capabilities.effective.shell = ["inspect"]; }), base);
  assert.notEqual(build((value) => { (value.workflow.artifact as any).options = { mode: "strict" }; }), base);
  assert.notEqual(build((value) => { value.project.rawSource = "changed manifest\n"; }), base);
});

test("snapshot identity consumes the exact resolver-issued effective authority", () => {
  const resolve = (narrow: boolean) => {
    const base = fixture();
    (base.catalogs.agents[0] as any).frontmatter.capabilities = { shell: ["inspect"] };
    if (narrow) (base.workflow.team.nodes[0] as any).capabilities = {};
    const result = resolveWorkflowCapabilities({ workflowId: base.workflow.id, team: base.workflow.team, catalogs: base.catalogs, artifactAvailable: false, knowledgeAvailable: false, questionsAvailable: false });
    assert.equal(result.ok, true);
    assert.ok(result.authority);
    (base.workflow as any).authority = result.authority;
    (base.workflow as any).policies = result.policies;
    return { base, authority: result.authority! };
  };
  const full = resolve(false);
  const narrow = resolve(true);
  const fullSnapshot = buildActivationSnapshot({ ...full.base, authority: full.authority, models, packageVersion: "0.1.0" });
  const narrowSnapshot = buildActivationSnapshot({ ...narrow.base, authority: narrow.authority, models, packageVersion: "0.1.0" });
  assert.notDeepEqual(fullSnapshot.payload.authority, narrowSnapshot.payload.authority);
  assert.notEqual(fullSnapshot.snapshotHash, narrowSnapshot.snapshotHash);
  assert.throws(() => buildActivationSnapshot({ ...full.base, authority: narrow.authority, models, packageVersion: "0.1.0" }), /exact resolved workflow authority/i);
});

test("capability resolution rejects N+1 normalized knowledge attachments before authority issuance", () => {
  const resolve = (count: number) => {
    const base = fixture();
    (base.workflow.team.nodes[0] as any).knowledge.resolved = Array.from({ length: count }, (_, index) => `bundle-${String(index).padStart(3, "0")}`);
    return resolveWorkflowCapabilities({
      workflowId: base.workflow.id, team: base.workflow.team, catalogs: base.catalogs,
      artifactAvailable: false, knowledgeAvailable: true, questionsAvailable: false,
    });
  };
  assert.equal(resolve(128).ok, true);
  let overflow: ReturnType<typeof resolve> | undefined;
  assert.doesNotThrow(() => { overflow = resolve(129); });
  assert.equal(overflow?.ok, false);
  assert.equal(overflow?.authority, undefined);
  assert.deepEqual(overflow?.issues.map((entry) => [entry.nodeId, entry.issue.group]), [["root", "knowledge"]]);
});

test("configured human-input authority enables questions and survives snapshot persistence", () => {
  const copied = copyWorkflowFixture("artifact-free-debug");
  try {
    const project = loadConfigProject(copied.projectRoot);
    assert.equal(project.status, "configured");
    if (project.status !== "configured") return;
    const catalogs = loadConfigCatalogs(project);
    const resolution = resolveConfigWorkflows(project, catalogs);
    const workflow = resolution.workflows[0];
    assert.equal(workflow.status, "valid");
    if (workflow.status !== "valid") return;
    const effective = workflow.authority.nodes[0].capabilities.effective as Readonly<Record<string, unknown>>;
    assert.equal(effective["human-input"], true);
    assert.equal(workflow.authority.nodes[0].tools.includes("human_question"), true);

    const activation = buildActivationSnapshot({ project, workflow, catalogs, authority: workflow.authority, models, packageVersion: "0.1.0" });
    writeActivationSnapshot(copied.projectRoot, activation);
    const restored = readActivationSnapshot(copied.projectRoot, activation.snapshotHash);
    assert.ok(restored);
    const restoredNode = restored.payload.authority.nodes[0] as { tools: readonly string[]; capabilities: { effective: Readonly<Record<string, unknown>> } };
    assert.equal(restoredNode.tools.includes("human_question"), true);
    assert.equal(restoredNode.capabilities.effective["human-input"], true);
  } finally { copied.cleanup(); }
});

test("resolver-produced activation snapshots round-trip through persistence with resolved team depths", () => {
  const base = fixture();
  const resolution = resolveWorkflowCapabilities({
    workflowId: base.workflow.id,
    team: base.workflow.team,
    catalogs: base.catalogs,
    artifactAvailable: false,
    knowledgeAvailable: false,
    questionsAvailable: false,
  });
  assert.equal(resolution.ok, true);
  assert.ok(resolution.authority);
  (base.workflow as any).authority = resolution.authority;
  (base.workflow as any).policies = resolution.policies;
  const snapshot = buildActivationSnapshot({ ...base, authority: resolution.authority!, models, packageVersion: "0.1.0" });
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-resolved-snapshot-"));
  writeActivationSnapshot(projectRoot, snapshot);
  assert.deepEqual(readActivationSnapshot(projectRoot, snapshot.snapshotHash), snapshot);
});

test("snapshot source provenance is derived from exact loaded registry associations", () => {
  const base = fixture();
  const input = { ...base, authority: testAuthority(), models, packageVersion: "0.1.0" };
  const snapshot = buildActivationSnapshot(input);
  assert.deepEqual(snapshot.payload.sources.map(({ path, kind, id }) => ({ path, kind, id })), [
    { path: ".pi/hive/agents/agent.md", kind: "agent", id: "agent" },
    { path: ".pi/hive/hive-config.yaml", kind: "manifest", id: "root" },
    { path: ".pi/hive/skills/skill/README.md", kind: "skill", id: "skill" },
    { path: ".pi/hive/workflows/debug.yaml", kind: "workflow", id: "debug" },
  ]);
  const skillSource = snapshot.payload.sources.find((source) => source.kind === "skill")!;
  assert.equal(skillSource.hash, "d".repeat(64));
  assert.equal(skillSource.canonicalHash, "d".repeat(64), "loaded skill files expose only their canonical catalog identity");
  (base.project.registries.workflows[0] as any).projectPath = ".pi/hive/workflows/other.yaml";
  assert.throws(() => buildActivationSnapshot(input), /workflow.*source|source.*workflow/i);
});

test("literal inherit walks node, agent, and project precedence before adapter defaults", () => {
  const base = fixture();
  (base.workflow.team.nodes[0] as any).model = "inherit";
  (base.workflow.team.nodes[0] as any).thinking = "inherit";
  (base.catalogs.agents[0] as any).frontmatter.model = "inherit";
  (base.catalogs.agents[0] as any).frontmatter.thinking = "inherit";
  (base.project.manifest as any).settings = { defaults: { agent: { model: "provider/project", thinking: "low" } } };
  const inheritedModels = {
    ...models,
    defaultModel: "provider/adapter",
    defaultThinking: "off",
    find: (id: string) => ({ id, contextWindow: 1_000_000, maxTokens: 8_000, thinking: ["off", "low"] }),
  };
  const snapshot = buildActivationSnapshot({ ...base, authority: testAuthority("debug", [authorityNode("root", "provider/project", "low")]), models: inheritedModels, packageVersion: "0.1.0" });
  assert.equal(snapshot.payload.models[0].modelId, "provider/project");
  assert.equal(snapshot.payload.models[0].thinking, "low");
});

test("builder recursively freezes mutable children beneath shallow-frozen inputs", () => {
  const base = fixture();
  const options = { nested: { enabled: true } };
  (base.workflow.artifact as any).options = Object.freeze(options);
  const snapshot = buildActivationSnapshot({ ...base, authority: testAuthority(), models, packageVersion: "0.1.0" });
  const storedOptions = (snapshot.payload.workflow.artifact as any).options;
  assert.equal(Object.isFrozen(storedOptions), true);
  assert.equal(Object.isFrozen(storedOptions.nested), true);
});

test("live knowledge fingerprint and creation time do not affect identity while frozen content does", () => {
  const base = fixture();
  const authority = testAuthority();
  const input = { ...base, authority, models, packageVersion: "0.1.0", createdAt: "2026-01-01T00:00:00.000Z" };
  const first = buildActivationSnapshot(input);
  (base.catalogs.knowledge[0] as any).fingerprint = "9".repeat(64);
  assert.equal(buildActivationSnapshot(input).snapshotHash, first.snapshotHash);
  (base.catalogs.skills[0] as any).files[0].content = "Changed";
  assert.notEqual(buildActivationSnapshot(input).snapshotHash, first.snapshotHash);
});

test("snapshot summary is bounded and content-free", () => {
  const base = fixture();
  (base.catalogs.agents[0] as any).prompt = "TOP-SECRET-PROMPT";
  const snapshot = buildActivationSnapshot({ ...base, authority: testAuthority(), models, packageVersion: "0.1.0", createdAt: "2026-01-01T00:00:00.000Z" });
  const hostile = structuredClone(snapshot) as any;
  hostile.payload.workflow.id = `TOP-SECRET-${"x".repeat(300_000)}`;
  hostile.payload.versions.package = `PRIVATE-${"y".repeat(300_000)}`;
  const summary = buildActivationSummary(hostile, { state: "stale", resumable: true, codes: [`SECRET-CODE-${"z".repeat(300_000)}`] });
  const encoded = JSON.stringify(summary);
  assert.equal(encoded.includes("TOP-SECRET"), false);
  assert.equal(encoded.includes("PRIVATE"), false);
  assert.equal(encoded.includes("SECRET-CODE"), false);
  assert.ok(Buffer.byteLength(encoded) <= 262_144);
  assert.equal(summary.truncated, true);

  const useful = buildActivationSummary(snapshot, { state: "current", resumable: true, codes: [] });
  assert.equal(useful.workflowName, "Debug");
  assert.deepEqual(useful.artifact, { adapter: "none", profile: "default" });
  assert.deepEqual(useful.modelIds, ["provider/model"]);
  const manyModels = structuredClone(snapshot) as any;
  manyModels.payload.models = Array.from({ length: 4_096 }, (_, index) => ({ ...manyModels.payload.models[0], nodeId: `node-${index}`, modelId: `provider/${String(index).padStart(4, "0")}-${"m".repeat(240)}` }));
  const manyModelsSummary = buildActivationSummary(manyModels, { state: "current", resumable: true, codes: [] });
  assert.ok(Buffer.byteLength(JSON.stringify(manyModelsSummary)) <= 262_144);
  assert.equal(manyModelsSummary.truncated, true);

  const manyCodes = Array.from({ length: 5_000 }, (_, index) => `CODE_${index}`);
  const boundedCodes = new Proxy(manyCodes, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property) && Number(property) > 4_096) throw new Error("processed beyond raw compatibility bound");
      return Reflect.get(target, property, receiver);
    },
  });
  assert.doesNotThrow(() => buildActivationSummary(snapshot, { state: "current", resumable: true, codes: boundedCodes }));
});
