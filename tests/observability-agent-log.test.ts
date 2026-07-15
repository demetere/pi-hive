import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentRuns, parseAgentLog } from "../src/observability/agent-log.ts";
import { forEachJsonlLine, readJsonlPage } from "../src/core/fs.ts";

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

test("readJsonlPage provides bounded backward pages and retains partial tails", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-jsonl-page-"));
  const file = join(dir, "events.jsonl");
  const records = Array.from({ length: 80 }, (_, i) => JSON.stringify({ i, text: `🐝-${i}-${"x".repeat(20)}` }));
  writeFileSync(file, `${records.join("\n")}\n${JSON.stringify({ i: 80, text: "partial" }).slice(0, 12)}`);

  const newest = readJsonlPage(file, { before: Number.MAX_SAFE_INTEGER, maxBytes: 256 });
  assert.ok(Buffer.byteLength(newest.text) <= 256);
  assert.equal(newest.hasMoreBefore, true);
  assert.equal(newest.hasMoreAfter, true, "unterminated writer tail must stay pending");
  const newestIds = newest.text.trim().split("\n").map((line) => JSON.parse(line).i);
  assert.ok(newestIds.length > 0);

  const beginning = readJsonlPage(file, { before: 0, maxBytes: 256 });
  assert.equal(beginning.text, "", "before=0 must not wrap around to the newest page");

  const older = readJsonlPage(file, { before: newest.startOffset, maxBytes: 256 });
  const olderIds = older.text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).i);
  assert.ok(olderIds.length > 0);
  assert.equal(olderIds.some((id) => newestIds.includes(id)), false, "byte pages must not overlap");

  const pendingOffset = newest.offset;
  appendFileSync(file, `${JSON.stringify({ i: 80, text: "partial" }).slice(12)}\n`);
  const appended = readJsonlPage(file, { after: pendingOffset, maxBytes: 256 });
  assert.deepEqual(appended.text.trim().split("\n").map((line) => JSON.parse(line).i), [80]);
});

test("forEachJsonlLine scans large logs with a fixed buffer and ignores incomplete tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-jsonl-scan-"));
  const file = join(dir, "events.jsonl");
  writeFileSync(file, `${Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i })).join("\n")}\n{\"partial\":`);
  let count = 0;
  let last = -1;
  forEachJsonlLine(file, (line) => { count++; last = JSON.parse(line).i; }, 1024);
  assert.equal(count, 5000);
  assert.equal(last, 4999);
});

test("parseAgentLog bounds its initial response and pages older entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-agent-log-pages-"));
  const file = join(dir, "worker.jsonl");
  const rows = Array.from({ length: 200 }, (_, i) => JSON.stringify({
    type: "message", timestamp: i, message: { role: "assistant", content: [{ type: "text", text: `${i}:${"x".repeat(80)}` }] },
  }));
  writeFileSync(file, `${rows.join("\n")}\n`);
  const newest = parseAgentLog(file, { before: Number.MAX_SAFE_INTEGER, maxBytes: 2048 });
  assert.ok(newest.entries.length < 200);
  assert.equal(newest.hasMoreBefore, true);
  const older = parseAgentLog(file, { before: newest.startOffset, maxBytes: 2048 });
  assert.ok(older.entries.length > 0);
  assert.ok(Number(older.entries.at(-1).ts) < Number(newest.entries[0].ts));
});

test("parseAgentLog handles metadata, sparse messages, and unmatched tool results", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-agent-log-variants-"));
  const file = join(dir, "worker.jsonl");
  writeFileSync(file, [
    "{bad json",
    JSON.stringify({ type: "ignored" }),
    JSON.stringify({ type: "model_change", modelId: "m1", provider: "p", timestamp: 1 }),
    JSON.stringify({ type: "model_change", model: "m2", timestamp: 2 }),
    JSON.stringify({ type: "model_change", timestamp: 3 }),
    JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high", timestamp: 4 }),
    JSON.stringify({ type: "thinking_level_change", level: "low", timestamp: 5 }),
    JSON.stringify({ type: "thinking_level_change", timestamp: 6 }),
    JSON.stringify({ type: "message", timestamp: 7, message: { content: "plain" } }),
    JSON.stringify({ type: "message", timestamp: 8, message: { role: "assistant", content: [
      { type: "thinking", thinking: "reason" },
      { type: "toolCall", id: "t1", name: "write", input: { path: "x" } },
      { type: "toolCall", name: "read" },
      { type: "unknown" },
    ] } }),
    JSON.stringify({ type: "message", timestamp: 9, message: { role: "toolResult", toolCallId: "t1", content: [{ text: "ok" }, "tail"], isError: true } }),
    JSON.stringify({ type: "message", timestamp: 10, message: { role: "toolResult", toolName: "missing", content: [{ text: "no call" }] } }),
    JSON.stringify({ type: "message", timestamp: 11, role: "user", content: null }),
    JSON.stringify({ type: "message", timestamp: 12, message: { role: "assistant", content: [] } }),
    "",
  ].join("\n"));

  const parsed = parseAgentLog(file, 0);
  assert.equal(parsed.entries.filter((entry) => entry.kind === "meta").length, 4);
  assert.ok(parsed.entries.some((entry) => entry.role === "assistant" && entry.parts[0]?.text === "plain"));
  const call = parsed.entries.flatMap((entry) => entry.parts || []).find((part) => part.id === "t1");
  assert.equal(call.result, "ok\ntail");
  assert.equal(call.resultError, true);
  assert.ok(parsed.entries.some((entry) => entry.role === "toolResult"));
  assert.ok(parseAgentLog(file, 1).offset >= 1);
});

test("agentRuns tolerates missing directories and sorts multiple archives", () => {
  const missing = join(tmpdir(), `pi-hive-missing-${Date.now()}`, "worker.jsonl");
  assert.deepEqual(agentRuns(missing), []);

  const dir = mkdtempSync(join(tmpdir(), "pi-hive-agent-runs-many-"));
  const current = join(dir, "worker.jsonl");
  writeFileSync(join(dir, "worker.run-10.jsonl"), "");
  writeFileSync(join(dir, "worker.run-2.jsonl"), "");
  writeFileSync(join(dir, "worker.run-x.jsonl"), "");
  assert.deepEqual(agentRuns(current).map((run) => run.id), ["run-10", "run-2"]);
  writeFileSync(current, "");
  assert.deepEqual(agentRuns(current).map((run) => run.id), ["current", "run-10", "run-2"]);
});

test("agentRuns returns archived runs and current newest-first", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-agent-runs-"));
  const current = join(dir, "worker.jsonl");
  writeFileSync(join(dir, "worker.run-1.jsonl"), "");
  writeFileSync(current, "");

  assert.deepEqual(agentRuns(current).map((run) => run.id), ["current", "run-1"]);
});
