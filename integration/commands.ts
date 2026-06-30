import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { HiveState } from "../core/types";
import { toggleTeamMode } from "../ui/tui/widget";
import { openStatusModal } from "../ui/tui/status-modal";
import { hiveTelemetryRegistryPath } from "../engine/observability";

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function stopDashboardOnPort(state: HiveState, port: number): Promise<number[]> {
  const killed = new Set<number>();

  if (state.obsServer?.proc && !state.obsServer.proc.killed) {
    try {
      state.obsServer.proc.kill();
      if (typeof state.obsServer.proc.pid === "number") killed.add(state.obsServer.proc.pid);
    } catch { /* noop */ }
  }
  state.obsServer = undefined;

  try {
    const out = execFileSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    for (const raw of out.split("\n")) {
      const pid = Number(raw.trim());
      if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue;
      try {
        process.kill(pid, "SIGTERM");
        killed.add(pid);
      } catch { /* noop */ }
    }
  } catch { /* lsof exits non-zero when no process is listening */ }

  if (killed.size) await sleep(300);
  return Array.from(killed);
}

export function registerCommands(pi: ExtensionAPI, state: HiveState) {
  pi.registerCommand("hive-toggle", {
    description: "Toggle normal chat / hive orchestrator mode",
    handler: async (_args, ctx) => toggleTeamMode(state, ctx),
  });

  pi.registerShortcut(Key.ctrlAlt("t"), {
    description: "Toggle normal chat / hive orchestrator mode",
    handler: async (ctx) => toggleTeamMode(state, ctx),
  });

  pi.registerCommand("hive-status", {
    description: "Open the hive status canvas (live hierarchy + per-agent stats)",
    handler: async (_args, ctx) => {
      state.widgetCtx = ctx;
      openStatusModal(state, ctx);
    },
  });

  pi.registerCommand("hive-observe", {
    description: "Restart/open the pi-hive telemetry dashboard",
    handler: async (_args, ctx) => {
      if (!state.session) {
        ctx.ui.notify("Hive session is not initialized yet.", "error");
        return;
      }
      const port = Number(process.env.HIVE_TELEMETRY_PORT || 43191);
      const host = process.env.HIVE_TELEMETRY_HOST || "127.0.0.1";
      const url = `http://${host}:${port}`;
      const killed = await stopDashboardOnPort(state, port);
      const serverPath = resolve(EXTENSION_DIR, "observability", "server.ts");
      if (!existsSync(serverPath)) {
        ctx.ui.notify(`Missing hive observability server: ${serverPath}`, "error");
        return;
      }
      const proc = spawn("bun", [serverPath], {
        cwd: ctx.cwd,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          HIVE_TELEMETRY_PORT: String(port),
          HIVE_TELEMETRY_HOST: host,
          HIVE_TELEMETRY_LOG: state.session.observabilityLog,
          HIVE_TELEMETRY_REGISTRY: hiveTelemetryRegistryPath(),
          HIVE_CONVERSATION_LOG: state.session.conversationLog,
          HIVE_SESSION_ID: state.session.sessionId,
          HIVE_PROJECT_CWD: ctx.cwd,
        },
      });
      proc.on("error", (error) => {
        ctx.ui.notify(`Failed to start hive observability (is Bun installed?): ${error.message}`, "error");
      });
      proc.unref();
      state.obsServer = { proc, url, port };
      if (process.env.HIVE_TELEMETRY_NO_OPEN !== "1" && process.platform === "darwin") {
        try { spawn("open", [url], { detached: true, stdio: "ignore" }).unref(); } catch { /* noop */ }
      }
      ctx.ui.notify(`pi-hive telemetry restarted: ${url}${killed.length ? ` (stopped ${killed.length} old process${killed.length === 1 ? "" : "es"})` : ""}`, "info");
    },
  });

  pi.registerCommand("hive-observe-stop", {
    description: "Stop the pi-hive telemetry dashboard on the configured port",
    handler: async (_args, ctx) => {
      const port = Number(process.env.HIVE_TELEMETRY_PORT || 43191);
      const killed = await stopDashboardOnPort(state, port);
      ctx.ui.notify(killed.length ? `Stopped pi-hive telemetry dashboard (${killed.join(", ")})` : `No pi-hive telemetry dashboard found on port ${port}`, "info");
    },
  });
}
