import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { acknowledgeSessionReplacementStart, observeSessionReplacementStart } from "../../src/integration/session-replacement-acknowledgement.ts";
import { createPiSessionNavigationAdapter, WORKFLOW_SESSION_MARKER_TYPE } from "../../src/integration/session-links.ts";
import { durablyFlushPiSessionManager } from "../../src/integration/pi-session-manager-compat.ts";
import { trackSessionContext } from "../../src/integration/session-context.ts";
import { initializeNormalParent, listSessionLinks, workflowLinkGenerationHash, type WorkflowSessionLink } from "../../src/workflows/sessions.ts";
import { selectWorkflowSession } from "../../src/workflows/navigation.ts";
import { FakePiSessionManager as SessionManager } from "../helpers/fake-pi-session-manager.ts";

test("linked-session integration loads without the Pi package index or undici", () => {
  const child = spawnSync(process.execPath, [
    "--import", "tsx",
    "--import", "./tests/helpers/register-poison-pi-package-loader.mjs",
    "--input-type=module",
    "--eval", "await import('./src/integration/session-links.ts')",
  ], { cwd: process.cwd(), env: { ...process.env, NODE_V8_COVERAGE: "" }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
});

const generation = Object.freeze({ workflowSessionId: "workflow-link", linkGenerationHash: "f".repeat(64) });
const workflow = Object.freeze({ workflowId: "build", activationHash: "a".repeat(64), source: "current" as const, resumable: true, freshEnabled: true, model: "provider/model", thinking: "medium", tools: ["read"] });

function persistedManager(root: string, id: string): SessionManager {
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.newSession({ id });
  manager.appendCustomEntry("test-anchor", { version: 1 });
  durablyFlushPiSessionManager(manager as never);
  return manager;
}

function replacementInput(root: string, created: { piSessionId: string; piSessionFile: string }) {
  return {
    piSessionFile: created.piSessionFile,
    withSession: async () => {},
    replacement: {
      projectRoot: root,
      projectId: "project-1",
      piSessionId: created.piSessionId,
      restoreSession: join(root, "normal.jsonl"),
      generation,
    },
  };
}

test("Pi navigation precreates a durable public SessionManager child before switching", async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-precreated-session-order-"));
  try {
    const oldManager = persistedManager(root, "normal-session");
    const order: string[] = [];
    let committed = false;
    let oldStale = false;
    const target: any = {
      sessionManager: oldManager,
      async newSession() { throw new Error("newSession must not be used"); },
      async switchSession(path: string, options: any) {
        order.push("switch");
        assert.equal(committed, true, "durable workflow authority exists before native invalidation");
        assert.equal(existsSync(path), true);
        oldStale = true;
        const replacementManager = SessionManager.open(path);
        const fresh = { sessionManager: replacementManager, async switchSession() { throw new Error("unexpected compensation"); } } as any;
        observeSessionReplacementStart(root, "project-1", fresh);
        order.push("session_start");
        acknowledgeSessionReplacementStart(root, "project-1", fresh, generation);
        await options.withSession?.(fresh);
        order.push("callback");
        return { cancelled: false };
      },
    };
    const old = new Proxy(target, { get(value, property, receiver) { if (oldStale) throw new Error(`old context used after replacement: ${String(property)}`); return Reflect.get(value, property, receiver); } }) as ExtensionCommandContext;
    const use = trackSessionContext(old);
    const adapter = createPiSessionNavigationAdapter(old);
    const created = await adapter.create({
      projectRoot: root,
      parentSession: oldManager.getSessionFile()!,
      name: "hive:build:aaaaaaaa",
      workflowId: "build",
      activationHash: "a".repeat(64),
    });
    order.push("precreated");
    assert.equal(use.wasReplaced(), false, "precreation leaves the active Pi context valid");
    const persisted = readFileSync(created.piSessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(persisted[0]?.parentSession, oldManager.getSessionFile(), "public create preserves the canonical parent link");
    assert.equal(persisted.some((entry) => entry.type === "session_info" && entry.name === "hive:build:aaaaaaaa"), true);
    assert.equal(persisted.some((entry) => entry.type === "custom" && entry.customType === WORKFLOW_SESSION_MARKER_TYPE), true);
    committed = true;
    order.push("commit");
    const result = await adapter.switch(replacementInput(root, created));
    assert.equal(result.cancelled, false);
    assert.equal(use.wasReplaced(), true);
    assert.equal(use.replacementContext()?.sessionManager.getSessionId(), created.piSessionId, "result delivery binds inside the fresh protected callback");
    assert.deepEqual(order, ["precreated", "commit", "switch", "session_start", "callback"]);
    assert.doesNotThrow(() => SessionManager.open(created.piSessionFile).appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replacement acknowledgement restores through the still-valid target context on wrong target or missing acknowledgement", async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-replacement-ack-faults-"));
  try {
    for (const stage of ["wrong-target", "wrong-generation", "missing-ack"] as const) {
      const oldManager = persistedManager(root, `normal-${stage}`);
      const restored: string[] = [];
      const context = {
        sessionManager: oldManager,
        async switchSession(path: string, options: any) {
          const expected = SessionManager.open(path);
          const observed = stage === "wrong-target" ? persistedManager(root, `wrong-${stage}`) : expected;
          const fresh = {
            sessionManager: observed,
            async switchSession(restorePath: string, restoreOptions: any) {
              restored.push(restorePath);
              await restoreOptions.withSession?.({ sessionManager: oldManager });
              return { cancelled: false };
            },
          } as any;
          observeSessionReplacementStart(root, "project-1", fresh);
          if (stage !== "missing-ack") acknowledgeSessionReplacementStart(root, "project-1", fresh, stage === "wrong-generation" ? { ...generation, workflowSessionId: "wrong" } : generation);
          await options.withSession?.(fresh);
          return { cancelled: false };
        },
      } as unknown as ExtensionCommandContext;
      const adapter = createPiSessionNavigationAdapter(context);
      const created = await adapter.create({ projectRoot: root, parentSession: oldManager.getSessionFile()!, name: "hive:build", workflowId: "build", activationHash: "a".repeat(64) });
      await assert.rejects(() => adapter.switch({ ...replacementInput(root, created), replacement: { ...replacementInput(root, created).replacement, restoreSession: oldManager.getSessionFile()! } }), /wrong replacement|acknowledge/i);
      assert.deepEqual(restored, [oldManager.getSessionFile()], stage);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh selection durably rolls back authority and removes only its exact unlinked precreated file", async () => {
  for (const stage of ["cancelled", "wrong-target", "missing-ack"] as const) {
    const root = mkdtempSync(join(tmpdir(), `hive-precreated-rollback-${stage}-`));
    try {
      const oldManager = persistedManager(root, `normal-${stage}`);
      initializeNormalParent({ configured: true, projectRoot: root, projectId: "project-1", piSessionId: oldManager.getSessionId(), piSessionFile: oldManager.getSessionFile()!, model: "provider/normal", thinking: "low", activeTools: [] });
      let candidateFile: string | undefined;
      const context = {
        sessionManager: oldManager,
        async switchSession(path: string, options: any) {
          candidateFile = path;
          if (stage === "cancelled") return { cancelled: true };
          const expected = SessionManager.open(path);
          const observed = stage === "wrong-target" ? persistedManager(root, "wrong-target") : expected;
          const fresh = {
            sessionManager: observed,
            async switchSession(_restorePath: string, restoreOptions: any) {
              await restoreOptions.withSession?.({ sessionManager: oldManager });
              return { cancelled: false };
            },
          } as any;
          observeSessionReplacementStart(root, "project-1", fresh);
          await options.withSession?.(fresh);
          return { cancelled: false };
        },
      } as unknown as ExtensionCommandContext;
      const adapter = createPiSessionNavigationAdapter(context);
      await assert.rejects(() => selectWorkflowSession({
        projectRoot: root,
        projectId: "project-1",
        currentPiSessionId: oldManager.getSessionId(),
        workflow,
        adapter,
        owner: { pid: 1, processMarker: "marker", nonce: `owner-${stage}`, verifyDead: () => true },
      }), /cancelled|wrong replacement|acknowledge/i);
      assert.ok(candidateFile);
      assert.equal(existsSync(candidateFile!), false, `${stage}: exact candidate transcript is removed after rollback`);
      assert.deepEqual(listSessionLinks(root).filter((entry) => entry.kind === "workflow"), [], `${stage}: workflow link rolled back`);
      const workflowStateRoot = join(root, ".pi", "hive", "sessions");
      const ownerFiles = existsSync(workflowStateRoot) ? readdirSync(workflowStateRoot, { recursive: true }).filter((entry) => String(entry).endsWith("owner.json")) : [];
      assert.deepEqual(ownerFiles, [], `${stage}: replacement ownership rolled back`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("native switch failure before callback or session_start retains the candidate recovery authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-native-unproven-replacement-"));
  try {
    const oldManager = persistedManager(root, "normal-unproven");
    initializeNormalParent({ configured: true, projectRoot: root, projectId: "project-1", piSessionId: oldManager.getSessionId(), piSessionFile: oldManager.getSessionFile()!, model: "provider/normal", thinking: "low", activeTools: [] });
    let candidateFile = "";
    const context = {
      sessionManager: oldManager,
      async switchSession(path: string) {
        candidateFile = path;
        throw new Error("native replacement failed after invalidating the old runtime");
      },
    } as unknown as ExtensionCommandContext;
    const use = trackSessionContext(context);
    await assert.rejects(() => selectWorkflowSession({
      projectRoot: root, projectId: "project-1", currentPiSessionId: oldManager.getSessionId(), workflow,
      adapter: createPiSessionNavigationAdapter(context), owner: { pid: 1, processMarker: "marker", nonce: "unproven-owner", verifyDead: () => true },
    }), /restoration could not be proven/i);
    const retained = listSessionLinks(root).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.piSessionFile === candidateFile);
    assert.ok(retained, "precommitted candidate link remains recovery authority");
    assert.equal(existsSync(candidateFile), true, "potentially active candidate transcript is never deleted");
    assert.equal(use.wasReplaced(), true, "unknown native invalidation never reuses the old result channel");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session precreation fails closed when the bound manager has no native factory", async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-native-session-factory-"));
  try {
    const oldManager = persistedManager(root, "normal-no-factory");
    const unsupportedManager = new Proxy(oldManager, {
      getPrototypeOf: () => ({ constructor: class UnsupportedSessionManager {} }),
    });
    const context = { sessionManager: unsupportedManager } as unknown as ExtensionCommandContext;
    const adapter = createPiSessionNavigationAdapter(context);
    await assert.rejects(() => adapter.create({ projectRoot: root, parentSession: oldManager.getSessionFile()!, name: "hive:build", workflowId: "build", activationHash: "a".repeat(64) }), /native factory.*refusing session replacement/i);
    assert.deepEqual(readdirSync(join(root, "sessions")), ["normal-no-factory.jsonl"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancellation before native invalidation keeps the old context and result channel", async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-native-cancelled-replacement-"));
  try {
    const oldManager = persistedManager(root, "normal-cancelled");
    const context = { sessionManager: oldManager, async switchSession() { return { cancelled: true }; } } as unknown as ExtensionCommandContext;
    const use = trackSessionContext(context);
    const adapter = createPiSessionNavigationAdapter(context);
    const created = await adapter.create({ projectRoot: root, parentSession: oldManager.getSessionFile()!, name: "hive:build", workflowId: "build", activationHash: "a".repeat(64) });
    assert.equal((await adapter.switch(replacementInput(root, created))).cancelled, true);
    assert.equal(use.wasReplaced(), false);
    assert.equal(use.replacementContext(), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate cleanup rejects an inode/pathname replacement even with a forged matching header", async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-candidate-path-swap-"));
  try {
    const oldManager = persistedManager(root, "normal-path-swap");
    const context = { sessionManager: oldManager, async switchSession() { return { cancelled: true }; } } as unknown as ExtensionCommandContext;
    const adapter = createPiSessionNavigationAdapter(context);
    const created = await adapter.create({ projectRoot: root, parentSession: oldManager.getSessionFile()!, name: "hive:build", workflowId: "build", activationHash: "a".repeat(64) });
    const forged = readFileSync(created.piSessionFile, "utf8");
    const replacement = `${created.piSessionFile}.replacement`;
    writeFileSync(replacement, forged);
    unlinkSync(created.piSessionFile);
    renameSync(replacement, created.piSessionFile);
    assert.throws(() => adapter.cleanup!({ projectRoot: root, created }), /identity|different|replacement/i);
    assert.equal(existsSync(created.piSessionFile), true, "pathname replacement is not removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful fresh selection publishes the committed exact generation on the first target session_start", async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-first-start-authority-"));
  try {
    const oldManager = persistedManager(root, "normal-success");
    initializeNormalParent({ configured: true, projectRoot: root, projectId: "project-1", piSessionId: oldManager.getSessionId(), piSessionFile: oldManager.getSessionFile()!, model: "provider/normal", thinking: "low", activeTools: [] });
    let firstStartLink: WorkflowSessionLink | undefined;
    const context = {
      sessionManager: oldManager,
      async switchSession(path: string, options: any) {
        const manager = SessionManager.open(path);
        const fresh = { sessionManager: manager } as any;
        firstStartLink = listSessionLinks(root).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.piSessionId === manager.getSessionId());
        assert.ok(firstStartLink, "the exact committed link is visible to the first target session_start");
        observeSessionReplacementStart(root, "project-1", fresh);
        acknowledgeSessionReplacementStart(root, "project-1", fresh, { workflowSessionId: firstStartLink.workflowSessionId, linkGenerationHash: workflowLinkGenerationHash(firstStartLink) });
        await options.withSession?.(fresh);
        return { cancelled: false };
      },
    } as unknown as ExtensionCommandContext;
    const selected = await selectWorkflowSession({ projectRoot: root, projectId: "project-1", currentPiSessionId: oldManager.getSessionId(), workflow, adapter: createPiSessionNavigationAdapter(context), owner: { pid: 1, processMarker: "marker", nonce: "owner", verifyDead: () => true } });
    assert.equal(firstStartLink?.workflowSessionId, selected.link.workflowSessionId);
    assert.equal(existsSync(selected.link.piSessionFile), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
