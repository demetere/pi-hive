import { createHash } from "node:crypto";

export const SNAPSHOT_HASH_DOMAIN = "pi-hive-activation-snapshot-v1\0" as const;

function canonical(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new TypeError("Canonical JSON requires finite numbers and safe integers.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("Canonical JSON does not support this value.");
  if (seen.has(value)) throw new TypeError("Canonical JSON cycle detected.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) if (!(index in value)) throw new TypeError("Canonical JSON rejects sparse arrays.");
      return `[${value.map((entry) => canonical(entry, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Canonical JSON requires plain objects.");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    return `{${keys.map((key) => {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable) return undefined;
      if (!("value" in descriptor)) throw new TypeError("Canonical JSON rejects accessors.");
      return `${JSON.stringify(key)}:${canonical(descriptor.value, seen)}`;
    }).filter((entry): entry is string => entry !== undefined).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonical(value, new Set());
}

export function hashActivationPayload(payload: unknown): string {
  return createHash("sha256").update(SNAPSHOT_HASH_DOMAIN).update(canonicalJson(payload), "utf8").digest("hex");
}
