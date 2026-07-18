import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createPiSessionNavigationAdapter, WORKFLOW_SESSION_MARKER_TYPE } from "../src/integration/session-links.ts";

test("Pi navigation adapter initializes markers and uses only replacement context", async () => {
  const setupCalls: unknown[] = [];
  const freshManager = { getSessionId: () => "fresh-id", getSessionFile: () => "/pi/fresh.jsonl" };
  const oldContext = {
    async newSession(options: { setup?: (manager: unknown) => Promise<void>; withSession?: (ctx: unknown) => Promise<void> }) {
      await options.setup?.({ appendSessionInfo: (name: string) => setupCalls.push(["name", name]), appendCustomEntry: (type: string, data: unknown) => setupCalls.push([type, data]) });
      await options.withSession?.({ sessionManager: freshManager });
      return { cancelled: false };
    },
    async switchSession(_path: string, options: { withSession?: (ctx: unknown) => Promise<void> }) { await options.withSession?.({ sessionManager: freshManager }); return { cancelled: false }; },
  } as unknown as ExtensionCommandContext;
  const adapter = createPiSessionNavigationAdapter(oldContext);
  const created = await adapter.create({ parentSession: "/pi/normal", name: "hive:build:aaaaaaaa", workflowId: "build", activationHash: "a".repeat(64) });
  assert.deepEqual(created, { piSessionId: "fresh-id", piSessionFile: "/pi/fresh.jsonl" });
  assert.equal((setupCalls[1] as [string, unknown])[0], WORKFLOW_SESSION_MARKER_TYPE);
  let replacementSeen = false;
  await adapter.switch({ piSessionFile: "/pi/fresh.jsonl", withSession: (ctx) => { replacementSeen = ctx !== oldContext; } });
  assert.equal(replacementSeen, true);
});
