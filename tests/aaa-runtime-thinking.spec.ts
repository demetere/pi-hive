import { beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, unwatchFile } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

process.env.HIVE_TELEMETRY_CAPTURE_THINKING = "1";
process.env.HIVE_TELEMETRY_DB ||= join(mkdtempSync(join(tmpdir(), "pi-hive-thinking-db-")), "telemetry.db");

let runtime: typeof import("../src/observability/server/runtime");
let config: typeof import("../src/observability/server/config");

beforeAll(async () => {
  config = await import("../src/observability/server/config");
  runtime = await import("../src/observability/server/runtime");
});

function thinkingMessage(ts: string, text: string, usage: Record<string, number>) {
  return JSON.stringify({
    type: "message", timestamp: ts,
    message: { role: "assistant", content: [{ type: "thinking", thinking: text }, { type: "text", text: "answer" }], usage },
  });
}

test("runtime incrementally materializes bounded thinking tails", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-thinking-runtime-"));
  const log = join(dir, "hive-events.jsonl");
  const stateFile = join(dir, "hive-state.json");
  const worker = join(dir, "thinker.jsonl");
  writeFileSync(log, "");
  writeFileSync(worker, [
    thinkingMessage("2026-07-15T03:00:00.000Z", "first thought", { reasoning: 5, output: 9 }),
    JSON.stringify({ type: "message", timestamp: "2026-07-15T03:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "no thought" }] } }),
  ].join("\n") + "\n");
  writeFileSync(stateFile, JSON.stringify({
    updated_at: "2026-07-15T03:00:02.000Z", session_id: "runtime-thinking", cwd: dir,
    agents: [
      { name: "Thinker", status: "done", sessionFile: worker },
      { name: "Missing", status: "idle", sessionFile: join(dir, "missing.jsonl") },
      { name: "No File", status: "idle" },
    ],
  }));
  runtime.addSource(log, { session_id: "runtime-thinking", cwd: dir, state_file: stateFile });

  const first = runtime.recentThinking("runtime-thinking", 1, 10);
  expect(first).toHaveLength(1);
  expect(first[0].text).toBe("first thought");
  expect(first[0].tokens).toBe(5);

  appendFileSync(worker, thinkingMessage("2026-07-15T03:00:03.000Z", "second thought", { output: 7 }) + "\n");
  const second = runtime.recentThinking("runtime-thinking", 2, 1);
  expect(second).toHaveLength(1);
  expect(second[0].text).toBe("second thought");
  expect(second[0].tokens).toBe(7);
  expect(runtime.recentThinking("missing")).toEqual([]);
});

test("runtime startup reads the registry once and remains idempotent", () => {
  mkdirSync(dirname(config.REGISTRY_PATH), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-registry-runtime-"));
  const log = join(dir, "events.jsonl");
  writeFileSync(log, "");
  writeFileSync(config.REGISTRY_PATH, [
    "{bad json",
    JSON.stringify({ telemetry_log: log, session_id: "old", cwd: dir }),
    JSON.stringify({ telemetry_log: log, session_id: "registry-runtime", cwd: dir }),
    JSON.stringify({ session_id: "no-log" }),
    "",
  ].join("\n"));

  runtime.startTelemetryRuntime();
  runtime.startTelemetryRuntime();
  expect(runtime.sourcePaths()).toContain(log);
  unwatchFile(config.REGISTRY_PATH);
});
