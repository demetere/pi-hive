import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withCrossProcessFileLock } from "../core/file-lock";
import { resolveProjectPath } from "../core/safe-path";
import { canonicalJson } from "../config/snapshot-canonical";
import { appendWorkflowEvent, appendWorkflowEventChecked, readWorkflowJournal } from "./journal";
import { createWorkflowEvent } from "./events";

export const SESSION_LINK_FORMAT_VERSION = 1 as const;
export type WorkflowLinkStatus = "current" | "archived";
export interface NormalSessionLink { readonly kind: "normal"; readonly formatVersion: 1; readonly projectId: string; readonly piSessionId: string; readonly piSessionFile: string; readonly normalModel: string; readonly normalThinking: string; readonly normalTools: readonly string[]; readonly createdAt: string; readonly updatedAt: string }
export type WorkflowRecoveryState =
  | Readonly<{ state: "blocked"; codes: readonly string[]; diagnostic: string; attemptedAt: string }>
  | Readonly<{ state: "prepared"; previousPiSessionId: string; previousPiSessionFile: string; preparedAt: string; preparedEventHash: string; expectedLinkHash: string }>
  | Readonly<{ state: "recovered"; previousPiSessionId: string; previousPiSessionFile: string; recoveredAt: string; preparedEventHash: string; eventHash: string }>;
export interface WorkflowSessionLink { readonly kind: "workflow"; readonly formatVersion: 1; readonly workflowSessionId: string; readonly workflowId: string; readonly activationHash: string; readonly piSessionId: string; readonly piSessionFile: string; readonly normalParentId: string; readonly normalParentFile: string; readonly status: WorkflowLinkStatus; readonly stale: boolean; readonly orphaned?: boolean; readonly orphanedAt?: string; readonly recovery?: WorkflowRecoveryState; readonly model: string; readonly thinking: string; readonly tools: readonly string[]; readonly createdAt: string; readonly updatedAt: string; readonly name: string }
export type SessionLink = NormalSessionLink | WorkflowSessionLink;

function sessionInvariant(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function linksPath(root: string): string { const resolved = resolveProjectPath(root, ".pi/hive/sessions/session-links-v1.json", { allowMissing: true }); sessionInvariant(resolved, "SESSION_LINK_PATH_INVALID"); return resolved.lexicalPath; }
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
function readLinks(root: string): SessionLink[] { const path = linksPath(root); try { sessionInvariant(!lstatSync(path).isSymbolicLink(), "SESSION_LINK_PATH_INVALID"); const raw = readFileSync(path, "utf8"); sessionInvariant(Buffer.byteLength(raw) <= 1_048_576, "SESSION_LINK_LIMIT_EXCEEDED"); const value = JSON.parse(raw) as { formatVersion: number; links: SessionLink[] }; sessionInvariant(value.formatVersion === 1 && Array.isArray(value.links), "SESSION_LINK_INVALID"); return value.links; } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
function writeLinksUnlocked(root: string, links: readonly SessionLink[]): void { const path = linksPath(root); const dir = dirname(path); mkdirSync(dir, { recursive: true, mode: 0o700 }); const content = `${JSON.stringify({ formatVersion: 1, links })}\n`; sessionInvariant(Buffer.byteLength(content) <= 1_048_576, "SESSION_LINK_LIMIT_EXCEEDED"); const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; let fd: number | undefined; try { fd = openSync(temp, "wx", 0o600); writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path); const dirFd = openSync(dir, constants.O_RDONLY); try { fsyncSync(dirFd); } finally { closeSync(dirFd); } } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ } try { unlinkSync(temp); } catch { /* published or absent */ } } }
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function listSessionLinks(projectRoot: string): readonly SessionLink[] { return freeze(readLinks(projectRoot).sort((a, b) => (a.kind === b.kind ? (a.kind === "normal" ? compareText(a.piSessionId, (b as NormalSessionLink).piSessionId) : compareText(a.workflowSessionId, (b as WorkflowSessionLink).workflowSessionId)) : a.kind === "normal" ? -1 : 1))); }
/** Serialize identity-sensitive filesystem cleanup with every session-link publication. */
export function withSessionLinkMutationLock<T>(projectRoot: string, inspect: (links: readonly SessionLink[]) => T): T {
  const path = linksPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withCrossProcessFileLock(path, () => inspect(freeze(readLinks(projectRoot))));
}
function mutateLinks(projectRoot: string, mutate: (links: SessionLink[]) => readonly SessionLink[]): void { const path = linksPath(projectRoot); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); withCrossProcessFileLock(path, () => writeLinksUnlocked(projectRoot, mutate(readLinks(projectRoot)))); }
export function replaceSessionLinks(projectRoot: string, links: readonly SessionLink[]): void { mutateLinks(projectRoot, () => links); }
export function commitWorkflowSelection(projectRoot: string, workflowId: string, expectedCurrentId: string | undefined, archived: WorkflowSessionLink | undefined, selected: WorkflowSessionLink): void { mutateLinks(projectRoot, (links) => { const latest = links.find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.workflowId === workflowId && entry.status === "current"); sessionInvariant(latest?.workflowSessionId === expectedCurrentId, "Concurrent workflow selection changed the current session"); return [...links.filter((entry) => entry.kind !== "workflow" || (entry.workflowSessionId !== expectedCurrentId && entry.workflowSessionId !== selected.workflowSessionId)), ...(archived ? [archived] : []), selected]; }); }
/** Exact-CAS compensation for a selection committed before a replacement reload fails. */
export function rollbackWorkflowSelection(projectRoot: string, selected: WorkflowSessionLink, previous: WorkflowSessionLink | undefined): void {
  mutateLinks(projectRoot, (links) => {
    const current = links.find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.workflowId === selected.workflowId && entry.status === "current");
    sessionInvariant(current && sameWorkflowLinkGeneration(current, selected), "Committed workflow selection changed before rollback");
    return [
      ...links.filter((entry) => entry.kind !== "workflow" || (entry.workflowSessionId !== selected.workflowSessionId && entry.workflowSessionId !== previous?.workflowSessionId)),
      ...(previous ? [previous] : []),
    ];
  });
}
export function initializeNormalParent(input: { configured: boolean; projectRoot: string; projectId: string; piSessionId: string; piSessionFile: string; model: string; thinking: string; activeTools: readonly string[] }): { configured: boolean; commands: readonly string[] } {
  if (!input.configured) return freeze({ configured: false, commands: [] });
  const now = new Date().toISOString();
  mutateLinks(input.projectRoot, (links) => {
    const existing = links.find((entry): entry is NormalSessionLink => entry.kind === "normal" && entry.projectId === input.projectId);
    // The first explicit normal session is the canonical parent for every linked
    // workflow generation. Merely opening an unrelated normal chat must not
    // silently retarget selection or exit. A restart of that same Pi session may
    // refresh its model/tool baseline without changing its identity.
    if (existing && existing.piSessionId !== input.piSessionId) return links;
    const normal: NormalSessionLink = freeze({ kind: "normal", formatVersion: 1, projectId: input.projectId, piSessionId: input.piSessionId, piSessionFile: input.piSessionFile, normalModel: input.model, normalThinking: input.thinking, normalTools: [...new Set(input.activeTools)].sort(), createdAt: existing?.createdAt ?? now, updatedAt: now });
    return [normal, ...links.filter((entry) => entry.kind !== "normal")];
  });
  return freeze({ configured: true, commands: ["hive:select", "hive:exit"] });
}
export function upsertWorkflowLink(projectRoot: string, link: WorkflowSessionLink): void { mutateLinks(projectRoot, (links) => [...links.filter((entry) => entry.kind !== "workflow" || entry.workflowSessionId !== link.workflowSessionId), freeze(link)]); }
export function recordWorkflowModelState(projectRoot: string, projectId: string, input: Omit<WorkflowSessionLink, "kind"> | WorkflowSessionLink, model: string, thinking: string, preflight: (model: string, thinking: string) => boolean): WorkflowSessionLink { if (!preflight(model, thinking)) throw new Error("Model/thinking preflight failed"); const now = new Date().toISOString(); const link = freeze({ ...input, kind: "workflow" as const, formatVersion: 1 as const, model, thinking, tools: [...input.tools].sort(), updatedAt: now }); upsertWorkflowLink(projectRoot, link); appendWorkflowEvent(projectRoot, createWorkflowEvent({ projectId, sessionId: link.workflowSessionId, type: "session.selected", payload: { model, thinking }, producer: "runtime" })); return link; }
export function markMissingPiSession(projectRoot: string, projectId: string, workflowSessionId: string): void {
  const now = new Date().toISOString();
  const generation = listSessionLinks(projectRoot).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.workflowSessionId === workflowSessionId);
  const matchesGeneration = (event: { type: string; payload: unknown }): boolean => {
    if (event.type !== "session.orphaned" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return false;
    const payload = event.payload as Record<string, unknown>;
    return generation
      ? payload.piSessionId === generation.piSessionId && payload.piSessionFile === generation.piSessionFile
      : payload.piSessionId === undefined && payload.piSessionFile === undefined;
  };
  const existingEvent = readWorkflowJournal(projectRoot, workflowSessionId).some(matchesGeneration);
  if (!existingEvent) {
    try {
      appendWorkflowEventChecked(projectRoot, createWorkflowEvent({
        projectId, sessionId: workflowSessionId, type: "session.orphaned",
        payload: { reason: "linked Pi session is missing", ...(generation ? { piSessionId: generation.piSessionId, piSessionFile: generation.piSessionFile } : {}) },
        producer: "recovery", timestamp: now,
      }), (events) => {
        if (events.some(matchesGeneration)) throw new Error("Workflow session generation was orphaned concurrently");
      });
    } catch (error) {
      if (!readWorkflowJournal(projectRoot, workflowSessionId).some(matchesGeneration)) throw error;
    }
  }
  mutateLinks(projectRoot, (links) => links.map((entry) => {
    if (entry.kind !== "workflow" || entry.workflowSessionId !== workflowSessionId) return entry;
    sessionInvariant(generation && entry.piSessionId === generation.piSessionId && entry.piSessionFile === generation.piSessionFile, "Workflow session generation changed before orphan marking");
    return freeze({ ...entry, orphaned: true, orphanedAt: entry.orphanedAt ?? now, updatedAt: now });
  }));
}
export function workflowLinkGenerationHash(link: WorkflowSessionLink): string {
  return createHash("sha256").update("pi-hive-workflow-link-generation-v1\0").update(canonicalJson(link)).digest("hex");
}
export function sameWorkflowLinkGeneration(actual: WorkflowSessionLink, expected: WorkflowSessionLink): boolean {
  return workflowLinkGenerationHash(actual) === workflowLinkGenerationHash(expected);
}
export function recordWorkflowRecoveryBlocked(projectRoot: string, projectId: string, expected: WorkflowSessionLink, codes: readonly string[], diagnostic: string): WorkflowSessionLink {
  const attemptedAt = new Date().toISOString();
  const boundedCodes = Object.freeze([...new Set(codes.map((code) => String(code).slice(0, 256)))].sort().slice(0, 64));
  const boundedDiagnostic = String(diagnostic).slice(0, 2_048);
  let result: WorkflowSessionLink | undefined;
  mutateLinks(projectRoot, (links) => links.map((entry) => {
    if (entry.kind !== "workflow" || entry.workflowSessionId !== expected.workflowSessionId) return entry;
    sessionInvariant(sameWorkflowLinkGeneration(entry, expected), "Orphan workflow link changed before blocked recovery update");
    result = freeze({ ...entry, orphaned: true, recovery: { state: "blocked" as const, codes: boundedCodes, diagnostic: boundedDiagnostic, attemptedAt }, updatedAt: attemptedAt });
    return result;
  }));
  sessionInvariant(result, "Orphan workflow session link is missing");
  try {
    appendWorkflowEvent(projectRoot, createWorkflowEvent({
      projectId, sessionId: expected.workflowSessionId, type: "session.recovery.blocked",
      payload: { codes: [...boundedCodes], diagnostic: boundedDiagnostic, expectedLinkHash: workflowLinkGenerationHash(expected) },
      producer: "recovery", timestamp: attemptedAt,
    }));
  } catch {
    // The exact-CAS link state is the fail-closed authority when the audit journal is unavailable.
  }
  return result;
}
function preparedEventMatches(event: { type: string; eventHash: string; payload: unknown }, expected: WorkflowSessionLink, replacement: { piSessionId: string; piSessionFile: string; preparedAt: string; preparedEventHash: string }): boolean {
  if (event.type !== "session.recovery.prepared" || event.eventHash !== replacement.preparedEventHash || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return false;
  const payload = event.payload as Record<string, unknown>;
  return payload.expectedLinkHash === workflowLinkGenerationHash(expected)
    && canonicalJson(payload.expectedLink) === canonicalJson(expected)
    && payload.previousPiSessionId === expected.piSessionId
    && payload.previousPiSessionFile === expected.piSessionFile
    && payload.piSessionId === replacement.piSessionId
    && payload.piSessionFile === replacement.piSessionFile
    && payload.activationHash === expected.activationHash
    && payload.preparedAt === replacement.preparedAt;
}
export function prepareWorkflowRecoveryLink(projectRoot: string, expected: WorkflowSessionLink, replacement: { piSessionId: string; piSessionFile: string; preparedAt: string; preparedEventHash: string }): WorkflowSessionLink {
  const published = readWorkflowJournal(projectRoot, expected.workflowSessionId).find((event) => event.eventHash === replacement.preparedEventHash);
  sessionInvariant(published && preparedEventMatches(published, expected, replacement), "Workflow recovery preparation journal is missing or inconsistent");
  let result: WorkflowSessionLink | undefined;
  mutateLinks(projectRoot, (links) => links.map((entry) => {
    if (entry.kind !== "workflow" || entry.workflowSessionId !== expected.workflowSessionId) return entry;
    sessionInvariant(sameWorkflowLinkGeneration(entry, expected), "Orphan workflow link changed during recovery preparation");
    result = freeze({
      ...entry, piSessionId: replacement.piSessionId, piSessionFile: replacement.piSessionFile, orphaned: true,
      recovery: { state: "prepared" as const, previousPiSessionId: expected.piSessionId, previousPiSessionFile: expected.piSessionFile, preparedAt: replacement.preparedAt, preparedEventHash: replacement.preparedEventHash, expectedLinkHash: workflowLinkGenerationHash(expected) },
      updatedAt: replacement.preparedAt,
    });
    return result;
  }));
  sessionInvariant(result, "Orphan workflow session link is missing");
  return result;
}
function committedEventMatches(event: { type: string; eventHash: string; payload: unknown }, prepared: WorkflowSessionLink, replacement: { recoveredAt: string; preparedEventHash: string; eventHash: string }): boolean {
  if (event.type !== "session.recovered" || event.eventHash !== replacement.eventHash || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return false;
  const payload = event.payload as Record<string, unknown>;
  return prepared.recovery?.state === "prepared"
    && prepared.recovery.preparedEventHash === replacement.preparedEventHash
    && payload.preparedEventHash === replacement.preparedEventHash
    && payload.previousPiSessionId === prepared.recovery.previousPiSessionId
    && payload.previousPiSessionFile === prepared.recovery.previousPiSessionFile
    && payload.piSessionId === prepared.piSessionId
    && payload.piSessionFile === prepared.piSessionFile
    && payload.activationHash === prepared.activationHash
    && payload.recoveredAt === replacement.recoveredAt;
}
export function commitWorkflowRecovery(projectRoot: string, expectedPrepared: WorkflowSessionLink, replacement: { recoveredAt: string; preparedEventHash: string; eventHash: string }): WorkflowSessionLink {
  const published = readWorkflowJournal(projectRoot, expectedPrepared.workflowSessionId).find((event) => event.eventHash === replacement.eventHash);
  sessionInvariant(published && committedEventMatches(published, expectedPrepared, replacement), "Workflow recovery commit journal is missing or inconsistent");
  const preparedRecovery = expectedPrepared.recovery;
  sessionInvariant(preparedRecovery?.state === "prepared", "Workflow recovery link is not prepared");
  let result: WorkflowSessionLink | undefined;
  mutateLinks(projectRoot, (links) => links.map((entry) => {
    if (entry.kind !== "workflow" || entry.workflowSessionId !== expectedPrepared.workflowSessionId) return entry;
    sessionInvariant(sameWorkflowLinkGeneration(entry, expectedPrepared), "Prepared workflow link changed during recovery commit");
    result = freeze({
      ...entry, orphaned: false, orphanedAt: undefined,
      recovery: { state: "recovered" as const, previousPiSessionId: preparedRecovery.previousPiSessionId, previousPiSessionFile: preparedRecovery.previousPiSessionFile, recoveredAt: replacement.recoveredAt, preparedEventHash: replacement.preparedEventHash, eventHash: replacement.eventHash },
      updatedAt: replacement.recoveredAt,
    });
    return result;
  }));
  sessionInvariant(result, "Prepared workflow session link is missing");
  return result;
}
export function rollbackWorkflowRecovery(projectRoot: string, expectedCurrent: WorkflowSessionLink, restore: WorkflowSessionLink, preparedEventHash: string): boolean {
  sessionInvariant(expectedCurrent.workflowSessionId === restore.workflowSessionId, "Workflow recovery rollback identity mismatch");
  sessionInvariant(expectedCurrent.recovery?.state === "prepared" && expectedCurrent.recovery.preparedEventHash === preparedEventHash, "Workflow recovery rollback requires an exact prepared generation");
  let rolledBack = false;
  mutateLinks(projectRoot, (links) => links.map((entry) => {
    if (entry.kind !== "workflow" || entry.workflowSessionId !== expectedCurrent.workflowSessionId) return entry;
    sessionInvariant(sameWorkflowLinkGeneration(entry, expectedCurrent), "Prepared workflow link changed before recovery rollback");
    rolledBack = true;
    return restore;
  }));
  sessionInvariant(rolledBack, "Prepared workflow session link is missing");
  return true;
}
