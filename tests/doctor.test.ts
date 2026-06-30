import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderHiveDoctor } from "../src/engine/doctor.ts";
import type { HiveState } from "../src/core/types.ts";

function state(overrides: Partial<HiveState> = {}): HiveState {
  return {
    pi: {} as any,
    config: { orchestrator: { name: "Orchestrator", path: "o.md" }, agents: [], sharedContext: [], settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 1, distiller: { enabled: false, model: "", conversationLines: 10 } } },
    session: { sessionId: "test-session", sessionDir: "/tmp/session", conversationLog: "/tmp/session/conversation.jsonl", observabilityLog: "/tmp/session/hive-events.jsonl", activeTeam: "all" },
    runtimes: new Map([["orchestrator", {} as any]]),
    widgetCtx: null,
    activeRuns: 0,
    teamMode: "team",
    normalToolNames: [],
    streamStartMs: 0,
    streamedChars: 0,
    lastTokPerSec: 0,
    skillRegistry: [{ name: "review", path: "skills/review/SKILL.md", description: "Review", scope: "project" }],
    sddStatus: { configured: true, activeChanges: [], suggestedRouting: [] },
    obsSeq: 0,
    ...overrides,
  };
}

test("renderHiveDoctor reports package assets and workspace state", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-doctor-cwd-"));
  const extensionDir = mkdtempSync(join(tmpdir(), "pi-hive-doctor-ext-"));
  mkdirSync(join(cwd, ".pi", "hive"), { recursive: true });
  mkdirSync(join(extensionDir, "src", "observability"), { recursive: true });
  mkdirSync(join(extensionDir, "ui", "web", "dist"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), "orchestrator:\n  name: Orchestrator\n");
  writeFileSync(join(extensionDir, "src", "observability", "server.ts"), "export {};\n");
  writeFileSync(join(extensionDir, "ui", "web", "dist", "index.html"), "<div></div>\n");
  writeFileSync(join(extensionDir, "ui", "web", "dist", ".build-hash"), "hash\n");

  const result = renderHiveDoctor(state(), cwd, extensionDir);

  assert.equal(result.severity, "info");
  assert.match(result.text, /pi-hive doctor/);
  assert.match(result.text, /pass: Opt-in config present/);
  assert.match(result.text, /pass: Telemetry server present/);
  assert.match(result.text, /pass: Dashboard dist index present/);
});

test("renderHiveDoctor includes remedies for missing required assets", () => {
  const result = renderHiveDoctor(state({ config: null, runtimes: new Map(), session: null, skillRegistry: [], sddStatus: null }), "/missing-cwd", "/missing-extension");

  assert.equal(result.severity, "warning");
  assert.match(result.text, /fail: Opt-in config missing/);
  assert.match(result.text, /remedy: create \.pi\/hive\/hive-config\.yaml/);
  assert.match(result.text, /remedy: run just build-dashboard/);
});
