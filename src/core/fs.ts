import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";

export function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

export function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

export function readIfSmall(path: string, maxBytes = 64_000): string {
  try {
    const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(2 * 1024 * 1024, Math.floor(maxBytes)) : 64_000;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > limit) return "";
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

export interface JsonlPage {
  text: string;
  startOffset: number;
  offset: number;
  size: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  truncated: boolean;
}

function byteLimit(value: number | undefined, fallback = 256 * 1024): number {
  return Number.isFinite(value) && (value as number) > 0
    ? Math.min(2 * 1024 * 1024, Math.floor(value as number))
    : fallback;
}

// Read one newline-aligned JSONL page with bounded allocation. `after` pages
// forward for live tails; `before` pages backward for older-history requests.
// Omitting both returns the newest page. Offsets only advance through complete
// newline-terminated records, so a partial writer tail is retried next time.
export function readJsonlPage(path: string, options: { after?: number; before?: number; maxBytes?: number } = {}): JsonlPage {
  const empty = (size = 0): JsonlPage => ({ text: "", startOffset: 0, offset: 0, size, hasMoreBefore: false, hasMoreAfter: false, truncated: false });
  let size = 0;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return empty();
    size = stat.size;
  } catch { return empty(); }
  const limit = byteLimit(options.maxBytes);
  const forward = options.after != null;
  let rawStart: number;
  let rawEnd: number;
  if (forward) {
    const requested = Math.max(0, Math.floor(Number(options.after) || 0));
    rawStart = requested > size ? 0 : requested;
    rawEnd = Math.min(size, rawStart + limit);
  } else {
    const requested = options.before == null ? size : Number(options.before);
    rawEnd = Math.min(size, Math.max(0, Math.floor(Number.isFinite(requested) ? requested : size)));
    rawStart = Math.max(0, rawEnd - limit);
  }
  if (rawEnd <= rawStart) return { ...empty(size), startOffset: rawStart, offset: rawStart, hasMoreBefore: rawStart > 0, hasMoreAfter: rawStart < size, truncated: size > 0 };

  const fd = openSync(path, "r");
  let buffer: Buffer;
  try {
    buffer = Buffer.allocUnsafe(rawEnd - rawStart);
    const bytes = readSync(fd, buffer, 0, buffer.length, rawStart);
    buffer = buffer.subarray(0, bytes);
  } finally { closeSync(fd); }

  let begin = 0;
  // A backward page commonly starts in the middle of a record. Drop that prefix;
  // the preceding page owns the complete record. Forward offsets returned by us
  // are already newline boundaries and need no such adjustment.
  if (!forward && rawStart > 0) {
    const firstNewline = buffer.indexOf(0x0a);
    begin = firstNewline >= 0 ? firstNewline + 1 : buffer.length;
  }
  let end = buffer.length;
  // Never consume a partial trailing record. When a single record exceeds the
  // byte budget, advance over the bounded fragment with no text; this prevents a
  // permanently stuck cursor while keeping memory fixed.
  if (end > begin && buffer[end - 1] !== 0x0a) {
    const lastNewline = buffer.lastIndexOf(0x0a, end - 1);
    if (lastNewline >= begin) end = lastNewline + 1;
    else if (forward && rawEnd < size) begin = end;
    else end = begin;
  }
  const startOffset = rawStart + begin;
  const offset = rawStart + end;
  return {
    text: Buffer.from(buffer.subarray(begin, end)).toString("utf8"),
    startOffset,
    offset: forward && begin === end && rawEnd < size ? rawEnd : offset,
    size,
    hasMoreBefore: startOffset > 0,
    hasMoreAfter: (forward && begin === end && rawEnd < size ? rawEnd : offset) < size,
    truncated: startOffset > 0 || offset < size,
  };
}

// Stream every complete JSONL line through a fixed-size buffer. This is for
// restore/migration scans that need the whole logical history but must not load
// the whole file into memory. A trailing incomplete line is intentionally ignored.
export function forEachJsonlLine(path: string, visit: (line: string) => void, chunkBytes = 64 * 1024): void {
  const limit = byteLimit(chunkBytes, 64 * 1024);
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return; }
  const buffer = Buffer.allocUnsafe(limit);
  let carry = Buffer.alloc(0);
  let position = 0;
  try {
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.length, position);
      if (bytes <= 0) break;
      position += bytes;
      const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytes)]) : buffer.subarray(0, bytes);
      let start = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0x0a) continue;
        if (i > start) visit(Buffer.from(data.subarray(start, i)).toString("utf8"));
        start = i + 1;
      }
      carry = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
      // One pathological unterminated record must not make carry unbounded.
      if (carry.length > 2 * 1024 * 1024) carry = Buffer.alloc(0);
    }
  } finally { closeSync(fd); }
}
