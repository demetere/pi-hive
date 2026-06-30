import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentRuns, parseAgentLog } from "../src/observability/agent-log.ts";

test("parseAgentLog flattens messages and joins tool calls with results", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-agent-log-"));
  const file = join(dir, "worker.jsonl");
  writeFileSync(file, [
    JSON.stringify({ type: "message", timestamp: 1, message: { role: "assistant", content: [{ type: "text", text: "working" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "README.md" } }] } }),
    JSON.stringify({ type: "message", timestamp: 2, message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: "contents" } }),
    "",
  ].join("\n"));

  const parsed = parseAgentLog(file);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].parts[0].text, "working");
  assert.equal(parsed.entries[0].parts[1].name, "read");
  assert.equal(parsed.entries[0].parts[1].result, "contents");
  assert.equal(parsed.offset, parsed.size);
});

test("agentRuns returns archived runs and current newest-first", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-agent-runs-"));
  const current = join(dir, "worker.jsonl");
  writeFileSync(join(dir, "worker.run-1.jsonl"), "");
  writeFileSync(current, "");

  assert.deepEqual(agentRuns(current).map((run) => run.id), ["current", "run-1"]);
});
