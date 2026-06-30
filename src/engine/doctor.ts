import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HiveState } from "../core/types";
import { HIVE_ROOT } from "../core/constants";
import { hiveTelemetryRegistryPath } from "./observability";

export type DoctorSeverity = "info" | "warning";

export interface HiveDoctorResult {
  text: string;
  severity: DoctorSeverity;
}

function checkLine(ok: boolean, message: string, warn = false): string {
  if (ok) return `pass: ${message}`;
  return `${warn ? "warn" : "fail"}: ${message}`;
}

function commandVersion(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function renderHiveDoctor(state: HiveState, cwd: string, extensionDir: string): HiveDoctorResult {
  const configPath = join(cwd, HIVE_ROOT, "hive-config.yaml");
  const dashboardIndex = join(extensionDir, "ui", "web", "dist", "index.html");
  const dashboardStamp = join(extensionDir, "ui", "web", "dist", ".build-hash");
  const observabilityServer = join(extensionDir, "src", "observability", "server.ts");
  const registryPath = hiveTelemetryRegistryPath();
  const bunVersion = commandVersion("bun", ["--version"]);

  const lines = [
    "pi-hive doctor",
    checkLine(existsSync(configPath), `Opt-in config ${existsSync(configPath) ? "present" : "missing"}: ${configPath}`),
    checkLine(Boolean(state.config), `Hive config ${state.config ? "loaded" : "not loaded"}`),
    checkLine(state.runtimes.size > 0, `Agent runtimes ${state.runtimes.size ? `${state.runtimes.size} loaded` : "not initialized"}`),
    checkLine(Boolean(state.session), `Session ${state.session ? state.session.sessionId : "not initialized"}`, true),
    checkLine(existsSync(observabilityServer), `Telemetry server ${existsSync(observabilityServer) ? "present" : "missing"}: ${observabilityServer}`),
    checkLine(Boolean(bunVersion), `Bun runtime ${bunVersion ? `available (${bunVersion})` : "not found; dashboard commands need Bun"}`, true),
    checkLine(existsSync(dashboardIndex), `Dashboard dist index ${existsSync(dashboardIndex) ? "present" : "missing"}`),
    checkLine(existsSync(dashboardStamp), `Dashboard build stamp ${existsSync(dashboardStamp) ? "present" : "missing"}`),
    checkLine(state.skillRegistry.length > 0, `Skill registry ${state.skillRegistry.length ? `${state.skillRegistry.length} skill(s)` : "empty or not discovered"}`, true),
    checkLine(Boolean(state.sddStatus?.configured), `SDD/OpenSpec ${state.sddStatus?.configured ? "configured" : "not configured"}`, true),
    `info: Telemetry registry path: ${registryPath}`,
  ];

  if (!existsSync(configPath)) lines.push(`remedy: create ${HIVE_ROOT}/hive-config.yaml to activate pi-hive in this project`);
  if (!bunVersion) lines.push("remedy: install Bun or avoid /hive-observe dashboard commands");
  if (!existsSync(dashboardIndex) || !existsSync(dashboardStamp)) lines.push("remedy: run just build-dashboard before packaging");

  return {
    text: lines.join("\n"),
    severity: lines.some((line) => line.startsWith("fail:")) ? "warning" : "info",
  };
}
