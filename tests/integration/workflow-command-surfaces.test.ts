import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import hiveExtension, { registerLinkedWorkflowCommandSurfaces, WORKFLOW_UI_REFRESH_BOUNDARIES } from "../../index";
import { CheckpointApprovalService } from "../../src/artifacts/approvals";
import { hashArtifactWorkspace } from "../../src/artifacts/hashes";
import { WorkspaceLeaseRuntime } from "../../src/artifacts/leases";
import { BUILTIN_ARTIFACT_REGISTRY } from "../../src/artifacts/registry";
import { readActivationSnapshot } from "../../src/config/index";
import { resolveProjectIdentity } from "../../src/shared/project-identity";
import { acknowledgeSessionReplacementStart, observeSessionReplacementStart } from "../../src/integration/session-replacement-acknowledgement";
import { createLinkedWorkflowCommandServices, createPiWorkflowRuntimeCommandAuthority } from "../../src/integration/workflow-command-service";
import { durablyFlushPiSessionManager } from "../../src/integration/pi-session-manager-compat";
import { registerWorkflowCommands, type WorkflowCommandServices } from "../../src/integration/workflow-commands";
import { publishSessionContext } from "../../src/integration/session-context";
import { createWorkflowEvent } from "../../src/workflows/events";
import { createHandoffPacket, readHandoffState } from "../../src/workflows/handoff";
import { appendWorkflowEvent, readWorkflowJournal } from "../../src/workflows/journal";
import { QuestionService } from "../../src/workflows/questions";
import { terminalEnvelopeFromEvent, WorkflowRunLifecycle } from "../../src/workflows/runs";
import { RunOrchestrationService } from "../../src/workflows/orchestration";
import { initializeNormalParent, markMissingPiSession, listSessionLinks, workflowLinkGenerationHash, type WorkflowSessionLink } from "../../src/workflows/sessions";
import { FakePiSessionManager } from "../helpers/fake-pi-session-manager";

function persistedFakePiSessionManager(projectRoot: string, sessionRoot: string, id: string): FakePiSessionManager {
  const manager = FakePiSessionManager.create(projectRoot, sessionRoot);
  manager.newSession({ id });
  manager.appendCustomEntry("test-anchor", { formatVersion: 1 });
  durablyFlushPiSessionManager(manager as never);
  return manager;
}

function harness(overrides: Partial<WorkflowCommandServices> = {}, onSettled?: (ctx: any) => void) {
  const commands = new Map<string, any>();
  const calls: Array<[string, unknown]> = [];
  const pi = { registerCommand(name: string, value: unknown) { commands.set(name, value); } } as any;
  const services: WorkflowCommandServices = {
    configured: true,
    listWorkflows: async () => [{ workflowId: "build", name: "Build", description: "Build safely", useWhen: "implementation", avoidWhen: "requirements unclear", tags: ["delivery"], adapter: "none", profile: "default", activationHash: "a".repeat(64), source: "current", archivedLinks: [], state: "available", resumable: false, selectable: true, diagnostics: [] }],
    select: async (input) => { calls.push(["select", input]); return "Selected build"; },
    status: async () => "Workflow build · idle",
    exit: async () => "Returned to normal chat",
    cancel: async (reason) => { calls.push(["cancel", reason]); return "Cancellation requested"; },
    reload: async () => "Reloaded workflow",
    checkpoints: async (input) => { calls.push(["checkpoints", input]); return "No checkpoints"; },
    readQuestion: async () => ({ definition: { prompt: "Continue?", kind: "confirm", required: true } }),
    answer: async (input) => { calls.push(["answer", input]); return "Answer recorded"; },
    clearHandoff: async () => "Handoff cleared",
    recover: async (id) => { calls.push(["recover", id]); return "Recovered"; },
    ...overrides,
  };
  registerWorkflowCommands(pi, services, onSettled);
  return { commands, calls };
}

function context(mode: "tui" | "print" = "print") {
  const notices: Array<[string, string]> = [];
  return {
    ctx: { mode, hasUI: mode === "tui", ui: { notify(text: string, severity: string) { notices.push([text, severity]); } } } as any,
    notices,
  };
}

test("widget refresh is bounded to existing Pi lifecycle boundaries and local command settlement", () => {
  assert.deepEqual(WORKFLOW_UI_REFRESH_BOUNDARIES, ["session_start", "input", "message_end", "turn_end", "command-settled"]);
});

test("actual schema-v1 index wiring has unique commands, no mode-cycle shortcut, and no legacy widget in normal chat", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-index-schema-v1-"));
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  cpSync(join(process.cwd(), "tests/fixtures/workflow-configs/artifact-free-debug/.pi/hive"), join(projectRoot, ".pi/hive"), { recursive: true });
  const previousCwd = process.cwd();
  const commands = new Map<string, unknown>();
  const hooks = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
  const shortcuts: unknown[] = [];
  const widgets: Array<readonly [string, unknown]> = [];
  const statuses: Array<readonly [string, unknown]> = [];
  const sessionFile = join(projectRoot, "normal.jsonl");
  writeFileSync(sessionFile, "normal\n");
  const pi: any = {
    registerTool() {},
    registerCommand(name: string, value: unknown) {
      assert.equal(commands.has(name), false, `duplicate command registration: ${name}`);
      commands.set(name, value);
    },
    registerShortcut(...input: unknown[]) { shortcuts.push(input); },
    on(name: string, handler: (event: unknown, ctx: any) => unknown) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    getActiveTools: () => ["read"], getAllTools: () => [{ name: "read" }], setActiveTools() {}, getThinkingLevel: () => "medium",
  };
  const ctx: any = {
    cwd: projectRoot, mode: "tui", hasUI: true, model: { provider: "provider", id: "model" }, modelRegistry: {},
    sessionManager: { getSessionId: () => "normal-pi", getSessionFile: () => sessionFile },
    ui: {
      setWidget: (id: string, value: unknown) => widgets.push([id, value]),
      setStatus: (id: string, value: unknown) => statuses.push([id, value]),
      setHeader() {}, setWorkingVisible() {}, notify() {},
    },
  };
  try {
    process.chdir(projectRoot);
    await hiveExtension(pi);
    for (const handler of hooks.get("session_start") ?? []) await handler({}, ctx);
  } finally {
    process.chdir(previousCwd);
  }
  const workflowCommands = ["hive:answer", "hive:cancel", "hive:checkpoints", "hive:doctor", "hive:exit", "hive:handoff-clear", "hive:observe", "hive:observe-prune", "hive:observe-stop", "hive:recover", "hive:reload", "hive:select", "hive:status"];
  assert.deepEqual([...commands.keys()].sort(), workflowCommands.sort());
  assert.equal(shortcuts.length, 0);
  assert.equal(widgets.some(([id]) => id === "hive-tree"), false);
  assert.equal(statuses.some(([id]) => id === "hive"), false);
  assert.equal(widgets.some(([, value]) => value !== undefined), false, "normal chat renders no workflow widget");
});

test("pre-1.0 config fails before any partial registration or telemetry mutation", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-index-legacy-"));
  mkdirSync(join(projectRoot, ".pi/hive"), { recursive: true });
  writeFileSync(join(projectRoot, ".pi/hive/hive-config.yaml"), "planning:\n  main: legacy-planner\nhive:\n  main: legacy-builder\n");
  const previousCwd = process.cwd(); const registrations: string[] = [];
  const pi: any = { registerTool() { registrations.push("tool"); }, registerCommand() { registrations.push("command"); }, registerShortcut() { registrations.push("shortcut"); }, on() { registrations.push("hook"); } };
  try { process.chdir(projectRoot); await assert.rejects(() => hiveExtension(pi), /schema-v1.*Manual migration.*SCHEMA_VERSION_MISSING/i); }
  finally { process.chdir(previousCwd); }
  assert.deepEqual(registrations, []);
  assert.equal(existsSync(join(projectRoot, ".pi/hive/sessions")), false);
});

test("index production wiring constructs real linked services and runtime command authority", async () => {
  const commands = new Map<string, unknown>();
  const pi = { registerCommand(name: string, value: unknown) { commands.set(name, value); } } as any;
  let refreshes = 0;
  await registerLinkedWorkflowCommandSurfaces(pi, "/project", "project-1", () => { refreshes += 1; });
  assert.deepEqual([...commands.keys()].sort(), ["hive:answer", "hive:cancel", "hive:checkpoints", "hive:doctor", "hive:exit", "hive:handoff-clear", "hive:observe", "hive:observe-prune", "hive:observe-stop", "hive:recover", "hive:reload", "hive:select", "hive:status"].sort());
  const notices: string[] = [];
  await (commands.get("hive:status") as any).handler("", { mode: "print", hasUI: false, sessionManager: { getSessionId: () => "normal" } });
  assert.equal(refreshes, 1);
  assert.equal(notices.length, 0);
});

test("real linked production services register every exact operation with bound runtime authority", () => {
  const commands = new Map<string, unknown>();
  const pi = { registerCommand(name: string, value: unknown) { commands.set(name, value); } } as any;
  const services = createLinkedWorkflowCommandServices(pi, "/project", "project-1", createPiWorkflowRuntimeCommandAuthority());
  registerWorkflowCommands(pi, services);
  assert.deepEqual([...commands.keys()].sort(), ["hive:answer", "hive:cancel", "hive:checkpoints", "hive:doctor", "hive:exit", "hive:handoff-clear", "hive:observe", "hive:observe-prune", "hive:observe-stop", "hive:recover", "hive:reload", "hive:select", "hive:status"].sort());
});

test("real index wiring executes select, status, checkpoints, answer, cancel, exit, and recover with valid Pi context", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-command-production-"));
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  cpSync(join(process.cwd(), "tests/fixtures/workflow-configs/artifact-free-debug/.pi/hive"), join(projectRoot, ".pi/hive"), { recursive: true });
  const workflowPath = join(projectRoot, ".pi/hive/workflows/debug-chat.yaml");
  writeFileSync(workflowPath, readFileSync(workflowPath, "utf8")
    .replace("  adapter: none\n  profile: default\n  binding: none\n  options: {}", "  adapter: markdown-plan\n  profile: author\n  binding: new\n  options: {}")
    .replace("\nteam:\n", "\napprovals:\n  plan: optional\n\nteam:\n")
    .replace("  agent: debugger\n\ninstructions:", "  agent: debugger\n  members:\n    - id: worker\n      agent: debugger\n\ninstructions:"));
  const agentPath = join(projectRoot, ".pi/hive/agents/debugger.md");
  writeFileSync(agentPath, readFileSync(agentPath, "utf8").replace("  human-input: true", "  human-input: true\n  artifact: [read, write, review]"));
  const sessionRoot = join(projectRoot, "pi-sessions"); mkdirSync(sessionRoot);
  let sessionManager = persistedFakePiSessionManager(projectRoot, sessionRoot, "normal");
  let sessionId = sessionManager.getSessionId(); let sessionFile = sessionManager.getSessionFile()!;
  const notices: Array<[string, string]> = [];
  const model = { provider: "provider", id: "model", contextWindow: 2_000_000, maxTokens: 16_384, reasoning: true };
  let created = 0;
  const ctx: any = {
    mode: "print", hasUI: true, cwd: projectRoot, sessionManager, model,
    modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
    isProjectTrusted: () => true, isIdle: () => true, abort() {}, waitForIdle: async () => {},
    ui: { notify: (text: string, severity: string) => notices.push([text, severity]) },
    async newSession(input: any) {
      sessionManager = FakePiSessionManager.create(projectRoot, sessionRoot);
      sessionManager.newSession({ id: `workflow-pi-${++created}` });
      sessionId = sessionManager.getSessionId(); sessionFile = sessionManager.getSessionFile()!;
      ctx.sessionManager = sessionManager;
      await input.setup?.(sessionManager);
      const fresh = { ...ctx, sessionManager };
      await input.withSession?.(fresh);
      return { cancelled: false };
    },
    async switchSession(target: string, input: any) {
      sessionManager = FakePiSessionManager.open(target);
      sessionFile = sessionManager.getSessionFile()!; sessionId = sessionManager.getSessionId();
      ctx.sessionManager = sessionManager;
      const fresh = { ...ctx, sessionManager };
      const selected = listSessionLinks(projectRoot).find((link): link is WorkflowSessionLink => link.kind === "workflow" && link.piSessionId === sessionId);
      observeSessionReplacementStart(projectRoot, projectId, fresh);
      if (selected) acknowledgeSessionReplacementStart(projectRoot, projectId, fresh, { workflowSessionId: selected.workflowSessionId, linkGenerationHash: workflowLinkGenerationHash(selected) });
      publishSessionContext(fresh);
      await input.withSession?.(fresh); return { cancelled: false };
    },
    async reload() {
      const selected = listSessionLinks(projectRoot).find((link): link is WorkflowSessionLink => link.kind === "workflow" && link.piSessionId === sessionId);
      observeSessionReplacementStart(projectRoot, projectId, ctx);
      if (selected) acknowledgeSessionReplacementStart(projectRoot, projectId, ctx, { workflowSessionId: selected.workflowSessionId, linkGenerationHash: workflowLinkGenerationHash(selected) });
      publishSessionContext(ctx);
    },
  };
  const commands = new Map<string, any>();
  const pi: any = { getThinkingLevel: () => "medium", registerCommand(name: string, value: unknown) { commands.set(name, value); } };
  const projectId = resolveProjectIdentity(projectRoot).projectId;
  initializeNormalParent({ configured: true, projectRoot, projectId, piSessionId: "normal", piSessionFile: sessionFile, model: "provider/model", thinking: "medium", activeTools: [] });
  await registerLinkedWorkflowCommandSurfaces(pi, projectRoot, projectId);
  assert.deepEqual([...commands.keys()].sort(), ["hive:answer", "hive:cancel", "hive:checkpoints", "hive:doctor", "hive:exit", "hive:handoff-clear", "hive:observe", "hive:observe-prune", "hive:observe-stop", "hive:recover", "hive:reload", "hive:select", "hive:status"].sort());
  const services = createLinkedWorkflowCommandServices(pi, projectRoot, projectId, createPiWorkflowRuntimeCommandAuthority());
  await commands.get("hive:status").handler("", ctx);
  const normalStatus = notices.at(-1)?.[0] ?? "";
  assert.match(normalStatus, /^Normal chat normal/u);
  assert.match(normalStatus, /Linked workflows: none/u);
  assert.doesNotMatch(normalStatus, /No workflow session is selected/u);

  const rows = await services.listWorkflows(ctx);
  assert.ok(rows.length > 0);
  assert.ok(rows[0].activationHash && rows[0].source === "current");
  assert.deepEqual(rows[0].archivedLinks, []);
  await commands.get("hive:select").handler(rows[0].workflowId, ctx);
  const selected = listSessionLinks(projectRoot).find((link): link is WorkflowSessionLink => link.kind === "workflow" && link.piSessionId === sessionId)!;
  await commands.get("hive:status").handler("", ctx);
  await commands.get("hive:checkpoints").handler("", ctx);
  assert.match(notices.map(([text]) => text).join("\n"), new RegExp(selected.activationHash.slice(0, 12), "u"));
  const idleStatus = await services.status(ctx);
  for (const expected of ["Workflow debug-chat", `session ${selected.workflowSessionId} (current)`, "idle", "workers 0", "approvals 0", "workspace none", "budget idle", "handoff none", "questions 0"]) assert.ok(idleStatus.includes(expected), `idle status includes ${expected}`);
  assert.match(await services.checkpoints!(undefined, ctx), /revision 0/i);
  const initialCheckpoint = (await services.checkpointActions!(ctx)).find((entry) => entry.checkpointId === "plan")!;
  assert.equal(initialCheckpoint.policy, "optional");
  await commands.get("hive:checkpoints").handler("plan off", ctx);
  assert.equal((await services.checkpointActions!(ctx)).find((entry) => entry.checkpointId === "plan")?.enabled, false, "headless syntax reads the current revision inside the service");
  const disabledCheckpoint = (await services.checkpointActions!(ctx)).find((entry) => entry.checkpointId === "plan")!;
  const beforeStaleCheckpoint = readWorkflowJournal(projectRoot, selected.workflowSessionId).length;
  await assert.rejects(() => services.checkpoints!({ checkpointId: "plan", enabled: true, expectedDefaultsRevision: initialCheckpoint.defaultsRevision }, ctx), /revision|CAS|stale/i);
  assert.equal(readWorkflowJournal(projectRoot, selected.workflowSessionId).length, beforeStaleCheckpoint, "stale command CAS has no partial write");
  await services.checkpoints!({ checkpointId: "plan", enabled: true, expectedDefaultsRevision: disabledCheckpoint.defaultsRevision }, ctx);

  const snapshot = readActivationSnapshot(projectRoot, selected.activationHash);
  const artifact = (snapshot.payload.workflow as any).artifact;
  const resolvedArtifact = BUILTIN_ARTIFACT_REGISTRY.resolveProfile({ contractVersion: artifact.contractVersion, adapterId: artifact.adapter, adapterVersion: artifact.adapterVersion, profileId: artifact.profile, profileVersion: artifact.profileVersion });
  const checkpointService = new CheckpointApprovalService({
    projectRoot, projectId, sessionId: selected.workflowSessionId, adapterId: resolvedArtifact.adapter.id, adapterVersion: resolvedArtifact.adapter.version,
    profileId: resolvedArtifact.profile.id, profileVersion: resolvedArtifact.profile.version, profileSchemaVersion: resolvedArtifact.profile.optionsSchemaVersion,
    checkpointPolicies: { plan: "optional" }, resolveDescriptor: ({ checkpointId, binding }) => resolvedArtifact.adapter.checkpointDescriptor!({ checkpointId, binding, hashes: hashArtifactWorkspace(binding.path!) }), authenticateControl: () => undefined,
  });
  const idleJournalLength = readWorkflowJournal(projectRoot, selected.workflowSessionId).length;
  await assert.rejects(() => services.cancel!("idle cancellation", ctx), /open run/i);
  await assert.rejects(() => services.recover!(selected.workflowSessionId, ctx), /orphan/i);
  assert.equal(readWorkflowJournal(projectRoot, selected.workflowSessionId).length, idleJournalLength, "idle cancel and non-orphan recovery have no partial write");

  const rootId = String((snapshot.payload.workflow.team as { rootId: string }).rootId);
  const runtimeOwnerPath = join(projectRoot, ".pi", "hive", "sessions", selected.workflowSessionId, "runtime-owner.json");
  const runtimeOwnerNonce = String(JSON.parse(readFileSync(runtimeOwnerPath, "utf8")).ownerNonce);
  let workerStarted!: () => void;
  const activeWorkerStarted = new Promise<void>((resolve) => { workerStarted = resolve; });
  let failCancellationRelease = true;
  const orchestration = new RunOrchestrationService({
    projectRoot, projectId, sessionId: selected.workflowSessionId, snapshot, runtimeOwnerNonce, maxParallel: 1,
    createRunId: () => "production-command-run", createTaskId: () => "production-command-task", createAttemptId: () => "production-command-attempt",
    artifactRuntime: resolvedArtifact,
    workerFactory: async () => ({ linkedSessionId: "production-command-worker", async prompt(_text, signal) {
      workerStarted();
      if (!signal) throw new Error("production command worker signal is required");
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("production command worker aborted")), { once: true }));
      return "unreachable";
    }, dispose() {} }),
    pauseAuthority: { captureState: () => ({}), releaseLeases: () => {}, releaseOwnership: () => {} },
    resumeAuthority: { acquireOwnership: () => {}, acquireLeases: () => {}, revalidateHashes: () => true, rollbackAuthority: () => {} },
    cancellationAuthority: { terminateProcessTrees: () => {}, capturePartialState: () => ({ productionCommand: true }), releaseLeases: () => { if (failCancellationRelease) { failCancellationRelease = false; throw new Error("simulated cancellation release crash"); } } },
  });
  const lifecycle = orchestration.lifecycle;
  lifecycle.recordUserInput({ inputId: "command-open", text: "open run", source: "interactive" });
  const runId = lifecycle.restore().latestRun!.runId;
  const binding = orchestration.bindArtifactWorkspace({ mode: "new", workspaceId: "command-integration" });
  const workspacePath = binding.path!;
  writeFileSync(join(workspacePath, "plan.md"), "---\nschema-version: 1\nplan-id: command-integration\ntitle: \"Production command integration\"\nrevision: 1\nlast-operation-id: production-command\n---\n\n# Summary\n\nIntegration plan.\n\n# Tasks\n\n- [ ] verify: Verify command integration\n");
  const lease = new WorkspaceLeaseRuntime({ projectRoot, adapterId: resolvedArtifact.adapter.id, workspaceId: "command-integration", sessionId: selected.workflowSessionId, runId, ownerNonce: runtimeOwnerNonce });
  assert.equal(lease.acquire().ok, true);
  const protectedLease = new WorkspaceLeaseRuntime({ projectRoot, adapterId: resolvedArtifact.adapter.id, workspaceId: "protected-other-run", sessionId: "other-session", runId: "other-run", ownerNonce: "other-owner" });
  assert.equal(protectedLease.acquire().ok, true);
  const request = await checkpointService.requestApproval({ operationId: "production-command-request", checkpointId: "plan", expectedWorkspaceHash: hashArtifactWorkspace(workspacePath).workspaceHash });
  const approval = (await services.approvalActions!(ctx)).find((entry) => entry.requestId === request.requestId)!;
  assert.equal(approval.digest, request.digest);
  const openStatus = await services.status(ctx);
  for (const expected of ["waiting_for_human run production-command-run", "workers 0", "approvals 1", "workspace command-integration", "budget tokens 0/"]) assert.match(openStatus, new RegExp(expected, "u"));
  const beforeApprovalConflict = readWorkflowJournal(projectRoot, selected.workflowSessionId).length;
  ctx.mode = "tui";
  await assert.rejects(() => services.decideApproval!({ requestId: approval.requestId, expectedRequestSequence: approval.requestSequence + 1, digest: approval.digest, expectedWorkspaceHash: approval.workspaceHash, decision: "approved" }, ctx), /sequence|CAS|stale/i);
  assert.equal(readWorkflowJournal(projectRoot, selected.workflowSessionId).length, beforeApprovalConflict, "approval CAS conflict has no partial decision");
  await services.decideApproval!({ requestId: approval.requestId, expectedRequestSequence: approval.requestSequence, digest: approval.digest, expectedWorkspaceHash: approval.workspaceHash, decision: "approved" }, ctx);
  ctx.mode = "print";
  assert.equal(checkpointService.restore().requests[request.requestId].decision?.decision, "approved");
  const beforeInvalid = readWorkflowJournal(projectRoot, selected.workflowSessionId).length;
  await assert.rejects(() => services.checkpoints!({ checkpointId: "missing", enabled: false, expectedDefaultsRevision: 0 }, ctx), /idle|optional|checkpoint/i);
  assert.equal(readWorkflowJournal(projectRoot, selected.workflowSessionId).length, beforeInvalid, "invalid checkpoint command has no partial write");
  const questionService = new QuestionService({ projectRoot, projectId, sessionId: selected.workflowSessionId, runId: lifecycle.restore().latestRun!.runId, snapshot, authenticateControl: () => undefined });
  const question = questionService.create({ nodeId: rootId, definition: { prompt: "Continue production command test?", kind: "confirm", required: true }, provenance: { source: "human_question", toolCallId: "production-command-question" } });
  const waitingStatus = await services.status(ctx);
  assert.match(waitingStatus, /questions 1/u);
  assert.doesNotMatch(waitingStatus, /Continue production command test/u, "status never leaks raw question prompts");
  await commands.get("hive:answer").handler(`${question.questionId} yes`, ctx);
  assert.equal(questionService.restore().questions[question.questionId].state, "answered");
  if (lifecycle.restore().latestRun?.status === "waiting_for_human") lifecycle.transitionFromWaitingForHuman("production command answer ready");
  orchestration.rootServices().delegate({ targetNodeId: "worker", objective: "hold active cancellation worker", deliverables: ["settlement"] });
  const workers = orchestration.runWorkers().catch((error: unknown) => {
    assert.match(String(error instanceof Error ? error.message : error), /cancel|pause|closed|settle/i);
  });
  await activeWorkerStarted;
  assert.equal(orchestration.activeWorkerCount(), 1);
  await commands.get("hive:cancel").handler("operator stop", ctx);
  assert.equal(lifecycle.restore().latestRun?.status === "cancelled", false, "release crash must remain honestly retryable");
  assert.equal(lifecycle.restore().latestRun?.cancellationRequested, true);
  assert.equal(lease.inspect().state, "available", "the exact run lease release is idempotent across cancellation retry");
  assert.equal(protectedLease.inspect().state, "owned", "cancellation cannot release another run's workspace lease");
  await commands.get("hive:cancel").handler("operator stop retry", ctx);
  await workers;
  assert.equal(lifecycle.restore().latestRun?.status, "cancelled");
  assert.equal(orchestration.activeWorkerCount(), 0);
  const successorLease = new WorkspaceLeaseRuntime({ projectRoot, adapterId: resolvedArtifact.adapter.id, workspaceId: "command-integration", sessionId: "successor-session", runId: "successor-run", ownerNonce: "successor-owner" });
  assert.equal(successorLease.acquire().ok, true, "subsequent work acquires immediately after cancellation");
  assert.equal(successorLease.release(), true);
  assert.equal(protectedLease.release(), true);
  const restoredServices = createLinkedWorkflowCommandServices(pi, projectRoot, projectId, createPiWorkflowRuntimeCommandAuthority());
  const restoredStatus = await restoredServices.status(ctx);
  assert.match(restoredStatus, /cancelled run production-command-run/u);
  assert.match(restoredStatus, /workers 1 \(queued 0, active 0, suspended 0, terminal 1\)/u);
  assert.match(restoredStatus, /approvals 0/u);
  const terminalEvent = [...readWorkflowJournal(projectRoot, selected.workflowSessionId)].reverse().find((event) => event.type === "terminal.recorded")!;
  const packet = createHandoffPacket({ projectId, workflowId: selected.workflowId, sessionId: selected.workflowSessionId, terminal: terminalEnvelopeFromEvent(terminalEvent), createdAt: terminalEvent.timestamp });
  appendWorkflowEvent(projectRoot, createWorkflowEvent({ projectId, sessionId: selected.workflowSessionId, type: "handoff.recorded", producer: "harness", payload: { formatVersion: 1, operation: "stage", targetWorkflowId: selected.workflowId, packet: packet as any } }));
  assert.equal(readHandoffState(projectRoot, selected.workflowSessionId).staged?.packetHash, packet.packetHash);
  await commands.get("hive:handoff-clear").handler("", ctx);
  assert.equal(readHandoffState(projectRoot, selected.workflowSessionId).staged, undefined);
  await commands.get("hive:exit").handler("", ctx);
  await commands.get("hive:status").handler("", ctx);
  const linkedNormalStatus = notices.at(-1)?.[0] ?? "";
  assert.match(linkedNormalStatus, /^Normal chat normal/u);
  assert.match(linkedNormalStatus, /Linked workflows: debug-chat \(current, cancelled run production-command-run, activation [a-f0-9]{12}\)/u);
  assert.ok(Buffer.byteLength(linkedNormalStatus, "utf8") <= 8_192);
  unlinkSync(selected.piSessionFile); markMissingPiSession(projectRoot, projectId, selected.workflowSessionId);
  await commands.get("hive:recover").handler(selected.workflowSessionId, ctx);
  assert.deepEqual(notices.at(-1), [`Recovered ${selected.workflowSessionId} as Pi session ${sessionId}`, "info"]);
  const recovered = listSessionLinks(projectRoot).find((link) => link.kind === "workflow" && link.workflowSessionId === selected.workflowSessionId) as WorkflowSessionLink;
  assert.equal(recovered.orphaned, false);
  const beforeReloadSessionId = sessionId;
  await commands.get("hive:reload").handler("", ctx);
  assert.notEqual(sessionId, beforeReloadSessionId);
  assert.ok(listSessionLinks(projectRoot).some((link) => link.kind === "workflow" && link.piSessionId === sessionId && link.status === "current"));

  const workflowSource = readdirSync(join(projectRoot, ".pi/hive/workflows")).find((name) => name.endsWith(".yaml"))!;
  appendFileSync(join(projectRoot, ".pi/hive/workflows", workflowSource), "\nunknown-review-field: true\n");
  const stale = (await services.listWorkflows(ctx)).find((row) => row.workflowId === recovered.workflowId)!;
  assert.equal(stale.source, "stale"); assert.equal(stale.resumable, true); assert.equal(stale.state, "stale");
  await services.select({ workflowId: stale.workflowId }, ctx);
  const beforeFresh = listSessionLinks(projectRoot).map((link) => JSON.stringify(link));
  await assert.rejects(() => services.select({ workflowId: stale.workflowId, fresh: true }, ctx), /fresh|unavailable|invalid|stale/i);
  assert.deepEqual(listSessionLinks(projectRoot).map((link) => JSON.stringify(link)), beforeFresh, "stale fresh block has no partial archive or link");

  const fallbackLink = listSessionLinks(projectRoot).find((link): link is WorkflowSessionLink => link.kind === "workflow" && link.piSessionId === sessionId)!;
  const fallbackSnapshot = readActivationSnapshot(projectRoot, fallbackLink.activationHash);
  const fallbackRoot = String((fallbackSnapshot.payload.workflow.team as { rootId: string }).rootId);
  const fallbackOwnerPath = join(projectRoot, ".pi", "hive", "sessions", fallbackLink.workflowSessionId, "runtime-owner.json");
  const fallbackOwnerNonce = String(JSON.parse(readFileSync(fallbackOwnerPath, "utf8")).ownerNonce);
  const offlineLifecycle = new WorkflowRunLifecycle({ projectRoot, projectId, sessionId: fallbackLink.workflowSessionId, snapshotId: fallbackLink.activationHash, rootNodeId: fallbackRoot, runtimeOwnerNonce: fallbackOwnerNonce });
  offlineLifecycle.recordUserInput({ inputId: "offline-command-open", text: "open an idle fallback cancellation run", source: "interactive" });
  assert.match(await services.cancel!("offline command fallback", ctx), /^Cancelled /u);
  assert.equal(offlineLifecycle.restore().latestRun?.status, "cancelled", "command authority settles a durably idle run without a live runtime");
});

test("registers exactly the bound schema-v1 workflow command surface only when configured", () => {
  const off = harness({ configured: false });
  assert.deepEqual([...off.commands], []);
  const { commands } = harness();
  assert.deepEqual([...commands.keys()].sort(), ["hive:answer", "hive:cancel", "hive:checkpoints", "hive:exit", "hive:handoff-clear", "hive:recover", "hive:reload", "hive:select", "hive:status"].sort());
});

test("parses exact select flags and rejects duplicates before service mutation", async () => {
  const { commands, calls } = harness();
  const { ctx } = context();
  await commands.get("hive:select").handler("build --fresh --from run-7", ctx);
  assert.deepEqual(calls, [["select", { workflowId: "build", fresh: true, from: "run-7" }]]);
  await commands.get("hive:select").handler("build --fresh --fresh", ctx);
  assert.equal(calls.length, 1);
});

test("headless answer requires an explicit value and never calls authority service on invalid args", async () => {
  const { commands, calls } = harness();
  const { ctx } = context();
  await commands.get("hive:answer").handler("question-1", ctx);
  assert.equal(calls.length, 0);
  await commands.get("hive:answer").handler("question-1 yes", ctx);
  assert.deepEqual(calls, [["answer", { questionId: "question-1", value: true, channel: "command" }]]);
});

test("TUI confirm answers distinguish dismissal from an intentional No", async () => {
  const dismissed = harness();
  await dismissed.commands.get("hive:answer").handler("question-1", { mode: "tui", hasUI: true, ui: { notify() {}, select: async () => undefined } } as any);
  assert.deepEqual(dismissed.calls, [], "dismissing the Yes/No selector does not mutate the question");

  const denied = harness();
  await denied.commands.get("hive:answer").handler("question-1", { mode: "tui", hasUI: true, ui: { notify() {}, select: async () => "No" } } as any);
  assert.deepEqual(denied.calls, [["answer", { questionId: "question-1", value: false, channel: "command" }]]);
});

test("command settlement contains restoration failures after success and handled errors", async () => {
  let settlements = 0;
  const built = harness({}, () => { settlements += 1; throw new Error("restore failed"); });
  await built.commands.get("hive:status").handler("", context().ctx);
  await built.commands.get("hive:status").handler("extra", context().ctx);
  assert.equal(settlements, 2);
});

test("bounds diagnostics by UTF-8 bytes and marks status truncation", async () => {
  const { commands } = harness({ status: async () => "🧭".repeat(20_000) });
  const tui = context("tui");
  await commands.get("hive:status").handler("", tui.ctx);
  assert.equal(tui.notices.length, 1);
  assert.ok(Buffer.byteLength(tui.notices[0]![0], "utf8") <= 8_192);
  assert.match(tui.notices[0]![0], /\[output truncated\]$/u);
});

test("interactive selector resumes a compatible stale activation but blocks fresh selection", async () => {
  const stale = { workflowId: "build", name: "Build", description: "Stored", useWhen: "resume", tags: [], adapter: "none", profile: "default", activationHash: "b".repeat(64), source: "stale" as const, archivedLinks: [], state: "stale" as const, resumable: true, selectable: false, diagnostics: ["source changed"] };
  const { commands, calls } = harness({ listWorkflows: async () => [stale] });
  const notices: Array<[string, string]> = [];
  const ctx = { mode: "tui", hasUI: true, ui: { select: async (_title: string, values: string[]) => values[0], notify: (text: string, severity: string) => notices.push([text, severity]) } } as any;
  await commands.get("hive:select").handler("", ctx);
  assert.deepEqual(calls, [["select", { workflowId: "build" }]]);
  calls.length = 0;
  await commands.get("hive:select").handler("--fresh", ctx);
  assert.deepEqual(calls, []);
  assert.match(notices.at(-1)?.[0] ?? "", /unavailable/i);
});

test("checkpoint command syntax never exposes the hidden defaults revision", async () => {
  const built = harness();
  await built.commands.get("hive:checkpoints").handler("review off", context().ctx);
  assert.deepEqual(built.calls, [["checkpoints", { checkpointId: "review", enabled: false }]]);
  await built.commands.get("hive:checkpoints").handler("review off 4", context().ctx);
  assert.equal(built.calls.length, 1, "an exposed defaults revision is rejected before service mutation");
});

test("TUI checkpoint defaults and pending approvals require explicit exact actions", async () => {
  const calls: Array<[string, unknown]> = [];
  const { commands } = harness({
    checkpointActions: async () => [{ kind: "default", checkpointId: "review", policy: "optional", enabled: true, defaultsRevision: 4 }],
    checkpoints: async (input) => { calls.push(["checkpoint", input]); return "updated"; },
    approvalActions: async () => [{ requestId: "approval-1", checkpointId: "review", requestSequence: 8, digest: `sha256:${"a".repeat(64)}`, workspaceHash: `sha256:${"b".repeat(64)}` }],
    decideApproval: async (input) => { calls.push(["approval", input]); return "approved"; },
  });
  const selections = ["review — optional — on", "approval-1 — review — sha256:aaaaaaaaaaaa…", "Approve"];
  const ctx = { mode: "tui", hasUI: true, isProjectTrusted: () => true, ui: {
    notify() {}, select: async () => selections.shift(), confirm: async () => true,
  } } as any;
  await commands.get("hive:checkpoints").handler("", ctx);
  await commands.get("hive:status").handler("", ctx);
  assert.deepEqual(calls, [
    ["checkpoint", undefined], ["checkpoint", { checkpointId: "review", enabled: false, expectedDefaultsRevision: 4 }],
    ["approval", { requestId: "approval-1", expectedRequestSequence: 8, digest: `sha256:${"a".repeat(64)}`, expectedWorkspaceHash: `sha256:${"b".repeat(64)}`, decision: "approved" }],
  ]);
});

test("all command and TUI cancellation branches remain no-op before service mutation", async () => {
  const invalid = harness(); const invalidCtx = context().ctx;
  for (const [name, args] of [["hive:status", "extra"], ["hive:exit", "extra"], ["hive:reload", "extra"], ["hive:checkpoints", "review maybe"], ["hive:handoff-clear", "extra"], ["hive:recover", ""], ["hive:recover", "one two"]] as const) await invalid.commands.get(name).handler(args, invalidCtx);
  assert.deepEqual(invalid.calls, []);

  const approval = { requestId: "approval-1", checkpointId: "review", requestSequence: 8, digest: `sha256:${"a".repeat(64)}`, workspaceHash: `sha256:${"b".repeat(64)}` };
  const checkpoint = { kind: "default" as const, checkpointId: "review", policy: "optional" as const, enabled: true, defaultsRevision: 4 };
  const tuiCase = async (kind: "status" | "checkpoints", selections: Array<string | undefined>, confirmations: boolean[], overrides: Partial<WorkflowCommandServices>) => {
    let selection = 0; let confirmation = 0; const built = harness(overrides);
    const ctx = { mode: "tui", hasUI: true, ui: { notify() {}, select: async () => selections[selection++], confirm: async () => confirmations[confirmation++] ?? false } } as any;
    await built.commands.get(`hive:${kind}`).handler("", ctx); return built.calls;
  };
  const decideApproval = async () => "decided";
  assert.deepEqual(await tuiCase("status", [], [], { approvalActions: async () => [], decideApproval }), []);
  assert.deepEqual(await tuiCase("status", [undefined], [], { approvalActions: async () => [approval], decideApproval }), []);
  assert.deepEqual(await tuiCase("status", ["approval-1 — review — sha256:aaaaaaaaaaaa…", undefined], [], { approvalActions: async () => [approval], decideApproval }), []);
  assert.deepEqual(await tuiCase("status", ["approval-1 — review — sha256:aaaaaaaaaaaa…", "Deny"], [false], { approvalActions: async () => [approval], decideApproval }), []);
  assert.deepEqual(await tuiCase("checkpoints", [], [], { checkpointActions: async () => [] }), [["checkpoints", undefined]]);
  assert.deepEqual(await tuiCase("checkpoints", [undefined], [], { checkpointActions: async () => [checkpoint] }), [["checkpoints", undefined]]);
  assert.deepEqual(await tuiCase("checkpoints", ["review — required — on"], [], { checkpointActions: async () => [{ ...checkpoint, policy: "required" }] }), [["checkpoints", undefined]]);
  assert.deepEqual(await tuiCase("checkpoints", ["review — optional — on"], [false], { checkpointActions: async () => [checkpoint] }), [["checkpoints", undefined]]);
});

test("typed command answers parse confirm, single, multi, and text before authority", async () => {
  const cases = [
    [{ prompt: "Confirm", kind: "confirm" as const, required: true }, "yes", true],
    [{ prompt: "Pick", kind: "single" as const, required: true, choices: [{ value: "a", label: "A" }] }, "a", "a"],
    [{ prompt: "Pick", kind: "multi" as const, required: true, choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }, "b,a", ["a", "b"]],
    [{ prompt: "Text", kind: "text" as const, required: true }, "hello", "hello"],
  ] as const;
  for (const [definition, raw, expected] of cases) {
    const { commands, calls } = harness({ readQuestion: async () => ({ definition }) });
    await commands.get("hive:answer").handler(`question-1 ${raw}`, context().ctx);
    assert.deepEqual(calls, [["answer", { questionId: "question-1", value: expected, channel: "command" }]]);
  }
});

test("session-replacing commands never access an invalidated Pi command context", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-command-stale-context-"));
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  cpSync(join(process.cwd(), "tests/fixtures/workflow-configs/artifact-free-debug/.pi/hive"), join(projectRoot, ".pi/hive"), { recursive: true });
  const sessionRoot = join(projectRoot, "pi-sessions");
  mkdirSync(sessionRoot);
  const normalManager = persistedFakePiSessionManager(projectRoot, sessionRoot, "normal");
  const normalFile = normalManager.getSessionFile()!;

  const model = { provider: "provider", id: "model", contextWindow: 2_000_000, maxTokens: 16_384, reasoning: true };
  const notices: Array<[string, string]> = [];
  let sessionId = "normal";
  let sessionFile = normalFile;
  let created = 0;
  let currentContext: any;
  const createContext = (): any => {
    let stale = false;
    const sessionManager = FakePiSessionManager.open(sessionFile);
    const target: any = {
      mode: "tui", hasUI: true, cwd: projectRoot, sessionManager, model,
      modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
      isProjectTrusted: () => true, isIdle: () => true, abort() {}, waitForIdle: async () => {},
      ui: { notify: (text: string, severity: string) => notices.push([text, severity]) },
      async newSession(input: any) {
        const manager = FakePiSessionManager.create(projectRoot, sessionRoot);
        manager.newSession({ id: `workflow-pi-${++created}` });
        durablyFlushPiSessionManager(manager as never);
        sessionId = manager.getSessionId();
        sessionFile = manager.getSessionFile()!;
        const fresh = createContext();
        await input.setup?.(fresh.sessionManager);
        currentContext = fresh;
        stale = true;
        await input.withSession?.(fresh);
        return { cancelled: false };
      },
      async switchSession(path: string, input: any) {
        const manager = FakePiSessionManager.open(path);
        sessionFile = manager.getSessionFile()!;
        sessionId = manager.getSessionId();
        const fresh = createContext();
        currentContext = fresh;
        const selected = listSessionLinks(projectRoot).find((link): link is WorkflowSessionLink => link.kind === "workflow" && link.piSessionId === sessionId);
        observeSessionReplacementStart(projectRoot, projectId, fresh);
        if (selected) acknowledgeSessionReplacementStart(projectRoot, projectId, fresh, { workflowSessionId: selected.workflowSessionId, linkGenerationHash: workflowLinkGenerationHash(selected) });
        publishSessionContext(fresh);
        stale = true;
        await input.withSession?.(fresh);
        return { cancelled: false };
      },
      async reload() {
        const reloaded = createContext();
        currentContext = reloaded;
        stale = true;
        const selected = listSessionLinks(projectRoot).find((link): link is WorkflowSessionLink => link.kind === "workflow" && link.piSessionId === sessionId);
        observeSessionReplacementStart(projectRoot, projectId, reloaded);
        if (selected) acknowledgeSessionReplacementStart(projectRoot, projectId, reloaded, { workflowSessionId: selected.workflowSessionId, linkGenerationHash: workflowLinkGenerationHash(selected) });
        publishSessionContext(reloaded);
      },
    };
    return new Proxy(target, {
      get(value, property, receiver) {
        if (stale) throw new Error(`stale command context access: ${String(property)}`);
        return Reflect.get(value, property, receiver);
      },
    });
  };
  currentContext = createContext();

  const commands = new Map<string, any>();
  const pi: any = { getThinkingLevel: () => "medium", registerCommand(name: string, value: unknown) { commands.set(name, value); } };
  const projectId = resolveProjectIdentity(projectRoot).projectId;
  initializeNormalParent({ configured: true, projectRoot, projectId, piSessionId: sessionId, piSessionFile: sessionFile, model: "provider/model", thinking: "medium", activeTools: [] });
  let settled = 0;
  await registerLinkedWorkflowCommandSurfaces(pi, projectRoot, projectId, (ctx) => {
    void ctx.mode;
    settled += 1;
  });

  await commands.get("hive:select").handler("debug-chat", currentContext);
  const selectedAfterSelect = listSessionLinks(projectRoot).find((link): link is WorkflowSessionLink => link.kind === "workflow" && link.piSessionId === sessionId)!;
  assert.ok(selectedAfterSelect);
  await commands.get("hive:status").handler("", currentContext);
  await commands.get("hive:checkpoints").handler("", currentContext);
  assert.equal(settled, 2, "non-replacing commands retain command-settled refreshes");

  await commands.get("hive:reload").handler("", currentContext);
  assert.notEqual(sessionId, selectedAfterSelect.piSessionId);
  const selectedAfterReload = listSessionLinks(projectRoot).find((link): link is WorkflowSessionLink => link.kind === "workflow" && link.piSessionId === sessionId)!;
  await commands.get("hive:exit").handler("", currentContext);
  assert.equal(sessionId, "normal");

  unlinkSync(selectedAfterReload.piSessionFile);
  markMissingPiSession(projectRoot, projectId, selectedAfterReload.workflowSessionId);
  await commands.get("hive:recover").handler(selectedAfterReload.workflowSessionId, currentContext);
  assert.notEqual(sessionId, "normal");
  assert.deepEqual(notices.at(-1), [`Recovered ${selectedAfterReload.workflowSessionId} as Pi session ${sessionId}`, "info"], "recover presents its exact result through the fresh replacement context");
  await commands.get("hive:exit").handler("", currentContext);
  assert.equal(sessionId, "normal");
  assert.equal(settled, 2, "select, reload, recover, and exit never settle against their replaced contexts");
  assert.ok(notices.some(([text]) => /Workflow debug-chat/u.test(text)));
  assert.ok(notices.some(([text]) => /Checkpoints/u.test(text)));
});
