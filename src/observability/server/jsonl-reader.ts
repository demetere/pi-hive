import * as fs from "node:fs";

export interface JsonlReaderOptions {
  chunkBytes?: number;
  batchBytes?: number;
  maxRecordBytes?: number;
}

export interface JsonlBatch {
  lines: string[];
  endOffset: number;
  oversizedLines: number;
}

export interface JsonlScanResult {
  fileSize: number;
  committedOffset: number;
  pendingTailBytes: number;
  bytesRead: number;
  maxBufferedBytes: number;
  oversizedLines: number;
}

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_BATCH_BYTES = 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 16 * 1024 * 1024;

/**
 * Scan a stable byte snapshot of a JSONL file with bounded memory.
 *
 * Bytes after the final newline are deliberately left uncommitted. Callers
 * persist each batch's endOffset only after processing that batch succeeds,
 * then pass the persisted offset back on the next scan. UTF-8 is decoded only
 * after a complete line has been assembled, so multi-byte characters may cross
 * any read-chunk boundary safely.
 */
export function scanJsonlFile(
  file: string,
  startOffset: number,
  onBatch: (batch: JsonlBatch) => void,
  options: JsonlReaderOptions = {},
): JsonlScanResult {
  const chunkBytes = Math.max(1, Math.floor(options.chunkBytes || DEFAULT_CHUNK_BYTES));
  const batchBytes = Math.max(1, Math.floor(options.batchBytes || DEFAULT_BATCH_BYTES));
  const maxRecordBytes = Math.max(1, Math.floor(options.maxRecordBytes || DEFAULT_MAX_RECORD_BYTES));
  const stat = fs.statSync(file);
  const fileSize = stat.size;
  const start = Math.max(0, Math.min(Math.floor(startOffset), fileSize));
  const fd = fs.openSync(file, "r");

  let readOffset = start;
  let committedOffset = start;
  let recordStart = start;
  let recordBytes = 0;
  let recordParts: Buffer[] = [];
  let skippingOversized = false;
  let batchLines: string[] = [];
  let batchSize = 0;
  let batchOversized = 0;
  let totalOversized = 0;
  let maxBufferedBytes = 0;

  const flush = (endOffset: number) => {
    if (!batchLines.length && batchOversized === 0) return;
    onBatch({ lines: batchLines, endOffset, oversizedLines: batchOversized });
    batchLines = [];
    batchSize = 0;
    batchOversized = 0;
  };

  const appendPart = (part: Buffer) => {
    if (!part.length || skippingOversized) return;
    recordBytes += part.length;
    if (recordBytes > maxRecordBytes) {
      skippingOversized = true;
      recordParts = [];
      return;
    }
    recordParts.push(Buffer.from(part));
    maxBufferedBytes = Math.max(maxBufferedBytes, recordBytes + batchSize);
  };

  try {
    while (readOffset < fileSize) {
      const wanted = Math.min(chunkBytes, fileSize - readOffset);
      const chunk = Buffer.allocUnsafe(wanted);
      const bytesRead = fs.readSync(fd, chunk, 0, wanted, readOffset);
      if (bytesRead <= 0) break;
      const data = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
      let cursor = 0;
      while (cursor < data.length) {
        const newline = data.indexOf(0x0a, cursor);
        if (newline < 0) {
          appendPart(data.subarray(cursor));
          break;
        }
        appendPart(data.subarray(cursor, newline));
        const lineEndOffset = readOffset + newline + 1;
        if (skippingOversized) {
          totalOversized++;
          batchOversized++;
        } else {
          const raw = recordParts.length === 0
            ? Buffer.alloc(0)
            : recordParts.length === 1
              ? recordParts[0]
              : Buffer.concat(recordParts, recordBytes);
          const normalized = raw.length && raw[raw.length - 1] === 0x0d ? raw.subarray(0, -1) : raw;
          batchLines.push(normalized.toString("utf8"));
          batchSize += raw.length;
          maxBufferedBytes = Math.max(maxBufferedBytes, batchSize);
        }
        committedOffset = lineEndOffset;
        recordStart = lineEndOffset;
        recordBytes = 0;
        recordParts = [];
        skippingOversized = false;
        cursor = newline + 1;
        if (batchSize >= batchBytes || batchLines.length >= 1000 || batchOversized > 0) flush(committedOffset);
      }
      readOffset += bytesRead;
    }
    flush(committedOffset);
    return {
      fileSize,
      committedOffset,
      pendingTailBytes: fileSize - recordStart,
      bytesRead: readOffset - start,
      maxBufferedBytes,
      oversizedLines: totalOversized,
    };
  } finally {
    fs.closeSync(fd);
  }
}
