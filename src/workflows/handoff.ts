import { createHash } from "node:crypto";
import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";
import type { DynamicPromptInput } from "./prompts";
import {
  createEmptyRunLifecycleState,
  reduceRunLifecycle,
  terminalEnvelopeFromEvent,
  type ArtifactReference,
  type EvidenceReference,
  type FileChangeRecord,
  type PersistedTerminalEnvelope,
  type TerminalRunStatus,
} from "./runs";
import { createWorkflowEvent, type WorkflowEventEnvelope } from "./events";
import { appendWorkflowEventChecked, readWorkflowJournal, type JournalFaultOptions } from "./journal";
import { replayWorkflowJournal } from "./replay";
import { listSessionLinks, type WorkflowSessionLink } from "./sessions";

export const HANDOFF_FORMAT_VERSION = 1 as const;
export const HANDOFF_LIMITS = Object.freeze({
  packetBytes: 131_072,
  dataBytes: 65_536,
  dataDepth: 16,
  dataNodes: 4_096,
  summaryBytes: 8_192,
  idBytes: 256,
  referenceItems: 128,
  referenceFieldBytes: 2_048,
  fileChanges: 4_096,
  consumedRecords: 4_096,
});

export interface HandoffPacketSource {
  readonly projectId: string;
  readonly workflowId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly terminalEventHash: string;
}
export interface HandoffPacket {
  readonly formatVersion: 1;
  readonly packetHash: string;
  readonly createdAt: string;
  readonly source: HandoffPacketSource;
  readonly terminal: Readonly<{ status: TerminalRunStatus; summary: string; finishedAt: string }>;
  readonly fileChanges: readonly FileChangeRecord[];
  readonly changeCoverage: string;
  /** W17 must revalidate these refs before adapter binding or mutation. */
  readonly artifactRefsAreCandidates: true;
  readonly artifactRefs: readonly ArtifactReference[];
  readonly evidenceRefs: readonly EvidenceReference[];
  readonly data: Readonly<Record<string, JsonValue>>;
}
export interface ConsumedHandoff {
  readonly packet: HandoffPacket;
  readonly runId: string;
  readonly inputId: string;
  readonly consumedAt: string;
  readonly sequence: number;
}
export interface HandoffState {
  readonly staged?: HandoffPacket;
  readonly consumed: readonly ConsumedHandoff[];
}

function handoffInvariant(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} contains unsupported field: ${unknown}`);
  const missing = allowed.find((key) => !(key in value));
  if (missing) throw new Error(`${label} is missing field: ${missing}`);
}
function bounded(value: unknown, label: string, maxBytes: number = HANDOFF_LIMITS.referenceFieldBytes): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes || value.includes("\0")) throw new Error(`${label} is invalid or exceeds its limit`);
  return value;
}
function identifier(value: unknown, label: string): string { return bounded(value, label, HANDOFF_LIMITS.idBytes); }
function digest(value: unknown, label: string, prefixed = true): string {
  const result = bounded(value, label, 80);
  const expression = prefixed ? /^sha256:[0-9a-f]{64}$/u : /^[0-9a-f]{64}$/u;
  if (!expression.test(result)) throw new Error(`${label} is not a SHA-256 digest`);
  return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function jsonData(value: unknown): Readonly<Record<string, JsonValue>> {
  if (!plainRecord(value)) throw new Error("Handoff data must be a plain JSON object");
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > HANDOFF_LIMITS.dataNodes || current.depth > HANDOFF_LIMITS.dataDepth) throw new Error("Handoff data exceeds its structural limit");
    if (current.value === null || typeof current.value === "string" || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") { if (!Number.isFinite(current.value)) throw new Error("Handoff data is not JSON"); continue; }
    if (Array.isArray(current.value)) { for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 }); continue; }
    if (!plainRecord(current.value)) throw new Error("Handoff data is not JSON");
    for (const [key, child] of Object.entries(current.value)) {
      bounded(key, "Handoff data key");
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  const cloned = structuredClone(value) as Record<string, JsonValue>;
  if (Buffer.byteLength(canonicalJson(cloned), "utf8") > HANDOFF_LIMITS.dataBytes) throw new Error("Handoff data exceeds its byte limit");
  return freeze(cloned);
}
function projectPath(value: unknown, label: string): string {
  const result = bounded(value, label, 4_096);
  if (result.startsWith("/") || result.includes("\\") || result.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`${label} is not a normalized project-relative path`);
  return result;
}
function parseFileChanges(value: unknown): readonly FileChangeRecord[] {
  if (!Array.isArray(value) || value.length > HANDOFF_LIMITS.fileChanges) throw new Error("Handoff file changes exceed their limit");
  return freeze(value.map((entry, index): FileChangeRecord => {
    if (!plainRecord(entry)) throw new Error(`Handoff fileChanges[${index}] is invalid`);
    const allowed = ["path", "previousPath", "operation", "beforeHash", "afterHash", "attribution"];
    const unknown = Object.keys(entry).find((key) => !allowed.includes(key));
    if (unknown) throw new Error(`Handoff fileChanges[${index}] contains unsupported field: ${unknown}`);
    if (entry.operation !== "create" && entry.operation !== "update" && entry.operation !== "delete" && entry.operation !== "rename") throw new Error(`Handoff fileChanges[${index}] operation is invalid`);
    if (!new Set(["recorded", "reconciled", "unknown", "git-reconciled", "scoped-reconciled", "conflicted", "unattributed"]).has(String(entry.attribution))) throw new Error(`Handoff fileChanges[${index}] attribution is invalid`);
    const path = projectPath(entry.path, `Handoff fileChanges[${index}].path`);
    const previousPath = entry.previousPath === undefined ? undefined : projectPath(entry.previousPath, `Handoff fileChanges[${index}].previousPath`);
    const beforeHash = entry.beforeHash === undefined ? undefined : digest(entry.beforeHash, `Handoff fileChanges[${index}].beforeHash`);
    const afterHash = entry.afterHash === undefined ? undefined : digest(entry.afterHash, `Handoff fileChanges[${index}].afterHash`);
    if (entry.operation === "create" && (beforeHash || previousPath || !afterHash)) throw new Error("Handoff create change hash shape is invalid");
    if (entry.operation === "update" && (!beforeHash || !afterHash || previousPath)) throw new Error("Handoff update change hash shape is invalid");
    if (entry.operation === "delete" && (!beforeHash || afterHash || previousPath)) throw new Error("Handoff delete change hash shape is invalid");
    if (entry.operation === "rename" && (!beforeHash || !afterHash || !previousPath || previousPath === path)) throw new Error("Handoff rename change hash shape is invalid");
    return freeze({ path, ...(previousPath ? { previousPath } : {}), operation: entry.operation, ...(beforeHash ? { beforeHash } : {}), ...(afterHash ? { afterHash } : {}), attribution: entry.attribution as FileChangeRecord["attribution"] });
  }));
}
function parseArtifactRefs(value: unknown): readonly ArtifactReference[] {
  if (!Array.isArray(value) || value.length > HANDOFF_LIMITS.referenceItems) throw new Error("Handoff artifact refs exceed their limit");
  return freeze(value.map((entry, index) => {
    if (!plainRecord(entry)) throw new Error(`Handoff artifactRefs[${index}] is invalid`);
    exactKeys(entry, ["workspaceId", "checkpoint", "digest"], `Handoff artifactRefs[${index}]`);
    return freeze({ workspaceId: bounded(entry.workspaceId, "Handoff artifact workspace"), checkpoint: bounded(entry.checkpoint, "Handoff artifact checkpoint"), digest: digest(entry.digest, "Handoff artifact digest") });
  }));
}
function parseEvidenceRefs(value: unknown): readonly EvidenceReference[] {
  if (!Array.isArray(value) || value.length > HANDOFF_LIMITS.referenceItems) throw new Error("Handoff evidence refs exceed their limit");
  return freeze(value.map((entry, index) => {
    if (!plainRecord(entry)) throw new Error(`Handoff evidenceRefs[${index}] is invalid`);
    const allowed = entry.toolCallId === undefined ? ["kind", "claim"] : ["kind", "toolCallId", "claim"];
    exactKeys(entry, allowed, `Handoff evidenceRefs[${index}]`);
    return freeze({ kind: bounded(entry.kind, "Handoff evidence kind"), ...(entry.toolCallId === undefined ? {} : { toolCallId: identifier(entry.toolCallId, "Handoff evidence tool call") }), claim: bounded(entry.claim, "Handoff evidence claim") });
  }));
}
function packetIdentity(packet: Omit<HandoffPacket, "packetHash">): Omit<HandoffPacket, "packetHash"> { return packet; }
function packetHash(packet: Omit<HandoffPacket, "packetHash">): string {
  return createHash("sha256").update("pi-hive-handoff-packet-v1\0").update(canonicalJson(packet)).digest("hex");
}

export interface CreateHandoffPacketInput {
  readonly projectId: string;
  readonly workflowId: string;
  readonly sessionId: string;
  readonly terminal: PersistedTerminalEnvelope;
  readonly createdAt?: string;
}
export function createHandoffPacket(input: CreateHandoffPacketInput): HandoffPacket {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const identity: Omit<HandoffPacket, "packetHash"> = {
    formatVersion: HANDOFF_FORMAT_VERSION,
    createdAt,
    source: {
      projectId: input.projectId,
      workflowId: input.workflowId,
      sessionId: input.sessionId,
      runId: input.terminal.runId,
      snapshotId: input.terminal.snapshotId,
      terminalEventHash: input.terminal.terminalEventHash,
    },
    terminal: { status: input.terminal.status, summary: input.terminal.summary, finishedAt: input.terminal.finishedAt },
    fileChanges: input.terminal.fileChanges,
    changeCoverage: input.terminal.changeCoverage,
    artifactRefsAreCandidates: true,
    artifactRefs: input.terminal.artifactRefs,
    evidenceRefs: input.terminal.evidenceRefs,
    data: input.terminal.data,
  };
  return verifyHandoffPacket({ ...identity, packetHash: packetHash(packetIdentity(identity)) }, input.projectId);
}

export function verifyHandoffPacket(value: unknown, expectedProjectId?: string): HandoffPacket {
  if (!plainRecord(value)) throw new Error("Handoff packet is invalid");
  exactKeys(value, ["formatVersion", "packetHash", "createdAt", "source", "terminal", "fileChanges", "changeCoverage", "artifactRefsAreCandidates", "artifactRefs", "evidenceRefs", "data"], "Handoff packet");
  if (value.formatVersion !== HANDOFF_FORMAT_VERSION) throw new Error("Handoff packet format is unsupported");
  const hash = digest(value.packetHash, "Handoff packet hash", false);
  const createdAt = bounded(value.createdAt, "Handoff createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Handoff createdAt is invalid");
  if (!plainRecord(value.source)) throw new Error("Handoff packet source is invalid");
  exactKeys(value.source, ["projectId", "workflowId", "sessionId", "runId", "snapshotId", "terminalEventHash"], "Handoff source");
  const source = freeze({
    projectId: identifier(value.source.projectId, "Handoff source project"),
    workflowId: identifier(value.source.workflowId, "Handoff source workflow"),
    sessionId: identifier(value.source.sessionId, "Handoff source session"),
    runId: identifier(value.source.runId, "Handoff source run"),
    snapshotId: digest(value.source.snapshotId, "Handoff source snapshot", false),
    terminalEventHash: digest(value.source.terminalEventHash, "Handoff source terminal event", false),
  });
  if (expectedProjectId !== undefined && source.projectId !== expectedProjectId) throw new Error("Handoff packet belongs to a different canonical project");
  if (!plainRecord(value.terminal)) throw new Error("Handoff terminal is invalid");
  exactKeys(value.terminal, ["status", "summary", "finishedAt"], "Handoff terminal");
  if (!new Set(["completed", "blocked", "failed", "cancelled"]).has(String(value.terminal.status))) throw new Error("Handoff terminal status is invalid");
  const finishedAt = bounded(value.terminal.finishedAt, "Handoff terminal finishedAt");
  if (!Number.isFinite(Date.parse(finishedAt))) throw new Error("Handoff terminal finishedAt is invalid");
  const terminal = freeze({ status: value.terminal.status as TerminalRunStatus, summary: bounded(value.terminal.summary, "Handoff terminal summary", HANDOFF_LIMITS.summaryBytes), finishedAt });
  if (value.artifactRefsAreCandidates !== true) throw new Error("Handoff artifact references must remain non-authoritative candidates");
  const result: HandoffPacket = {
    formatVersion: HANDOFF_FORMAT_VERSION,
    packetHash: hash,
    createdAt,
    source,
    terminal,
    fileChanges: parseFileChanges(value.fileChanges),
    changeCoverage: bounded(value.changeCoverage, "Handoff change coverage", 128),
    artifactRefsAreCandidates: true,
    artifactRefs: parseArtifactRefs(value.artifactRefs),
    evidenceRefs: parseEvidenceRefs(value.evidenceRefs),
    data: jsonData(value.data),
  };
  const { packetHash: _packetHash, ...identity } = result;
  if (packetHash(identity) !== hash) throw new Error("Handoff packet hash mismatch");
  if (Buffer.byteLength(canonicalJson(result), "utf8") > HANDOFF_LIMITS.packetBytes) throw new Error("Handoff packet exceeds its byte limit");
  return freeze(result);
}

/** Verify packet identity against the authoritative linked source journal, not caller-supplied hashes. */
export function verifyHandoffPacketSource(projectRoot: string, projectId: string, value: unknown): HandoffPacket {
  const packet = verifyHandoffPacket(value, projectId);
  const link = listSessionLinks(projectRoot).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.workflowSessionId === packet.source.sessionId);
  if (!link || link.workflowId !== packet.source.workflowId) throw new Error("Handoff source is not linked to the claimed workflow in this project");
  if (link.activationHash !== packet.source.snapshotId) throw new Error("Handoff source snapshot does not match its linked activation");
  const events = readWorkflowJournal(projectRoot, link.workflowSessionId);
  if (!events.length || events.some((event) => event.projectId !== projectId)) throw new Error("Handoff source journal belongs to a different or missing canonical project");
  replayWorkflowJournal(events, createEmptyRunLifecycleState(link.workflowSessionId), reduceRunLifecycle);
  const terminalEvents = events.filter((event) => event.type === "terminal.recorded" && event.runId === packet.source.runId);
  if (terminalEvents.length !== 1) throw new Error("Handoff source run does not have one authoritative terminal event");
  const terminalEvent = terminalEvents[0];
  if (terminalEvent.producer !== "harness" || terminalEvent.eventHash !== packet.source.terminalEventHash) throw new Error("Handoff source terminal event hash or authority does not match");
  const terminal = terminalEnvelopeFromEvent(terminalEvent);
  const derived = createHandoffPacket({ projectId, workflowId: link.workflowId, sessionId: link.workflowSessionId, terminal, createdAt: terminal.finishedAt });
  if (canonicalJson(derived) !== canonicalJson(packet)) throw new Error("Handoff packet does not match its authoritative source terminal envelope");
  return derived;
}

export function createEmptyHandoffState(): HandoffState { return freeze({ consumed: [] }); }
function eventPayload(event: WorkflowEventEnvelope): Record<string, unknown> {
  if (!plainRecord(event.payload) || event.payload.formatVersion !== HANDOFF_FORMAT_VERSION) throw new Error("Handoff event payload is invalid");
  return event.payload;
}
function runStartHandoff(event: WorkflowEventEnvelope): Readonly<{ packetHash: string; inputId: string }> | undefined {
  if (event.type !== "run.started") return undefined;
  if (!plainRecord(event.payload) || event.payload.handoffPacketHash === undefined) return undefined;
  const hash = digest(event.payload.handoffPacketHash, "Run handoff packet hash", false);
  const input = event.payload.input;
  if (!plainRecord(input)) throw new Error("Run handoff input is invalid");
  return freeze({ packetHash: hash, inputId: identifier(input.inputId, "Run handoff input ID") });
}
export function reduceHandoffState(state: HandoffState, event: WorkflowEventEnvelope): HandoffState {
  if (event.type === "handoff.recorded") {
    if (event.producer !== "harness") throw new Error("Handoff state event lacks harness authority");
    const payload = eventPayload(event);
    if (payload.operation === "stage") {
      const packet = verifyHandoffPacket(payload.packet, event.projectId);
      if (state.staged) throw new Error("A staged handoff already exists");
      return freeze({ ...state, staged: packet });
    }
    if (payload.operation === "clear") {
      const expected = digest(payload.packetHash, "Cleared handoff hash", false);
      if (!state.staged || state.staged.packetHash !== expected) throw new Error("Staged handoff changed before clear");
      return freeze({ ...state, staged: undefined });
    }
    throw new Error("Handoff state operation is unsupported");
  }
  const consumed = runStartHandoff(event);
  if (!consumed) return state;
  if (event.producer !== "runtime" || !event.runId) throw new Error("Handoff consumption lacks runtime authority");
  if (!state.staged || state.staged.packetHash !== consumed.packetHash) throw new Error("Run cannot consume a missing or different staged handoff");
  if (state.consumed.length >= HANDOFF_LIMITS.consumedRecords) throw new Error("Handoff consumption history exceeds its bound");
  return freeze({ staged: undefined, consumed: [...state.consumed, { packet: state.staged, runId: event.runId, inputId: consumed.inputId, consumedAt: event.timestamp, sequence: event.sequence }] });
}
export function restoreHandoffState(events: readonly WorkflowEventEnvelope[]): HandoffState {
  return events.reduce(reduceHandoffState, createEmptyHandoffState());
}
export function readHandoffState(projectRoot: string, targetSessionId: string): HandoffState {
  return restoreHandoffState(readWorkflowJournal(projectRoot, targetSessionId));
}
export function handoffForRun(events: readonly WorkflowEventEnvelope[], runId: string): HandoffPacket | undefined {
  return restoreHandoffState(events).consumed.find((entry) => entry.runId === runId)?.packet;
}
export function readHandoffPacket(projectRoot: string, sessionId: string, packetHashValue: string): HandoffPacket | undefined {
  digest(packetHashValue, "Handoff packet reference", false);
  const state = readHandoffState(projectRoot, sessionId);
  if (state.staged?.packetHash === packetHashValue) return state.staged;
  return state.consumed.find((entry) => entry.packet.packetHash === packetHashValue)?.packet;
}
export function hasOpenRun(events: readonly WorkflowEventEnvelope[]): boolean {
  let openRunId: string | undefined;
  for (const event of events) {
    if (event.type === "run.started") openRunId = event.runId;
    else if (event.type === "terminal.recorded" && event.runId === openRunId) openRunId = undefined;
  }
  return openRunId !== undefined;
}
export interface StageHandoffInput extends JournalFaultOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly targetSessionId: string;
  readonly targetWorkflowId: string;
  readonly packet: HandoffPacket;
  readonly now?: () => string;
}
export function stageHandoff(input: StageHandoffInput): Readonly<{ staged: boolean; duplicate: boolean; packet: HandoffPacket }> {
  const packet = verifyHandoffPacketSource(input.projectRoot, input.projectId, input.packet);
  if (packet.source.workflowId === input.targetWorkflowId) throw new Error("Handoff target must be a different workflow");
  const initial = readWorkflowJournal(input.projectRoot, input.targetSessionId);
  if (hasOpenRun(initial)) throw new Error("Target workflow session must be idle before handoff staging");
  const existing = restoreHandoffState(initial).staged;
  if (existing?.packetHash === packet.packetHash) return freeze({ staged: false, duplicate: true, packet: existing });
  if (existing) throw new Error("Target workflow session has a conflicting staged handoff");
  appendWorkflowEventChecked(input.projectRoot, createWorkflowEvent({
    projectId: input.projectId, sessionId: input.targetSessionId, type: "handoff.recorded",
    payload: { formatVersion: HANDOFF_FORMAT_VERSION, operation: "stage", targetWorkflowId: input.targetWorkflowId, packet: packet as unknown as JsonValue },
    producer: "harness", timestamp: input.now?.() ?? new Date().toISOString(),
  }), (events) => {
    handoffInvariant(!hasOpenRun(events), "Target workflow session opened a run before handoff staging");
    const locked = restoreHandoffState(events).staged;
    handoffInvariant(!locked, locked?.packetHash === packet.packetHash ? "Handoff packet was staged concurrently" : "Target workflow session has a conflicting staged handoff");
  }, { fault: input.fault });
  return freeze({ staged: true, duplicate: false, packet });
}
export function clearStagedHandoff(input: { projectRoot: string; projectId: string; targetSessionId: string; expectedPacketHash?: string; now?: () => string } & JournalFaultOptions): Readonly<{ cleared: boolean; packetHash?: string }> {
  const initial = readWorkflowJournal(input.projectRoot, input.targetSessionId);
  if (hasOpenRun(initial)) throw new Error("Target workflow session must be idle before clearing a staged handoff");
  const staged = restoreHandoffState(initial).staged;
  if (!staged) return freeze({ cleared: false });
  if (input.expectedPacketHash !== undefined && staged.packetHash !== input.expectedPacketHash) throw new Error("Staged handoff changed before clear");
  appendWorkflowEventChecked(input.projectRoot, createWorkflowEvent({
    projectId: input.projectId, sessionId: input.targetSessionId, type: "handoff.recorded",
    payload: { formatVersion: HANDOFF_FORMAT_VERSION, operation: "clear", packetHash: staged.packetHash },
    producer: "harness", timestamp: input.now?.() ?? new Date().toISOString(),
  }), (events) => {
    handoffInvariant(!hasOpenRun(events), "Target workflow session opened a run before handoff clear");
    handoffInvariant(restoreHandoffState(events).staged?.packetHash === staged.packetHash, "Staged handoff changed before clear");
  }, { fault: input.fault });
  return freeze({ cleared: true, packetHash: staged.packetHash });
}
export function handoffPromptInput(packet: HandoffPacket): DynamicPromptInput {
  const verified = verifyHandoffPacket(packet);
  return freeze({
    source: "handoff",
    provenance: `handoff:${verified.packetHash}:${verified.source.workflowId}:${verified.source.runId}`,
    content: verified,
    ref: `workflow_status:handoff?packetHash=${verified.packetHash}`,
  });
}
