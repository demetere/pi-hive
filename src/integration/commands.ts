import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { HiveState } from "../core/types";
import { toggleTeamMode } from "../ui/tui/widget";
import { hiveTelemetryRegistryPath, hiveTelemetryServerPidPath } from "../engine/observability";
import { renderHiveDoctor } from "../engine/doctor";
import { killProcess, spawnManaged } from "../engine/process";

const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type DashboardPidFile = {
  pid?: number;
  host?: string;
  port?: number;
  url?: string;
  cwd?: string;
  startedAt?: string;
};

function readDashboardPidFile(): DashboardPidFile | null {
  try {
    return JSON.parse(readFileSync(hiveTelemetryServerPidPath(), "utf8")) as DashboardPidFile;
  } catch {
    return null;
  }
}

function writeDashboardPidFile(info: DashboardPidFile) {
  const path = hiveTelemetryServerPidPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`);
}

function removeDashboardPidFile() {
  try { rmSync(hiveTelemetryServerPidPath(), { force: true }); } catch { /* noop */ }
}

function killPid(pid: number | undefined, killed: Set<number>): void {
  if (!Number.isFinite(pid) || !pid || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, "SIGTERM");
    killed.add(pid);
  } catch { /* noop */ }
}

async function isHiveDashboard(host: string, port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: boolean; mode?: string; registry?: string; db?: string };
    return body.ok === true && body.mode === "global" && typeof body.registry === "string" && typeof body.db === "string";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function stopDashboardOnPort(state: HiveState, port: number, host = process.env.HIVE_TELEMETRY_HOST || "127.0.0.1"): Promise<number[]> {
  const killed = new Set<number>();

  if (state.obsServer?.proc && !state.obsServer.proc.killed) {
    const pid = killProcess(state.obsServer.proc);
    if (typeof pid === "number") killed.add(pid);
  }
  state.obsServer = undefined;

  const pidFile = readDashboardPidFile();
  if (pidFile?.port === port) killPid(pidFile.pid, killed);

  // Only kill a listener discovered by port scan after proving the HTTP server
  // is pi-hive. This avoids terminating an unrelated local process that happens
  // to be using the configured port.
  if (await isHiveDashboard(host, port)) {
    try {
      const out = execFileSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
      for (const raw of out.split("\n")) killPid(Number(raw.trim()), killed);
    } catch { /* lsof exits non-zero when no process is listening */ }
  }

  if (killed.size) {
    await sleep(300);
    removeDashboardPidFile();
  }
  return Array.from(killed);
}

export function registerCommands(pi: ExtensionAPI, state: HiveState) {
  pi.registerCommand("hive-toggle", {
    description: "Toggle normal chat / hive orchestrator mode",
    handler: async (_args: string, ctx: ExtensionContext) => toggleTeamMode(state, ctx),
  });

  pi.registerShortcut(Key.ctrlAlt("t"), {
    description: "Toggle normal chat / hive orchestrator mode",
    handler: async (ctx: ExtensionContext) => toggleTeamMode(state, ctx),
  });

  pi.registerCommand("hive-doctor", {
    description: "Run read-only pi-hive diagnostics for this workspace",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const result = renderHiveDoctor(state, ctx.cwd, EXTENSION_ROOT);
      if (ctx.hasUI) ctx.ui.notify(result.text, result.severity);
    },
  });

  pi.registerCommand("hive-observe", {
    description: "Restart/open the pi-hive telemetry dashboard",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!state.session) {
        if (ctx.hasUI) ctx.ui.notify("Hive session is not initialized yet.", "error");
        return;
      }
      const port = Number(process.env.HIVE_TELEMETRY_PORT || 43191);
      const host = process.env.HIVE_TELEMETRY_HOST || "127.0.0.1";
      const url = `http://${host}:${port}`;
      const killed = await stopDashboardOnPort(state, port, host);
      const serverPath = resolve(EXTENSION_ROOT, "src", "observability", "server", "index.ts");
      if (!existsSync(serverPath)) {
        if (ctx.hasUI) ctx.ui.notify(`Missing hive observability server: ${serverPath}`, "error");
        return;
      }
      const { proc } = spawnManaged("bun", [serverPath], {
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
      proc.on("error", (error: Error) => {
        if (ctx.hasUI) ctx.ui.notify(`Failed to start hive observability (is Bun installed?): ${error.message}`, "error");
      });
      state.obsServer = { proc, url, port };
      writeDashboardPidFile({ pid: proc.pid, host, port, url, cwd: ctx.cwd, startedAt: new Date().toISOString() });
      if (process.env.HIVE_TELEMETRY_NO_OPEN !== "1" && process.platform === "darwin") {
        spawnManaged("open", [url], { detached: true, stdio: "ignore" });
      }
      if (ctx.hasUI) ctx.ui.notify(`pi-hive telemetry restarted: ${url}${killed.length ? ` (stopped ${killed.length} old process${killed.length === 1 ? "" : "es"})` : ""}`, "info");
    },
  });

  pi.registerCommand("hive-observe-stop", {
    description: "Stop the pi-hive telemetry dashboard on the configured port",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const port = Number(process.env.HIVE_TELEMETRY_PORT || 43191);
      const host = process.env.HIVE_TELEMETRY_HOST || "127.0.0.1";
      const killed = await stopDashboardOnPort(state, port, host);
      if (ctx.hasUI) ctx.ui.notify(killed.length ? `Stopped pi-hive telemetry dashboard (${killed.join(", ")})` : `No pi-hive telemetry dashboard found on port ${port}`, "info");
    },
  });
}
