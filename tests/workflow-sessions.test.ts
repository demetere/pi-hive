import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeNormalParent, listSessionLinks, recordWorkflowModelState } from "../src/workflows/sessions.ts";

const root = () => mkdtempSync(join(tmpdir(), "hive-links-"));

test("unconfigured startup is inert while configured normal startup persists its own baseline", () => {
  const project = root();
  assert.deepEqual(initializeNormalParent({ configured: false, projectRoot: project, projectId: "p", piSessionId: "normal", piSessionFile: "/pi/normal.jsonl", model: "provider/normal", thinking: "low", activeTools: ["read"] }), { configured: false, commands: [] });
  assert.equal(listSessionLinks(project).length, 0);
  const state = initializeNormalParent({ configured: true, projectRoot: project, projectId: "p", piSessionId: "normal", piSessionFile: "/pi/normal.jsonl", model: "provider/normal", thinking: "low", activeTools: ["read", "grep"] });
  assert.deepEqual(state.commands, ["hive:select", "hive:exit"]);
  const normal = listSessionLinks(project).find((entry) => entry.kind === "normal");
  assert.deepEqual(normal?.normalTools, ["grep", "read"]);
});

test("normal and workflow model/thinking/tool state remain distinct and model changes are journaled", () => {
  const project = root(); initializeNormalParent({ configured: true, projectRoot: project, projectId: "p", piSessionId: "normal", piSessionFile: "/pi/normal", model: "provider/normal", thinking: "low", activeTools: ["read"] });
  const link = { formatVersion: 1 as const, workflowSessionId: "ws", workflowId: "build", activationHash: "a".repeat(64), piSessionId: "piw", piSessionFile: "/pi/w", normalParentId: "normal", normalParentFile: "/pi/normal", status: "current" as const, stale: false, model: "provider/model", thinking: "high", tools: ["bash", "write"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), name: "hive:build:aaaaaaaa" };
  recordWorkflowModelState(project, "p", link, "provider/other", "medium", () => true);
  const stored = listSessionLinks(project).find((entry) => entry.kind === "workflow")!; assert.deepEqual(stored.tools, ["bash", "write"]); assert.equal(stored.model, "provider/other");
  const normal = listSessionLinks(project).find((entry) => entry.kind === "normal")!; assert.deepEqual(normal.normalTools, ["read"]); assert.equal(normal.normalModel, "provider/normal"); assert.equal(normal.normalThinking, "low");
  assert.throws(() => recordWorkflowModelState(project, "p", stored as any, "bad", "max", () => false), /preflight/i);
});
