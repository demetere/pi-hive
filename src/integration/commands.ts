import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { HiveState } from "../core/types";
import { applyMode, cycleMode } from "../ui/tui/widget";
import { renderHiveDoctor } from "../engine/doctor";
import { ensureDashboard, stopDashboard } from "../engine/dashboard";
import { changeExists, hasTasks, listChangeIds, readTasks } from "../engine/plan-store";
import { truncateMiddle } from "../core/utils";

const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function registerCommands(pi: ExtensionAPI, state: HiveState) {
  // Three explicit mode commands + a cycle key (normal → plan → hive → normal).
  pi.registerCommand("hive-normal", {
    description: "Switch to normal Pi chat (no hive, no enforcement)",
    handler: async (_args: string, ctx: ExtensionContext) => applyMode(state, ctx, "normal"),
  });
  pi.registerCommand("hive-plan-mode", {
    description: "Switch to plan mode — planning team produces full specs",
    handler: async (_args: string, ctx: ExtensionContext) => applyMode(state, ctx, "plan"),
  });
  pi.registerCommand("hive", {
    description: "Switch to hive mode — execution team builds the specs",
    handler: async (_args: string, ctx: ExtensionContext) => applyMode(state, ctx, "hive"),
  });
  // Back-compat alias: /hive-toggle now cycles through the three modes.
  pi.registerCommand("hive-toggle", {
    description: "Cycle session mode: normal → plan → hive → normal",
    handler: async (_args: string, ctx: ExtensionContext) => cycleMode(state, ctx),
  });

  pi.registerShortcut(Key.ctrlAlt("t"), {
    description: "Cycle session mode: normal → plan → hive → normal",
    handler: async (ctx: ExtensionContext) => cycleMode(state, ctx),
  });

  pi.registerCommand("hive-doctor", {
    description: "Run read-only pi-hive diagnostics for this workspace",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const result = renderHiveDoctor(state, ctx.cwd, EXTENSION_ROOT);
      if (ctx.hasUI) ctx.ui.notify(result.text, result.severity);
    },
  });

  pi.registerCommand("hive-execute", {
    description: "Execute a plan change's tasks.md through the hive (usage: /hive-execute <change-id>)",
    getArgumentCompletions: (prefix: string) => {
      const cwd = state.widgetCtx?.cwd || process.cwd();
      return listChangeIds(cwd)
        .filter((id) => id.startsWith(prefix))
        .map((id) => ({ value: id, label: id }));
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const changeId = args.trim().split(/\s+/)[0] || "";
      if (!changeId) {
        const available = listChangeIds(ctx.cwd);
        if (ctx.hasUI) ctx.ui.notify(`Usage: /hive-execute <change-id>. Available: ${available.join(", ") || "none (create one first)"}`, "warning");
        return;
      }
      if (!changeExists(ctx.cwd, changeId)) {
        if (ctx.hasUI) ctx.ui.notify(`No plan change "${changeId}" under .pi/hive/plans/. Available: ${listChangeIds(ctx.cwd).join(", ") || "none"}`, "error");
        return;
      }
      if (!hasTasks(ctx.cwd, changeId)) {
        if (ctx.hasUI) ctx.ui.notify(`Change "${changeId}" has no tasks.md yet. Complete the planning gates (proposal → requirements → design → tasks) first.`, "error");
        return;
      }
      // Select the change so delegations are scoped to it, ensure HIVE (execution)
      // mode is active, then drive execution via a user turn. The main session
      // reads the tasks and delegates to coder/tester leads.
      state.activeChangeId = changeId;
      if (state.mode !== "hive") applyMode(state, ctx, "hive", { notify: false });
      const tasks = truncateMiddle(readTasks(ctx.cwd, changeId), 12_000);
      pi.sendUserMessage(
        `Execute the approved plan for change "${changeId}" (.pi/hive/plans/${changeId}/). This is the active change; delegate each task to the appropriate coder/tester lead and record implementation evidence. Do not edit files yourself.\n\n## tasks.md\n${tasks}`,
      );
      if (ctx.hasUI) ctx.ui.notify(`Executing plan "${changeId}" — driving the hive from tasks.md.`, "info");
    },
  });

  pi.registerCommand("hive-plan", {
    description: "List plan changes, or show the active one (usage: /hive-plan [change-id])",
    handler: async (args: string, ctx: ExtensionContext) => {
      const requested = args.trim().split(/\s+/)[0] || "";
      const available = listChangeIds(ctx.cwd);
      if (requested) {
        if (!changeExists(ctx.cwd, requested)) {
          if (ctx.hasUI) ctx.ui.notify(`No plan change "${requested}". Available: ${available.join(", ") || "none"}`, "error");
          return;
        }
        state.activeChangeId = requested;
        if (ctx.hasUI) ctx.ui.notify(`Active plan change set to "${requested}".`, "info");
        return;
      }
      const lines = available.length
        ? available.map((id) => `- ${id}${state.activeChangeId === id ? " (active)" : ""}${hasTasks(ctx.cwd, id) ? " — tasks ready" : ""}`).join("\n")
        : "No plan changes yet. Ask the orchestrator to plan a change, or a lead to run plan_new.";
      if (ctx.hasUI) ctx.ui.notify(`Plan changes under .pi/hive/plans/:\n${lines}`, "info");
    },
  });

  pi.registerCommand("hive-observe", {
    description: "Restart and open the global pi-hive telemetry dashboard",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!state.session) {
        if (ctx.hasUI) ctx.ui.notify("Hive session is not initialized yet.", "error");
        return;
      }
      // Explicit command: force a clean restart and open the browser tab.
      const result = await ensureDashboard(state, ctx, EXTENSION_ROOT, { open: true, forceRestart: true });
      if (!ctx.hasUI) return;
      if (result.running) ctx.ui.notify(`pi-hive telemetry restarted: ${result.url}`, "info");
      else ctx.ui.notify(result.bunMissing ? "Cannot start dashboard: Bun is not installed." : `Failed to start dashboard: ${result.error || "unknown error"}`, "error");
    },
  });

  pi.registerCommand("hive-observe-stop", {
    description: "Stop the global pi-hive telemetry dashboard",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const killed = await stopDashboard(state);
      if (ctx.hasUI) ctx.ui.notify(killed.length ? `Stopped pi-hive telemetry dashboard (${killed.join(", ")})` : "No pi-hive telemetry dashboard was running.", "info");
    },
  });
}
