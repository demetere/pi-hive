import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  const missing = required.find((key) => !(key in value));
  if (extra) throw new Error(`${label} contains unsupported field ${extra}`);
  if (missing) throw new Error(`${label} is missing required field ${missing}`);
}

export function boundedText(value: unknown, label: string, bytes: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > bytes) {
    throw new Error(`${label} is empty, invalid, or exceeds its limit`);
  }
  return value;
}

export function boundedId(value: unknown, label: string): string {
  return boundedText(value, label, 256);
}

export function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

interface JsonBounds {
  readonly bytes: number;
  readonly depth: number;
  readonly nodes: number;
  readonly rootRecord?: boolean;
}

export function boundedJson(value: unknown, label: string, bounds: JsonBounds): JsonValue {
  if (bounds.rootRecord && !plainRecord(value)) throw new Error(`${label} must be a plain JSON object`);
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > bounds.nodes || current.depth > bounds.depth) throw new Error(`${label} exceeds structural limits`);
    const item = current.value;
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number" && Number.isFinite(item)) continue;
    if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index--) pending.push({ value: item[index], depth: current.depth + 1 });
      continue;
    }
    if (!plainRecord(item)) throw new Error(`${label} is not JSON`);
    for (const child of Object.values(item)) pending.push({ value: child, depth: current.depth + 1 });
  }
  const clone = structuredClone(value) as JsonValue;
  if (Buffer.byteLength(canonicalJson(clone), "utf8") > bounds.bytes) throw new Error(`${label} exceeds its byte limit`);
  return clone;
}
