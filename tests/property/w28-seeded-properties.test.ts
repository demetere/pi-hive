import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Check } from "typebox/value";
import { isCapabilitySubset, normalizeCapabilities, resolveCapabilityOverlay } from "../../src/capabilities/policy.ts";
import { compileFilesystemGlob, matchFilesystemGlob, normalizeFilesystemRelativePath } from "../../src/capabilities/glob.ts";
import type { ArtifactCapability, CapabilityDeclaration, FilesystemOperation, KnowledgeCapability, ShellCapability } from "../../src/capabilities/types.ts";
import { CONFIG_LIMITS } from "../../src/config/diagnostics.ts";
import { loadConfigCatalogs, loadConfigProject, PublicIdSchema, resolveTeam, WORKFLOW_LIMITS, type RawTeamNodeV1 } from "../../src/config/index.ts";
import { parseConfigYaml } from "../../src/config/yaml.ts";
import { toWorkflowTelemetryEvent } from "../../src/observability/events.ts";
import { WORKFLOW_PROJECTION_PAGE_LIMIT, WorkflowTelemetryProjection, rebuildWorkflowProjection } from "../../src/observability/projection.ts";
import { createWorkflowEvent, sealWorkflowEvent } from "../../src/workflows/events.ts";
import { appendWorkflowEvent, readWorkflowJournal, readWorkflowJournalFrom } from "../../src/workflows/journal.ts";
import { copyWorkflowFixture } from "../helpers/workflow-fixtures.ts";

const SEED = 0x28_20_26_07;
const CASES = 96;

function seeded(seed = SEED): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
function integer(random: () => number, maximum: number): number { return Math.floor(random() * maximum); }
function sample<T>(random: () => number, values: readonly T[]): T { return values[integer(random, values.length)]!; }
function subset<T>(random: () => number, values: readonly T[], requireOne = false): T[] {
  const selected = values.filter(() => random() >= 0.5);
  if (requireOne && selected.length === 0) selected.push(sample(random, values));
  return selected;
}

function telemetryChain(count: number, sessionId: string) {
  const output = [];
  let previous: ReturnType<typeof sealWorkflowEvent> | undefined;
  for (let index = 1; index <= count; index += 1) {
    const event = sealWorkflowEvent(createWorkflowEvent({
      eventId: `${sessionId}-event-${index}`, projectId: "property-project", sessionId, runId: `run-${index % 7}`,
      type: "run.started", producer: "harness", timestamp: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
      payload: { formatVersion: 1, nodeId: `node-${index % 5}` },
    }), index, previous?.eventHash ?? null);
    previous = event;
    output.push(toWorkflowTelemetryEvent(event, { workflowId: `workflow-${index % 3}` }));
  }
  return output;
}

function teamChain(depth: number): RawTeamNodeV1 {
  let node: RawTeamNodeV1 = { id: `node-${depth}`, agent: "debugger" };
  for (let index = depth - 1; index >= 1; index -= 1) node = { id: `node-${index}`, agent: "debugger", members: [node] };
  return node;
}

function generatedTeam(random: () => number, count: number): RawTeamNodeV1 {
  const nodes = Array.from({ length: count }, (_, index): RawTeamNodeV1 => ({ id: `node-${index}`, agent: "debugger" }));
  for (let index = 1; index < nodes.length; index += 1) {
    const parent = nodes[integer(random, index)]!;
    (parent.members ??= []).push(nodes[index]!);
  }
  return nodes[0]!;
}

const SHELL = ["inspect", "test", "build", "package", "mutate", "execute-code"] as const satisfies readonly ShellCapability[];
const FILESYSTEM = ["read", "create", "update", "delete"] as const satisfies readonly FilesystemOperation[];
const ARTIFACT = ["read", "write", "review"] as const satisfies readonly ArtifactCapability[];
const KNOWLEDGE = ["read", "propose", "curate"] as const satisfies readonly KnowledgeCapability[];

// This suite deliberately uses a fixed seed and bounded cases. A failure always
// reports the seed/case so it is replayable and never depends on ambient randomness.
test("seeded YAML properties enforce literal parsing and exact byte/depth/node N/N+1 guards", () => {
  const random = seeded();
  for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
    const key = `key-${caseIndex}`;
    const literal = `${sample(random, ["${HOME}", "$(command)", "`command`", "{{template}}"])}-${integer(random, 1_000_000)}`;
    const result = parseConfigYaml(JSON.stringify({ [key]: literal, count: integer(random, Number.MAX_SAFE_INTEGER) }), `seed-${SEED}-case-${caseIndex}.yaml`);
    assert.deepEqual(result.diagnostics, [], `seed=${SEED} case=${caseIndex}`);
    assert.deepEqual(result.value?.data, { [key]: literal, count: (result.value?.data as { count: number }).count });
    const unsafe = sample(random, ["a: &anchor 1\n", "a: *alias\n", "<<: merge\n", "a: !custom value\n", "1: value\n"]);
    assert.equal(parseConfigYaml(unsafe, "unsafe.yaml").value, undefined, `seed=${SEED} case=${caseIndex}`);
  }
  assert.ok(parseConfigYaml("x".repeat(CONFIG_LIMITS.inputBytes), "bytes-n.yaml").value);
  assert.equal(parseConfigYaml("x".repeat(CONFIG_LIMITS.inputBytes + 1), "bytes-n-plus-one.yaml").diagnostics[0]?.code, "CONFIG_INPUT_TOO_LARGE");
  const depthN = CONFIG_LIMITS.maxDepth - 1;
  assert.ok(parseConfigYaml(`${"[".repeat(depthN)}x${"]".repeat(depthN)}`, "depth-n.yaml").value);
  assert.equal(parseConfigYaml(`${"[".repeat(depthN + 1)}x${"]".repeat(depthN + 1)}`, "depth-n-plus-one.yaml").diagnostics[0]?.code, "YAML_MAX_DEPTH");
  const nodeItemsN = CONFIG_LIMITS.maxNodes - 1;
  assert.ok(parseConfigYaml(`${"- x\n".repeat(nodeItemsN)}`, "nodes-n.yaml").value);
  assert.equal(parseConfigYaml(`${"- x\n".repeat(nodeItemsN + 1)}`, "nodes-n-plus-one.yaml").diagnostics[0]?.code, "YAML_MAX_NODES");
});

test("seeded public-ID and path/glob properties are canonical, idempotent, and fail closed", () => {
  const random = seeded();
  for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
    const segments = Array.from({ length: 1 + integer(random, 5) }, () => `s${integer(random, 10_000).toString(36)}`);
    const id = segments.join("-");
    assert.equal(Check(PublicIdSchema, id), true, `seed=${SEED} case=${caseIndex}`);
    for (const invalid of [id.toUpperCase(), `-${id}`, `${id}-`, `${id}--x`, `${id}_x`, `${id}/x`]) assert.equal(Check(PublicIdSchema, invalid), false, invalid);

    const rawPath = segments.map((segment, index) => index === 0 && caseIndex % 2 === 0 ? `${segment}cafe\u0301` : segment).join("/");
    const normalized = normalizeFilesystemRelativePath(rawPath);
    assert.equal(normalizeFilesystemRelativePath(normalized), normalized, `seed=${SEED} case=${caseIndex}`);
    const glob = compileFilesystemGlob(`${normalized}/**`);
    assert.equal(matchFilesystemGlob(glob, `${normalized}/child-${integer(random, 10_000)}.ts`), true);
    for (const escape of [`../${normalized}`, `/${normalized}`, `${normalized}/../escape`, `${normalized}\\escape`, `${normalized}//escape`]) {
      assert.throws(() => normalizeFilesystemRelativePath(escape), /FILESYSTEM_PATH_INVALID/, `seed=${SEED} case=${caseIndex} value=${escape}`);
    }
    for (const unsafeGlob of [`!${normalized}/**`, `../${normalized}/**`, `${normalized}/[ab]`, `${normalized}/**x`]) {
      assert.throws(() => compileFilesystemGlob(unsafeGlob), /FILESYSTEM_GLOB_INVALID/, `seed=${SEED} case=${caseIndex} glob=${unsafeGlob}`);
    }
  }
});

test("seeded capability narrowing is monotone across every authority group and widening fails closed", () => {
  const random = seeded();
  const ceiling: CapabilityDeclaration = {
    filesystem: [{ path: "workspace", operations: FILESYSTEM, include: ["src/**", "tests/**", "docs/**"], exclude: ["**/.env*", "**/secrets/**"] }],
    shell: SHELL, git: true, "external-network": true, "human-input": true, artifact: ARTIFACT, knowledge: KNOWLEDGE,
  };
  const normalizedCeiling = normalizeCapabilities(ceiling);
  for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
    const overlay: CapabilityDeclaration = {
      filesystem: [{
        path: `workspace/${sample(random, ["src", "tests", "docs"])}`,
        operations: subset(random, FILESYSTEM, true), include: subset(random, ["src/**", "tests/**", "docs/**"], true),
        exclude: ["**/.env*", "**/secrets/**", ...(random() > 0.5 ? ["**/private/**"] : [])],
      }],
      shell: subset(random, SHELL), git: random() > 0.5, "external-network": random() > 0.5, "human-input": random() > 0.5,
      artifact: subset(random, ARTIFACT), knowledge: subset(random, KNOWLEDGE),
    };
    const result = resolveCapabilityOverlay(ceiling, overlay);
    assert.equal(result.ok, true, `seed=${SEED} case=${caseIndex} ${JSON.stringify(result.issues)}`);
    assert.ok(result.policy);
    assert.equal(isCapabilitySubset(result.policy, normalizedCeiling), true, `seed=${SEED} case=${caseIndex}`);

    const deniedGroup = sample(random, ["shell", "filesystem", "artifact", "knowledge", "git", "external-network", "human-input"] as const);
    let narrowCeiling: CapabilityDeclaration; let widening: CapabilityDeclaration;
    if (deniedGroup === "shell") { narrowCeiling = { shell: ["inspect"] }; widening = { shell: ["execute-code"] }; }
    else if (deniedGroup === "filesystem") { narrowCeiling = { filesystem: [{ path: "workspace", operations: ["read"] }] }; widening = { filesystem: [{ path: ".", operations: ["read"] }] }; }
    else if (deniedGroup === "artifact") { narrowCeiling = { artifact: ["read"] }; widening = { artifact: ["write"] }; }
    else if (deniedGroup === "knowledge") { narrowCeiling = { knowledge: ["read"] }; widening = { knowledge: ["curate"] }; }
    else { narrowCeiling = {}; widening = { [deniedGroup]: true }; }
    assert.equal(resolveCapabilityOverlay(narrowCeiling, widening).ok, false, `seed=${SEED} case=${caseIndex} group=${deniedGroup}`);
  }
});

test("seeded recursive teams preserve unique topology and reject duplicates plus exact N/N+1 depth", () => {
  const fixture = copyWorkflowFixture("artifact-free-debug");
  try {
    const project = loadConfigProject(fixture.projectRoot); assert.equal(project.status, "configured");
    if (project.status !== "configured") throw new Error("property fixture invalid");
    const catalogs = loadConfigCatalogs(project);
    const random = seeded();
    for (let caseIndex = 0; caseIndex < 32; caseIndex += 1) {
      const raw = generatedTeam(random, 2 + integer(random, 62));
      const result = resolveTeam(raw, {}, "property.yaml", "property-workflow", catalogs);
      assert.equal(result.diagnostics.length, 0, `seed=${SEED} case=${caseIndex}`);
      assert.equal(result.team?.nodes.length, result.encounteredNodes);
      assert.equal(new Set(result.team?.nodes.map((node) => node.id)).size, result.encounteredNodes);
      const duplicate = structuredClone(raw);
      if (duplicate.members?.[0]) duplicate.members[0].id = duplicate.id;
      assert.equal(resolveTeam(duplicate, {}, "property.yaml", "property-workflow", catalogs).diagnostics.some((entry) => entry.code === "TEAM_NODE_ID_DUPLICATE"), true);
    }
    assert.equal(resolveTeam(teamChain(WORKFLOW_LIMITS.teamDepth), {}, "property.yaml", "property-workflow", catalogs).diagnostics.length, 0);
    assert.equal(resolveTeam(teamChain(WORKFLOW_LIMITS.teamDepth + 1), {}, "property.yaml", "property-workflow", catalogs).diagnostics.some((entry) => entry.code === "TEAM_DEPTH_EXCEEDED"), true);
  } finally { fixture.cleanup(); }
});

test("seeded journal cursor replay is suffix-exact and rejects every forged boundary", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-w28-journal-property-"));
  const sessionId = "property-session";
  const random = seeded();
  const appended = Array.from({ length: 64 }, (_, index) => appendWorkflowEvent(projectRoot, createWorkflowEvent({
    eventId: `journal-property-${index}`, projectId: "property-project", sessionId, type: "control.requested", producer: "harness",
    payload: { formatVersion: 1, sample: integer(random, 1_000_000) },
  })));
  assert.deepEqual(readWorkflowJournal(projectRoot, sessionId).map((event) => event.eventId), appended.map((event) => event.eventId));
  for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
    const sequence = integer(random, appended.length + 1);
    const hash = sequence === 0 ? null : appended[sequence - 1]!.eventHash;
    const suffix = readWorkflowJournalFrom(projectRoot, sessionId, { sequence, hash, projectId: "property-project" }, { verifyBoundary: sequence > 0 });
    assert.deepEqual(suffix.map((event) => event.eventId), appended.slice(sequence).map((event) => event.eventId), `seed=${SEED} case=${caseIndex}`);
    if (sequence > 0) assert.throws(() => readWorkflowJournalFrom(projectRoot, sessionId, { sequence, hash: "f".repeat(64), projectId: "property-project" }), /boundary mismatch/i);
  }
});

test("seeded projection ingest is idempotent and pagination is lossless with exact bounds", () => {
  const random = seeded();
  const streams = [telemetryChain(73, "property-a"), telemetryChain(61, "property-b")];
  const projection = rebuildWorkflowProjection(streams);
  const before = projection.snapshot();
  for (const stream of streams) for (const event of stream) assert.equal(projection.ingest(event), "duplicate");
  assert.deepEqual(projection.snapshot(), before, "duplicate replay must not change any projected state or usage");

  for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
    const limit = 1 + integer(random, WORKFLOW_PROJECTION_PAGE_LIMIT);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = projection.history({ limit, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((event) => event.eventId));
      cursor = page.nextCursor;
      if (!page.hasMore) assert.equal(cursor, undefined);
    } while (cursor);
    assert.equal(seen.length, streams[0].length + streams[1].length, `seed=${SEED} case=${caseIndex}`);
    assert.equal(new Set(seen).size, seen.length, `seed=${SEED} case=${caseIndex}`);
  }
  for (const invalid of [0, WORKFLOW_PROJECTION_PAGE_LIMIT + 1, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => projection.history({ limit: invalid }), /limit must be/i);
    assert.throws(() => projection.currentPage({ kind: "sessions", limit: invalid }), /limit must be/i);
  }
  const limited = new WorkflowTelemetryProjection({ eventLimit: 2 });
  const exact = telemetryChain(3, "event-limit");
  assert.equal(limited.ingest(exact[0]!), "inserted");
  assert.equal(limited.ingest(exact[1]!), "inserted");
  assert.throws(() => limited.ingest(exact[2]!), /event limit exceeded/i);
});
