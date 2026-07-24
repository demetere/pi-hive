/** Config-first workflow extension entrypoint. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertFilesystemPlatformSupported } from "./src/capabilities/filesystem";
import { loadConfigProject, readActivationSnapshot } from "./src/config/index";
import { resolveProjectIdentity } from "./src/shared/project-identity";
import { workflowToolDefinitionsWithRuntime } from "./src/integration/workflow-tools";
import { createLinkedWorkflowCommandServices, createPiWorkflowRuntimeCommandAuthority } from "./src/integration/workflow-command-service";
import { registerWorkflowCommands } from "./src/integration/workflow-commands";
import { registerWorkflowRunHooks } from "./src/integration/run-lifecycle";
import { createSelectedWorkflowToolPolicyHook } from "./src/integration/workflow-tool-policy";
import { startWorkflowDashboard } from "./src/integration/workflow-dashboard-service";
import { materializeNormalSession } from "./src/integration/session-links";
import { acknowledgeSessionReplacementStart, observeSessionReplacementStart } from "./src/integration/session-replacement-acknowledgement";
import { publishSessionContext } from "./src/integration/session-context";
import { WorkflowProductionRuntimeRegistry, type SelectedProductionWorkflowRuntime } from "./src/integration/workflow-production-runtime";
import { clearWorkflowStatusUi, restoreWorkflowStatusSummary, updateWorkflowStatusUi } from "./src/ui/tui/workflow-widget";
import { initializeNormalParent, listSessionLinks, workflowLinkGenerationHash, type NormalSessionLink, type WorkflowSessionLink } from "./src/workflows/sessions";

export const WORKFLOW_UI_REFRESH_BOUNDARIES = Object.freeze(["session_start", "input", "message_end", "turn_end", "command-settled"] as const);

// Pi cache-busts extension modules during session replacement. Keep ownership
// truly process-scoped so the committed target can reacquire the live runtime.
const RUNTIME_OWNER_NONCE_KEY = Symbol.for("pi-hive.runtime-owner-nonce.v1");
const processRuntimeState = globalThis as typeof globalThis & { [RUNTIME_OWNER_NONCE_KEY]?: string };
const runtimeOwnerNonce = processRuntimeState[RUNTIME_OWNER_NONCE_KEY] ??= randomUUID();

function configurationFailure(result: Exclude<ReturnType<typeof loadConfigProject>, { status: "configured" | "unconfigured" }>): Error {
  const details = result.diagnostics.slice(0, 20).map((entry) => `${entry.code}: ${entry.message}`).join("; ");
  return new Error(`pi-hive schema-v1 configuration is invalid. Manual migration is required; pre-1.0 configuration is not loaded. ${details}`);
}

export type WorkflowDashboardStartMode = "session" | "workflow" | "manual";
export interface WorkflowDashboardStartLifecycle<Context = unknown> {
  sessionStarted(context: Context, workflowSelected: boolean): Promise<void>;
  workflowSelected(context: Context): Promise<void>;
}

/** One-shot, injectable dashboard lifecycle. It has no side effects until an explicit hook boundary. */
export function createWorkflowDashboardStartLifecycle<Context>(
  configuredMode: WorkflowDashboardStartMode | undefined,
  start: (context: Context, open: boolean) => Promise<unknown>,
): WorkflowDashboardStartLifecycle<Context> {
  const mode = configuredMode ?? "workflow";
  let started = false;
  let pending: Promise<void> | undefined;
  const startOnce = async (context: Context): Promise<void> => {
    if (started) return;
    pending ??= Promise.resolve(start(context, false)).then(() => { started = true; }).finally(() => { pending = undefined; });
    await pending;
  };
  return Object.freeze({
    async sessionStarted(context: Context, selected: boolean) {
      if (mode === "session" || (mode === "workflow" && selected)) await startOnce(context);
    },
    async workflowSelected(context: Context) { if (mode === "workflow") await startOnce(context); },
  });
}

export interface HiveExtensionDependencies {
  readonly startDashboard?: (ctx: ExtensionContext, open: boolean) => Promise<unknown>;
  /** Test seam; production always uses process.platform. */
  readonly runtimePlatform?: NodeJS.Platform;
}

/** Testable production wiring seam; constructing services has no process side effects. */
export async function registerLinkedWorkflowCommandSurfaces(pi: ExtensionAPI, projectRoot: string, projectId: string, onSettled?: (ctx: ExtensionCommandContext) => void | Promise<void>, runtimeOwnerNonce?: string, runtimePlatform: NodeJS.Platform = process.platform): Promise<void> {
  registerWorkflowCommands(pi, createLinkedWorkflowCommandServices(pi, projectRoot, projectId, createPiWorkflowRuntimeCommandAuthority(), runtimeOwnerNonce, runtimePlatform), onSettled);
}

function selectedLink(projectRoot: string, ctx: ExtensionContext): WorkflowSessionLink | undefined {
  return listSessionLinks(projectRoot).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.piSessionId === ctx.sessionManager.getSessionId());
}

function normalLink(projectRoot: string, ctx: ExtensionContext): NormalSessionLink | undefined {
  return listSessionLinks(projectRoot).find((entry): entry is NormalSessionLink => entry.kind === "normal" && entry.piSessionId === ctx.sessionManager.getSessionId());
}

export default async function hiveExtension(pi: ExtensionAPI, dependencies: HiveExtensionDependencies = {}): Promise<void> {
  const configured = loadConfigProject(process.cwd());
  if (configured.status === "unconfigured") return;
  if (configured.status === "invalid") throw configurationFailure(configured);

  const project = resolveProjectIdentity(configured.projectRoot);
  const runtimePlatform = dependencies.runtimePlatform ?? process.platform;
  const runtimes = new WorkflowProductionRuntimeRegistry(configured.projectRoot, project.projectId, undefined, runtimeOwnerNonce);
  const dashboardStart = createWorkflowDashboardStartLifecycle<ExtensionContext>(
    configured.manifest.settings?.telemetry?.["dashboard-start"],
    dependencies.startDashboard ?? ((ctx, open) => startWorkflowDashboard(ctx as ExtensionCommandContext, open)),
  );
  let activeRuntime: SelectedProductionWorkflowRuntime | undefined;
  let workflowUiVisible = false;
  let restoringFrozenModel = false;

  const applyFrozenModel = async (ctx: ExtensionContext, modelId: string, thinking: string): Promise<void> => {
    if (restoringFrozenModel) return;
    const separator = modelId.indexOf("/");
    if (separator < 1 || separator === modelId.length - 1) throw new Error(`Frozen workflow model ${modelId} is invalid`);
    const model = ctx.modelRegistry.find(modelId.slice(0, separator), modelId.slice(separator + 1));
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`Frozen workflow model ${modelId} is unavailable`);
    restoringFrozenModel = true;
    try {
      if (!ctx.model || `${ctx.model.provider}/${ctx.model.id}` !== modelId) {
        if (!await pi.setModel(model)) throw new Error(`Frozen workflow model ${modelId} could not be selected`);
      }
      if (String(pi.getThinkingLevel()) !== thinking) pi.setThinkingLevel(thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
    } finally { restoringFrozenModel = false; }
  };

  const workflowTools = workflowToolDefinitionsWithRuntime(() => activeRuntime?.rootServices());
  const workflowToolNames = new Set(workflowTools.map((tool) => tool.name));
  for (const tool of workflowTools) pi.registerTool(tool);

  const refreshSelection = (ctx: ExtensionContext): void => {
    const selected = selectedLink(configured.projectRoot, ctx);
    activeRuntime = runtimes.select(selected, ctx);
  };
  const refreshWorkflowUi = (ctx: ExtensionContext): boolean => {
    const selected = selectedLink(configured.projectRoot, ctx);
    try {
      if (selected) {
        const restored = updateWorkflowStatusUi(ctx, restoreWorkflowStatusSummary(configured.projectRoot, selected));
        workflowUiVisible = restored;
        return restored;
      }
      if (workflowUiVisible) {
        const restored = clearWorkflowStatusUi(ctx);
        workflowUiVisible = false;
        return restored;
      }
      return true;
    } catch {
      if (workflowUiVisible) clearWorkflowStatusUi(ctx);
      workflowUiVisible = false;
      return false;
    }
  };
  await registerLinkedWorkflowCommandSurfaces(pi, configured.projectRoot, project.projectId, async (ctx) => {
    refreshSelection(ctx);
    refreshWorkflowUi(ctx);
    if (selectedLink(configured.projectRoot, ctx)) await dashboardStart.workflowSelected(ctx);
  }, runtimeOwnerNonce, runtimePlatform);

  // This handler is registered before lifecycle hooks so session restoration has
  // selected the exact linked authority before resume/input callbacks run.
  pi.on("session_start", async (_event, ctx) => {
    observeSessionReplacementStart(configured.projectRoot, project.projectId, ctx);
    publishSessionContext(ctx);
    let sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const selected = selectedLink(configured.projectRoot, ctx);
    if (selected) {
      try { assertFilesystemPlatformSupported(runtimePlatform); }
      catch (error) {
        pi.setActiveTools([]);
        if (ctx.hasUI) ctx.ui.notify(String(error instanceof Error ? error.message : error), "error");
        return;
      }
      readActivationSnapshot(configured.projectRoot, selected.activationHash);
      await applyFrozenModel(ctx, selected.model, selected.thinking);
      pi.setActiveTools([...selected.tools]);
    } else {
      sessionFile = materializeNormalSession(ctx.sessionManager) ?? sessionFile;
      // Pi enables newly registered custom tools by default. Action methods are
      // unavailable while loading an extension, so derive the initial normal
      // baseline at this runtime boundary. Replacement back to the canonical
      // normal session restores its previously captured baseline exactly.
      const stored = normalLink(configured.projectRoot, ctx);
      const baseline = stored?.normalTools ?? Object.freeze(pi.getActiveTools().filter((name) => !workflowToolNames.has(name)));
      initializeNormalParent({
        configured: true, projectRoot: configured.projectRoot, projectId: project.projectId,
        piSessionId: ctx.sessionManager.getSessionId(), piSessionFile: sessionFile,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unselected",
        thinking: String(pi.getThinkingLevel()), activeTools: baseline,
      });
      pi.setActiveTools([...baseline]);
    }
    refreshSelection(ctx);
    const workflowUiRestored = refreshWorkflowUi(ctx);
    let dashboardRestored = true;
    try { await dashboardStart.sessionStarted(ctx, Boolean(selected)); }
    catch { dashboardRestored = false; /* Optional telemetry startup must not disrupt ordinary Pi startup. */ }
    if (selected && workflowUiRestored && dashboardRestored && activeRuntime?.link.workflowSessionId === selected.workflowSessionId && workflowLinkGenerationHash(activeRuntime.link) === workflowLinkGenerationHash(selected)) {
      acknowledgeSessionReplacementStart(configured.projectRoot, project.projectId, ctx, {
        workflowSessionId: selected.workflowSessionId,
        linkGenerationHash: workflowLinkGenerationHash(selected),
      });
    }
  });
  pi.on("model_select", async (event, ctx) => {
    if (restoringFrozenModel) return;
    const selected = selectedLink(configured.projectRoot, ctx);
    if (!selected || `${event.model.provider}/${event.model.id}` === selected.model) return;
    await applyFrozenModel(ctx, selected.model, selected.thinking);
    if (ctx.hasUI) ctx.ui.notify(`Workflow ${selected.workflowId} keeps ${selected.model} fixed. Exit and select again to change models.`, "warning");
  });
  pi.on("thinking_level_select", async (event, ctx) => {
    if (restoringFrozenModel) return;
    const selected = selectedLink(configured.projectRoot, ctx);
    if (!selected || String(event.level) === selected.thinking) return;
    await applyFrozenModel(ctx, selected.model, selected.thinking);
    if (ctx.hasUI) ctx.ui.notify(`Workflow ${selected.workflowId} keeps thinking ${selected.thinking} fixed. Exit and select again to change it.`, "warning");
  });
  pi.on("input", async (_event, ctx) => { const selected = selectedLink(configured.projectRoot, ctx); if (selected) await applyFrozenModel(ctx, selected.model, selected.thinking); refreshSelection(ctx); refreshWorkflowUi(ctx); });
  pi.on("message_end", async (_event, ctx) => { refreshSelection(ctx); refreshWorkflowUi(ctx); });
  pi.on("turn_end", async (_event, ctx) => { refreshSelection(ctx); refreshWorkflowUi(ctx); });

  registerWorkflowRunHooks(pi, {
    resolveLifecycle: () => activeRuntime?.lifecycle,
    resolveRuntime: () => activeRuntime,
    pauseCoordinator: {},
    resumeCoordinator: { acquireOwnership: () => {}, acquireLeases: () => {}, revalidateHashes: () => false, rollbackAuthority: () => {} },
  });
  pi.on("tool_call", createSelectedWorkflowToolPolicyHook(configured.projectRoot, () => activeRuntime));
  pi.on("session_shutdown", async (_event, ctx) => {
    if (workflowUiVisible) clearWorkflowStatusUi(ctx);
    workflowUiVisible = false;
    activeRuntime = undefined;
    await runtimes.shutdown();
  });
}
