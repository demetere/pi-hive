import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { SessionManager as DevSessionManager } from "@earendil-works/pi-coding-agent";
import { assertPiSessionPersistenceCompatibility, durablyFlushPiSessionManager } from "../../src/integration/pi-session-manager-compat.ts";

const assistantMessage = { role: "assistant" as const, content: [], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: Date.now() };

async function verifyManagerSemantics(label: string, SessionManager: typeof DevSessionManager): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `pi-hive-session-manager-${label}-`));
  try {
    const parentSession = join(root, "parent.jsonl");
    const manager = SessionManager.create(root, join(root, "sessions"), { parentSession });
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    manager.appendSessionInfo("hive:installed-order-test");
    manager.appendCustomEntry("pi-hive-test-marker", { version: 1 });
    assert.equal(existsSync(sessionFile), false, "Pi defers a no-assistant transcript");

    assertPiSessionPersistenceCompatibility(manager);
    assert.equal(durablyFlushPiSessionManager(manager), sessionFile);
    assert.equal(existsSync(sessionFile), true);
    const materialized = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(materialized[0]?.parentSession, parentSession, "public create writes parent metadata before any switch");
    assert.equal(materialized.some((entry) => entry.type === "session_info" && entry.name === "hive:installed-order-test"), true);
    assert.equal(materialized.some((entry) => entry.type === "custom" && entry.customType === "pi-hive-test-marker"), true);

    assert.doesNotThrow(() => manager.appendMessage(assistantMessage));
    const persisted = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(persisted.filter((entry) => entry.type === "session").length, 1, "later assistant append does not recreate the materialized file");
    assert.equal(persisted.at(-1)?.message?.role, "assistant");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("compatibility adapter materializes dev Pi 0.80.7 and permits the next assistant append", async () => {
  await verifyManagerSemantics("dev-0807", DevSessionManager);
});

test("compatibility adapter materializes installed Pi 0.80.10 and permits the next assistant append", async (t) => {
  let packageRoot: string;
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    packageRoot = resolve(globalRoot, "@earendil-works/pi-coding-agent");
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (manifest.version !== "0.80.10") return t.skip(`installed Pi is ${String(manifest.version)}, not 0.80.10`);
  } catch (error) {
    return t.skip(`installed Pi 0.80.10 is unavailable: ${String(error)}`);
  }
  const installed = await import(pathToFileURL(join(packageRoot, "dist/index.js")).href) as { SessionManager: typeof DevSessionManager };
  await verifyManagerSemantics("installed-08010", installed.SessionManager);
});

test("compatibility adapter fails closed when Pi private persistence semantics are unsupported", () => {
  const unsupported = {
    isPersisted: () => true,
    getSessionFile: () => "/tmp/unsupported.jsonl",
    _rewriteFile() {},
    flushed: "not-a-boolean",
  };
  assert.throws(() => assertPiSessionPersistenceCompatibility(unsupported as never), /unsupported Pi SessionManager persistence semantics/u);
});
