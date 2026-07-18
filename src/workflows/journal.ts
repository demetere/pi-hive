import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withCrossProcessFileLock } from "../core/file-lock";
import { resolveProjectPath } from "../core/safe-path";
import { canonicalJson } from "../config/snapshot-canonical";
import { sealWorkflowEvent, verifyWorkflowEvent, WORKFLOW_EVENT_LIMITS, type WorkflowEventDraft, type WorkflowEventEnvelope } from "./events";

export type JournalFaultStage = "beforeWrite" | "afterFileFsync" | "beforeRename" | "afterRename" | "beforeDirFsync";
export interface JournalFaultOptions { readonly fault?: (stage: JournalFaultStage) => void }

function resolveWorkflowSessionDirectory(projectRoot: string, sessionId: string) {
  let unsafe = false; for (const character of sessionId) if (character === "/" || character === "\\" || character.codePointAt(0) === 0) unsafe = true;
  if (!sessionId || unsafe || Buffer.byteLength(sessionId, "utf8") > 256) throw new Error("WORKFLOW_SESSION_ID_INVALID");
  const relative = `.pi/hive/sessions/${sessionId}`; const resolved = resolveProjectPath(projectRoot, relative, { allowMissing: true });
  if (!resolved) throw new Error("WORKFLOW_SESSION_PATH_INVALID"); return resolved;
}
export function workflowSessionDirectory(projectRoot: string, sessionId: string): string {
  return resolveWorkflowSessionDirectory(projectRoot, sessionId).lexicalPath;
}
export function workflowJournalIdentity(projectRoot: string, sessionId: string): string {
  return join(resolveWorkflowSessionDirectory(projectRoot, sessionId).canonicalPath, "journal");
}
function ensureDirectory(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("WORKFLOW_JOURNAL_DIRECTORY_INVALID"); }
function fsyncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function journalDirectory(root: string, sessionId: string): string { return join(workflowSessionDirectory(root, sessionId), "journal"); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
function parseEvent(path: string): WorkflowEventEnvelope {
  let fd: number | undefined;
  try { if (lstatSync(path).isSymbolicLink()) throw new Error("Workflow journal event symlink denied"); fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const stat = fstatSync(fd); if (!stat.isFile() || stat.size <= 0 || stat.size > WORKFLOW_EVENT_LIMITS.eventBytes) throw new Error("Workflow journal event size invalid"); const value = JSON.parse(readFileSync(fd, "utf8")) as WorkflowEventEnvelope; verifyWorkflowEvent(value); return deepFreeze(value); }
  catch (error) { if (error instanceof Error && /Workflow journal/u.test(error.message)) throw error; throw new Error("Workflow journal event corruption"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function readWorkflowJournal(projectRoot: string, sessionId: string): readonly WorkflowEventEnvelope[] {
  const dir = journalDirectory(projectRoot, sessionId); try { if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error("Workflow journal path invalid"); } catch (error: any) { if (error?.code === "ENOENT") return Object.freeze([]); throw error; }
  const names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort(); const events = names.map((name) => parseEvent(join(dir, name)));
  let previous: string | null = null; let projectId: string | undefined;
  for (let index = 0; index < events.length; index += 1) { const event = events[index]; if (event.sequence !== index + 1) throw new Error("Workflow journal sequence gap or duplicate"); if (event.previousHash !== previous) throw new Error("Workflow journal previous hash mismatch"); if (event.sessionId !== sessionId || (projectId !== undefined && event.projectId !== projectId)) throw new Error("Workflow journal identity mismatch"); const expectedName = `${String(event.sequence).padStart(16, "0")}-${event.eventHash}.json`; if (names[index] !== expectedName) throw new Error("Workflow journal filename/hash mismatch"); projectId = event.projectId; previous = event.eventHash; }
  return Object.freeze(events);
}
export function appendWorkflowEventChecked(
  projectRoot: string,
  draft: WorkflowEventDraft,
  check: (events: readonly WorkflowEventEnvelope[]) => void,
  options: JournalFaultOptions = {},
): WorkflowEventEnvelope {
  const dir = journalDirectory(projectRoot, draft.sessionId); ensureDirectory(dir); const lockResource = join(dir, "append");
  return withCrossProcessFileLock(lockResource, () => {
    const existing = readWorkflowJournal(projectRoot, draft.sessionId); if (existing.some((event) => event.eventId === draft.eventId)) throw new Error("Workflow journal duplicate event ID"); if (existing.length && existing[0].projectId !== draft.projectId) throw new Error("Workflow journal project identity mismatch");
    check(existing);
    const last = existing.at(-1); const event = sealWorkflowEvent(draft, existing.length + 1, last?.eventHash ?? null); const content = `${canonicalJson(event)}\n`;
    const name = `${String(event.sequence).padStart(16, "0")}-${event.eventHash}.json`; const target = join(dir, name); const temp = join(dir, `.${name}.${process.pid}.${randomUUID()}.tmp`); let fd: number | undefined;
    try {
      options.fault?.("beforeWrite"); fd = openSync(temp, "wx", 0o600); writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined; options.fault?.("afterFileFsync"); options.fault?.("beforeRename"); renameSync(temp, target); options.fault?.("afterRename"); options.fault?.("beforeDirFsync"); fsyncDirectory(dir); return event;
    } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ } try { unlinkSync(temp); } catch { /* published or absent */ } }
  }, { timeoutMs: 5_000, staleMs: 30_000 });
}
export function appendWorkflowEvent(projectRoot: string, draft: WorkflowEventDraft, options: JournalFaultOptions = {}): WorkflowEventEnvelope {
  return appendWorkflowEventChecked(projectRoot, draft, () => {}, options);
}
export function inspectJournal(projectRoot: string, sessionId: string): Readonly<Record<string, unknown>> {
  try { const events = readWorkflowJournal(projectRoot, sessionId); const last = events.at(-1); return Object.freeze({ sessionId: sessionId.slice(0, 256), eventCount: events.length, lastSequence: last?.sequence ?? 0, lastHash: last?.eventHash, lastType: last?.type, lastTimestamp: last?.timestamp }); }
  catch (error) { return Object.freeze({ sessionId: sessionId.slice(0, 256), status: "invalid", diagnostic: String(error instanceof Error ? error.message : error).slice(0, 2_048) }); }
}
