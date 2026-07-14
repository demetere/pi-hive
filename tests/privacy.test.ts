import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emitHiveEvent } from "../src/engine/observability.ts";
import { redactSensitive, redactSensitiveText } from "../src/shared/privacy.ts";

function telemetryState(root: string, telemetry: Record<string, unknown>) {
  return {
    mode: "hive",
    obsSeq: 0,
    config: { settings: { telemetry } },
    session: {
      sessionId: "session-1",
      sessionDir: root,
      observabilityLog: join(root, "hive-events.jsonl"),
      conversationLog: join(root, "conversation.jsonl"),
    },
    widgetCtx: { cwd: root },
  } as any;
}

test("redactSensitive removes credentials from keys and free text", () => {
  const value = redactSensitive({
    authorization: "Bearer top-secret",
    nested: { apiKey: "sk-live", note: "password=hunter2 Bearer abc.def" },
    url: "https://alice:swordfish@example.test/path",
  });
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /top-secret|sk-live|hunter2|abc\.def|swordfish/);
  assert.match(text, /\[REDACTED\]/);
  assert.equal(redactSensitiveText("token=visible",), "token=visible");
});

test("emitHiveEvent honors telemetry disablement", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-privacy-off-"));
  const state = telemetryState(root, { enabled: false });
  emitHiveEvent(state, "user_message", { text: "do not persist" });
  assert.equal(readdirSync(root).length, 0);
});

test("emitHiveEvent redacts, rotates, and uses restrictive permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-privacy-log-"));
  const state = telemetryState(root, { enabled: true, redactSensitiveData: true, maxLogBytes: 500 });
  emitHiveEvent(state, "user_message", { text: `Authorization: Bearer secret-token ${"x".repeat(280)}` });
  emitHiveEvent(state, "assistant_message", { apiKey: "sk-secret", text: "done" });

  const files = (readdirSync(root) as string[]).filter((name: string) => name.startsWith("hive-events.jsonl") && !name.endsWith(".lock"));
  assert.ok(files.length >= 2, "expected current log plus a rotated archive");
  const content = files.map((name: string) => readFileSync(join(root, name), "utf8")).join("\n");
  assert.doesNotMatch(content, /secret-token|sk-secret/);
  assert.match(content, /\[REDACTED\]/);
  for (const name of files) assert.equal(statSync(join(root, name)).mode & 0o777, 0o600);
  assert.equal(statSync(root).mode & 0o777, 0o700);
});
