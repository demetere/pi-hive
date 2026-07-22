/**
 * Hive orchestration extension for Pi.
 *
 * Installed globally and auto-discovered for every project, but it only
 * activates when the current project opts in by providing a
 * `.pi/hive/hive-config.yaml`. Without that file the extension registers
 * nothing — no tools, no commands, no hooks — so non-hive projects are
 * completely unaffected.
 *
 * When active, it loads a hierarchical team from `.pi/hive/hive-config.yaml`,
 * gives the visible session only delegation/coordination tools (it routes,
 * never edits), renders a live team tree, and records a JSONL conversation log
 * across the orchestrator and workers.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HIVE_ROOT } from "./src/core/constants";


// The project opts in by configuring a hive. We check at load time (the
// extension module runs in the project's cwd) so projects without a hive get
// zero registrations — no /hive commands, no tools, no hooks.
function projectHasHive(): boolean {
  return existsSync(join(process.cwd(), HIVE_ROOT, "hive-config.yaml"));
}

export const WORKFLOW_UI_REFRESH_BOUNDARIES = Object.freeze(["session_start", "input", "message_end", "turn_end", "command-settled"] as const);

/** Testable production wiring seam; constructing services has no process side effects. */
export async function registerLinkedWorkflowCommandSurfaces(pi: ExtensionAPI, projectRoot: string, projectId: string, onSettled?: (ctx: ExtensionCommandContext) => void): Promise<void> {
  const [{ registerWorkflowCommands }, { createLinkedWorkflowCommandServices, createPiWorkflowRuntimeCommandAuthority }] = await Promise.all([
    import("./src/integration/workflow-commands"),
    import("./src/integration/workflow-command-service"),
  ]);
  registerWorkflowCommands(pi, createLinkedWorkflowCommandServices(pi, projectRoot, projectId, createPiWorkflowRuntimeCommandAuthority()), onSettled);
}

export default async function hiveExtension(pi: ExtensionAPI) {
  if (!projectHasHive()) return;

  const [stateModule, toolsModule, commandsModule, hooksModule, configModule, projectIdentityModule, sessionsModule, workflowWidgetModule] = await Promise.all([
    import("./src/engine/state"),
    import("./src/agents/tools"),
    import("./src/integration/commands"),
    import("./src/integration/hooks"),
    import("./src/config/index"),
    import("./src/shared/project-identity"),
    import("./src/workflows/sessions"),
    import("./src/ui/tui/workflow-widget"),
  ]);

  // Resolve schema ownership before registering either legacy or workflow
  // surfaces so legacy hooks can remain installed through W26 without rendering
  // fixed-mode chrome in schema-v1 projects.
  const configured = configModule.loadConfigProject(process.cwd());
  const workflowConfigured = configured.status === "configured";
  const state = stateModule.createState(pi);
  state.workflowConfigured = workflowConfigured;
  toolsModule.registerTools(pi, state);
  commandsModule.registerCommands(pi, state, { workflowConfigured });
  hooksModule.registerHooks(pi, state, { workflowConfigured });

  // A legacy hive-config remains owned by the existing modes through W27. The
  // workflow command surfaces are added only when the same opted-in file also
  // satisfies the schema-v1 workflow configuration contract.
  if (configured.status !== "configured") return;
  const project = projectIdentityModule.resolveProjectIdentity(configured.projectRoot);
  const refreshWorkflowUi = (ctx: Parameters<typeof workflowWidgetModule.updateWorkflowStatusUi>[0]): void => {
    try {
      const selected = sessionsModule.listSessionLinks(configured.projectRoot).find((entry) => entry.kind === "workflow" && entry.piSessionId === ctx.sessionManager.getSessionId());
      if (selected?.kind === "workflow") workflowWidgetModule.updateWorkflowStatusUi(ctx, workflowWidgetModule.restoreWorkflowStatusSummary(configured.projectRoot, selected));
      else workflowWidgetModule.clearWorkflowStatusUi(ctx);
    } catch {
      workflowWidgetModule.clearWorkflowStatusUi(ctx);
    }
  };
  await registerLinkedWorkflowCommandSurfaces(pi, configured.projectRoot, project.projectId, refreshWorkflowUi);

  // W26 coexists with the legacy modes. Link and render workflow sessions only
  // after Pi supplies a session-bound context; the extension factory itself
  // still starts no process and performs no unconfigured registration.
  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const selected = sessionsModule.listSessionLinks(configured.projectRoot).find((entry) => entry.kind === "workflow" && entry.piSessionId === ctx.sessionManager.getSessionId());
    if (!selected) sessionsModule.initializeNormalParent({
      configured: true,
      projectRoot: configured.projectRoot,
      projectId: project.projectId,
      piSessionId: ctx.sessionManager.getSessionId(),
      piSessionFile: sessionFile,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unselected",
      thinking: String(pi.getThinkingLevel()),
      activeTools: pi.getActiveTools(),
    });
    refreshWorkflowUi(ctx);
  });
  // Refresh from the durable journal at bounded Pi lifecycle boundaries. These
  // hooks create no watcher or long-lived process and survive session restore.
  pi.on("input", async (_event, ctx) => { refreshWorkflowUi(ctx); });
  pi.on("message_end", async (_event, ctx) => { refreshWorkflowUi(ctx); });
  pi.on("turn_end", async (_event, ctx) => { refreshWorkflowUi(ctx); });
  pi.on("session_shutdown", async (_event, ctx) => workflowWidgetModule.clearWorkflowStatusUi(ctx));
}
