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
    session: { sessionId: "test-session", sessionDir: "/tmp/session", conversationLog: "/tmp/session/conversation.jsonl", observabilityLog: "/tmp/session/hive-events.jsonl" },
    runtimes: new Map([["orchestrator", {} as any]]),
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: { configured: true, activeChanges: [], suggestedRouting: [] },
    obsSeq: 0,
    ...overrides,
  };
}

test("renderHiveDoctor reports package assets and workspace state", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-doctor-cwd-"));
  const extensionDir = mkdtempSync(join(tmpdir(), "pi-hive-doctor-ext-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  mkdirSync(join(extensionDir, "src", "observability", "server"), { recursive: true });
  mkdirSync(join(extensionDir, "ui", "web", "dist"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "agents", "orchestrator.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: lead\n---\nLead.");
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), "orchestrator:\n  name: Orchestrator\n  path: .pi/hive/agents/orchestrator.md\n");
  writeFileSync(join(extensionDir, "src", "observability", "server", "index.ts"), "export {};\n");
  writeFileSync(join(extensionDir, "ui", "web", "dist", "index.html"), "<div></div>\n");
  writeFileSync(join(extensionDir, "ui", "web", "dist", ".build-hash"), "hash\n");

  const result = renderHiveDoctor(state(), cwd, extensionDir);

  assert.equal(result.severity, "info");
  assert.match(result.text, /pi-hive doctor/);
  assert.match(result.text, /pass: Opt-in config present/);
  assert.match(result.text, /pass: Telemetry server present/);
  assert.match(result.text, /pass: Dashboard dist index present/);
  assert.match(result.text, /pass: agent-type declared on all/);
});

test("renderHiveDoctor flags agents missing agent-type with a suggestion", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-doctor-untyped-"));
  const extensionDir = mkdtempSync(join(tmpdir(), "pi-hive-doctor-ext-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  // Orchestrator typed, but a top-level "Security Reviewer" is untyped.
  writeFileSync(join(cwd, ".pi", "hive", "agents", "orchestrator.md"), "---\nagent-type: lead\n---\nLead.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "reviewer.md"), "---\nmodel: openai/gpt-5\n---\nReview.");
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), "orchestrator:\n  name: Orchestrator\n  path: .pi/hive/agents/orchestrator.md\nagents:\n  - name: Security Reviewer\n    path: .pi/hive/agents/reviewer.md\n");

  const result = renderHiveDoctor(state(), cwd, extensionDir);

  assert.match(result.text, /Security Reviewer: no agent-type; suggest agent-type: reviewer/);
  assert.match(result.text, /remedy: add the suggested 'agent-type:'/);
});

test("renderHiveDoctor includes remedies for missing required assets", () => {
  const result = renderHiveDoctor(state({ config: null, runtimes: new Map(), session: null, sddStatus: null }), "/missing-cwd", "/missing-extension");

  assert.equal(result.severity, "warning");
  assert.match(result.text, /fail: Opt-in config missing/);
  assert.match(result.text, /remedy: create \.pi\/hive\/hive-config\.yaml/);
  assert.match(result.text, /remedy: run just build-dashboard/);
});
