import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import { OwnedProcessRegistry, terminateOwnedProcess } from "../capabilities/process";
import { readActivationSnapshot } from "../config/snapshot-store";
import { effectiveRuntimeBudgetLimitsFromSnapshot } from "../workflows/budgets";
import { RunOrchestrationService, type BoundDelegationServices, type RunOrchestrationServiceOptions } from "../workflows/orchestration";
import { CANCELLATION_TIMING } from "../workflows/runs";
import {
  acquireRuntimeOwnership,
  captureRuntimeOwnership,
  heartbeatCurrentRuntimeOwnership,
  settleRuntimeOwnershipRelease,
  type RuntimeOwner,
} from "../workflows/ownership";
import type { WorkflowSessionLink } from "../workflows/sessions";
import type { WorkerPromptInvocation, WorkerPromptResponse, WorkerSessionFactory, WorkerSessionHandle } from "../workflows/workers";
import { genericWorkflowToolsForNode } from "./workflow-tools";
import { createSelectedWorkflowToolPolicyHook, type SelectedWorkflowToolAuthority } from "./workflow-tool-policy";

function splitModel(value: string): readonly [string, string] {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error(`Workflow model ${value} is invalid`);
  return [value.slice(0, slash), value.slice(slash + 1)];
}

function assistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    if (typeof record.content === "string") return record.content;
    if (Array.isArray(record.content)) return record.content.flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" ? [text] : [];
    }).join("");
  }
  throw new Error("Workflow worker provider returned no assistant text");
}

function ownedBashTool(projectRoot: string, processes: OwnedProcessRegistry) {
  return createBashToolDefinition(projectRoot, { operations: {
    async exec(command, cwd, options) {
      if (options.signal?.aborted) throw new Error("aborted");
      const shell = process.env.SHELL || "/bin/sh";
      const handle = processes.spawn(shell, ["-lc", command], { cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
      handle.child.stdout?.on("data", options.onData);
      handle.child.stderr?.on("data", options.onData);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const terminateHandle = (): void => { terminateOwnedProcess(handle, "SIGKILL"); };
      const abort = (): void => { terminateHandle(); };
      if (options.timeout !== undefined) timeout = setTimeout(terminateHandle, options.timeout * 1_000);
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          handle.child.once("error", reject);
          handle.child.once("exit", (code) => resolve(code));
        });
        if (options.signal?.aborted) throw new Error("aborted");
        return { exitCode };
      } finally {
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      }
    },
  } });
}

function workerFactory(projectRoot: string, snapshot: ActivationSnapshotFileV1, processes: OwnedProcessRegistry, context: () => ExtensionContext): WorkerSessionFactory {
  return async (input): Promise<WorkerSessionHandle> => {
    const ctx = context();
    const [provider, modelId] = splitModel(input.modelId);
    const model = ctx.modelRegistry.find(provider, modelId);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`Workflow worker model ${input.modelId} is unavailable`);
    const policy = input.toolPolicy;
    if (!policy) throw new Error(`Workflow worker ${input.nodeId} has no immutable tool policy`);
    const policyExtension: InlineExtension = async (pi) => {
      pi.on("tool_call", createSelectedWorkflowToolPolicyHook(projectRoot, () => ({ snapshot, nodeId: input.nodeId, policy })));
    };
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    const settings = SettingsManager.create(projectRoot, agentDir);
    const loader = new DefaultResourceLoader({
      cwd: projectRoot,
      agentDir,
      settingsManager: settings,
      extensionFactories: [{ name: "pi-hive-worker-policy", factory: policyExtension }],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd: projectRoot,
      model,
      thinkingLevel: input.thinking as Parameters<typeof createAgentSession>[0] extends { thinkingLevel?: infer T } ? T : never,
      tools: [...input.tools],
      customTools: [
        ...genericWorkflowToolsForNode(snapshot, input.nodeId),
        ...(input.tools.includes("bash") ? [ownedBashTool(projectRoot, processes)] : []),
      ] as never,
      resourceLoader: loader,
      modelRegistry: ctx.modelRegistry,
      sessionManager: SessionManager.inMemory(),
      settingsManager: settings,
    });
    const session = created.session;
    return Object.freeze({
      linkedSessionId: session.sessionManager.getSessionId(),
      async prompt(text: string, signal?: AbortSignal, invocation?: WorkerPromptInvocation): Promise<WorkerPromptResponse> {
        if (signal?.aborted) throw signal.reason;
        const abort = (): void => { void session.abort(); };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          const run = () => session.prompt(text, { source: "rpc" });
          if (invocation?.runWithToolRuntime) await invocation.runWithToolRuntime(run);
          else await run();
          return Object.freeze({ output: assistantText(session.state.messages) });
        } finally { signal?.removeEventListener("abort", abort); }
      },
      abort: () => session.abort(),
      dispose: () => session.dispose(),
    });
  };
}

export interface SelectedProductionWorkflowRuntime extends SelectedWorkflowToolAuthority {
  readonly link: WorkflowSessionLink;
  readonly service: RunOrchestrationService;
  readonly lifecycle: RunOrchestrationService["lifecycle"];
  rootServices(): BoundDelegationServices;
  pause(reason: string): Promise<boolean>;
  resume(): Promise<boolean>;
}

interface RuntimeRecord {
  readonly link: WorkflowSessionLink;
  readonly snapshot: ActivationSnapshotFileV1;
  readonly ownerNonce: string;
  readonly ownedProcesses: OwnedProcessRegistry;
  readonly service: RunOrchestrationService;
  ownerHeld: boolean;
  ownerGeneration?: RuntimeOwner;
  heartbeat?: ReturnType<typeof setInterval>;
}

/** Session-resolved production owner for root lifecycle, worker execution, and policy authority. */
export class WorkflowProductionRuntimeRegistry {
  private readonly records = new Map<string, RuntimeRecord>();
  private currentContext?: ExtensionContext;
  private readonly projectRoot: string;
  private readonly projectId: string;
  private readonly ownedProcessRegistryFactory: () => OwnedProcessRegistry;
  private readonly runtimeOwnerNonce: string;
  private readonly serviceDependencies: Pick<RunOrchestrationServiceOptions, "artifactMutationQueue" | "checkpointApproval" | "completion">;

  constructor(
    projectRoot: string,
    projectId: string,
    ownedProcessRegistryFactory: () => OwnedProcessRegistry = () => new OwnedProcessRegistry(),
    runtimeOwnerNonce: string = randomUUID(),
    serviceDependencies: Pick<RunOrchestrationServiceOptions, "artifactMutationQueue" | "checkpointApproval" | "completion"> = {},
  ) {
    this.projectRoot = projectRoot;
    this.projectId = projectId;
    this.ownedProcessRegistryFactory = ownedProcessRegistryFactory;
    this.runtimeOwnerNonce = runtimeOwnerNonce;
    this.serviceDependencies = serviceDependencies;
  }

  private acquire(record: RuntimeRecord): void {
    if (record.ownerHeld) return;
    let alreadyOwned = false;
    try { alreadyOwned = heartbeatCurrentRuntimeOwnership(this.projectRoot, record.link.workflowSessionId, record.ownerNonce); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!alreadyOwned) {
      const acquired = acquireRuntimeOwnership(this.projectRoot, record.link.workflowSessionId, { nonce: record.ownerNonce });
      if (!acquired.ok || acquired.owner?.ownerNonce !== record.ownerNonce) throw new Error(`Workflow runtime ownership denied: ${acquired.reason}`);
      record.ownerGeneration = acquired.owner;
    } else {
      record.ownerGeneration = captureRuntimeOwnership(this.projectRoot, record.link.workflowSessionId, record.ownerNonce);
      if (!record.ownerGeneration) throw new Error("Workflow runtime ownership changed after heartbeat");
    }
    record.ownerHeld = true;
    record.heartbeat = setInterval(() => {
      if (!heartbeatCurrentRuntimeOwnership(this.projectRoot, record.link.workflowSessionId, record.ownerNonce)) record.ownerHeld = false;
    }, 10_000);
    record.heartbeat.unref?.();
  }

  private release(record: RuntimeRecord): void {
    if (record.heartbeat) clearInterval(record.heartbeat);
    record.heartbeat = undefined;
    if (record.ownerHeld && (!record.ownerGeneration || !settleRuntimeOwnershipRelease(this.projectRoot, record.link.workflowSessionId, record.ownerGeneration))) {
      throw new Error("Workflow runtime ownership release was denied");
    }
    record.ownerHeld = false;
    record.ownerGeneration = undefined;
  }

  select(link: WorkflowSessionLink | undefined, ctx: ExtensionContext): SelectedProductionWorkflowRuntime | undefined {
    this.currentContext = ctx;
    if (!link) return undefined;
    let record = this.records.get(link.workflowSessionId);
    if (record && (record.link.activationHash !== link.activationHash || record.link.piSessionId !== link.piSessionId)) {
      throw new Error("Workflow runtime link generation changed while authority remained live");
    }
    if (!record) {
      const snapshot = readActivationSnapshot(this.projectRoot, link.activationHash);
      const ownerNonce = this.runtimeOwnerNonce;
      const context = (): ExtensionContext => {
        if (!this.currentContext) throw new Error("Workflow worker execution has no current Pi context");
        return this.currentContext;
      };
      const holder = { release: (): void => undefined, acquire: (): void => undefined };
      const ownedProcesses = this.ownedProcessRegistryFactory();
      const service = new RunOrchestrationService({
        projectRoot: this.projectRoot,
        projectId: this.projectId,
        sessionId: link.workflowSessionId,
        snapshot,
        runtimeOwnerNonce: ownerNonce,
        maxParallel: effectiveRuntimeBudgetLimitsFromSnapshot(snapshot).run.maxParallel,
        workerFactory: workerFactory(this.projectRoot, snapshot, ownedProcesses, context),
        ...this.serviceDependencies,
        pauseAuthority: { releaseOwnership: () => holder.release() },
        resumeAuthority: { acquireOwnership: () => holder.acquire(), acquireLeases: () => {}, revalidateHashes: () => true, rollbackAuthority: () => holder.release() },
        cancellationAuthority: {
          waitForSettlement: async (timeoutMs) => {
            if (ownedProcesses.isSettled()) return true;
            if (timeoutMs === CANCELLATION_TIMING.settleGraceMs) return false;
            const deadline = Date.now() + Math.max(0, timeoutMs - 50);
            while (Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 20));
              if (ownedProcesses.isSettled()) return true;
            }
            return ownedProcesses.isSettled();
          },
          terminateProcessTrees: () => { ownedProcesses.terminateAll("SIGKILL"); },
          capturePartialState: () => ({}), releaseLeases: () => {},
        },
      });
      record = { link, snapshot, ownerNonce, ownedProcesses, service, ownerHeld: false };
      holder.release = () => this.release(record!);
      holder.acquire = () => this.acquire(record!);
      this.records.set(link.workflowSessionId, record);
    }
    this.acquire(record);
    const nodeId = String((record.snapshot.payload.workflow.team as { rootId?: unknown } | undefined)?.rootId ?? "");
    return Object.freeze({
      link: record.link,
      snapshot: record.snapshot,
      nodeId,
      service: record.service,
      lifecycle: record.service.lifecycle,
      rootServices: () => record!.service.rootServices(),
      pause: async (reason: string) => {
        if (!record!.service.lifecycle.restore().latestRun) { this.release(record!); return true; }
        return record!.service.pause(reason);
      },
      resume: async () => record!.service.resume(),
    });
  }

  async shutdown(): Promise<void> {
    for (const record of this.records.values()) {
      try { await record.service.shutdown(); }
      finally {
        record.ownedProcesses.terminateAll("SIGKILL");
        if (record.ownerHeld) this.release(record);
      }
    }
    this.records.clear();
  }
}
