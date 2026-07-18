import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalJson } from "../../src/config/snapshot-canonical.ts";
import { appendWorkflowEvent, readWorkflowJournal } from "../../src/workflows/journal.ts";
import { createWorkflowEvent } from "../../src/workflows/events.ts";
import {
  HANDOFF_LIMITS,
  clearStagedHandoff,
  createEmptyHandoffState,
  createHandoffPacket,
  handoffForRun,
  handoffPromptInput,
  hasOpenRun,
  readHandoffPacket,
  readHandoffState,
  reduceHandoffState,
  restoreHandoffState,
  stageHandoff,
  verifyHandoffPacket,
  verifyHandoffPacketSource,
} from "../../src/workflows/handoff.ts";
import {
  resolveHandoffSource,
  selectWorkflowSession,
} from "../../src/workflows/navigation.ts";
import { WorkflowRunLifecycle } from "../../src/workflows/runs.ts";
import { TOOL_CONTRACT_LIMITS, buildWorkflowStatusPage } from "../../src/workflows/tools.ts";
import { initializeNormalParent, listSessionLinks, replaceSessionLinks, type NormalSessionLink, type WorkflowSessionLink } from "../../src/workflows/sessions.ts";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const workflow = (workflowId: string, character: string) => ({
  workflowId,
  activationHash: character.repeat(64),
  source: "current" as const,
  resumable: true,
  freshEnabled: true,
  model: "provider/model",
  thinking: "medium",
  tools: workflowId === "plan" ? ["read"] : ["write", "bash"],
});

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-handoff-"));
  initializeNormalParent({ configured: true, projectRoot, projectId: "project-1", piSessionId: "normal", piSessionFile: "/pi/normal", model: "provider/normal", thinking: "low", activeTools: ["read"] });
  let next = 0;
  const calls: string[] = [];
  const adapter = {
    async create() { next += 1; calls.push(`create:${next}`); return { piSessionId: `pi-${next}`, piSessionFile: `/pi/${next}.jsonl` }; },
    async switch(input: { piSessionFile: string; withSession: (ctx: unknown) => Promise<void> | void }) { calls.push(`switch:${input.piSessionFile}`); await input.withSession({}); return { cancelled: false }; },
  };
  const owner = (nonce: string) => ({ pid: 100 + next, processMarker: `marker-${nonce}`, nonce, verifyDead: () => true });
  return { projectRoot, adapter, owner, calls };
}

function lifecycle(projectRoot: string, sessionId: string, snapshotId: string, runId: string, status: "completed" | "blocked" | "failed" = "completed") {
  const runtime = new WorkflowRunLifecycle({
    projectRoot,
    projectId: "project-1",
    sessionId,
    snapshotId,
    rootNodeId: "root",
    createRunId: () => runId,
    completion: {
      evidence: () => ({ state: "satisfied" }),
      artifacts: () => ({ state: "satisfied" }),
      projectState: () => ({
        state: "satisfied",
        changeCoverage: "recorded",
        fileChanges: [{ path: "src/result.ts", operation: "create", afterHash: digest("a"), attribution: "recorded" }],
      }),
    },
  });
  runtime.recordUserInput({ inputId: `${runId}-input`, text: "produce the source result", source: "interactive" });
  const delivery = runtime.prepareInputDelivery(`${runId}-request`);
  runtime.confirmInputDelivery(delivery.requestId);
  return runtime.finish({
    status,
    summary: `${status} source result`,
    artifactRefs: [{ workspaceId: "workspace-1", checkpoint: "tasks", digest: digest("b") }],
    evidenceRefs: [{ kind: "test", toolCallId: "call-1", claim: "focused tests passed" }],
    data: { suggested: "inspect, never authorize" },
  }, { callerNodeId: "root", toolBatch: ["workflow_finish"] }).then((result) => {
    assert.equal(result.ok, true);
    return runtime;
  });
}

test("completed, blocked, and failed terminal runs produce bounded authority-free content-addressed packets", async () => {
  for (const [index, status] of (["completed", "blocked", "failed"] as const).entries()) {
    const f = fixture();
    const selected = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: "normal", workflow: workflow("plan", "a"), adapter: f.adapter, owner: f.owner(`source-${index}`) });
    await lifecycle(f.projectRoot, selected.link.workflowSessionId, selected.link.activationHash, `run-${status}`, status);
    const packet = resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "project-1", runId: `run-${status}`, currentPiSessionId: "normal" });
    assert.equal(packet.terminal.status, status);
    assert.equal(packet.source.workflowId, "plan");
    assert.equal(packet.source.snapshotId, selected.link.activationHash);
    assert.equal(packet.fileChanges[0].path, "src/result.ts");
    assert.equal(packet.artifactRefs[0].workspaceId, "workspace-1");
    assert.equal(packet.artifactRefsAreCandidates, true);
    assert.ok(Buffer.byteLength(JSON.stringify(packet), "utf8") <= HANDOFF_LIMITS.packetBytes);
    assert.equal(verifyHandoffPacket(packet, "project-1").packetHash, packet.packetHash);
    const encoded = JSON.stringify(packet);
    for (const excluded of ["capabilities", "approval", "lease", "budget", "model", "team", "transcript", "pendingQuestion"]) assert.equal(encoded.includes(excluded), false, excluded);
    assert.deepEqual(handoffPromptInput(packet), {
      source: "handoff",
      provenance: `handoff:${packet.packetHash}:plan:run-${status}`,
      content: packet,
      ref: `workflow_status:handoff?packetHash=${packet.packetHash}`,
    });
  }
});

test("source resolution rejects missing, nonterminal, cross-project, and invalid last contexts", async () => {
  const f = fixture();
  const source = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: "normal", workflow: workflow("plan", "a"), adapter: f.adapter, owner: f.owner("source") });
  const runtime = new WorkflowRunLifecycle({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: source.link.workflowSessionId, snapshotId: source.link.activationHash, rootNodeId: "root", createRunId: () => "open-run" });
  runtime.recordUserInput({ inputId: "open-input", text: "still running", source: "interactive" });
  assert.throws(() => resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "project-1", runId: "open-run", currentPiSessionId: "normal" }), /terminal/i);
  assert.throws(() => resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "project-1", runId: "missing", currentPiSessionId: "normal" }), /missing/i);
  assert.throws(() => resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "other-project", runId: "open-run", currentPiSessionId: "normal" }), /project/i);
  assert.throws(() => resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "project-1", runId: "last", currentPiSessionId: "normal" }), /last.*workflow/i);
  assert.throws(() => resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "project-1", runId: "last", currentPiSessionId: source.link.piSessionId }), /terminal/i);
});

test("last chooses the newest terminal run only in the selected source workflow", async () => {
  const f = fixture();
  const source = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: "normal", workflow: workflow("plan", "a"), adapter: f.adapter, owner: f.owner("source") });
  await lifecycle(f.projectRoot, source.link.workflowSessionId, source.link.activationHash, "older");
  await lifecycle(f.projectRoot, source.link.workflowSessionId, source.link.activationHash, "newer");
  const packet = resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "project-1", runId: "last", currentPiSessionId: source.link.piSessionId });
  assert.equal(packet.source.runId, "newer");
});

test("staging survives restart, rejects conflicts/open targets, clears only while idle, and consumes once with run creation", async () => {
  const f = fixture();
  const source = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: "normal", workflow: workflow("plan", "a"), adapter: f.adapter, owner: f.owner("source") });
  await lifecycle(f.projectRoot, source.link.workflowSessionId, source.link.activationHash, "source-run");
  const packet = resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "project-1", runId: "source-run", currentPiSessionId: "normal" });
  const target = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: source.link.piSessionId, workflow: workflow("build", "b"), fresh: true, stagedHandoff: packet, adapter: f.adapter, owner: f.owner("target") });
  assert.equal(f.calls.some((call) => call.startsWith("run:") || call.startsWith("model:")), false);
  assert.equal(readHandoffState(f.projectRoot, target.link.workflowSessionId).staged?.packetHash, packet.packetHash);
  assert.equal(readHandoffState(f.projectRoot, target.link.workflowSessionId).consumed.length, 0);

  const restarted = new WorkflowRunLifecycle({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: target.link.workflowSessionId, snapshotId: target.link.activationHash, rootNodeId: "root", createRunId: () => "target-run" });
  const first = restarted.recordUserInput({ inputId: "ordinary-callback", text: "implement independently", source: "interactive" });
  const duplicate = restarted.recordUserInput({ inputId: "ordinary-callback", text: "implement independently", source: "interactive" });
  assert.equal(first.created, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(restarted.restore().latestRun?.handoffPacketHash, packet.packetHash);
  const consumed = readHandoffState(f.projectRoot, target.link.workflowSessionId);
  assert.equal(consumed.staged, undefined);
  assert.deepEqual(consumed.consumed.map((entry) => [entry.packet.packetHash, entry.runId]), [[packet.packetHash, "target-run"]]);
  assert.equal(readWorkflowJournal(f.projectRoot, target.link.workflowSessionId).filter((event) => event.type === "run.started").length, 1);
  assert.throws(() => clearStagedHandoff({ projectRoot: f.projectRoot, projectId: "project-1", targetSessionId: target.link.workflowSessionId }), /idle/i);
  assert.throws(() => stageHandoff({ projectRoot: f.projectRoot, projectId: "project-1", targetSessionId: target.link.workflowSessionId, targetWorkflowId: "build", packet }), /idle|open run/i);
});

test("clear is CAS/idempotent and a conflicting packet rejects before a target switch", async () => {
  const f = fixture();
  const source = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: "normal", workflow: workflow("plan", "a"), adapter: f.adapter, owner: f.owner("source") });
  await lifecycle(f.projectRoot, source.link.workflowSessionId, source.link.activationHash, "source-1");
  await lifecycle(f.projectRoot, source.link.workflowSessionId, source.link.activationHash, "source-2");
  const one = resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "project-1", runId: "source-1", currentPiSessionId: "normal" });
  const two = resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "project-1", runId: "source-2", currentPiSessionId: "normal" });
  const target = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: source.link.piSessionId, workflow: workflow("build", "b"), fresh: true, stagedHandoff: one, adapter: f.adapter, owner: f.owner("target") });
  assert.deepEqual(stageHandoff({ projectRoot: f.projectRoot, projectId: "project-1", targetSessionId: target.link.workflowSessionId, targetWorkflowId: "build", packet: one }).duplicate, true);
  assert.throws(() => stageHandoff({ projectRoot: f.projectRoot, projectId: "project-1", targetSessionId: target.link.workflowSessionId, targetWorkflowId: "build", packet: two }), /conflicting staged handoff/i);
  assert.throws(() => stageHandoff({ projectRoot: f.projectRoot, projectId: "project-1", targetSessionId: source.link.workflowSessionId, targetWorkflowId: "plan", packet: one }), /different workflow/i);
  assert.throws(() => clearStagedHandoff({ projectRoot: f.projectRoot, projectId: "project-1", targetSessionId: target.link.workflowSessionId, expectedPacketHash: "f".repeat(64) }), /changed before clear/i);
  const switches = f.calls.length;
  await assert.rejects(() => selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: source.link.piSessionId, workflow: workflow("build", "b"), stagedHandoff: two, adapter: f.adapter, owner: f.owner("target") }), /conflicting.*handoff/i);
  assert.equal(f.calls.length, switches, "conflict must reject before any navigation callback");
  assert.equal(clearStagedHandoff({ projectRoot: f.projectRoot, projectId: "project-1", targetSessionId: target.link.workflowSessionId, expectedPacketHash: one.packetHash, now: () => "2025-01-01T00:00:00.000Z" }).cleared, true);
  assert.equal(clearStagedHandoff({ projectRoot: f.projectRoot, projectId: "project-1", targetSessionId: target.link.workflowSessionId }).cleared, false);
  assert.equal(readHandoffState(f.projectRoot, target.link.workflowSessionId).staged, undefined);
});

test("staging rejects a self-consistent caller-hashed packet that diverges from its authoritative source terminal", async () => {
  const f = fixture();
  const source = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: "normal", workflow: workflow("plan", "a"), adapter: f.adapter, owner: f.owner("source") });
  await lifecycle(f.projectRoot, source.link.workflowSessionId, source.link.activationHash, "source-run");
  const packet = resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "project-1", runId: "source-run", currentPiSessionId: "normal" });
  const { packetHash: _packetHash, ...identity } = packet;
  const fabricatedIdentity = { ...identity, terminal: { ...identity.terminal, summary: "caller-fabricated but self-hashed" } };
  const fabricated = {
    ...fabricatedIdentity,
    packetHash: createHash("sha256").update("pi-hive-handoff-packet-v1\0").update(canonicalJson(fabricatedIdentity)).digest("hex"),
  };
  assert.equal(verifyHandoffPacket(fabricated, "project-1").terminal.summary, "caller-fabricated but self-hashed", "structural verification alone cannot establish journal authority");
  const target = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: source.link.piSessionId, workflow: workflow("build", "b"), adapter: f.adapter, owner: f.owner("target") });
  const calls = f.calls.length;
  assert.throws(() => stageHandoff({ projectRoot: f.projectRoot, projectId: "project-1", targetSessionId: target.link.workflowSessionId, targetWorkflowId: "build", packet: fabricated as never }), /authoritative source terminal envelope/i);
  assert.equal(f.calls.length, calls);
  assert.equal(readHandoffState(f.projectRoot, target.link.workflowSessionId).staged, undefined);
});

test("large handoff content exposes bounded actionable workflow_status pages resolved by packet hash", async () => {
  const f = fixture();
  const source = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: "normal", workflow: workflow("plan", "a"), adapter: f.adapter, owner: f.owner("source") });
  const runtime = new WorkflowRunLifecycle({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: source.link.workflowSessionId, snapshotId: source.link.activationHash, rootNodeId: "root", createRunId: () => "large-run" });
  runtime.recordUserInput({ inputId: "large-input", text: "produce large handoff", source: "interactive" });
  const delivery = runtime.prepareInputDelivery("large-delivery");
  runtime.confirmInputDelivery(delivery.requestId);
  const finished = await runtime.finish({ status: "completed", summary: "large", data: { body: "x".repeat(50_000) } }, { callerNodeId: "root", toolBatch: ["workflow_finish"] });
  assert.equal(finished.ok, true);
  const packet = resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "project-1", runId: "large-run", currentPiSessionId: "normal" });
  const promptInput = handoffPromptInput(packet);
  assert.equal(promptInput.ref, `workflow_status:handoff?packetHash=${packet.packetHash}`);
  const lifecycleState = { sessionId: "target", latestRun: { runId: "target-run", handoffPacketHash: packet.packetHash } } as never;
  const chunks: string[] = [];
  let cursor: string | undefined;
  do {
    const page = buildWorkflowStatusPage({ snapshot: {} as never, lifecycle: lifecycleState, handoff: packet }, { section: "handoff", packetHash: packet.packetHash, limit: 1, ...(cursor ? { cursor } : {}) });
    assert.ok(Buffer.byteLength(canonicalJson(page), "utf8") <= TOOL_CONTRACT_LIMITS.outputBytes);
    chunks.push(...(page.items as Array<{ content: string }>).map((item) => item.content));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(chunks.join(""), canonicalJson(packet));
  assert.throws(() => buildWorkflowStatusPage({ snapshot: {} as never, lifecycle: lifecycleState, handoff: packet }, { section: "handoff", packetHash: "0".repeat(64) }), /not bound/i);
});

test("packet structural and byte limits reject authority smuggling and preserve candidate artifact evidence", async () => {
  const f = fixture();
  const source = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: "normal", workflow: workflow("plan", "a"), adapter: f.adapter, owner: f.owner("source") });
  await lifecycle(f.projectRoot, source.link.workflowSessionId, source.link.activationHash, "source-run");
  const packet = resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "project-1", runId: "source-run", currentPiSessionId: "normal" });
  assert.throws(() => verifyHandoffPacket({ ...packet, capabilities: { filesystem: ["**"] } } as never, "project-1"), /unsupported field/i);
  assert.throws(() => verifyHandoffPacket({ ...packet, data: { oversized: "x".repeat(HANDOFF_LIMITS.dataBytes + 1) } } as never, "project-1"), /limit/i);
  const malformed: Array<[unknown, RegExp]> = [
    [null, /invalid/i],
    [{ ...packet, formatVersion: 2 }, /unsupported/i],
    [{ ...packet, packetHash: "bad" }, /digest/i],
    [{ ...packet, createdAt: "never" }, /createdAt/i],
    [{ ...packet, source: { ...packet.source, projectId: "other" } }, /project/i],
    [{ ...packet, source: { ...packet.source, terminalEventHash: "0" } }, /digest/i],
    [{ ...packet, terminal: { ...packet.terminal, status: "running" } }, /status/i],
    [{ ...packet, terminal: { ...packet.terminal, finishedAt: "never" } }, /finishedAt/i],
    [{ ...packet, artifactRefsAreCandidates: false }, /candidate/i],
    [{ ...packet, fileChanges: "none" }, /file changes/i],
    [{ ...packet, artifactRefs: [{ ...packet.artifactRefs[0], extra: true }] }, /unsupported field/i],
    [{ ...packet, evidenceRefs: [{ kind: "test", claim: "ok", extra: true }] }, /unsupported field/i],
    [{ ...packet, data: [] }, /plain JSON object/i],
    [{ ...packet, data: { invalid: Number.NaN } }, /not JSON/i],
    [{ ...packet, terminal: { ...packet.terminal, summary: "changed" } }, /hash mismatch/i],
  ];
  for (const [candidate, expected] of malformed) assert.throws(() => verifyHandoffPacket(candidate, "project-1"), expected);
  assert.equal(packet.artifactRefsAreCandidates, true);
  assert.equal(Object.isFrozen(packet), true);
});

function packetFixture(overrides: Record<string, unknown> = {}) {
  return createHandoffPacket({
    projectId: "project-1",
    workflowId: "plan",
    sessionId: "workflow-plan",
    createdAt: "2025-01-01T00:00:01.000Z",
    terminal: {
      runId: "run-1",
      snapshotId: "a".repeat(64),
      terminalEventHash: "b".repeat(64),
      status: "completed",
      summary: "done",
      finishedAt: "2025-01-01T00:00:00.000Z",
      fileChanges: [],
      changeCoverage: "recorded",
      artifactRefs: [],
      evidenceRefs: [],
      data: {},
      ...overrides,
    } as never,
  });
}

function handoffEvent(type: string, payload: unknown, producer = "harness", runId?: string) {
  return {
    projectId: "project-1",
    sessionId: "target",
    eventId: `event-${type}-${producer}-${runId ?? "none"}`,
    sequence: 1,
    previousHash: null,
    eventHash: "c".repeat(64),
    timestamp: "2025-01-01T00:00:02.000Z",
    type,
    payload,
    producer,
    ...(runId === undefined ? {} : { runId }),
  } as never;
}

test("handoff validation exercises every file-change shape, JSON kind, and optional reference field", () => {
  const packet = packetFixture({
    fileChanges: [
      { path: "created.ts", operation: "create", afterHash: digest("1"), attribution: "recorded" },
      { path: "updated.ts", operation: "update", beforeHash: digest("2"), afterHash: digest("3"), attribution: "reconciled" },
      { path: "deleted.ts", operation: "delete", beforeHash: digest("4"), attribution: "unknown" },
      { path: "renamed.ts", previousPath: "old.ts", operation: "rename", beforeHash: digest("5"), afterHash: digest("6"), attribution: "git-reconciled" },
      { path: "scoped.ts", operation: "create", afterHash: digest("7"), attribution: "scoped-reconciled" },
      { path: "conflict.ts", operation: "create", afterHash: digest("8"), attribution: "conflicted" },
      { path: "unknown.ts", operation: "create", afterHash: digest("9"), attribution: "unattributed" },
    ],
    artifactRefs: [{ workspaceId: "workspace", checkpoint: "checkpoint", digest: digest("d") }],
    evidenceRefs: [{ kind: "test", claim: "passed" }, { kind: "tool", toolCallId: "call-1", claim: "observed" }],
    data: { nil: null, flag: true, count: 2, nested: [{ value: "ok" }, false] },
  });
  const verified = verifyHandoffPacket(packet);
  assert.deepEqual(verified.fileChanges.map((change) => change.operation), ["create", "update", "delete", "rename", "create", "create", "create"]);
  assert.equal("toolCallId" in verified.evidenceRefs[0], false);
  assert.equal(verified.evidenceRefs[1].toolCallId, "call-1");
  assert.equal(Object.isFrozen(verified.data.nested), true);
  assert.match(createHandoffPacket({
    projectId: "project-1", workflowId: "plan", sessionId: "workflow-plan",
    terminal: {
      runId: "default-time", snapshotId: "a".repeat(64), terminalEventHash: "b".repeat(64), status: "completed", summary: "done",
      finishedAt: "2025-01-01T00:00:00.000Z", fileChanges: [], changeCoverage: "recorded", artifactRefs: [], evidenceRefs: [], data: {},
    } as never,
  }).createdAt, /^\d{4}-/u);
});

test("handoff validation rejects bounded-field, path, collection, and hash-shape edge cases", () => {
  const packet = packetFixture();
  const candidates: Array<[unknown, RegExp]> = [
    [{ ...packet, terminal: { ...packet.terminal, summary: 7 } }, /summary.*invalid/i],
    [{ ...packet, terminal: { ...packet.terminal, summary: " " } }, /summary.*invalid/i],
    [{ ...packet, terminal: { ...packet.terminal, summary: "bad\0text" } }, /summary.*invalid/i],
    [{ ...packet, source: null }, /source.*invalid/i],
    [{ ...packet, source: { ...packet.source, sessionId: "" } }, /session.*invalid/i],
    [{ ...packet, source: { ...packet.source, extra: true } }, /unsupported field/i],
    [{ ...packet, source: { projectId: "project-1" } }, /missing field/i],
    [{ ...packet, terminal: null }, /terminal.*invalid/i],
    [{ ...packet, terminal: { status: "completed", summary: "done" } }, /missing field/i],
    [{ ...packet, fileChanges: Array(HANDOFF_LIMITS.fileChanges + 1).fill(null) }, /file changes.*limit/i],
    [{ ...packet, fileChanges: [null] }, /fileChanges\[0\].*invalid/i],
    [{ ...packet, fileChanges: [{ path: "a", operation: "create", afterHash: digest("1"), attribution: "recorded", authority: true }] }, /unsupported field/i],
    [{ ...packet, fileChanges: [{ path: "a", operation: "move", attribution: "recorded" }] }, /operation.*invalid/i],
    [{ ...packet, fileChanges: [{ path: "a", operation: "create", afterHash: digest("1"), attribution: "invented" }] }, /attribution.*invalid/i],
    ...(["/absolute", "back\\slash", "double//part", "dot/./part", "up/../part"] as const).map((path) => [{ ...packet, fileChanges: [{ path, operation: "create", afterHash: digest("1"), attribution: "recorded" }] }, /normalized project-relative path/i] as [unknown, RegExp]),
    [{ ...packet, fileChanges: [{ path: "a", operation: "create", beforeHash: digest("1"), afterHash: digest("2"), attribution: "recorded" }] }, /create change hash shape/i],
    [{ ...packet, fileChanges: [{ path: "a", previousPath: "old", operation: "create", afterHash: digest("2"), attribution: "recorded" }] }, /create change hash shape/i],
    [{ ...packet, fileChanges: [{ path: "a", operation: "create", attribution: "recorded" }] }, /create change hash shape/i],
    [{ ...packet, fileChanges: [{ path: "a", operation: "update", afterHash: digest("2"), attribution: "recorded" }] }, /update change hash shape/i],
    [{ ...packet, fileChanges: [{ path: "a", operation: "update", beforeHash: digest("1"), attribution: "recorded" }] }, /update change hash shape/i],
    [{ ...packet, fileChanges: [{ path: "a", previousPath: "old", operation: "update", beforeHash: digest("1"), afterHash: digest("2"), attribution: "recorded" }] }, /update change hash shape/i],
    [{ ...packet, fileChanges: [{ path: "a", operation: "delete", attribution: "recorded" }] }, /delete change hash shape/i],
    [{ ...packet, fileChanges: [{ path: "a", operation: "delete", beforeHash: digest("1"), afterHash: digest("2"), attribution: "recorded" }] }, /delete change hash shape/i],
    [{ ...packet, fileChanges: [{ path: "a", previousPath: "old", operation: "delete", beforeHash: digest("1"), attribution: "recorded" }] }, /delete change hash shape/i],
    [{ ...packet, fileChanges: [{ path: "a", previousPath: "old", operation: "rename", afterHash: digest("2"), attribution: "recorded" }] }, /rename change hash shape/i],
    [{ ...packet, fileChanges: [{ path: "a", previousPath: "old", operation: "rename", beforeHash: digest("1"), attribution: "recorded" }] }, /rename change hash shape/i],
    [{ ...packet, fileChanges: [{ path: "a", operation: "rename", beforeHash: digest("1"), afterHash: digest("2"), attribution: "recorded" }] }, /rename change hash shape/i],
    [{ ...packet, fileChanges: [{ path: "a", previousPath: "a", operation: "rename", beforeHash: digest("1"), afterHash: digest("2"), attribution: "recorded" }] }, /rename change hash shape/i],
    [{ ...packet, artifactRefs: "none" }, /artifact refs.*limit/i],
    [{ ...packet, artifactRefs: Array(HANDOFF_LIMITS.referenceItems + 1).fill(null) }, /artifact refs.*limit/i],
    [{ ...packet, artifactRefs: [null] }, /artifactRefs\[0\].*invalid/i],
    [{ ...packet, artifactRefs: [{ workspaceId: "w", checkpoint: "c" }] }, /missing field/i],
    [{ ...packet, evidenceRefs: "none" }, /evidence refs.*limit/i],
    [{ ...packet, evidenceRefs: Array(HANDOFF_LIMITS.referenceItems + 1).fill(null) }, /evidence refs.*limit/i],
    [{ ...packet, evidenceRefs: [null] }, /evidenceRefs\[0\].*invalid/i],
    [{ ...packet, evidenceRefs: [{ kind: "test" }] }, /missing field/i],
    [{ ...packet, evidenceRefs: [{ kind: "test", toolCallId: "", claim: "ok" }] }, /tool call.*invalid/i],
    [{ ...packet, data: { deep: Array.from({ length: HANDOFF_LIMITS.dataDepth + 1 }).reduce<unknown[]>((value) => [value], []) } }, /structural limit/i],
    [{ ...packet, data: Object.fromEntries(Array.from({ length: HANDOFF_LIMITS.dataNodes + 1 }, (_, index) => [`k${index}`, null])) }, /structural limit/i],
    [{ ...packet, data: { date: new Date() } }, /not JSON/i],
    [{ ...packet, data: { "": true } }, /data key.*invalid/i],
  ];
  for (const [candidate, expected] of candidates) assert.throws(() => verifyHandoffPacket(candidate, "project-1"), expected);

  const refs = Array.from({ length: HANDOFF_LIMITS.referenceItems }, (_, index) => ({ workspaceId: `w${index}${"x".repeat(2_000)}`, checkpoint: `c${index}${"y".repeat(2_000)}`, digest: digest("d") }));
  assert.throws(() => packetFixture({ artifactRefs: refs }), /packet exceeds.*byte limit/i);
});

test("handoff reducer rejects malformed authority transitions and resolves staged and consumed lookups", () => {
  const packet = packetFixture();
  const stage = handoffEvent("handoff.recorded", { formatVersion: 1, operation: "stage", packet });
  const staged = reduceHandoffState(createEmptyHandoffState(), stage);
  assert.equal(staged.staged?.packetHash, packet.packetHash);
  assert.throws(() => reduceHandoffState(staged, stage), /already exists/i);
  assert.throws(() => reduceHandoffState(createEmptyHandoffState(), handoffEvent("handoff.recorded", { formatVersion: 1, operation: "stage", packet }, "runtime")), /authority/i);
  assert.throws(() => reduceHandoffState(createEmptyHandoffState(), handoffEvent("handoff.recorded", null)), /payload.*invalid/i);
  assert.throws(() => reduceHandoffState(createEmptyHandoffState(), handoffEvent("handoff.recorded", { formatVersion: 2, operation: "stage", packet })), /payload.*invalid/i);
  assert.throws(() => reduceHandoffState(createEmptyHandoffState(), handoffEvent("handoff.recorded", { formatVersion: 1, operation: "replace" })), /operation.*unsupported/i);
  assert.throws(() => reduceHandoffState(createEmptyHandoffState(), handoffEvent("handoff.recorded", { formatVersion: 1, operation: "clear", packetHash: packet.packetHash })), /changed before clear/i);
  assert.throws(() => reduceHandoffState(staged, handoffEvent("handoff.recorded", { formatVersion: 1, operation: "clear", packetHash: "f".repeat(64) })), /changed before clear/i);

  const noHandoff = handoffEvent("run.started", { input: { inputId: "input" } }, "runtime", "run-1");
  assert.equal(reduceHandoffState(staged, noHandoff), staged);
  assert.throws(() => reduceHandoffState(staged, handoffEvent("run.started", { handoffPacketHash: packet.packetHash, input: null }, "runtime", "run-1")), /input.*invalid/i);
  assert.throws(() => reduceHandoffState(staged, handoffEvent("run.started", { handoffPacketHash: packet.packetHash, input: { inputId: "input" } }, "harness", "run-1")), /runtime authority/i);
  assert.throws(() => reduceHandoffState(staged, handoffEvent("run.started", { handoffPacketHash: packet.packetHash, input: { inputId: "input" } }, "runtime")), /runtime authority/i);
  assert.throws(() => reduceHandoffState(staged, handoffEvent("run.started", { handoffPacketHash: "f".repeat(64), input: { inputId: "input" } }, "runtime", "run-1")), /missing or different/i);
  assert.throws(() => reduceHandoffState({ staged: packet, consumed: Array(HANDOFF_LIMITS.consumedRecords).fill({}) } as never, handoffEvent("run.started", { handoffPacketHash: packet.packetHash, input: { inputId: "input" } }, "runtime", "run-1")), /history exceeds/i);

  const consumed = reduceHandoffState(staged, handoffEvent("run.started", { handoffPacketHash: packet.packetHash, input: { inputId: "input" } }, "runtime", "run-1"));
  assert.equal(handoffForRun([stage, handoffEvent("run.started", { handoffPacketHash: packet.packetHash, input: { inputId: "input" } }, "runtime", "run-1")], "run-1")?.packetHash, packet.packetHash);
  assert.equal(handoffForRun([stage], "missing"), undefined);
  assert.equal(consumed.consumed[0].inputId, "input");
  assert.equal(hasOpenRun([handoffEvent("run.started", {}, "runtime", "run-1")]), true);
  assert.equal(hasOpenRun([handoffEvent("run.started", {}, "runtime", "run-1"), handoffEvent("terminal.recorded", {}, "harness", "other")]), true);
  assert.equal(hasOpenRun([handoffEvent("run.started", {}, "runtime", "run-1"), handoffEvent("terminal.recorded", {}, "harness", "run-1")]), false);
  assert.deepEqual(restoreHandoffState([]), { consumed: [] });
});

test("authoritative handoff source verification rejects each link, journal, and terminal mismatch", async () => {
  const link = (overrides: Partial<WorkflowSessionLink> = {}): WorkflowSessionLink => ({
    kind: "workflow", formatVersion: 1, workflowSessionId: "workflow-plan", workflowId: "plan", activationHash: "a".repeat(64),
    piSessionId: "pi-plan", piSessionFile: "/pi/plan", normalParentId: "normal", normalParentFile: "/pi/normal", status: "current",
    stale: false, model: "provider/model", thinking: "medium", tools: [], createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z", name: "hive:plan:aaaaaaaa", ...overrides,
  });
  const packet = packetFixture();

  const unlinked = fixture();
  assert.throws(() => verifyHandoffPacketSource(unlinked.projectRoot, "project-1", packet), /not linked/i);

  const wrongWorkflow = fixture();
  replaceSessionLinks(wrongWorkflow.projectRoot, [listNormal(wrongWorkflow.projectRoot), link({ workflowId: "other" })]);
  assert.throws(() => verifyHandoffPacketSource(wrongWorkflow.projectRoot, "project-1", packet), /not linked/i);

  const wrongActivation = fixture();
  replaceSessionLinks(wrongActivation.projectRoot, [listNormal(wrongActivation.projectRoot), link({ activationHash: "c".repeat(64) })]);
  assert.throws(() => verifyHandoffPacketSource(wrongActivation.projectRoot, "project-1", packet), /snapshot.*linked activation/i);

  const emptyJournal = fixture();
  replaceSessionLinks(emptyJournal.projectRoot, [listNormal(emptyJournal.projectRoot), link()]);
  assert.throws(() => verifyHandoffPacketSource(emptyJournal.projectRoot, "project-1", packet), /missing canonical project/i);

  const missingTerminal = fixture();
  replaceSessionLinks(missingTerminal.projectRoot, [listNormal(missingTerminal.projectRoot), link()]);
  appendWorkflowEvent(missingTerminal.projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "workflow-plan", type: "session.created", payload: {}, producer: "runtime" }));
  assert.throws(() => verifyHandoffPacketSource(missingTerminal.projectRoot, "project-1", packet), /one authoritative terminal/i);

  const wrongTerminal = fixture();
  replaceSessionLinks(wrongTerminal.projectRoot, [listNormal(wrongTerminal.projectRoot), link()]);
  await lifecycle(wrongTerminal.projectRoot, "workflow-plan", "a".repeat(64), "run-1");
  assert.throws(() => verifyHandoffPacketSource(wrongTerminal.projectRoot, "project-1", packet), /terminal event hash or authority/i);
});

function listNormal(projectRoot: string): NormalSessionLink {
  return listSessionLinks(projectRoot).find((entry): entry is NormalSessionLink => entry.kind === "normal")!;
}

test("selection compensates a staged handoff when target resume navigation is cancelled", async () => {
  const f = fixture();
  const source = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: "normal", workflow: workflow("plan", "a"), adapter: f.adapter, owner: f.owner("source") });
  await lifecycle(f.projectRoot, source.link.workflowSessionId, source.link.activationHash, "cancel-source");
  const packet = resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "project-1", runId: "cancel-source", currentPiSessionId: "normal" });
  await assert.rejects(() => selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: source.link.piSessionId, workflow: workflow("plan", "a"), stagedHandoff: packet, adapter: f.adapter, owner: f.owner("source") }), /different workflow/i);
  const target = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: source.link.piSessionId, workflow: workflow("build", "b"), adapter: f.adapter, owner: f.owner("target") });
  assert.equal(stageHandoff({ projectRoot: f.projectRoot, projectId: "project-1", targetSessionId: target.link.workflowSessionId, targetWorkflowId: "build", packet, now: () => "2025-01-01T00:00:00.000Z" }).staged, true);
  assert.equal(clearStagedHandoff({ projectRoot: f.projectRoot, projectId: "project-1", targetSessionId: target.link.workflowSessionId, now: () => "2025-01-01T00:00:01.000Z" }).cleared, true);
  const cancelling = { ...f.adapter, async switch() { return { cancelled: true }; } };
  await assert.rejects(() => selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: target.link.piSessionId, workflow: workflow("build", "b"), stagedHandoff: packet, adapter: cancelling, owner: f.owner("target") }), /switch cancelled/i);
  assert.equal(readHandoffState(f.projectRoot, target.link.workflowSessionId).staged, undefined, "failed navigation clears the newly staged packet");
});

test("source resolution rejects ambiguous run IDs and terminal/link snapshot drift", async () => {
  const ambiguous = fixture();
  const plan = await selectWorkflowSession({ projectRoot: ambiguous.projectRoot, projectId: "project-1", currentPiSessionId: "normal", workflow: workflow("plan", "a"), adapter: ambiguous.adapter, owner: ambiguous.owner("plan") });
  const build = await selectWorkflowSession({ projectRoot: ambiguous.projectRoot, projectId: "project-1", currentPiSessionId: plan.link.piSessionId, workflow: workflow("build", "b"), adapter: ambiguous.adapter, owner: ambiguous.owner("build") });
  await lifecycle(ambiguous.projectRoot, plan.link.workflowSessionId, plan.link.activationHash, "duplicate-run");
  await lifecycle(ambiguous.projectRoot, build.link.workflowSessionId, build.link.activationHash, "duplicate-run");
  assert.throws(() => resolveHandoffSource({ projectRoot: ambiguous.projectRoot, projectId: "project-1", runId: "duplicate-run", currentPiSessionId: "normal" }), /ambiguous/i);

  const drift = fixture();
  const selected = await selectWorkflowSession({ projectRoot: drift.projectRoot, projectId: "project-1", currentPiSessionId: "normal", workflow: workflow("plan", "a"), adapter: drift.adapter, owner: drift.owner("drift") });
  await lifecycle(drift.projectRoot, selected.link.workflowSessionId, selected.link.activationHash, "drift-run");
  replaceSessionLinks(drift.projectRoot, listSessionLinks(drift.projectRoot).map((entry) => entry.kind === "workflow" ? { ...entry, activationHash: "c".repeat(64) } : entry));
  assert.throws(() => resolveHandoffSource({ projectRoot: drift.projectRoot, projectId: "project-1", runId: "drift-run", currentPiSessionId: "normal" }), /snapshot.*linked activation/i);
});

test("handoff packet lookup finds staged and consumed packets and validates references", async () => {
  const f = fixture();
  const source = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: "normal", workflow: workflow("plan", "a"), adapter: f.adapter, owner: f.owner("source") });
  await lifecycle(f.projectRoot, source.link.workflowSessionId, source.link.activationHash, "lookup-source");
  const packet = resolveHandoffSource({ projectRoot: f.projectRoot, projectId: "project-1", runId: "lookup-source", currentPiSessionId: "normal" });
  const target = await selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: source.link.piSessionId, workflow: workflow("build", "b"), fresh: true, stagedHandoff: packet, adapter: f.adapter, owner: f.owner("target") });
  assert.equal(readHandoffPacket(f.projectRoot, target.link.workflowSessionId, packet.packetHash)?.packetHash, packet.packetHash);
  assert.equal(readHandoffPacket(f.projectRoot, target.link.workflowSessionId, "f".repeat(64)), undefined);
  const runtime = new WorkflowRunLifecycle({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: target.link.workflowSessionId, snapshotId: target.link.activationHash, rootNodeId: "root", createRunId: () => "lookup-target" });
  runtime.recordUserInput({ inputId: "lookup-input", text: "consume", source: "interactive" });
  assert.equal(readHandoffPacket(f.projectRoot, target.link.workflowSessionId, packet.packetHash)?.packetHash, packet.packetHash);
  assert.throws(() => readHandoffPacket(f.projectRoot, target.link.workflowSessionId, "bad"), /digest/i);
});
