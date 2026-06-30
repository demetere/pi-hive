import { mkdirSync, readFileSync, statSync } from "node:fs";

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
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return "";
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}
