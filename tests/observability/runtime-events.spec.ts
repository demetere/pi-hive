import { beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_TELEMETRY_DB ||= join(mkdtempSync(join(tmpdir(), "pi-hive-runtime-events-db-")), "telemetry.db");

let runtime: typeof import("../../src/observability/server/runtime");

beforeAll(async () => {
  runtime = await import("../../src/observability/server/runtime");
});

function event(seq: number, type: string, payload: Record<string, unknown>) {
  return JSON.stringify({
    event_id: `runtime-event-${seq}`,
    session_id: "runtime-events",
    seq,
    ts: `2026-07-15T01:00:${String(seq).padStart(2, "0")}.000Z`,
    type,
    actor: "Builder",
    cwd: "/runtime-events",
    pid: 1,
    payload,
  });
}

test("runtime materializes delegation, tool, and model event variants", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-runtime-events-"));
  const log = join(dir, "hive-events.jsonl");
  const rows = [
    event(1, "delegation_start", { to: "Builder", from: "Orchestrator", model: { provider: "provider", id: "model" }, thinkingLevels: ["off", "high"] }),
    event(2, "delegation_start", { to: "Sparse", from: "Orchestrator", model: "inherit", thinkingLevels: [] }),
    event(3, "delegation_end", {
      from: "Builder", to: "Orchestrator", elapsedMs: 25, delegationsSchema: 1,
      delta: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 3, reasoningTokens: 2, costUsd: 0.1 },
      type: "done", stopReason: "stop", models: ["provider/old", "provider/model"],
    }),
    event(4, "delegation_end", {
      from: "Legacy", to: "Orchestrator", inputTokens: 7, outputTokens: 3, costUsd: 0.2,
      runtime: { cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 4 }, model: "provider/legacy",
      type: "error",
    }),
    event(5, "worker_tool_start", { agent: "Builder", toolName: "read", toolCallId: "worker-tool", args: "{}" }),
    event(6, "worker_tool_end", { toolCallId: "worker-tool", resultPreview: "ok", isError: false, durationMs: 12 }),
    event(7, "orchestrator_tool_start", { agent: "Orchestrator", toolName: "bash", toolCallId: "orch-tool", args: "pwd" }),
    event(8, "orchestrator_tool_end", { toolCallId: "orch-tool", resultPreview: "failed", isError: true }),
    event(9, "model_catalog", { models: [
      null,
      { provider: "", modelId: "bad" },
      { provider: "provider", modelId: "catalog", name: "Catalog", api: "responses", reasoning: true, thinkingLevels: ["low", "high"], contextWindow: 100_000, maxTokens: 8_000, costRates: { input: 1, output: 2 } },
      { provider: "provider", modelId: "minimal", reasoning: false, thinkingLevels: "unknown", contextWindow: 0, maxTokens: 0 },
    ] }),
    event(10, "review_verdict", { changeId: " add-runtime-coverage ", reviewer: "Reviewer", verdict: "green", summary: "ready", evidence: ["tests"], concerns: [], blockers: [] }),
    event(11, "review_verdict", { changeId: "", verdict: "red" }),
    event(12, "delegation_progress", { from: "Builder", text: "ignored" }),
  ];
  writeFileSync(log, `${rows.join("\n")}\n`);
  runtime.addSource(log, { session_id: "runtime-events", cwd: "/runtime-events" });

  const delegations = runtime.queryDelegations({ session: "runtime-events" });
  expect(delegations.length).toBe(2);
  expect(delegations.some((row) => row.schemaVersion === 1 && row.inputTokens === 10)).toBe(true);
  expect(delegations.some((row) => row.schemaVersion === 0 && row.reasoningTokens === 4)).toBe(true);

  const tools = runtime.queryToolCalls({ session: "runtime-events" });
  expect(tools.length).toBe(2);
  expect(tools.find((row) => row.toolCallId === "worker-tool")?.durationMs).toBe(12);
  expect(tools.find((row) => row.toolCallId === "orch-tool")?.isError).toBe(true);

  const models = runtime.listModels(true);
  expect(models.some((model) => model.provider === "provider" && model.modelId === "catalog")).toBe(true);
  expect(models.some((model) => model.provider === "provider" && model.modelId === "model" && model.thinkingLevels?.includes("high"))).toBe(true);
  expect(runtime.queryEvents({ session: "runtime-events" }).some((row) => row.type === "delegation_progress")).toBe(false);
});

test("runtime prune removes stale sessions and source watchers through one path", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-runtime-prune-"));
  const log = join(dir, "hive-events.jsonl");
  writeFileSync(log, `${JSON.stringify({
    event_id: "runtime-prune-old", session_id: "runtime-prune", seq: 1,
    ts: "2010-01-01T00:00:00.000Z", type: "user_message", actor: "User", pid: 1,
    cwd: dir, payload: { text: "old" },
  })}\n`);
  runtime.addSource(log, { session_id: "runtime-prune", cwd: dir });
  expect(runtime.sourcePaths()).toContain(log);
  const pruned = runtime.pruneTelemetry("2015-01-01T00:00:00.000Z");
  expect(pruned.events).toBeGreaterThanOrEqual(1);
  expect(pruned.sessions).toBeGreaterThanOrEqual(1);
  expect(runtime.sourcePaths()).not.toContain(log);
  expect(runtime.deleteSessions([])).toBe(0);
  expect(runtime.deleteProject("missing-project")).toBe(0);
});

test("snapshot topology fallback loads both configured teams and caches the result", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-runtime-config-topology-"));
  const agents = join(cwd, ".pi", "hive", "agents");
  mkdirSync(agents, { recursive: true });
  const prompt = (type: string) => `---\nmodel: provider/model\nthinking: off\nagent-type: ${type}\n---\nPrompt.\n`;
  writeFileSync(join(agents, "planner.md"), prompt("planner"));
  writeFileSync(join(agents, "lead.md"), prompt("lead"));
  writeFileSync(join(agents, "coder.md"), prompt("coder"));
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
settings:
  telemetry:
    enabled: false
  distiller:
    enabled: false
planning:
  main:
    name: Planner
    path: .pi/hive/agents/planner.md
  agents: []
hive:
  main:
    name: Lead
    path: .pi/hive/agents/lead.md
  agents:
    - name: Coder
      path: .pi/hive/agents/coder.md
      domain:
        - path: src
          read: true
          upsert: true
          delete: false
`);
  const log = join(cwd, "hive-events.jsonl");
  const stateFile = join(cwd, "hive-state.json");
  writeFileSync(log, "");
  writeFileSync(stateFile, JSON.stringify({
    updated_at: "2026-07-15T02:00:00.000Z",
    session_id: "runtime-config-topology",
    cwd,
    topology: { orchestrator: { name: "Planner" }, agents: [] },
    agents: [],
  }));
  runtime.addSource(log, { session_id: "runtime-config-topology", cwd, state_file: stateFile });

  const first = runtime.allSnapshots().find((snapshot) => snapshot.session_id === "runtime-config-topology")!;
  expect(first.topologies?.active).toBe("planning");
  expect(first.topologies?.planning?.orchestrator?.name).toBe("Planner");
  expect(first.topologies?.hive?.orchestrator?.name).toBe("Lead");
  expect(first.topologies?.hive?.agents?.[0].name).toBe("Coder");
  expect(first.topologies?.hive?.agents?.[0].domain).toEqual(["src"]);

  const cached = runtime.allSnapshots().find((snapshot) => snapshot.session_id === "runtime-config-topology")!;
  expect(cached.topologies?.active).toBe("planning");
});
