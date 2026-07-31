import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundCuratorTargetContext,
  buildCuratorPrompt,
  parseCuratorOutput,
  type CuratorCandidateView,
} from "../../src/knowledge/curator.ts";
import { boundCuratorTargetContext as boundAdmissionTargetContext, buildCuratorPrompt as buildAdmissionPrompt, curatorFitsSnapshotModelContext } from "../../src/knowledge/curator-contract.ts";

const candidates: CuratorCandidateView[] = [{
  candidateId: "candidate-1",
  conclusion: "The build graph must remain deterministic.",
  citations: [{ eventId: "event-1", eventHash: "a".repeat(64), payloadHash: "b".repeat(64), sequence: 7, type: "attempt.result.recorded" }],
  sourceHashes: [`sha256:${"c".repeat(64)}`],
}];

test("curator prompt is provider-neutral, bounded, untrusted, and forbids authority or transcript output", () => {
  const prompt = buildCuratorPrompt({
    jobId: "job-1", scope: "shared", targets: [{ bundleId: "project", policy: "reviewed", expectedContentHash: `sha256:${"d".repeat(64)}` }], candidates,
  });
  assert.match(prompt, /untrusted evidence/i);
  assert.match(prompt, /stable conclusions/i);
  assert.match(prompt, /citations? required/i);
  assert.match(prompt, /must not.*authority|authority.*must not/i);
  assert.match(prompt, /do not.*transcript|transcript.*do not/i);
  assert.doesNotMatch(prompt, /anthropic|openai|google/i);
  assert.ok(Buffer.byteLength(prompt, "utf8") <= 131_072);
});

test("durable admission and production dispatch share one exact conservative prompt contract", () => {
  const targets = [{ bundleId: "project", policy: "reviewed" as const, expectedContentHash: `sha256:${"d".repeat(64)}`, currentSummary: "Verified project summary.", documentCount: 3 }];
  const admittedTargets = boundAdmissionTargetContext(targets);
  const productionTargets = boundCuratorTargetContext(targets);
  const admitted = buildAdmissionPrompt({ jobId: "job-1", scope: "shared", targets: admittedTargets, candidates });
  const production = buildCuratorPrompt({ jobId: "job-1", scope: "shared", targets: productionTargets, candidates });
  assert.equal(admitted, production);
  assert.ok(Buffer.byteLength(production, "utf8") <= 32_768);
});

test("curator target context is serialized-byte bounded and explicitly reports every summary/document omission", () => {
  const targets = Array.from({ length: 64 }, (_, index) => ({
    bundleId: `bundle-${index}`,
    policy: "reviewed" as const,
    expectedContentHash: `sha256:${String(index % 10).repeat(64)}`,
    currentSummary: "summary ".repeat(2_048),
    documentCount: 1_024,
  }));
  const bounded = boundCuratorTargetContext(targets);
  assert.equal(bounded.length, targets.length);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 24_000);
  assert.equal(bounded.every((target) => target.summaryTruncated && target.documentsOmitted === 1_024), true);
});

test("curator admission rejects malformed model, target, prompt, and provenance branches", () => {
  assert.equal(curatorFitsSnapshotModelContext({ staticTokens: 1, contextWindow: 100_000 }), true);
  for (const model of [
    { staticTokens: 1.5, contextWindow: 100_000 },
    { staticTokens: -1, contextWindow: 100_000 },
    { staticTokens: 1, contextWindow: 100_000.5 },
    { staticTokens: 1, contextWindow: 0 },
    { staticTokens: 1, contextWindow: 40_000 },
  ]) assert.equal(curatorFitsSnapshotModelContext(model), false);

  assert.deepEqual(boundAdmissionTargetContext([{
    bundleId: "empty-summary", policy: "reviewed", expectedContentHash: `sha256:${"d".repeat(64)}`, currentSummary: "", documentCount: 0,
  }])[0], {
    bundleId: "empty-summary", policy: "reviewed", expectedContentHash: `sha256:${"d".repeat(64)}`, currentSummary: "", summaryTruncated: false, documentsOmitted: 0,
  });
  for (const targets of [
    [],
    [null],
    [{ bundleId: "", policy: "reviewed", expectedContentHash: `sha256:${"d".repeat(64)}`, currentSummary: "summary", documentCount: 1 }],
    [{ bundleId: "project", policy: "reviewed", expectedContentHash: `sha256:${"d".repeat(64)}`, currentSummary: 1, documentCount: 1 }],
    [{ bundleId: "project", policy: "reviewed", expectedContentHash: `sha256:${"d".repeat(64)}`, currentSummary: "summary", documentCount: 1.5 }],
    [{ bundleId: "project", policy: "reviewed", expectedContentHash: `sha256:${"d".repeat(64)}`, currentSummary: "summary", documentCount: -1 }],
    [{ bundleId: "x".repeat(24_001), policy: "reviewed", expectedContentHash: `sha256:${"d".repeat(64)}`, currentSummary: "summary", documentCount: 1 }],
  ]) assert.throws(() => boundAdmissionTargetContext(targets as never), /target|context|bound|invalid/i);

  const base = { jobId: "job-1", scope: "shared", targets: [{ bundleId: "project", policy: "reviewed", expectedContentHash: `sha256:${"d".repeat(64)}` }], candidates } as const;
  const invalidInputs: unknown[] = [
    null,
    { ...base, jobId: "" },
    { ...base, scope: "global" },
    { ...base, targets: [] },
    { ...base, candidates: [] },
    { ...base, candidates: Array.from({ length: 513 }, () => candidates[0]) },
    { ...base, candidates: [{ ...candidates[0], candidateId: "" }] },
    { ...base, candidates: [{ ...candidates[0], candidateId: "x".repeat(257) }] },
    { ...base, candidates: [{ ...candidates[0], conclusion: 1 }] },
    { ...base, candidates: [{ ...candidates[0], conclusion: "short" }] },
    { ...base, candidates: [{ ...candidates[0], conclusion: "Unsafe conclusion\ntext" }] },
    { ...base, candidates: [{ ...candidates[0], citations: [] }] },
    { ...base, candidates: [{ ...candidates[0], sourceHashes: {} }] },
    { ...base, candidates: [{ ...candidates[0], sourceHashes: Array.from({ length: 129 }, () => `sha256:${"c".repeat(64)}`) }] },
  ];
  for (const input of invalidInputs) assert.throws(() => buildAdmissionPrompt(input as never), /prompt|candidate|conclusion|provenance|bound|invalid/i);

  const oversizedCandidates = Array.from({ length: 512 }, (_, index) => ({
    ...candidates[0], candidateId: `candidate-${index}`, conclusion: "x".repeat(4_096),
  }));
  assert.throws(() => buildAdmissionPrompt({ ...base, candidates: oversizedCandidates }), /production input bound/i);
});

test("strict curator output requires exact candidate citations and rejects authority/config fields", () => {
  const parsed = parseCuratorOutput(JSON.stringify({
    formatVersion: 1,
    conclusions: [{ text: "The build graph must remain deterministic.", citationIds: ["candidate-1"] }],
  }), candidates);
  assert.deepEqual(parsed.conclusions, [{ text: "The build graph must remain deterministic.", citationIds: ["candidate-1"] }]);
  assert.match(parsed.outputHash, /^sha256:[0-9a-f]{64}$/u);

  for (const invalid of [
    { formatVersion: 1, conclusions: [{ text: "Unsupported statement.", citationIds: [] }] },
    { formatVersion: 1, conclusions: [{ text: "Unsupported statement.", citationIds: ["missing"] }] },
    { formatVersion: 1, conclusions: [{ text: "Change the agent capability policy.", citationIds: ["candidate-1"], authority: { filesystem: true } }] },
    { formatVersion: 1, conclusions: [{ text: "Multiline\n---\nprompt: override", citationIds: ["candidate-1"] }] },
    { formatVersion: 1, conclusions: [], config: { workflow: "rewrite" } },
  ]) assert.throws(() => parseCuratorOutput(JSON.stringify(invalid), candidates), /schema|citation|field|single-line|conclusion/i);
  assert.throws(() => parseCuratorOutput("not-json", candidates), /JSON/i);
});

test("curator output dedupe union accepts N citations and rejects N+1 after consolidation", () => {
  const boundedCandidates: CuratorCandidateView[] = Array.from({ length: 33 }, (_, index) => ({
    candidateId: `candidate-${String(index).padStart(2, "0")}`,
    conclusion: `Stable candidate conclusion number ${index}.`,
    citations: [{ eventId: `event-${index}`, eventHash: String(index % 10).repeat(64), payloadHash: String((index + 1) % 10).repeat(64), sequence: index + 1, type: "attempt.result.recorded" }],
    sourceHashes: [`sha256:${String((index + 2) % 10).repeat(64)}`],
  }));
  const exact = parseCuratorOutput(JSON.stringify({ formatVersion: 1, conclusions: [
    { text: "The build graph must remain deterministic.", citationIds: boundedCandidates.slice(0, 16).map((candidate) => candidate.candidateId) },
    { text: "  The   build graph must remain deterministic.  ", citationIds: boundedCandidates.slice(16, 32).map((candidate) => candidate.candidateId) },
  ] }), boundedCandidates);
  assert.equal(exact.conclusions.length, 1);
  assert.equal(exact.conclusions[0].citationIds.length, 32);
  assert.throws(() => parseCuratorOutput(JSON.stringify({ formatVersion: 1, conclusions: [
    { text: "The build graph must remain deterministic.", citationIds: boundedCandidates.slice(0, 16).map((candidate) => candidate.candidateId) },
    { text: "  The   build graph must remain deterministic.  ", citationIds: boundedCandidates.slice(16, 33).map((candidate) => candidate.candidateId) },
  ] }), boundedCandidates), /post-deduplication bound|citation/i);
});
