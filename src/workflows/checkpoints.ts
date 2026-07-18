import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../config/snapshot-canonical";
import { readWorkflowJournal, workflowSessionDirectory, type JournalFaultStage } from "./journal";

export const WORKFLOW_CHECKPOINT_FORMAT_VERSION = 1 as const;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
export interface WorkflowCheckpoint<State = unknown> { readonly formatVersion: 1; readonly sessionId: string; readonly lastSequence: number; readonly lastHash: string; readonly state: State; readonly createdAt: string; readonly checkpointHash: string }
export interface CheckpointInput<State> { readonly lastSequence: number; readonly lastHash: string; readonly state: State }
export interface CheckpointFaultOptions { readonly fault?: (stage: JournalFaultStage) => void }
function hash(value: unknown): string { return createHash("sha256").update("pi-hive-workflow-checkpoint-v1\0").update(canonicalJson(value)).digest("hex"); }
function directory(root: string, id: string): string { return join(workflowSessionDirectory(root, id), "checkpoints"); }
function fsyncDir(path: string) { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function validate<State>(value: WorkflowCheckpoint<State>): void { if (value.formatVersion !== 1 || !Number.isSafeInteger(value.lastSequence) || value.lastSequence < 1 || !/^[0-9a-f]{64}$/u.test(value.lastHash)) throw new Error("Checkpoint format invalid"); const { checkpointHash, ...identity } = value; if (hash(identity) !== checkpointHash) throw new Error("Checkpoint hash mismatch"); canonicalJson(value.state); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
export function writeCheckpoint<State>(root: string, sessionId: string, input: CheckpointInput<State>, options: CheckpointFaultOptions = {}): WorkflowCheckpoint<State> {
  const events = readWorkflowJournal(root, sessionId); const anchor = events[input.lastSequence - 1]; if (!anchor || anchor.eventHash !== input.lastHash) throw new Error("Checkpoint journal hash mismatch");
  const identity = { formatVersion: 1 as const, sessionId, lastSequence: input.lastSequence, lastHash: input.lastHash, state: structuredClone(input.state), createdAt: new Date().toISOString() }; const value = Object.freeze({ ...identity, checkpointHash: hash(identity) }); const content = `${canonicalJson(value)}\n`; if (Buffer.byteLength(content) > MAX_CHECKPOINT_BYTES) throw new Error("Checkpoint size limit exceeded");
  const dir = directory(root, sessionId); mkdirSync(dir, { recursive: true, mode: 0o700 }); if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error("Checkpoint directory invalid");
  const name = `${String(input.lastSequence).padStart(16, "0")}-${input.lastHash}.json`; const target = join(dir, name); const temp = join(dir, `.${name}.${randomUUID()}.tmp`); let fd: number | undefined;
  try { options.fault?.("beforeWrite"); fd = openSync(temp, "wx", 0o600); writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined; options.fault?.("afterFileFsync"); options.fault?.("beforeRename"); renameSync(temp, target); options.fault?.("afterRename"); options.fault?.("beforeDirFsync"); fsyncDir(dir); return value; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ } try { unlinkSync(temp); } catch { /* published or absent */ } }
}
export function loadLatestCheckpoint<State>(root: string, sessionId: string): WorkflowCheckpoint<State> | undefined {
  const dir = directory(root, sessionId); let names: string[]; try { names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort().reverse(); } catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; }
  for (const name of names) { let fd: number | undefined; try { const path = join(dir, name); if (lstatSync(path).isSymbolicLink()) continue; fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const stat = fstatSync(fd); if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CHECKPOINT_BYTES) continue; const value = JSON.parse(readFileSync(fd, "utf8")) as WorkflowCheckpoint<State>; validate(value); return deepFreeze(value); } catch { continue; } finally { if (fd !== undefined) closeSync(fd); } }
  return undefined;
}
