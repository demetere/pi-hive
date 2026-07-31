import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { appendWorkflowEvent, readWorkflowJournal } from "../../src/workflows/journal.ts";
import { createWorkflowEvent } from "../../src/workflows/events.ts";
import {
  KnowledgeEnrichmentService,
  restoreKnowledgeEnrichmentState,
} from "../../src/knowledge/enrichment.ts";
import { boundCuratorTargetContext, buildCuratorPrompt } from "../../src/knowledge/curator.ts";
import { createBuiltInKnowledgeProviderRegistry, KnowledgeProviderRegistry } from "../../src/knowledge/provider.ts";

function snapshot(): ActivationSnapshotFileV1 {
  return { snapshotHash: "a".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", payload: {
    project: { projectId: "project-1", rootRef: "." },
    workflow: { id: "delivery", team: { rootId: "root", nodes: [
      { id: "root", agentId: "lead", memberIds: ["alpha", "beta"], depth: 1 },
      { id: "alpha", agentId: "builder", parentId: "root", memberIds: [], depth: 2 },
      { id: "beta", agentId: "builder", parentId: "root", memberIds: [], depth: 2 },
    ] } },
    authority: { capabilityContractVersion: 1, nodes: [
      { nodeId: "root", capabilities: { effective: { knowledge: ["curate"] } }, tools: [], model: "root-model", thinking: "low" },
      { nodeId: "alpha", capabilities: { effective: { knowledge: ["propose", "curate"] } }, tools: ["knowledge_propose"], model: "builder-model", thinking: "low" },
      { nodeId: "beta", capabilities: { effective: { knowledge: ["propose", "curate"] } }, tools: ["knowledge_propose"], model: "builder-model", thinking: "low" },
    ] },
    agents: [{ id: "lead", name: "Lead", prompt: "lead" }, { id: "builder", name: "Builder", prompt: "builder" }],
    skills: [],
    knowledge: [
      { id: "builder-notes", provider: "okf", path: ".pi/hive/knowledge/builder-notes", owner: "builder", updates: "automatic", metadataFingerprint: "b".repeat(64), attachedNodeIds: ["alpha", "beta"] },
      { id: "project", provider: "okf", path: ".pi/hive/knowledge/project", updates: "reviewed", metadataFingerprint: "c".repeat(64), attachedNodeIds: ["root"] },
      { id: "audit", provider: "okf", path: ".pi/hive/knowledge/audit", updates: "read-only", metadataFingerprint: "d".repeat(64), attachedNodeIds: ["root"] },
    ],
    models: [
      { nodeId: "root", modelId: "root-model", thinking: "low", staticTokens: 1, dynamicReserve: 1, contextWindow: 100_000 },
      { nodeId: "alpha", modelId: "builder-model", thinking: "low", staticTokens: 1, dynamicReserve: 1, contextWindow: 100_000 },
      { nodeId: "beta", modelId: "builder-model", thinking: "low", staticTokens: 1, dynamicReserve: 1, contextWindow: 100_000 },
    ], sources: [], versions: {} as never,
  } } as unknown as ActivationSnapshotFileV1;
}

function fixture(runId = "run-1") {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-enrichment-"));
  for (const bundle of ["builder-notes", "project", "audit"]) {
    const directory = join(projectRoot, ".pi/hive/knowledge", bundle);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "existing.md"), `---\ntype: Knowledge\ntitle: ${bundle}\n---\n\nExisting verified knowledge.\n`);
  }
  let tick = 0;
  const service = new KnowledgeEnrichmentService({
    projectRoot, projectId: "project-1", sessionId: "session-1", runId, snapshot: snapshot(),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    createCandidateId: (() => { let n = 0; return () => `candidate-${++n}`; })(),
    createJobId: (() => { let n = 0; return () => `job-${++n}`; })(),
  });
  return { projectRoot, service };
}

function evidence(projectRoot: string, eventId: string, nodeId: string) {
  return appendWorkflowEvent(projectRoot, createWorkflowEvent({
    eventId, projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "attempt.result.recorded", producer: "harness",
    payload: { formatVersion: 1, nodeId, attemptId: `attempt-${nodeId}`, result: { ok: true, contentHash: `sha256:${"e".repeat(64)}` } },
    timestamp: "2026-01-01T00:00:00.000Z",
  }));
}

function terminal(projectRoot: string, status: "completed" | "failed" | "blocked" | "cancelled") {
  if (status === "cancelled") appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "run.cancel.requested", producer: "harness",
    payload: { formatVersion: 1, operationId: "cancel-1", reason: "stop", pendingQuestionIds: [] }, timestamp: "2026-01-01T00:00:03.000Z",
  }));
  return appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "terminal.recorded", producer: "harness",
    payload: { formatVersion: 1, status, summary: `${status} outcome`, fileChanges: [], changeCoverage: "recorded", artifactRefs: [], evidenceRefs: [], data: {}, partialState: {}, closedQuestionIds: [], unsatisfiedGates: [], finishedByNodeId: "root", finishedAt: "2026-01-01T00:00:04.000Z", snapshotId: "a".repeat(64), runId: "run-1" },
    timestamp: "2026-01-01T00:00:04.000Z",
  }));
}

function appendPreservedCancelledJob(projectRoot: string, terminalEventHash: string, candidateId: string): void {
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness",
    payload: { formatVersion: 1, operation: "jobs-enqueued", terminalEventHash, preservedCancelled: true, jobs: [{
      formatVersion: 1, jobId: "preserved-cancelled-job", projectId: "project-1", sessionId: "session-1", runId: "run-1", terminalEventHash,
      scope: "agent", agentId: "builder", candidateIds: [candidateId],
      targets: [{ bundleId: "builder-notes", providerId: "okf", path: ".pi/hive/knowledge/builder-notes", policy: "automatic", expectedContentHash: `sha256:${"f".repeat(64)}` }],
      model: { nodeId: "alpha", modelId: "builder-model", thinking: "low", reason: "agent-lowest-participating-node;shared-workflow-root" },
      state: "queued", attemptCount: 0, staleReevaluations: 0, createdAt: "2026-01-01T00:00:05.000Z", updatedAt: "2026-01-01T00:00:05.000Z",
    }] } as never,
  }));
}

test("terminal consolidation creates one deterministic agent job for repeated nodes and one shared job", () => {
  const f = fixture();
  evidence(f.projectRoot, "evidence-alpha", "alpha");
  evidence(f.projectRoot, "evidence-beta", "beta");
  f.service.propose("alpha", "tool-alpha", { scope: "agent", conclusion: "The build graph requires deterministic ordering.", evidenceEventIds: ["evidence-alpha"] });
  f.service.propose("beta", "tool-beta", { scope: "agent", conclusion: "Tests must use the same deterministic build order.", evidenceEventIds: ["evidence-beta"] });
  f.service.propose("alpha", "tool-shared", { scope: "shared", conclusion: "The project uses a deterministic build graph.", evidenceEventIds: ["evidence-alpha", "evidence-beta"] });
  const result = f.service.enqueueTerminal(terminal(f.projectRoot, "completed"));

  assert.equal(result.enqueued, 2);
  const state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  const jobs = Object.values(state.jobs).sort((a, b) => a.scope.localeCompare(b.scope));
  assert.deepEqual(jobs.map((job) => ({ scope: job.scope, agentId: job.agentId, candidates: job.candidateIds, bundles: job.targets.map((target) => `${target.bundleId}:${target.policy}`), model: job.model.modelId })), [
    { scope: "agent", agentId: "builder", candidates: ["candidate-1", "candidate-2"], bundles: ["builder-notes:automatic"], model: "builder-model" },
    { scope: "shared", agentId: undefined, candidates: ["candidate-3"], bundles: ["audit:read-only", "project:reviewed"], model: "root-model" },
  ]);
  assert.equal(jobs.every((job) => job.state === "queued"), true);
});

test("completed, failed and blocked may enqueue; cancelled requires explicit preservation and repeated enqueue is idempotent", () => {
  for (const status of ["completed", "failed", "blocked", "cancelled"] as const) {
    const f = fixture();
    evidence(f.projectRoot, "evidence-alpha", "alpha");
    f.service.propose("alpha", "tool-alpha", { scope: "agent", conclusion: "Stable conclusion with exact evidence.", evidenceEventIds: ["evidence-alpha"] });
    const event = terminal(f.projectRoot, status);
    const first = f.service.enqueueTerminal(event);
    assert.equal(first.enqueued, status === "cancelled" ? 0 : 1, status);
    assert.equal(restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).terminalEnqueueCompleted[event.eventHash], true, `${status} reconciliation must become durably complete even when policy enqueues no job`);
    if (status !== "cancelled") assert.deepEqual(f.service.enqueueTerminal(event), { enqueued: 0, skipped: 0, alreadyEnqueued: true });
  }

  const preserved = fixture();
  evidence(preserved.projectRoot, "evidence-alpha", "alpha");
  preserved.service.propose("alpha", "tool-alpha", { scope: "agent", conclusion: "Preserve this user-requested cancelled-run conclusion.", evidenceEventIds: ["evidence-alpha"] });
  preserved.service.requestCancelledPreservation();
  assert.equal(preserved.service.enqueueTerminal(terminal(preserved.projectRoot, "cancelled"), { preserveCancelled: true }).enqueued, 1);
});

test("durable candidate and job reducers reject unknown fields and out-of-bound persisted shapes", () => {
  const malformedCandidate = fixture();
  appendWorkflowEvent(malformedCandidate.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "runtime",
    payload: { formatVersion: 1, operation: "candidate-recorded", candidate: { formatVersion: 1, candidateId: "bad", projectId: "project-1", sessionId: "session-1", runId: "run-1", nodeId: "alpha", agentId: "builder", scope: "agent", conclusion: "x".repeat(4_097), citations: [], sourceHashes: [], createdAt: "2026-01-01T00:00:00.000Z", injectedAuthority: true } } as never,
  }));
  assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(malformedCandidate.projectRoot, "session-1")), /candidate|schema|bound|field/i);

  const forgedProducer = fixture();
  evidence(forgedProducer.projectRoot, "evidence-alpha", "alpha");
  const validCandidate = forgedProducer.service.propose("alpha", "tool-alpha", { scope: "agent", conclusion: "A properly bounded candidate for producer replay.", evidenceEventIds: ["evidence-alpha"] });
  const candidateEvent = readWorkflowJournal(forgedProducer.projectRoot, "session-1").at(-1)!;
  appendWorkflowEvent(forgedProducer.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "dashboard",
    payload: { formatVersion: 1, operation: "candidate-recorded", candidate: { ...validCandidate, candidateId: "forged-producer" } } as never,
  }));
  assert.equal(candidateEvent.producer, "runtime");
  assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(forgedProducer.projectRoot, "session-1")), /producer|authority/i);

  const malformedJob = fixture();
  appendWorkflowEvent(malformedJob.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness",
    payload: { formatVersion: 1, operation: "jobs-enqueued", terminalEventHash: "a".repeat(64), jobs: [{ formatVersion: 1, jobId: "bad-job", projectId: "project-1", sessionId: "session-1", runId: "run-1", terminalEventHash: "a".repeat(64), scope: "shared", candidateIds: [], targets: [], model: {}, state: "queued", attemptCount: 0, staleReevaluations: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", authority: "injected" }] } as never,
  }));
  assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(malformedJob.projectRoot, "session-1")), /job|schema|field|target|model/i);
});

test("candidate and job reducers fail closed for independently malformed durable fields", () => {
  const candidateFixture = fixture();
  evidence(candidateFixture.projectRoot, "schema-evidence", "alpha");
  candidateFixture.service.propose("alpha", "schema-attempt", {
    scope: "agent", conclusion: "A valid candidate anchors independent fail-closed schema cases.", evidenceEventIds: ["schema-evidence"],
  });
  const candidateEvents = readWorkflowJournal(candidateFixture.projectRoot, "session-1");
  const candidateIndex = candidateEvents.findIndex((event) => (event.payload as any).operation === "candidate-recorded");
  const candidateEvent = candidateEvents[candidateIndex];
  const validCandidate = structuredClone((candidateEvent.payload as any).candidate);
  const candidateCases: ReadonlyArray<readonly [string, (candidate: any) => void]> = [
    ["exact fields", (candidate) => { candidate.authority = true; }],
    ["format version", (candidate) => { candidate.formatVersion = 2; }],
    ["scope", (candidate) => { candidate.scope = "global"; }],
    ["request hash type", (candidate) => { candidate.requestHash = 1; }],
    ["request hash grammar", (candidate) => { candidate.requestHash = "z".repeat(64); }],
    ["created time", (candidate) => { candidate.createdAt = "not-a-time"; }],
    ["candidate ID", (candidate) => { candidate.candidateId = "bad/id"; }],
    ["conclusion type", (candidate) => { candidate.conclusion = 1; }],
    ["conclusion minimum", (candidate) => { candidate.conclusion = "short"; }],
    ["conclusion maximum", (candidate) => { candidate.conclusion = "x".repeat(4_097); }],
    ["conclusion control", (candidate) => { candidate.conclusion = "Unsafe conclusion\u0000text"; }],
    ["citations type", (candidate) => { candidate.citations = {}; }],
    ["citations empty", (candidate) => { candidate.citations = []; }],
    ["citations bound", (candidate) => { candidate.citations = Array.from({ length: 65 }, () => candidate.citations[0]); }],
    ["source hashes type", (candidate) => { candidate.sourceHashes = {}; }],
    ["source hashes empty", (candidate) => { candidate.sourceHashes = []; }],
    ["source hashes bound", (candidate) => { candidate.sourceHashes = Array.from({ length: 65 }, () => candidate.sourceHashes[0]); }],
    ["source hash type", (candidate) => { candidate.sourceHashes = [1]; }],
    ["source hash grammar", (candidate) => { candidate.sourceHashes = [`sha256:${"z".repeat(64)}`]; }],
    ["citation object", (candidate) => { candidate.citations = [null]; }],
    ["citation exactness", (candidate) => { candidate.citations[0].authority = true; }],
    ["citation event type", (candidate) => { candidate.citations[0].type = "terminal.recorded"; }],
    ["citation event hash type", (candidate) => { candidate.citations[0].eventHash = 1; }],
    ["citation event hash grammar", (candidate) => { candidate.citations[0].eventHash = "z".repeat(64); }],
    ["citation payload hash type", (candidate) => { candidate.citations[0].payloadHash = 1; }],
    ["citation payload hash grammar", (candidate) => { candidate.citations[0].payloadHash = "z".repeat(64); }],
    ["citation sequence integer", (candidate) => { candidate.citations[0].sequence = 1.5; }],
    ["citation sequence positive", (candidate) => { candidate.citations[0].sequence = 0; }],
    ["citation event ID", (candidate) => { candidate.citations[0].eventId = "bad/id"; }],
  ];
  assert.throws(() => restoreKnowledgeEnrichmentState(candidateEvents.map((event, index) => index === candidateIndex
    ? { ...event, payload: { ...(event.payload as any), candidate: null } }
    : event)), /candidate|schema/i, "candidate object");
  for (const [label, mutate] of candidateCases) {
    const candidate = structuredClone(validCandidate);
    mutate(candidate);
    const events = [...candidateEvents];
    events[candidateIndex] = { ...candidateEvent, payload: { ...(candidateEvent.payload as any), candidate } };
    assert.throws(() => restoreKnowledgeEnrichmentState(events), /candidate|conclusion|citation|hash|ID|schema|provenance/i, label);
  }

  const jobFixture = fixture();
  evidence(jobFixture.projectRoot, "job-schema-evidence", "alpha");
  jobFixture.service.propose("alpha", "job-schema-attempt", {
    scope: "agent", conclusion: "A valid job anchors independent fail-closed schema cases.", evidenceEventIds: ["job-schema-evidence"],
  });
  jobFixture.service.enqueueTerminal(terminal(jobFixture.projectRoot, "completed"));
  const jobEvents = readWorkflowJournal(jobFixture.projectRoot, "session-1");
  const jobIndex = jobEvents.findIndex((event) => (event.payload as any).operation === "jobs-enqueued");
  const jobEvent = jobEvents[jobIndex];
  const validJob = structuredClone((jobEvent.payload as any).jobs[0]);
  const jobCases: ReadonlyArray<readonly [string, (job: any) => void]> = [
    ["exact fields", (job) => { job.authority = true; }],
    ["format version", (job) => { job.formatVersion = 2; }],
    ["scope", (job) => { job.scope = "global"; }],
    ["state", (job) => { job.state = "running"; }],
    ["terminal hash type", (job) => { job.terminalEventHash = 1; }],
    ["terminal hash grammar", (job) => { job.terminalEventHash = "z".repeat(64); }],
    ["attempt integer", (job) => { job.attemptCount = 1.5; }],
    ["attempt positive", (job) => { job.attemptCount = -1; }],
    ["reevaluation integer", (job) => { job.staleReevaluations = 1.5; }],
    ["reevaluation positive", (job) => { job.staleReevaluations = -1; }],
    ["reevaluation maximum", (job) => { job.staleReevaluations = 2; }],
    ["fallback marker", (job) => { job.staleFallbackRequired = false; }],
    ["fallback counter", (job) => { job.staleFallbackRequired = true; }],
    ["created time", (job) => { job.createdAt = "not-a-time"; }],
    ["updated time", (job) => { job.updatedAt = "not-a-time"; }],
    ["job ID", (job) => { job.jobId = "bad/id"; }],
    ["agent owner required", (job) => { delete job.agentId; }],
    ["shared owner prohibited", (job) => { job.scope = "shared"; }],
    ["agent owner grammar", (job) => { job.agentId = "Bad_Agent"; }],
    ["candidate IDs type", (job) => { job.candidateIds = {}; }],
    ["candidate IDs empty", (job) => { job.candidateIds = []; }],
    ["candidate IDs bound", (job) => { job.candidateIds = Array.from({ length: 514 }, (_, index) => `candidate-${index}`); }],
    ["candidate IDs unique", (job) => { job.candidateIds = [job.candidateIds[0], job.candidateIds[0]]; }],
    ["candidate ID grammar", (job) => { job.candidateIds = ["bad/id"]; }],
    ["targets type", (job) => { job.targets = {}; }],
    ["targets empty", (job) => { job.targets = []; }],
    ["targets bound", (job) => { job.targets = Array.from({ length: 129 }, () => job.targets[0]); }],
    ["target object", (job) => { job.targets = [null]; }],
    ["target exactness", (job) => { job.targets[0].authority = true; }],
    ["target bundle type", (job) => { job.targets[0].bundleId = 1; }],
    ["target provider type", (job) => { job.targets[0].providerId = 1; }],
    ["target path type", (job) => { job.targets[0].path = 1; }],
    ["target path empty", (job) => { job.targets[0].path = ""; }],
    ["target path absolute", (job) => { job.targets[0].path = "/tmp/bundle"; }],
    ["target path separator", (job) => { job.targets[0].path = ".pi\\hive"; }],
    ["target path empty segment", (job) => { job.targets[0].path = ".pi//bundle"; }],
    ["target path dot segment", (job) => { job.targets[0].path = ".pi/./bundle"; }],
    ["target path parent segment", (job) => { job.targets[0].path = ".pi/../bundle"; }],
    ["target bundle grammar", (job) => { job.targets[0].bundleId = "bad/id"; }],
    ["target policy", (job) => { job.targets[0].policy = "mutable"; }],
    ["target hash type", (job) => { job.targets[0].expectedContentHash = 1; }],
    ["target hash grammar", (job) => { job.targets[0].expectedContentHash = `sha256:${"z".repeat(64)}`; }],
    ["target identity unique", (job) => { job.targets = [job.targets[0], structuredClone(job.targets[0])]; }],
    ["model object", (job) => { job.model = null; }],
    ["model exactness", (job) => { job.model.authority = true; }],
    ["model selection", (job) => { job.model.reason = "dynamic"; }],
    ["model ID type", (job) => { job.model.modelId = 1; }],
    ["model ID empty", (job) => { job.model.modelId = ""; }],
    ["thinking type", (job) => { job.model.thinking = 1; }],
    ["thinking empty", (job) => { job.model.thinking = ""; }],
    ["model node ID", (job) => { job.model.nodeId = "bad/id"; }],
    ["active owner required", (job) => { job.state = "active"; }],
    ["active owner grammar", (job) => { job.state = "active"; job.activeOwnerNonce = "bad/owner"; }],
    ["inactive owner prohibited", (job) => { job.activeOwnerNonce = "owner"; }],
    ["reason type", (job) => { job.lastReason = 1; }],
    ["reason bound", (job) => { job.lastReason = "x".repeat(2_049); }],
  ];
  assert.throws(() => restoreKnowledgeEnrichmentState(jobEvents.map((event, index) => index === jobIndex
    ? { ...event, payload: { ...(event.payload as any), jobs: [null] } }
    : event)), /job|schema/i, "job object");
  for (const [label, mutate] of jobCases) {
    const job = structuredClone(validJob);
    mutate(job);
    const events = [...jobEvents];
    events[jobIndex] = { ...jobEvent, payload: { ...(jobEvent.payload as any), jobs: [job] } };
    assert.throws(() => restoreKnowledgeEnrichmentState(events), /job|target|model|owner|reason|ID|schema/i, label);
  }
});

test("reducers enforce one candidate per exact attempt, one terminal scope job, and plan-effect closure before completion", () => {
  {
    const f = fixture();
    evidence(f.projectRoot, "duplicate-attempt-evidence", "alpha");
    const candidate = f.service.propose("alpha", "same-attempt", { scope: "agent", conclusion: "One attempt has exactly one durable candidate effect.", evidenceEventIds: ["duplicate-attempt-evidence"] });
    appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "runtime", correlationId: "same-attempt", attemptId: "same-attempt",
      payload: { formatVersion: 1, operation: "candidate-recorded", candidate: { ...candidate, candidateId: "candidate-duplicate-attempt" } } as never }));
    assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")), /attempt.*duplicated|candidate.*duplicated/i);
  }
  {
    const f = fixture();
    evidence(f.projectRoot, "duplicate-job-evidence", "alpha");
    f.service.propose("alpha", "duplicate-job-attempt", { scope: "agent", conclusion: "One terminal scope has exactly one consolidated job.", evidenceEventIds: ["duplicate-job-evidence"] });
    const terminalEvent = terminal(f.projectRoot, "completed");
    f.service.enqueueTerminal(terminalEvent);
    const state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
    const existing = Object.values(state.jobs)[0];
    appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness",
      payload: { formatVersion: 1, operation: "jobs-enqueued", terminalEventHash: terminalEvent.eventHash, preservedCancelled: false, jobs: [{ ...existing, jobId: "duplicate-consolidated-job" }] } as never }));
    assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")), /terminal\/scope\/agent|consolidation key|duplicated|enqueue completion/i);
  }
  {
    const f = fixture();
    evidence(f.projectRoot, "closure-evidence", "alpha");
    f.service.propose("alpha", "closure-attempt", { scope: "agent", conclusion: "Completion requires every exact durable plan effect.", evidenceEventIds: ["closure-evidence"] });
    f.service.enqueueTerminal(terminal(f.projectRoot, "completed"));
    const job = Object.values(restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs)[0];
    appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: job.projectId, sessionId: job.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness",
      payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "queued", to: "active", attemptCount: 1, staleReevaluations: 0, reason: "start", ownerNonce: "closure-owner" } }));
    appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: job.projectId, sessionId: job.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness",
      payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "active", to: "completed", attemptCount: 1, staleReevaluations: 0, reason: "forged-completion", ownerNonce: "closure-owner" } }));
    assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")), /plan-effect closure|completion|plan/i);
  }
});

test("candidate proposals derive immutable citation hashes and reject missing evidence or authority", () => {
  const f = fixture();
  const event = evidence(f.projectRoot, "evidence-alpha", "alpha");
  const candidate = f.service.propose("alpha", "tool-alpha", { scope: "agent", conclusion: "A stable verified conclusion.", evidenceEventIds: [event.eventId] });
  assert.deepEqual(candidate.citations, [{ eventId: event.eventId, eventHash: event.eventHash, payloadHash: event.payloadHash, sequence: event.sequence, type: event.type }]);
  assert.deepEqual(candidate.sourceHashes, [`sha256:${"e".repeat(64)}`]);
  assert.throws(() => f.service.propose("alpha", "bad", { scope: "agent", conclusion: "No evidence.", evidenceEventIds: ["missing"] }), /evidence/i);
  assert.throws(() => f.service.propose("missing", "bad", { scope: "agent", conclusion: "Unauthorized.", evidenceEventIds: [event.eventId] }), /authority|node/i);

  const noHashes = appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    eventId: "evidence-without-source-hash", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "attempt.result.recorded", producer: "harness",
    payload: { formatVersion: 1, nodeId: "alpha", attemptId: "no-hash", result: { ok: true } },
  }));
  assert.throws(() => f.service.propose("alpha", "no-hash-tool", { scope: "agent", conclusion: "This conclusion has no durable source hash.", evidenceEventIds: [noHashes.eventId] }), /source hash|provenance/i);

  const nestedForeign = appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    eventId: "nested-foreign-node", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness",
    payload: { formatVersion: 1, operation: "audit", participant: { nodeId: "root" }, contentHash: `sha256:${"f".repeat(64)}` },
  }));
  assert.throws(() => f.service.propose("alpha", "nested-foreign", { scope: "agent", conclusion: "Nested evidence belongs to another catalog agent.", evidenceEventIds: [nestedForeign.eventId] }), /another catalog agent|scope/i);

  const traversalOverflow = appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    eventId: "nested-scope-overflow", projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness",
    payload: { formatVersion: 1, nodeId: "alpha", foreign: { participant: { nodeId: "root" } }, padding: [...Array.from({ length: 4_095 }, () => 0), `sha256:${"a".repeat(64)}`] },
  }));
  assert.throws(() => f.service.propose("alpha", "nested-overflow", { scope: "agent", conclusion: "Incomplete nested scope traversal must fail closed.", evidenceEventIds: [traversalOverflow.eventId] }), /scope|bound|participant|traversal/i);
});

test("candidate and job event envelopes bind exact project/session/run/terminal identities", () => {
  const f = fixture();
  const base = {
    formatVersion: 1, candidateId: "mismatch", projectId: "other-project", sessionId: "session-1", runId: "run-1", nodeId: "alpha", agentId: "builder", scope: "agent",
    conclusion: "A forged envelope mismatch must fail closed.", citations: [{ eventId: "evidence", eventHash: "a".repeat(64), payloadHash: "b".repeat(64), sequence: 1, type: "attempt.result.recorded" }],
    sourceHashes: [`sha256:${"c".repeat(64)}`], createdAt: "2026-01-01T00:00:00.000Z",
  };
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "runtime",
    payload: { formatVersion: 1, operation: "candidate-recorded", candidate: base, injectedAuthority: true } as never,
  }));
  assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")), /envelope|identity|unknown|field/i);
});

test("enqueue completion rejects an undisposed exact same-terminal candidate", () => {
  const f = fixture();
  evidence(f.projectRoot, "coverage-evidence", "alpha");
  f.service.propose("alpha", "coverage-attempt", { scope: "agent", conclusion: "Every terminal candidate requires one exact durable disposition.", evidenceEventIds: ["coverage-evidence"] });
  const terminalEvent = terminal(f.projectRoot, "completed");
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness",
    payload: { formatVersion: 1, operation: "jobs-enqueue-completed", terminalEventHash: terminalEvent.eventHash, jobIds: [], skipped: 0 },
  }));
  assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")), /candidate|disposition|completion|enqueue/i);
});

test("replay rejects a same-run candidate recorded after its terminal", () => {
  const f = fixture();
  evidence(f.projectRoot, "terminal-order-evidence", "alpha");
  const candidate = f.service.propose("alpha", "terminal-order-source", { scope: "agent", conclusion: "Terminal ordering closes candidate publication authoritatively.", evidenceEventIds: ["terminal-order-evidence"] });
  terminal(f.projectRoot, "completed");
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "runtime", correlationId: "terminal-order-late", attemptId: "terminal-order-late",
    payload: { formatVersion: 1, operation: "candidate-recorded", candidate: { ...candidate, candidateId: "candidate-after-terminal", requestHash: "1".repeat(64) } } as never,
  }));
  assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")), /candidate|terminal|late|ordering/i);
});

test("replay rejects a same-run candidate recorded after terminal enqueue completion", () => {
  const f = fixture();
  evidence(f.projectRoot, "completion-order-evidence", "alpha");
  const candidate = f.service.propose("alpha", "completion-order-source", { scope: "agent", conclusion: "Completed terminal disposition permanently closes candidate publication.", evidenceEventIds: ["completion-order-evidence"] });
  f.service.enqueueTerminal(terminal(f.projectRoot, "completed"));
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "runtime", correlationId: "completion-order-late", attemptId: "completion-order-late",
    payload: { formatVersion: 1, operation: "candidate-recorded", candidate: { ...candidate, candidateId: "candidate-after-completion", requestHash: "2".repeat(64) } } as never,
  }));
  assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")), /candidate|terminal|completion|late|ordering/i);
});

test("restart reconciles a terminal after an audited skip was durable but enqueue completion crashed", () => {
  const f = fixture();
  evidence(f.projectRoot, "skip-restart-evidence", "alpha");
  f.service.propose("alpha", "skip-restart-tool", { scope: "agent", conclusion: "Cancelled candidate skip recovery remains deterministic.", evidenceEventIds: ["skip-restart-evidence"] });
  const terminalEvent = terminal(f.projectRoot, "cancelled");
  let armed = true;
  const faulting = new KnowledgeEnrichmentService({
    ...f.service.options,
    fault: (stage: string) => { if (armed && stage === "after-skip") { armed = false; throw new Error("fault:after-skip"); } },
  } as any);
  assert.throws(() => faulting.enqueueTerminal(terminalEvent), /fault:after-skip/);
  let state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  assert.equal(state.terminalSkipped[terminalEvent.eventHash], 1);
  assert.equal(state.terminalEnqueueCompleted[terminalEvent.eventHash], undefined);
  const recovered = new KnowledgeEnrichmentService(f.service.options).enqueueTerminal(terminalEvent);
  assert.equal(recovered.alreadyEnqueued, false);
  state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  assert.equal(state.terminalEnqueueCompleted[terminalEvent.eventHash], true);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").filter((event) => (event.payload as any).operation === "enrichment-skipped").length, 1);
});

test("published keyed job reconciliation completes without reloading an unavailable provider", () => {
  const f = fixture();
  evidence(f.projectRoot, "published-job-evidence", "alpha");
  f.service.propose("alpha", "published-job-attempt", { scope: "agent", conclusion: "Already durable enrichment work must not be starved by later provider loss.", evidenceEventIds: ["published-job-evidence"] });
  const terminalEvent = terminal(f.projectRoot, "completed");
  let armed = true;
  const faulting = new KnowledgeEnrichmentService({ ...f.service.options, fault: (stage: string) => {
    if (armed && stage === "after-job") { armed = false; throw new Error("fault:after-job"); }
  } } as any);
  assert.throws(() => faulting.enqueueTerminal(terminalEvent), /fault:after-job/);
  assert.equal(Object.keys(restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs).length, 1);
  const unavailable = new KnowledgeEnrichmentService({ ...f.service.options, providers: new KnowledgeProviderRegistry() });
  const recovered = unavailable.enqueueTerminal(terminalEvent);
  assert.equal(recovered.alreadyEnqueued, false);
  assert.equal(restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).terminalEnqueueCompleted[terminalEvent.eventHash], true);
});

test("job enqueue envelope binds cancellation preservation policy to the exact terminal status", () => {
  const f = fixture();
  evidence(f.projectRoot, "cancel-policy-evidence", "alpha");
  f.service.propose("alpha", "cancel-policy-tool", { scope: "agent", conclusion: "Cancelled evidence requires an explicit preservation decision.", evidenceEventIds: ["cancel-policy-evidence"] });
  f.service.requestCancelledPreservation();
  f.service.enqueueTerminal(terminal(f.projectRoot, "cancelled"), { preserveCancelled: true });
  const events = readWorkflowJournal(f.projectRoot, "session-1");
  const forged = events.map((event) => (event.payload as any).operation === "jobs-enqueued"
    ? ({ ...event, payload: { ...(event.payload as any), preservedCancelled: false } })
    : event);
  assert.throws(() => restoreKnowledgeEnrichmentState(forged as any), /cancel|preserv|terminal|envelope/i);
});

test("preserved cancelled enqueue requires an exact prior preservation request", () => {
  const missing = fixture();
  evidence(missing.projectRoot, "missing-preservation-evidence", "alpha");
  const missingCandidate = missing.service.propose("alpha", "missing-preservation-attempt", { scope: "agent", conclusion: "A preserved cancellation requires durable prior policy evidence.", evidenceEventIds: ["missing-preservation-evidence"] });
  const missingTerminal = terminal(missing.projectRoot, "cancelled");
  appendPreservedCancelledJob(missing.projectRoot, missingTerminal.eventHash, missingCandidate.candidateId);
  assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(missing.projectRoot, "session-1")), /preserv|request|prior|cancel/i);

  const late = fixture();
  evidence(late.projectRoot, "late-preservation-evidence", "alpha");
  const lateCandidate = late.service.propose("alpha", "late-preservation-attempt", { scope: "agent", conclusion: "Late preservation cannot authorize terminal enrichment.", evidenceEventIds: ["late-preservation-evidence"] });
  const lateTerminal = terminal(late.projectRoot, "cancelled");
  appendWorkflowEvent(late.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness",
    payload: { formatVersion: 1, operation: "cancel-preservation-requested", runId: "run-1" },
  }));
  appendPreservedCancelledJob(late.projectRoot, lateTerminal.eventHash, lateCandidate.candidateId);
  assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(late.projectRoot, "session-1")), /preserv|request|prior|late|terminal|ordering/i);
});

test("terminal enqueue persists only candidates fitting the exact production prompt and audits the remainder", () => {
  const f = fixture();
  for (let index = 0; index < 140; index++) {
    const event = evidence(f.projectRoot, `bulk-evidence-${index}`, "alpha");
    f.service.propose("alpha", `bulk-tool-${index}`, { scope: "agent", conclusion: `Stable bounded conclusion number ${index} has exact evidence.`, evidenceEventIds: [event.eventId] });
  }
  const result = f.service.enqueueTerminal(terminal(f.projectRoot, "completed"));
  assert.equal(result.enqueued, 1);
  assert.ok(result.skipped > 0);
  const state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  assert.equal(Object.values(state.jobs)[0].candidateIds.length + result.skipped, 140);
  const enqueueEvents = readWorkflowJournal(f.projectRoot, "session-1").filter((event) => event.type === "knowledge.transition" && (event.payload as any).operation === "jobs-enqueued");
  assert.equal(enqueueEvents.length, 1);
  assert.equal((enqueueEvents[0].payload as any).jobs.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(enqueueEvents[0].payload), "utf8") < 262_144);

  const job = Object.values(state.jobs)[0];
  writeFileSync(join(f.projectRoot, ".pi/hive/knowledge/builder-notes/existing.md"), `---\ntype: Knowledge\ntitle: builder-notes\ndescription: ${"x".repeat(4_000)}\n---\n\nStill-valid target growth.\n`);
  const registry = createBuiltInKnowledgeProviderRegistry();
  const contexts = job.targets.map((target) => {
    const loaded = registry.load({ projectRoot: f.projectRoot, declaration: { id: target.bundleId, providerId: target.providerId, path: target.path, updatePolicy: target.policy } });
    assert.equal(loaded.ok, true);
    return { bundleId: target.bundleId, policy: target.policy, expectedContentHash: target.expectedContentHash, currentSummary: loaded.bundle!.summary, documentCount: loaded.bundle!.documents.length };
  });
  const grownPrompt = buildCuratorPrompt({ jobId: job.jobId, scope: job.scope, targets: boundCuratorTargetContext(contexts),
    candidates: job.candidateIds.map((id) => state.candidates[id]).map((candidate) => ({ candidateId: candidate.candidateId, conclusion: candidate.conclusion, citations: candidate.citations, sourceHashes: candidate.sourceHashes })) });
  assert.ok(Buffer.byteLength(grownPrompt, "utf8") <= 32_768, "valid target growth cannot strand an already accepted curator job");
});

test("terminal consolidation applies a serialized curator-input budget and durably audits every omitted candidate", () => {
  const f = fixture();
  for (let index = 0; index < 40; index++) {
    const event = evidence(f.projectRoot, `large-evidence-${index}`, "alpha");
    f.service.propose("alpha", `large-tool-${index}`, {
      scope: "agent",
      conclusion: `${String(index).padStart(2, "0")}: ${"bounded stable evidence ".repeat(170)}`,
      evidenceEventIds: [event.eventId],
    });
  }
  const result = f.service.enqueueTerminal(terminal(f.projectRoot, "completed"));
  assert.ok(result.skipped > 0, "candidate bytes that cannot fit the curator prompt must be counted as audited skips");
  const events = readWorkflowJournal(f.projectRoot, "session-1");
  const state = restoreKnowledgeEnrichmentState(events);
  const job = Object.values(state.jobs)[0];
  assert.equal(job.candidateIds.length + result.skipped, 40);
  const skip = events.find((event) => (event.payload as any).operation === "enrichment-skipped" && (event.payload as any).reason === "curator-input-byte-limit");
  assert.equal((skip?.payload as any).candidateIds.length, result.skipped);
  const registry = createBuiltInKnowledgeProviderRegistry();
  const contexts = job.targets.map((target) => {
    const loaded = registry.load({ projectRoot: f.projectRoot, declaration: { id: target.bundleId, providerId: target.providerId, path: target.path, updatePolicy: target.policy } });
    assert.equal(loaded.ok, true);
    return { bundleId: target.bundleId, policy: target.policy, expectedContentHash: target.expectedContentHash, currentSummary: loaded.bundle!.summary, documentCount: loaded.bundle!.documents.length };
  });
  const prompt = buildCuratorPrompt({ jobId: job.jobId, scope: job.scope, targets: boundCuratorTargetContext(contexts),
    candidates: job.candidateIds.map((id) => state.candidates[id]).map((candidate) => ({ candidateId: candidate.candidateId, conclusion: candidate.conclusion, citations: candidate.citations, sourceHashes: candidate.sourceHashes })) });
  assert.ok(Buffer.byteLength(prompt, "utf8") <= 32_768, "durable admission input must fit the exact production conservative preflight");
});

test("large target omissions are chunked into byte-bounded durable audits without losing any identifier", () => {
  const active = snapshot() as any;
  active.payload.knowledge = Array.from({ length: 300 }, (_, index) => ({
    id: `bundle-${String(index).padStart(3, "0")}`, provider: "okf", path: `.pi/hive/knowledge/bundle-${String(index).padStart(3, "0")}`,
    updates: "reviewed", metadataFingerprint: String(index % 10).repeat(64), attachedNodeIds: ["root"],
  }));
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-enrichment-skip-chunks-"));
  for (const declaration of active.payload.knowledge) {
    const directory = join(projectRoot, declaration.path);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "existing.md"), `---\ntype: Knowledge\ntitle: ${declaration.id}\n---\n\nExisting.\n`);
  }
  const service = new KnowledgeEnrichmentService({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, createCandidateId: () => "chunk-candidate" });
  const cited = evidence(projectRoot, "chunk-evidence", "alpha");
  service.propose("alpha", "chunk-tool", { scope: "shared", conclusion: "Large omission audits preserve every target identity.", evidenceEventIds: [cited.eventId] });
  service.enqueueTerminal(terminal(projectRoot, "completed"));
  const skips = readWorkflowJournal(projectRoot, "session-1").filter((event) => (event.payload as any).operation === "enrichment-skipped" && ["target-limit", "target-payload-byte-limit"].includes((event.payload as any).reason));
  assert.ok(skips.length > 1);
  assert.equal(skips.every((event) => (event.payload as any).bundleIds.length <= 128 && Buffer.byteLength(JSON.stringify(event.payload), "utf8") <= 65_536), true);
  const omitted = skips.flatMap((event) => (event.payload as any).bundleIds);
  assert.equal(omitted.length, 300 - Object.values(restoreKnowledgeEnrichmentState(readWorkflowJournal(projectRoot, "session-1")).jobs)[0].targets.length);
  assert.equal(new Set(omitted).size, omitted.length);
});

test("agent proposer authority is separate from same-agent curator model authority", () => {
  const active = snapshot() as any;
  active.payload.authority.nodes.find((node: any) => node.nodeId === "alpha").capabilities.effective.knowledge = ["propose"];
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-enrichment-authority-split-"));
  for (const bundle of ["builder-notes", "project", "audit"]) {
    const directory = join(projectRoot, ".pi/hive/knowledge", bundle);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "existing.md"), `---\ntype: Knowledge\ntitle: ${bundle}\n---\n\nExisting verified knowledge.\n`);
  }
  const service = new KnowledgeEnrichmentService({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, createCandidateId: () => "split-candidate" });
  evidence(projectRoot, "split-evidence", "alpha");
  service.propose("alpha", "split-tool", { scope: "agent", conclusion: "Proposal authority does not grant controlled curator execution.", evidenceEventIds: ["split-evidence"] });
  service.enqueueTerminal(terminal(projectRoot, "completed"));
  const job = Object.values(restoreKnowledgeEnrichmentState(readWorkflowJournal(projectRoot, "session-1")).jobs)[0];
  assert.equal(job.model.nodeId, "beta");
  assert.equal(job.model.modelId, "builder-model");
});

test("proposal authority is separate from durable curator selection authority", () => {
  const f = fixture();
  const event = evidence(f.projectRoot, "shared-worker-evidence", "alpha");
  f.service.propose("alpha", "shared-worker-tool", { scope: "shared", conclusion: "A worker may propose shared evidence for a controlled root curator.", evidenceEventIds: [event.eventId] });
  const result = f.service.enqueueTerminal(terminal(f.projectRoot, "completed"));
  assert.equal(result.enqueued, 1);
  const job = Object.values(restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs)[0];
  assert.equal(job.model.nodeId, "root");
  assert.equal(job.model.modelId, "root-model");
});
