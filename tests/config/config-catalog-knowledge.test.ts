import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildActivationSnapshot, CONFIG_CATALOG_LIMITS, loadAgentCatalog, loadConfigCatalogs, loadConfigProject, loadKnowledgeCatalog, resolveConfigWorkflows, type ConfiguredProject, type KnowledgeLoadOperations } from "../../src/config/index.ts";
import { readActivationSnapshot, writeActivationSnapshot } from "../../src/config/snapshot-store.ts";
import { KnowledgeProviderRegistry } from "../../src/knowledge/provider.ts";
import { attachedKnowledgeBundleIds, createKnowledgeReferenceAuthorizer } from "../../src/knowledge/attachments.ts";
import { KnowledgeService } from "../../src/knowledge/search.ts";
import { DelegationRuntime } from "../../src/workflows/delegation.ts";
import { genericWorkflowToolContractsForNode } from "../../src/workflows/tools.ts";

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

test("production catalog loading validates complete OKF content and quarantines malformed bundles", () => {
  const configured = project("  shared: {provider: okf, path: knowledge/shared/}\n", (root) => {
    write(join(root, ".pi/hive/knowledge/shared/bad.md"), "---\ntitle: Missing type\n---\nbody\n");
  });
  const node = loadConfigCatalogs(configured).knowledge[0];
  assert.equal(node.status, "failed");
  assert.equal(node.diagnosticCodes.includes("KNOWLEDGE_BUNDLE_INVALID"), true);
});

test("production catalog validation dispatches through the provider registry", () => {
  const configured = project("  shared: {provider: okf, path: knowledge/shared/}\n");
  const providers = new KnowledgeProviderRegistry();
  let calls = 0;
  providers.register({
    id: "okf", version: "test-provider-v1",
    load(request) {
      calls++;
      return {
        ok: true, diagnostics: [], bundle: {
          id: request.declaration.id, providerId: "okf", updatePolicy: request.declaration.updatePolicy,
          canonicalRoot: ".", documents: [], summary: "registry", contentHash: "a".repeat(64), totalBytes: 0, diagnostics: [],
        },
      };
    },
  });
  const result = loadConfigCatalogs(configured, { knowledgeProviders: providers });
  assert.equal(calls, 1);
  const shared = result.knowledge.find((entry) => entry.id === "shared");
  assert.equal(shared?.status, "available");
  if (shared?.status === "available") assert.equal(shared.fingerprint, "a".repeat(64));
});

test("knowledge bytes share the catalog aggregate budget and reject before a further content read", () => {
  const configured = project("  shared: {provider: okf, path: knowledge/shared/}\n", (root) => {
    write(join(root, ".pi/hive/knowledge/shared/doc.md"), "---\ntype: Reference\ntitle: Document\n---\n\ncontent\n");
  });
  const oversizedAgentRead = new Uint8Array(CONFIG_CATALOG_LIMITS.aggregateContentBytes);
  const result = loadConfigCatalogs(configured, { agents: { readFile: () => oversizedAgentRead } });
  assert.equal(result.knowledge.find((entry) => entry.id === "shared")?.status, "failed", "knowledge cannot spend a second aggregate budget");

  const providers = new KnowledgeProviderRegistry();
  let attemptedRead = false;
  providers.register({
    id: "okf", version: "budget-probe-v1",
    load(request) {
      try {
        request.reserveContentBytes?.(1);
        attemptedRead = true;
      } catch {
        return { ok: false, diagnostics: [{ code: "BUDGET", severity: "error", message: "bounded", bundleId: request.declaration.id }] };
      }
      return { ok: false, diagnostics: [{ code: "UNEXPECTED", severity: "error", message: "bounded", bundleId: request.declaration.id }] };
    },
  });
  loadConfigCatalogs(configured, { agents: { readFile: () => oversizedAgentRead }, knowledgeProviders: providers });
  assert.equal(attemptedRead, false, "the shared reservation must fail before provider content reads");
});

test("agent-owned knowledge is attached independently of defaults and enables read tools", () => {
  const root = temp();
  write(join(root, ".pi/hive/agents/worker.md"), "---\nname: Worker\ncapabilities:\n  knowledge: [read]\n---\nwork\n");
  write(join(root, ".pi/hive/knowledge/owned/tactics.md"), "---\ntype: Reference\ntitle: Tactics\n---\n\nFacts.\n");
  write(join(root, ".pi/hive/workflows/chat.yaml"), "name: Chat\ndescription: Chat\nuse-when: Chat\nartifact: {adapter: none, profile: default, binding: none}\ninstructions: {root: Chat}\nteam: {id: root, agent: worker}\n");
  write(join(root, ".pi/hive/hive-config.yaml"), "schema-version: 1\nagents: {worker: agents/worker.md}\nworkflows: {chat: workflows/chat.yaml}\nknowledge:\n  owned: {provider: okf, path: knowledge/owned/, owner: worker}\n");
  const configured = loadConfigProject(root); assert.equal(configured.status, "configured");
  if (configured.status !== "configured") return;
  const catalogs = loadConfigCatalogs(configured);
  const workflow = resolveConfigWorkflows(configured, catalogs).workflows[0];
  assert.equal(workflow.status, "valid");
  if (workflow.status !== "valid") return;
  assert.deepEqual(workflow.team.nodes[0].knowledge.resolved, ["owned"]);
  assert.deepEqual((workflow.authority.nodes[0].capabilities as any).attachments.knowledge, ["owned"]);
  assert.equal(workflow.authority.nodes[0].tools.includes("knowledge_search"), true);
  assert.equal(workflow.authority.nodes[0].tools.includes("knowledge_read"), true);
});

test("resolver, snapshot, and generic registration keep propose-only authority unadvertised until W23", () => {
  const root = temp();
  write(join(root, ".pi/hive/agents/proposer.md"), "---\nname: Proposer\nmodel: provider/model\ncapabilities:\n  knowledge: [propose]\nknowledge: [shared]\n---\npropose\n");
  write(join(root, ".pi/hive/agents/reader.md"), "---\nname: Reader\nmodel: provider/model\ncapabilities:\n  knowledge: [read, propose]\nknowledge: [shared]\n---\nread\n");
  write(join(root, ".pi/hive/knowledge/shared/doc.md"), "---\ntype: Reference\ntitle: Shared\n---\n\nShared facts.\n");
  write(join(root, ".pi/hive/workflows/chat.yaml"), "name: Chat\ndescription: Chat\nuse-when: Chat\nartifact: {adapter: none, profile: default, binding: none}\ninstructions: {root: Chat}\nteam:\n  id: root\n  agent: proposer\n  members:\n    - id: reader\n      agent: reader\n");
  write(join(root, ".pi/hive/hive-config.yaml"), "schema-version: 1\nagents: {proposer: agents/proposer.md, reader: agents/reader.md}\nworkflows: {chat: workflows/chat.yaml}\nknowledge:\n  shared: {provider: okf, path: knowledge/shared/}\n");
  const configured = loadConfigProject(root);
  assert.equal(configured.status, "configured");
  if (configured.status !== "configured") return;
  const catalogs = loadConfigCatalogs(configured);
  const workflow = resolveConfigWorkflows(configured, catalogs).workflows[0];
  assert.equal(workflow.status, "valid", workflow.status === "invalid" ? JSON.stringify(workflow.diagnostics) : undefined);
  if (workflow.status !== "valid") return;
  const knowledgeTools = (nodeId: string) => workflow.authority.nodes.find((node) => node.nodeId === nodeId)?.tools.filter((name) => name.startsWith("knowledge_"));
  assert.deepEqual(knowledgeTools("root"), [], "propose-only frozen authority advertises no W22 knowledge tool");
  assert.deepEqual(knowledgeTools("reader"), ["knowledge_read", "knowledge_search"], "read remains effective while propose has no W22 tool");

  const models = {
    defaultModel: "provider/model", defaultThinking: "off",
    find: (id: string) => id === "provider/model" ? { id, contextWindow: 1_000_000, maxTokens: 8_000, thinking: ["off"] } : undefined,
    canActivate: () => true, estimateTokens: (text: string) => Buffer.byteLength(text),
  };
  const activation = buildActivationSnapshot({ project: configured, catalogs, workflow, authority: workflow.authority, models, packageVersion: "0.1.0" });
  const frozenKnowledgeTools = (nodeId: string) => (activation.payload.authority.nodes.find((node) => node.nodeId === nodeId) as { tools: string[] } | undefined)?.tools.filter((name) => name.startsWith("knowledge_"));
  assert.deepEqual(frozenKnowledgeTools("root"), []);
  assert.deepEqual(frozenKnowledgeTools("reader"), ["knowledge_read", "knowledge_search"]);
  assert.deepEqual(genericWorkflowToolContractsForNode(activation, "root").filter((tool) => tool.name.startsWith("knowledge_")).map((tool) => tool.name), []);
  assert.deepEqual(genericWorkflowToolContractsForNode(activation, "reader").filter((tool) => tool.name.startsWith("knowledge_")).map((tool) => tool.name), ["knowledge_search", "knowledge_read"]);
  assert.equal(JSON.stringify(activation.payload.authority).includes("knowledge_propose"), false);
});

test("resolver, snapshot builder, and persistence accept a catalog-valid foreign knowledge owner", () => {
  const root = temp();
  write(join(root, ".pi/hive/agents/worker.md"), "---\nname: Worker\nmodel: provider/model\ncapabilities:\n  knowledge: [read]\nknowledge: [foreign]\n---\nwork\n");
  write(join(root, ".pi/hive/agents/owner.md"), "---\nname: Owner\ncapabilities: {}\n---\nowner\n");
  write(join(root, ".pi/hive/knowledge/foreign/doc.md"), "---\ntype: Reference\ntitle: Foreign\n---\n\nForeign facts.\n");
  write(join(root, ".pi/hive/workflows/chat.yaml"), "name: Chat\ndescription: Chat\nuse-when: Chat\nartifact: {adapter: none, profile: default, binding: none}\ninstructions: {root: Chat}\nteam: {id: root, agent: worker}\n");
  write(join(root, ".pi/hive/hive-config.yaml"), "schema-version: 1\nagents: {worker: agents/worker.md, owner: agents/owner.md}\nworkflows: {chat: workflows/chat.yaml}\nknowledge:\n  foreign: {provider: okf, path: knowledge/foreign/, owner: owner}\n");

  const configured = loadConfigProject(root);
  assert.equal(configured.status, "configured");
  if (configured.status !== "configured") return;
  const catalogs = loadConfigCatalogs(configured);
  const workflow = resolveConfigWorkflows(configured, catalogs).workflows[0];
  assert.equal(workflow.status, "valid", workflow.status === "invalid" ? JSON.stringify(workflow.diagnostics) : undefined);
  if (workflow.status !== "valid") return;
  assert.deepEqual(workflow.team.nodes.map((node) => node.agentId), ["worker"]);
  assert.deepEqual(workflow.team.nodes[0].knowledge.resolved, ["foreign"]);
  const models = {
    defaultModel: "provider/model", defaultThinking: "off",
    find: (id: string) => id === "provider/model" ? { id, contextWindow: 1_000_000, maxTokens: 8_000, thinking: ["off"] } : undefined,
    canActivate: () => true, estimateTokens: (text: string) => Buffer.byteLength(text),
  };
  const activation = buildActivationSnapshot({ project: configured, catalogs, workflow, authority: workflow.authority, models, packageVersion: "0.1.0" });
  assert.deepEqual(activation.payload.agents.map((agent) => agent.id), ["worker"]);
  assert.equal(activation.payload.knowledge[0].owner, "owner");
  writeActivationSnapshot(root, activation);
  assert.deepEqual(readActivationSnapshot(root, activation.snapshotHash), activation);
});

test("resolver-to-snapshot preserves default/add/remove/own attachment semantics and rejects failed bundles", () => {
  const root = temp();
  write(join(root, ".pi/hive/agents/worker.md"), "---\nname: Worker\nmodel: provider/model\ncapabilities:\n  knowledge: [read]\nknowledge: [default]\n---\nwork\n");
  for (const id of ["default", "added", "owned"]) write(join(root, `.pi/hive/knowledge/${id}/doc.md`), `---\ntype: Reference\ntitle: ${id}\n---\n\n${id} facts.\n`);
  write(join(root, ".pi/hive/workflows/chat.yaml"), "name: Chat\ndescription: Chat\nuse-when: Chat\nartifact: {adapter: none, profile: default, binding: none}\ninstructions: {root: Chat}\nteam:\n  id: root\n  agent: worker\n  members:\n    - id: overlay\n      agent: worker\n      overrides:\n        knowledge:\n          add: [added]\n          remove: [default]\n");
  write(join(root, ".pi/hive/hive-config.yaml"), "schema-version: 1\nagents: {worker: agents/worker.md}\nworkflows: {chat: workflows/chat.yaml}\nknowledge:\n  default: {provider: okf, path: knowledge/default/}\n  added: {provider: okf, path: knowledge/added/}\n  owned: {provider: okf, path: knowledge/owned/, owner: worker}\n");
  const configured = loadConfigProject(root); assert.equal(configured.status, "configured");
  if (configured.status !== "configured") return;
  const catalogs = loadConfigCatalogs(configured);
  const workflow = resolveConfigWorkflows(configured, catalogs).workflows[0];
  assert.equal(workflow.status, "valid", workflow.status === "invalid" ? JSON.stringify(workflow.diagnostics) : undefined);
  if (workflow.status !== "valid") return;
  assert.deepEqual(workflow.team.nodes.find((entry) => entry.id === "root")?.knowledge.resolved, ["default", "owned"]);
  assert.deepEqual(workflow.team.nodes.find((entry) => entry.id === "overlay")?.knowledge.resolved, ["added", "owned"]);
  const models = {
    defaultModel: "provider/model", defaultThinking: "off",
    find: (id: string) => id === "provider/model" ? { id, contextWindow: 1_000_000, maxTokens: 8_000, thinking: ["off"] } : undefined,
    canActivate: () => true, estimateTokens: (text: string) => Buffer.byteLength(text),
  };
  const snapshot = buildActivationSnapshot({ project: configured, catalogs, workflow, authority: workflow.authority, models, packageVersion: "0.1.0" });
  assert.deepEqual(attachedKnowledgeBundleIds(snapshot, "root"), ["default", "owned"]);
  assert.deepEqual(attachedKnowledgeBundleIds(snapshot, "overlay"), ["added", "owned"]);
  assert.deepEqual(Object.fromEntries(snapshot.payload.authority.nodes.map((entry) => [entry.nodeId, (entry.capabilities as any).attachments.knowledge])), {
    root: ["default", "owned"], overlay: ["added", "owned"],
  });

  const service = new KnowledgeService({ projectRoot: root, projectId: snapshot.payload.project.projectId, sessionId: "session-matrix", runId: "run-matrix", snapshot });
  for (const [nodeId, bundleId] of [["root", "default"], ["root", "owned"], ["overlay", "added"], ["overlay", "owned"]] as const) {
    const page = service.read(nodeId, { bundleId, documentId: "doc" });
    assert.match(page.content, new RegExp(`${bundleId} facts\\.`));
    assert.match(page.contentHash, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(page.returnedContentHash, `sha256:${createHash("sha256").update(page.content, "utf8").digest("hex")}`);
    assert.equal(service.search(nodeId, { query: bundleId, bundleIds: [bundleId] }).items[0]?.bundleId, bundleId);
  }
  const denialMessages = [
    assert.throws(() => service.read("root", { bundleId: "added", documentId: "doc" })),
    assert.throws(() => service.read("overlay", { bundleId: "default", documentId: "doc" })),
  ].map((error) => String(error));
  assert.equal(denialMessages[0], denialMessages[1], "removed/default cross-node denials are identity-independent");
  assert.equal(denialMessages.join(" ").includes("facts"), false, "service denials remain content-free");

  const runtime = new DelegationRuntime({
    projectRoot: root, projectId: snapshot.payload.project.projectId, sessionId: "session-matrix", runId: "run-matrix", snapshot,
    createTaskId: () => "task-matrix", referenceAuthorizer: createKnowledgeReferenceAuthorizer(snapshot, service),
  });
  const accepted = runtime.accept(runtime.rootExecutionContext(), {
    targetNodeId: "overlay", objective: "Check resolved attachments", deliverables: ["refs"],
    contextRefs: [{ kind: "knowledge", id: "added/doc" }, { kind: "knowledge", id: "default/doc" }],
  });
  assert.deepEqual(runtime.restore().tasks[accepted.taskId].contextRefs.map((entry) => entry.authorization), ["authorized", "denied"]);
  runtime.start(accepted.taskId, "attempt-matrix");
  runtime.recordResult(accepted.taskId, {
    status: "completed", summary: "done",
    outputRefs: [{ kind: "knowledge", id: "default/doc" }, { kind: "knowledge", id: "added/doc" }],
  });
  const matrixTask = runtime.restore().tasks[accepted.taskId];
  assert.deepEqual(matrixTask.result?.outputRefs.map((entry) => entry.authorization), ["authorized", "denied"]);
  const deniedContext = matrixTask.contextRefs[1];
  const deniedOutput = matrixTask.result?.outputRefs[1];
  if (deniedContext.authorization === "denied" && deniedOutput?.authorization === "denied") assert.equal(deniedContext.diagnostic, deniedOutput.diagnostic);
  assert.equal(JSON.stringify({ deniedContext, deniedOutput }).includes("facts"), false, "recipient denials remain content-free");

  write(join(root, ".pi/hive/knowledge/added/doc.md"), "---\ntitle: invalid\n---\nbody\n");
  const failedCatalogs = loadConfigCatalogs(configured);
  assert.equal(failedCatalogs.knowledge.find((entry) => entry.id === "added")?.status, "failed");
  const failedWorkflow = resolveConfigWorkflows(configured, failedCatalogs).workflows[0];
  assert.equal(failedWorkflow.status, "invalid");
  assert.equal(failedWorkflow.diagnosticCodes.includes("WORKFLOW_ATTACHMENT_FAILED"), true);
});

test("final knowledge attachments accept N and quarantine N+1 across defaults, additions, and owned bundles", () => {
  const resolve = (ownedCount: number) => {
    const root = temp();
    const defaults = Array.from({ length: 126 }, (_, index) => `default-${String(index).padStart(3, "0")}`);
    const owned = Array.from({ length: ownedCount }, (_, index) => `owned-${String(index).padStart(3, "0")}`);
    const ids = [...defaults, "added", ...owned];
    write(join(root, ".pi/hive/agents/worker.md"), `---\nname: Worker\ncapabilities:\n  knowledge: [read]\nknowledge: [${defaults.join(", ")}]\n---\nwork\n`);
    for (const id of ids) write(join(root, `.pi/hive/knowledge/${id}/doc.md`), `---\ntype: Reference\ntitle: ${id}\n---\n\n${id}\n`);
    write(join(root, ".pi/hive/workflows/chat.yaml"), "name: Chat\ndescription: Chat\nuse-when: Chat\nartifact: {adapter: none, profile: default, binding: none}\ninstructions: {root: Chat}\nteam:\n  id: root\n  agent: worker\n  overrides:\n    knowledge:\n      add: [added]\n");
    write(join(root, ".pi/hive/hive-config.yaml"), `schema-version: 1\nagents: {worker: agents/worker.md}\nworkflows: {chat: workflows/chat.yaml}\nknowledge:\n${ids.map((id) => `  ${id}: {provider: okf, path: knowledge/${id}/${owned.includes(id) ? ", owner: worker" : ""}}`).join("\n")}\n`);
    const configured = loadConfigProject(root);
    assert.equal(configured.status, "configured");
    if (configured.status !== "configured") throw new Error("fixture configuration failed");
    return resolveConfigWorkflows(configured, loadConfigCatalogs(configured)).workflows[0];
  };

  const exact = resolve(1);
  assert.equal(exact.status, "valid", exact.status === "invalid" ? JSON.stringify(exact.diagnostics) : undefined);
  if (exact.status === "valid") assert.equal(exact.team.nodes[0].knowledge.resolved.length, 128);

  const overflow = resolve(2);
  assert.equal(overflow.status, "invalid");
  assert.equal(overflow.diagnosticCodes.includes("WORKFLOW_ATTACHMENT_LIMIT_EXCEEDED"), true);
  assert.ok(overflow.diagnostics.length <= 100);
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
