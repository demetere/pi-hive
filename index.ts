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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HIVE_ROOT } from "./src/core/constants";


// The project opts in by configuring a hive. We check at load time (the
// extension module runs in the project's cwd) so projects without a hive get
// zero registrations — no /hive commands, no tools, no hooks.
function projectHasHive(): boolean {
  return existsSync(join(process.cwd(), HIVE_ROOT, "hive-config.yaml"));
}

export default async function hiveExtension(pi: ExtensionAPI) {
  if (!projectHasHive()) return;

  const [stateModule, toolsModule, commandsModule, hooksModule] = await Promise.all([
    import("./src/engine/state"),
    import("./src/agents/tools"),
    import("./src/integration/commands"),
    import("./src/integration/hooks"),
  ]);

  const state = stateModule.createState(pi);
  toolsModule.registerTools(pi, state);
  commandsModule.registerCommands(pi, state);
  hooksModule.registerHooks(pi, state);
}
