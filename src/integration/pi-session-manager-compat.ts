import { existsSync } from "node:fs";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";

type PiSessionManagerRuntime = ExtensionContext["sessionManager"] | SessionManager;

/**
 * Pi 0.80.7 and 0.80.10 do not expose a public flush operation. Their
 * SessionManager deliberately leaves no-assistant sessions uncreated with the
 * private `flushed` flag false; manually creating that path alone makes the
 * next assistant append use `wx` and fail with EEXIST.
 *
 * Keep the compatibility boundary here: feature-detect the exact manager-owned
 * rewrite operation and its writable state field, then perform the same paired
 * transition used by Pi when it rewrites a loaded session. Unsupported manager
 * layouts fail before native session replacement rather than risking a damaged
 * transcript. No synthetic message is added to model context.
 */
interface Pi080SessionPersistenceSurface {
  _rewriteFile: () => void;
  flushed: boolean;
  isPersisted: () => boolean;
  appendCustomEntry: (customType: string, data?: unknown) => string;
}

function compatibilitySurface(manager: PiSessionManagerRuntime): Pi080SessionPersistenceSurface {
  const candidate = manager as unknown as Partial<Pi080SessionPersistenceSurface>;
  const descriptor = Object.getOwnPropertyDescriptor(manager, "flushed");
  if (
    typeof candidate.isPersisted !== "function"
    || !candidate.isPersisted.call(manager)
    || typeof manager.getSessionFile !== "function"
    || typeof candidate.appendCustomEntry !== "function"
    || typeof candidate._rewriteFile !== "function"
    || typeof candidate.flushed !== "boolean"
    || !descriptor
    || descriptor.get !== undefined
    || descriptor.set !== undefined
    || descriptor.writable !== true
  ) throw new Error("unsupported Pi SessionManager persistence semantics; refusing session replacement");
  return candidate as Pi080SessionPersistenceSurface;
}

/** Validate the Pi 0.80 persistence layout without changing manager state. */
export function assertPiSessionPersistenceCompatibility(manager: PiSessionManagerRuntime): void {
  compatibilitySurface(manager);
  if (!manager.getSessionFile()) throw new Error("Persisted Pi SessionManager has no session file");
}

/**
 * Detect a deferred or previously mis-materialized Pi 0.80 session. An existing
 * path with `flushed === false` is inconsistent and must be repaired before the
 * next assistant entry.
 */
export function piSessionManagerNeedsDurableFlush(manager: PiSessionManagerRuntime): boolean {
  const sessionFile = manager.getSessionFile();
  const candidate = manager as unknown as Partial<Pi080SessionPersistenceSurface>;
  if (!sessionFile || typeof candidate.isPersisted !== "function" || !candidate.isPersisted.call(manager)) return false;
  if (typeof candidate._rewriteFile === "function" && typeof candidate.flushed === "boolean") return !candidate.flushed || !existsSync(sessionFile);
  return !existsSync(sessionFile);
}

/** Append context-free metadata through the runtime manager at this boundary. */
export function appendPiSessionCustomEntry(manager: PiSessionManagerRuntime, customType: string, data?: unknown): string {
  const surface = compatibilitySurface(manager);
  return surface.appendCustomEntry.call(manager, customType, data);
}

/** Rewrite all manager-owned entries and make Pi's actual flush state agree. */
export function durablyFlushPiSessionManager(manager: PiSessionManagerRuntime): string {
  const surface = compatibilitySurface(manager);
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Persisted Pi SessionManager has no session file");
  surface._rewriteFile.call(manager);
  surface.flushed = true;
  if (!existsSync(sessionFile) || surface.flushed !== true) throw new Error("Pi SessionManager did not durably materialize its session file");
  return sessionFile;
}
