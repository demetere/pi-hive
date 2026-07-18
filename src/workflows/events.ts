import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";

export const WORKFLOW_EVENT_FORMAT_VERSION = 1 as const;
export const WORKFLOW_EVENT_LIMITS = Object.freeze({ payloadBytes: 262_144, eventBytes: 524_288, idBytes: 256, diagnosticsBytes: 4_096 });
export type WorkflowEventProducer = "runtime" | "dashboard" | "recovery" | "harness";
export type WorkflowEventType =
  | "session.created"
  | "session.linked"
  | "session.selected"
  | "session.orphaned"
  | "control.requested"
  | "run.started"
  | "run.input.recorded"
  | "run.input.delivery.prepared"
  | "run.input.delivered"
  | "run.transition"
  | "run.cancel.requested"
  | "run.cancel.settlement.failed"
  | "run.pause.release.confirmed"
  | "run.terminal.prepared"
  | "task.accepted"
  | "task.started"
  | "task.suspended"
  | "task.interrupted"
  | "task.result.recorded"
  | "task.result.delivery.prepared"
  | "task.result.delivery.accepted"
  | "scheduler.paused"
  | "scheduler.resumed"
  | "scheduler.closed"
  | "budget.model.attempted"
  | "budget.model.usage.recorded"
  | "budget.tool.attempted"
  | "budget.clock.started"
  | "budget.clock.stopped"
  | "budget.clock.paused"
  | "budget.clock.resumed"
  | "budget.warning.recorded"
  | "attempt.intent.recorded"
  | "attempt.result.recorded"
  | "attempt.reconciliation.recorded"
  | "change.baseline.recorded"
  | "change.mutation.started"
  | "change.mutation.recorded"
  | "change.mutation.not-applied"
  | "change.command.started"
  | "change.command.recorded"
  | "task.transition"
  | "question.transition"
  | "approval.recorded"
  | "artifact.recorded"
  | "handoff.recorded"
  | "knowledge.transition"
  | "terminal.recorded";
const EVENT_TYPES = new Set<WorkflowEventType>([
  "session.created", "session.linked", "session.selected", "session.orphaned", "control.requested",
  "run.started", "run.input.recorded", "run.input.delivery.prepared", "run.input.delivered",
  "run.transition", "run.cancel.requested", "run.cancel.settlement.failed", "run.pause.release.confirmed", "run.terminal.prepared",
  "task.accepted", "task.started", "task.suspended", "task.interrupted", "task.result.recorded",
  "task.result.delivery.prepared", "task.result.delivery.accepted",
  "scheduler.paused", "scheduler.resumed", "scheduler.closed",
  "budget.model.attempted", "budget.model.usage.recorded", "budget.tool.attempted",
  "budget.clock.started", "budget.clock.stopped", "budget.clock.paused", "budget.clock.resumed", "budget.warning.recorded",
  "attempt.intent.recorded", "attempt.result.recorded", "attempt.reconciliation.recorded",
  "change.baseline.recorded", "change.mutation.started", "change.mutation.recorded", "change.mutation.not-applied", "change.command.started", "change.command.recorded",
  "task.transition", "question.transition", "approval.recorded",
  "artifact.recorded", "handoff.recorded", "knowledge.transition", "terminal.recorded",
]);
const PRODUCERS = new Set<WorkflowEventProducer>(["runtime", "dashboard", "recovery", "harness"]);
export interface WorkflowEventDraft { readonly eventId: string; readonly projectId: string; readonly sessionId: string; readonly runId?: string; readonly type: WorkflowEventType; readonly payload: JsonValue; readonly timestamp: string; readonly producer: WorkflowEventProducer; readonly correlationId?: string; readonly attemptId?: string }
export interface WorkflowEventEnvelope extends WorkflowEventDraft { readonly formatVersion: 1; readonly sequence: number; readonly previousHash: string | null; readonly payloadHash: string; readonly eventHash: string }
export interface CreateWorkflowEventInput extends Omit<WorkflowEventDraft, "eventId" | "timestamp"> { readonly eventId?: string; readonly timestamp?: string }

function hash(domain: string, value: unknown): string { return createHash("sha256").update(`${domain}\0`).update(canonicalJson(value)).digest("hex"); }
function unsafeId(value: string): boolean { for (const character of value) if (character === "/" || character === "\\" || character.codePointAt(0)! <= 0x1f) return true; return false; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
function boundedId(value: string, label: string): string { if (!value || Buffer.byteLength(value, "utf8") > WORKFLOW_EVENT_LIMITS.idBytes || unsafeId(value)) throw new Error(`WORKFLOW_EVENT_${label}_INVALID`); return value; }
function validateDraft(input: WorkflowEventDraft): void {
  boundedId(input.eventId, "ID"); boundedId(input.projectId, "PROJECT"); boundedId(input.sessionId, "SESSION"); if (input.runId) boundedId(input.runId, "RUN"); if (input.correlationId) boundedId(input.correlationId, "CORRELATION"); if (input.attemptId) boundedId(input.attemptId, "ATTEMPT");
  if (!EVENT_TYPES.has(input.type) || !PRODUCERS.has(input.producer) || !Number.isFinite(Date.parse(input.timestamp))) throw new Error("WORKFLOW_EVENT_ENVELOPE_INVALID");
  const payload = canonicalJson(input.payload); if (Buffer.byteLength(payload, "utf8") > WORKFLOW_EVENT_LIMITS.payloadBytes) throw new Error("WORKFLOW_EVENT_PAYLOAD_LIMIT_EXCEEDED");
}
export function createWorkflowEvent(input: CreateWorkflowEventInput): WorkflowEventDraft {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const result = { eventId: boundedId(input.eventId ?? randomUUID(), "ID"), projectId: boundedId(input.projectId, "PROJECT"), sessionId: boundedId(input.sessionId, "SESSION"), ...(input.runId ? { runId: boundedId(input.runId, "RUN") } : {}), type: input.type, payload: deepFreeze(structuredClone(input.payload)), timestamp, producer: input.producer, ...(input.correlationId ? { correlationId: boundedId(input.correlationId, "CORRELATION") } : {}), ...(input.attemptId ? { attemptId: boundedId(input.attemptId, "ATTEMPT") } : {}) }; validateDraft(result); return Object.freeze(result);
}
export function sealWorkflowEvent(draft: WorkflowEventDraft, sequence: number, previousHash: string | null): WorkflowEventEnvelope {
  validateDraft(draft);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || (previousHash !== null && !/^[0-9a-f]{64}$/u.test(previousHash))) throw new Error("WORKFLOW_EVENT_CHAIN_INVALID");
  const payloadHash = hash("pi-hive-workflow-payload-v1", draft.payload);
  const identity = { formatVersion: WORKFLOW_EVENT_FORMAT_VERSION, sequence, previousHash, payloadHash, ...draft };
  const eventHash = hash("pi-hive-workflow-event-v1", identity);
  const result = Object.freeze({ ...identity, eventHash });
  if (Buffer.byteLength(canonicalJson(result), "utf8") > WORKFLOW_EVENT_LIMITS.eventBytes) throw new Error("WORKFLOW_EVENT_LIMIT_EXCEEDED");
  return result;
}
export function verifyWorkflowEvent(value: WorkflowEventEnvelope): void {
  if (value.formatVersion !== 1) throw new Error("Unknown workflow event version"); validateDraft(value);
  const payloadHash = hash("pi-hive-workflow-payload-v1", value.payload); if (payloadHash !== value.payloadHash) throw new Error("Workflow payload hash mismatch");
  const { eventHash, ...identity } = value; if (hash("pi-hive-workflow-event-v1", identity) !== eventHash) throw new Error("Workflow event hash mismatch");
}
