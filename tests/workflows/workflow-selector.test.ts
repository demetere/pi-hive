import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildWorkflowSelector } from "../../src/workflows/registry.ts";
import { initializeNormalParent, markMissingPiSession } from "../../src/workflows/sessions.ts";
import { readWorkflowJournal } from "../../src/workflows/journal.ts";

test("selector exposes bounded valid, invalid, stale, and resumable DTOs without prompts", () => {
  const rows = buildWorkflowSelector([
    { workflowId: "valid", name: "Valid", source: "current", resumable: false, freshEnabled: true, diagnostics: [], prompt: "secret" },
    { workflowId: "stale", name: "Stale", source: "stale", resumable: true, freshEnabled: false, diagnostics: ["changed"] },
    { workflowId: "bad", name: "Bad", source: "invalid", resumable: false, freshEnabled: false, diagnostics: ["x".repeat(10000)] },
  ] as any);
  assert.deepEqual(rows.map((row) => row.id), ["bad", "stale", "valid"]); assert.equal(rows[1].resumable, true); assert.equal(JSON.stringify(rows).includes("secret"), false); assert.ok(Buffer.byteLength(JSON.stringify(rows)) < 8192);
});

test("missing Pi session appends orphan state without deleting its journal", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "hive-orphan-")); initializeNormalParent({ configured: true, projectRoot, projectId: "p", piSessionId: "normal", piSessionFile: "/pi/normal", model: "provider/normal", thinking: "low", activeTools: [] });
  markMissingPiSession(projectRoot, "p", "workflow-session"); assert.equal(readWorkflowJournal(projectRoot, "workflow-session").at(-1)?.type, "session.orphaned");
});
