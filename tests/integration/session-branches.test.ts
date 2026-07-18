import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  currentAgentName,
  currentChangeId,
  currentDelegationDepth,
  loadAgentRuntime,
  restoreOrCreateSession,
  restoreRuntimeCounters,
  runAsAgent,
  runAtDelegationDepth,
  runWithChange,
} from "../../src/engine/session.ts";

test("session restoration migrates legacy records and creates missing sessions", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-session-record-"));
  const legacy = { sessionId: "legacy", sessionDir: join(cwd, "legacy"), conversationLog: join(cwd, "legacy.jsonl") };
  const state = { pi: { appendEntry() { throw new Error("must not append"); } } } as any;
  const restored = restoreOrCreateSession(state, {
    cwd,
    sessionManager: { getEntries: () => [
      { type: "custom", customType: "other", data: {} },
      { type: "custom", customType: "hive-session", data: legacy },
    ] },
  } as any, {} as any);
  assert.equal(restored.sessionId, "legacy");
  assert.equal(restored.observabilityLog, join(legacy.sessionDir, "hive-events.jsonl"));

  const current = { ...legacy, observabilityLog: join(cwd, "events.jsonl") };
  assert.equal(restoreOrCreateSession(state, {
    cwd, sessionManager: { getEntries: () => [{ type: "custom", customType: "hive-session", data: current }] },
  } as any, {} as any).observabilityLog, current.observabilityLog);

  let appended: any;
  const created = restoreOrCreateSession({ pi: { appendEntry(type: string, data: any) { appended = { type, data }; } } } as any, {
    cwd, sessionManager: { getEntries: (): any[] => [] },
  } as any, {} as any);
  assert.equal(appended.type, "hive-session");
  assert.equal(appended.data.sessionId, created.sessionId);
  assert.match(created.conversationLog, /conversation\.jsonl$/);
});

test("agent runtime loading covers frontmatter precedence, defaults, and fail-closed requirements", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-runtime-load-"));
  const agentsDir = join(cwd, ".pi", "hive", "agents");
  mkdirSync(agentsDir, { recursive: true });
  const sessionDir = join(cwd, "session");
  mkdirSync(sessionDir, { recursive: true });
  const state = { session: { sessionDir } } as any;
  const cfg = { settings: { defaultTools: "read" } } as any;

  writeFileSync(join(agentsDir, "rich.md"), `---
slug: Rich Agent
name: Frontmatter Name
model: provider/model
thinking: high
tools: read,bash
color: '#123456'
description: Handles rich work
routing-tags: [api]
responsibilities: [build]
context:
  - path: .pi/hive/agents/rich-mental-model.yaml
skills:
  - path: skills/example/SKILL.md
domain:
  - path: src
    read: true
    upsert: true
    delete: false
agent-type: planner
stages: [proposal]
commit: Commit the result.
---
Rich prompt body.`);
  const rich = loadAgentRuntime(state, { cwd } as any, cfg, {
    name: "Config Name", path: ".pi/hive/agents/rich.md", role: "member", routingTags: [], domain: [],
  } as any);
  assert.equal(rich.config.name, "Frontmatter Name");
  assert.equal(rich.config.model, "provider/model");
  assert.equal(rich.config.thinking, "high");
  assert.equal(rich.systemPrompt, "Rich prompt body.");
  assert.equal(rich.config.context?.filter((ref: any) => ref.path.endsWith("mental-model.yaml")).length, 1);

  writeFileSync(join(agentsDir, "configured.md"), "Configured prompt.");
  const configured = loadAgentRuntime(state, { cwd } as any, cfg, {
    name: "Configured", slug: "configured-slug", path: ".pi/hive/agents/configured.md", role: "member",
    model: "agent/model", thinking: "low", tools: "read", color: "#abcdef", consultWhen: "configured work",
    routingTags: ["configured"], responsibilities: ["work"], context: [{ path: "README.md" }], skills: [],
    domain: [], agentType: "coder", commit: "Commit configured work.",
  } as any);
  assert.equal(configured.config.slug, "configured-slug");
  assert.equal(configured.config.model, "agent/model");
  assert.equal(configured.config.consultWhen, "configured work");
  assert.equal(configured.lastWork, "configured work");

  writeFileSync(join(agentsDir, "main.md"), "");
  const main = loadAgentRuntime(state, { cwd } as any, cfg, {
    name: "Main", path: ".pi/hive/agents/main.md", role: "orchestrator", routingTags: [], domain: [],
  } as any);
  assert.equal(main.config.model, "inherit");
  assert.equal(main.config.thinking, "medium");
  assert.match(main.systemPrompt, /You are Main/);

  writeFileSync(join(agentsDir, "missing.md"), "---\nthinking: low\n---\nWorker");
  assert.throws(() => loadAgentRuntime(state, { cwd } as any, cfg, {
    name: "Missing Model", path: ".pi/hive/agents/missing.md", role: "member",
  } as any), /missing required 'model'/);
  writeFileSync(join(agentsDir, "missing.md"), "---\nmodel: provider/model\n---\nWorker");
  assert.throws(() => loadAgentRuntime(state, { cwd } as any, cfg, {
    name: "Missing Thinking", path: ".pi/hive/agents/missing.md", role: "member",
  } as any), /missing required 'thinking'/);
  assert.throws(() => loadAgentRuntime(state, { cwd } as any, cfg, {
    name: "Escape", path: "../outside.md", role: "member",
  } as any), /missing or escapes/);
});

test("runtime counter restoration handles sparse, corrupt, and explicit snapshots", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-counter-"));
  const log = join(cwd, "events.jsonl");
  const runtime = { config: { name: "Worker", slug: "worker" } } as any;
  const absent = { config: { name: "Absent", slug: "absent" }, inputTokens: 7 } as any;
  const state = { session: { observabilityLog: log }, runtimes: new Map([["worker", runtime], ["absent", absent]]) } as any;

  restoreRuntimeCounters({ session: {}, runtimes: new Map() } as any);
  writeFileSync(log, [
    JSON.stringify({ type: "other", payload: {} }),
    "{bad delegation_end",
    JSON.stringify({ type: "distill_start", payload: {} }),
    JSON.stringify({ type: "distill_start", payload: { agent: "Worker" } }),
    JSON.stringify({ type: "delegation_end", payload: {} }),
    JSON.stringify({ type: "delegation_end", payload: { from: "Worker", runtime: { name: "Worker", runCount: 5 } } }),
    JSON.stringify({ type: "delegation_end", payload: { runtime: {
      slug: "worker", inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2,
      reasoningTokens: 1, costUsd: 0.5, governanceTokens: 25, governanceCostUsd: 0.75,
      runCount: 2, toolCount: 6,
    } } }),
    JSON.stringify({ type: "distill_start", payload: { agent: "Worker", distillerRunCount: 3 } }),
  ].join("\n") + "\n");

  restoreRuntimeCounters(state);
  assert.deepEqual({
    input: runtime.inputTokens, output: runtime.outputTokens, cacheRead: runtime.cacheReadTokens,
    cacheWrite: runtime.cacheWriteTokens, reasoning: runtime.reasoningTokens, cost: runtime.costUsd,
    governanceTokens: runtime.governanceTokens, governanceCost: runtime.governanceCostUsd,
    runs: runtime.runCount, tools: runtime.toolCount, distillers: runtime.distillerRunCount,
  }, {
    input: 10, output: 4, cacheRead: 3, cacheWrite: 2, reasoning: 1, cost: 0.5,
    governanceTokens: 25, governanceCost: 0.75, runs: 5, tools: 6, distillers: 3,
  });
  assert.equal(absent.inputTokens, 7);
});

test("async-local session context preserves defaults and nested values", async () => {
  assert.equal(currentAgentName(), "Orchestrator");
  assert.equal(currentDelegationDepth(), 0);
  assert.equal(currentChangeId(), undefined);

  await runAsAgent("Lead", async () => {
    assert.equal(currentAgentName(), "Lead");
    await runAtDelegationDepth(2, async () => {
      assert.equal(currentDelegationDepth(), 2);
      await runWithChange("change-1", async () => {
        await Promise.resolve();
        assert.equal(currentAgentName(), "Lead");
        assert.equal(currentDelegationDepth(), 2);
        assert.equal(currentChangeId(), "change-1");
      });
    });
  });

  assert.equal(runWithChange(undefined, currentChangeId), undefined);
});
