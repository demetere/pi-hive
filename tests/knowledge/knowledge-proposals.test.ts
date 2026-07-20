import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { createCuratorPlan } from "../../src/knowledge/enrichment.ts";
import { parseCuratorOutput } from "../../src/knowledge/curator.ts";
import { loadOkfBundle } from "../../src/knowledge/okf.ts";
import {
  KnowledgeMutationError,
  KnowledgeProposalService,
  OkfKnowledgeMutator,
  restoreKnowledgeProposalState,
  type DurableKnowledgeUpdate,
} from "../../src/knowledge/proposals.ts";
import { appendWorkflowEvent, readWorkflowJournal } from "../../src/workflows/journal.ts";
import { hashAttemptInput } from "../../src/workflows/attempts.ts";
import { createWorkflowEvent } from "../../src/workflows/events.ts";

function snapshot(policy: "automatic" | "reviewed" | "read-only" = "automatic"): ActivationSnapshotFileV1 {
  return { snapshotHash: "a".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", payload: {
    project: { projectId: "project-1", rootRef: "." }, workflow: { id: "delivery", team: { rootId: "root", nodes: [{ id: "root", agentId: "lead", memberIds: [], depth: 1 }] } },
    authority: { capabilityContractVersion: 1, nodes: [{ nodeId: "root", capabilities: { effective: { knowledge: ["curate"] } }, tools: [], model: "curator", thinking: "low" }] },
    agents: [{ id: "lead", name: "Lead", prompt: "lead" }], skills: [],
    knowledge: [{ id: "project", provider: "okf", path: ".pi/hive/knowledge/project", updates: policy, metadataFingerprint: "b".repeat(64), attachedNodeIds: ["root"] }],
    models: [], sources: [], versions: {} as never,
  } } as unknown as ActivationSnapshotFileV1;
}
function fixture(policy: "automatic" | "reviewed" | "read-only" = "automatic", authoritative = true) {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-knowledge-proposal-"));
  const root = join(projectRoot, ".pi/hive/knowledge/project");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "existing.md"), "---\ntype: Knowledge\ntitle: Existing\n---\n\nExisting architecture.\n");
  const declaration = { id: "project", providerId: "okf", path: ".pi/hive/knowledge/project", updatePolicy: policy } as const;
  const loaded = loadOkfBundle({ projectRoot, declaration });
  assert.equal(loaded.ok, true);
  const base = { projectRoot, root, declaration, expectedContentHash: `sha256:${loaded.bundle!.contentHash}`, policy };
  const update = authoritative
    ? authorizeUpdate(base, "update-1", "job-1", "candidate-1", "The build graph must remain deterministic.")
    : {
      formatVersion: 1 as const, updateId: "update-1", jobId: "job-1", projectId: "project-1", sessionId: "session-1", runId: "run-1",
      bundleId: "project", providerId: "okf", expectedContentHash: base.expectedContentHash, curatorOutputHash: `sha256:${"c".repeat(64)}`,
      conclusions: [{ text: "The build graph must remain deterministic.", citations: [{ candidateId: "candidate-1", eventId: "evidence-1", eventHash: "d".repeat(64), payloadHash: "e".repeat(64), sourceHashes: [`sha256:${"f".repeat(64)}`] }] }],
      createdAt: "2026-01-01T00:00:01.000Z",
    };
  return { ...base, update };
}

type ProposalFixtureBase = Readonly<{ projectRoot: string; root: string; declaration: { readonly id: "project"; readonly providerId: "okf"; readonly path: ".pi/hive/knowledge/project"; readonly updatePolicy: "automatic" | "reviewed" | "read-only" }; expectedContentHash: string; policy: "automatic" | "reviewed" | "read-only" }>;
function authorizeUpdateShape(base: ProposalFixtureBase, updateId: string, jobId: string, candidatePrefix: string, conclusions: readonly string[], citationCount: number): DurableKnowledgeUpdate {
  const runId = `run-${jobId}`;
  const candidates = Array.from({ length: citationCount }, (_, index) => {
    const candidateId = citationCount === 1 ? candidatePrefix : `${candidatePrefix}-${index + 1}`;
    const sourceHash = `sha256:${createHash("sha256").update(`${jobId}-source-${index}`).digest("hex")}`;
    const evidence = appendWorkflowEvent(base.projectRoot, createWorkflowEvent({ eventId: `${jobId}-evidence-${index + 1}`, projectId: "project-1", sessionId: "session-1", runId, type: "artifact.recorded", producer: "harness", payload: { formatVersion: 1, nodeId: "root", sourceHashes: [sourceHash] }, timestamp: "2026-01-01T00:00:00.000Z" }));
    const candidateConclusion = `Candidate ${index + 1} provides exact durable provenance.`;
    const candidate = { formatVersion: 1 as const, candidateId, projectId: "project-1", sessionId: "session-1", runId, nodeId: "root", agentId: "lead", scope: "shared" as const, conclusion: candidateConclusion, requestHash: hashAttemptInput({ scope: "shared", conclusion: candidateConclusion, evidenceEventIds: [evidence.eventId] }), citations: [{ eventId: evidence.eventId, eventHash: evidence.eventHash, payloadHash: evidence.payloadHash, sequence: evidence.sequence, type: evidence.type }], sourceHashes: [sourceHash], createdAt: "2026-01-01T00:00:00.000Z" };
    appendWorkflowEvent(base.projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId, type: "knowledge.transition", producer: "runtime", correlationId: `${jobId}-candidate-attempt-${index + 1}`, attemptId: `${jobId}-candidate-attempt-${index + 1}`, payload: { formatVersion: 1, operation: "candidate-recorded", candidate } as never, timestamp: candidate.createdAt }));
    return { candidate, evidence, sourceHash };
  });
  const terminal = appendWorkflowEvent(base.projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId, type: "terminal.recorded", producer: "harness", payload: { formatVersion: 1, status: "completed" }, timestamp: "2026-01-01T00:00:00.000Z" }));
  const target = { bundleId: "project", providerId: "okf", path: ".pi/hive/knowledge/project", policy: "reviewed" as const, expectedContentHash: base.expectedContentHash };
  const job = { formatVersion: 1 as const, jobId, projectId: "project-1", sessionId: "session-1", runId, terminalEventHash: terminal.eventHash, scope: "shared" as const, candidateIds: candidates.map(({ candidate }) => candidate.candidateId), targets: [target], model: { nodeId: "root", modelId: "curator", thinking: "low", reason: "agent-lowest-participating-node;shared-workflow-root" as const }, state: "queued" as const, attemptCount: 0, staleReevaluations: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  appendWorkflowEvent(base.projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId, type: "knowledge.transition", producer: "harness", payload: { formatVersion: 1, operation: "jobs-enqueued", terminalEventHash: terminal.eventHash, preservedCancelled: false, jobs: [job] } as never }));
  appendWorkflowEvent(base.projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId, type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${jobId}`, payload: { formatVersion: 1, operation: "job-transition", jobId, from: "queued", to: "active", attemptCount: 1, staleReevaluations: 0, reason: "test", ownerNonce: "owner-1" } }));
  const citationIds = candidates.map(({ candidate }) => candidate.candidateId);
  const output = parseCuratorOutput(JSON.stringify({ formatVersion: 1, conclusions: conclusions.map((conclusion) => ({ text: conclusion, citationIds })) }), candidates.map(({ candidate }) => candidate));
  const citations = candidates.map(({ candidate, evidence, sourceHash }) => ({ candidateId: candidate.candidateId, eventId: evidence.eventId, eventHash: evidence.eventHash, payloadHash: evidence.payloadHash, sourceHashes: [sourceHash] }))
    .sort((left, right) => left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0);
  const update: DurableKnowledgeUpdate = { formatVersion: 1, updateId, jobId, projectId: "project-1", sessionId: "session-1", runId, bundleId: "project", providerId: "okf", expectedContentHash: base.expectedContentHash, curatorOutputHash: output.outputHash, conclusions: output.conclusions.map((conclusion) => ({ text: conclusion.text, citations })), createdAt: "2026-01-01T00:00:01.000Z" };
  const plan = createCuratorPlan({ jobId, evaluation: 0, targets: [target], output, actions: [{ kind: "proposal", bundleId: "project", reason: "reviewed-policy", update }], createdAt: "2026-01-01T00:00:01.000Z" });
  appendWorkflowEvent(base.projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId, type: "knowledge.transition", producer: "harness", correlationId: `curator-plan-${jobId}`, payload: { formatVersion: 1, operation: "curator-plan-recorded", jobId, ownerNonce: "owner-1", plan } as never, timestamp: plan.createdAt }));
  return update;
}
function authorizeUpdate(base: ProposalFixtureBase, updateId: string, jobId: string, candidateId: string, conclusion: string): DurableKnowledgeUpdate {
  return authorizeUpdateShape(base, updateId, jobId, candidateId, [conclusion], 1);
}

const mutationQueue = (calls: string[]) => async <T>(canonicalPath: string, operationId: string, callback: () => T | Promise<T>): Promise<T> => {
  calls.push(`${canonicalPath}:${operationId}`);
  return callback();
};

test("automatic OKF mutation requires Pi queue, optimistic hash, short-lock validation, citations, and deterministic dedupe", async () => {
  const f = fixture();
  const calls: string[] = [];
  const mutator = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue(calls) });
  await assert.rejects(() => mutator.apply({ ...f.update, authority: { filesystem: true } } as never), /schema|field|unknown/i);
  const first = await mutator.apply(f.update);
  assert.equal(first.changed, true);
  assert.match(first.contentHash, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /curated\.md:update-1$/u);
  const content = readFileSync(join(f.root, "curated.md"), "utf8");
  assert.match(content, /build graph must remain deterministic/i);
  assert.match(content, /pi-hive-citations:/i);
  assert.equal(loadOkfBundle({ projectRoot: f.projectRoot, declaration: f.declaration }).ok, true, "committed bytes must pass the provider's OKF validation");

  const replay = await mutator.apply(f.update);
  assert.equal(replay.changed, false);
  assert.equal(readFileSync(join(f.root, "curated.md"), "utf8"), content, "dedupe replay must not rewrite bytes");
});

test("consistent automatic mutation fails closed at queue, precondition, and pre-effect CAS boundaries", async () => {
  const f = fixture();
  const precondition = {
    bundleId: "project", providerId: "okf", path: ".pi/hive/knowledge/project", policy: "automatic", expectedContentHash: f.expectedContentHash,
  } as const;

  const withoutQueue = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot() });
  await assert.rejects(() => withoutQueue.apply(f.update), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "MUTATION_QUEUE_REQUIRED");
  await assert.rejects(() => withoutQueue.applyConsistent([f.update], [precondition]), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "MUTATION_QUEUE_REQUIRED");

  const mutator = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) });
  await assert.rejects(() => mutator.applyConsistent([], [precondition]), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "MUTATION_QUEUE_REQUIRED");
  await assert.rejects(() => mutator.applyConsistent([f.update], []), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "MUTATION_QUEUE_REQUIRED");
  await assert.rejects(() => mutator.applyConsistent([f.update, f.update], [precondition]), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "VALIDATION_FAILED");
  await assert.rejects(() => mutator.applyConsistent([f.update], [precondition, precondition]), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "VALIDATION_FAILED");
  await assert.rejects(() => mutator.applyConsistent([f.update], [{ ...precondition, providerId: "other" }]), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "BUNDLE_UNAVAILABLE");
  await assert.rejects(() => mutator.applyConsistent([f.update], [{ ...precondition, path: ".pi/hive/knowledge/other" }]), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "BUNDLE_UNAVAILABLE");
  await assert.rejects(() => mutator.applyConsistent([f.update], [{ ...precondition, policy: "reviewed" }]), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "BUNDLE_UNAVAILABLE");
  await assert.rejects(() => mutator.applyConsistent([f.update], [{ ...precondition, expectedContentHash: `sha256:${"9".repeat(64)}` }]), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "BUNDLE_UNAVAILABLE");

  const queueFailure = new Error("mutation queue unavailable");
  const rejectedByQueue = new OkfKnowledgeMutator({
    projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: async () => { throw queueFailure; },
  });
  await assert.rejects(() => rejectedByQueue.applyConsistent([f.update], [precondition]), queueFailure);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").some((event) => String((event.payload as any).operation).startsWith("mutation-")), false);
  assert.equal(existsSync(join(f.root, "curated.md")), false);

  const staleAtAdmission = new OkfKnowledgeMutator({
    projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: async (_path, _operationId, callback) => {
      writeFileSync(join(f.root, "existing.md"), "---\ntype: Knowledge\ntitle: Existing\n---\n\nChanged before the queued callback acquired its mutation boundary.\n");
      return callback();
    },
  });
  await assert.rejects(() => staleAtAdmission.applyConsistent([f.update], [precondition]), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "STALE_HASH");
  assert.equal(existsSync(join(f.root, "curated.md")), false);

  const valid = fixture();
  const result = await new OkfKnowledgeMutator({ projectRoot: valid.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) }).applyConsistent([valid.update], [{
    bundleId: "project", providerId: "okf", path: ".pi/hive/knowledge/project", policy: "automatic", expectedContentHash: valid.expectedContentHash,
  }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].changed, true);
  assert.match(readFileSync(join(valid.root, "curated.md"), "utf8"), /deterministic/u);
});

test("concurrent optimistic writers allow one commit and return a stale-hash conflict for the loser", async () => {
  const f = fixture();
  const mutatorA = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) });
  const mutatorB = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) });
  const other = authorizeUpdate(f, "update-2", "job-2", "candidate-2", "The build graph uses content-addressed nodes.");
  const results = await Promise.allSettled([mutatorA.apply(f.update), mutatorB.apply(other)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.ok(rejected?.reason instanceof KnowledgeMutationError);
  assert.equal(rejected.reason.code, "STALE_HASH");
  assert.equal(loadOkfBundle({ projectRoot: f.projectRoot, declaration: f.declaration }).ok, true);
});

test("read-only policy is audit-only and never enters the mutation queue", async () => {
  const f = fixture("read-only");
  const calls: string[] = [];
  const mutator = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot("read-only"), mutationQueue: mutationQueue(calls) });
  await assert.rejects(() => mutator.apply(f.update), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "READ_ONLY");
  assert.deepEqual(calls, []);
});

test("proposal creation rejects updates without exact authoritative job, target, plan, candidate, and citation provenance", () => {
  const f = fixture("reviewed", false);
  const service = new KnowledgeProposalService({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", createProposalId: () => "ungrounded-proposal", authenticateControl: () => undefined });
  assert.throws(() => service.create(f.update), /authoritative|provenance|job|plan|candidate|citation/i);
});

test("proposal reducer rejects forged producers and unknown authority-bearing fields", () => {
  const f = fixture("reviewed");
  const service = new KnowledgeProposalService({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", createProposalId: () => "proposal-1", authenticateControl: () => undefined });
  const proposal = service.create(f.update);
  const created = readWorkflowJournal(f.projectRoot, "session-1").at(-1)!;
  assert.equal(created.producer, "harness");
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "runtime",
    payload: { formatVersion: 1, operation: "proposal-created", proposal: { ...proposal, proposalId: "forged", authority: { approve: true } } } as never,
  }));
  assert.throws(() => restoreKnowledgeProposalState(readWorkflowJournal(f.projectRoot, "session-1")), /proposal|producer|authority|field/i);
});

test("reviewed proposals use authenticated exact CAS; approval, denial, replay, and races cannot be model-created", async () => {
  const f = fixture("reviewed");
  let proposal = 0;
  const service = new KnowledgeProposalService({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1",
    createProposalId: () => `proposal-${++proposal}`,
    authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
  });
  const pending = service.create(f.update);
  assert.equal(pending.state, "pending");
  assert.throws(() => service.decide({ projectId: "project-1", sessionId: "session-1", proposalId: pending.proposalId, expectedState: "pending", decision: "approve", operationId: "model-attempt", channel: "model" as never, claimedIdentity: "model", credential: "secret" }), /channel|dashboard|human/i);
  assert.throws(() => service.decide({ projectId: "project-1", sessionId: "session-1", proposalId: pending.proposalId, expectedState: "pending", decision: "approve", operationId: "unauth", channel: "dashboard", claimedIdentity: "human", credential: "wrong" }), /auth/i);

  const approved = service.decide({ projectId: "project-1", sessionId: "session-1", proposalId: pending.proposalId, expectedState: "pending", decision: "approve", operationId: "decision-1", channel: "dashboard", claimedIdentity: "human", credential: "secret" });
  assert.equal(approved.state, "approved");
  assert.equal(approved.decision?.identity, "human");
  const replay = service.decide({ projectId: "project-1", sessionId: "session-1", proposalId: pending.proposalId, expectedState: "pending", decision: "approve", operationId: "decision-1", channel: "dashboard", claimedIdentity: "human", credential: "secret" });
  assert.deepEqual(replay, approved);
  assert.throws(() => service.decide({ projectId: "project-1", sessionId: "session-1", proposalId: pending.proposalId, expectedState: "pending", decision: "deny", operationId: "decision-2", channel: "dashboard", claimedIdentity: "other", credential: "secret" }), /CAS|decided|pending/i);
  const applied = await service.applyApproved(pending.proposalId, new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot("reviewed"), mutationQueue: mutationQueue([]) }));
  assert.equal(applied.state, "applied");
  assert.equal(applied.applied?.updateId, "update-1");
  assert.deepEqual(await service.applyApproved(pending.proposalId, new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot("reviewed"), mutationQueue: mutationQueue([]) })), applied);

  const deniedPending = service.create(authorizeUpdate(f, "update-2", "job-2", "candidate-2", "A second reviewed conclusion can be denied independently."));
  assert.equal(service.decide({ projectId: "project-1", sessionId: "session-1", proposalId: deniedPending.proposalId, expectedState: "pending", decision: "deny", operationId: "decision-3", channel: "dashboard", claimedIdentity: "human", credential: "secret" }).state, "denied");
  const restored = restoreKnowledgeProposalState(readWorkflowJournal(f.projectRoot, "session-1"));
  assert.deepEqual(Object.values(restored.proposals).map((entry) => entry.state), ["applied", "denied"]);
});

test("proposal decision replay recomputes the authenticated request hash and rejects unknown transitions", () => {
  const f = fixture("reviewed");
  const service = new KnowledgeProposalService({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", createProposalId: () => "proposal-hash",
    authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined });
  const pending = service.create(f.update);
  service.decide({ projectId: "project-1", sessionId: "session-1", proposalId: pending.proposalId, expectedState: "pending", decision: "approve", operationId: "hash-decision", channel: "dashboard", claimedIdentity: "human", credential: "secret" });
  const tampered = readWorkflowJournal(f.projectRoot, "session-1").map((event) => (event.payload as any).operation === "proposal-decided"
    ? ({ ...event, payload: { ...(event.payload as any), decision: { ...(event.payload as any).decision, requestHash: `sha256:${"9".repeat(64)}` } } })
    : event);
  assert.throws(() => restoreKnowledgeProposalState(tampered as any), /request hash|authenticated|identity/i);

  const unknown = fixture("reviewed");
  appendWorkflowEvent(unknown.projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "dashboard",
    payload: { formatVersion: 1, operation: "proposal-escalated", proposalId: "invented" } as never }));
  assert.throws(() => restoreKnowledgeProposalState(readWorkflowJournal(unknown.projectRoot, "session-1")), /unknown knowledge proposal transition/i);
});

test("concurrent same-process exact applyApproved calls return the one durable application identity", async () => {
  const f = fixture("reviewed");
  const service = new KnowledgeProposalService({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", createProposalId: () => "proposal-apply-race",
    authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
  });
  service.create(f.update);
  service.decide({ projectId: "project-1", sessionId: "session-1", proposalId: "proposal-apply-race", expectedState: "pending", decision: "approve", operationId: "approve-apply-race", channel: "dashboard", claimedIdentity: "human", credential: "secret" });
  const apply = () => service.applyApproved("proposal-apply-race", new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot("reviewed"), mutationQueue: mutationQueue([]) }));
  const [first, second] = await Promise.all([apply(), apply()]);
  assert.equal(first.state, "applied");
  assert.deepEqual(second, first);
  assert.equal(first.proposalId, "proposal-apply-race");
  assert.equal(first.update.updateId, "update-1");
  assert.equal(first.decision?.operationId, "approve-apply-race");
  assert.equal(first.applied?.changed, true, "both callers return the authoritative committed result rather than a replay-local changed flag");
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").filter((event) => (event.payload as any).operation === "proposal-applied").length, 1);
});

test("proposal application publishes the authoritative mutation-committed result when a replay caller wins the proposal CAS", async () => {
  const f = fixture("reviewed");
  const service = new KnowledgeProposalService({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", createProposalId: () => "proposal-authoritative-result",
    authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
  });
  service.create(f.update);
  service.decide({ projectId: "project-1", sessionId: "session-1", proposalId: "proposal-authoritative-result", expectedState: "pending", decision: "approve", operationId: "approve-authoritative-result", channel: "dashboard", claimedIdentity: "human", credential: "secret" });
  let committed!: () => void;
  const didCommit = new Promise<void>((resolve) => { committed = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const physicalWriter = new OkfKnowledgeMutator({
    projectRoot: f.projectRoot, snapshot: snapshot("reviewed"),
    mutationQueue: async (_path, _operationId, callback) => { const result = await callback(); committed(); await hold; return result; },
  });
  const replayingWriter = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot("reviewed"), mutationQueue: mutationQueue([]) });
  const firstPromise = service.applyApproved("proposal-authoritative-result", physicalWriter);
  await didCommit;
  const second = await service.applyApproved("proposal-authoritative-result", replayingWriter);
  release();
  const first = await firstPromise;
  assert.equal(first.applied?.changed, true);
  assert.equal(second.applied?.changed, true);
  const durable = restoreKnowledgeProposalState(readWorkflowJournal(f.projectRoot, "session-1")).proposals["proposal-authoritative-result"];
  assert.equal(durable.applied?.changed, true);
  const committedEvent = readWorkflowJournal(f.projectRoot, "session-1").find((event) => (event.payload as any).operation === "mutation-committed")!;
  assert.deepEqual(durable.applied, (committedEvent.payload as any).result);
});

test("concurrent cross-process exact applyApproved calls are idempotent by proposal, update, and decision identity", async () => {
  const f = fixture("reviewed");
  const service = new KnowledgeProposalService({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", createProposalId: () => "proposal-cross-apply",
    authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
  });
  service.create(f.update);
  service.decide({ projectId: "project-1", sessionId: "session-1", proposalId: "proposal-cross-apply", expectedState: "pending", decision: "approve", operationId: "approve-cross-apply", channel: "dashboard", claimedIdentity: "human", credential: "secret" });
  const run = () => new Promise<{ code: number | null; output: string; error: string }>((resolve) => {
    const script = `
      import { KnowledgeProposalService, OkfKnowledgeMutator } from './src/knowledge/proposals.ts';
      const snapshot = ${JSON.stringify(snapshot("reviewed"))};
      const service = new KnowledgeProposalService({ projectRoot: ${JSON.stringify(f.projectRoot)}, projectId: 'project-1', sessionId: 'session-1', authenticateControl: () => undefined });
      const mutator = new OkfKnowledgeMutator({ projectRoot: ${JSON.stringify(f.projectRoot)}, snapshot, mutationQueue: async (_path, _operationId, callback) => callback() });
      try {
        const proposal = await service.applyApproved('proposal-cross-apply', mutator);
        console.log(JSON.stringify({ ok: true, proposalId: proposal.proposalId, updateId: proposal.update.updateId, decisionOperationId: proposal.decision.operationId, changed: proposal.applied.changed }));
      } catch (error) { console.log(JSON.stringify({ ok: false, error: String(error.message || error) })); }
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--import", "./tests/helpers/register-ts-loader.mjs", "--input-type=module", "-e", script], { cwd: process.cwd() });
    let output = "", error = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { error += String(chunk); });
    child.on("close", (code) => resolve({ code, output, error }));
  });
  const raced = await Promise.all([run(), run()]);
  assert.equal(raced.every((result) => result.code === 0), true, raced.map((result) => result.error).join("\n"));
  const outputs = raced.map((result) => JSON.parse(result.output.trim()));
  assert.deepEqual(outputs, [
    { ok: true, proposalId: "proposal-cross-apply", updateId: "update-1", decisionOperationId: "approve-cross-apply", changed: true },
    { ok: true, proposalId: "proposal-cross-apply", updateId: "update-1", decisionOperationId: "approve-cross-apply", changed: true },
  ]);
  const durable = restoreKnowledgeProposalState(readWorkflowJournal(f.projectRoot, "session-1")).proposals["proposal-cross-apply"];
  assert.equal(durable.state, "applied");
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").filter((event) => (event.payload as any).operation === "proposal-applied").length, 1);
});

test("proposal creation is idempotent by stable update identity despite retry timestamps", () => {
  const f = fixture("reviewed");
  let proposal = 0;
  const service = new KnowledgeProposalService({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1",
    createProposalId: () => `proposal-${++proposal}`, authenticateControl: () => undefined,
  });
  const first = service.create(f.update);
  const replay = service.create({ ...f.update, createdAt: "2026-01-01T00:00:09.000Z" });
  assert.equal(replay.proposalId, first.proposalId);
  assert.equal(Object.keys(restoreKnowledgeProposalState(readWorkflowJournal(f.projectRoot, "session-1")).proposals).length, 1);
  assert.throws(() => service.create({ ...f.update, conclusions: [{ ...f.update.conclusions[0], text: "A conflicting value reuses the stable update identity." }] }), /identity|reuse|conflict/i);

  const foreign = new KnowledgeProposalService({ projectRoot: f.projectRoot, projectId: "other-project", sessionId: "session-1", authenticateControl: () => undefined });
  assert.throws(() => foreign.create(f.update), /project|service identity/i);
});

test("decision DTOs are exact and operation replay is session-wide", () => {
  const f = fixture("reviewed");
  let proposal = 0;
  const service = new KnowledgeProposalService({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", createProposalId: () => `proposal-${++proposal}`,
    authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
  });
  const first = service.create(f.update);
  const second = service.create(authorizeUpdate(f, "update-2", "job-2", "candidate-2", "A second stable proposal exists for replay checks."));
  const request = { projectId: "project-1", sessionId: "session-1", proposalId: first.proposalId, expectedState: "pending" as const, decision: "approve" as const, operationId: "global-operation", channel: "dashboard" as const, claimedIdentity: "human", credential: "secret" };
  service.decide(request);
  assert.throws(() => service.decide({ ...request, proposalId: second.proposalId }), /operation.*replay|reuse|conflict/i);
  assert.throws(() => service.decide({ ...request, injectedAuthority: true } as never), /unknown|schema|field/i);
  assert.throws(() => service.decide({ ...request, credential: "x".repeat(20_000) }), /bound|bytes|request/i);
});

test("proposal status/detail DTOs are exact, bounded, and cursor paginated", () => {
  const f = fixture("reviewed");
  let proposal = 0;
  const service = new KnowledgeProposalService({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", createProposalId: () => `proposal-${++proposal}`, authenticateControl: () => undefined });
  service.create(f.update);
  service.create(authorizeUpdate(f, "update-2", "job-2", "candidate-2", "A bounded second detail record is available."));
  const first = service.status({ projectId: "project-1", sessionId: "session-1", state: "pending", limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.total, 2);
  assert.ok(first.nextCursor);
  assert.equal(service.status({ projectId: "project-1", sessionId: "session-1", state: "pending", limit: 1, cursor: first.nextCursor }).items.length, 1);
  assert.equal(service.detail({ projectId: "project-1", sessionId: "session-1", proposalId: first.items[0].proposalId }).proposalId, first.items[0].proposalId);
  assert.throws(() => service.status({ projectId: "project-1", sessionId: "session-1", limit: 1, authority: true } as never), /unknown|schema|field/i);
});

test("cross-process approve/deny CAS elects one decision and replays only its exact operation", async () => {
  const f = fixture("reviewed");
  const service = new KnowledgeProposalService({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", createProposalId: () => "proposal-race", authenticateControl: () => undefined });
  service.create(f.update);
  const run = (decision: "approve" | "deny", operationId: string) => new Promise<{ code: number | null; output: string }>((resolve) => {
    const request = { projectId: "project-1", sessionId: "session-1", proposalId: "proposal-race", expectedState: "pending", decision, operationId, channel: "dashboard", claimedIdentity: "human", credential: "secret" };
    const script = `
      import { KnowledgeProposalService } from './src/knowledge/proposals.ts';
      const service = new KnowledgeProposalService({ projectRoot: ${JSON.stringify(f.projectRoot)}, projectId: 'project-1', sessionId: 'session-1', authenticateControl: (request) => request.credential === 'secret' ? request.claimedIdentity : undefined });
      try { const value = service.decide(${JSON.stringify(request)}); console.log(JSON.stringify({ ok: true, state: value.state, operationId: value.decision.operationId })); }
      catch (error) { console.log(JSON.stringify({ ok: false, error: String(error.message || error) })); }
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--import", "./tests/helpers/register-ts-loader.mjs", "--input-type=module", "-e", script], { cwd: process.cwd() });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.on("close", (code) => resolve({ code, output }));
  });
  const raced = await Promise.all([run("approve", "cross-approve"), run("deny", "cross-deny")]);
  assert.equal(raced.every((result) => result.code === 0), true);
  const outputs = raced.map((result) => JSON.parse(result.output.trim()));
  assert.equal(outputs.filter((result) => result.ok).length, 1);
  const durable = restoreKnowledgeProposalState(readWorkflowJournal(f.projectRoot, "session-1")).proposals["proposal-race"];
  assert.ok(durable.decision);
  const replayed = await run(durable.decision!.decision, durable.decision!.operationId);
  assert.deepEqual(JSON.parse(replayed.output.trim()), { ok: true, state: durable.state, operationId: durable.decision!.operationId });
});

test("a concurrent commit after durable intent recovers as stale input instead of overwriting or dead-ending validation", async () => {
  const f = fixture();
  let armed = true;
  const interrupted = new OkfKnowledgeMutator({
    projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]),
    fault: (stage) => { if (armed && stage === "after-intent") { armed = false; throw new Error("fault:after-intent"); } },
  });
  await assert.rejects(() => interrupted.apply(f.update), /fault:after-intent/);
  const concurrent = authorizeUpdate(f, "update-concurrent", "job-concurrent", "candidate-concurrent", "A concurrent durable conclusion commits after the first intent.");
  await new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) }).apply(concurrent);
  await assert.rejects(
    () => new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) }).apply(f.update),
    (error: unknown) => error instanceof KnowledgeMutationError && error.code === "STALE_HASH",
  );
  const live = readFileSync(join(f.root, "curated.md"), "utf8");
  assert.match(live, /concurrent durable conclusion/i);
  assert.doesNotMatch(live, /build graph must remain deterministic/i);
});

test("post-intent recovery rejects an unrelated complete-bundle hash change before publication", async () => {
  const f = fixture();
  let armed = true;
  const interrupted = new OkfKnowledgeMutator({
    projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]),
    fault: (stage) => { if (armed && stage === "after-intent") { armed = false; throw new Error("fault:after-intent"); } },
  });
  await assert.rejects(() => interrupted.apply(f.update), /fault:after-intent/);
  writeFileSync(join(f.root, "existing.md"), "---\ntype: Knowledge\ntitle: Existing\n---\n\nUnrelated knowledge changed after intent.\n");
  await assert.rejects(
    () => new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) }).apply(f.update),
    (error: unknown) => error instanceof KnowledgeMutationError && error.code === "STALE_HASH",
  );
  assert.equal(existsSync(join(f.root, "curated.md")), false);
});

test("complete-bundle CAS rejects concurrent edits made inside one apply after intent or validation", async () => {
  for (const boundary of ["after-intent", "after-validation"] as const) {
    const f = fixture();
    const concurrent = `---\ntype: Knowledge\ntitle: Existing\n---\n\nConcurrent edit at ${boundary}.\n`;
    let changed = false;
    const mutator = new OkfKnowledgeMutator({
      projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]),
      fault: (stage) => {
        if (!changed && stage === boundary) {
          changed = true;
          writeFileSync(join(f.root, "existing.md"), concurrent);
        }
      },
    });
    await assert.rejects(
      () => mutator.apply(f.update),
      (error: unknown) => error instanceof KnowledgeMutationError && error.code === "STALE_HASH",
    );
    assert.equal(changed, true);
    assert.equal(readFileSync(join(f.root, "existing.md"), "utf8"), concurrent);
    assert.equal(existsSync(join(f.root, "curated.md")), false, "stale curator output must never cross the commit boundary");
    assert.equal(readWorkflowJournal(f.projectRoot, "session-1").some((event) => (event.payload as any).operation === "mutation-committed"), false);
  }
});

test("mutation replay derives committed accounting from the exact durable intent", async () => {
  const f = fixture();
  let armed = true;
  const interrupted = new OkfKnowledgeMutator({
    projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]),
    fault: (stage) => { if (armed && stage === "after-validation") { armed = false; throw new Error("fault:after-validation"); } },
  });
  await assert.rejects(() => interrupted.apply(f.update), /fault:after-validation/);
  const events = readWorkflowJournal(f.projectRoot, "session-1");
  const intent = events.find((event) => (event.payload as any).operation === "mutation-intent")!;
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: f.update.runId, type: "knowledge.transition", producer: "harness", correlationId: f.update.updateId,
    payload: { formatVersion: 1, operation: "mutation-committed", updateId: f.update.updateId, renderedHash: (intent.payload as any).renderedHash,
      result: { updateId: f.update.updateId, bundleId: f.update.bundleId, changed: false, contentHash: `sha256:${"9".repeat(64)}`, documentId: "curated", conclusionCount: 999 } } as never,
  }));
  assert.throws(() => interrupted.authoritativeResult(f.update), /intent|commit|result|authoritative/i);
});

test("automatic mutation stages and validates before atomic publication and recovers every durable fault boundary", async () => {
  for (const faultStage of ["after-intent", "after-stage", "after-validation", "after-commit"] as const) {
    const f = fixture();
    let armed = true;
    const faulting = new OkfKnowledgeMutator({
      projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]),
      fault: (stage) => { if (armed && stage === faultStage) { armed = false; throw new Error(`fault:${stage}`); } },
    });
    await assert.rejects(() => faulting.apply(f.update), /fault:/i);
    const livePath = join(f.root, "curated.md");
    if (faultStage !== "after-commit") assert.equal(existsSync(livePath), false, "unvalidated or uncommitted bytes must never become live");
    const recovered = await new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) }).apply(f.update);
    assert.equal(recovered.contentHash.startsWith("sha256:"), true);
    assert.match(readFileSync(livePath, "utf8"), /build graph must remain deterministic/i);
    assert.equal(loadOkfBundle({ projectRoot: f.projectRoot, declaration: f.declaration }).ok, true);
    const operations = readWorkflowJournal(f.projectRoot, "session-1").filter((event) => String((event.payload as any).operation).startsWith("mutation-"));
    assert.equal(operations.some((event) => (event.payload as any).operation === "mutation-committed"), true);
  }
});

test("post-publication recovery commits only the exact durable bundle identity and rolls stale curated bytes back", async () => {
  {
    const f = fixture();
    let armed = true;
    const interrupted = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]),
      fault: (stage) => { if (armed && stage === "after-publication") { armed = false; throw new Error("fault:after-publication"); } } });
    await assert.rejects(() => interrupted.apply(f.update), /fault:after-publication/);
    assert.equal(readWorkflowJournal(f.projectRoot, "session-1").some((event) => (event.payload as any).operation === "mutation-committed"), false);
    const recovered = await new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) }).apply(f.update);
    assert.equal(recovered.changed, true);
    assert.equal(readWorkflowJournal(f.projectRoot, "session-1").filter((event) => (event.payload as any).operation === "mutation-committed").length, 1);
  }
  {
    const f = fixture();
    let armed = true;
    const interrupted = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]),
      fault: (stage) => { if (armed && stage === "after-publication") { armed = false; throw new Error("fault:after-publication"); } } });
    await assert.rejects(() => interrupted.apply(f.update), /fault:after-publication/);
    writeFileSync(join(f.root, "existing.md"), "---\ntype: Knowledge\ntitle: Existing\n---\n\nUnrelated post-publication drift.\n");
    await assert.rejects(() => new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) }).apply(f.update),
      (error: unknown) => error instanceof KnowledgeMutationError && error.code === "STALE_HASH");
    assert.equal(existsSync(join(f.root, "curated.md")), false, "the exact stale publication must be removed from the live bundle");
    assert.equal(readWorkflowJournal(f.projectRoot, "session-1").some((event) => (event.payload as any).operation === "mutation-committed"), false);
  }
  {
    const f = fixture();
    let armed = true;
    const interrupted = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]),
      fault: (stage) => { if (armed && stage === "after-publication") { armed = false; throw new Error("fault:after-publication"); } } });
    await assert.rejects(() => interrupted.apply(f.update), /fault:after-publication/);
    writeFileSync(join(f.root, "existing.md"), "invalid post-publication provider bytes\n");
    await assert.rejects(() => new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) }).apply(f.update),
      (error: unknown) => error instanceof KnowledgeMutationError && error.code === "STALE_HASH");
    assert.equal(existsSync(join(f.root, "curated.md")), false, "provider-unavailable drift must not strand the exact unaudited publication");
  }
});

test("validated publication remains anchored to the original bundle directory across a parent swap", async () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "hive-knowledge-outside-"));
  const displaced = `${f.root}.displaced`;
  let swapped = false;
  const mutator = new OkfKnowledgeMutator({
    projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]),
    fault: (stage) => {
      if (stage !== "after-validation" || swapped) return;
      swapped = true;
      renameSync(f.root, displaced);
      symlinkSync(outside, f.root, "dir");
    },
  });
  await assert.rejects(() => mutator.apply(f.update), /bundle|validation|identity|reload/i);
  assert.equal(swapped, true);
  assert.equal(existsSync(join(outside, "curated.md")), false, "validated bytes must never follow a swapped bundle parent outside the project");
  assert.equal(existsSync(join(displaced, "curated.md")), true, "descriptor-anchored publication may only target the validated original directory inode");
  rmSync(f.root);
  renameSync(displaced, f.root);

  const replaced = fixture();
  const original = `${replaced.root}.original`;
  const originalExisting = readFileSync(join(replaced.root, "existing.md"), "utf8");
  const replacement = new OkfKnowledgeMutator({
    projectRoot: replaced.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]),
    fault: (stage) => {
      if (stage !== "after-intent" || existsSync(original)) return;
      renameSync(replaced.root, original);
      mkdirSync(replaced.root);
      writeFileSync(join(replaced.root, "existing.md"), originalExisting);
    },
  });
  await assert.rejects(() => replacement.apply(replaced.update), /bundle|identity|unavailable/i);
  assert.equal(existsSync(join(replaced.root, "curated.md")), false, "an exact-byte replacement directory cannot capture descriptor-anchored publication");
  assert.equal(existsSync(join(original, "curated.md")), false);
});

test("managed citations reject injected fields instead of republishing them", async () => {
  const f = fixture();
  const mutator = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) });
  await mutator.apply(f.update);
  const path = join(f.root, "curated.md");
  const content = readFileSync(path, "utf8");
  const prefix = "  <!-- pi-hive-citations:";
  const encoded = content.split("\n").find((line) => line.startsWith(prefix))!.slice(prefix.length, -4);
  const provenance = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  provenance.citations[0].authority = "admin";
  const injected = Buffer.from(JSON.stringify(provenance), "utf8").toString("base64url");
  const injectedContent = content.replace(encoded, injected);
  writeFileSync(path, injectedContent);
  const loaded = loadOkfBundle({ projectRoot: f.projectRoot, declaration: f.declaration });
  assert.equal(loaded.ok, true);
  const next: DurableKnowledgeUpdate = { ...f.update, updateId: "update-after-injected-citation", expectedContentHash: `sha256:${loaded.bundle!.contentHash}`, conclusions: [{ ...f.update.conclusions[0], text: "A second update must not preserve injected citation authority." }] };
  await assert.rejects(() => mutator.apply(next), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "TARGET_UNMANAGED");
  assert.equal(readFileSync(path, "utf8"), injectedContent, "rejection must not rewrite or republish injected managed citation bytes");
});

test("managed entry text is bound to exact durable curator plan and update provenance", async () => {
  const f = fixture();
  const mutator = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) });
  await mutator.apply(f.update);
  const path = join(f.root, "curated.md");
  const original = readFileSync(path, "utf8");
  const tampered = original.replace("* The build graph must remain deterministic.", "* An injected unsupported conclusion keeps the old citation.");
  assert.notEqual(tampered, original);
  writeFileSync(path, tampered);
  const loaded = loadOkfBundle({ projectRoot: f.projectRoot, declaration: f.declaration });
  assert.equal(loaded.ok, true);
  const next = authorizeUpdate({ ...f, expectedContentHash: `sha256:${loaded.bundle!.contentHash}` }, "update-after-text-tamper", "job-after-text-tamper", "candidate-after-text-tamper", "A new authoritative conclusion must not canonize edited managed text.");
  await assert.rejects(() => mutator.apply(next), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "TARGET_UNMANAGED");
  assert.equal(readFileSync(path, "utf8"), tampered);
});

test("post-merge managed citation and conclusion counts remain parser-valid and fail closed", async () => {
  {
    const f = fixture();
    const mutator = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) });
    const exact = authorizeUpdateShape(f, "update-citation-32", "job-citation-32", "candidate-citation", [f.update.conclusions[0].text], 32);
    await mutator.apply(exact);
    const before = readFileSync(join(f.root, "curated.md"), "utf8");
    const loaded = loadOkfBundle({ projectRoot: f.projectRoot, declaration: f.declaration });
    const overflow = authorizeUpdate({ ...f, expectedContentHash: `sha256:${loaded.bundle!.contentHash}` }, "update-citation-33", "job-citation-33", "candidate-citation-33", f.update.conclusions[0].text);
    await assert.rejects(() => mutator.apply(overflow), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "VALIDATION_FAILED");
    assert.equal(readFileSync(join(f.root, "curated.md"), "utf8"), before);
  }
  {
    const f = fixture();
    const mutator = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) });
    const conclusions = Array.from({ length: 64 }, (_, index) => `Stable managed conclusion number ${index + 1} is authoritative.`);
    await mutator.apply(authorizeUpdateShape(f, "update-count-64", "job-count-64", "candidate-count", conclusions, 1));
    const before = readFileSync(join(f.root, "curated.md"), "utf8");
    const loaded = loadOkfBundle({ projectRoot: f.projectRoot, declaration: f.declaration });
    const overflow = authorizeUpdate({ ...f, expectedContentHash: `sha256:${loaded.bundle!.contentHash}` }, "update-count-65", "job-count-65", "candidate-count-65", "Stable managed conclusion number 65 is authoritative.");
    await assert.rejects(() => mutator.apply(overflow), (error: unknown) => error instanceof KnowledgeMutationError && error.code === "VALIDATION_FAILED");
    assert.equal(readFileSync(join(f.root, "curated.md"), "utf8"), before);
  }
});

test("proposal-applied reducer independently requires the exact prior mutation commit result", () => {
  const f = fixture("reviewed");
  const service = new KnowledgeProposalService({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", createProposalId: () => "proposal-forged-application",
    authenticateControl: (request) => request.credential === "secret" ? request.claimedIdentity : undefined,
  });
  const pending = service.create(f.update);
  const approved = service.decide({ projectId: "project-1", sessionId: "session-1", proposalId: pending.proposalId, expectedState: "pending", decision: "approve", operationId: "approve-forged-application", channel: "dashboard", claimedIdentity: "human", credential: "secret" });
  const forged = createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: f.update.updateId,
    payload: { formatVersion: 1, operation: "proposal-applied", proposalId: pending.proposalId, updateHash: approved.updateHash, decisionOperationId: approved.decision!.operationId,
      result: { updateId: f.update.updateId, bundleId: f.update.bundleId, changed: true, contentHash: `sha256:${"9".repeat(64)}`, documentId: "curated", conclusionCount: 1 } } as never,
  });
  assert.throws(() => restoreKnowledgeProposalState([...readWorkflowJournal(f.projectRoot, "session-1"), forged as any]), /mutation|commit|authoritative|application/i);
});

test("automatic mutation rejects a pre-existing staging-directory symlink without outside writes or mutation journaling", async () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "hive-knowledge-staging-outside-"));
  const stagingRoot = join(f.projectRoot, ".pi/hive/sessions/session-1/knowledge-mutations/update-1");
  mkdirSync(join(stagingRoot, ".."), { recursive: true });
  symlinkSync(outside, stagingRoot, "dir");

  await assert.rejects(
    () => new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) }).apply(f.update),
    (error: unknown) => error instanceof KnowledgeMutationError && error.code === "VALIDATION_FAILED",
  );
  for (const name of ["curated.md", "rollback.md", "publication.md", "validation"]) {
    assert.equal(existsSync(join(outside, name)), false, `pre-existing staging symlink must not create outside ${name}`);
  }
  assert.equal(
    readWorkflowJournal(f.projectRoot, "session-1").some((event) => String((event.payload as any).operation).startsWith("mutation-")),
    false,
    "a rejected outside staging inode must not receive a durable mutation transition",
  );
});

test("automatic mutation rejects raced staging and validation directory replacements without outside writes or identity journaling", async () => {
  for (const replaced of ["staging", "validation"] as const) {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), `hive-knowledge-${replaced}-outside-`));
    const stagingRoot = join(f.projectRoot, ".pi/hive/sessions/session-1/knowledge-mutations/update-1");
    const validationRoot = join(stagingRoot, "validation");
    mkdirSync(validationRoot, { recursive: true });
    let raced = false;
    const mutator = new OkfKnowledgeMutator({
      projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]),
      fault: (stage) => {
        if (raced || (replaced === "staging" ? stage !== "after-intent" : stage !== "after-stage")) return;
        raced = true;
        const target = replaced === "staging" ? stagingRoot : validationRoot;
        renameSync(target, `${target}.displaced`);
        symlinkSync(outside, target, "dir");
      },
    });

    await assert.rejects(
      () => mutator.apply(f.update),
      (error: unknown) => error instanceof KnowledgeMutationError && error.code === "VALIDATION_FAILED",
    );
    assert.equal(raced, true, `${replaced} replacement fault seam must run`);
    for (const name of ["curated.md", "rollback.md", "publication.md", "existing.md"]) {
      assert.equal(existsSync(join(outside, name)), false, `${replaced} replacement must not write outside ${name}`);
    }
    assert.equal(existsSync(join(outside, "validation/curated.md")), false, `${replaced} replacement must not reconstruct validation outside the project`);
    const mutationOperations = readWorkflowJournal(f.projectRoot, "session-1")
      .map((event) => String((event.payload as any).operation)).filter((operation) => operation.startsWith("mutation-"));
    assert.deepEqual(mutationOperations, replaced === "staging" ? ["mutation-intent"] : ["mutation-intent", "mutation-staged"],
      "a raced directory must not journal a staging or validation identity reached through its replacement");
  }
});

test("recovery never publishes staging bytes corrupted after staging/validation or replaced by a symlink", async () => {
  const cases = [
    { boundary: "after-stage" as const, replacement: "corrupt" as const },
    { boundary: "after-validation" as const, replacement: "corrupt" as const },
    { boundary: "after-validation" as const, replacement: "symlink" as const },
  ];
  for (const scenario of cases) {
    const f = fixture();
    let armed = true;
    const faulting = new OkfKnowledgeMutator({
      projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]),
      fault: (stage) => { if (armed && stage === scenario.boundary) { armed = false; throw new Error(`fault:${stage}`); } },
    });
    await assert.rejects(() => faulting.apply(f.update), new RegExp(`fault:${scenario.boundary}`));
    const staging = join(f.projectRoot, ".pi/hive/sessions/session-1/knowledge-mutations/update-1/curated.md");
    if (scenario.replacement === "corrupt") {
      writeFileSync(staging, `CORRUPTED STAGING BYTES AFTER ${scenario.boundary}\n`);
    } else {
      const replacement = join(f.projectRoot, "attacker-controlled-staging.md");
      writeFileSync(replacement, "REPLACED STAGING BYTES\n");
      unlinkSync(staging);
      symlinkSync(replacement, staging);
    }
    await assert.rejects(
      () => new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: snapshot(), mutationQueue: mutationQueue([]) }).apply(f.update),
      (error: unknown) => error instanceof KnowledgeMutationError && error.code === "VALIDATION_FAILED",
    );
    assert.equal(existsSync(join(f.root, "curated.md")), false, "corrupt or replaced staging must never become live");
    assert.equal(loadOkfBundle({ projectRoot: f.projectRoot, declaration: f.declaration }).ok, true, "the live bundle must remain provider-valid");
  }
});
