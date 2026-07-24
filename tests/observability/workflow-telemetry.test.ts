import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkflowEvent, sealWorkflowEvent, type WorkflowEventEnvelope } from "../../src/workflows/events.ts";
import { appendWorkflowEvent, configureWorkflowJournalRedaction, readWorkflowJournal } from "../../src/workflows/journal.ts";
import { terminalEnvelopeFromEvent } from "../../src/workflows/runs.ts";
import {
  WORKFLOW_TELEMETRY_LIMITS,
  WORKFLOW_TELEMETRY_SCHEMA_VERSION,
  restoreWorkflowTelemetryEvent,
  toWorkflowTelemetryEvent,
} from "../../src/observability/events.ts";
import {
  WORKFLOW_PROJECTION_IN_MEMORY_EVENT_LIMIT,
  ProjectionStreamError,
  WorkflowTelemetryProjection,
  rebuildWorkflowProjection,
  rebuildWorkflowProjectionFromJournals,
} from "../../src/observability/projection.ts";
import { redactJournalPayload, redactProjectionValue } from "../../src/observability/redaction.ts";
import {
  previewWorkflowJournalPrune,
  createWorkflowJournalPruneService,
} from "../../src/observability/journal-prune.ts";

function chain(inputs: Array<{ id: string; type?: WorkflowEventEnvelope["type"]; runId?: string; payload: Record<string, unknown>; timestamp?: string }>): WorkflowEventEnvelope[] {
  const out: WorkflowEventEnvelope[] = [];
  for (const [index, input] of inputs.entries()) {
    const draft = createWorkflowEvent({
      eventId: input.id,
      projectId: "project-1",
      sessionId: "workflow-session-1",
      ...(input.runId ? { runId: input.runId } : {}),
      type: input.type ?? "artifact.recorded",
      producer: "harness",
      timestamp: input.timestamp ?? `2026-07-20T00:00:${String(index).padStart(2, "0")}.000Z`,
      payload: input.payload as never,
    });
    out.push(sealWorkflowEvent(draft, index + 1, out.at(-1)?.eventHash ?? null));
  }
  return out;
}

const context = {
  projectRoot: "/work/project",
  projectLabel: "project",
  piSessionId: "pi-session-1",
  workflowId: "delivery",
  snapshotId: "snapshot-1",
  workflowConfigHash: "a".repeat(64),
  workflowConfigVersion: "1",
};

test("workflow telemetry envelope is generic, versioned, bounded, and omits raw content", () => {
  const [source] = chain([{
    id: "event-all-dimensions",
    runId: "run-1",
    payload: {
      formatVersion: 1,
      operation: "provider-call",
      operationId: "operation-1",
      attemptId: "attempt-1",
      agentId: "agent-1",
      agentName: "Builder",
      nodeId: "node-1",
      parentNodeId: "root",
      taskId: "task-1",
      adapterId: "openspec",
      adapterVersion: "2",
      profileId: "delivery",
      profileVersion: "3",
      workspaceId: "workspace-1",
      workspaceHash: `sha256:${"b".repeat(64)}`,
      leaseState: "owned",
      questionId: "question-1",
      checkpointId: "checkpoint-1",
      approvalId: "approval-1",
      knowledgeJobId: "job-1",
      knowledgeUpdateId: "update-1",
      modelId: "provider/model",
      thinking: "high",
      toolName: "bash",
      capabilityId: "shell.mutate",
      status: "running",
      elapsedMs: 125,
      activeWallTimeMs: 100,
      budgetScope: "run",
      budgetUsed: 12,
      budgetLimit: 20,
      budgetRemaining: 8,
      summary: "x".repeat(10_000),
      transcript: "raw transcript must not persist",
      prompt: "raw prompt must not persist",
      toolArgs: { command: "curl -H 'Authorization: Bearer secret-token'" },
      toolResult: "unrestricted result",
      refs: ["artifact:one"],
    },
  }]);
  const event = toWorkflowTelemetryEvent(source, context);
  assert.equal(event.schemaVersion, WORKFLOW_TELEMETRY_SCHEMA_VERSION);
  assert.match(event.streamId, /^wfs1-[0-9a-f]{64}$/);
  assert.equal(event.sequence, source.sequence);
  assert.equal(event.previousHash, source.previousHash);
  assert.equal(event.sourceEventHash, source.eventHash);
  assert.match(event.eventHash, /^[0-9a-f]{64}$/);
  const expectedDimensions = {
    projectId: "project-1", projectRoot: "/work/project", piSessionId: "pi-session-1",
    workflowId: "delivery", snapshotId: "snapshot-1", runId: "run-1",
    agentId: "agent-1", agentName: "Builder", nodeId: "node-1", parentNodeId: "root", taskId: "task-1",
    adapterId: "openspec", profileId: "delivery", workspaceId: "workspace-1",
    questionId: "question-1", checkpointId: "checkpoint-1", approvalId: "approval-1",
    knowledgeJobId: "job-1", knowledgeUpdateId: "update-1", modelId: "provider/model",
    thinking: "high", toolName: "bash", capabilityId: "shell.mutate",
    attemptId: "attempt-1", operationId: "operation-1",
  };
  for (const [key, value] of Object.entries(expectedDimensions)) {
    assert.equal((event.dimensions as unknown as Record<string, unknown>)[key], value, key);
  }
  assert.ok(Buffer.byteLength(event.summary ?? "") <= 2_048);
  assert.deepEqual(event.metrics, { elapsedMs: 125, activeWallTimeMs: 100, budgetScope: "run", budgetUsed: 12, budgetLimit: 20, budgetRemaining: 8 });
  const persisted = JSON.stringify(event);
  assert.doesNotMatch(persisted, /raw transcript|raw prompt|unrestricted result|secret-token/);
  assert.doesNotMatch(persisted, /planning|hiveTeam|planId/);
});

test("redaction removes credentials, secret environment values, and protected-path content before persistence", () => {
  const environment = { PUBLIC_NAME: "visible", SERVICE_TOKEN: "env-secret-value" };
  const value = {
    authorization: "Bearer header-secret",
    note: "SERVICE_TOKEN=env-secret-value password=hunter2",
    headers: { Authorization: "Basic dXNlcjpwYXNz" },
    path: ".pi/hive/private/credential.txt",
    content: "protected-content",
    nested: [{ apiKey: "key-secret" }],
  };
  const redacted = redactJournalPayload(value, { environment, protectedPaths: [".pi/hive/private"] });
  const text = JSON.stringify(redacted);
  assert.doesNotMatch(text, /header-secret|env-secret-value|hunter2|dXNlcjpwYXNz|protected-content|key-secret/);
  assert.match(text, /\[REDACTED\]/);
  assert.equal((redacted as any).note.length <= 2_048, true);

  const journal = redactJournalPayload({ audit: "keep", password: "journal-secret", summary: "y".repeat(200_000) });
  assert.equal((journal as any).audit, "keep");
  assert.equal((journal as any).password, "[REDACTED]");
  assert.ok(Buffer.byteLength((journal as any).summary) <= 131_072);
  const draft = createWorkflowEvent({ projectId: "project-1", sessionId: "session-redaction", type: "artifact.recorded", producer: "runtime", payload: { authorization: "Bearer journal-token", audit: "keep" } });
  assert.equal(JSON.stringify(draft).includes("journal-token"), false, "workflow journal drafts are redacted before append");
});

test("protected-path aliases taint nested content without relying on a tiny exact key list", () => {
  for (const key of ["canonicalPath", "config_path", "sourceFile", "workingDirectory", "artifactRoot"]) {
    const redacted = redactJournalPayload({ [key]: ".pi/hive/private/item.json", nested: { content: "nested-private-content", deeper: [{ body: "nested-private-body" }] } });
    assert.doesNotMatch(JSON.stringify(redacted), /nested-private-content|nested-private-body/);
  }
  assert.equal((redactJournalPayload({ profile: "public", content: "visible" }) as any).content, "visible", "ordinary keys ending in the letters 'file' are not path aliases");
});

test("credential header aliases and protected-object content aliases are redacted before journaling", () => {
  const secrets = ["header-api-secret", "header-auth-secret", "normalized-api-secret", "normalized-auth-secret", "protected-data", "protected-file-content", "protected-raw", "protected-value"];
  const draft = createWorkflowEvent({
    eventId: "alias-redaction",
    projectId: "project-1",
    sessionId: "alias-redaction-session",
    type: "artifact.recorded",
    producer: "harness",
    payload: {
      headers: {
        "X-API-Key": secrets[0],
        "X-Auth-Token": secrets[1],
        x_api_key: secrets[2],
        xAuthToken: secrets[3],
      },
      path: ".pi/hive/private/aliases.json",
      nested: { data: secrets[4], deeper: [{ fileContent: secrets[5], raw: secrets[6], value: secrets[7] }] },
    },
  });
  const persistedDraft = JSON.stringify(draft);
  for (const secret of secrets) assert.doesNotMatch(persistedDraft, new RegExp(secret));
  assert.match(persistedDraft, /\[REDACTED\]/);

  const publicMetadata = redactJournalPayload({
    xApiKeyMetadata: "public-description",
    apiKeyDescription: "public-api-description",
    metadata: { data: "public-data", fileContent: "public-file-content", raw: "public-raw", value: "public-value" },
  }, { environment: {} }) as any;
  assert.equal(publicMetadata.xApiKeyMetadata, "public-description");
  assert.equal(publicMetadata.apiKeyDescription, "public-api-description");
  assert.deepEqual(publicMetadata.metadata, { data: "public-data", fileContent: "public-file-content", raw: "public-raw", value: "public-value" });
});

test("projection from an authoritative journal is deterministic across environment changes", () => {
  const variable = "W24_REBUILD_SECRET";
  const prior = process.env[variable];
  delete process.env[variable];
  const [source] = chain([{ id: "deterministic-redaction", payload: { formatVersion: 1, summary: "plain-value-that-later-becomes-secret" } }]);
  const before = toWorkflowTelemetryEvent(source, context);
  process.env[variable] = "plain-value-that-later-becomes-secret";
  try {
    const after = toWorkflowTelemetryEvent(source, { ...context, redaction: { environment: process.env } });
    assert.equal(after.eventHash, before.eventHash);
    assert.deepEqual(after, before);
  } finally {
    if (prior === undefined) delete process.env[variable]; else process.env[variable] = prior;
  }
});

test("projection ingestion is event-ID idempotent and fail-stops only a corrupt stream", () => {
  const source = chain([
    { id: "event-1", payload: { formatVersion: 1, operation: "start", status: "running" } },
    { id: "event-2", payload: { formatVersion: 1, operation: "finish", status: "completed" } },
  ]).map((event) => toWorkflowTelemetryEvent(event, context));
  const projection = new WorkflowTelemetryProjection();
  assert.equal(projection.ingest(source[0]), "inserted");
  assert.equal(projection.ingest(source[0]), "duplicate");
  assert.equal(projection.history({ limit: 10 }).items.length, 1);

  const skippedDraft = createWorkflowEvent({ eventId: "skipped", projectId: "project-1", sessionId: "workflow-session-1", type: "artifact.recorded", producer: "harness", payload: { formatVersion: 1 } });
  const skipped = toWorkflowTelemetryEvent(sealWorkflowEvent(skippedDraft, 3, source[0].sourceEventHash), context);
  assert.throws(() => projection.ingest(skipped), ProjectionStreamError);
  assert.equal(projection.streamStatus(source[0].streamId).state, "blocked");
  assert.throws(() => projection.ingest(source[1]), /blocked/i);

  const otherDraft = createWorkflowEvent({ eventId: "other-1", projectId: "project-2", sessionId: "session-2", type: "artifact.recorded", producer: "harness", payload: { formatVersion: 1, status: "running" } });
  const otherEvent = toWorkflowTelemetryEvent(sealWorkflowEvent(otherDraft, 1, null), context);
  assert.equal(projection.ingest(otherEvent), "inserted", "an unrelated stream remains available");
});

test("incremental and rebuild projections are deterministic and expose current, history, usage, and stable bounded pages", () => {
  const source = chain([
    { id: "run-start", type: "run.started", runId: "run-1", payload: { formatVersion: 1, status: "running", nodeId: "root" } },
    { id: "task-start", type: "task.started", runId: "run-1", payload: { formatVersion: 1, taskId: "task-1", nodeId: "worker", parentNodeId: "root", status: "running" } },
    { id: "estimated", type: "budget.model.usage.recorded", runId: "run-1", payload: { formatVersion: 1, nodeId: "worker", usage: { inputTokens: 10, outputTokens: 5, costMicroUsd: 20, precision: "estimated" } } },
    { id: "confirmed", type: "knowledge.transition", runId: "run-1", payload: { formatVersion: 1, operation: "curator-model-usage", jobId: "job-1", usage: { inputTokens: 7, outputTokens: 3, costMicroUsd: 11, precision: "provider-confirmed" } } },
    { id: "terminal", type: "terminal.recorded", runId: "run-1", payload: { formatVersion: 1, status: "completed", summary: "done", changeCoverage: "scoped-reconciled", terminalEventHash: `sha256:${"c".repeat(64)}`, refs: ["artifact:result"] } },
  ]).map((event) => toWorkflowTelemetryEvent(event, context));

  const incremental = new WorkflowTelemetryProjection();
  for (const event of source) incremental.ingest(event);
  const rebuilt = rebuildWorkflowProjection([source]);
  assert.deepEqual(rebuilt.snapshot(), incremental.snapshot());

  const current = incremental.current();
  assert.equal(current.sessions[0].workflowId, "delivery");
  assert.equal(current.runs[0].status, "completed");
  assert.equal(current.tasks[0].taskId, "task-1");
  assert.equal(current.knowledge[0].knowledgeJobId, "job-1");
  assert.deepEqual(incremental.usage(), {
    estimated: { inputTokens: 10, outputTokens: 5, costMicroUsd: 20 },
    providerConfirmed: { inputTokens: 7, outputTokens: 3, costMicroUsd: 11 },
  });
  assert.equal(incremental.history({ limit: 10 }).items.at(-1)?.terminal?.changeCoverage, "scoped-reconciled");

  const first = incremental.history({ limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.hasMore, true);
  const second = incremental.history({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(first.items.map((event) => event.eventId).filter((id) => second.items.some((event) => event.eventId === id)), []);
  assert.throws(() => incremental.history({ limit: 501 }), /limit/i);

  const pruned = incremental.pruneProjection("2026-07-20T00:00:04.000Z");
  assert.equal(pruned.removed, 4);
  assert.equal(incremental.current().runs[0].status, "completed", "projection pruning retains materialized current state");
  assert.equal(source.length, 5, "authoritative source arrays are untouched");
});

test("question, approval, workspace, knowledge, and terminal transitions materialize without workflow-name semantics", () => {
  const source = chain([
    { id: "transition-run", type: "run.started", runId: "run-1", payload: { formatVersion: 1 } },
    { id: "transition-workspace", type: "artifact.recorded", runId: "run-1", payload: { formatVersion: 1, operation: "bind", workspace: { id: "workspace-1" }, workspaceHash: `sha256:${"d".repeat(64)}`, leaseState: "owned" } },
    { id: "transition-question-create", type: "question.transition", runId: "run-1", payload: { formatVersion: 1, operation: "create", questionId: "question-1", nodeId: "root" } },
    { id: "transition-question-answer", type: "question.transition", runId: "run-1", payload: { formatVersion: 1, operation: "answer", questionId: "question-1", nodeId: "root" } },
    { id: "transition-approval-request", type: "approval.recorded", runId: "run-1", payload: { formatVersion: 1, operation: "request", requestId: "request-1", checkpointId: "verify" } },
    { id: "transition-approval-decision", type: "approval.recorded", runId: "run-1", payload: { formatVersion: 1, operation: "decision", requestId: "request-1", decision: { verdict: "approved" } } },
    { id: "transition-knowledge", type: "knowledge.transition", runId: "run-1", payload: { formatVersion: 1, operation: "job-transition", jobId: "job-1", from: "running", to: "completed" } },
    { id: "transition-terminal", type: "terminal.recorded", runId: "run-1", payload: { formatVersion: 1, status: "completed", changeCoverage: "recorded" } },
  ]).map((event) => toWorkflowTelemetryEvent(event, { ...context, workflowId: "arbitrary-user-workflow" }));
  const projection = rebuildWorkflowProjection([source]);
  const current = projection.current();
  assert.equal(current.workspaces[0].workspaceId, "workspace-1");
  assert.equal(current.questions[0].status, "answered");
  assert.equal(current.approvals[0].status, "approved");
  assert.equal(current.knowledge[0].status, "completed");
  assert.equal(current.runs[0].status, "completed");
  assert.equal(JSON.stringify(projection.snapshot()).includes("arbitrary-user-workflow"), true);
});

test("authority-owned journal pruning is fail-closed, crash-recoverable, and idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-journal-prune-"));
  const projectId = "project-1";
  const sessionId = "session-1";
  const service = createWorkflowJournalPruneService({ authenticate: (credential) => credential === "ok" ? "operator" : undefined });
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "open", projectId, sessionId, runId: "run-open", type: "run.started", producer: "runtime", payload: { formatVersion: 1 } }));
  assert.throws(() => previewWorkflowJournalPrune(root, sessionId), /nonterminal|open/i);
  assert.throws(() => service.prune({ projectRoot: root, sessionId, credential: "bad", confirmIrrecoverable: true, operationId: "prune-1", authenticate: () => "spoof" } as never), /unknown|auth/i);

  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "closed", projectId, sessionId, runId: "run-open", type: "terminal.recorded", producer: "harness", payload: { formatVersion: 1, status: "completed" } }));
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "reopened", projectId, sessionId, runId: "run-open", type: "run.transition", producer: "runtime", payload: { formatVersion: 1, from: "completed", to: "running" } }));
  assert.throws(() => previewWorkflowJournalPrune(root, sessionId), /nonterminal|open/i);
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "reclosed", projectId, sessionId, runId: "run-open", type: "terminal.recorded", producer: "harness", payload: { formatVersion: 1, status: "completed" } }));
  assert.throws(() => service.prune({ projectRoot: root, sessionId, credential: "ok", confirmIrrecoverable: false, operationId: "prune-1" }), /confirm/i);
  const crashing = createWorkflowJournalPruneService({ authenticate: () => "operator", fault: (stage) => { if (stage === "afterDetach") throw new Error("simulated crash"); } });
  assert.throws(() => crashing.prune({ projectRoot: root, sessionId, credential: "ok", confirmIrrecoverable: true, operationId: "prune-1" }), /simulated crash/);
  const result = service.prune({ projectRoot: root, sessionId, credential: "ok", confirmIrrecoverable: true, operationId: "prune-1" });
  assert.equal(result.deletedEvents, 4);
  assert.equal(result.authenticatedIdentity, "operator");
  assert.equal(service.prune({ projectRoot: root, sessionId, credential: "ok", confirmIrrecoverable: true, operationId: "prune-1" }).deletedEvents, 4);
  assert.deepEqual(readWorkflowJournal(root, sessionId), []);
});

test("concurrent prune identities cannot overwrite the operation receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-journal-prune-race-"));
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "started", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "run.started", producer: "runtime", payload: { formatVersion: 1 } }));
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "terminal", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "terminal.recorded", producer: "runtime", payload: { formatVersion: 1, status: "completed" } }));
  const script = `import {writeFileSync,existsSync} from 'node:fs'; import {createWorkflowJournalPruneService} from './src/observability/journal-prune.ts'; const [root,identity]=process.argv.slice(1); const service=createWorkflowJournalPruneService({authenticate(){writeFileSync(root+'/ready-'+identity,'1'); while(!existsSync(root+'/go')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); return identity;}}); try { const value=service.prune({projectRoot:root,sessionId:'session-1',credential:'ok',operationId:'same-operation',confirmIrrecoverable:true}); console.log(JSON.stringify({ok:true,identity:value.authenticatedIdentity})); } catch(error) { console.log(JSON.stringify({ok:false,error:String(error)})); }`;
  const children = ["operator-a", "operator-b"].map((identity) => spawn(process.execPath, ["--import", "tsx", "--import", "./tests/helpers/register-ts-loader.mjs", "--input-type=module", "-e", script, root, identity], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }));
  while (!existsSync(join(root, "ready-operator-a")) || !existsSync(join(root, "ready-operator-b"))) await new Promise((resolve) => setTimeout(resolve, 5));
  writeFileSync(join(root, "go"), "1");
  const results = await Promise.all(children.map(async (child) => { const output: Buffer[] = []; child.stdout.on("data", (chunk) => output.push(chunk)); await once(child, "exit"); return JSON.parse(Buffer.concat(output).toString().trim()); }));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && /different authenticated identity/.test(result.error)).length, 1);
});

test("journal pruning refuses lifecycle events whose run identity is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-journal-prune-missing-run-"));
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "missing-run", projectId: "project-1", sessionId: "session-1", type: "run.started", producer: "runtime", payload: { formatVersion: 1 } }));
  const before = readWorkflowJournal(root, "session-1");
  assert.throws(() => previewWorkflowJournalPrune(root, "session-1"), /run.*identity|runId|nonterminal/i);
  assert.equal(readWorkflowJournal(root, "session-1").length, before.length);
});

test("projection rebuild consumes explicit workflow journal registrations without treating a registry as authority", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-journal-rebuild-"));
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "registered-1", projectId: "project-1", sessionId: "registered", runId: "run-1", type: "run.started", producer: "runtime", payload: { formatVersion: 1, status: "running" } }));
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "registered-2", projectId: "project-1", sessionId: "registered", runId: "run-1", type: "terminal.recorded", producer: "harness", payload: { formatVersion: 1, status: "completed" } }));
  const rebuilt = rebuildWorkflowProjectionFromJournals([{ projectRoot: root, sessionId: "registered", context: { workflowId: "delivery", snapshotId: "snapshot" } }]);
  assert.equal(rebuilt.history({ limit: 10 }).items.length, 2);
  assert.equal(rebuilt.current().runs[0].status, "completed");
  assert.equal(rebuilt.current().runs[0].workflowId, "delivery");
});

test("projection authentication rejects forged hashes, first events, and colliding colon identities", () => {
  const left = chain([{ id: "left", payload: { formatVersion: 1, status: "running" } }])[0];
  const rightDraft = createWorkflowEvent({ eventId: "right", projectId: "project-1:workflow", sessionId: "session-1", type: "run.started", producer: "harness", payload: { formatVersion: 1 } });
  const right = toWorkflowTelemetryEvent(sealWorkflowEvent(rightDraft, 1, null));
  const projected = toWorkflowTelemetryEvent(left);
  assert.notEqual(projected.streamId, right.streamId);
  const projection = new WorkflowTelemetryProjection();
  assert.throws(() => projection.ingest({ ...projected, eventHash: "f".repeat(64) }), /authentic|hash|trusted/i);
  assert.throws(() => projection.ingest({ ...projected, payloadHash: "not-a-hash" }), /authentic|hash|trusted/i);
  for (const replacement of [
    { dimensions: { ...projected.dimensions, workflowId: "forged" } },
    { status: "forged" },
    { usage: { inputTokens: 999, outputTokens: 0, costMicroUsd: 0, precision: "estimated" as const } },
    { metadata: { forged: true } },
  ]) {
    const forged = Object.create(Object.getPrototypeOf(projected));
    Object.defineProperties(forged, Object.fromEntries(Reflect.ownKeys(projected).map((key) => [key, { ...Object.getOwnPropertyDescriptor(projected, key)!, configurable: true, writable: true }])));
    Object.assign(forged, replacement);
    assert.throws(() => projection.ingest(forged), /projected event hash/i);
  }
  assert.equal(projection.streamStatus(projected.streamId).lastSequence, 0);
});

test("current state ignores incidental usage, preserves entity status, and remains bounded", () => {
  const source = chain([
    { id: "state-run", type: "run.started", runId: "run-1", payload: { formatVersion: 1, status: "running", nodeId: "root" } },
    { id: "state-usage", type: "budget.model.usage.recorded", runId: "run-1", payload: { formatVersion: 1, nodeId: "root", usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1, precision: "estimated" } } },
    { id: "state-terminal", type: "terminal.recorded", runId: "run-1", payload: { formatVersion: 1, status: "completed" } },
  ]).map((event) => toWorkflowTelemetryEvent(event, context));
  const projection = rebuildWorkflowProjection([source]);
  assert.equal(projection.current().runs[0].status, "completed");
  assert.equal(projection.current().sessions[0]?.status, undefined, "a run terminal must not close its session");
  assert.equal(projection.current().nodes[0].status, "running", "usage must not erase node state");
});

test("projection prune and blocked-stream duplicate semantics remain authority-equivalent", () => {
  const source = chain([
    { id: "prune-start", type: "run.started", runId: "run-1", payload: { formatVersion: 1 } },
    { id: "prune-usage", type: "budget.model.usage.recorded", runId: "run-1", payload: { formatVersion: 1, usage: { inputTokens: 4, outputTokens: 2, costMicroUsd: 8, precision: "estimated" } } },
  ]).map((event) => toWorkflowTelemetryEvent(event, context));
  const projection = rebuildWorkflowProjection([source]);
  assert.throws(() => projection.ingest({ ...source[1], eventId: "gap", sequence: 4 }), /authentic|gap/i);
  assert.equal(projection.ingest(source[0]), "duplicate");
  projection.pruneProjection("2026-07-20T00:00:02.000Z");
  assert.deepEqual(projection.usage().estimated, { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 });

  const reused = toWorkflowTelemetryEvent(sealWorkflowEvent(createWorkflowEvent({
    eventId: source[0].eventId,
    projectId: "different-project",
    sessionId: "different-session",
    type: "run.started",
    producer: "harness",
    payload: { formatVersion: 1 },
  }), 1, null));
  assert.throws(() => projection.ingest(reused), /reused an event ID/i, "pruning must permanently retain event-ID identity");
  assert.equal(projection.streamStatus(reused.streamId).state, "blocked");
});

test("redaction canonicalizes protected paths, fails closed on secret policy overflow, and production writers consume configured policy", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-redaction-policy-"));
  const secret = "configured-super-secret";
  for (const protectedPath of [join(root, ".env"), "nested/../.env", "nested\\..\\.env", join(root, "configured/private/item.json")]) {
    const redacted = redactJournalPayload({ path: protectedPath, nested: { content: "must-not-survive" } }, { projectRoot: root, protectedPaths: ["configured/private"] });
    assert.doesNotMatch(JSON.stringify(redacted), /must-not-survive/);
  }
  const tooManySecrets = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`TOKEN_${index}`, `secret-${index}`]));
  assert.throws(() => redactJournalPayload("value", { environment: tooManySecrets }), /secret.*limit|redaction.*limit/i);
  assert.throws(() => redactJournalPayload("value", { environment: { API_TOKEN: "abc" } }), /secret.*length|redaction.*limit/i);
  assert.throws(() => redactJournalPayload("value", { environment: { API_TOKEN: "x".repeat(8_193) } }), /secret.*length|redaction.*limit/i);

  configureWorkflowJournalRedaction(root, { environment: { CONFIG_TOKEN: secret }, protectedPaths: ["configured/private"] });
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "redacted", projectId: "project-1", sessionId: "redacted-session", type: "artifact.recorded", producer: "runtime", payload: {
    path: "configured/private/item.json",
    nested: { content: secret, toolArgs: { command: `echo ${secret}` }, deeper: [{ toolResult: secret }] },
  } }));
  const bytes = readFileSync(join(root, ".pi/hive/sessions/redacted-session/journal", `${String(1).padStart(16, "0")}-${readWorkflowJournal(root, "redacted-session")[0].eventHash}.json`), "utf8");
  assert.doesNotMatch(bytes, new RegExp(secret));
  assert.match(bytes, /\[REDACTED\]/);
});

test("redaction policy validation covers aggregate bounds and normalized path boundaries", () => {
  assert.throws(() => redactJournalPayload("value", { environment: Object.fromEntries(Array.from({ length: 1_025 }, (_, index) => [`PUBLIC_${index}`, "visible"])) }), /environment entry limit/i);
  assert.throws(() => redactJournalPayload("value", { environment: { API_TOKEN: "😀".repeat(3_000) } }), /secret byte limit/i);
  assert.throws(() => redactJournalPayload("value", { environment: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`TOKEN_${index}`, `${index}`.padEnd(8_000, "x")])) }), /secret limit/i);
  assert.throws(() => redactJournalPayload("value", { protectedPaths: Array.from({ length: 257 }, (_, index) => `private/${index}`) }), /protected path limit/i);
  for (const protectedPaths of [[""], ["bad\0path"], ["x".repeat(4_097)]]) assert.throws(() => redactJournalPayload("value", { protectedPaths }), /protected path limit/i);
  assert.equal((redactJournalPayload({ path: "/outside/public.txt", content: "visible" }, { projectRoot: "/project" }) as any).content, "visible");
  assert.equal((redactJournalPayload({ path: "/anywhere/.env", content: "hidden" }) as any).content, "[REDACTED]");
  assert.equal(redactJournalPayload("abcdef", { environment: { TOKEN_UNDEFINED: undefined, TOKEN_EMPTY: "", PUBLIC: "visible", ["x".repeat(513)]: "ignored" }, maxStringBytes: 4, maxArrayItems: 1, maxObjectKeys: 1, maxDepth: 1 }), "abcd");
  assert.equal((redactJournalPayload({ path: ".", content: "visible" }, { projectRoot: "/project" }) as any).content, "visible");
  assert.equal((redactJournalPayload({ path: ".env/child", content: "hidden" }) as any).content, "[REDACTED]");
  assert.throws(() => redactJournalPayload("value", { protectedPaths: [1 as never] }), /protected path limit/i);

  const secondRoot = mkdtempSync(join(tmpdir(), "pi-hive-redaction-empty-policy-"));
  configureWorkflowJournalRedaction(secondRoot, {});
  configureWorkflowJournalRedaction(secondRoot, { protectedPaths: ["private"] });
  appendWorkflowEvent(secondRoot, createWorkflowEvent({ eventId: "local-options", projectId: "project-2", sessionId: "session-2", type: "artifact.recorded", producer: "runtime", payload: { value: "abcdef" } }), {
    redaction: { environment: { LOCAL_TOKEN: "local-secret" }, protectedPaths: ["other-private"], maxStringBytes: 4, maxArrayItems: 2, maxObjectKeys: 2, maxDepth: 2 },
  });
  assert.equal((readWorkflowJournal(secondRoot, "session-2")[0].payload as any).value, "abcd");
  let projectLimitError: unknown;
  for (let index = 0; index < 100 && !projectLimitError; index++) {
    try { configureWorkflowJournalRedaction(join(secondRoot, `project-${index}`), {}); } catch (error) { projectLimitError = error; }
  }
  assert.match(String(projectLimitError), /redaction project limit/i);
});

test("persisted telemetry restoration verifies the complete projected hash before trusting a row", () => {
  const event = toWorkflowTelemetryEvent(chain([{ id: "persisted", payload: { formatVersion: 1, status: "running" } }])[0], context);
  assert.equal(restoreWorkflowTelemetryEvent(JSON.parse(JSON.stringify(event))).eventHash, event.eventHash);
  assert.throws(() => restoreWorkflowTelemetryEvent({ ...JSON.parse(JSON.stringify(event)), status: "forged" }), /hash/i);
  assert.throws(() => restoreWorkflowTelemetryEvent({ forged: true }), /shape/i);
});

test("history and current cursors strictly reject malformed base64url", () => {
  const projection = new WorkflowTelemetryProjection();
  assert.throws(() => projection.history({ limit: 1, cursor: "x".repeat(5_000) }), /byte|cursor|limit/i);
  assert.throws(() => projection.history({ limit: 1, projectId: "x".repeat(2_000) }), /byte|filter|limit/i);
  for (const cursor of ["!", "a=", "a b", "%%%%", "eyJub3QiOiJhLWN1cnNvciJ9"]) {
    assert.throws(() => projection.history({ limit: 1, cursor }), /cursor.*invalid/i);
    assert.throws(() => projection.currentPage({ kind: "sessions", limit: 1, cursor }), /cursor.*invalid/i);
  }
});

test("composite entity identities are collision-free", () => {
  const source = chain([
    { id: "collision-left", type: "task.started", runId: "a:b", payload: { formatVersion: 1, taskId: "c", nodeId: "n:o" } },
    { id: "collision-right", type: "task.started", runId: "a", payload: { formatVersion: 1, taskId: "b:c", nodeId: "n:o" } },
  ]).map((event) => toWorkflowTelemetryEvent(event, context));
  const projection = rebuildWorkflowProjection([source]);
  assert.equal(projection.current().tasks.length, 2);
  assert.deepEqual(new Set(projection.current().tasks.map((row) => `${row.runId}/${row.taskId}`)), new Set(["a:b/c", "a/b:c"]));
});

test("telemetry rejects unsafe context and numeric magnitudes before projection", () => {
  const source = chain([{ id: "magnitude", type: "budget.model.usage.recorded", payload: {
    formatVersion: 1,
    elapsedMs: 1_000_000_000_001,
    usage: { inputTokens: 1_000_000_000_001, outputTokens: 0, costMicroUsd: 0, precision: "estimated" },
  } }])[0];
  assert.throws(() => toWorkflowTelemetryEvent(source, { ...context, projectLabel: "x".repeat(2_000) }), /dimension|context|byte|limit/i);
  assert.throws(() => toWorkflowTelemetryEvent(source, context), /metric|usage|magnitude|limit/i);
});

test("loaded project policy redacts configured protected roots through real symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-redaction-loaded-policy-"));
  mkdirSync(join(root, ".pi", "hive"), { recursive: true });
  mkdirSync(join(root, "protected-knowledge"));
  writeFileSync(join(root, ".pi", "hive", "hive-config.yaml"), "schema-version: 1\nagents: {}\nworkflows: {}\nknowledge:\n  private:\n    provider: okf\n    path: protected-knowledge\n");
  writeFileSync(join(root, "protected-knowledge", "secret.txt"), "private");
  symlinkSync("protected-knowledge", join(root, "public-link"));
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "symlink-redaction", projectId: "project-policy", sessionId: "session-policy", type: "artifact.recorded", producer: "runtime", payload: {
    path: "public-link/secret.txt",
    content: "must-not-survive",
    note: process.env.HIVE_TEST_CONFIG_TOKEN ?? "visible",
  } }));
  assert.doesNotMatch(JSON.stringify(readWorkflowJournal(root, "session-policy")[0].payload), /must-not-survive/);
});

test("completed journal prune receipts never attach to a later similar closed journal", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-journal-prune-successive-"));
  const service = createWorkflowJournalPruneService({ authenticate: () => "operator" });
  const appendClosed = (prefix: string) => {
    appendWorkflowEvent(root, createWorkflowEvent({ eventId: `${prefix}-start`, projectId: "project-1", sessionId: "session-1", runId: `${prefix}-run`, type: "run.started", producer: "runtime", payload: { formatVersion: 1 } }));
    appendWorkflowEvent(root, createWorkflowEvent({ eventId: `${prefix}-finish`, projectId: "project-1", sessionId: "session-1", runId: `${prefix}-run`, type: "terminal.recorded", producer: "runtime", payload: { formatVersion: 1, status: "completed" } }));
  };
  appendClosed("first");
  expectPruned("first-operation", 2);
  appendClosed("second");
  expectPruned("second-operation", 2);
  assert.deepEqual(readWorkflowJournal(root, "session-1"), []);

  function expectPruned(operationId: string, count: number): void {
    const value = service.prune({ projectRoot: root, sessionId: "session-1", credential: "ok", operationId, confirmIrrecoverable: true });
    assert.equal(value.deletedEvents, count);
    const operationHash = createHash("sha256").update("pi-hive-journal-prune-operation-v1\0").update(operationId).digest("hex");
    const receipt = JSON.parse(readFileSync(join(root, ".pi", "hive", "sessions", "session-1", `.journal-prune-receipt-${operationHash}.json`), "utf8"));
    assert.equal(receipt.status, "completed");
    assert.match(receipt.journal.contentHash, /^[0-9a-f]{64}$/);
  }
});

test("journal prune reconciles a detached prior operation before a new operation ID", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-journal-prune-new-operation-"));
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "start", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "run.started", producer: "runtime", payload: { formatVersion: 1 } }));
  appendWorkflowEvent(root, createWorkflowEvent({ eventId: "finish", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "terminal.recorded", producer: "runtime", payload: { formatVersion: 1, status: "completed" } }));
  const crashing = createWorkflowJournalPruneService({ authenticate: () => "operator", fault(stage) { if (stage === "afterDetach") throw new Error("crash"); } });
  assert.throws(() => crashing.prune({ projectRoot: root, sessionId: "session-1", credential: "ok", operationId: "old-operation", confirmIrrecoverable: true }), /crash/);
  const service = createWorkflowJournalPruneService({ authenticate: () => "operator" });
  const result = service.prune({ projectRoot: root, sessionId: "session-1", credential: "ok", operationId: "new-operation", confirmIrrecoverable: true });
  assert.equal(result.deletedEvents, 0);
  assert.deepEqual(readWorkflowJournal(root, "session-1"), []);
  assert.deepEqual(readdirSync(join(root, ".pi", "hive", "sessions", "session-1")).filter((name) => name.startsWith(".journal-pruned-")), []);
});

test("in-memory rebuild supports histories above ten thousand while keeping output bounded", () => {
  const drafts: WorkflowEventEnvelope[] = [];
  for (let index = 0; index < 10_001; index++) {
    const draft = createWorkflowEvent({
      eventId: `large-node-${index}`,
      projectId: "project-large-node",
      sessionId: "session-large-node",
      runId: "run-large-node",
      type: index === 0 ? "run.started" : index === 10_000 ? "terminal.recorded" : "artifact.recorded",
      producer: "harness",
      timestamp: new Date(Date.UTC(2026, 6, 22, 0, 0, index)).toISOString(),
      payload: index === 10_000 ? { formatVersion: 1, status: "completed" } : { formatVersion: 1 },
    });
    drafts.push(sealWorkflowEvent(draft, index + 1, drafts.at(-1)?.eventHash ?? null));
  }
  const projection = rebuildWorkflowProjection([drafts.map((event) => toWorkflowTelemetryEvent(event))]);
  const page = projection.history({ limit: 500 });
  assert.equal(page.items.length, 500);
  assert.equal(page.hasMore, true);
  assert.equal(projection.current().runs[0].status, "completed");

  const bounded = new WorkflowTelemetryProjection({ eventLimit: 2 });
  bounded.ingest(toWorkflowTelemetryEvent(drafts[0]));
  bounded.ingest(toWorkflowTelemetryEvent(drafts[1]));
  assert.throws(() => bounded.ingest(toWorkflowTelemetryEvent(drafts[2])), /event limit/i);
});

test("legacy telemetry files are ignored and preserved by workflow projection rebuild", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-legacy-preserve-"));
  const legacyJsonl = join(root, "hive-events.jsonl");
  const legacyDb = join(root, "telemetry.db");
  writeFileSync(legacyJsonl, "{\"event_id\":\"legacy\",\"type\":\"planning\"}\n");
  writeFileSync(legacyDb, "legacy database bytes");
  const before = [readFileSync(legacyJsonl), readFileSync(legacyDb)];
  const rebuilt = rebuildWorkflowProjection([]);
  assert.equal(rebuilt.history({ limit: 1 }).items.length, 0);
  assert.equal(existsSync(legacyJsonl), true);
  assert.equal(existsSync(legacyDb), true);
  assert.deepEqual(readFileSync(legacyJsonl), before[0]);
  assert.deepEqual(readFileSync(legacyDb), before[1]);
});

test("persisted telemetry restoration fails closed at every bounded identity boundary", () => {
  const persisted = JSON.parse(JSON.stringify(toWorkflowTelemetryEvent(chain([{
    id: "persisted-boundaries",
    payload: { formatVersion: 1, status: "running" },
  }])[0], context)));
  const invalidShapes: ReadonlyArray<readonly [string, (value: any) => void]> = [
    ["missing dimensions", (value) => { value.dimensions = null; }],
    ["non-string project", (value) => { value.dimensions.projectId = 1; }],
    ["non-string session", (value) => { value.dimensions.sessionId = 1; }],
    ["empty dimension", (value) => { value.dimensions.projectLabel = ""; }],
    ["non-string dimension", (value) => { value.dimensions.projectLabel = 1; }],
    ["oversized dimension", (value) => { value.dimensions.projectLabel = "x".repeat(WORKFLOW_TELEMETRY_LIMITS.dimensionBytes + 1); }],
    ["non-string stream", (value) => { value.streamId = 1; }],
    ["non-string event ID", (value) => { value.eventId = 1; }],
    ["non-string event type", (value) => { value.eventType = 1; }],
    ["non-string timestamp", (value) => { value.timestamp = 1; }],
    ["invalid timestamp", (value) => { value.timestamp = "not-a-timestamp"; }],
    ["non-string producer", (value) => { value.producer = 1; }],
    ["fractional sequence", (value) => { value.sequence = 1.5; }],
    ["zero sequence", (value) => { value.sequence = 0; }],
    ["non-array refs", (value) => { value.refs = {}; }],
    ["too many refs", (value) => { value.refs = Array.from({ length: WORKFLOW_TELEMETRY_LIMITS.refs + 1 }, () => "ref"); }],
    ["non-string ref", (value) => { value.refs = [1]; }],
    ["oversized ref", (value) => { value.refs = ["x".repeat(WORKFLOW_TELEMETRY_LIMITS.refBytes + 1)]; }],
    ["non-finite metric", (value) => { value.metrics = { elapsedMs: Number.POSITIVE_INFINITY }; }],
    ["negative metric", (value) => { value.metrics = { budgetRemaining: -1 }; }],
    ["oversized metric", (value) => { value.metrics = { budgetLimit: WORKFLOW_TELEMETRY_LIMITS.numericMagnitude + 1 }; }],
    ["fractional usage", (value) => { value.usage = { inputTokens: 1.5, outputTokens: 0, costMicroUsd: 0, precision: "estimated" }; }],
  ];
  assert.throws(() => restoreWorkflowTelemetryEvent(null), /shape/i, "null rows are rejected");
  for (const [label, mutate] of invalidShapes) {
    const candidate = structuredClone(persisted);
    mutate(candidate);
    assert.throws(() => restoreWorkflowTelemetryEvent(candidate), /shape/i, label);
  }

  const invalidHashes: ReadonlyArray<readonly [string, (value: any) => void]> = [
    ["schema version", (value) => { value.schemaVersion = 2; }],
    ["event hash", (value) => { value.eventHash = "invalid"; }],
    ["payload hash", (value) => { value.payloadHash = "invalid"; }],
    ["source hash", (value) => { value.sourceEventHash = "invalid"; }],
    ["previous hash", (value) => { value.previousHash = "invalid"; }],
    ["configuration hash", (value) => { value.dimensions.workflowConfigHash = "invalid"; }],
    ["workspace hash", (value) => { value.dimensions.workspaceHash = "sha256:invalid"; }],
    ["terminal hash", (value) => { value.terminal = { refs: [], terminalEventHash: "invalid" }; }],
  ];
  for (const [label, mutate] of invalidHashes) {
    const candidate = structuredClone(persisted);
    mutate(candidate);
    assert.throws(() => restoreWorkflowTelemetryEvent(candidate), /hash format/i, label);
  }
  const wrongStream = structuredClone(persisted);
  wrongStream.streamId = `wfs1-${"b".repeat(64)}`;
  assert.throws(() => restoreWorkflowTelemetryEvent(wrongStream), /stream identity/i);
});

test("redaction handles non-JSON values, cycles, truncation, and unresolved path aliases safely", () => {
  const cycle: Record<string, unknown> = { visible: "kept" };
  cycle.self = cycle;
  const redacted = redactJournalPayload({
    array: ["first", "second"],
    boolean: true,
    cycle,
    finite: 1,
    function: () => "unsafe",
    infinite: Number.POSITIVE_INFINITY,
    nil: null,
    missing: undefined,
    bigint: 1n,
    symbol: Symbol("unsafe"),
    nested: { value: "too deep" },
  }, { environment: {}, maxArrayItems: 1, maxDepth: 3 });
  assert.deepEqual((redacted as any).array, ["first"]);
  assert.equal((redacted as any).boolean, true);
  assert.equal((redacted as any).finite, 1);
  assert.equal((redacted as any).infinite, null);
  assert.equal((redacted as any).nil, null);
  for (const key of ["function", "missing", "bigint", "symbol"]) assert.equal((redacted as any)[key], null);
  assert.equal((redacted as any).cycle.self, "[REDACTED]");
  assert.equal((redacted as any).nested.value, "too deep");
  assert.equal((redactJournalPayload({ nested: { value: "hidden by depth" } }, { environment: {}, maxDepth: 1 }) as any).nested, "[TRUNCATED]");
  assert.equal(redactJournalPayload("😀😀", { environment: {}, maxStringBytes: 5 }), "😀", "UTF-8 truncation never emits a partial code point");
  assert.equal((redactJournalPayload({ authorization: "authorized" }, { environment: {} }) as any).authorization, "authorized");

  const projected = redactProjectionValue({ path: "configured/private/file", content: "already-authoritative", transcript: "omit" }, {
    environment: { API_TOKEN: "already-authoritative" }, protectedPaths: ["configured/private"], projectRoot: "/untrusted/root",
  });
  assert.deepEqual(projected, { content: "already-authoritative", path: "configured/private/file" }, "projection ignores process policy and strips raw fields deterministically");

  const root = mkdtempSync(join(tmpdir(), "pi-hive-redaction-broken-link-"));
  symlinkSync("missing-target", join(root, "unresolved-link"));
  const unresolved = redactJournalPayload({ path: "unresolved-link/private.txt", content: "must-not-survive" }, { environment: {}, projectRoot: root });
  assert.equal((unresolved as any).content, "[REDACTED]", "an unresolved symlink path fails closed");
});

test("a real structured terminal envelope projects every bounded artifact, evidence, checkpoint, and knowledge identity", () => {
  const artifactDigest = `sha256:${"a".repeat(64)}`;
  const knowledgeHash = `sha256:${"b".repeat(64)}`;
  const evidenceIdentity = "tool-call-verified";
  const [source] = chain([{ id: "structured-terminal-refs", type: "terminal.recorded", runId: "run-1", payload: {
    formatVersion: 1,
    status: "completed",
    summary: "Terminal reference projection is complete.",
    fileChanges: [],
    changeCoverage: "recorded",
    artifactRefs: [{ workspaceId: "workspace-verified", checkpoint: "checkpoint-verified", digest: artifactDigest }],
    evidenceRefs: [{ kind: "tool", toolCallId: evidenceIdentity, claim: "The verified tool call proves completion." }, { kind: "journal", claim: "Authenticated journal evidence has no external ID." }],
    data: {
      checkpointRefs: [{ checkpointId: "checkpoint-extra", digest: `sha256:${"c".repeat(64)}` }],
      knowledgeRefs: [{ knowledgeJobId: "knowledge-job-verified", contentHash: knowledgeHash }],
    },
    unsatisfiedGates: [], closedQuestionIds: [], partialState: {},
    finishedByNodeId: "root", finishedAt: "2026-07-20T00:00:00.000Z", snapshotId: "snapshot-1", runId: "run-1",
  } }]);
  assert.doesNotThrow(() => terminalEnvelopeFromEvent(source), "the fixture is a real validated terminal envelope");
  const event = toWorkflowTelemetryEvent(source, context);
  const refs = new Set(event.terminal?.refs);
  for (const expected of ["workspace-verified", "checkpoint-verified", artifactDigest, evidenceIdentity, "checkpoint-extra", "knowledge-job-verified", knowledgeHash]) {
    assert.equal(refs.has(expected), true, `missing projected terminal reference ${expected}`);
  }
  assert.equal(event.refs.length, event.terminal?.refs.length);
  assert.equal(event.refs.some((ref) => ref.includes("Authenticated journal evidence")), false, "raw evidence claims are not projected");
  assert.ok(event.refs.length <= WORKFLOW_TELEMETRY_LIMITS.refs);
  assert.ok(event.refs.every((ref) => Buffer.byteLength(ref, "utf8") <= WORKFLOW_TELEMETRY_LIMITS.refBytes));
});

test("telemetry extraction covers nested bounds, usage aliases, and lifecycle status fallbacks", () => {
  const [usageSource] = chain([{ id: "fallback-usage", type: "budget.model.usage.recorded", payload: {
    formatVersion: 1,
    nested: { providerUsage: { input: 3, output: 2, costMicroUsd: 4, precision: "estimated", cacheReadTokens: 5, cacheWriteTokens: 6, reasoningTokens: 7 } },
    durationMs: 9,
    refs: [1, "kept-ref", null],
  } }]);
  const usageEvent = toWorkflowTelemetryEvent(usageSource);
  assert.deepEqual(usageEvent.usage, {
    inputTokens: 3, outputTokens: 2, costMicroUsd: 4, precision: "estimated",
    cacheReadTokens: 5, cacheWriteTokens: 6, reasoningTokens: 7,
  });
  assert.deepEqual(usageEvent.metrics, { elapsedMs: 9 });
  assert.deepEqual(usageEvent.refs, ["kept-ref"]);

  const [invalidPrecision] = chain([{ id: "invalid-precision", payload: { formatVersion: 1, usage: { precision: "invented", inputTokens: 100 } } }]);
  assert.equal(toWorkflowTelemetryEvent(invalidPrecision).usage, undefined, "unknown usage precision is ignored rather than misclassified");
  const deeplyNestedPayload = { formatVersion: 1, one: { two: { three: { four: { five: { status: "must-not-project" } } } } } };
  const [tooDeep] = chain([{ id: "too-deep", payload: deeplyNestedPayload }]);
  assert.equal(toWorkflowTelemetryEvent(tooDeep).status, undefined, "recursive field discovery stops at its fixed depth");

  const statuses = chain([
    { id: "question-close", type: "question.transition", payload: { formatVersion: 1, operation: "close-pending" } },
    { id: "approval-default", type: "approval.recorded", payload: { formatVersion: 1, operation: "decision" } },
    { id: "session-created", type: "session.created", payload: { formatVersion: 1 } },
    { id: "session-linked", type: "session.linked", payload: { formatVersion: 1 } },
    { id: "session-recovered", type: "session.recovered", payload: { formatVersion: 1 } },
    { id: "session-orphaned", type: "session.orphaned", payload: { formatVersion: 1 } },
    { id: "terminal-without-status", type: "terminal.recorded", payload: { formatVersion: 1 } },
  ]).map((event) => toWorkflowTelemetryEvent(event));
  assert.deepEqual(statuses.map((event) => event.status), ["closed", "decided", "active", "active", "active", "orphaned", undefined]);
  assert.deepEqual(statuses.at(-1)?.terminal, { refs: [] });

  const correlatedDraft = createWorkflowEvent({
    eventId: "correlated", projectId: "project-1", sessionId: "correlated-session", correlationId: "operation-correlation",
    type: "artifact.recorded", producer: "harness", payload: { formatVersion: 1 },
  });
  assert.equal(toWorkflowTelemetryEvent(sealWorkflowEvent(correlatedDraft, 1, null)).correlationId, "operation-correlation");
});

test("projection integrity and filtering exercise collision, previous-hash, and page boundaries", () => {
  const collisionProjection = new WorkflowTelemetryProjection();
  const collisionLeft = createWorkflowEvent({ eventId: "same-event", projectId: "left", sessionId: "session", type: "artifact.recorded", producer: "harness", payload: { formatVersion: 1 } });
  const collisionRight = createWorkflowEvent({ eventId: "same-event", projectId: "right", sessionId: "session", type: "artifact.recorded", producer: "harness", payload: { formatVersion: 1 } });
  collisionProjection.ingest(toWorkflowTelemetryEvent(sealWorkflowEvent(collisionLeft, 1, null)));
  assert.throws(() => collisionProjection.ingest(toWorkflowTelemetryEvent(sealWorkflowEvent(collisionRight, 1, null))), /reused an event ID/i);

  const previousHashProjection = new WorkflowTelemetryProjection();
  const firstDraft = createWorkflowEvent({ eventId: "hash-first", projectId: "hash-project", sessionId: "hash-session", type: "artifact.recorded", producer: "harness", payload: { formatVersion: 1 } });
  const secondDraft = createWorkflowEvent({ eventId: "hash-second", projectId: "hash-project", sessionId: "hash-session", type: "artifact.recorded", producer: "harness", payload: { formatVersion: 1 } });
  previousHashProjection.ingest(toWorkflowTelemetryEvent(sealWorkflowEvent(firstDraft, 1, null)));
  assert.throws(() => previousHashProjection.ingest(toWorkflowTelemetryEvent(sealWorkflowEvent(secondDraft, 2, "f".repeat(64)))), /previous hash mismatch/i);

  const filterSource = chain([{ id: "filter-event", type: "task.started", runId: "filter-run", payload: {
    formatVersion: 1, nodeId: "filter-node", taskId: "filter-task",
  } }]).map((event) => toWorkflowTelemetryEvent(event, { workflowId: "filter-workflow" }));
  const filtered = rebuildWorkflowProjection([filterSource]);
  assert.equal(filtered.history({
    limit: 1, projectId: "project-1", sessionId: "workflow-session-1", workflowId: "filter-workflow",
    runId: "filter-run", nodeId: "filter-node", taskId: "filter-task", eventType: "task.started",
  }).items.length, 1);
  for (const query of [
    { projectId: "wrong" }, { sessionId: "wrong" }, { workflowId: "wrong" }, { runId: "wrong" },
    { nodeId: "wrong" }, { taskId: "wrong" }, { eventType: "artifact.recorded" },
  ]) assert.equal(filtered.history({ limit: 1, ...query }).items.length, 0);
  assert.throws(() => filtered.pruneProjection("invalid"), /cutoff is invalid/i);

  const pageProjection = rebuildWorkflowProjection([
    chain([{ id: "page-left", type: "run.started", payload: { formatVersion: 1 } }]).map((event) => toWorkflowTelemetryEvent(event)),
    [toWorkflowTelemetryEvent(sealWorkflowEvent(createWorkflowEvent({ eventId: "page-right", projectId: "project-2", sessionId: "session-2", type: "run.started", producer: "harness", payload: { formatVersion: 1 } }), 1, null))],
  ]);
  const firstPage = pageProjection.currentPage({ kind: "sessions", limit: 1 });
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);
  const secondPage = pageProjection.currentPage({ kind: "sessions", limit: 1, cursor: firstPage.nextCursor });
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.hasMore, false);
});

test("projection query cursors and in-memory limits reject each malformed boundary", () => {
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const stream = `wfs1-${"a".repeat(64)}`;
  const timestamp = "2026-07-20T00:00:00.000Z";
  const invalidHistory = [
    [], [timestamp, stream, 1], [1, stream, 1, "event"], ["invalid", stream, 1, "event"],
    [timestamp, 1, 1, "event"], [timestamp, "invalid", 1, "event"], [timestamp, stream, "1", "event"],
    [timestamp, stream, 0, "event"], [timestamp, stream, 1, 1], [timestamp, stream, 1, ""],
  ];
  const invalidCurrent = [
    [], ["project", "session", "run", "entity"], ["project", "session", "run", "entity", 1],
    ["project", "session", "run", "entity", "invalid"],
    ["x".repeat(8_193), "session", "run", "entity", `wfe1-${"a".repeat(64)}`],
  ];
  const projection = new WorkflowTelemetryProjection();
  for (const value of invalidHistory) assert.throws(() => projection.history({ limit: 1, cursor: encoded(value) }), /history cursor is invalid/i);
  for (const value of invalidCurrent) assert.throws(() => projection.currentPage({ kind: "sessions", limit: 1, cursor: encoded(value) }), /current cursor|byte limit/i);
  for (const limit of [0, 1.5, WORKFLOW_PROJECTION_IN_MEMORY_EVENT_LIMIT + 1]) assert.throws(() => new WorkflowTelemetryProjection({ eventLimit: limit }), /event limit is invalid/i);
  for (const limit of [0, 1.5, 501]) assert.throws(() => projection.currentPage({ kind: "sessions", limit }), /current limit/i);
  assert.throws(() => projection.currentPage({ kind: "invalid" as never, limit: 1 }), /kind is invalid/i);
  assert.throws(() => projection.currentPage({ kind: "sessions", limit: 1, cursor: "x".repeat(8_193) }), /byte limit|cursor exceeds/i);
});
