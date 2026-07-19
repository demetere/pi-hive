import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOpenSpecAdapter, OPEN_SPEC_PROFILES, type OpenSpecCli } from "../../src/artifacts/adapters/openspec.ts";
import { resolveCheckpointDigest } from "../../src/artifacts/checkpoints.ts";
import { ArtifactFacade } from "../../src/artifacts/facade.ts";
import { hashArtifactWorkspace } from "../../src/artifacts/hashes.ts";
import { createRunOrchestrationArtifactCallerIssuer } from "../../src/artifacts/internal/caller.ts";
import { WorkspaceLeaseRuntime } from "../../src/artifacts/leases.ts";
import { ArtifactOperationRuntime } from "../../src/artifacts/operations.ts";
import { bindPhysicalArtifactWorkspace } from "../../src/artifacts/workspaces.ts";
import type { ArtifactActionContext, ArtifactEvidenceReferenceV1, ArtifactWorkspaceBinding, VerifiedArtifactEvidenceV1 } from "../../src/artifacts/types.ts";

function fixture(label: string) {
  const projectRoot = mkdtempSync(join(tmpdir(), `hive-openspec-e2e-${label}-`));
  mkdirSync(join(projectRoot, "openspec", "changes"), { recursive: true });
  writeFileSync(join(projectRoot, "openspec", "config.yaml"), "schema: spec-driven\n");
  const cli: OpenSpecCli = {
    available: () => true,
    runSync(root, args) { mkdirSync(join(root, "openspec", "changes", args[2])); },
    async runJson(_root, args) {
      if (args[0] === "validate") return { items: [], summary: { totals: { passed: 1, failed: 0 } } };
      return { artifacts: [] };
    },
  };
  return { projectRoot, adapter: createOpenSpecAdapter({ cli, now: () => "2026-01-01T00:00:00.000Z" }) };
}

function live(value: ArtifactWorkspaceBinding): ArtifactWorkspaceBinding {
  return Object.freeze({ ...value, workspaceHash: hashArtifactWorkspace(value.path!).workspaceHash });
}

async function action(adapter: ReturnType<typeof createOpenSpecAdapter>, value: ArtifactWorkspaceBinding, actionId: string, argumentsValue: Record<string, unknown>, operationId: string) {
  const profile = adapter.profiles.find((entry) => entry.id === value.profileId)!;
  const contract = profile.actions.find((entry) => entry.id === actionId)!;
  const current = live(value);
  const enqueueMutation = async <T>(_path: string, callback: () => T | Promise<T>): Promise<T> => callback();
  const verifyEvidence = (references: readonly ArtifactEvidenceReferenceV1[]): readonly VerifiedArtifactEvidenceV1[] => references.map((reference) => {
    if (reference.kind === "tool") return Object.freeze({ kind: "tool", attemptId: reference.attemptId, operation: "tool.test", inputHash: "a".repeat(64), resultHash: "b".repeat(64) });
    if (reference.kind !== "repository") throw new Error("E2E adapter context does not issue command proofs");
    const content = readFileSync(join(fixtureRoot(current), reference.path));
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (digest !== reference.digest) throw new Error("Repository evidence hash is stale");
    return Object.freeze({ kind: "repository" as const, path: reference.path, digest, bytes: content.byteLength });
  });
  const context: ArtifactActionContext = Object.freeze({
    binding: current,
    capabilities: Object.freeze(["read", "write", "review"] as const),
    hashes: hashArtifactWorkspace(current.path!),
    operationId,
    expectedWorkspaceHash: current.workspaceHash,
    enqueueMutation,
    verifyEvidence,
  });
  return adapter.executeAction!(context, contract, argumentsValue as never);
}

function fixtureRoot(value: ArtifactWorkspaceBinding): string { return join(value.path!, "..", "..", ".."); }
function repositoryRef(root: string, path: string) {
  return { kind: "repository" as const, path, digest: `sha256:${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}` };
}
const toolRef = { kind: "tool" as const, attemptId: "tool-test" };

async function plan(adapter: ReturnType<typeof createOpenSpecAdapter>, value: ArtifactWorkspaceBinding): Promise<void> {
  await action(adapter, value, "openspec.artifact.write", { artifactId: "proposal", content: "# Proposal\n\nShip it.\n" }, "op-proposal");
  await action(adapter, value, "openspec.artifact.write", { artifactId: "design", content: "# Design\n\nContained.\n" }, "op-design");
  await action(adapter, value, "openspec.artifact.write", { artifactId: "specs", capabilityId: "delivery", content: "# Delivery requirements\n" }, "op-specs");
  await action(adapter, value, "openspec.artifact.write", { artifactId: "tasks", content: "# Tasks\n\n- [ ] 1.1 Deliver safely\n" }, "op-tasks");
}

test("true author to execute to review split consumes profile-neutral task evidence while checkpoint digests remain profile-bound", async () => {
  const f = fixture("split");
  mkdirSync(join(f.projectRoot, "src"));
  writeFileSync(join(f.projectRoot, "src", "delivery.ts"), "export const delivered = true;\n");
  const author = bindPhysicalArtifactWorkspace({ projectRoot: f.projectRoot, adapter: f.adapter, profile: OPEN_SPEC_PROFILES.author, runId: "author-run", configuredBinding: "new", options: {}, selection: { mode: "new", workspaceId: "split-change" } });
  await plan(f.adapter, author);
  const authorHashes = hashArtifactWorkspace(author.path!);
  const authorTasks = resolveCheckpointDigest(f.adapter.checkpointDescriptor!({ binding: live(author), checkpointId: "tasks", hashes: authorHashes }), authorHashes);
  const tasksReference = { workspaceId: "split-change", checkpoint: "tasks", digest: authorTasks.digest };
  const execute = bindPhysicalArtifactWorkspace({ projectRoot: f.projectRoot, adapter: f.adapter, profile: OPEN_SPEC_PROFILES.execute, runId: "execute-run", configuredBinding: "existing", options: {}, selection: { mode: "existing", workspaceId: "split-change" }, handoffReference: tasksReference });
  assert.equal(execute.workspace.id, "split-change");
  const executeHashes = hashArtifactWorkspace(execute.path!);
  const executeTasks = resolveCheckpointDigest(f.adapter.checkpointDescriptor!({ binding: live(execute), checkpointId: "tasks", hashes: executeHashes }), executeHashes);
  assert.notEqual(executeTasks.digest, authorTasks.digest, "checkpoint approval identities stay bound to their source profile");

  await action(f.adapter, execute, "openspec.tasks.complete", { taskId: "1.1", evidenceRefs: [toolRef, repositoryRef(f.projectRoot, "src/delivery.ts")] }, "execute-complete");
  assert.equal((await f.adapter.validateCompletion(live(execute))).state, "satisfied");
  const implementationHashes = hashArtifactWorkspace(execute.path!);
  const implementation = resolveCheckpointDigest(f.adapter.checkpointDescriptor!({ binding: live(execute), checkpointId: "implementation", hashes: implementationHashes }), implementationHashes);
  const review = bindPhysicalArtifactWorkspace({
    projectRoot: f.projectRoot, adapter: f.adapter, profile: OPEN_SPEC_PROFILES.review, runId: "review-run", configuredBinding: "existing", options: {},
    selection: { mode: "existing", workspaceId: "split-change" }, handoffReference: { workspaceId: "split-change", checkpoint: "implementation", digest: implementation.digest },
  });
  assert.equal(OPEN_SPEC_PROFILES.review.actions.some((candidate) => candidate.id === "openspec.tasks.complete"), false);
  assert.equal((await f.adapter.validateCompletion(live(review))).state, "satisfied", "review validates the current source tasks identity without execute-only completion authority");
  const reviewView = await action(f.adapter, review, "openspec.review.inspect", {}, "review-inspect");
  assert.deepEqual(reviewView.data.completedTaskIds, ["1.1"]);

  writeFileSync(join(author.path!, "tasks.md"), "# Tasks\n\n- [ ] 1.1 Revised\n");
  assert.throws(() => bindPhysicalArtifactWorkspace({ projectRoot: f.projectRoot, adapter: f.adapter, profile: OPEN_SPEC_PROFILES.execute, runId: "stale-run", configuredBinding: "existing", options: {}, selection: { mode: "existing", workspaceId: "split-change" }, handoffReference: tasksReference }), /stale/i);
});

test("combined lifecycle uses the same contract from scaffold through implementation and review view", async () => {
  const f = fixture("combined");
  mkdirSync(join(f.projectRoot, "src"));
  writeFileSync(join(f.projectRoot, "src", "combined.ts"), "export const combined = true;\n");
  const lifecycle = bindPhysicalArtifactWorkspace({ projectRoot: f.projectRoot, adapter: f.adapter, profile: OPEN_SPEC_PROFILES.lifecycle, runId: "lifecycle-run", configuredBinding: "either", options: {}, selection: { mode: "new", workspaceId: "combined-change" } });
  await plan(f.adapter, lifecycle);
  const current = live(lifecycle);
  const facade = new ArtifactFacade({
    adapter: f.adapter,
    profile: OPEN_SPEC_PROFILES.lifecycle,
    binding: current,
    mutationQueue: async (_target, _operationId, callback) => callback(),
    workspaceAuthority: {
      readHashes: () => hashArtifactWorkspace(current.path!),
      lease: new WorkspaceLeaseRuntime({ projectRoot: f.projectRoot, adapterId: "openspec", workspaceId: "combined-change", sessionId: "combined-session", runId: "lifecycle-run" }),
      operations: new ArtifactOperationRuntime({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "combined-session", runId: "lifecycle-run" }),
    },
  });
  const caller = createRunOrchestrationArtifactCallerIssuer({ payload: { authority: { nodes: [{ nodeId: "root", capabilities: { effective: { artifact: ["read", "review", "write"] } }, tools: ["artifact_action", "artifact_status"] }] } } } as never).issue("root", current);
  await facade.action(caller, { actionId: "openspec.tasks.complete", arguments: { taskId: "1.1", evidenceRefs: [toolRef, repositoryRef(f.projectRoot, "src/combined.ts")] }, expectedWorkspaceHash: current.workspaceHash }, { attemptId: "op-complete", verifyEvidence: (references) => references.map((reference) => {
    if (reference.kind === "tool") return { kind: "tool" as const, attemptId: reference.attemptId, operation: "tool.test", inputHash: "a".repeat(64), resultHash: "b".repeat(64) };
    if (reference.kind !== "repository") throw new Error("command evidence is not used by this fixture");
    const content = readFileSync(join(f.projectRoot, reference.path));
    return { kind: "repository" as const, path: reference.path, digest: reference.digest, bytes: content.byteLength };
  }) });
  assert.equal((await f.adapter.validateCompletion(live(lifecycle))).state, "satisfied");
  const status = await f.adapter.status({ binding: live(lifecycle), capabilities: ["read", "write", "review"], hashes: hashArtifactWorkspace(lifecycle.path!) }, { limit: 20 });
  assert.equal(status.status, "complete");
  assert.deepEqual(status.checkpoints.map((entry) => entry.id), ["proposal", "design", "specs", "tasks", "implementation", "review"]);
  assert.ok(status.items.some((entry) => entry.kind === "execution-task" && entry.state === "complete"));
});
