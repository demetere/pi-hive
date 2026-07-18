import { beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_TELEMETRY_DB ||= join(mkdtempSync(join(tmpdir(), "pi-hive-runtime-logs-db-")), "telemetry.db");

let runtime: typeof import("../../src/observability/server/runtime");

beforeAll(async () => {
  runtime = await import("../../src/observability/server/runtime");
});

function message(role: string, content: unknown, timestamp: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: "message", timestamp, message: { role, content, ...extra } });
}

test("runtime serves bounded main/worker logs and deletes tracked source artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-runtime-logs-"));
  const telemetryLog = join(dir, "hive-events.jsonl");
  const stateFile = join(dir, "hive-state.json");
  const conversationLog = join(dir, "conversation.jsonl");
  const workerLog = join(dir, "builder.jsonl");
  const workerArchive = join(dir, "builder.run-1.jsonl");
  writeFileSync(telemetryLog, "");
  writeFileSync(`${telemetryLog}.1.gz`, "archive");
  writeFileSync(`${telemetryLog}.lock`, "lock");
  writeFileSync(conversationLog, [
    message("user", [{ type: "text", text: "question" }], "2026-07-15T00:00:00.000Z"),
    message("assistant", [{ type: "thinking", thinking: "private" }, { type: "text", text: "answer" }], "2026-07-15T00:00:01.000Z"),
  ].join("\n") + "\n");
  writeFileSync(workerLog, [
    message("assistant", [{ type: "thinking", thinking: "worker thought" }, { type: "text", text: "worker answer" }], "2026-07-15T00:00:02.000Z"),
    message("assistant", [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } }], "2026-07-15T00:00:03.000Z"),
    message("toolResult", "ok", "2026-07-15T00:00:04.000Z", { toolCallId: "t1", toolName: "read" }),
  ].join("\n") + "\n");
  writeFileSync(workerArchive, message("assistant", "archived", "2026-07-14T00:00:00.000Z") + "\n");
  writeFileSync(stateFile, JSON.stringify({
    updated_at: "2026-07-15T00:00:05.000Z",
    session_id: "runtime-logs",
    project_id: "project-runtime-logs",
    project_root: dir,
    project_label: "Runtime logs",
    cwd: dir,
    session_dir: dir,
    telemetry_log: telemetryLog,
    conversation_log: conversationLog,
    active_runs: 1,
    topologies: {
      active: "hive",
      hive: { orchestrator: { name: "Main" }, agents: [{ name: "Builder" }] },
      planning: { orchestrator: { name: "Planner" }, agents: [] },
    },
    agents: [
      { name: "Main", role: "orchestrator", status: "running", sessionFile: conversationLog },
      { name: "Builder", role: "member", status: "done", sessionFile: workerLog },
      { name: "No File", role: "member", status: "idle" },
    ],
  }));

  runtime.addSource(telemetryLog, {
    session_id: "runtime-logs", project_id: "project-runtime-logs", project_root: dir,
    cwd: dir, session_dir: dir, conversation_log: conversationLog, state_file: stateFile,
  });

  expect(runtime.sourcePaths()).toContain(telemetryLog);
  expect(runtime.allSnapshots().some((snapshot) => snapshot.session_id === "runtime-logs")).toBe(true);
  expect(runtime.allSnapshots({ offset: -2, limit: 0 }).length).toBeGreaterThanOrEqual(1);
  expect(runtime.sourceLogForSession("runtime-logs")).toBe(telemetryLog);
  expect(runtime.sourceLogForSession("missing")).toBeUndefined();

  expect(runtime.agentLogPath("missing", "Builder")).toEqual({});
  expect(runtime.agentLogPath("runtime-logs", "Main").main).toBe(true);
  expect(runtime.agentLogPath("runtime-logs", "Orchestrator").main).toBe(true);
  expect(runtime.agentLogPath("runtime-logs", "Builder").file).toBe(workerLog);
  expect(runtime.agentLogPath("runtime-logs", "No File").status).toBe("idle");
  expect(runtime.agentLogPath("runtime-logs", "Unknown")).toEqual({ status: undefined });

  const unknown = runtime.readAgentLog("missing", "Builder", 0, "");
  expect(unknown.exists).toBe(false);
  const main = runtime.readAgentLog("runtime-logs", "Main", 0, "");
  expect(main.exists).toBe(true);
  expect(main.run).toBe("current");
  expect(main.entries.length).toBeGreaterThan(0);
  const worker = runtime.readAgentLog("runtime-logs", "Builder", 0, "current");
  expect(worker.exists).toBe(true);
  expect(worker.runs.length).toBe(2);
  expect(worker.entries.length).toBeGreaterThan(0);
  expect(runtime.readAgentLog("runtime-logs", "Builder", 1, "run-1").run).toBe("run-1");
  expect(runtime.readAgentLog("runtime-logs", "Builder", 0, "missing", 10).exists).toBe(true);

  expect(Array.isArray(runtime.recentThinking("missing"))).toBe(true);
  const storage = runtime.telemetryStorage("project-runtime-logs", 30);
  expect(storage.sourceLogs.files).toBeGreaterThanOrEqual(1);
  expect(runtime.deleteProjectSourceLogs("")).toEqual({ files: 0, bytes: 0 });
  const deleted = runtime.deleteProjectSourceLogs("project-runtime-logs");
  expect(deleted.files).toBe(2);
  expect(deleted.bytes).toBeGreaterThan(0);
  expect(existsSync(telemetryLog)).toBe(false);
  expect(existsSync(stateFile)).toBe(true);
  expect(existsSync(`${telemetryLog}.lock`)).toBe(true);
});
