import { createHash } from "node:crypto";

export const CATALOG_HASH_VERSION = "pi-hive-catalog-hash-v1";

export type CatalogHashDomain =
  | "agent-source"
  | "agent-prompt"
  | "skill-file"
  | "skill-tree"
  | "knowledge-root-metadata";

export function canonicalCatalogText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function decodeCatalogText(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
  } catch {
    throw new Error("Catalog content is not valid UTF-8.");
  }
}

function lengthFrame(size: number): Buffer {
  const value = Buffer.allocUnsafe(8);
  value.writeBigUInt64BE(BigInt(size));
  return value;
}

export function hashCatalogFrames(
  domain: CatalogHashDomain,
  frames: readonly (string | Uint8Array)[],
  canonicalizeText = domain !== "agent-source",
): string {
  const hash = createHash("sha256");
  for (const frame of [CATALOG_HASH_VERSION, domain]) {
    const bytes = Buffer.from(frame, "utf8");
    hash.update(lengthFrame(bytes.byteLength));
    hash.update(bytes);
  }
  for (const frame of frames) {
    const bytes = typeof frame === "string"
      ? Buffer.from(canonicalizeText ? canonicalCatalogText(frame) : frame, "utf8")
      : Buffer.from(frame);
    hash.update(lengthFrame(bytes.byteLength));
    hash.update(bytes);
  }
  return hash.digest("hex");
}
