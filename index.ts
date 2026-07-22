/** Config-first workflow extension entrypoint. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfigProject, readActivationSnapshot } from "./src/config/index";
import { resolveProjectIdentity } from "./src/shared/project-identity";
import { workflowToolDefinitionsWithRuntime } from "./src/integration/workflow-tools";
import { createLinkedWorkflowCommandServices, createPiWorkflowRuntimeCommandAuthority } from "./src/integration/workflow-command-service";
import { registerWorkflowCommands } from "./src/integration/workflow-commands";
import { registerWorkflowRunHooks } from "./src/integration/run-lifecycle";
import { createSelectedWorkflowToolPolicyHook } from "./src/integration/workflow-tool-policy";
import { WorkflowProductionRuntimeRegistry, type SelectedProductionWorkflowRuntime } from "./src/integration/workflow-production-runtime";
import { clearWorkflowStatusUi, restoreWorkflowStatusSummary, updateWorkflowStatusUi } from "./src/ui/tui/workflow-widget";
import { initializeNormalParent, listSessionLinks, type NormalSessionLink, type WorkflowSessionLink } from "./src/workflows/sessions";

export const WORKFLOW_UI_REFRESH_BOUNDARIES = Object.freeze(["session_start", "input", "message_end", "turn_end", "command-settled"] as const);

function configurationFailure(result: Exclude<ReturnType<typeof loadConfigProject>, { status: "configured" | "unconfigured" }>): Error {
  const details = result.diagnostics.slice(0, 20).map((entry) => `${entry.code}: ${entry.message}`).join("; ");
  return new Error(`pi-hive schema-v1 configuration is invalid. Manual migration is required; pre-1.0 configuration is not loaded. ${details}`);
}

/** Testable production wiring seam; constructing services has no process side effects. */
export async function registerLinkedWorkflowCommandSurfaces(pi: ExtensionAPI, projectRoot: string, projectId: string, onSettled?: (ctx: ExtensionCommandContext) => void, runtimeOwnerNonce?: string): Promise<void> {
  registerWorkflowCommands(pi, createLinkedWorkflowCommandServices(pi, projectRoot, projectId, createPiWorkflowRuntimeCommandAuthority(), runtimeOwnerNonce), onSettled);
}

function selectedLink(projectRoot: string, ctx: ExtensionContext): WorkflowSessionLink | undefined {
  return listSessionLinks(projectRoot).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.piSessionId === ctx.sessionManager.getSessionId());
}

function normalLink(projectRoot: string, ctx: ExtensionContext): NormalSessionLink | undefined {
  return listSessionLinks(projectRoot).find((entry): entry is NormalSessionLink => entry.kind === "normal" && entry.piSessionId === ctx.sessionManager.getSessionId());
}

export default async function hiveExtension(pi: ExtensionAPI): Promise<void> {
  const configured = loadConfigProject(process.cwd());
  if (configured.status === "unconfigured") return;
  if (configured.status === "invalid") throw configurationFailure(configured);

  // Capture before workflow tools are registered: Pi enables newly registered
  // custom tools by default, so a later getActiveTools() is not a normal-chat baseline.
  const startupNormalTools = Object.freeze([...pi.getActiveTools()]);
  const project = resolveProjectIdentity(configured.projectRoot);
  const runtimeOwnerNonce = randomUUID();
  const runtimes = new WorkflowProductionRuntimeRegistry(configured.projectRoot, project.projectId, undefined, runtimeOwnerNonce);
  let activeRuntime: SelectedProductionWorkflowRuntime | undefined;
  let workflowUiVisible = false;

  for (const tool of workflowToolDefinitionsWithRuntime(() => activeRuntime?.rootServices())) pi.registerTool(tool);
  pi.setActiveTools([...startupNormalTools]);

  const refreshSelection = (ctx: ExtensionContext): void => {
    const selected = selectedLink(configured.projectRoot, ctx);
    activeRuntime = runtimes.select(selected, ctx);
  };
  const refreshWorkflowUi = (ctx: ExtensionContext): void => {
    const selected = selectedLink(configured.projectRoot, ctx);
    try {
      if (selected) {
        updateWorkflowStatusUi(ctx, restoreWorkflowStatusSummary(configured.projectRoot, selected));
        workflowUiVisible = true;
      } else if (workflowUiVisible) {
        clearWorkflowStatusUi(ctx);
        workflowUiVisible = false;
      }
    } catch {
      if (workflowUiVisible) clearWorkflowStatusUi(ctx);
      workflowUiVisible = false;
    }
  };
  await registerLinkedWorkflowCommandSurfaces(pi, configured.projectRoot, project.projectId, (ctx) => {
    refreshSelection(ctx);
    refreshWorkflowUi(ctx);
  }, runtimeOwnerNonce);

  // This handler is registered before lifecycle hooks so session restoration has
  // selected the exact linked authority before resume/input callbacks run.
  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const selected = selectedLink(configured.projectRoot, ctx);
    if (selected) {
      readActivationSnapshot(configured.projectRoot, selected.activationHash);
      pi.setActiveTools([...selected.tools]);
    } else {
      const stored = normalLink(configured.projectRoot, ctx);
      const baseline = stored?.normalTools ?? startupNormalTools;
      pi.setActiveTools([...baseline]);
      initializeNormalParent({
        configured: true, projectRoot: configured.projectRoot, projectId: project.projectId,
        piSessionId: ctx.sessionManager.getSessionId(), piSessionFile: sessionFile,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unselected",
        thinking: String(pi.getThinkingLevel()), activeTools: baseline,
      });
    }
    refreshSelection(ctx);
    refreshWorkflowUi(ctx);
  });
  pi.on("input", async (_event, ctx) => { refreshSelection(ctx); refreshWorkflowUi(ctx); });
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
