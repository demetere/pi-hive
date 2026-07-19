import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashActivationPayload } from "../../src/config/snapshot-canonical.ts";
import { snapshotFilePath, writeActivationSnapshot } from "../../src/config/snapshot-store.ts";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { readWorkflowJournal } from "../../src/workflows/journal.ts";
import { reloadWorkflowSession, selectWorkflowSession } from "../../src/workflows/navigation.ts";
import { releaseRuntimeOwnership } from "../../src/workflows/ownership.ts";
import {
  detectOrphanedWorkflowSessions,
  recoverOrphanedWorkflowSession,
} from "../../src/workflows/recovery.ts";
import { buildWorkflowSelector } from "../../src/workflows/registry.ts";
import { initializeNormalParent, listSessionLinks, replaceSessionLinks } from "../../src/workflows/sessions.ts";
import { readHandoffState } from "../../src/workflows/handoff.ts";
import { WorkflowRunLifecycle } from "../../src/workflows/runs.ts";

const selectable = (activationHash: string) => ({ workflowId: "build", activationHash, source: "current" as const, resumable: true, freshEnabled: true, model: "provider/model", thinking: "medium", tools: ["write"] });

function recoverySnapshot(identity: { projectId?: string; workflowId?: string } = {}): ActivationSnapshotFileV1 {
  const effective = { filesystem: [], shell: [], git: false, "external-network": false, "human-input": false, artifact: [], knowledge: [] };
  const provenance = { filesystem: ["agent-ceiling", "inherited"], shell: ["agent-ceiling", "inherited"], git: ["agent-ceiling", "inherited"], "external-network": ["agent-ceiling", "inherited"], "human-input": ["agent-ceiling", "inherited"], artifact: ["agent-ceiling", "inherited"], knowledge: ["agent-ceiling", "inherited"] };
  const payload = {
    versions: { snapshot: 1, packageContract: "pi-hive-package-contract-v1", schema: 1, capability: 1, catalogHash: "pi-hive-catalog-hash-v1", artifact: "pi-hive-artifact-contract-v1", contextPolicy: "pi-hive-context-policy-v1", package: "0.1.0" },
    project: { projectId: identity.projectId ?? "project-1", rootRef: "." },
    workflow: { id: identity.workflowId ?? "build", artifact: { adapter: "none", adapterVersion: "1", profile: "default", profileVersion: "1", binding: "none", options: {}, optionsSchemaVersion: "1", contractVersion: "pi-hive-artifact-contract-v1", checkpoints: [], actionIds: [], viewVersion: 1, approvals: {} }, team: { rootId: "root", nodes: [{ id: "root", agentId: "agent", memberIds: [], responsibilities: [], skills: { resolved: [] }, knowledge: { resolved: [] }, budgets: {} }] } },
    agents: [{ id: "agent", name: "Agent", tags: [], frontmatter: {}, prompt: "recover", sourceHash: "a".repeat(64), canonicalSourceHash: "b".repeat(64), promptHash: "c".repeat(64) }],
    skills: [], knowledge: [],
    authority: { capabilityContractVersion: 1, nodes: [{ nodeId: "root", capabilities: { effective, provenance, budgets: {}, attachments: { skills: [], knowledge: [] }, directMemberIds: [] }, tools: ["workflow_finish", "workflow_status"] }] },
    models: [{ nodeId: "root", modelId: "provider/model", thinking: "off", staticTokens: 8192, dynamicReserve: 20000, contextWindow: 100000 }],
    sources: [],
  } as any;
  return { snapshotHash: hashActivationPayload(payload), createdAt: "2026-01-01T00:00:00.000Z", payload };
}

function fixture(snapshot = recoverySnapshot()) {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-reload-"));
  const piRoot = mkdtempSync(join(tmpdir(), "hive-pi-sessions-"));
  const normalFile = join(piRoot, "normal.jsonl");
  writeFileSync(normalFile, "normal\n");
  initializeNormalParent({ configured: true, projectRoot, projectId: "project-1", piSessionId: "normal", piSessionFile: normalFile, model: "provider/normal", thinking: "low", activeTools: ["read"] });
  writeActivationSnapshot(projectRoot, snapshot);
  let next = 0;
  const calls: string[] = [];
  let failCreate = false;
  let activeSessionFile = normalFile;
  const adapter = {
    async create(input: { recovery?: unknown; restoreSession?: string }) {
      calls.push(input.recovery ? "recover-create" : "create");
      if (failCreate) throw new Error("injected create fault");
      next += 1;
      const piSessionFile = join(piRoot, `workflow-${next}.jsonl`);
      writeFileSync(piSessionFile, "workflow\n");
      activeSessionFile = piSessionFile;
      return { piSessionId: `pi-${next}`, piSessionFile, ...(input.restoreSession ? { compensate: () => { calls.push("compensate"); activeSessionFile = input.restoreSession!; } } : {}) };
    },
    async switch(input: { piSessionFile: string; withSession: (ctx: unknown) => Promise<void> | void }) { calls.push(`switch:${input.piSessionFile}`); await input.withSession({}); return { cancelled: false }; },
  };
  return { projectRoot, piRoot, normalFile, adapter, calls, activationHash: snapshot.snapshotHash, snapshot, activeSessionFile: () => activeSessionFile, setFailCreate(value: boolean) { failCreate = value; } };
}

const owner = (nonce: string) => ({ pid: 123, processMarker: `marker-${nonce}`, nonce, verifyDead: () => true });
function runRecoveryProcess(f: ReturnType<typeof fixture>, workflowSessionId: string, suffix: string, crashStage?: string) {
  const candidate = join(f.piRoot, `process-${suffix}.jsonl`);
  const script = `
    import { writeFileSync } from "node:fs";
    import { recoverOrphanedWorkflowSession } from "./src/workflows/recovery.ts";
    const runtime = {
      sourceState: "current",
      model: {
        defaultModel: "provider/model", defaultThinking: "off",
        find: (modelId) => modelId === "provider/model" ? { id: modelId, contextWindow: 100000, thinking: ["off"] } : undefined,
        canActivate: (modelId) => modelId === "provider/model", estimateTokens: (text) => text.length,
      },
      knowledgeAvailable: () => true, workspaceAvailable: () => true,
      artifactProfileAvailable: (adapter, profile) => adapter === "none" && profile === "default",
    };
    const adapter = {
      async create() {
        writeFileSync(${JSON.stringify(candidate)}, "process recovery\\n");
        return { piSessionId: ${JSON.stringify(`process-${suffix}`)}, piSessionFile: ${JSON.stringify(candidate)} };
      },
      async switch({ withSession }) { await withSession({}); return { cancelled: false }; },
    };
    await recoverOrphanedWorkflowSession({
      projectRoot: ${JSON.stringify(f.projectRoot)}, projectId: "project-1", workflowSessionId: ${JSON.stringify(workflowSessionId)},
      adapter, owner: { nonce: ${JSON.stringify(`process-${suffix}`)}, verifyDead: () => true }, runtime,
      restorePiSessionFile: ${JSON.stringify(f.normalFile)},
      ${crashStage ? `recoveryFault: (stage) => { if (stage === ${JSON.stringify(crashStage)}) process.exit(86); },` : ""}
    });
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: process.cwd(), encoding: "utf8" });
  if (result.status === 86 && crashStage === "afterCommitted") {
    unlinkSync(join(f.projectRoot, ".pi", "hive", "sessions", workflowSessionId, "recovery-settlement.lock"));
  }
  return result;
}

const recoveryDependencies = (f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) => ({
  restorePiSessionFile: f.normalFile,
  runtime: {
    sourceState: "current" as const,
    model: {
      defaultModel: "provider/model",
      defaultThinking: "off",
      find: (modelId: string) => modelId === "provider/model" ? { id: modelId, contextWindow: 100_000, thinking: ["off"] } : undefined,
      canActivate: (modelId: string) => modelId === "provider/model",
      estimateTokens: (text: string) => text.length,
    },
    knowledgeAvailable: () => true,
    workspaceAvailable: () => true,
    artifactProfileAvailable: (adapter: string, profile: string) => adapter === "none" && profile === "default",
    ...overrides,
  },
});

async function selected(f: ReturnType<typeof fixture>, nonce = "owner") {
  return selectWorkflowSession({ projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: "normal", workflow: selectable(f.activationHash), adapter: f.adapter, owner: owner(nonce) });
}

test("reload validates a complete fresh activation before archiving and switches only while idle", async () => {
  const f = fixture();
  const original = await selected(f);
  const order: string[] = [];
  const reloaded = await reloadWorkflowSession({
    projectRoot: f.projectRoot,
    projectId: "project-1",
    currentPiSessionId: original.link.piSessionId,
    adapter: f.adapter,
    owner: owner("owner"),
    prepareActivation: async () => {
      order.push("prepared");
      return { workflow: selectable("b".repeat(64)), validateBeforeCommit: () => { order.push("revalidated"); } };
    },
  });
  assert.equal(reloaded.kind, "created");
  assert.deepEqual(order, ["prepared", "revalidated"]);
  const links = listSessionLinks(f.projectRoot).filter((entry) => entry.kind === "workflow");
  assert.equal(links.filter((entry) => entry.status === "current").length, 1);
  assert.equal(links.filter((entry) => entry.status === "archived").length, 1);
  assert.equal(links.find((entry) => entry.status === "current")?.activationHash, "b".repeat(64));
  assert.equal(links.find((entry) => entry.status === "archived")?.workflowSessionId, original.link.workflowSessionId);

  const runtime = new WorkflowRunLifecycle({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: reloaded.link.workflowSessionId, snapshotId: reloaded.link.activationHash, rootNodeId: "root" });
  runtime.recordUserInput({ inputId: "open", text: "active", source: "interactive" });
  let prepared = false;
  await assert.rejects(() => reloadWorkflowSession({
    projectRoot: f.projectRoot, projectId: "project-1", currentPiSessionId: reloaded.link.piSessionId, adapter: f.adapter, owner: owner("owner"),
    prepareActivation: async () => { prepared = true; return { workflow: selectable("c".repeat(64)) }; },
  }), /idle/i);
  assert.equal(prepared, false, "idle preflight runs before expensive activation building");
});

test("reload validation, creation, and source-race faults preserve the current activation", async () => {
  for (const failure of ["prepare", "create", "source-race"] as const) {
    const f = fixture();
    const original = await selected(f);
    if (failure === "create") f.setFailCreate(true);
    await assert.rejects(() => reloadWorkflowSession({
      projectRoot: f.projectRoot,
      projectId: "project-1",
      currentPiSessionId: original.link.piSessionId,
      adapter: f.adapter,
      owner: owner("owner"),
      prepareActivation: async () => {
        if (failure === "prepare") throw new Error("activation invalid");
        return {
          workflow: selectable("b".repeat(64)),
          ...(failure === "source-race" ? { validateBeforeCommit: () => { throw new Error("activation sources changed"); } } : {}),
        };
      },
    }), /invalid|fault|changed/i);
    const current = listSessionLinks(f.projectRoot).filter((entry): entry is Extract<typeof entry, { kind: "workflow" }> => entry.kind === "workflow" && entry.status === "current");
    assert.equal(current.length, 1, failure);
    assert.equal(current[0].workflowSessionId, original.link.workflowSessionId, failure);
    assert.equal(current[0].activationHash, original.link.activationHash, failure);
  }
});

test("reload rechecks run state after async preparation and compensates a post-creation CAS race", async () => {
  const prepareRace = fixture();
  const prepareOriginal = await selected(prepareRace);
  const createsBefore = prepareRace.calls.filter((call) => call === "create").length;
  await assert.rejects(() => reloadWorkflowSession({
    projectRoot: prepareRace.projectRoot, projectId: "project-1", currentPiSessionId: prepareOriginal.link.piSessionId, adapter: prepareRace.adapter, owner: owner("owner"),
    prepareActivation: async () => {
      const runtime = new WorkflowRunLifecycle({ projectRoot: prepareRace.projectRoot, projectId: "project-1", sessionId: prepareOriginal.link.workflowSessionId, snapshotId: prepareOriginal.link.activationHash, rootNodeId: "root" });
      runtime.recordUserInput({ inputId: "prepare-race", text: "run won during prepare", source: "interactive" });
      return { workflow: selectable("b".repeat(64)) };
    },
  }), /run|journal|compare-and-swap/i);
  assert.equal(prepareRace.calls.filter((call) => call === "create").length, createsBefore, "prepare race rejects before Pi session creation");

  const commitRace = fixture();
  const commitOriginal = await selected(commitRace);
  await assert.rejects(() => reloadWorkflowSession({
    projectRoot: commitRace.projectRoot, projectId: "project-1", currentPiSessionId: commitOriginal.link.piSessionId, adapter: commitRace.adapter, owner: owner("owner"),
    prepareActivation: async () => ({
      workflow: selectable("b".repeat(64)),
      validateBeforeCommit: () => {
        const runtime = new WorkflowRunLifecycle({ projectRoot: commitRace.projectRoot, projectId: "project-1", sessionId: commitOriginal.link.workflowSessionId, snapshotId: commitOriginal.link.activationHash, rootNodeId: "root" });
        runtime.recordUserInput({ inputId: "commit-race", text: "run won during create", source: "interactive" });
      },
    }),
  }), /run|journal|compare-and-swap/i);
  const current = listSessionLinks(commitRace.projectRoot).filter((entry): entry is Extract<typeof entry, { kind: "workflow" }> => entry.kind === "workflow" && entry.status === "current");
  assert.deepEqual(current.map((entry) => entry.workflowSessionId), [commitOriginal.link.workflowSessionId]);
  assert.equal(commitRace.activeSessionFile(), commitOriginal.link.piSessionFile, "failed CAS compensates the Pi replacement session");
  assert.equal(commitRace.calls.includes("compensate"), true);
  assert.equal(current.some((entry) => readHandoffState(commitRace.projectRoot, entry.workflowSessionId).staged !== undefined), false);
});

test("missing linked Pi sessions become idempotently orphaned without deleting journal/history", async () => {
  const f = fixture();
  const original = await selected(f);
  const journalBefore = readWorkflowJournal(f.projectRoot, original.link.workflowSessionId).length;
  unlinkSync(original.link.piSessionFile);
  assert.equal(existsSync(original.link.piSessionFile), false);
  const first = detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" });
  const second = detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" });
  assert.deepEqual(first.map((entry) => entry.workflowSessionId), [original.link.workflowSessionId]);
  assert.deepEqual(second.map((entry) => entry.workflowSessionId), [original.link.workflowSessionId]);
  const link = listSessionLinks(f.projectRoot).find((entry) => entry.kind === "workflow" && entry.workflowSessionId === original.link.workflowSessionId);
  assert.equal(link?.kind === "workflow" && link.orphaned, true);
  const orphanEvents = readWorkflowJournal(f.projectRoot, original.link.workflowSessionId).filter((event) => event.type === "session.orphaned");
  assert.equal(orphanEvents.length, 1);
  assert.ok(readWorkflowJournal(f.projectRoot, original.link.workflowSessionId).length > journalBefore);
});

test("recovery refuses a live owner, blocks corrupt/unsupported contracts, then creates an auditable fresh Pi link", async () => {
  const f = fixture();
  const original = await selected(f, "live");
  unlinkSync(original.link.piSessionFile);
  detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" });

  await assert.rejects(() => recoverOrphanedWorkflowSession({
    projectRoot: f.projectRoot, projectId: "project-1", workflowSessionId: original.link.workflowSessionId, adapter: f.adapter, owner: owner("recovery"),
    ...recoveryDependencies(f), validateActivation: () => ({ ok: true, codes: [] }),
  }), /live owner|ownership/i);
  assert.equal(f.calls.includes("recover-create"), false);
  assert.equal(releaseRuntimeOwnership(f.projectRoot, original.link.workflowSessionId, "live"), true);
  unlinkSync(snapshotFilePath(f.projectRoot, f.activationHash));

  await assert.rejects(() => recoverOrphanedWorkflowSession({
    projectRoot: f.projectRoot, projectId: "project-1", workflowSessionId: original.link.workflowSessionId, adapter: f.adapter, owner: owner("corrupt"),
    ...recoveryDependencies(f), validateActivation: () => ({ ok: true, codes: [] }),
  }), /snapshot.*missing|invalid|corrupt/i);
  let blocked = listSessionLinks(f.projectRoot).find((entry) => entry.kind === "workflow" && entry.workflowSessionId === original.link.workflowSessionId);
  assert.equal(blocked?.kind === "workflow" && blocked.recovery?.state, "blocked");
  assert.ok(blocked?.kind === "workflow" && blocked.recovery?.state === "blocked" && blocked.recovery.codes.includes("SNAPSHOT_INVALID"));

  writeActivationSnapshot(f.projectRoot, f.snapshot);
  await assert.rejects(() => recoverOrphanedWorkflowSession({
    projectRoot: f.projectRoot, projectId: "project-1", workflowSessionId: original.link.workflowSessionId, adapter: f.adapter, owner: owner("unsupported"),
    ...recoveryDependencies(f), validateActivation: () => ({ ok: false, codes: ["SNAPSHOT_PACKAGE_CONTRACT_UNSUPPORTED"] }),
  }), /unsupported|blocked/i);
  blocked = listSessionLinks(f.projectRoot).find((entry) => entry.kind === "workflow" && entry.workflowSessionId === original.link.workflowSessionId);
  assert.ok(blocked?.kind === "workflow" && blocked.recovery?.state === "blocked" && blocked.recovery.codes.includes("SNAPSHOT_PACKAGE_CONTRACT_UNSUPPORTED"));

  const recovered = await recoverOrphanedWorkflowSession({
    projectRoot: f.projectRoot, projectId: "project-1", workflowSessionId: original.link.workflowSessionId, adapter: f.adapter, owner: owner("recovered"),
    ...recoveryDependencies(f), validateActivation: () => ({ ok: true, codes: [] }),
  });
  assert.notEqual(recovered.piSessionId, original.link.piSessionId);
  assert.equal(recovered.workflowSessionId, original.link.workflowSessionId);
  assert.equal(recovered.orphaned, false);
  assert.equal(recovered.recovery?.state, "recovered");
  assert.equal(recovered.recovery?.previousPiSessionId, original.link.piSessionId);
  assert.equal(existsSync(original.link.piSessionFile), false, "recovery never fabricates or deletes old transcript paths");
  const recoveredEvent = readWorkflowJournal(f.projectRoot, original.link.workflowSessionId).find((event) => event.type === "session.recovered");
  const recoveryPayload = recoveredEvent?.payload as Record<string, unknown> | undefined;
  assert.equal(recoveryPayload?.previousPiSessionId, original.link.piSessionId);
  assert.equal(recoveryPayload?.piSessionId, recovered.piSessionId);

  unlinkSync(recovered.piSessionFile);
  detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" });
  const orphanEvents = readWorkflowJournal(f.projectRoot, original.link.workflowSessionId).filter((event) => event.type === "session.orphaned");
  assert.equal(orphanEvents.length, 2, "a recovered Pi-link generation receives its own orphan event");
  assert.deepEqual(orphanEvents.map((event) => (event.payload as Record<string, unknown>).piSessionId), [original.link.piSessionId, recovered.piSessionId]);
});

test("recovery creation faults leave the orphan link unchanged and release acquired ownership", async () => {
  const f = fixture();
  const original = await selected(f, "live");
  unlinkSync(original.link.piSessionFile);
  detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" });
  assert.equal(releaseRuntimeOwnership(f.projectRoot, original.link.workflowSessionId, "live"), true);
  f.setFailCreate(true);
  await assert.rejects(() => recoverOrphanedWorkflowSession({
    projectRoot: f.projectRoot, projectId: "project-1", workflowSessionId: original.link.workflowSessionId, adapter: f.adapter, owner: owner("fault"),
    ...recoveryDependencies(f), validateActivation: () => ({ ok: true, codes: [] }),
  }), /injected create fault/);
  const link = listSessionLinks(f.projectRoot).find((entry) => entry.kind === "workflow" && entry.workflowSessionId === original.link.workflowSessionId);
  assert.equal(link?.kind === "workflow" && link.orphaned, true);
  const reacquired = await recoverOrphanedWorkflowSession({
    projectRoot: f.projectRoot, projectId: "project-1", workflowSessionId: original.link.workflowSessionId, adapter: { ...f.adapter, async create() { const path = join(f.piRoot, "retry.jsonl"); writeFileSync(path, "retry\n"); return { piSessionId: "retry", piSessionFile: path }; } }, owner: owner("retry"),
    ...recoveryDependencies(f), validateActivation: () => ({ ok: true, codes: [] }),
  });
  assert.equal(reacquired.piSessionId, "retry");
});

test("mandatory recovery validation rejects identity and runtime incompatibility even when optional policy approves", async () => {
  const unavailableModel = {
    defaultModel: "provider/model", defaultThinking: "off",
    find: () => undefined, canActivate: () => false, estimateTokens: (text: string) => text.length,
  };
  const cases = [
    { label: "project identity", snapshot: recoverySnapshot({ projectId: "different-project" }), overrides: {}, code: "SNAPSHOT_PROJECT_IDENTITY_MISMATCH" },
    { label: "workflow identity", snapshot: recoverySnapshot({ workflowId: "different-workflow" }), overrides: {}, code: "SNAPSHOT_WORKFLOW_IDENTITY_MISMATCH" },
    { label: "model runtime", snapshot: recoverySnapshot(), overrides: { model: unavailableModel }, code: "SNAPSHOT_MODEL_UNAVAILABLE" },
    { label: "artifact adapter", snapshot: recoverySnapshot(), overrides: { artifactProfileAvailable: () => false }, code: "SNAPSHOT_ARTIFACT_CONTRACT_UNSUPPORTED" },
    { label: "workspace", snapshot: recoverySnapshot(), overrides: { workspaceAvailable: () => false }, code: "SNAPSHOT_WORKSPACE_UNAVAILABLE" },
  ];
  for (const entry of cases) {
    const f = fixture(entry.snapshot);
    const original = await selected(f, `live-${entry.label}`);
    unlinkSync(original.link.piSessionFile);
    detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" });
    assert.equal(releaseRuntimeOwnership(f.projectRoot, original.link.workflowSessionId, `live-${entry.label}`), true);
    await assert.rejects(() => recoverOrphanedWorkflowSession({
      projectRoot: f.projectRoot, projectId: "project-1", workflowSessionId: original.link.workflowSessionId,
      adapter: f.adapter, owner: owner(`validate-${entry.label}`), ...recoveryDependencies(f, entry.overrides),
      validateActivation: () => ({ ok: true, codes: [] }),
    }), /unsupported|blocked/i, entry.label);
    const blocked = listSessionLinks(f.projectRoot).find((candidate) => candidate.kind === "workflow" && candidate.workflowSessionId === original.link.workflowSessionId);
    assert.ok(blocked?.kind === "workflow" && blocked.recovery?.state === "blocked" && blocked.recovery.codes.includes(entry.code), entry.label);
    assert.equal(f.calls.includes("recover-create"), false, `${entry.label} blocks before Pi navigation`);
  }
});

test("stale validation cannot replace a concurrently recovered link with blocked state", async () => {
  const f = fixture();
  const original = await selected(f, "live");
  unlinkSync(original.link.piSessionFile);
  detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" });
  assert.equal(releaseRuntimeOwnership(f.projectRoot, original.link.workflowSessionId, "live"), true);

  await assert.rejects(() => recoverOrphanedWorkflowSession({
    projectRoot: f.projectRoot, projectId: "project-1", workflowSessionId: original.link.workflowSessionId,
    adapter: f.adapter, owner: owner("stale-validation"), ...recoveryDependencies(f),
    validateActivation: () => {
      const concurrent = runRecoveryProcess(f, original.link.workflowSessionId, "validation-winner");
      assert.equal(concurrent.status, 0, concurrent.stderr || concurrent.stdout);
      return { ok: false, codes: ["STALE_POLICY_DECISION"] };
    },
  }), /changed before blocked recovery update/i);

  const link = listSessionLinks(f.projectRoot).find((entry) => entry.kind === "workflow" && entry.workflowSessionId === original.link.workflowSessionId);
  assert.ok(link?.kind === "workflow" && link.recovery?.state === "recovered");
  assert.equal(link?.kind === "workflow" && link.piSessionId, "process-validation-winner");
  const staleBlocked = readWorkflowJournal(f.projectRoot, original.link.workflowSessionId)
    .filter((event) => event.type === "session.recovery.blocked")
    .some((event) => (event.payload as Record<string, unknown>).codes instanceof Array && ((event.payload as Record<string, unknown>).codes as unknown[]).includes("STALE_POLICY_DECISION"));
  assert.equal(staleBlocked, false, "the losing validation publishes no blocked authority");
});

test("process restart reconciles every durable recovery crash boundary", async () => {
  for (const stage of ["afterPrepared", "afterLinkPrepared", "afterCommitted"] as const) {
    const f = fixture();
    const original = await selected(f, `live-${stage}`);
    unlinkSync(original.link.piSessionFile);
    detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" });
    assert.equal(releaseRuntimeOwnership(f.projectRoot, original.link.workflowSessionId, `live-${stage}`), true);

    const crashed = runRecoveryProcess(f, original.link.workflowSessionId, stage, stage);
    assert.equal(crashed.status, 86, `${stage}: ${crashed.stderr || crashed.stdout}`);
    const before = listSessionLinks(f.projectRoot).find((entry) => entry.kind === "workflow" && entry.workflowSessionId === original.link.workflowSessionId);
    assert.ok(before?.kind === "workflow" && before.orphaned === true, stage);
    assert.notEqual(before?.kind === "workflow" && before.recovery?.state, "recovered", `${stage} is not recovered authority before restart reconciliation`);

    const preparedBefore = readWorkflowJournal(f.projectRoot, original.link.workflowSessionId).filter((event) => event.type === "session.recovery.prepared");
    assert.equal(preparedBefore.length, 1, stage);
    const detected = detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" });
    assert.deepEqual(detected, [], `${stage} is completed before orphan reporting`);

    const recovered = listSessionLinks(f.projectRoot).find((entry) => entry.kind === "workflow" && entry.workflowSessionId === original.link.workflowSessionId);
    assert.ok(recovered?.kind === "workflow" && recovered.orphaned === false && recovered.recovery?.state === "recovered", stage);
    const events = readWorkflowJournal(f.projectRoot, original.link.workflowSessionId);
    const committed = events.filter((event) => event.type === "session.recovered");
    assert.equal(committed.length, 1, stage);
    assert.equal((committed[0].payload as Record<string, unknown>).preparedEventHash, preparedBefore[0].eventHash, stage);
    assert.equal(recovered?.kind === "workflow" && recovered.recovery?.state === "recovered" && recovered.recovery.eventHash, committed[0].eventHash, stage);
  }
});

test("multiprocess restart reconciliation serializes one commit decision with no rollback event", async () => {
  const f = fixture();
  const original = await selected(f, "live-multiprocess");
  unlinkSync(original.link.piSessionFile);
  detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" });
  assert.equal(releaseRuntimeOwnership(f.projectRoot, original.link.workflowSessionId, "live-multiprocess"), true);

  const crashed = runRecoveryProcess(f, original.link.workflowSessionId, "multiprocess", "afterLinkPrepared");
  assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);
  const prepared = readWorkflowJournal(f.projectRoot, original.link.workflowSessionId).find((event) => event.type === "session.recovery.prepared");
  assert.ok(prepared);

  const lockPath = join(f.projectRoot, ".pi", "hive", "sessions", original.link.workflowSessionId, "recovery-settlement.lock");
  writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
  const script = `
    import { detectOrphanedWorkflowSessions } from "./src/workflows/recovery.ts";
    detectOrphanedWorkflowSessions({ projectRoot: ${JSON.stringify(f.projectRoot)}, projectId: "project-1" });
  `;
  const children = ["one", "two"].map(() => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }));
  const completed = children.map((child) => new Promise<{ code: number | null; output: string }>((resolve) => {
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    child.on("close", (code) => resolve({ code, output }));
  }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(children.every((child) => child.exitCode === null), true, "each process waits for the shared session settlement lock");
  unlinkSync(lockPath);
  for (const result of await Promise.all(completed)) assert.equal(result.code, 0, result.output);

  const link = listSessionLinks(f.projectRoot).find((entry) => entry.kind === "workflow" && entry.workflowSessionId === original.link.workflowSessionId);
  assert.ok(link?.kind === "workflow" && link.recovery?.state === "recovered" && link.orphaned === false);
  const events = readWorkflowJournal(f.projectRoot, original.link.workflowSessionId);
  assert.equal(events.filter((event) => event.type === "session.recovered" && (event.payload as Record<string, unknown>).preparedEventHash === prepared.eventHash).length, 1);
  assert.equal(events.some((event) => event.type === "session.orphaned" && (event.payload as Record<string, unknown>).preparedEventHash === prepared.eventHash && (event.payload as Record<string, unknown>).rolledBack === true), false);
});

test("restart rolls back a prepared recovery whose candidate session was lost", async () => {
  const f = fixture();
  const original = await selected(f, "live-lost-candidate");
  unlinkSync(original.link.piSessionFile);
  detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" });
  assert.equal(releaseRuntimeOwnership(f.projectRoot, original.link.workflowSessionId, "live-lost-candidate"), true);

  const crashed = runRecoveryProcess(f, original.link.workflowSessionId, "lost-candidate", "afterLinkPrepared");
  assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);
  const preparedLink = listSessionLinks(f.projectRoot).find((entry) => entry.kind === "workflow" && entry.workflowSessionId === original.link.workflowSessionId);
  assert.ok(preparedLink?.kind === "workflow" && preparedLink.recovery?.state === "prepared");
  if (preparedLink?.kind === "workflow") unlinkSync(preparedLink.piSessionFile);

  const detected = detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" });
  assert.deepEqual(detected.map((entry) => entry.workflowSessionId), [original.link.workflowSessionId]);
  const rolledBack = listSessionLinks(f.projectRoot).find((entry) => entry.kind === "workflow" && entry.workflowSessionId === original.link.workflowSessionId);
  assert.ok(rolledBack?.kind === "workflow" && rolledBack.orphaned === true && rolledBack.recovery?.state !== "recovered");
  assert.equal(rolledBack?.kind === "workflow" && rolledBack.piSessionId, original.link.piSessionId);
  const events = readWorkflowJournal(f.projectRoot, original.link.workflowSessionId);
  const prepared = events.find((event) => event.type === "session.recovery.prepared");
  assert.ok(prepared);
  assert.ok(events.some((event) => event.type === "session.orphaned" && (event.payload as Record<string, unknown>).preparedEventHash === prepared.eventHash && (event.payload as Record<string, unknown>).rolledBack === true));
  assert.equal(events.some((event) => event.type === "session.recovered" && (event.payload as Record<string, unknown>).preparedEventHash === prepared.eventHash), false);
});

test("restart rollback never overwrites unrelated changes to the prepared link generation", async () => {
  const f = fixture();
  const original = await selected(f, "live-prepared-race");
  unlinkSync(original.link.piSessionFile);
  detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" });
  assert.equal(releaseRuntimeOwnership(f.projectRoot, original.link.workflowSessionId, "live-prepared-race"), true);

  const crashed = runRecoveryProcess(f, original.link.workflowSessionId, "prepared-race", "afterLinkPrepared");
  assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);
  const preparedLink = listSessionLinks(f.projectRoot).find((entry) => entry.kind === "workflow" && entry.workflowSessionId === original.link.workflowSessionId);
  assert.ok(preparedLink?.kind === "workflow" && preparedLink.recovery?.state === "prepared");
  if (preparedLink?.kind !== "workflow") return;
  replaceSessionLinks(f.projectRoot, listSessionLinks(f.projectRoot).map((entry) => entry.kind === "workflow" && entry.workflowSessionId === original.link.workflowSessionId
    ? { ...entry, updatedAt: "2027-02-01T00:00:00.000Z" }
    : entry));
  unlinkSync(preparedLink.piSessionFile);

  assert.throws(() => detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" }), /changed|exact link generation/i);
  const preserved = listSessionLinks(f.projectRoot).find((entry) => entry.kind === "workflow" && entry.workflowSessionId === original.link.workflowSessionId);
  assert.equal(preserved?.kind === "workflow" && preserved.updatedAt, "2027-02-01T00:00:00.000Z");
  assert.equal(preserved?.kind === "workflow" && preserved.piSessionId, preparedLink.piSessionId, "rollback does not restore over the unrelated generation");
  const events = readWorkflowJournal(f.projectRoot, original.link.workflowSessionId);
  const prepared = events.find((event) => event.type === "session.recovery.prepared");
  assert.ok(prepared);
  assert.equal(events.some((event) => event.type === "session.orphaned" && (event.payload as Record<string, unknown>).preparedEventHash === prepared.eventHash && (event.payload as Record<string, unknown>).rolledBack === true), false);
});

test("recovery rollback refuses a concurrently changed complete link generation", async () => {
  const f = fixture();
  const original = await selected(f, "live");
  unlinkSync(original.link.piSessionFile);
  detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" });
  assert.equal(releaseRuntimeOwnership(f.projectRoot, original.link.workflowSessionId, "live"), true);
  const racingAdapter = {
    ...f.adapter,
    async create(input: Parameters<typeof f.adapter.create>[0]) {
      const created = await f.adapter.create(input);
      replaceSessionLinks(f.projectRoot, listSessionLinks(f.projectRoot).map((entry) => entry.kind === "workflow" && entry.workflowSessionId === original.link.workflowSessionId
        ? { ...entry, updatedAt: "2027-01-01T00:00:00.000Z" }
        : entry));
      return created;
    },
  };
  await assert.rejects(() => recoverOrphanedWorkflowSession({
    projectRoot: f.projectRoot, projectId: "project-1", workflowSessionId: original.link.workflowSessionId,
    adapter: racingAdapter, owner: owner("race"), ...recoveryDependencies(f),
  }), /compensation was incomplete/i);
  const link = listSessionLinks(f.projectRoot).find((entry) => entry.kind === "workflow" && entry.workflowSessionId === original.link.workflowSessionId);
  assert.ok(link?.kind === "workflow" && link.orphaned === true);
  assert.equal(link?.kind === "workflow" && link.piSessionId, original.link.piSessionId);
  assert.equal(link?.kind === "workflow" && link.updatedAt, "2027-01-01T00:00:00.000Z", "rollback never overwrites an unrelated complete-generation change");
  assert.equal(f.activeSessionFile(), f.normalFile, "failed link CAS restores the previously active Pi session");
  const events = readWorkflowJournal(f.projectRoot, original.link.workflowSessionId);
  const prepared = events.find((event) => event.type === "session.recovery.prepared");
  assert.ok(prepared);
  assert.equal(events.some((event) => event.type === "session.recovered" && (event.payload as Record<string, unknown>).preparedEventHash === prepared.eventHash), false);
  assert.equal(events.some((event) => event.type === "session.orphaned" && (event.payload as Record<string, unknown>).preparedEventHash === prepared.eventHash), false, "an unverified generation publishes no rollback claim");
});

test("a published recovery commit wins an after-rename fault without a contradictory rollback", async () => {
  const f = fixture();
  const original = await selected(f, "live");
  unlinkSync(original.link.piSessionFile);
  detectOrphanedWorkflowSessions({ projectRoot: f.projectRoot, projectId: "project-1" });
  assert.equal(releaseRuntimeOwnership(f.projectRoot, original.link.workflowSessionId, "live"), true);
  const recoveredLink = await recoverOrphanedWorkflowSession({
    projectRoot: f.projectRoot, projectId: "project-1", workflowSessionId: original.link.workflowSessionId,
    adapter: f.adapter, owner: owner("journal-fault"), ...recoveryDependencies(f),
    journalFault: (stage) => { if (stage === "afterRename") throw new Error("injected after-publish fault"); },
  });
  assert.ok(recoveredLink.orphaned === false && recoveredLink.recovery?.state === "recovered");
  assert.equal(f.activeSessionFile(), recoveredLink.piSessionFile);
  const events = readWorkflowJournal(f.projectRoot, original.link.workflowSessionId);
  const prepared = events.find((event) => event.type === "session.recovery.prepared");
  assert.ok(prepared);
  assert.equal(events.filter((event) => event.type === "session.recovered" && (event.payload as Record<string, unknown>).preparedEventHash === prepared.eventHash).length, 1);
  assert.equal(events.some((event) => event.type === "session.orphaned" && (event.payload as Record<string, unknown>).preparedEventHash === prepared.eventHash && (event.payload as Record<string, unknown>).rolledBack === true), false);
});

test("selector status carries staged/source/archive/orphan/recovery metadata while suggested-next remains inert", () => {
  const rows = buildWorkflowSelector([{
    workflowId: "build", name: "Build", source: "stale", resumable: true, freshEnabled: false, diagnostics: ["source changed"],
    stagedHandoff: { packetHash: "a".repeat(64), sourceWorkflowId: "plan", sourceRunId: "run-1" },
    currentSessionState: "orphaned", archiveCount: 2, recoveryState: "blocked", suggestedNext: ["review"],
  }]);
  assert.equal(rows[0].sourceStale, true);
  assert.equal(rows[0].currentSessionState, "orphaned");
  assert.equal(rows[0].archiveCount, 2);
  assert.equal(rows[0].recoveryState, "blocked");
  assert.equal(rows[0].stagedHandoff?.sourceRunId, "run-1");
  assert.equal(JSON.stringify(rows).includes("suggestedNext"), false);
  assert.equal(JSON.stringify(rows).includes("review"), false, "suggested-next is presentation input only and never an invocation edge");
});
