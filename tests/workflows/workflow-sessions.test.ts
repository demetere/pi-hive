import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendWorkflowEvent } from "../../src/workflows/journal.ts";
import { createWorkflowEvent } from "../../src/workflows/events.ts";
import {
  commitWorkflowRecovery,
  commitWorkflowSelection,
  initializeNormalParent,
  listSessionLinks,
  markMissingPiSession,
  prepareWorkflowRecoveryLink,
  recordWorkflowModelState,
  recordWorkflowRecoveryBlocked,
  replaceSessionLinks,
  rollbackWorkflowRecovery,
  sameWorkflowLinkGeneration,
  upsertWorkflowLink,
  workflowLinkGenerationHash,
  type WorkflowSessionLink,
} from "../../src/workflows/sessions.ts";

const root = () => mkdtempSync(join(tmpdir(), "hive-links-"));

test("unconfigured startup is inert while configured normal startup persists its own baseline", () => {
  const project = root();
  assert.deepEqual(initializeNormalParent({ configured: false, projectRoot: project, projectId: "p", piSessionId: "normal", piSessionFile: "/pi/normal.jsonl", model: "provider/normal", thinking: "low", activeTools: ["read"] }), { configured: false, commands: [] });
  assert.equal(listSessionLinks(project).length, 0);
  const state = initializeNormalParent({ configured: true, projectRoot: project, projectId: "p", piSessionId: "normal", piSessionFile: "/pi/normal.jsonl", model: "provider/normal", thinking: "low", activeTools: ["read", "grep"] });
  assert.deepEqual(state.commands, ["hive:select", "hive:exit"]);
  const normal = listSessionLinks(project).find((entry) => entry.kind === "normal");
  assert.deepEqual(normal?.normalTools, ["grep", "read"]);
});

test("normal and workflow model/thinking/tool state remain distinct and model changes are journaled", () => {
  const project = root(); initializeNormalParent({ configured: true, projectRoot: project, projectId: "p", piSessionId: "normal", piSessionFile: "/pi/normal", model: "provider/normal", thinking: "low", activeTools: ["read"] });
  const link = { formatVersion: 1 as const, workflowSessionId: "ws", workflowId: "build", activationHash: "a".repeat(64), piSessionId: "piw", piSessionFile: "/pi/w", normalParentId: "normal", normalParentFile: "/pi/normal", status: "current" as const, stale: false, model: "provider/model", thinking: "high", tools: ["bash", "write"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), name: "hive:build:aaaaaaaa" };
  recordWorkflowModelState(project, "p", link, "provider/other", "medium", () => true);
  const stored = listSessionLinks(project).find((entry) => entry.kind === "workflow")!; assert.deepEqual(stored.tools, ["bash", "write"]); assert.equal(stored.model, "provider/other");
  const normal = listSessionLinks(project).find((entry) => entry.kind === "normal")!; assert.deepEqual(normal.normalTools, ["read"]); assert.equal(normal.normalModel, "provider/normal"); assert.equal(normal.normalThinking, "low");
  assert.throws(() => recordWorkflowModelState(project, "p", stored as any, "bad", "max", () => false), /preflight/i);
});

function workflowLink(id = "ws", overrides: Partial<WorkflowSessionLink> = {}): WorkflowSessionLink {
  return {
    kind: "workflow", formatVersion: 1, workflowSessionId: id, workflowId: "build", activationHash: "a".repeat(64),
    piSessionId: `pi-${id}`, piSessionFile: `/pi/${id}`, normalParentId: "normal", normalParentFile: "/pi/normal", status: "current",
    stale: false, model: "provider/model", thinking: "high", tools: ["write"], createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z", name: `hive:build:${id}`, ...overrides,
  };
}

test("session-link storage rejects symlink, malformed, oversized, and invalid envelopes", () => {
  for (const content of ["not-json", JSON.stringify({ formatVersion: 2, links: [] }), JSON.stringify({ formatVersion: 1, links: null })]) {
    const project = root();
    const directory = join(project, ".pi/hive/sessions");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "session-links-v1.json"), content);
    assert.throws(() => listSessionLinks(project), /JSON|invalid|Unexpected/i);
  }
  const oversized = root();
  mkdirSync(join(oversized, ".pi/hive/sessions"), { recursive: true });
  writeFileSync(join(oversized, ".pi/hive/sessions/session-links-v1.json"), "x".repeat(1_048_577));
  assert.throws(() => listSessionLinks(oversized), /limit/i);

  const symlinked = root();
  mkdirSync(join(symlinked, ".pi/hive/sessions"), { recursive: true });
  writeFileSync(join(symlinked, "outside.json"), JSON.stringify({ formatVersion: 1, links: [] }));
  symlinkSync(join(symlinked, "outside.json"), join(symlinked, ".pi/hive/sessions/session-links-v1.json"));
  assert.throws(() => listSessionLinks(symlinked), /path[_ ]invalid/i);

  const tooLargeToWrite = root();
  assert.throws(() => replaceSessionLinks(tooLargeToWrite, [workflowLink("huge", { name: "x".repeat(1_048_577) })]), /limit/i);
});

test("session-link sorting, replacement, and selection CAS cover every link kind", () => {
  const project = root();
  const normals = [
    { kind: "normal" as const, formatVersion: 1 as const, projectId: "p", piSessionId: "z", piSessionFile: "/z", normalModel: "m", normalThinking: "l", normalTools: [], createdAt: "t", updatedAt: "t" },
    { kind: "normal" as const, formatVersion: 1 as const, projectId: "p", piSessionId: "a", piSessionFile: "/a", normalModel: "m", normalThinking: "l", normalTools: [], createdAt: "t", updatedAt: "t" },
  ];
  replaceSessionLinks(project, [workflowLink("z"), normals[0], workflowLink("a"), normals[1]]);
  assert.deepEqual(listSessionLinks(project).map((link) => link.kind === "normal" ? `n:${link.piSessionId}` : `w:${link.workflowSessionId}`), ["n:a", "n:z", "w:a", "w:z"]);
  assert.equal(sameWorkflowLinkGeneration(workflowLink("a"), workflowLink("a")), true);
  assert.equal(sameWorkflowLinkGeneration(workflowLink("a"), workflowLink("a", { model: "other" })), false);

  const selected = workflowLink("selected");
  assert.throws(() => commitWorkflowSelection(project, "build", undefined, undefined, selected), /concurrent/i);
  replaceSessionLinks(project, [normals[0], workflowLink("current")]);
  commitWorkflowSelection(project, "build", "current", workflowLink("current", { status: "archived" }), selected);
  assert.deepEqual(listSessionLinks(project).filter((link) => link.kind === "workflow").map((link) => link.status).sort(), ["archived", "current"]);
  upsertWorkflowLink(project, { ...selected, model: "replacement" });
  assert.equal((listSessionLinks(project).find((link) => link.kind === "workflow" && link.workflowSessionId === "selected") as WorkflowSessionLink).model, "replacement");
});

test("unrelated normal startup preserves the canonical parent while same-session restart refreshes its baseline", () => {
  const project = root();
  initializeNormalParent({ configured: true, projectRoot: project, projectId: "p", piSessionId: "normal", piSessionFile: "/pi/normal", model: "m", thinking: "low", activeTools: [] });
  const createdAt = listSessionLinks(project).find((entry) => entry.kind === "normal")!.createdAt;
  initializeNormalParent({ configured: true, projectRoot: project, projectId: "p", piSessionId: "unrelated", piSessionFile: "/pi/unrelated", model: "other", thinking: "high", activeTools: ["bash"] });
  let normal = listSessionLinks(project).find((entry) => entry.kind === "normal")!;
  assert.deepEqual({ id: normal.piSessionId, file: normal.piSessionFile, model: normal.normalModel, tools: normal.normalTools }, { id: "normal", file: "/pi/normal", model: "m", tools: [] });
  initializeNormalParent({ configured: true, projectRoot: project, projectId: "p", piSessionId: "normal", piSessionFile: "/pi/normal", model: "m2", thinking: "high", activeTools: ["read"] });
  normal = listSessionLinks(project).find((entry) => entry.kind === "normal")!;
  assert.equal(normal.createdAt, createdAt);
  assert.deepEqual({ model: normal.normalModel, thinking: normal.normalThinking, tools: normal.normalTools }, { model: "m2", thinking: "high", tools: ["read"] });

  upsertWorkflowLink(project, workflowLink("missing"));
  markMissingPiSession(project, "p", "missing");
  const first = listSessionLinks(project).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.workflowSessionId === "missing")!;
  markMissingPiSession(project, "p", "missing");
  const second = listSessionLinks(project).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.workflowSessionId === "missing")!;
  assert.equal(second.orphanedAt, first.orphanedAt);
  markMissingPiSession(project, "p", "unlinked");
});

test("recovery-link helpers fail closed on missing and changed generations", () => {
  const missing = root();
  const expected = workflowLink("expected", { orphaned: true });
  assert.throws(() => recordWorkflowRecoveryBlocked(missing, "p", expected, ["B", "A", "A"], "diagnostic"), /missing/i);

  const changed = root();
  replaceSessionLinks(changed, [{ ...expected, model: "changed" }]);
  assert.throws(() => recordWorkflowRecoveryBlocked(changed, "p", expected, ["X"], "diagnostic"), /changed/i);
  assert.throws(() => rollbackWorkflowRecovery(changed, workflowLink("one"), workflowLink("two"), "hash"), /identity mismatch/i);
  assert.throws(() => rollbackWorkflowRecovery(changed, workflowLink("one"), workflowLink("one"), "hash"), /exact prepared generation/i);
  const prepared = workflowLink("one", { recovery: { state: "prepared", previousPiSessionId: "old", previousPiSessionFile: "/old", preparedAt: "2025-01-01T00:00:00.000Z", preparedEventHash: "e".repeat(64), expectedLinkHash: "f".repeat(64) } });
  assert.throws(() => rollbackWorkflowRecovery(changed, prepared, workflowLink("one"), "e".repeat(64)), /missing/i);

  assert.equal(workflowLinkGenerationHash(expected).length, 64);
});

test("recovery-link journal matching rejects each inconsistent preparation field", () => {
  const expected = workflowLink("recover", { orphaned: true });
  const replacement = { piSessionId: "new-pi", piSessionFile: "/pi/new", preparedAt: "2025-01-02T00:00:00.000Z" };
  const validPayload = {
    expectedLinkHash: workflowLinkGenerationHash(expected), expectedLink: expected,
    previousPiSessionId: expected.piSessionId, previousPiSessionFile: expected.piSessionFile,
    piSessionId: replacement.piSessionId, piSessionFile: replacement.piSessionFile,
    activationHash: expected.activationHash, preparedAt: replacement.preparedAt,
  };
  const variants: unknown[] = [
    null,
    { ...validPayload, expectedLinkHash: "bad" },
    { ...validPayload, expectedLink: { ...expected, model: "changed" } },
    { ...validPayload, previousPiSessionId: "bad" },
    { ...validPayload, previousPiSessionFile: "bad" },
    { ...validPayload, piSessionId: "bad" },
    { ...validPayload, piSessionFile: "bad" },
    { ...validPayload, activationHash: "bad" },
    { ...validPayload, preparedAt: "2026-01-01T00:00:00.000Z" },
  ];
  for (const [index, payload] of variants.entries()) {
    const project = root(); replaceSessionLinks(project, [expected]);
    const event = appendWorkflowEvent(project, createWorkflowEvent({ projectId: "p", sessionId: expected.workflowSessionId, type: "session.recovery.prepared", payload: payload as never, producer: "recovery" }));
    assert.throws(() => prepareWorkflowRecoveryLink(project, expected, { ...replacement, preparedEventHash: event.eventHash }), /missing or inconsistent/i, `variant ${index}`);
  }
});

test("recovery-link preparation, rollback, and commit enforce exact persisted generations", () => {
  const expected = workflowLink("protocol", { orphaned: true, orphanedAt: "2025-01-01T00:00:00.000Z" });
  const preparedAt = "2025-01-02T00:00:00.000Z";
  const createPreparation = (project: string) => {
    replaceSessionLinks(project, [expected]);
    const event = appendWorkflowEvent(project, createWorkflowEvent({
      projectId: "p", sessionId: expected.workflowSessionId, type: "session.recovery.prepared", producer: "recovery", timestamp: preparedAt,
      payload: {
        expectedLinkHash: workflowLinkGenerationHash(expected), expectedLink: expected as never,
        previousPiSessionId: expected.piSessionId, previousPiSessionFile: expected.piSessionFile,
        piSessionId: "new-pi", piSessionFile: "/pi/new", activationHash: expected.activationHash, preparedAt,
      },
    }));
    return { event, replacement: { piSessionId: "new-pi", piSessionFile: "/pi/new", preparedAt, preparedEventHash: event.eventHash } };
  };

  const rollbackProject = root();
  const rollbackPreparation = createPreparation(rollbackProject);
  const preparedForRollback = prepareWorkflowRecoveryLink(rollbackProject, expected, rollbackPreparation.replacement);
  assert.equal(rollbackWorkflowRecovery(rollbackProject, preparedForRollback, expected, rollbackPreparation.event.eventHash), true);
  assert.equal(sameWorkflowLinkGeneration(listSessionLinks(rollbackProject).find((entry) => entry.kind === "workflow")!, expected), true);

  const commitProject = root();
  const commitPreparation = createPreparation(commitProject);
  const preparedForCommit = prepareWorkflowRecoveryLink(commitProject, expected, commitPreparation.replacement);
  const recoveredAt = "2025-01-03T00:00:00.000Z";
  const recoveredEvent = appendWorkflowEvent(commitProject, createWorkflowEvent({
    projectId: "p", sessionId: expected.workflowSessionId, type: "session.recovered", producer: "recovery", timestamp: recoveredAt,
    payload: {
      preparedEventHash: commitPreparation.event.eventHash,
      previousPiSessionId: expected.piSessionId, previousPiSessionFile: expected.piSessionFile,
      piSessionId: preparedForCommit.piSessionId, piSessionFile: preparedForCommit.piSessionFile,
      activationHash: preparedForCommit.activationHash, recoveredAt,
    },
  }));
  const committed = commitWorkflowRecovery(commitProject, preparedForCommit, { recoveredAt, preparedEventHash: commitPreparation.event.eventHash, eventHash: recoveredEvent.eventHash });
  assert.equal(committed.orphaned, false);
  assert.equal(committed.recovery?.state, "recovered");

  const changedProject = root();
  const changedPreparation = createPreparation(changedProject);
  replaceSessionLinks(changedProject, [{ ...expected, model: "changed" }]);
  assert.throws(() => prepareWorkflowRecoveryLink(changedProject, expected, changedPreparation.replacement), /changed during recovery preparation/i);

  const missingProject = root();
  const missingPreparation = createPreparation(missingProject);
  replaceSessionLinks(missingProject, []);
  assert.throws(() => prepareWorkflowRecoveryLink(missingProject, expected, missingPreparation.replacement), /link is missing/i);

  replaceSessionLinks(commitProject, [{ ...preparedForCommit, model: "changed" }]);
  assert.throws(() => commitWorkflowRecovery(commitProject, preparedForCommit, { recoveredAt, preparedEventHash: commitPreparation.event.eventHash, eventHash: recoveredEvent.eventHash }), /changed during recovery commit/i);
  replaceSessionLinks(commitProject, []);
  assert.throws(() => commitWorkflowRecovery(commitProject, preparedForCommit, { recoveredAt, preparedEventHash: commitPreparation.event.eventHash, eventHash: recoveredEvent.eventHash }), /link is missing/i);
});

test("recovery-link journal matching rejects each inconsistent commit field", () => {
  const recovery = { state: "prepared" as const, previousPiSessionId: "old", previousPiSessionFile: "/old", preparedAt: "2025-01-01T00:00:00.000Z", preparedEventHash: "a".repeat(64), expectedLinkHash: "b".repeat(64) };
  const prepared = workflowLink("commit", { orphaned: true, recovery, piSessionId: "new", piSessionFile: "/new" });
  const replacement = { recoveredAt: "2025-01-02T00:00:00.000Z", preparedEventHash: recovery.preparedEventHash };
  const validPayload = {
    preparedEventHash: replacement.preparedEventHash, previousPiSessionId: recovery.previousPiSessionId, previousPiSessionFile: recovery.previousPiSessionFile,
    piSessionId: prepared.piSessionId, piSessionFile: prepared.piSessionFile, activationHash: prepared.activationHash, recoveredAt: replacement.recoveredAt,
  };
  const variants: unknown[] = [
    null,
    { ...validPayload, preparedEventHash: "bad" },
    { ...validPayload, previousPiSessionId: "bad" },
    { ...validPayload, previousPiSessionFile: "bad" },
    { ...validPayload, piSessionId: "bad" },
    { ...validPayload, piSessionFile: "bad" },
    { ...validPayload, activationHash: "bad" },
    { ...validPayload, recoveredAt: "bad" },
  ];
  for (const [index, payload] of variants.entries()) {
    const project = root(); replaceSessionLinks(project, [prepared]);
    const event = appendWorkflowEvent(project, createWorkflowEvent({ projectId: "p", sessionId: prepared.workflowSessionId, type: "session.recovered", payload: payload as never, producer: "recovery" }));
    assert.throws(() => commitWorkflowRecovery(project, prepared, { ...replacement, eventHash: event.eventHash }), /missing or inconsistent/i, `variant ${index}`);
  }
});
