import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMarkdownPlanAdapter, MARKDOWN_PLAN_PROFILES } from "../../src/artifacts/adapters/markdown-plan.ts";
import { CheckpointApprovalService } from "../../src/artifacts/approvals.ts";
import { resolveCheckpointDigest } from "../../src/artifacts/checkpoints.ts";
import { ArtifactFacade } from "../../src/artifacts/facade.ts";
import { hashArtifactWorkspace } from "../../src/artifacts/hashes.ts";
import { createRunOrchestrationArtifactCallerIssuer } from "../../src/artifacts/internal/caller.ts";
import { WorkspaceLeaseRuntime } from "../../src/artifacts/leases.ts";
import { ArtifactOperationRuntime } from "../../src/artifacts/operations.ts";
import { bindPhysicalArtifactWorkspace } from "../../src/artifacts/workspaces.ts";
import type { ArtifactActionContext, ArtifactEvidenceReferenceV1, ArtifactWorkspaceBinding, VerifiedArtifactEvidenceV1 } from "../../src/artifacts/types.ts";
import { WorkflowRunLifecycle } from "../../src/workflows/runs.ts";

function fixture(label: string) {
  const projectRoot = mkdtempSync(join(tmpdir(), `hive-markdown-plan-e2e-${label}-`));
  return { projectRoot, adapter: createMarkdownPlanAdapter({ now: () => "2026-01-01T00:00:00.000Z" }) };
}
function live(value: ArtifactWorkspaceBinding): ArtifactWorkspaceBinding { return Object.freeze({ ...value, workspaceHash: hashArtifactWorkspace(value.path!).workspaceHash }); }
function repositoryRef(root: string, path: string) { return { kind: "repository" as const, path, digest: `sha256:${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}` }; }
const toolRef = { kind: "tool" as const, attemptId: "tool-test" };
async function action(adapter: ReturnType<typeof createMarkdownPlanAdapter>, value: ArtifactWorkspaceBinding, actionId: string, argumentsValue: Record<string, unknown>, operationId: string) {
  const profile = adapter.profiles.find((entry) => entry.id === value.profileId)!;
  const contract = profile.actions.find((entry) => entry.id === actionId)!;
  const current = live(value);
  const context: ArtifactActionContext = Object.freeze({
    binding: current, capabilities: Object.freeze(["read", "write", "review"] as const), hashes: hashArtifactWorkspace(current.path!), operationId,
    expectedWorkspaceHash: current.workspaceHash, enqueueMutation: async <T>(_path: string, callback: () => T | Promise<T>): Promise<T> => callback(),
    verifyEvidence: (references: readonly ArtifactEvidenceReferenceV1[]): readonly VerifiedArtifactEvidenceV1[] => references.map((reference) => {
      if (reference.kind === "tool") return { kind: "tool" as const, attemptId: reference.attemptId, operation: "tool.test", inputHash: "a".repeat(64), resultHash: "b".repeat(64) };
      if (reference.kind !== "repository") throw new Error("command evidence is unused");
      const root = join(current.path!, "..", ".."); const content = readFileSync(join(root, reference.path));
      return { kind: "repository" as const, path: reference.path, digest: reference.digest, bytes: content.byteLength };
    }),
  });
  return adapter.executeAction!(context, contract, argumentsValue as never);
}
const plan = { title: "Deliver feature", summary: "Implement and review the requested feature.", tasks: [{ id: "deliver", text: "Deliver the feature" }] };

async function facadeAction(input: Readonly<{
  projectRoot: string;
  adapter: ReturnType<typeof createMarkdownPlanAdapter>;
  binding: ArtifactWorkspaceBinding;
  sessionId: string;
  runId: string;
  actionId: string;
  arguments: Record<string, unknown>;
  operationId: string;
}>) {
  const current = live(input.binding);
  const lease = new WorkspaceLeaseRuntime({ projectRoot: input.projectRoot, adapterId: "markdown-plan", workspaceId: current.workspace.id, sessionId: input.sessionId, runId: input.runId });
  const facade = new ArtifactFacade({ adapter: input.adapter, profile: input.adapter.profiles.find((entry) => entry.id === current.profileId)!, binding: current,
    mutationQueue: async (_target, _operationId, callback) => callback(), workspaceAuthority: {
      readHashes: () => hashArtifactWorkspace(current.path!), lease,
      operations: new ArtifactOperationRuntime({ projectRoot: input.projectRoot, projectId: "project", sessionId: input.sessionId, runId: input.runId }),
    },
  });
  const caller = createRunOrchestrationArtifactCallerIssuer({ payload: { authority: { nodes: [{ nodeId: "root", capabilities: { effective: { artifact: ["read", "review", "write"] } }, tools: ["artifact_action", "artifact_status"] }] } } } as never).issue("root", current);
  try {
    return await facade.action(caller, { actionId: input.actionId, arguments: input.arguments, ...(input.adapter.profiles.find((entry) => entry.id === current.profileId)!.actions.find((entry) => entry.id === input.actionId)!.mutability === "mutating" ? { expectedWorkspaceHash: current.workspaceHash } : {}) }, {
      attemptId: input.operationId,
      verifyEvidence: (references) => references.map((reference) => {
        if (reference.kind === "tool") return { kind: "tool" as const, attemptId: reference.attemptId, operation: "tool.test", inputHash: "a".repeat(64), resultHash: "b".repeat(64) };
        if (reference.kind !== "repository") throw new Error("command evidence is unused");
        const content = readFileSync(join(input.projectRoot, reference.path));
        return { kind: "repository" as const, path: reference.path, digest: reference.digest, bytes: content.byteLength };
      }),
    });
  } finally { lease.release(); }
}

test("split Markdown author handoff execute review revalidates exact current evidence without carrying approval authority", async () => {
  const f = fixture("split"); mkdirSync(join(f.projectRoot, "src")); writeFileSync(join(f.projectRoot, "src", "delivery.ts"), "export const delivered = true;\n");
  const author = bindPhysicalArtifactWorkspace({ projectRoot: f.projectRoot, adapter: f.adapter, profile: MARKDOWN_PLAN_PROFILES.author, runId: "author-run", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "split-plan" } });
  await facadeAction({ projectRoot: f.projectRoot, adapter: f.adapter, binding: author, sessionId: "author-session", runId: "author-run", actionId: "markdown-plan.plan.author", arguments: plan, operationId: "author-plan" });
  const authorHashes = hashArtifactWorkspace(author.path!);
  const authorPlan = resolveCheckpointDigest(f.adapter.checkpointDescriptor!({ binding: live(author), checkpointId: "plan", hashes: authorHashes }), authorHashes);
  const execute = bindPhysicalArtifactWorkspace({ projectRoot: f.projectRoot, adapter: f.adapter, profile: MARKDOWN_PLAN_PROFILES.execute, runId: "execute-run", configuredBinding: "existing", options: {}, selection: { mode: "existing", workspaceId: "split-plan" }, handoffReference: { workspaceId: "split-plan", checkpoint: "plan", digest: authorPlan.digest } });
  const executeHashes = hashArtifactWorkspace(execute.path!);
  assert.notEqual(resolveCheckpointDigest(f.adapter.checkpointDescriptor!({ binding: live(execute), checkpointId: "plan", hashes: executeHashes }), executeHashes).digest, authorPlan.digest);
  await facadeAction({ projectRoot: f.projectRoot, adapter: f.adapter, binding: execute, sessionId: "execute-session", runId: "execute-run", actionId: "markdown-plan.tasks.complete", arguments: { taskId: "deliver", evidenceRefs: [toolRef, repositoryRef(f.projectRoot, "src/delivery.ts")] }, operationId: "execute-task" });
  assert.equal((await f.adapter.validateCompletion(live(execute))).state, "satisfied");
  const implementationHashes = hashArtifactWorkspace(execute.path!);
  const execution = resolveCheckpointDigest(f.adapter.checkpointDescriptor!({ binding: live(execute), checkpointId: "execution", hashes: implementationHashes }), implementationHashes);
  const review = bindPhysicalArtifactWorkspace({ projectRoot: f.projectRoot, adapter: f.adapter, profile: MARKDOWN_PLAN_PROFILES.review, runId: "review-run", configuredBinding: "existing", options: {}, selection: { mode: "existing", workspaceId: "split-plan" }, handoffReference: { workspaceId: "split-plan", checkpoint: "execution", digest: execution.digest } });
  assert.equal(MARKDOWN_PLAN_PROFILES.review.actions.some((entry) => entry.id === "markdown-plan.tasks.complete"), false);
  assert.equal((await f.adapter.validateCompletion(live(review))).state, "satisfied");
  const reviewData = await facadeAction({ projectRoot: f.projectRoot, adapter: f.adapter, binding: review, sessionId: "review-session", runId: "review-run", actionId: "markdown-plan.review.inspect", arguments: {}, operationId: "inspect-review" });
  assert.deepEqual(reviewData.data.completedTaskIds, ["deliver"]);
  writeFileSync(join(author.path!, "plan.md"), readFileSync(join(author.path!, "plan.md"), "utf8").replace("Deliver the feature", "Deliver the revised feature"));
  assert.throws(() => bindPhysicalArtifactWorkspace({ projectRoot: f.projectRoot, adapter: f.adapter, profile: MARKDOWN_PLAN_PROFILES.execute, runId: "stale-run", configuredBinding: "existing", options: {}, selection: { mode: "existing", workspaceId: "split-plan" }, handoffReference: { workspaceId: "split-plan", checkpoint: "plan", digest: authorPlan.digest } }), /stale/i);
});

test("a real W18 denial is immutable for one Markdown plan digest and revision creates a fresh request", async () => {
  const f = fixture("approval-revision");
  const created = bindPhysicalArtifactWorkspace({ projectRoot: f.projectRoot, adapter: f.adapter, profile: MARKDOWN_PLAN_PROFILES.author, runId: "approval-run", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "approval-plan" } });
  await action(f.adapter, created, "markdown-plan.plan.author", plan, "approval-author");
  const current = live(created);
  let requestId = 0; let decisionId = 0;
  const service = new CheckpointApprovalService({
    projectRoot: f.projectRoot, projectId: "project", sessionId: "approval-session", adapterId: "markdown-plan", adapterVersion: "1", profileId: "author", profileVersion: "1", profileSchemaVersion: "1",
    checkpointPolicies: { plan: "required" }, resolveDescriptor: ({ checkpointId, binding }) => f.adapter.checkpointDescriptor!({ binding, checkpointId, hashes: hashArtifactWorkspace(binding.path!) }),
    authenticateControl: ({ credential }) => credential === "human-secret" ? { approverId: "human", authenticationId: "auth", mechanism: "bearer" } : undefined,
    createRequestId: () => `request-${++requestId}`, createDecisionId: () => `decision-${++decisionId}`,
  });
  const lifecycle = new WorkflowRunLifecycle({ projectRoot: f.projectRoot, projectId: "project", sessionId: "approval-session", snapshotId: "snapshot", rootNodeId: "root", createRunId: () => "approval-run", createArtifactWorkspace: () => current, checkpointSnapshots: service.runSnapshotProvider() });
  lifecycle.recordUserInput({ inputId: "input", text: "review plan", source: "interactive" });
  const lease = new WorkspaceLeaseRuntime({ projectRoot: f.projectRoot, adapterId: "markdown-plan", workspaceId: "approval-plan", sessionId: "approval-session", runId: "approval-run" });
  assert.equal(lease.acquire().ok, true);
  const firstHash = hashArtifactWorkspace(current.path!).workspaceHash;
  const first = await service.requestApproval({ operationId: "request-first", checkpointId: "plan", expectedWorkspaceHash: firstHash });
  const denied = await service.decide({ operationId: "deny-first", requestId: first.requestId, expectedRequestSequence: first.requestSequence, digest: first.digest, expectedWorkspaceHash: firstHash, decision: "denied", feedback: "revise" }, { channel: "dashboard", mode: "headless", dashboardAvailable: true, credential: "human-secret" });
  assert.equal(denied.decision, "denied");
  assert.equal((await service.requestApproval({ operationId: "request-again", checkpointId: "plan", expectedWorkspaceHash: firstHash })).requestId, first.requestId);
  await action(f.adapter, current, "markdown-plan.plan.update", { ...plan, summary: "Revised after human denial." }, "approval-revise");
  const revisedHash = hashArtifactWorkspace(current.path!).workspaceHash;
  const revised = await service.requestApproval({ operationId: "request-revised", checkpointId: "plan", expectedWorkspaceHash: revisedHash });
  assert.notEqual(revised.requestId, first.requestId);
  assert.notEqual(revised.digest, first.digest);
  assert.equal(lease.release(), true);
});

test("combined Markdown lifecycle uses the generic facade, lease, operation, evidence, and completion contracts", async () => {
  const f = fixture("lifecycle"); mkdirSync(join(f.projectRoot, "src")); writeFileSync(join(f.projectRoot, "src", "combined.ts"), "export const combined = true;\n");
  const lifecycle = bindPhysicalArtifactWorkspace({ projectRoot: f.projectRoot, adapter: f.adapter, profile: MARKDOWN_PLAN_PROFILES.lifecycle, runId: "run", configuredBinding: "either", options: {}, selection: { mode: "new", workspaceId: "combined-plan" } });
  await action(f.adapter, lifecycle, "markdown-plan.plan.author", plan, "author-plan");
  const current = live(lifecycle);
  const facade = new ArtifactFacade({ adapter: f.adapter, profile: MARKDOWN_PLAN_PROFILES.lifecycle, binding: current,
    mutationQueue: async (_target, _operationId, callback) => callback(), workspaceAuthority: {
      readHashes: () => hashArtifactWorkspace(current.path!),
      lease: new WorkspaceLeaseRuntime({ projectRoot: f.projectRoot, adapterId: "markdown-plan", workspaceId: "combined-plan", sessionId: "session", runId: "run" }),
      operations: new ArtifactOperationRuntime({ projectRoot: f.projectRoot, projectId: "project", sessionId: "session", runId: "run" }),
    },
  });
  const caller = createRunOrchestrationArtifactCallerIssuer({ payload: { authority: { nodes: [{ nodeId: "root", capabilities: { effective: { artifact: ["read", "review", "write"] } }, tools: ["artifact_action", "artifact_status"] }] } } } as never).issue("root", current);
  const ref = repositoryRef(f.projectRoot, "src/combined.ts");
  await facade.action(caller, { actionId: "markdown-plan.tasks.complete", arguments: { taskId: "deliver", evidenceRefs: [toolRef, ref] }, expectedWorkspaceHash: current.workspaceHash }, { attemptId: "complete", verifyEvidence: (references) => references.map((reference) => {
    if (reference.kind === "tool") return { kind: "tool" as const, attemptId: reference.attemptId, operation: "tool.test", inputHash: "a".repeat(64), resultHash: "b".repeat(64) };
    if (reference.kind !== "repository") throw new Error("command evidence is unused");
    return { kind: "repository" as const, path: reference.path, digest: reference.digest, bytes: readFileSync(join(f.projectRoot, reference.path)).byteLength };
  }) });
  assert.equal((await f.adapter.validateCompletion(live(lifecycle))).state, "satisfied");
  const status = await facade.status(caller, { limit: 20 });
  assert.equal(status.status, "complete");
  assert.deepEqual(status.checkpoints.map((entry) => entry.id), ["plan", "execution", "review"]);
});

test("Markdown facade serializes concurrent writers, rejects stale hashes, and reconciles an applied crash intent", async () => {
  const f = fixture("writer-recovery");
  const value = bindPhysicalArtifactWorkspace({ projectRoot: f.projectRoot, adapter: f.adapter, profile: MARKDOWN_PLAN_PROFILES.lifecycle, runId: "writer-run", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "writer-plan" } });
  const initial = live(value);
  const lease = new WorkspaceLeaseRuntime({ projectRoot: f.projectRoot, adapterId: "markdown-plan", workspaceId: "writer-plan", sessionId: "writer-session", runId: "writer-run" });
  const operations = new ArtifactOperationRuntime({ projectRoot: f.projectRoot, projectId: "project", sessionId: "writer-session", runId: "writer-run" });
  const facade = new ArtifactFacade({ adapter: f.adapter, profile: MARKDOWN_PLAN_PROFILES.lifecycle, binding: initial, mutationQueue: async (_target, _operationId, callback) => callback(), workspaceAuthority: { readHashes: () => hashArtifactWorkspace(initial.path!), lease, operations } });
  const caller = createRunOrchestrationArtifactCallerIssuer({ payload: { authority: { nodes: [{ nodeId: "root", capabilities: { effective: { artifact: ["read", "review", "write"] } }, tools: ["artifact_action", "artifact_status"] }] } } } as never).issue("root", initial);
  await facade.action(caller, { actionId: "markdown-plan.plan.author", arguments: plan, expectedWorkspaceHash: initial.workspaceHash }, { attemptId: "writer-author" });
  const beforeConcurrent = hashArtifactWorkspace(initial.path!).workspaceHash;
  const settled = await Promise.allSettled([
    facade.action(caller, { actionId: "markdown-plan.plan.update", arguments: { ...plan, summary: "Concurrent first." }, expectedWorkspaceHash: beforeConcurrent }, { attemptId: "writer-first" }),
    facade.action(caller, { actionId: "markdown-plan.plan.update", arguments: { ...plan, summary: "Concurrent second." }, expectedWorkspaceHash: beforeConcurrent }, { attemptId: "writer-second" }),
  ]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1);

  const stale = hashArtifactWorkspace(initial.path!).workspaceHash;
  writeFileSync(join(initial.path!, "external.txt"), "external\n");
  await assert.rejects(() => facade.action(caller, { actionId: "markdown-plan.plan.update", arguments: { ...plan, summary: "Must conflict." }, expectedWorkspaceHash: stale }, { attemptId: "writer-stale" }), /hash conflict|changed/i);

  const crashExpected = hashArtifactWorkspace(initial.path!).workspaceHash;
  const crashArguments = { ...plan, summary: "Applied before process crash." };
  operations.begin({ operationId: "writer-crash", actionId: "markdown-plan.plan.update", arguments: crashArguments, expectedWorkspaceHash: crashExpected });
  await action(f.adapter, initial, "markdown-plan.plan.update", crashArguments, "writer-crash");
  assert.deepEqual(facade.recoverUnresolvedOperations().recovered, ["writer-crash"]);
  assert.equal(operations.restore().operations["writer-crash"].reconciliation, "applied");
  assert.equal(lease.release(), true);
});
