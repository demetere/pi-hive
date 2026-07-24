import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { KnowledgeCuratorProcessor } from "../../src/knowledge/curator.ts";
import { KnowledgeEnrichmentService, restoreKnowledgeEnrichmentState } from "../../src/knowledge/enrichment.ts";
import { KnowledgeProposalService, OkfKnowledgeMutator, restoreKnowledgeProposalState } from "../../src/knowledge/proposals.ts";
import { createBuiltInKnowledgeProviderRegistry, KnowledgeProviderRegistry } from "../../src/knowledge/provider.ts";
import { DurableKnowledgeQueue } from "../../src/knowledge/queue.ts";
import { createWorkflowEvent } from "../../src/workflows/events.ts";
import { appendWorkflowEvent, readWorkflowJournal } from "../../src/workflows/journal.ts";

function snapshot(bundleIds: readonly ("alpha" | "beta")[] = ["alpha", "beta"]): ActivationSnapshotFileV1 {
  return { snapshotHash: "a".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", payload: {
    project: { projectId: "project-1", rootRef: "." },
    workflow: { id: "delivery", team: { rootId: "root", nodes: [{ id: "root", agentId: "lead", memberIds: [], depth: 1 }] } },
    authority: { capabilityContractVersion: 1, nodes: [{ nodeId: "root", capabilities: { effective: { knowledge: ["propose", "curate"] } }, tools: ["knowledge_propose"], model: "curator", thinking: "low" }] },
    agents: [{ id: "lead", name: "Lead", prompt: "lead" }], skills: [],
    knowledge: [
      { id: "alpha", provider: "okf", path: ".pi/hive/knowledge/alpha", updates: "automatic", metadataFingerprint: "b".repeat(64), attachedNodeIds: ["root"] },
      { id: "beta", provider: "okf", path: ".pi/hive/knowledge/beta", updates: "automatic", metadataFingerprint: "c".repeat(64), attachedNodeIds: ["root"] },
    ].filter((entry) => bundleIds.includes(entry.id as "alpha" | "beta")),
    models: [{ nodeId: "root", modelId: "curator", thinking: "low", staticTokens: 1, dynamicReserve: 1, contextWindow: 100_000 }], sources: [], versions: {} as never,
  } } as unknown as ActivationSnapshotFileV1;
}

function fixture(evidenceCounts: readonly number[] = [1], sourceHashesPerCandidate = 1, bundleIds: readonly ("alpha" | "beta")[] = ["alpha", "beta"]) {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-knowledge-processing-"));
  for (const bundle of ["alpha", "beta"]) {
    const root = join(projectRoot, ".pi/hive/knowledge", bundle);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "existing.md"), `---\ntype: Knowledge\ntitle: ${bundle}\n---\n\nInitial ${bundle} knowledge.\n`);
  }
  const active = snapshot(bundleIds);
  let candidateNumber = 0;
  const enrichment = new KnowledgeEnrichmentService({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: active, createCandidateId: () => `candidate-${++candidateNumber}` });
  for (const [candidateIndex, evidenceCount] of evidenceCounts.entries()) {
    const sourceHashes = Array.from({ length: sourceHashesPerCandidate }, (_, hashIndex) => `sha256:${createHash("sha256").update(`candidate-${candidateIndex}-source-${hashIndex}`).digest("hex")}`);
    const evidenceEventIds = Array.from({ length: evidenceCount }, (_, evidenceIndex) => appendWorkflowEvent(projectRoot, createWorkflowEvent({
      eventId: `evidence-${candidateIndex + 1}-${evidenceIndex + 1}`, projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "artifact.recorded", producer: "harness",
      payload: { formatVersion: 1, nodeId: "root", sourceHashes },
    })).eventId);
    enrichment.propose("root", `proposal-attempt-${candidateIndex + 1}`, { scope: "shared", conclusion: `Both bundles use stable build graph variant ${candidateIndex + 1}.`, evidenceEventIds });
  }
  const terminal = appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "terminal.recorded", producer: "harness", payload: { formatVersion: 1, status: "completed" },
  }));
  enrichment.enqueueTerminal(terminal);
  let job = Object.values(restoreKnowledgeEnrichmentState(readWorkflowJournal(projectRoot, "session-1")).jobs)[0];
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "queued", to: "active", attemptCount: 1, staleReevaluations: 0, reason: "test-start", ownerNonce: "owner-1" },
  }));
  job = restoreKnowledgeEnrichmentState(readWorkflowJournal(projectRoot, "session-1")).jobs[job.jobId];
  const mutator = new OkfKnowledgeMutator({ projectRoot, snapshot: active, mutationQueue: async (_path, _id, callback) => callback() });
  const proposals = new KnowledgeProposalService({ projectRoot, projectId: "project-1", sessionId: "session-1", authenticateControl: () => undefined });
  return { projectRoot, active, job, mutator, proposals };
}

function curatorAdmission(job: { jobId: string; attemptCount: number; projectId: string; sessionId: string; runId: string; activeOwnerNonce?: string }, evaluation: 0 | 1) {
  const admissionId = `curator-${createHash("sha256").update(`pi-hive-curator-admission-v1\0${job.jobId}\0${job.attemptCount}\0${evaluation}`).digest("hex").slice(0, 48)}`;
  return createWorkflowEvent({
    projectId: job.projectId, sessionId: job.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness", correlationId: admissionId,
    payload: { formatVersion: 1, operation: "curator-model-admitted", jobId: job.jobId, ownerNonce: job.activeOwnerNonce!, admissionId, evaluation,
      reservedInputTokens: 32_768, reservedOutputTokens: 8_192, reservedCostMicroUsd: 100_000,
      limits: { maxSessionInputTokens: 4_194_304, maxSessionOutputTokens: 1_048_576, maxSessionCostMicroUsd: 10_000_000, maxSessionModelCalls: 128 } } as never,
  });
}

function transition(projectRoot: string, job: { jobId: string; projectId: string; sessionId: string; runId: string; state: string; attemptCount: number; staleReevaluations: number; activeOwnerNonce?: string }, to: "active" | "paused", ownerNonce = job.activeOwnerNonce ?? "owner-1") {
  appendWorkflowEvent(projectRoot, createWorkflowEvent({
    projectId: job.projectId, sessionId: job.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: job.state, to,
      attemptCount: to === "active" ? job.attemptCount + 1 : job.attemptCount, staleReevaluations: job.staleReevaluations, reason: "test-transition", ownerNonce },
  }));
}

test("all target hashes are preflighted before any multi-target effect and provider cost is durably replayed", async () => {
  const f = fixture();
  writeFileSync(join(f.projectRoot, ".pi/hive/knowledge/beta/existing.md"), "---\ntype: Knowledge\ntitle: beta\n---\n\nChanged before evaluation effects.\n");
  const evaluations: number[] = [];
  const processor = new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals,
    runModel: (request) => {
      evaluations.push(request.evaluation);
      const candidateId = /"candidateId":"([^"]+)"/u.exec(request.prompt)![1];
      const text = request.evaluation === 0 ? "Stale first-pass output must never be published." : "Fresh second-pass output is safe to publish everywhere.";
      return { output: JSON.stringify({ formatVersion: 1, conclusions: [{ text, citationIds: [candidateId] }] }), usage: { inputTokens: 100, outputTokens: 20, costMicroUsd: 12_345, precision: "provider-confirmed" } };
    },
  });
  await processor.process(f.job, new AbortController().signal);
  assert.deepEqual(evaluations, [0, 1]);
  for (const bundle of ["alpha", "beta"]) assert.equal(existsSync(join(f.projectRoot, `.pi/hive/knowledge/${bundle}/curated.md`)), false, "multi-target automatic publication is conservatively reviewed");
  const planned = Object.values(restoreKnowledgeProposalState(readWorkflowJournal(f.projectRoot, "session-1")).proposals);
  assert.equal(planned.length, 2);
  assert.equal(planned.every((proposal) => proposal.update.conclusions.every((conclusion) => !/Stale first-pass/u.test(conclusion.text) && /Fresh second-pass/u.test(conclusion.text))), true);
  const restored = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  assert.equal(Object.keys(restored.curatorAdmissions).length, 2);
  assert.equal(Object.values(restored.curatorAdmissions).every((admission) => admission.usage?.costMicroUsd === 12_345), true);
  assert.deepEqual(restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).curatorAccounting, restored.curatorAccounting, "admission and usage accounting replays exactly");
});

test("a target change after all-target preflight but before a later mutation publishes no stale mixed-prompt output", async () => {
  const f = fixture();
  let changedAfterPreflight = false;
  const mutator = new OkfKnowledgeMutator({
    projectRoot: f.projectRoot, snapshot: f.active,
    mutationQueue: async (_path, _operationId, callback) => callback(),
    fault: (stage) => {
      if (!changedAfterPreflight && stage === "after-intent") {
        changedAfterPreflight = true;
        writeFileSync(join(f.projectRoot, ".pi/hive/knowledge/beta/existing.md"), "---\ntype: Knowledge\ntitle: beta\n---\n\nChanged after locked all-target preflight and alpha intent.\n");
      }
    },
  });
  const evaluations: number[] = [];
  const processor = new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator, proposals: f.proposals,
    runModel: (request) => {
      evaluations.push(request.evaluation);
      const candidateId = /"candidateId":"([^"]+)"/u.exec(request.prompt)![1];
      const text = request.evaluation === 0 ? "First-pass stale output must not survive any target race." : "Second-pass output reflects the consistent target set.";
      return JSON.stringify({ formatVersion: 1, conclusions: [{ text, citationIds: [candidateId] }] });
    },
  });
  await processor.process(f.job, new AbortController().signal);
  assert.equal(changedAfterPreflight, false, "multi-target automatic work must not enter a first filesystem effect");
  assert.deepEqual(evaluations, [0]);
  for (const bundle of ["alpha", "beta"]) assert.equal(existsSync(join(f.projectRoot, `.pi/hive/knowledge/${bundle}/curated.md`)), false);
  const proposals = Object.values(restoreKnowledgeProposalState(readWorkflowJournal(f.projectRoot, "session-1")).proposals);
  assert.equal(proposals.length, 2);
  assert.equal(proposals.every((proposal) => proposal.update.conclusions.some((conclusion) => /First-pass stale output/u.test(conclusion.text))), true, "one exact reviewed plan replaces non-atomic multi-target automatic publication");
});

test("candidate citation expansion accepts N evidence citations and rejects N+1 before mutation", async () => {
  const run = async (evidenceCounts: readonly number[]) => {
    const f = fixture(evidenceCounts);
    const processor = new KnowledgeCuratorProcessor({
      projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals,
      runModel: (request) => {
        const citationIds = [...request.prompt.matchAll(/"candidateId":"([^"]+)"/gu)].map((match) => match[1]);
        return JSON.stringify({ formatVersion: 1, conclusions: [{ text: "Expanded evidence remains within the exact provenance bound.", citationIds }] });
      },
    });
    return { f, result: processor.process(f.job, new AbortController().signal) };
  };
  const exact = await run([16, 16]);
  await exact.result;
  assert.equal(Object.keys(restoreKnowledgeProposalState(readWorkflowJournal(exact.f.projectRoot, "session-1")).proposals).length, 2);
  const overflow = await run([16, 17]);
  await assert.rejects(() => overflow.result, /post-expansion bound/i);
  assert.equal(existsSync(join(overflow.f.projectRoot, ".pi/hive/knowledge/alpha/curated.md")), false);
  assert.equal(existsSync(join(overflow.f.projectRoot, ".pi/hive/knowledge/beta/curated.md")), false);
});

test("candidate citation expansion enforces the aggregate serialized update-byte bound deterministically", async () => {
  const process = async (sourceHashes: number) => {
    const f = fixture([16, 16], sourceHashes);
    const processor = new KnowledgeCuratorProcessor({
      projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals,
      now: () => "2026-01-01T00:00:02.000Z",
      runModel: (request) => {
        const citationIds = [...request.prompt.matchAll(/"candidateId":"([^"]+)"/gu)].map((match) => match[1]);
        return JSON.stringify({ formatVersion: 1, conclusions: [{ text: "Expanded provenance remains deterministically byte bounded.", citationIds }] });
      },
    });
    return { f, result: processor.process(f.job, new AbortController().signal) };
  };
  const bounded = await process(45);
  await bounded.result;
  assert.equal(Object.keys(restoreKnowledgeProposalState(readWorkflowJournal(bounded.f.projectRoot, "session-1")).proposals).length, 2);
  const overflow = await process(55);
  await assert.rejects(() => overflow.result, /post-expansion serialized byte bound/i);
  assert.equal(existsSync(join(overflow.f.projectRoot, ".pi/hive/knowledge/alpha/curated.md")), false);
});

test("a paused once-stale job durably refreshes a second-drift base and falls back without stale automatic publication", async () => {
  const f = fixture();
  const controller = new AbortController();
  const builtIn = createBuiltInKnowledgeProviderRegistry();
  const providers = new KnowledgeProviderRegistry();
  let processorLoads = 0;
  providers.register({
    id: "okf", version: "preemption-probe-v1",
    load(request) {
      const result = builtIn.load(request);
      processorLoads++;
      if (processorLoads === 4) controller.abort(new Error("test preemption after durable stale reload"));
      return result;
    },
  });
  const first = new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals, providers,
    runModel: (request) => {
      assert.equal(request.evaluation, 0);
      writeFileSync(join(f.projectRoot, ".pi/hive/knowledge/beta/existing.md"), "---\ntype: Knowledge\ntitle: beta\n---\n\nFirst drift before stale evaluation.\n");
      const candidateId = /"candidateId":"([^"]+)"/u.exec(request.prompt)![1];
      return JSON.stringify({ formatVersion: 1, conclusions: [{ text: "First evaluation observes the original target base.", citationIds: [candidateId] }] });
    },
  });
  await assert.rejects(() => first.process(f.job, controller.signal), /test preemption/i);
  let restored = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  let job = restored.jobs[f.job.jobId];
  assert.equal(job.staleReevaluations, 1);
  const onceStaleBetaHash = job.targets.find((target) => target.bundleId === "beta")!.expectedContentHash;

  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "active", to: "paused", attemptCount: 1, staleReevaluations: 1, reason: "test-preempted", ownerNonce: "owner-1" },
  }));
  writeFileSync(join(f.projectRoot, ".pi/hive/knowledge/beta/existing.md"), "---\ntype: Knowledge\ntitle: beta\n---\n\nSecond drift while the once-stale job is paused.\n");
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "paused", to: "active", attemptCount: 2, staleReevaluations: 1, reason: "test-resume", ownerNonce: "owner-2" },
  }));
  job = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs[job.jobId];
  const evaluations: number[] = [];
  let driftedAfterEvaluation = false;
  const resumed = new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals,
    runModel: (request) => {
      evaluations.push(request.evaluation);
      writeFileSync(join(f.projectRoot, ".pi/hive/knowledge/beta/existing.md"), "---\ntype: Knowledge\ntitle: beta\n---\n\nThird drift after the evaluation-one model output.\n");
      driftedAfterEvaluation = true;
      const candidateId = /"candidateId":"([^"]+)"/u.exec(request.prompt)![1];
      return JSON.stringify({ formatVersion: 1, conclusions: [{ text: "Resumed evaluation remains reviewable after second drift.", citationIds: [candidateId] }] });
    },
    fault: (stage) => { if (stage === "after-base-refresh-fallback") throw new Error("process death after atomic base-refresh fallback"); },
  });
  await assert.rejects(() => resumed.process(job, new AbortController().signal), /process death after atomic base-refresh fallback/i);
  const afterDeath = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  assert.ok(afterDeath.curatorPlans[job.jobId], "replacement fallback must be durable in the base-refresh event before process death");
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: job.projectId, sessionId: job.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "active", to: "paused", attemptCount: job.attemptCount, staleReevaluations: 1, reason: "process-death", ownerNonce: "owner-2" } }));
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: job.projectId, sessionId: job.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "paused", to: "active", attemptCount: job.attemptCount + 1, staleReevaluations: 1, reason: "takeover", ownerNonce: "owner-3" } }));
  job = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs[job.jobId];
  await new KnowledgeCuratorProcessor({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals,
    runModel: () => { throw new Error("model must not rerun after base-refresh-boundary process death"); } }).process(job, new AbortController().signal);
  assert.equal(driftedAfterEvaluation, true);
  assert.deepEqual(evaluations, [1]);
  assert.equal(existsSync(join(f.projectRoot, ".pi/hive/knowledge/alpha/curated.md")), false);
  assert.equal(existsSync(join(f.projectRoot, ".pi/hive/knowledge/beta/curated.md")), false);
  const events = readWorkflowJournal(f.projectRoot, "session-1");
  restored = restoreKnowledgeEnrichmentState(events);
  const durable = restored.jobs[job.jobId];
  assert.equal(durable.staleFallbackRequired, true);
  assert.notEqual(durable.targets.find((target) => target.bundleId === "beta")!.expectedContentHash, onceStaleBetaHash);
  const proposals = Object.values(restoreKnowledgeProposalState(events).proposals);
  assert.equal(proposals.length, 2);
  assert.equal(proposals.every((proposal) => proposal.state === "pending"), true);
  const refreshIndex = events.findIndex((event) => (event.payload as any).operation === "job-target-base-refreshed");
  const resumedAdmissionIndex = events.findIndex((event) => (event.payload as any).operation === "curator-model-admitted" && (event.payload as any).evaluation === 1 && (event.payload as any).ownerNonce === "owner-2");
  assert.ok(refreshIndex >= 0 && refreshIndex < resumedAdmissionIndex, "the exact refreshed base must be durable before resumed evaluation-1 admission");
  assert.doesNotThrow(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")));
});

test("a durable curator plan prevents model rerun and duplicate reviewed approvals after takeover", async () => {
  const f = fixture();
  // Multi-target automatic work is deliberately planned as reviewed so a
  // partial publication can never expose a stale first pass.
  const staleMutator = f.mutator;
  let proposalCalls = 0;
  const realCreate = f.proposals.create.bind(f.proposals);
  (f.proposals as any).create = (update: any) => {
    const proposal = realCreate(update);
    if (++proposalCalls === 1) throw new Error("crash after first proposal publication");
    return proposal;
  };
  let modelCalls = 0;
  const output = (request: any) => {
    modelCalls++;
    const candidateId = /"candidateId":"([^"]+)"/u.exec(request.prompt)![1];
    return JSON.stringify({ formatVersion: 1, conclusions: [{ text: "The exact planned conclusion survives curator takeover.", citationIds: [candidateId] }] });
  };
  const first = new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active,
    mutator: staleMutator, proposals: f.proposals, runModel: output,
  });
  await assert.rejects(() => first.process(f.job, new AbortController().signal), /crash after first proposal/i);
  assert.equal(Object.values(restoreKnowledgeProposalState(readWorkflowJournal(f.projectRoot, "session-1")).proposals).length, 1);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").some((event) => (event.payload as any).operation === "curator-plan-recorded"), true, "the exact bounded plan must precede its first external effect");

  let job = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs[f.job.jobId];
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "active", to: "paused", attemptCount: job.attemptCount, staleReevaluations: job.staleReevaluations, reason: "crash", ownerNonce: "owner-1" },
  }));
  job = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs[job.jobId];
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "paused", to: "active", attemptCount: job.attemptCount + 1, staleReevaluations: job.staleReevaluations, reason: "takeover", ownerNonce: "owner-2" },
  }));
  job = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs[job.jobId];
  await new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active,
    mutator: staleMutator, proposals: new KnowledgeProposalService({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", authenticateControl: () => undefined }), runModel: output,
  }).process(job, new AbortController().signal);
  assert.equal(modelCalls, 1, "takeover must replay the durable bounded plan without another model dispatch");
  assert.equal(Object.values(restoreKnowledgeProposalState(readWorkflowJournal(f.projectRoot, "session-1")).proposals).length, 2);
});

test("a stale unexecuted durable automatic plan is owner-CAS superseded, re-evaluated once, and converted to reviewed fallback", async () => {
  const f = fixture([1], 1, ["alpha"]);
  let modelCalls = 0;
  const output = (request: any) => {
    modelCalls++;
    const candidateId = /"candidateId":"([^"]+)"/u.exec(request.prompt)![1];
    return JSON.stringify({ formatVersion: 1, conclusions: [{ text: request.evaluation === 0
      ? "The first durable automatic plan becomes stale before its effect."
      : "The replacement evaluation is preserved as reviewed fallback.", citationIds: [candidateId] }] });
  };
  const crashingMutator = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: f.active, mutationQueue: async (_path, _id, callback) => callback() });
  (crashingMutator as any).apply = async () => { throw new Error("crash before automatic mutation effect"); };
  await assert.rejects(() => new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active,
    mutator: crashingMutator, proposals: f.proposals, runModel: output,
  }).process(f.job, new AbortController().signal), /crash before automatic/i);
  let restored = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  const stalePlanId = restored.curatorPlans[f.job.jobId].planId;
  let job = restored.jobs[f.job.jobId];
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`, payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "active", to: "paused", attemptCount: job.attemptCount, staleReevaluations: job.staleReevaluations, reason: "crash", ownerNonce: "owner-1" } }));
  writeFileSync(join(f.projectRoot, ".pi/hive/knowledge/alpha/existing.md"), "---\ntype: Knowledge\ntitle: alpha\n---\n\nThe target changed while the durable plan was paused.\n");
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`, payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "paused", to: "active", attemptCount: job.attemptCount + 1, staleReevaluations: job.staleReevaluations, reason: "takeover", ownerNonce: "owner-2" } }));
  job = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs[job.jobId];
  await new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active,
    mutator: f.mutator, proposals: f.proposals, runModel: output,
  }).process(job, new AbortController().signal);
  const events = readWorkflowJournal(f.projectRoot, "session-1");
  restored = restoreKnowledgeEnrichmentState(events);
  assert.equal(modelCalls, 2);
  assert.equal(restored.jobs[job.jobId].staleReevaluations, 1);
  assert.equal(restored.jobs[job.jobId].staleFallbackRequired, true);
  assert.notEqual(restored.curatorPlans[job.jobId].planId, stalePlanId);
  assert.equal((restored as any).curatorPlanHistory[stalePlanId].planId, stalePlanId);
  assert.equal(Object.values(restoreKnowledgeProposalState(events).proposals).length, 1);
  assert.equal(existsSync(join(f.projectRoot, ".pi/hive/knowledge/alpha/curated.md")), false);
  const invalidated = events.findIndex((event) => (event.payload as any).operation === "curator-plan-invalidated");
  const replacement = events.findIndex((event, index) => index > invalidated && (event.payload as any).operation === "curator-plan-recorded");
  assert.ok(invalidated >= 0 && replacement > invalidated, "exact invalidation must precede the replacement reviewed plan");
});

test("a stale durable evaluation-1 automatic plan is invalidated into deterministic reviewed fallback without a model rerun", async () => {
  const f = fixture([1], 1, ["alpha"]);
  let calls = 0;
  const noEffect = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: f.active, mutationQueue: async (_path, _id, callback) => callback() });
  (noEffect as any).apply = async () => { throw new Error("crash after evaluation-1 plan publication"); };
  await assert.rejects(() => new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: noEffect, proposals: f.proposals,
    runModel: (request) => {
      calls++;
      const candidateId = /"candidateId":"([^"]+)"/u.exec(request.prompt)![1];
      if (request.evaluation === 0) writeFileSync(join(f.projectRoot, ".pi/hive/knowledge/alpha/existing.md"), "---\ntype: Knowledge\ntitle: alpha\n---\n\nFirst drift forces evaluation one.\n");
      return JSON.stringify({ formatVersion: 1, conclusions: [{ text: request.evaluation === 0 ? "Evaluation zero becomes stale." : "Evaluation one remains the deterministic reviewed source.", citationIds: [candidateId] }] });
    },
  }).process(f.job, new AbortController().signal), /crash after evaluation-1 plan/i);
  let state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  const evaluationOnePlan = state.curatorPlans[f.job.jobId];
  assert.equal(evaluationOnePlan.evaluation, 1);
  let job = state.jobs[f.job.jobId];
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: job.projectId, sessionId: job.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "active", to: "paused", attemptCount: job.attemptCount, staleReevaluations: 1, reason: "crash", ownerNonce: "owner-1" } }));
  writeFileSync(join(f.projectRoot, ".pi/hive/knowledge/alpha/existing.md"), "---\ntype: Knowledge\ntitle: alpha\n---\n\nSecond drift invalidates the durable evaluation-one plan.\n");
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: job.projectId, sessionId: job.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "paused", to: "active", attemptCount: job.attemptCount + 1, staleReevaluations: 1, reason: "takeover", ownerNonce: "owner-2" } }));
  job = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs[job.jobId];
  await assert.rejects(() => new KnowledgeCuratorProcessor({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals,
    runModel: () => { throw new Error("model must not rerun for evaluation-1 stale fallback"); },
    fault: (stage) => { if (stage === "after-invalidation-fallback") throw new Error("process death after atomic invalidation fallback"); },
  }).process(job, new AbortController().signal), /process death after atomic invalidation fallback/i);
  const afterDeath = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  assert.ok(afterDeath.curatorPlans[job.jobId], "replacement fallback must be durable in the invalidation event before process death");
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: job.projectId, sessionId: job.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "active", to: "paused", attemptCount: job.attemptCount, staleReevaluations: 1, reason: "process-death", ownerNonce: "owner-2" } }));
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: job.projectId, sessionId: job.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "paused", to: "active", attemptCount: job.attemptCount + 1, staleReevaluations: 1, reason: "takeover", ownerNonce: "owner-3" } }));
  job = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs[job.jobId];
  await new KnowledgeCuratorProcessor({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals,
    runModel: () => { throw new Error("model must not rerun after invalidation-boundary process death"); } }).process(job, new AbortController().signal);
  const events = readWorkflowJournal(f.projectRoot, "session-1");
  state = restoreKnowledgeEnrichmentState(events);
  assert.equal(calls, 2);
  assert.notEqual(state.curatorPlans[job.jobId].planId, evaluationOnePlan.planId);
  assert.equal(state.curatorPlans[job.jobId].actions.every((action) => action.kind === "proposal" && action.reason === "stale-after-one-reevaluation"), true);
  assert.equal(Object.values(restoreKnowledgeProposalState(events).proposals).length, 1);
  assert.equal(existsSync(join(f.projectRoot, ".pi/hive/knowledge/alpha/curated.md")), false);
});

test("commit-boundary drift after plan validation supersedes the uncommitted plan and reaches reviewed fallback", async () => {
  const f = fixture([1], 1, ["alpha"]);
  let drifted = false;
  const mutator = new OkfKnowledgeMutator({
    projectRoot: f.projectRoot, snapshot: f.active, mutationQueue: async (_path, _id, callback) => callback(),
    fault: (stage) => {
      if (stage === "after-validation" && !drifted) {
        drifted = true;
        writeFileSync(join(f.projectRoot, ".pi/hive/knowledge/alpha/existing.md"), "---\ntype: Knowledge\ntitle: alpha\n---\n\nDrift at the commit boundary.\n");
      }
    },
  });
  const evaluations: number[] = [];
  await new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator, proposals: f.proposals,
    runModel: (request) => {
      evaluations.push(request.evaluation);
      const candidateId = /"candidateId":"([^"]+)"/u.exec(request.prompt)![1];
      return JSON.stringify({ formatVersion: 1, conclusions: [{ text: request.evaluation === 0 ? "The validated automatic plan became stale." : "The fresh result requires reviewed fallback.", citationIds: [candidateId] }] });
    },
  }).process(f.job, new AbortController().signal);
  const events = readWorkflowJournal(f.projectRoot, "session-1");
  assert.deepEqual(evaluations, [0, 1]);
  assert.equal(drifted, true);
  assert.equal(existsSync(join(f.projectRoot, ".pi/hive/knowledge/alpha/curated.md")), false);
  assert.equal(events.some((event) => (event.payload as any).operation === "mutation-committed"), false);
  assert.equal(events.some((event) => (event.payload as any).operation === "curator-plan-invalidated"), true);
  assert.equal(Object.values(restoreKnowledgeProposalState(events).proposals).length, 1);
});

test("durable no-output audit effects reconcile idempotently after a crash", async () => {
  const f = fixture();
  let modelCalls = 0;
  const processor = new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals,
    runModel: () => { modelCalls++; return JSON.stringify({ formatVersion: 1, conclusions: [] }); },
  });
  const originalAppend = (processor as any).append.bind(processor);
  let effects = 0;
  (processor as any).append = (...args: any[]) => {
    originalAppend(...args);
    if (++effects === 1) throw new Error("crash after first audit effect");
  };
  await assert.rejects(() => processor.process(f.job, new AbortController().signal), /crash after first audit/i);
  let job = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs[f.job.jobId];
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`, payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "active", to: "paused", attemptCount: job.attemptCount, staleReevaluations: job.staleReevaluations, reason: "crash", ownerNonce: "owner-1" } }));
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`, payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "paused", to: "active", attemptCount: job.attemptCount + 1, staleReevaluations: job.staleReevaluations, reason: "takeover", ownerNonce: "owner-2" } }));
  job = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs[job.jobId];
  await new KnowledgeCuratorProcessor({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals,
    runModel: () => { modelCalls++; return JSON.stringify({ formatVersion: 1, conclusions: [] }); },
  }).process(job, new AbortController().signal);
  assert.equal(modelCalls, 1);
  assert.equal(readWorkflowJournal(f.projectRoot, "session-1").filter((event) => (event.payload as any).operation === "target-skipped").length, 2);
});

test("recovered automatic plan reconciles an exact physical publication before stale-plan preflight", async () => {
  const f = fixture([1], 1, ["alpha"]);
  let armed = true;
  const interrupted = new OkfKnowledgeMutator({ projectRoot: f.projectRoot, snapshot: f.active, mutationQueue: async (_path, _id, callback) => callback(),
    fault: (stage) => { if (armed && stage === "after-publication") { armed = false; throw new Error("crash after physical publication"); } } });
  let modelCalls = 0;
  const output = (request: any) => { modelCalls++; const candidateId = /"candidateId":"([^"]+)"/u.exec(request.prompt)![1];
    return JSON.stringify({ formatVersion: 1, conclusions: [{ text: "Physical publication recovery preserves exact authoritative accounting.", citationIds: [candidateId] }] }); };
  await assert.rejects(() => new KnowledgeCuratorProcessor({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active,
    mutator: interrupted, proposals: f.proposals, runModel: output }).process(f.job, new AbortController().signal), /crash after physical publication/i);
  let job = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs[f.job.jobId];
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: job.projectId, sessionId: job.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "active", to: "paused", attemptCount: job.attemptCount, staleReevaluations: job.staleReevaluations, reason: "crash", ownerNonce: "owner-1" } }));
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: job.projectId, sessionId: job.sessionId, runId: job.runId, type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "paused", to: "active", attemptCount: job.attemptCount + 1, staleReevaluations: job.staleReevaluations, reason: "takeover", ownerNonce: "owner-2" } }));
  job = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs[job.jobId];
  await new KnowledgeCuratorProcessor({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active,
    mutator: f.mutator, proposals: f.proposals, runModel: output }).process(job, new AbortController().signal);
  const events = readWorkflowJournal(f.projectRoot, "session-1");
  assert.equal(modelCalls, 1);
  assert.equal(events.filter((event) => (event.payload as any).operation === "mutation-committed").length, 1);
  assert.equal(events.filter((event) => (event.payload as any).operation === "update-applied").length, 1);
  assert.equal(events.some((event) => (event.payload as any).operation === "curator-plan-invalidated"), false);
});

test("automatic plan recovery audits the authoritative mutation commit rather than a replay-local result", async () => {
  const f = fixture([1], 1, ["alpha"]);
  let armed = true;
  const faultingMutator = new OkfKnowledgeMutator({
    projectRoot: f.projectRoot, snapshot: f.active, mutationQueue: async (_path, _id, callback) => callback(),
    fault: (stage) => { if (armed && stage === "after-commit") { armed = false; throw new Error("crash after automatic mutation commit"); } },
  });
  let modelCalls = 0;
  const output = (request: any) => {
    modelCalls++;
    const candidateId = /"candidateId":"([^"]+)"/u.exec(request.prompt)![1];
    return JSON.stringify({ formatVersion: 1, conclusions: [{ text: "Automatic recovery preserves authoritative mutation accounting.", citationIds: [candidateId] }] });
  };
  await assert.rejects(() => new KnowledgeCuratorProcessor({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: faultingMutator, proposals: f.proposals, runModel: output }).process(f.job, new AbortController().signal), /crash after automatic/i);
  let job = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs[f.job.jobId];
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`, payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "active", to: "paused", attemptCount: job.attemptCount, staleReevaluations: job.staleReevaluations, reason: "crash", ownerNonce: "owner-1" } }));
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${job.jobId}`, payload: { formatVersion: 1, operation: "job-transition", jobId: job.jobId, from: "paused", to: "active", attemptCount: job.attemptCount + 1, staleReevaluations: job.staleReevaluations, reason: "takeover", ownerNonce: "owner-2" } }));
  job = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs[job.jobId];
  await new KnowledgeCuratorProcessor({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals, runModel: output }).process(job, new AbortController().signal);
  assert.equal(modelCalls, 1);
  const events = readWorkflowJournal(f.projectRoot, "session-1");
  const committed = events.find((event) => (event.payload as any).operation === "mutation-committed")!;
  const audited = events.find((event) => (event.payload as any).operation === "update-applied")!;
  assert.deepEqual((audited.payload as any).result, (committed.payload as any).result);
  assert.equal((audited.payload as any).result.changed, true);
});

test("curator audit and accounting reducers reject unknown fields, foreign owners, missing jobs, and duplicate usage", () => {
  const f = fixture();
  const forged = createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "dashboard", correlationId: `curator-${f.job.jobId}`,
    payload: { formatVersion: 999, operation: "target-skipped", jobId: f.job.jobId, ownerNonce: "other-owner", bundleId: "alpha", policy: "automatic", reason: "read-only-policy", injectedAuthority: true } as never,
  });
  assert.throws(() => restoreKnowledgeEnrichmentState([...readWorkflowJournal(f.projectRoot, "session-1"), forged as any]), /curator|skip|schema|owner|identity/i);
});

test("target-skipped reducer requires the exact current plan action and output", () => {
  const f = fixture([1], 1, ["alpha"]);
  const forged = createWorkflowEvent({ projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `curator-${f.job.jobId}`,
    payload: { formatVersion: 1, operation: "target-skipped", jobId: f.job.jobId, ownerNonce: "owner-1", bundleId: "alpha", policy: "automatic", reason: "no-stable-conclusions", curatorOutputHash: `sha256:${"7".repeat(64)}` } as never });
  assert.throws(() => restoreKnowledgeEnrichmentState([...readWorkflowJournal(f.projectRoot, "session-1"), forged as any]), /exact current plan|plan action|output identity/i);
});

test("update-applied reducer independently requires the exact prior plan action and mutation commit result", async () => {
  const f = fixture([1], 1, ["alpha"]);
  const forged = createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `curator-${f.job.jobId}`,
    payload: { formatVersion: 1, operation: "update-applied", jobId: f.job.jobId, ownerNonce: "owner-1", updateId: "invented-update", bundleId: "alpha",
      expectedContentHash: f.job.targets[0].expectedContentHash, curatorOutputHash: `sha256:${"8".repeat(64)}`,
      result: { updateId: "invented-update", bundleId: "alpha", changed: true, contentHash: `sha256:${"9".repeat(64)}`, documentId: "curated", conclusionCount: 1 } } as never,
  });
  assert.throws(() => restoreKnowledgeEnrichmentState([...readWorkflowJournal(f.projectRoot, "session-1"), forged as any]), /plan|mutation|commit|authoritative|applied/i);

  const planned = fixture([1], 1, ["alpha"]);
  const noCommit = new OkfKnowledgeMutator({ projectRoot: planned.projectRoot, snapshot: planned.active, mutationQueue: async (_path, _id, callback) => callback() });
  (noCommit as any).apply = async () => { throw new Error("stop after exact plan"); };
  await assert.rejects(() => new KnowledgeCuratorProcessor({
    projectRoot: planned.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: planned.active, mutator: noCommit, proposals: planned.proposals,
    runModel: (request) => JSON.stringify({ formatVersion: 1, conclusions: [{ text: "An exact automatic plan exists without a mutation commit.", citationIds: [/"candidateId":"([^"]+)"/u.exec(request.prompt)![1]] }] }),
  }).process(planned.job, new AbortController().signal), /stop after exact plan/i);
  const before = readWorkflowJournal(planned.projectRoot, "session-1");
  const plan = restoreKnowledgeEnrichmentState(before).curatorPlans[planned.job.jobId];
  const action = plan.actions.find((entry) => entry.kind === "automatic")!;
  if (action.kind !== "automatic") throw new Error("expected automatic action");
  const result = { updateId: action.update.updateId, bundleId: action.bundleId, changed: true, contentHash: `sha256:${"7".repeat(64)}`, documentId: "curated", conclusionCount: 1 };
  const forgedCommitAccounting = createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `curator-${planned.job.jobId}`,
    payload: { formatVersion: 1, operation: "update-applied", jobId: planned.job.jobId, ownerNonce: "owner-1", updateId: action.update.updateId, bundleId: action.bundleId,
      expectedContentHash: action.update.expectedContentHash, curatorOutputHash: plan.output.outputHash, result } as never,
  });
  assert.throws(() => restoreKnowledgeEnrichmentState([...before, forgedCommitAccounting as any]), /mutation|commit|authoritative|applied/i);
});

test("admission replay requires the current evaluation and rejects per-job N+1", () => {
  const wrong = fixture();
  const wrongWriter = new KnowledgeCuratorProcessor({
    projectRoot: wrong.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: wrong.active, mutator: wrong.mutator, proposals: wrong.proposals,
    runModel: () => "must not dispatch",
  });
  assert.throws(() => (wrongWriter as any).admitModel(wrong.job, 1), /evaluation|eligible|current/i);
  assert.equal(Object.keys(restoreKnowledgeEnrichmentState(readWorkflowJournal(wrong.projectRoot, "session-1")).curatorAdmissions).length, 0);
  const wrongEvent = curatorAdmission(wrong.job, 1);
  assert.throws(() => restoreKnowledgeEnrichmentState([...readWorkflowJournal(wrong.projectRoot, "session-1"), wrongEvent as any]), /admission|evaluation|budget|replay/i);

  const bounded = fixture();
  appendWorkflowEvent(bounded.projectRoot, curatorAdmission(bounded.job, 0));
  let state = restoreKnowledgeEnrichmentState(readWorkflowJournal(bounded.projectRoot, "session-1"));
  transition(bounded.projectRoot, state.jobs[bounded.job.jobId], "paused");
  state = restoreKnowledgeEnrichmentState(readWorkflowJournal(bounded.projectRoot, "session-1"));
  transition(bounded.projectRoot, state.jobs[bounded.job.jobId], "active", "owner-2");
  state = restoreKnowledgeEnrichmentState(readWorkflowJournal(bounded.projectRoot, "session-1"));
  appendWorkflowEvent(bounded.projectRoot, curatorAdmission(state.jobs[bounded.job.jobId], 0));
  assert.equal(Object.keys(restoreKnowledgeEnrichmentState(readWorkflowJournal(bounded.projectRoot, "session-1")).curatorAdmissions).length, 2, "the exact per-job limit N remains admitted");
  state = restoreKnowledgeEnrichmentState(readWorkflowJournal(bounded.projectRoot, "session-1"));
  transition(bounded.projectRoot, state.jobs[bounded.job.jobId], "paused", "owner-2");
  state = restoreKnowledgeEnrichmentState(readWorkflowJournal(bounded.projectRoot, "session-1"));
  transition(bounded.projectRoot, state.jobs[bounded.job.jobId], "active", "owner-3");
  state = restoreKnowledgeEnrichmentState(readWorkflowJournal(bounded.projectRoot, "session-1"));
  appendWorkflowEvent(bounded.projectRoot, curatorAdmission(state.jobs[bounded.job.jobId], 0));
  assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(bounded.projectRoot, "session-1")), /admission|budget|per-job|replay/i);
});

test("admission replay rejects a derived session denial before a denial marker exists", () => {
  const f = fixture();
  const admission = curatorAdmission(f.job, 0);
  appendWorkflowEvent(f.projectRoot, admission);
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: f.job.projectId, sessionId: f.job.sessionId, runId: f.job.runId, type: "knowledge.transition", producer: "harness", correlationId: admission.correlationId,
    payload: { formatVersion: 1, operation: "curator-model-usage", jobId: f.job.jobId, ownerNonce: f.job.activeOwnerNonce!, admissionId: admission.correlationId,
      usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 10_000_001, precision: "provider-confirmed" } } as never,
  }));
  let state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  transition(f.projectRoot, state.jobs[f.job.jobId], "paused");
  state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  transition(f.projectRoot, state.jobs[f.job.jobId], "active", "owner-2");
  state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  appendWorkflowEvent(f.projectRoot, curatorAdmission(state.jobs[f.job.jobId], 0));
  assert.throws(() => restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")), /admission|session|budget|denial/i);
});

test("concurrent processing cannot dispatch the same durable curator admission twice", async () => {
  const f = fixture();
  let modelCalls = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const processor = new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals,
    runModel: async () => { modelCalls++; await hold; return { output: JSON.stringify({ formatVersion: 1, conclusions: [] }), usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1, precision: "provider-confirmed" } }; },
  });
  const first = processor.process(f.job, new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => processor.process(f.job, new AbortController().signal), /admission|already|duplicated|replay/i);
  assert.equal(modelCalls, 1);
  release();
  await first;
});

test("a crash after durable admission replays fail-closed without an uncharged duplicate model dispatch", async () => {
  const f = fixture();
  let modelCalls = 0;
  const processor = new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals,
    runModel: () => { modelCalls++; throw new Error("provider disconnected after dispatch intent"); },
  });
  await assert.rejects(() => processor.process(f.job, new AbortController().signal), /disconnected/i);
  assert.equal(Object.keys(restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).curatorAdmissions).length, 1);
  await assert.rejects(() => processor.process(f.job, new AbortController().signal), /admission|already|duplicated|replay/i);
  assert.equal(modelCalls, 1);
});

test("post-denial owner takeover settles only through the new exact active owner", async () => {
  const f = fixture();
  let modelCalls = 0;
  const processor = new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals,
    runModel: () => { modelCalls++; throw new Error("simulated provider crash after admission"); },
  });
  await assert.rejects(() => processor.process(f.job, new AbortController().signal), /provider crash/i);
  let state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  transition(f.projectRoot, state.jobs[f.job.jobId], "paused");
  state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  transition(f.projectRoot, state.jobs[f.job.jobId], "active", "old-owner");
  state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  await assert.rejects(() => processor.process(state.jobs[f.job.jobId], new AbortController().signal), /provider crash/i);
  state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  transition(f.projectRoot, state.jobs[f.job.jobId], "paused", "old-owner");
  state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  transition(f.projectRoot, state.jobs[f.job.jobId], "active", "old-owner");
  state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  await assert.rejects(() => processor.process(state.jobs[f.job.jobId], new AbortController().signal), /per-job|budget|denied/i);
  state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  const denial = state.curatorBudgetDenials[f.job.jobId];
  assert.equal(denial.ownerNonce, "old-owner");
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: f.job.projectId, sessionId: f.job.sessionId, runId: f.job.runId, type: "knowledge.transition", producer: "recovery", correlationId: `knowledge-takeover-${f.job.jobId}`,
    payload: { formatVersion: 1, operation: "job-owner-taken-over", jobId: f.job.jobId, expectedOwnerNonce: "old-owner", newOwnerNonce: "new-owner", reason: "verified process/boot owner death" },
  }));
  state = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  const detachedFailure = createWorkflowEvent({
    projectId: f.job.projectId, sessionId: f.job.sessionId, runId: f.job.runId, type: "knowledge.transition", producer: "harness",
    payload: { formatVersion: 1, operation: "job-transition", jobId: f.job.jobId, from: "paused", to: "failed", attemptCount: state.jobs[f.job.jobId].attemptCount,
      staleReevaluations: 0, reason: denial.reason, ownerNonce: "unrelated-owner" },
  });
  assert.throws(() => restoreKnowledgeEnrichmentState([...readWorkflowJournal(f.projectRoot, "session-1"), detachedFailure as any]), /owner|transition|CAS|denial/i);

  const queue = new DurableKnowledgeQueue({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", ownerNonce: "new-owner", isIdle: () => true,
    process: (job, signal) => processor.process(job, signal),
  });
  await queue.wake();
  assert.equal(queue.restore().jobs[f.job.jobId].state, "failed");
  assert.equal(queue.restore().jobs[f.job.jobId].lastReason, denial.reason);
  assert.equal(modelCalls, 2, "takeover failure closure must not redispatch after canonical denial");
});

test("provider token/cost overage is durable, replayable, and exhausts later admission", async () => {
  const f = fixture();
  const processor = new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals,
    runModel: (request) => ({
      output: JSON.stringify({ formatVersion: 1, conclusions: [] }),
      usage: { inputTokens: request.maxInputTokens + 1, outputTokens: 0, costMicroUsd: 10_000_001, precision: "provider-confirmed" },
    }),
  });
  await assert.rejects(() => processor.process(f.job, new AbortController().signal), /per-call token limit|exceeded/i);
  const restored = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1"));
  const admission = Object.values(restored.curatorAdmissions)[0];
  assert.equal(admission.usage?.inputTokens, 32_769);
  assert.ok(restored.curatorAccounting.reservedInputTokens > 32_768);
  assert.ok(restored.curatorAccounting.reservedCostMicroUsd > 10_000_000);
  const events = readWorkflowJournal(f.projectRoot, "session-1");
  const usageEvent = events.find((event) => (event.payload as any).operation === "curator-model-usage")!;
  assert.throws(() => restoreKnowledgeEnrichmentState([...events, usageEvent]), /usage|admission|duplicate|CAS/i);

  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${f.job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: f.job.jobId, from: "active", to: "paused", attemptCount: 1, staleReevaluations: 0, reason: "retry", ownerNonce: "owner-1" },
  }));
  appendWorkflowEvent(f.projectRoot, createWorkflowEvent({
    projectId: "project-1", sessionId: "session-1", runId: "run-1", type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${f.job.jobId}`,
    payload: { formatVersion: 1, operation: "job-transition", jobId: f.job.jobId, from: "paused", to: "active", attemptCount: 2, staleReevaluations: 0, reason: "retry", ownerNonce: "owner-1" },
  }));
  const retried = restoreKnowledgeEnrichmentState(readWorkflowJournal(f.projectRoot, "session-1")).jobs[f.job.jobId];
  let retriedCalls = 0;
  const retry = new KnowledgeCuratorProcessor({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", snapshot: f.active, mutator: f.mutator, proposals: f.proposals,
    runModel: () => { retriedCalls++; return "never admitted"; },
  });
  await assert.rejects(() => retry.process(retried, new AbortController().signal), /budget|admission denied/i);
  assert.equal(retriedCalls, 0);
});
