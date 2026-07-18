import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanJsonlFile } from "../../src/observability/server/jsonl-reader.ts";

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "pi-hive-jsonl-")), name);
}

function scan(file: string, offset: number, options: Parameters<typeof scanJsonlFile>[3] = {}) {
  const lines: string[] = [];
  const batches: Array<{ endOffset: number; oversizedLines: number }> = [];
  const result = scanJsonlFile(file, offset, (batch) => {
    lines.push(...batch.lines);
    batches.push({ endOffset: batch.endOffset, oversizedLines: batch.oversizedLines });
  }, options);
  return { lines, batches, result };
}

test("JSONL reader preserves a UTF-8 event split at every byte boundary", () => {
  const line = JSON.stringify({ event_id: "split", text: "héllo 🐝 漢字" });
  const bytes = Buffer.from(`${line}\n`);

  for (let split = 0; split <= bytes.length; split++) {
    const file = tempFile(`split-${split}.jsonl`);
    writeFileSync(file, bytes.subarray(0, split));
    const first = scan(file, 0, { chunkBytes: 3 });
    assert.deepEqual(first.lines, split === bytes.length ? [line] : [], `first scan at byte ${split}`);
    assert.equal(first.result.committedOffset, split === bytes.length ? bytes.length : 0);
    assert.equal(first.result.pendingTailBytes, split === bytes.length ? 0 : split);

    appendFileSync(file, bytes.subarray(split));
    const second = scan(file, first.result.committedOffset, { chunkBytes: 3 });
    assert.deepEqual(
      [...first.lines, ...second.lines],
      [line],
      `event split at byte ${split} must be emitted exactly once`,
    );
    assert.equal(second.result.committedOffset, bytes.length);
    assert.equal(second.result.pendingTailBytes, 0);
  }
});

test("JSONL reader commits complete records and leaves a multi-event partial tail pending across restart", () => {
  const one = JSON.stringify({ event_id: "one" });
  const two = JSON.stringify({ event_id: "two", text: "second" });
  const three = JSON.stringify({ event_id: "three" });
  const twoBytes = Buffer.from(two);
  const cut = Math.floor(twoBytes.length / 2);
  const file = tempFile("partial-tail.jsonl");
  writeFileSync(file, Buffer.concat([Buffer.from(`${one}\n`), twoBytes.subarray(0, cut)]));

  const first = scan(file, 0, { chunkBytes: 5 });
  assert.deepEqual(first.lines, [one]);
  assert.equal(first.result.committedOffset, Buffer.byteLength(`${one}\n`));
  assert.equal(first.result.pendingTailBytes, cut);

  // Simulate daemon restart: only the persisted complete-newline offset survives.
  appendFileSync(file, Buffer.concat([twoBytes.subarray(cut), Buffer.from(`\n${three}`)]));
  const restarted = scan(file, first.result.committedOffset, { chunkBytes: 4 });
  assert.deepEqual(restarted.lines, [two]);
  assert.equal(restarted.result.pendingTailBytes, Buffer.byteLength(three));

  appendFileSync(file, "\n");
  const final = scan(file, restarted.result.committedOffset, { chunkBytes: 2 });
  assert.deepEqual(final.lines, [three]);
  assert.equal(final.result.pendingTailBytes, 0);
});

test("JSONL reader handles large records across chunks and skips oversized complete records", () => {
  const large = JSON.stringify({ event_id: "large", text: "x".repeat(256 * 1024) });
  const good = JSON.stringify({ event_id: "after-oversized" });
  const file = tempFile("large.jsonl");
  writeFileSync(file, `${large}\n${good}\n`);

  const accepted = scan(file, 0, { chunkBytes: 257, batchBytes: 4096, maxRecordBytes: 512 * 1024 });
  assert.deepEqual(accepted.lines, [large, good]);
  assert.equal(accepted.result.oversizedLines, 0);
  assert.ok(accepted.result.maxBufferedBytes <= 512 * 1024 + 4096);

  const bounded = scan(file, 0, { chunkBytes: 257, batchBytes: 4096, maxRecordBytes: 64 * 1024 });
  assert.deepEqual(bounded.lines, [good]);
  assert.equal(bounded.result.oversizedLines, 1);
  assert.equal(bounded.result.committedOffset, Buffer.byteLength(`${large}\n${good}\n`));
});

test("JSONL reader bounds batch memory for a large log", () => {
  const file = tempFile("many.jsonl");
  const rows = Array.from({ length: 20_000 }, (_, i) => JSON.stringify({ event_id: `e-${i}`, text: "x".repeat(100) }));
  writeFileSync(file, `${rows.join("\n")}\n`);
  let seen = 0;
  let largestBatch = 0;
  const result = scanJsonlFile(file, 0, (batch) => {
    seen += batch.lines.length;
    largestBatch = Math.max(largestBatch, batch.lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0));
  }, { chunkBytes: 1024, batchBytes: 8192, maxRecordBytes: 1024 * 1024 });

  assert.equal(seen, rows.length);
  assert.equal(result.committedOffset, result.fileSize);
  assert.ok(largestBatch < 10 * 1024, `largest batch was ${largestBatch} bytes`);
  assert.ok(result.maxBufferedBytes < 10 * 1024, `reader buffered ${result.maxBufferedBytes} bytes`);
});
