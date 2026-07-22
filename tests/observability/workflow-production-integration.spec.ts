import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashActivationPayload } from "../../src/config/snapshot-canonical";
import { writeActivationSnapshot } from "../../src/config/snapshot-store";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot";
import { createDashboardHttpHandler } from "../../src/observability/server/http-handler";
import { createProductionWorkflowApiOptions, type ProductionWorkflowServiceOptions } from "../../src/observability/server/workflow-service";
import { createConfiguredWorkflowProjectionSynchronizer } from "../../src/observability/server/workflow-runtime";
import { broadcastWorkflowEvent, closeAllSubscribers, hasLiveSubscribers } from "../../src/observability/server/sse";
import { DAEMON_TOKEN, expectedHostHeader } from "../../src/observability/server/config";
import { toWorkflowTelemetryEvent } from "../../src/observability/events";
import { encodeWorkflowHistoryCursor } from "../../src/observability/projection";
import { CheckpointApprovalService } from "../../src/artifacts/approvals";
import { createMarkdownPlanAdapter, MARKDOWN_PLAN_PROFILES } from "../../src/artifacts/adapters/markdown-plan";
import { hashArtifactWorkspace } from "../../src/artifacts/hashes";
import { WorkspaceLeaseRuntime } from "../../src/artifacts/leases";
import { bindPhysicalArtifactWorkspace } from "../../src/artifacts/workspaces";
import { DelegationRuntime } from "../../src/workflows/delegation";
import { QuestionService } from "../../src/workflows/questions";
import { appendWorkflowEvent, readWorkflowJournal } from "../../src/workflows/journal";
import { createWorkflowEvent, sealWorkflowEvent } from "../../src/workflows/events";
import { WorkflowRunLifecycle } from "../../src/workflows/runs";
import { upsertWorkflowLink } from "../../src/workflows/sessions";
import { hashAttemptInput } from "../../src/workflows/attempts";
import { loadOkfBundle } from "../../src/knowledge/okf";
import { parseCuratorOutput } from "../../src/knowledge/curator";
import { createCuratorPlan } from "../../src/knowledge/enrichment";
import { KnowledgeProposalService } from "../../src/knowledge/proposals";

const projectId = "project-production";
const questionSession = "session-question";
const knowledgeSession = "session-knowledge";
const pruneSession = "session-prune";
const approvalSession = "session-approval";
const approvalRunId = "run-approval";
const runId = "run-question";

function snapshot(): ActivationSnapshotFileV1 {
  const effective = { filesystem: [], shell: [], git: false, "external-network": false, "human-input": true, artifact: [], knowledge: [] };
  const provenance = { filesystem: ["agent-ceiling", "workflow-node-omitted-deny"], shell: ["agent-ceiling", "workflow-node-omitted-deny"], git: ["agent-ceiling", "workflow-node-omitted-deny"], "external-network": ["agent-ceiling", "workflow-node-omitted-deny"], "human-input": ["agent-ceiling", "workflow-node"], artifact: ["agent-ceiling", "workflow-node-omitted-deny"], knowledge: ["agent-ceiling", "workflow-node-omitted-deny"] };
  const payload = {
    versions: { snapshot: 1, packageContract: "pi-hive-package-contract-v1", schema: 1, capability: 1, catalogHash: "pi-hive-catalog-hash-v1", artifact: "pi-hive-artifact-contract-v1", contextPolicy: "pi-hive-context-policy-v1", package: "0.1.0" },
    project: { projectId, rootRef: "." },
    workflow: { id: "production", artifact: { adapter: "markdown-plan", adapterVersion: "1", profile: "author", profileVersion: "1", binding: "new", options: {}, optionsSchemaVersion: "1", contractVersion: "pi-hive-artifact-contract-v1", checkpoints: ["plan"], actionIds: MARKDOWN_PLAN_PROFILES.author.actions.map((action) => action.id), viewVersion: 1, approvals: { plan: "required" } }, team: { rootId: "root", nodes: [
      { id: "root", agentId: "lead", memberIds: ["worker"], capabilities: { "human-input": true }, responsibilities: [], skills: { resolved: [] }, knowledge: { resolved: [] }, budgets: {} },
      { id: "worker", agentId: "worker-agent", parentId: "root", memberIds: [], capabilities: { "human-input": true }, responsibilities: [], skills: { resolved: [] }, knowledge: { resolved: [] }, budgets: {} },
    ] } },
    agents: [
      { id: "lead", name: "Lead", tags: [], frontmatter: { capabilities: { "human-input": true } }, prompt: "lead", sourceHash: "a".repeat(64), canonicalSourceHash: "b".repeat(64), promptHash: "c".repeat(64) },
      { id: "worker-agent", name: "Worker", tags: [], frontmatter: { capabilities: { "human-input": true } }, prompt: "worker", sourceHash: "d".repeat(64), canonicalSourceHash: "e".repeat(64), promptHash: "f".repeat(64) },
    ],
    skills: [], knowledge: [],
    authority: { capabilityContractVersion: 1, nodes: [
      { nodeId: "root", capabilities: { effective, provenance, budgets: {}, attachments: { skills: [], knowledge: [] }, directMemberIds: ["worker"] }, tools: ["delegate_agent", "human_question", "route_agent", "team_status", "workflow_finish", "workflow_status"] },
      { nodeId: "worker", capabilities: { effective, provenance, budgets: {}, attachments: { skills: [], knowledge: [] }, directMemberIds: [] }, tools: ["human_question"] },
    ] },
    models: [
      { nodeId: "root", modelId: "provider/model", thinking: "off", staticTokens: 8192, dynamicReserve: 20000, contextWindow: 100000 },
      { nodeId: "worker", modelId: "provider/model", thinking: "off", staticTokens: 8192, dynamicReserve: 20000, contextWindow: 100000 },
    ],
    sources: [],
  } as any;
  return { snapshotHash: hashActivationPayload(payload), createdAt: "2026-01-01T00:00:00.000Z", payload };
}

function link(projectRoot: string, sessionId: string, activationHash: string, workflowId: string) {
  upsertWorkflowLink(projectRoot, {
    kind: "workflow", formatVersion: 1, workflowSessionId: sessionId, workflowId, activationHash,
    piSessionId: `pi-${sessionId}`, piSessionFile: join(projectRoot, `${sessionId}.jsonl`), normalParentId: "normal", normalParentFile: join(projectRoot, "normal.jsonl"),
    status: "current", stale: false, model: "provider/model", thinking: "off", tools: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", name: `hive:${workflowId}`,
  });
}

function seedKnowledgeProposal(projectRoot: string): void {
  const questionSession = knowledgeSession;
  const root = join(projectRoot, ".pi", "hive", "knowledge", "project");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "existing.md"), "---\ntype: Knowledge\ntitle: Existing\n---\n\nExisting architecture.\n");
  const declaration = { id: "project", providerId: "okf", path: ".pi/hive/knowledge/project", updatePolicy: "reviewed" } as const;
  const loaded = loadOkfBundle({ projectRoot, declaration });
  if (!loaded.ok) throw new Error("knowledge fixture did not load");
  const expectedContentHash = `sha256:${loaded.bundle!.contentHash}`;
  const sourceHash = `sha256:${createHash("sha256").update("production-source").digest("hex")}`;
  const evidence = appendWorkflowEvent(projectRoot, createWorkflowEvent({ eventId: "knowledge-evidence", projectId, sessionId: questionSession, runId: "run-knowledge", type: "artifact.recorded", producer: "harness", payload: { formatVersion: 1, nodeId: "root", sourceHashes: [sourceHash] }, timestamp: "2026-01-01T00:00:03.000Z" }));
  const conclusion = "Production dashboard decisions retain exact durable provenance.";
  const candidate = { formatVersion: 1 as const, candidateId: "candidate-production", projectId, sessionId: questionSession, runId: "run-knowledge", nodeId: "root", agentId: "lead", scope: "shared" as const, conclusion, requestHash: hashAttemptInput({ scope: "shared", conclusion, evidenceEventIds: [evidence.eventId] }), citations: [{ eventId: evidence.eventId, eventHash: evidence.eventHash, payloadHash: evidence.payloadHash, sequence: evidence.sequence, type: evidence.type }], sourceHashes: [sourceHash], createdAt: "2026-01-01T00:00:03.000Z" };
  appendWorkflowEvent(projectRoot, createWorkflowEvent({ projectId, sessionId: questionSession, runId: "run-knowledge", type: "knowledge.transition", producer: "runtime", correlationId: "candidate-attempt", attemptId: "candidate-attempt", payload: { formatVersion: 1, operation: "candidate-recorded", candidate } as never, timestamp: candidate.createdAt }));
  const terminal = appendWorkflowEvent(projectRoot, createWorkflowEvent({ projectId, sessionId: questionSession, runId: "run-knowledge", type: "terminal.recorded", producer: "harness", payload: { formatVersion: 1, status: "completed" }, timestamp: "2026-01-01T00:00:04.000Z" }));
  const target = { bundleId: "project", providerId: "okf", path: ".pi/hive/knowledge/project", policy: "reviewed" as const, expectedContentHash };
  const job = { formatVersion: 1 as const, jobId: "job-production", projectId, sessionId: questionSession, runId: "run-knowledge", terminalEventHash: terminal.eventHash, scope: "shared" as const, candidateIds: [candidate.candidateId], targets: [target], model: { nodeId: "root", modelId: "provider/model", thinking: "off", reason: "agent-lowest-participating-node;shared-workflow-root" as const }, state: "queued" as const, attemptCount: 0, staleReevaluations: 0, createdAt: "2026-01-01T00:00:04.000Z", updatedAt: "2026-01-01T00:00:04.000Z" };
  appendWorkflowEvent(projectRoot, createWorkflowEvent({ projectId, sessionId: questionSession, runId: "run-knowledge", type: "knowledge.transition", producer: "harness", payload: { formatVersion: 1, operation: "jobs-enqueued", terminalEventHash: terminal.eventHash, preservedCancelled: false, jobs: [job] } as never }));
  appendWorkflowEvent(projectRoot, createWorkflowEvent({ projectId, sessionId: questionSession, runId: "run-knowledge", type: "knowledge.transition", producer: "harness", correlationId: "knowledge-job-job-production", payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "queued", to: "active", attemptCount: 1, staleReevaluations: 0, reason: "production test", ownerNonce: "owner-production" } }));
  const output = parseCuratorOutput(JSON.stringify({ formatVersion: 1, conclusions: [{ text: conclusion, citationIds: [candidate.candidateId] }] }), [candidate]);
  const citations = [{ candidateId: candidate.candidateId, eventId: evidence.eventId, eventHash: evidence.eventHash, payloadHash: evidence.payloadHash, sourceHashes: [sourceHash] }];
  const update = { formatVersion: 1 as const, updateId: "update-production", jobId: job.jobId, projectId, sessionId: questionSession, runId: "run-knowledge", bundleId: "project", providerId: "okf", expectedContentHash, curatorOutputHash: output.outputHash, conclusions: output.conclusions.map((entry) => ({ text: entry.text, citations })), createdAt: "2026-01-01T00:00:05.000Z" };
  const plan = createCuratorPlan({ jobId: job.jobId, evaluation: 0, targets: [target], output, actions: [{ kind: "proposal", bundleId: "project", reason: "reviewed-policy", update }], createdAt: update.createdAt });
  appendWorkflowEvent(projectRoot, createWorkflowEvent({ projectId, sessionId: questionSession, runId: "run-knowledge", type: "knowledge.transition", producer: "harness", correlationId: `curator-plan-${job.jobId}`, payload: { formatVersion: 1, operation: "curator-plan-recorded", jobId: job.jobId, ownerNonce: "owner-production", plan } as never, timestamp: plan.createdAt }));
  new KnowledgeProposalService({ projectRoot, projectId, sessionId: questionSession, createProposalId: () => "proposal-production", authenticateControl: () => undefined }).create(update);
}

async function setup() {
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-hive-w25-production-"));
  const databasePath = join(projectRoot, ".pi", "hive", "workflow.db");
  const active = snapshot();
  writeActivationSnapshot(projectRoot, active);
  writeFileSync(join(projectRoot, ".pi", "hive", "hive-config.yaml"), "schema-version: 1\nagents: {}\nworkflows: {}\n");
  link(projectRoot, questionSession, active.snapshotHash, "production-question");
  link(projectRoot, knowledgeSession, active.snapshotHash, "production-knowledge");
  link(projectRoot, pruneSession, active.snapshotHash, "production-prune");
  link(projectRoot, approvalSession, active.snapshotHash, "production-approval");

  const delegation = new DelegationRuntime({ projectRoot, projectId, sessionId: questionSession, runId, snapshot: active, createTaskId: () => "task-question" });
  const task = delegation.accept(delegation.rootExecutionContext(), { targetNodeId: "worker", objective: "Ask the operator", deliverables: [] });
  delegation.start(task.taskId, "attempt-question");
  const questions = new QuestionService({ projectRoot, projectId, sessionId: questionSession, runId, snapshot: active, createQuestionId: () => "question-production", authenticateControl: () => undefined });
  questions.create({ nodeId: "worker", taskId: task.taskId, definition: { prompt: "Continue production deployment?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "tool-question" } });
  seedKnowledgeProposal(projectRoot);

  appendWorkflowEvent(projectRoot, createWorkflowEvent({ eventId: "prune-run-started", projectId, sessionId: pruneSession, runId: "run-prune", type: "run.started", producer: "runtime", timestamp: "2026-01-01T00:00:01.000Z", payload: { formatVersion: 1, workflowId: "production-prune", status: "running" } }));
  appendWorkflowEvent(projectRoot, createWorkflowEvent({ eventId: "prune-run-terminal", projectId, sessionId: pruneSession, runId: "run-prune", type: "terminal.recorded", producer: "runtime", timestamp: "2026-01-01T00:00:02.000Z", payload: { formatVersion: 1, status: "completed" } }));

  // Build a real W17 Markdown workspace and W18 durable pending approval. The
  // production handler later reconstructs this service solely from snapshot + journal.
  const adapter = createMarkdownPlanAdapter({ now: () => "2026-01-01T00:00:06.000Z" });
  const created = bindPhysicalArtifactWorkspace({ projectRoot, adapter, profile: MARKDOWN_PLAN_PROFILES.author, runId: approvalRunId, configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "production-plan" } });
  const author = MARKDOWN_PLAN_PROFILES.author.actions.find((action) => action.id === "markdown-plan.plan.author")!;
  await adapter.executeAction!({
    binding: created, capabilities: ["read", "write"], hashes: hashArtifactWorkspace(created.path!), operationId: "author-production-plan", expectedWorkspaceHash: created.workspaceHash,
    enqueueMutation: async <T>(_path: string, callback: () => T | Promise<T>) => callback(), verifyEvidence: () => [],
  }, author, { title: "Production plan", summary: "Exercise the real durable dashboard approval boundary.", tasks: [{ id: "approve", text: "Approve the production plan" }] });
  const binding = Object.freeze({ ...created, workspaceHash: hashArtifactWorkspace(created.path!).workspaceHash });
  const approvalService = new CheckpointApprovalService({
    projectRoot, projectId, sessionId: approvalSession, adapterId: "markdown-plan", adapterVersion: "1", profileId: "author", profileVersion: "1", profileSchemaVersion: "1",
    checkpointPolicies: { plan: "required" }, resolveDescriptor: ({ checkpointId, binding: current }) => adapter.checkpointDescriptor!({ binding: current, checkpointId, hashes: hashArtifactWorkspace(current.path!) }),
    authenticateControl: () => undefined, createRequestId: () => "approval-production",
  });
  const lifecycle = new WorkflowRunLifecycle({ projectRoot, projectId, sessionId: approvalSession, snapshotId: active.snapshotHash, rootNodeId: "root", createRunId: () => approvalRunId, createArtifactWorkspace: () => binding, checkpointSnapshots: approvalService.runSnapshotProvider() });
  lifecycle.recordUserInput({ inputId: "approval-input", text: "Review production plan", source: "interactive" });
  const approvalLease = new WorkspaceLeaseRuntime({ projectRoot, adapterId: "markdown-plan", workspaceId: binding.workspace.id, sessionId: approvalSession, runId: approvalRunId });
  if (!approvalLease.acquire().ok) throw new Error("approval fixture lease was not acquired");
  const approvalWorkspaceHash = hashArtifactWorkspace(binding.path!).workspaceHash;
  const approvalRequest = await approvalService.requestApproval({ operationId: "request-approval-production", checkpointId: "plan", expectedWorkspaceHash: approvalWorkspaceHash });

  const makeHandler = (overrides: Partial<ProductionWorkflowServiceOptions> = {}) => createDashboardHttpHandler({ workflowApiOptions: createProductionWorkflowApiOptions({ token: DAEMON_TOKEN, databasePath, legacyPaths: [], projectCwd: projectRoot, diagnostics: () => [], ...overrides }) });
  return { projectRoot, databasePath, makeHandler, approvalService, approvalLease, approvalRequest, approvalWorkspaceHash };
}

function request(path: string, init: RequestInit = {}): Request {
  const authority = expectedHostHeader();
  const headers = new Headers(init.headers);
  headers.set("host", authority);
  headers.set("authorization", `Bearer ${DAEMON_TOKEN}`);
  headers.set("x-pi-hive-api-version", "1");
  return new Request(`http://${authority}${path}`, { ...init, headers });
}
function write(body: unknown): RequestInit {
  return { method: "POST", headers: { origin: `http://${expectedHostHeader()}`, "content-type": "application/json", "x-pi-hive-csrf": DAEMON_TOKEN }, body: JSON.stringify(body) };
}
async function json(handler: ReturnType<typeof createDashboardHttpHandler>, path: string, init: RequestInit = {}) {
  const response = await handler(request(path, init));
  return { response, body: await response.json() as any };
}

async function readAvailableStream(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < 8; index += 1) {
    const result = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream did not produce catch-up")), 250))]);
    if (result.done) break;
    chunks.push(result.value);
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    if (text.includes("event: workflow")) break;
  }
  await reader.cancel();
  return new TextDecoder().decode(Buffer.concat(chunks));
}

test("production dashboard handler closes the control boundary over journals, SQLite, replay, SSE, and legacy routes", async () => {
  const fixture = await setup();
  let handler = fixture.makeHandler();

  const legacy = await handler(request("/health"));
  expect(legacy.status).toBe(200);
  expect(await legacy.json()).toMatchObject({ ok: true });

  const rebuilt = await json(handler, "/api/v1/maintenance/projection/rebuild", write({ operationId: "rebuild-production" }));
  expect(rebuilt.response.status).toBe(200);
  expect(rebuilt.body.result).toMatchObject({ streams: 4 });
  expect(rebuilt.body.result.events).toBeGreaterThanOrEqual(5);
  const workflowFiltered = await json(handler, `/api/v1/history?workflowId=production-question&limit=100`);
  expect(workflowFiltered.response.status).toBe(200);
  expect(workflowFiltered.body.items.length).toBeGreaterThan(0);
  expect(workflowFiltered.body.items.every((event: any) => event.dimensions.workflowId === "production-question" && event.dimensions.workflowConfigVersion === "1")).toBe(true);

  const detail = await json(handler, `/api/v1/questions/question-production?projectId=${projectId}&sessionId=${questionSession}&runId=${runId}`);
  expect(detail.response.status).toBe(200);
  expect(detail.body.object).toMatchObject({ questionId: "question-production", state: "pending" });

  const approvalDetail = await json(handler, `/api/v1/approvals/${fixture.approvalRequest.requestId}?projectId=${projectId}&sessionId=${approvalSession}&runId=${approvalRunId}`);
  expect(approvalDetail.response.status).toBe(200);
  expect(approvalDetail.body.object).toMatchObject({ requestId: "approval-production", runId: approvalRunId, checkpointId: "plan" });
  expect(approvalDetail.body.object.decision).toBeUndefined();
  const approvalDecision = { projectId, sessionId: approvalSession, runId: approvalRunId, requestId: fixture.approvalRequest.requestId, expectedRequestSequence: fixture.approvalRequest.requestSequence, digest: fixture.approvalRequest.digest, expectedWorkspaceHash: fixture.approvalWorkspaceHash, decision: "approved", operationId: "approval-decision-production" };
  const approvalApproved = await json(handler, "/api/v1/controls/approvals/decide", write(approvalDecision));
  expect(approvalApproved.response.status, JSON.stringify(approvalApproved.body)).toBe(200);
  expect(approvalApproved.body.result).toMatchObject({ requestId: "approval-production", decision: "approved", approverId: "local-dashboard", channel: "dashboard" });
  expect(fixture.approvalService.restore().requests[fixture.approvalRequest.requestId].decision).toMatchObject({ operationId: "approval-decision-production", decision: "approved" });
  expect(readWorkflowJournal(fixture.projectRoot, approvalSession).some((event) => event.type === "approval.recorded" && (event.payload as any).operation === "decision")).toBe(true);

  const knowledgeList = await json(handler, `/api/v1/knowledge?projectId=${projectId}&sessionId=${knowledgeSession}&runId=run-knowledge&limit=100`);
  expect(knowledgeList.response.status).toBe(200);
  expect(knowledgeList.body.items).toContainEqual(expect.objectContaining({ knowledgeProposalId: "proposal-production", status: "pending" }));
  const persistedProjection = new Database(fixture.databasePath, { readonly: true });
  try {
    expect(persistedProjection.query(`SELECT knowledge_proposal_id FROM workflow_events WHERE knowledge_proposal_id = ?`).get("proposal-production")).toEqual({ knowledge_proposal_id: "proposal-production" });
  } finally { persistedProjection.close(); }

  const knowledgeDetail = await json(handler, `/api/v1/knowledge/proposal-production?projectId=${projectId}&sessionId=${knowledgeSession}&runId=run-knowledge`);
  expect(knowledgeDetail.response.status).toBe(200);
  expect(knowledgeDetail.body.object).toMatchObject({ proposalId: "proposal-production", runId: "run-knowledge", state: "pending" });
  const wrongKnowledgeRun = await json(handler, `/api/v1/knowledge/proposal-production?projectId=${projectId}&sessionId=${knowledgeSession}&runId=wrong-run`);
  expect(wrongKnowledgeRun.response.status).toBe(404);
  const knowledgeDecision = { projectId, sessionId: knowledgeSession, runId: "run-knowledge", proposalId: "proposal-production", expectedState: "pending", decision: "approve", operationId: "knowledge-production", claimedIdentity: "operator" };
  const knowledgeApproved = await json(handler, "/api/v1/controls/knowledge/decide", write(knowledgeDecision));
  expect(knowledgeApproved.response.status).toBe(200);
  expect(knowledgeApproved.body.result).toMatchObject({ proposalId: "proposal-production", state: "approved", decision: { identity: "local-dashboard" } });

  const answer = { projectId, sessionId: questionSession, runId, questionId: "question-production", expectedState: "pending", value: true, operationId: "answer-production", claimedIdentity: "operator" };
  const answered = await json(handler, "/api/v1/controls/questions/answer", write(answer));
  expect(answered.response.status, JSON.stringify(answered.body)).toBe(200);
  expect(answered.body.result).toMatchObject({ state: "answered", answer: { value: true, identity: "local-dashboard" } });

  const sourceEvents = readWorkflowJournal(fixture.projectRoot, questionSession);
  const firstCursor = encodeWorkflowHistoryCursor(toWorkflowTelemetryEvent(sourceEvents[0], { projectRoot: fixture.projectRoot, workflowId: "production-question" }));
  const caughtUp = await handler(request("/api/v1/stream", { headers: { "last-event-id": firstCursor } }));
  expect(caughtUp.status).toBe(200);
  const streamText = await readAvailableStream(caughtUp);
  expect(streamText).toContain("event: hello");
  expect(streamText).toContain("event: workflow");
  expect(streamText).toContain(sourceEvents[1].eventId);

  const resync = await handler(request("/api/v1/stream", { headers: { "last-event-id": "invalid-cursor" } }));
  expect(await resync.text()).toContain("event: resync-required");

  const prune = { operationId: "projection-prune-production", cutoff: "2026-01-01T00:00:01.500Z" };
  const pruned = await json(handler, "/api/v1/maintenance/projection/prune", write(prune));
  expect(pruned.response.status).toBe(200);
  handler.dispose();

  handler = fixture.makeHandler();
  const replayedPrune = await json(handler, "/api/v1/maintenance/projection/prune", write(prune));
  expect(replayedPrune).toEqual(pruned);
  const conflictingPrune = await json(handler, "/api/v1/maintenance/projection/prune", write({ ...prune, cutoff: "2026-02-01T00:00:00.000Z" }));
  expect(conflictingPrune.response.status).toBe(409);
  expect(conflictingPrune.body.error.code).toBe("OPERATION_CONFLICT");

  const replayedAnswer = await json(handler, "/api/v1/controls/questions/answer", write(answer));
  expect(replayedAnswer.body).toEqual(answered.body);
  const replayedApproval = await json(handler, "/api/v1/controls/approvals/decide", write(approvalDecision));
  expect(replayedApproval.body).toEqual(approvalApproved.body);
  const conflictingApproval = await json(handler, "/api/v1/controls/approvals/decide", write({ ...approvalDecision, decision: "denied" }));
  expect(conflictingApproval.response.status).toBe(409);
  expect(conflictingApproval.body.error.code).toBe("OPERATION_CONFLICT");

  const journalRequest = { projectId, sessionId: pruneSession, operationId: "journal-prune-production", confirmIrrecoverable: true };
  const journalPruned = await json(handler, "/api/v1/maintenance/journals/prune", write(journalRequest));
  expect(journalPruned.response.status).toBe(200);
  expect(journalPruned.body.result).toMatchObject({ sessionId: pruneSession, deletedEvents: 2, authenticatedIdentity: "local-dashboard" });
  expect(readWorkflowJournal(fixture.projectRoot, pruneSession)).toEqual([]);
  handler.dispose();

  handler = fixture.makeHandler();
  const journalReplay = await json(handler, "/api/v1/maintenance/journals/prune", write(journalRequest));
  expect(journalReplay.body).toEqual(journalPruned.body);
  handler.dispose();
  fixture.approvalLease.release();
});

test("successful production projection maintenance invalidates already-open workflow streams with bounded resync reasons", async () => {
  closeAllSubscribers();
  const fixture = await setup();
  const handler = fixture.makeHandler();

  const rebuildStream = await handler(request("/api/v1/stream"));
  expect(hasLiveSubscribers()).toBe(true);
  const rebuilt = await json(handler, "/api/v1/maintenance/projection/rebuild", write({ operationId: "rebuild-invalidates-stream" }));
  expect(rebuilt.response.status).toBe(200);
  const rebuildText = await rebuildStream.text();
  expect(rebuildText).toContain("event: hello");
  expect(rebuildText).toContain("event: resync-required");
  expect(rebuildText).toContain('"reason":"projection-rebuild"');
  expect(hasLiveSubscribers()).toBe(false);

  const pruneStream = await handler(request("/api/v1/stream"));
  expect(hasLiveSubscribers()).toBe(true);
  const pruned = await json(handler, "/api/v1/maintenance/projection/prune", write({ operationId: "prune-invalidates-stream", cutoff: "2026-01-01T00:00:01.500Z" }));
  expect(pruned.response.status).toBe(200);
  const pruneText = await pruneStream.text();
  expect(pruneText).toContain("event: hello");
  expect(pruneText).toContain("event: resync-required");
  expect(pruneText).toContain('"reason":"projection-prune"');
  expect(hasLiveSubscribers()).toBe(false);

  handler.dispose();
  fixture.approvalLease.release();
  closeAllSubscribers();
});

test("production projection rebuild preflights aggregate N/N+1 and streams journals independently", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-hive-w25-rebuild-bound-"));
  const journal = join(projectRoot, ".pi", "hive", "sessions", "aggregate-session", "journal");
  mkdirSync(journal, { recursive: true });
  let previous: ReturnType<typeof sealWorkflowEvent> | undefined;
  const append = (index: number) => {
    const event = sealWorkflowEvent(createWorkflowEvent({ eventId: `aggregate-${index}`, projectId: "project-aggregate", sessionId: "aggregate-session", runId: "aggregate-run", type: "budget.model.usage.recorded", producer: "harness", timestamp: "2026-01-01T00:00:00.000Z", payload: { formatVersion: 1, nodeId: "root", usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1, precision: "estimated" } } }), index, previous?.eventHash ?? null);
    previous = event;
    writeFileSync(join(journal, `${String(event.sequence).padStart(16, "0")}-${event.eventHash}.json`), `${JSON.stringify(event)}\n`);
  };
  for (let index = 1; index <= 1_024; index += 1) append(index);
  const databasePath = join(projectRoot, "workflow.db");
  const make = () => createDashboardHttpHandler({ workflowApiOptions: createProductionWorkflowApiOptions({ token: DAEMON_TOKEN, databasePath, legacyPaths: [], projectCwd: projectRoot, diagnostics: () => [], rebuildLimits: { events: 1_024 } }) });
  let handler = make();
  const atLimit = await json(handler, "/api/v1/maintenance/projection/rebuild", write({ operationId: "aggregate-at-limit" }));
  expect(atLimit.response.status).toBe(200);
  expect(atLimit.body.result).toMatchObject({ events: 1_024, streams: 1 });
  handler.dispose();

  append(1_025);
  handler = make();
  const overLimit = await json(handler, "/api/v1/maintenance/projection/rebuild", write({ operationId: "aggregate-over-limit" }));
  expect(overLimit.response.status).toBe(413);
  expect(overLimit.body.error).toMatchObject({ code: "PROJECTION_REBUILD_LIMIT" });
  expect(overLimit.body.error.message).toMatch(/aggregate event or byte limit/i);
  handler.dispose();
});

test("failed maintenance rebuild rolls back the replacement and leaves already-open workflow streams live", async () => {
  closeAllSubscribers();
  const fixture = await setup();
  const handler = fixture.makeHandler();
  const first = await json(handler, "/api/v1/maintenance/projection/rebuild", write({ operationId: "atomic-baseline" }));
  expect(first.response.status).toBe(200);
  const before = await json(handler, "/api/v1/history?limit=100");
  const live = await handler(request("/api/v1/stream"));
  const liveReader = live.body!.getReader();
  expect(new TextDecoder().decode((await liveReader.read()).value)).toContain("event: hello");
  expect(hasLiveSubscribers()).toBe(true);
  const journal = join(fixture.projectRoot, ".pi", "hive", "sessions", pruneSession, "journal");
  writeFileSync(join(journal, "zzzz-corrupt.json"), "{not-json}\n");
  const failed = await json(handler, "/api/v1/maintenance/projection/rebuild", write({ operationId: "atomic-corruption" }));
  expect(failed.response.status).toBe(400);
  expect(failed.body.error.message).toMatch(/corrupt|journal|chain/i);
  const after = await json(handler, "/api/v1/history?limit=100");
  expect(after.body.items).toEqual(before.body.items);
  expect(hasLiveSubscribers()).toBe(true);
  broadcastWorkflowEvent({ eventId: "still-live-after-failed-maintenance" }, "failure-live-cursor");
  const stillLive = await Promise.race([liveReader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("failed maintenance closed the live stream")), 250))]);
  expect(new TextDecoder().decode(stillLive.value)).toContain("still-live-after-failed-maintenance");
  await liveReader.cancel();
  handler.dispose();
  fixture.approvalLease.release();
  closeAllSubscribers();
});

test("production workflow synchronizer broadcasts live events with bounded subscriber lifecycle", async () => {
  closeAllSubscribers();
  const fixture = await setup();
  const synchronizer = createConfiguredWorkflowProjectionSynchronizer({
    databasePath: fixture.databasePath,
    onEvent: (event) => broadcastWorkflowEvent(event, encodeWorkflowHistoryCursor(event)),
  });
  expect(synchronizer.sync([fixture.projectRoot]).active).toBe(true);

  let handler = fixture.makeHandler();
  const live = await handler(request("/api/v1/stream"));
  const liveReader = live.body!.getReader();
  const hello = await liveReader.read();
  expect(new TextDecoder().decode(hello.value)).toContain("event: hello");
  const appended = appendWorkflowEvent(fixture.projectRoot, createWorkflowEvent({ eventId: "live-production-event", projectId, sessionId: pruneSession, runId: "run-prune", type: "artifact.recorded", producer: "harness", payload: { formatVersion: 1, nodeId: "root" } }));
  expect(synchronizer.sync([fixture.projectRoot]).events).toBe(1);
  const liveEvent = await Promise.race([liveReader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("live workflow event was not broadcast")), 250))]);
  const liveText = new TextDecoder().decode(liveEvent.value);
  expect(liveText).toContain("event: workflow");
  expect(liveText).toContain(appended.eventId);
  expect(hasLiveSubscribers()).toBe(true);
  await liveReader.cancel();
  expect(hasLiveSubscribers()).toBe(false);
  handler.dispose();

  handler = fixture.makeHandler({ streamLimits: { maxSubscribers: 1 } });
  const first = await handler(request("/api/v1/stream"));
  const firstReader = first.body!.getReader();
  const capped = await handler(request("/api/v1/stream"));
  expect(await capped.text()).toContain("subscriber-capacity");
  await firstReader.cancel();
  expect(hasLiveSubscribers()).toBe(false);
  handler.dispose();

  handler = fixture.makeHandler({ streamLimits: { bufferBytes: 512 } });
  const slow = await handler(request("/api/v1/stream"));
  const slowReader = slow.body!.getReader();
  appendWorkflowEvent(fixture.projectRoot, createWorkflowEvent({ eventId: "backpressure-production-event", projectId, sessionId: pruneSession, runId: "run-prune", type: "artifact.recorded", producer: "harness", payload: { formatVersion: 1, nodeId: "root" } }));
  expect(synchronizer.sync([fixture.projectRoot]).events).toBe(1);
  expect(hasLiveSubscribers()).toBe(false);
  expect(new TextDecoder().decode((await slowReader.read()).value)).toContain("event: hello");
  expect((await slowReader.read()).done).toBe(true);
  handler.dispose();

  const timers = new Map<symbol, Readonly<{ callback: () => void; delayMs: number }>>();
  const scheduler = {
    setTimeout(callback: () => void, delayMs: number) { const id = Symbol("timer"); timers.set(id, { callback, delayMs }); return id; },
    clearTimeout(timer: unknown) { timers.delete(timer as symbol); },
  };
  handler = fixture.makeHandler({ streamLimits: { idleMs: 100, lifetimeMs: 50, scheduler } });
  const expiring = await handler(request("/api/v1/stream"));
  const expiringReader = expiring.body!.getReader();
  expect(hasLiveSubscribers()).toBe(true);
  const lifetime = [...timers.values()].find((timer) => timer.delayMs === 50);
  expect(lifetime).toBeDefined();
  lifetime!.callback();
  expect(hasLiveSubscribers()).toBe(false);
  expect(new TextDecoder().decode((await expiringReader.read()).value)).toContain("event: hello");
  expect((await expiringReader.read()).done).toBe(true);

  handler.dispose();

  // Exercise the production legacy stream's shared global cap as well; both
  // channels participate in the daemon's idle/live-handle decision.
  handler = fixture.makeHandler();
  const legacyStreams: Response[] = [];
  for (let index = 0; index < 64; index += 1) legacyStreams.push(await handler(request("/stream")));
  const legacyCapped = await handler(request("/stream"));
  expect(await legacyCapped.text()).toContain("subscriber-capacity");
  await Promise.all(legacyStreams.map((response) => response.body!.cancel()));
  expect(hasLiveSubscribers()).toBe(false);

  handler.dispose();
  synchronizer.close();
  fixture.approvalLease.release();
  closeAllSubscribers();
});
