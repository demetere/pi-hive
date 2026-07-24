import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionCommandContext, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { UnprovenSessionRestorationError, type CreatedNavigationSession, type SessionNavigationAdapter } from "../workflows/navigation";
import { withSessionLinkMutationLock } from "../workflows/sessions";
import { expectSessionReplacementAcknowledgement, type SessionReplacementAcknowledgementResult } from "./session-replacement-acknowledgement";
import { appendPiSessionCustomEntry, assertPiSessionPersistenceCompatibility, durablyFlushPiSessionManager, piSessionManagerNeedsDurableFlush } from "./pi-session-manager-compat";
import { bindFreshSessionContext, markSessionContextReplaced } from "./session-context";

export const WORKFLOW_SESSION_MARKER_TYPE = "pi-hive-workflow-link-v1";
export const NORMAL_SESSION_MARKER_TYPE = "pi-hive-normal-link-v1";
const NORMAL_SESSION_MARKER_DATA = Object.freeze({ formatVersion: 1 as const });

type PiSessionManager = ExtensionContext["sessionManager"];
type WritablePiSessionManager = SessionManager;
type SwitchSessionOptions = NonNullable<Parameters<ExtensionCommandContext["switchSession"]>[1]>;
type ReplacedSessionContext = Parameters<NonNullable<SwitchSessionOptions["withSession"]>>[0];

interface NativeSessionManagerFactory {
  create(cwd: string, sessionDir: string, options: { parentSession: string }): WritablePiSessionManager;
}

function nativeSessionManagerFactory(currentManager: PiSessionManager): NativeSessionManagerFactory {
  const prototype = Object.getPrototypeOf(currentManager) as { constructor?: unknown } | null;
  const constructor = prototype?.constructor;
  const create = typeof constructor === "function" ? (constructor as unknown as { create?: unknown }).create : undefined;
  if (!prototype || typeof constructor !== "function" || typeof create !== "function") {
    throw new Error("unsupported Pi SessionManager native factory; refusing session replacement");
  }
  return Object.freeze({
    create(cwd: string, sessionDir: string, options: { parentSession: string }) {
      const created = Reflect.apply(create, constructor, [cwd, sessionDir, options]) as unknown;
      if (!created || typeof created !== "object" || Object.getPrototypeOf(created) !== prototype || created === currentManager) {
        throw new Error("unsupported Pi SessionManager native factory result; refusing session replacement");
      }
      return created as WritablePiSessionManager;
    },
  });
}

function assertPrecreatedManagerCompatibility(currentManager: PiSessionManager, manager: WritablePiSessionManager): void {
  assertPiSessionPersistenceCompatibility(manager);
  const sessionFile = manager.getSessionFile();
  if (
    manager.getCwd() !== currentManager.getCwd()
    || resolve(manager.getSessionDir()) !== resolve(currentManager.getSessionDir())
    || !sessionFile
    || dirname(resolve(sessionFile)) !== resolve(currentManager.getSessionDir())
    || typeof manager.getSessionId() !== "string"
    || manager.getSessionId().length === 0
    || typeof manager.appendSessionInfo !== "function"
  ) throw new Error("unsupported Pi SessionManager precreation semantics; refusing session replacement");
}

function assertPrecreatedSessionHeader(manager: WritablePiSessionManager, parentSession: string): void {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Precreated Pi SessionManager has no session file");
  let header: unknown;
  try { header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n", 1)[0]); }
  catch { throw new Error("Precreated Pi SessionManager wrote an invalid session header"); }
  if (
    !header
    || typeof header !== "object"
    || (header as { type?: unknown }).type !== "session"
    || (header as { id?: unknown }).id !== manager.getSessionId()
    || (header as { parentSession?: unknown }).parentSession !== parentSession
  ) throw new Error("Precreated Pi SessionManager did not preserve session identity and parent semantics");
}

/**
 * Give a normal Pi session a durable, context-free anchor before it can become
 * a workflow parent. Pi allocates a file path before it creates that file, and
 * slash-command-only chats otherwise have no persisted return target.
 */
export function materializeNormalSession(manager: PiSessionManager): string | undefined {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) return undefined;
  if (existsSync(sessionFile) && !piSessionManagerNeedsDurableFlush(manager)) return sessionFile;
  const alreadyMarked = manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === NORMAL_SESSION_MARKER_TYPE);
  if (!alreadyMarked) appendPiSessionCustomEntry(manager, NORMAL_SESSION_MARKER_TYPE, NORMAL_SESSION_MARKER_DATA);
  return durablyFlushPiSessionManager(manager);
}

async function restoreReplacementOrThrow(fresh: ReplacedSessionContext, restoreSession: string | undefined, cause: unknown, onRestored?: (ctx: ReplacedSessionContext) => void): Promise<never> {
  if (!restoreSession) throw new UnprovenSessionRestorationError([cause, new Error("Original Pi session restoration target is unavailable")]);
  let callbackVerified = false;
  try {
    const restored = await fresh.switchSession(restoreSession, {
      withSession: async (normal) => {
        if (normal.sessionManager.getSessionFile() !== restoreSession) throw new Error("Pi restored the wrong replacement session");
        callbackVerified = true;
        onRestored?.(normal);
      },
    });
    if (restored.cancelled) throw new Error("Pi replacement session restoration was cancelled");
    if (!callbackVerified) throw new Error("Pi replacement session restoration callback was not observed");
  } catch (restoreError) {
    throw new UnprovenSessionRestorationError([cause, restoreError]);
  }
  throw cause;
}

function replacementIdentity(manager: PiSessionManager): CreatedNavigationSession {
  const piSessionFile = manager.getSessionFile();
  if (!piSessionFile || !existsSync(piSessionFile)) throw new Error("Workflow Pi session is not durably persisted");
  return Object.freeze({ piSessionId: manager.getSessionId(), piSessionFile });
}

function replacementFailure(observed: SessionReplacementAcknowledgementResult): Error {
  return new Error(observed.sessionStartObserved
    ? `Replacement session_start did not acknowledge the exact workflow generation (observed ${observed.observed?.projectId}/${observed.observed?.piSessionId})`
    : "Replacement completed without an exact session_start acknowledgement");
}

interface PrecreatedSessionOwnership { readonly directory: string; readonly dev: number; readonly ino: number }
function capturePrecreatedSessionOwnership(path: string, expectedDirectory: string): PrecreatedSessionOwnership {
  const exactFile = resolve(path);
  const exactDirectory = resolve(expectedDirectory);
  if (dirname(exactFile) !== exactDirectory || realpathSync(dirname(exactFile)) !== realpathSync(exactDirectory)) throw new Error("Refusing unsafe precreated Pi session identity");
  const stat = lstatSync(exactFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Refusing unsafe precreated Pi session identity");
  return Object.freeze({ directory: exactDirectory, dev: stat.dev, ino: stat.ino });
}
function safeCleanupPrecreatedSession(projectRoot: string, created: CreatedNavigationSession, expected: PrecreatedSessionOwnership): void {
  withSessionLinkMutationLock(projectRoot, (links) => {
    if (links.some((link) => link.piSessionId === created.piSessionId || link.piSessionFile === created.piSessionFile)) throw new Error("Refusing to remove a linked or successor Pi session");
    const exactFile = resolve(created.piSessionFile);
    if (dirname(exactFile) !== expected.directory || !existsSync(exactFile)) return;
    if (realpathSync(dirname(exactFile)) !== realpathSync(expected.directory)) throw new Error("Refusing unsafe precreated Pi session cleanup");
    let fd: number | undefined;
    try {
      fd = openSync(exactFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error("Refusing to remove a pathname replacement with different identity");
      const firstLine = readFileSync(fd, "utf8").split("\n", 1)[0];
      let header: unknown;
      try { header = JSON.parse(firstLine); }
      catch { throw new Error("Refusing to remove an invalid precreated Pi session"); }
      if (!header || typeof header !== "object" || (header as { type?: unknown }).type !== "session" || (header as { id?: unknown }).id !== created.piSessionId) throw new Error("Refusing to remove a different precreated Pi session");
      const pathStat = lstatSync(exactFile);
      if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino || pathStat.isSymbolicLink()) throw new Error("Refusing to remove a concurrently replaced Pi session pathname");
      const quarantine = `${exactFile}.${randomUUID()}.cleanup`;
      let moved = false;
      try {
        renameSync(exactFile, quarantine);
        moved = true;
        const movedStat = lstatSync(quarantine);
        if (movedStat.dev !== stat.dev || movedStat.ino !== stat.ino || movedStat.isSymbolicLink()) throw new Error("Refusing to remove a concurrently replaced Pi session identity");
        if (existsSync(exactFile)) throw new Error("Refusing cleanup after a successor Pi session pathname appeared");
        unlinkSync(quarantine);
        moved = false;
      } catch (error) {
        if (moved && !existsSync(exactFile)) {
          try { renameSync(quarantine, exactFile); moved = false; }
          catch { /* Preserve the quarantined inode for doctor/recovery instead of deleting uncertain state. */ }
        }
        throw error;
      }
    } finally { if (fd !== undefined) closeSync(fd); }
  });
}

/**
 * Precreate workflow transcripts through Pi's public SessionManager API. The
 * workflow layer commits link/handoff/ownership authority while the current
 * context is still valid, then calls switch() with that exact durable identity.
 * The first target session_start can therefore restore every runtime surface
 * and publish the exact replacement acknowledgement without a second reload.
 */
export function createPiSessionNavigationAdapter(commandContext: ExtensionCommandContext): SessionNavigationAdapter {
  const precreatedSessions = new Map<string, PrecreatedSessionOwnership>();
  return {
    async create(input) {
      const currentManager = commandContext.sessionManager;
      assertPiSessionPersistenceCompatibility(currentManager);
      const factory = nativeSessionManagerFactory(currentManager);
      const manager = factory.create(currentManager.getCwd(), currentManager.getSessionDir(), { parentSession: input.parentSession });
      const piSessionFile = manager.getSessionFile();
      if (!piSessionFile) throw new Error("Precreated Pi SessionManager has no session file");
      try {
        assertPrecreatedManagerCompatibility(currentManager, manager);
        manager.appendSessionInfo(input.name);
        appendPiSessionCustomEntry(manager, WORKFLOW_SESSION_MARKER_TYPE, {
          formatVersion: 1,
          workflowId: input.workflowId,
          activationHash: input.activationHash,
          ...(input.recovery ? { recovery: input.recovery } : {}),
        });
        durablyFlushPiSessionManager(manager);
        assertPrecreatedSessionHeader(manager, input.parentSession);
        const created = replacementIdentity(manager);
        precreatedSessions.set(piSessionFile, capturePrecreatedSessionOwnership(piSessionFile, manager.getSessionDir()));
        return created;
      } catch (error) {
        const created = Object.freeze({ piSessionId: manager.getSessionId(), piSessionFile });
        if (existsSync(piSessionFile)) {
          try { safeCleanupPrecreatedSession(input.projectRoot, created, capturePrecreatedSessionOwnership(piSessionFile, manager.getSessionDir())); }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], "Pi session precreation failed and cleanup was incomplete"); }
        }
        throw error;
      }
    },
    cleanup(input) {
      const expected = precreatedSessions.get(input.created.piSessionFile);
      if (!expected) throw new Error("Precreated Pi session is not owned by this navigation adapter");
      safeCleanupPrecreatedSession(input.projectRoot, input.created, expected);
      precreatedSessions.delete(input.created.piSessionFile);
    },
    async switch(input) {
      const restoreSession = input.replacement?.restoreSession ?? commandContext.sessionManager.getSessionFile();
      const switchSession = commandContext.switchSession.bind(commandContext);
      const bindFresh = (fresh: ReplacedSessionContext): void => bindFreshSessionContext(commandContext, fresh);
      if (!input.replacement) {
        let callbackObserved = false;
        try {
          const result = await switchSession(input.piSessionFile, {
            withSession: async (fresh) => {
              callbackObserved = true;
              bindFresh(fresh);
              try { await input.withSession(fresh); }
              catch (error) { return restoreReplacementOrThrow(fresh, restoreSession, error, bindFresh); }
            },
          });
          if (result.cancelled && callbackObserved) throw new UnprovenSessionRestorationError([new Error("Pi reported cancellation after replacement callback")]);
          return result;
        } catch (error) {
          if (callbackObserved || error instanceof UnprovenSessionRestorationError) throw error;
          markSessionContextReplaced(commandContext);
          throw new UnprovenSessionRestorationError([error, new Error("Native session replacement may have invalidated the original context before callback")]);
        }
      }

      const expected = input.replacement;
      const acknowledgement = expectSessionReplacementAcknowledgement({
        projectRoot: expected.projectRoot,
        projectId: expected.projectId,
        piSessionId: expected.piSessionId,
        generation: expected.generation,
      });
      let acknowledgementResult: SessionReplacementAcknowledgementResult | undefined;
      let callbackObserved = false;
      try {
        const result = await switchSession(input.piSessionFile, {
          withSession: async (fresh) => {
            callbackObserved = true;
            bindFresh(fresh);
            acknowledgementResult = acknowledgement.finish();
            let actual: CreatedNavigationSession;
            try { actual = replacementIdentity(fresh.sessionManager); }
            catch (error) { return restoreReplacementOrThrow(fresh, restoreSession, error, bindFresh); }
            if (actual.piSessionId !== expected.piSessionId || actual.piSessionFile !== input.piSessionFile) return restoreReplacementOrThrow(fresh, restoreSession, new Error("Pi switched to the wrong replacement session"), bindFresh);
            if (!acknowledgementResult.acknowledged) return restoreReplacementOrThrow(fresh, restoreSession, replacementFailure(acknowledgementResult), bindFresh);
            try { await input.withSession(fresh); }
            catch (error) { return restoreReplacementOrThrow(fresh, restoreSession, error, bindFresh); }
          },
        });
        acknowledgementResult ??= acknowledgement.finish();
        if (result.cancelled) {
          if (!callbackObserved && !acknowledgementResult.sessionStartObserved) return result;
          throw new UnprovenSessionRestorationError([new Error("Pi reported cancellation after replacement invalidation")]);
        }
        if (!callbackObserved) throw new UnprovenSessionRestorationError([
          new Error("Pi replacement session callback was not observed"),
          new Error(acknowledgementResult.sessionStartObserved ? "Replacement context is unavailable for restoration" : "Native replacement completion did not prove the active session"),
        ]);
        return result;
      } catch (error) {
        acknowledgementResult ??= acknowledgement.finish();
        if (!callbackObserved && !(error instanceof UnprovenSessionRestorationError)) {
          markSessionContextReplaced(commandContext);
          throw new UnprovenSessionRestorationError([error, new Error(acknowledgementResult.sessionStartObserved ? "Replacement context is unavailable for restoration" : "Native session replacement may have invalidated the original context before proof")]);
        }
        if (!callbackObserved) markSessionContextReplaced(commandContext);
        throw error;
      }
    },
  };
}
