import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildWorkflowSelectorSummary, loadConfigCatalogs, loadConfigProject, loadWorkflowResources, parseConfigYaml, resolveConfigWorkflows, WORKFLOW_LIMITS, type WorkflowDefinition } from "../../src/config/index.ts";
import { copyWorkflowFixture } from "../helpers/workflow-fixtures.ts";

function resolveFixture(name: string) {
  const fixture = copyWorkflowFixture(name);
  const project = loadConfigProject(fixture.projectRoot);
  assert.equal(project.status, "configured");
  const catalogs = loadConfigCatalogs(project);
  return { fixture, result: resolveConfigWorkflows(project, catalogs) };
}

test("implemented none and OpenSpec profiles activate for artifact-free, combined, and split configurations", () => {
  for (const [name, ids] of [["artifact-free-debug", ["debug-chat"]], ["combined-delivery", ["feature-delivery"]], ["split-plan-build", ["feature-build", "feature-plan"]]] as const) {
    const { fixture, result } = resolveFixture(name);
    try {
      assert.deepEqual(result.workflows.map((x) => x.id), ids);
      assert.equal(result.workflows.every((x) => x.status === "valid"), true);
      assert.deepEqual(result.summary.items.map((x) => x.id), ids);
      assert.equal(JSON.stringify(result.summary).includes("instructions"), false);
    } finally { fixture.cleanup(); }
  }
});

test("activation reachability checks mandatory completion actions but not optional inspect/read actions", () => {
  const optional = copyWorkflowFixture("combined-delivery");
  try {
    for (const relative of [".pi/hive/agents/orchestrator.md", ".pi/hive/agents/tester.md"]) {
      const path = join(optional.projectRoot, relative);
      writeFileSync(path, readFileSync(path, "utf8").replace("artifact: [read, write, review]", "artifact: [read, write]").replace("artifact: [read, review]", "artifact: [read]"));
    }
    const project = loadConfigProject(optional.projectRoot); assert.equal(project.status, "configured");
    const result = resolveConfigWorkflows(project, loadConfigCatalogs(project));
    assert.equal(result.workflows[0].status, "valid", "optional review inspection capability is not an activation prerequisite");
  } finally { optional.cleanup(); }

  const mandatory = copyWorkflowFixture("combined-delivery");
  try {
    for (const relative of [".pi/hive/agents/orchestrator.md", ".pi/hive/agents/planner.md", ".pi/hive/agents/coder.md", ".pi/hive/agents/tester.md"]) {
      const path = join(mandatory.projectRoot, relative);
      writeFileSync(path, readFileSync(path, "utf8").replace("artifact: [read, write, review]", "artifact: [read]").replace("artifact: [read, write]", "artifact: [read]").replace("artifact: [read, review]", "artifact: [read]"));
    }
    const project = loadConfigProject(mandatory.projectRoot); assert.equal(project.status, "configured");
    const result = resolveConfigWorkflows(project, loadConfigCatalogs(project));
    assert.equal(result.workflows[0].status, "invalid");
    assert.ok(result.workflows[0].diagnosticCodes.includes("ARTIFACT_ACTION_UNREACHABLE"));
  } finally { mandatory.cleanup(); }
});

test("implemented Markdown profiles activate with exact options and reachable mandatory actions", () => {
  const fixture = copyWorkflowFixture("artifact-free-debug");
  try {
    const path = join(fixture.projectRoot, ".pi/hive/workflows/debug-chat.yaml");
    const source = readFileSync(path, "utf8")
      .replace("  adapter: none\n  profile: default\n  binding: none\n  options: {}", "  adapter: markdown-plan\n  profile: author\n  binding: new\n  options: { root: docs/plans }")
      .replace("\nteam:\n", "\napprovals:\n  plan: required\n\nteam:\n");
    writeFileSync(path, source);
    const agentPath = join(fixture.projectRoot, ".pi/hive/agents/debugger.md");
    writeFileSync(agentPath, readFileSync(agentPath, "utf8").replace("  human-input: true", "  human-input: true\n  artifact: [read, write]"));
    const project = loadConfigProject(fixture.projectRoot); assert.equal(project.status, "configured");
    const result = resolveConfigWorkflows(project, loadConfigCatalogs(project));
    assert.equal(result.workflows[0].status, "valid");
    assert.equal(result.workflows[0].diagnosticCodes.includes("ARTIFACT_ADAPTER_UNAVAILABLE"), false);
  } finally { fixture.cleanup(); }
});

test("recursive teams preserve preorder, repeated agents, and unique node IDs for an activatable profile", () => {
  const fixture = copyWorkflowFixture("split-plan-build");
  try {
    const path = join(fixture.projectRoot, ".pi/hive/workflows/feature-build.yaml");
    const source = readFileSync(path, "utf8")
      .replace("  adapter: openspec\n  profile: execute\n  binding: existing", "  adapter: none\n  profile: default\n  binding: none")
      .replace("\napprovals:\n  tasks: required\n  implementation: required\n", "\n");
    writeFileSync(path, source);
    const project = loadConfigProject(fixture.projectRoot); assert.equal(project.status, "configured");
    const result = resolveConfigWorkflows(project, loadConfigCatalogs(project));
    const workflow = result.workflows.find((x) => x.id === "feature-build");
    assert.equal(workflow?.status, "valid");
    if (workflow?.status === "valid") assert.deepEqual(workflow.team.nodes.map((x) => x.id), ["root", "builder", "tester"]);
  } finally { fixture.cleanup(); }
});

test("workflow loader bounds descriptor reads and rejects invalid UTF-8, growth, and identity swaps", () => {
  const fixture = copyWorkflowFixture("artifact-free-debug");
  try {
    const project = loadConfigProject(fixture.projectRoot); assert.equal(project.status, "configured");
    const path = project.registries.workflows[0].canonicalPath!;
    const source = readFileSync(path);
    const run = (bytes: Uint8Array, after = { dev: 1, ino: 2 }, beforeSize = bytes.length) => {
      let cursor = 0, maximumRequest = 0, fstats = 0;
      const resources = loadWorkflowResources(project, {
        stat: () => ({ size: source.length, isFile: () => true }),
        open: () => 7,
        fstat: () => { const afterRead = fstats++ > 0; return { size: afterRead ? bytes.length : beforeSize, isFile: () => true, dev: 1, ino: afterRead ? after.ino : 2 }; },
        read: (_fd, buffer, offset, length) => { maximumRequest = Math.max(maximumRequest, length); const count = Math.min(length, bytes.length - cursor); buffer.set(bytes.subarray(cursor, cursor + count), offset); cursor += count; return count; },
        close: () => undefined,
      });
      return { resources, maximumRequest };
    };
    const valid = run(source);
    assert.equal(valid.resources[0].status, "loaded");
    assert.ok(valid.maximumRequest <= WORKFLOW_LIMITS.fileBytes + 1);
    for (const [bytes, after, beforeSize, code] of [[new Uint8Array([0xff]), { dev: 1, ino: 2 }, 1, "CATALOG_TEXT_INVALID_UTF8"], [new Uint8Array(WORKFLOW_LIMITS.fileBytes + 1), { dev: 1, ino: 2 }, source.length, "WORKFLOW_FILE_TOO_LARGE"], [source, { dev: 1, ino: 3 }, source.length, "WORKFLOW_READ_FAILED"]] as const) {
      const resource = run(bytes, after, beforeSize).resources[0];
      assert.equal(resource.status, "failed");
      if (resource.status === "failed") assert.ok(resource.diagnostics.some((diagnostic) => diagnostic.code === code));
    }
  } finally { fixture.cleanup(); }
});

test("workflow file byte limit accepts exact N and rejects N+1", () => {
  for (const delta of [0, 1]) {
    const fixture = copyWorkflowFixture("artifact-free-debug");
    try {
      const path = join(fixture.projectRoot, ".pi/hive/workflows/debug-chat.yaml");
      const source = readFileSync(path, "utf8");
      writeFileSync(path, `${source}${"#".repeat(WORKFLOW_LIMITS.fileBytes + delta - Buffer.byteLength(source) - 1)}\n`);
      const project = loadConfigProject(fixture.projectRoot); assert.equal(project.status, "configured");
      const resource = loadWorkflowResources(project)[0];
      assert.equal(resource.status, delta === 0 ? "loaded" : "failed");
      if (delta && resource.status === "failed") assert.equal(resource.diagnostics[0].code, "WORKFLOW_FILE_TOO_LARGE");
    } finally { fixture.cleanup(); }
  }
});

test("semantic failures quarantine only affected workflows and retain safe selector metadata with narrow ranges", () => {
  for (const [name, code] of [["invalid/duplicate-team-node-id", "TEAM_NODE_ID_DUPLICATE"], ["invalid/unknown-agent-id", "WORKFLOW_AGENT_UNKNOWN"], ["invalid/missing-checkpoint", "WORKFLOW_CHECKPOINT_MISSING"], ["invalid/unknown-checkpoint", "WORKFLOW_CHECKPOINT_UNKNOWN"], ["invalid/unknown-suggested-next-id", "WORKFLOW_SUGGESTED_NEXT_UNKNOWN"]] as const) {
    const { fixture, result } = resolveFixture(name);
    try {
      assert.equal(result.workflows.length, 1);
      assert.equal(result.workflows[0].status, "invalid");
      assert.ok(result.workflows[0].diagnosticCodes.includes(code), `${name}: ${result.workflows[0].diagnosticCodes}`);
      const source = readFileSync(join(fixture.projectRoot, ".pi/hive/workflows/debug-chat.yaml"), "utf8");
      const parsed = parseConfigYaml(source, ".pi/hive/workflows/debug-chat.yaml"); assert.ok(parsed.value);
      if (name === "invalid/unknown-suggested-next-id") assert.deepEqual(result.workflows[0].diagnostics.find((x) => x.code === code)?.range, parsed.value.sourceMap["/suggested-next/0"].value);
      if (name === "invalid/unknown-checkpoint") assert.deepEqual(result.workflows[0].diagnostics.find((x) => x.code === code)?.range, parsed.value.sourceMap["/approvals/deployment"].value);
      assert.equal(result.summary.items[0].name, "Debug Chat");
      const raw = parsed.value.data as { artifact: { adapter: string; profile: string } };
      assert.equal(result.summary.items[0].adapter, raw.artifact.adapter);
      assert.equal(result.summary.items[0].profile, raw.artifact.profile);
    } finally { fixture.cleanup(); }
  }
});

test("suggested-next self and mutual cycles are non-executable valid hints", () => {
  const fixture = copyWorkflowFixture("split-plan-build");
  try {
    const dir = join(fixture.projectRoot, ".pi/hive/workflows");
    const base = `name: A\ndescription: A workflow\nuse-when: Use A\nartifact: { adapter: none, profile: default, binding: none, options: {} }\nteam: { id: root, agent: planning-lead }\ninstructions: { root: Run A }\n`;
    writeFileSync(join(dir, "a.yaml"), `suggested-next: [b]\n${base}`);
    writeFileSync(join(dir, "b.yaml"), `suggested-next: [a]\n${base.replaceAll(" A", " B")}`);
    const manifest = join(fixture.projectRoot, ".pi/hive/hive-config.yaml");
    writeFileSync(manifest, `schema-version: 1\nagents:\n  planning-lead: agents/planning-lead.md\n  planner: agents/planner.md\n  coding-lead: agents/coding-lead.md\n  coder: agents/coder.md\n  tester: agents/tester.md\nworkflows:\n  a: workflows/a.yaml\n  b: workflows/b.yaml\nskills:\n  orchestration: skills/orchestration/\nknowledge:\n  project-architecture:\n    provider: okf\n    path: knowledge/project-architecture/\n    updates: reviewed\n`);
    const project = loadConfigProject(fixture.projectRoot); assert.equal(project.status, "configured");
    const result = resolveConfigWorkflows(project, loadConfigCatalogs(project));
    assert.equal(result.workflows.every((x) => x.status === "valid"), true);
    assert.equal(result.edges.some((edge) => edge.target === "workflow:a" || edge.target === "workflow:b"), false);
  } finally { fixture.cleanup(); }
});

test("persisted root model and thinking selection freezes only into the selected workflow authority", () => {
  const fixture = copyWorkflowFixture("artifact-free-debug");
  try {
    const project = loadConfigProject(fixture.projectRoot); assert.equal(project.status, "configured");
    const catalogs = loadConfigCatalogs(project);
    const selected = resolveConfigWorkflows(project, catalogs, {}, { workflowId: "debug-chat", model: "provider/session", thinking: "high" });
    assert.equal(selected.workflows[0].status, "valid");
    if (selected.workflows[0].status === "valid") {
      assert.equal(selected.workflows[0].policies[0].model, "provider/session");
      assert.equal(selected.workflows[0].authority.nodes[0].model, "provider/session");
      assert.equal(selected.workflows[0].authority.nodes[0].thinking, "high");
    }
    const unrelated = resolveConfigWorkflows(project, catalogs, {}, { workflowId: "other", model: "provider/session", thinking: "high" });
    assert.equal(unrelated.workflows[0].status, "valid");
    if (unrelated.workflows[0].status === "valid") {
      assert.equal(unrelated.workflows[0].authority.nodes[0].model, undefined);
      assert.equal(unrelated.workflows[0].authority.nodes[0].thinking, "medium");
    }
  } finally { fixture.cleanup(); }
});

test("capability widening quarantines only its workflow while valid definitions carry branded authority", () => {
  const widening = resolveFixture("invalid/widening-filesystem-override");
  try {
    assert.equal(widening.result.workflows[0].status, "invalid");
    assert.ok(widening.result.workflows[0].diagnosticCodes.includes("WORKFLOW_CAPABILITY_WIDENING"));
  } finally { widening.fixture.cleanup(); }

  const valid = resolveFixture("artifact-free-debug");
  try {
    assert.equal(valid.result.workflows[0].status, "valid");
    if (valid.result.workflows[0].status === "valid") {
      assert.equal(valid.result.workflows[0].authority.workflowId, "debug-chat");
      assert.deepEqual(valid.result.workflows[0].authority.nodes.map((node) => node.nodeId), valid.result.workflows[0].team.nodes.map((node) => node.id).sort());
      assert.equal(valid.result.workflows[0].policies.every((policy) => policy.tools.every((tool) => typeof tool === "string")), true);
      assert.equal(valid.result.workflows[0].policies[0].tools.includes("human_question"), false, "later subsystem tools remain reserved but inactive");
    }
  } finally { valid.fixture.cleanup(); }

  const isolated = copyWorkflowFixture("artifact-free-debug");
  try {
    const manifestPath = join(isolated.projectRoot, ".pi/hive/hive-config.yaml");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace("  debug-chat: workflows/debug-chat.yaml", "  debug-chat: workflows/debug-chat.yaml\n  clean-chat: workflows/clean-chat.yaml"));
    const workflowPath = join(isolated.projectRoot, ".pi/hive/workflows/debug-chat.yaml");
    const original = readFileSync(workflowPath, "utf8");
    writeFileSync(join(isolated.projectRoot, ".pi/hive/workflows/clean-chat.yaml"), original);
    writeFileSync(workflowPath, original.replace("  agent: debugger", "  agent: debugger\n  overrides:\n    capabilities:\n      git: true"));
    const project = loadConfigProject(isolated.projectRoot); assert.equal(project.status, "configured");
    const result = resolveConfigWorkflows(project, loadConfigCatalogs(project));
    assert.deepEqual(result.workflows.map((workflow) => [workflow.id, workflow.status]), [["clean-chat", "valid"], ["debug-chat", "invalid"]]);
  } finally { isolated.cleanup(); }

  const fixture = copyWorkflowFixture("combined-delivery");
  try {
    const workflowPath = join(fixture.projectRoot, ".pi/hive/workflows/feature-delivery.yaml");
    const source = readFileSync(workflowPath, "utf8").replace("  role: Delivery orchestrator\n", "  role: Delivery orchestrator\n  overrides:\n    skills:\n      add: [orchestration]\n      remove: [missing-skill]\n");
    writeFileSync(workflowPath, source);
    const project = loadConfigProject(fixture.projectRoot); assert.equal(project.status, "configured");
    const result = resolveConfigWorkflows(project, loadConfigCatalogs(project));
    assert.equal(result.workflows[0].status, "invalid");
    assert.ok(result.workflows[0].diagnosticCodes.includes("WORKFLOW_ATTACHMENT_ADD_EXISTING"));
    assert.ok(result.workflows[0].diagnosticCodes.includes("WORKFLOW_ATTACHMENT_REMOVE_MISSING"));
    const parsed = parseConfigYaml(source, ".pi/hive/workflows/feature-delivery.yaml"); assert.ok(parsed.value);
    assert.deepEqual(result.workflows[0].diagnostics.find((x) => x.code === "WORKFLOW_ATTACHMENT_ADD_EXISTING")?.range, parsed.value.sourceMap["/team/overrides/skills/add/0"].value);
    assert.deepEqual(result.workflows[0].diagnostics.find((x) => x.code === "WORKFLOW_ATTACHMENT_REMOVE_MISSING")?.range, parsed.value.sourceMap["/team/overrides/skills/remove/0"].value);
  } finally { fixture.cleanup(); }
});

test("attachment conflicts, unknown IDs, and failed targets have exact edges and ranges", () => {
  for (const [add, remove, expected] of [["orchestration", "orchestration", "WORKFLOW_ATTACHMENT_CONFLICT"], ["unknown-skill", undefined, "WORKFLOW_ATTACHMENT_UNKNOWN"]] as const) {
    const fixture = copyWorkflowFixture("combined-delivery");
    try {
      const path = join(fixture.projectRoot, ".pi/hive/workflows/feature-delivery.yaml");
      const delta = `  overrides:\n    skills:\n      add: [${add}]\n${remove ? `      remove: [${remove}]\n` : ""}`;
      const source = readFileSync(path, "utf8").replace("  role: Delivery orchestrator\n", `  role: Delivery orchestrator\n${delta}`);
      writeFileSync(path, source);
      const project = loadConfigProject(fixture.projectRoot); assert.equal(project.status, "configured");
      const result = resolveConfigWorkflows(project, loadConfigCatalogs(project));
      const parsed = parseConfigYaml(source, ".pi/hive/workflows/feature-delivery.yaml"); assert.ok(parsed.value);
      const diagnostic = result.workflows[0].diagnostics.find((x) => x.code === expected);
      assert.deepEqual(diagnostic?.range, parsed.value.sourceMap["/team/overrides/skills/add/0"].value);
      assert.ok(result.edges.some((edge) => edge.target === `skill:${add}` && edge.range.start.offset === diagnostic?.range.start.offset));
    } finally { fixture.cleanup(); }
  }

  const fixture = copyWorkflowFixture("artifact-free-debug");
  try {
    const configPath = join(fixture.projectRoot, ".pi/hive/hive-config.yaml");
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}\nskills:\n  broken: skills/broken/\n`);
    const skill = join(fixture.projectRoot, ".pi/hive/skills/broken"); mkdirSync(skill, { recursive: true }); writeFileSync(join(skill, "bad.txt"), "bad");
    const path = join(fixture.projectRoot, ".pi/hive/workflows/debug-chat.yaml");
    const source = readFileSync(path, "utf8").replace("  agent: debugger\n", "  agent: debugger\n  overrides:\n    skills:\n      add: [broken]\n");
    writeFileSync(path, source);
    const project = loadConfigProject(fixture.projectRoot); assert.equal(project.status, "configured");
    const result = resolveConfigWorkflows(project, loadConfigCatalogs(project));
    const parsed = parseConfigYaml(source, ".pi/hive/workflows/debug-chat.yaml"); assert.ok(parsed.value);
    assert.deepEqual(result.workflows[0].diagnostics.find((x) => x.code === "WORKFLOW_ATTACHMENT_FAILED")?.range, parsed.value.sourceMap["/team/overrides/skills/add/0"].value);
  } finally { fixture.cleanup(); }
});

test("artifact profile, binding, options, and checkpoint diagnostics use narrow ranges", () => {
  const cases = [
    ["profile: default", "profile: unknown", "ARTIFACT_PROFILE_UNKNOWN", "/artifact/profile"],
    ["binding: none", "binding: new", "ARTIFACT_BINDING_INVALID", "/artifact/binding"],
    ["options: {}", "options: { x: true }", "ARTIFACT_OPTIONS_UNKNOWN", "/artifact/options"],
    ["team:\n", "approvals:\n  review: optional\n\nteam:\n", "WORKFLOW_CHECKPOINT_UNKNOWN", "/approvals/review"],
  ] as const;
  for (const [needle, replacement, code, pointer] of cases) {
    const fixture = copyWorkflowFixture("artifact-free-debug");
    try {
      const path = join(fixture.projectRoot, ".pi/hive/workflows/debug-chat.yaml");
      const source = readFileSync(path, "utf8").replace(needle, replacement); writeFileSync(path, source);
      const project = loadConfigProject(fixture.projectRoot); assert.equal(project.status, "configured");
      const result = resolveConfigWorkflows(project, loadConfigCatalogs(project));
      const parsed = parseConfigYaml(source, ".pi/hive/workflows/debug-chat.yaml"); assert.ok(parsed.value);
      assert.deepEqual(result.workflows[0].diagnostics.find((x) => x.code === code)?.range, parsed.value.sourceMap[pointer].value);
    } finally { fixture.cleanup(); }
  }
});

test("self suggested-next is a valid non-executable hint", () => {
  const fixture = copyWorkflowFixture("artifact-free-debug");
  try {
    const path = join(fixture.projectRoot, ".pi/hive/workflows/debug-chat.yaml");
    writeFileSync(path, `suggested-next: [debug-chat]\n${readFileSync(path, "utf8")}`);
    const project = loadConfigProject(fixture.projectRoot); assert.equal(project.status, "configured");
    const result = resolveConfigWorkflows(project, loadConfigCatalogs(project));
    assert.equal(result.workflows[0].status, "valid");
    assert.equal(result.edges.some((edge) => edge.target === "workflow:debug-chat"), false);
  } finally { fixture.cleanup(); }
});

test("selector summary bounds items and reduces one oversized entry without dropping later siblings", () => {
  const invalid = (id: string): WorkflowDefinition => ({ id, status: "invalid", diagnostics: [], diagnosticCodes: [] });
  const exact = Array.from({ length: WORKFLOW_LIMITS.selectorItems }, (_, index) => invalid(index.toString(36)));
  assert.equal(buildWorkflowSelectorSummary(exact).truncated, false);
  assert.equal(buildWorkflowSelectorSummary([...exact, invalid("overflow")]).truncated, true);
  const oversized = {
    id: "a", status: "valid", diagnostics: [], diagnosticCodes: [], name: "A", description: "d".repeat(WORKFLOW_LIMITS.selectorEntryBytes), useWhen: "use", tags: [], examples: [], suggestedNext: [],
    artifact: { adapter: "none", profile: "default" },
  } as unknown as WorkflowDefinition;
  const reduced = buildWorkflowSelectorSummary([oversized, invalid("b")]);
  assert.deepEqual(reduced.items.map((x) => x.id), ["a", "b"]);
  assert.equal(reduced.truncated, true);
  assert.ok(reduced.bytes <= WORKFLOW_LIMITS.selectorBytes);

  const aggregate: WorkflowDefinition[] = [];
  while (!buildWorkflowSelectorSummary([...aggregate, { ...invalid(`i-${aggregate.length}`), description: "d".repeat(900) }]).truncated) aggregate.push({ ...invalid(`i-${aggregate.length}`), description: "d".repeat(900) });
  const atN = buildWorkflowSelectorSummary(aggregate);
  const atNPlusOne = buildWorkflowSelectorSummary([...aggregate, { ...invalid("aggregate-overflow"), description: "d".repeat(900) }]);
  assert.equal(atN.truncated, false);
  assert.ok(atN.bytes <= WORKFLOW_LIMITS.selectorBytes);
  assert.equal(atNPlusOne.truncated, true);
});

test("workflow budget overflow and package-cap widening fail at field ranges", () => {
  for (const [line, code, pointer] of [["  active-wall-time: 999999999999999999999h", "WORKFLOW_BUDGET_INVALID", "/budgets/active-wall-time"], ["  max-parallel: 33", "WORKFLOW_BUDGET_WIDENING", "/budgets/max-parallel"]] as const) {
    const fixture = copyWorkflowFixture("artifact-free-debug");
    try {
      const path = join(fixture.projectRoot, ".pi/hive/workflows/debug-chat.yaml");
      const source = readFileSync(path, "utf8").replace("team:\n", `budgets:\n${line}\n\nteam:\n`);
      writeFileSync(path, source);
      const project = loadConfigProject(fixture.projectRoot); assert.equal(project.status, "configured");
      const result = resolveConfigWorkflows(project, loadConfigCatalogs(project));
      const parsed = parseConfigYaml(source, ".pi/hive/workflows/debug-chat.yaml"); assert.ok(parsed.value);
      assert.deepEqual(result.workflows[0].diagnostics.find((x) => x.code === code)?.range, parsed.value.sourceMap[pointer].value);
    } finally { fixture.cleanup(); }
  }
});

test("workflow limits expose frozen safety ceilings", () => {
  assert.deepEqual({ depth: WORKFLOW_LIMITS.teamDepth, nodes: WORKFLOW_LIMITS.teamNodes }, { depth: 32, nodes: 1024 });
  assert.equal(WORKFLOW_LIMITS.fileBytes, 524_288);
});
