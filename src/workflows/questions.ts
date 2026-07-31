import { createHash, randomUUID } from "node:crypto";
import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import type { JsonValue } from "../config/types";
import { canonicalJson } from "../config/snapshot-canonical";
import { createWorkflowEvent, type WorkflowEventEnvelope, type WorkflowEventProducer } from "./events";
import { appendWorkflowEventChecked, readWorkflowJournal, type JournalFaultStage } from "./journal";
import { replayWorkflowJournal } from "./replay";
import { createEmptyRunLifecycleState, isOpenRunStatus, reduceRunLifecycle } from "./runs";
import { DelegationRuntime, createDelegationState, reduceDelegationState } from "./delegation";
import { createAttemptState, reduceAttemptState } from "./attempts";
import {
  QUESTION_LIMITS,
  normalizeQuestionDefinition,
  validateQuestionAnswer,
  type QuestionAnswerValue,
  type QuestionDefinition,
} from "./question-validation";
import { deepFreeze, exactKeys, plainRecord } from "./values";
import { assertLosslessDynamicPromptDeliveryFits, assertLosslessRootDynamicPromptDeliveryFits, losslessDynamicPromptInputs } from "./prompts";

const FORMAT_VERSION = 1 as const;
export type QuestionStateName = "pending" | "answered" | "closed";
export type QuestionAnswerChannel = "live" | "dashboard" | "command";

export interface QuestionCreationProvenance {
  readonly source: "human_question";
  readonly toolCallId: string;
  readonly agentId: string;
}
export interface PersistedQuestionAnswer {
  readonly value: QuestionAnswerValue;
  readonly channel: QuestionAnswerChannel;
  readonly identity: string;
  readonly operationId: string;
  readonly inputHash: string;
  readonly answeredAt: string;
}
export interface PersistedQuestionClosure {
  readonly reason: string;
  readonly operationId: string;
  readonly closedAt: string;
}
export interface QuestionDeliveryReceipt {
  readonly promptHash: string;
  readonly attemptId: string;
  readonly transcriptRef: string;
  readonly consumedSequence: number;
  readonly consumedAt: string;
}
export interface PersistedQuestion {
  readonly questionId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly taskId?: string;
  readonly taskAttemptId?: string;
  readonly definition: QuestionDefinition;
  readonly provenance: QuestionCreationProvenance;
  readonly createdAt: string;
  readonly creationSequence: number;
  readonly state: QuestionStateName;
  readonly answer?: PersistedQuestionAnswer;
  readonly closure?: PersistedQuestionClosure;
  readonly toolAnswerReturnedSequence?: number;
  readonly rootDeliveryId?: string;
  readonly rootDeliveryPreparedSequence?: number;
  readonly rootDeliveryReceipt?: QuestionDeliveryReceipt;
  readonly rootDeliveryAcceptedSequence?: number;
  readonly taskDeliveryId?: string;
  readonly taskDeliveryPreparedSequence?: number;
  readonly taskDeliveryReceipt?: QuestionDeliveryReceipt;
  readonly taskDeliveryAcceptedSequence?: number;
}
export interface QuestionState {
  readonly sessionId: string;
  readonly runId: string;
  readonly questions: Readonly<Record<string, PersistedQuestion>>;
}
export interface QuestionCreateRequest {
  readonly nodeId: string;
  readonly taskId?: string;
  readonly definition: unknown;
  readonly provenance: Readonly<{ source: "human_question"; toolCallId: string }>;
}
export interface QuestionControlAuthenticationRequest {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly questionId: string;
  readonly expectedState: "pending";
  readonly channel: QuestionAnswerChannel;
  readonly operationId: string;
  readonly claimedIdentity: string;
  readonly credential?: unknown;
}
export interface QuestionAnswerRequest extends QuestionControlAuthenticationRequest {
  readonly value: unknown;
}
export interface QuestionCloseRequest {
  readonly reason: string;
  readonly operationId: string;
  readonly expectedQuestionIds?: readonly string[];
}
export interface QuestionPresentationAnswer {
  readonly value: unknown;
  readonly claimedIdentity: string;
  readonly credential?: unknown;
  readonly operationId: string;
}
export type QuestionPresenter = (question: PersistedQuestion, signal: AbortSignal) => QuestionPresentationAnswer | undefined | Promise<QuestionPresentationAnswer | undefined>;
export interface QuestionServiceOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly snapshot: ActivationSnapshotFileV1;
  readonly createQuestionId?: () => string;
  readonly now?: () => string;
  readonly authenticateControl: (request: QuestionControlAuthenticationRequest) => string | undefined;
  readonly journalFault?: (eventType: "question.transition", stage: JournalFaultStage) => void;
}
export interface QuestionStatusRequest { readonly state?: QuestionStateName; readonly limit?: number; readonly cursor?: string }
export interface QuestionStatusItem {
  readonly questionId: string; readonly projectId: string; readonly sessionId: string; readonly runId: string; readonly nodeId: string; readonly taskId?: string;
  readonly kind: QuestionDefinition["kind"]; readonly required: boolean; readonly state: QuestionStateName;
  readonly promptPreview: string; readonly promptBytes: number; readonly promptTruncated: boolean; readonly choiceCount: number;
  readonly createdAt: string; readonly answerChannel?: QuestionAnswerChannel; readonly answeredAt?: string; readonly closedAt?: string;
  readonly readRef: string;
}
export interface QuestionStatusPage { readonly total: number; readonly items: readonly QuestionStatusItem[]; readonly nextCursor?: string }
export interface QuestionDetailRequest {
  readonly projectId: string; readonly sessionId: string; readonly runId: string; readonly questionId: string;
  readonly cursor?: string; readonly choiceLimit?: number;
}
export interface QuestionDetailPage {
  readonly questionId: string; readonly projectId: string; readonly sessionId: string; readonly runId: string; readonly nodeId: string; readonly taskId?: string;
  readonly state: QuestionStateName; readonly kind: QuestionDefinition["kind"]; readonly required: boolean; readonly validation?: QuestionDefinition["validation"];
  readonly promptChunk: string; readonly promptOffset: number; readonly promptBytes: number; readonly promptComplete: boolean;
  readonly choices: readonly Readonly<{ value: string; label: string }>[]; readonly choiceOffset: number; readonly choiceCount: number;
  readonly createdAt: string; readonly nextCursor?: string;
}
export interface AcceptedQuestionForTask {
  readonly questionId: string; readonly runId: string; readonly nodeId: string; readonly taskId: string; readonly taskAttemptId: string;
  readonly definition: QuestionDefinition; readonly answer: PersistedQuestionAnswer; readonly transcriptRef: string;
}
export interface AcceptedQuestionForRoot {
  readonly questionId: string; readonly runId: string; readonly nodeId: string;
  readonly definition: QuestionDefinition; readonly answer: PersistedQuestionAnswer; readonly transcriptRef: string;
}
export interface RootQuestionAnswerDelivery {
  readonly deliveryId: string; readonly nodeId: string; readonly questionIds: readonly string[];
  readonly answers: readonly AcceptedQuestionForRoot[];
}
export interface TaskQuestionAnswerDelivery {
  readonly deliveryId: string; readonly nodeId: string; readonly taskId: string; readonly questionIds: readonly string[];
  readonly answers: readonly AcceptedQuestionForTask[];
}
export interface QuestionDeliveryReceiptInput {
  readonly promptHash: string;
  readonly attemptId: string;
  readonly transcriptRef: string;
}

function boundedString(value: unknown, label: string, bytes: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > bytes || value.includes("\0") || value.includes("/") || value.includes("\\")) throw new Error(`${label} is invalid or exceeds its byte limit`);
  return value;
}
function boundedText(value: unknown, label: string, bytes: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > bytes
    || [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    })) throw new Error(`${label} is invalid or exceeds its byte limit`);
  return value;
}
function recordPayload(event: WorkflowEventEnvelope): Record<string, unknown> {
  if (!plainRecord(event.payload) || event.payload.formatVersion !== FORMAT_VERSION) throw new Error("Question event payload is invalid");
  return event.payload;
}
function questionAnswerProducer(channel: QuestionAnswerChannel): WorkflowEventProducer {
  return channel === "dashboard" ? "dashboard" : channel === "command" ? "runtime" : "harness";
}
function answerChannel(value: unknown): QuestionAnswerChannel {
  if (value !== "live" && value !== "dashboard" && value !== "command") throw new Error("Question answer channel is invalid");
  return value;
}
function questionAnswerTranscriptRef(question: Pick<PersistedQuestion, "runId" | "nodeId" | "taskId" | "questionId">): string {
  return question.taskId
    ? `run:${question.runId}/node:${question.nodeId}/task:${question.taskId}/question:${question.questionId}`
    : `run:${question.runId}/node:${question.nodeId}/question:${question.questionId}`;
}

function questionAnswerPromptInputs(question: Pick<PersistedQuestion, "questionId" | "runId" | "nodeId" | "taskId" | "definition">, answer: PersistedQuestionAnswer) {
  return losslessDynamicPromptInputs({
    provenance: `human-answer:${question.questionId}:${answer.channel}:${answer.identity}`,
    content: { questionId: question.questionId, definition: question.definition, answer },
    ref: questionAnswerTranscriptRef(question),
  });
}

function assertQuestionAnswerDeliverable(question: Pick<PersistedQuestion, "questionId" | "runId" | "nodeId" | "taskId" | "definition">, answer: PersistedQuestionAnswer): void {
  const inputs = questionAnswerPromptInputs(question, answer);
  if (question.taskId === undefined) assertLosslessRootDynamicPromptDeliveryFits(inputs);
  else assertLosslessDynamicPromptDeliveryFits(inputs);
}

function assertQuestionAnswerDeliverableForSnapshot(snapshot: ActivationSnapshotFileV1, question: Pick<PersistedQuestion, "questionId" | "runId" | "nodeId" | "taskId" | "definition">, answer: PersistedQuestionAnswer): void {
  const inputs = questionAnswerPromptInputs(question, answer);
  const context = { snapshot, nodeId: question.nodeId };
  if (question.taskId === undefined) assertLosslessRootDynamicPromptDeliveryFits(inputs, context);
  else assertLosslessDynamicPromptDeliveryFits(inputs, context);
}

function parseAnswer(payload: Record<string, unknown>, question: PersistedQuestion, event: WorkflowEventEnvelope): PersistedQuestionAnswer {
  const channel = answerChannel(payload.channel);
  if (event.producer !== questionAnswerProducer(channel)) throw new Error("Question answer channel lacks matching producer authority");
  const identity = boundedText(payload.identity, "Question answer identity", QUESTION_LIMITS.identityBytes);
  const operationId = boundedString(payload.operationId, "Question answer operation ID", QUESTION_LIMITS.operationIdBytes);
  const inputHash = payload.inputHash;
  if (typeof inputHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(inputHash)) throw new Error("Question answer input hash is invalid");
  const value = validateQuestionAnswer(question.definition, payload.value);
  const answer = deepFreeze({ value, channel, identity, operationId, inputHash, answeredAt: event.timestamp });
  assertQuestionAnswerDeliverable(question, answer);
  return answer;
}

function answerInputHash(input: Readonly<{ projectId: string; sessionId: string; runId: string; questionId: string; expectedState: "pending"; channel: QuestionAnswerChannel; identity: string; value: QuestionAnswerValue }>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
}

function parseDeliveryReceipt(payload: Record<string, unknown>, event: WorkflowEventEnvelope): QuestionDeliveryReceipt {
  const promptHash = payload.promptHash;
  if (typeof promptHash !== "string" || !/^[0-9a-f]{64}$/u.test(promptHash)) throw new Error("Question delivery receipt prompt hash is invalid");
  return deepFreeze({
    promptHash,
    attemptId: boundedString(payload.attemptId, "Question delivery receipt attempt ID", QUESTION_LIMITS.idBytes),
    transcriptRef: boundedText(payload.transcriptRef, "Question delivery receipt transcript reference", 2_048),
    consumedSequence: event.sequence,
    consumedAt: event.timestamp,
  });
}

export function createEmptyQuestionState(sessionId: string, runId: string): QuestionState {
  boundedString(sessionId, "Question session ID", QUESTION_LIMITS.idBytes);
  boundedString(runId, "Question run ID", QUESTION_LIMITS.idBytes);
  return deepFreeze({ sessionId, runId, questions: {} });
}

export function reduceQuestionState(state: QuestionState, event: WorkflowEventEnvelope): QuestionState {
  if (event.sessionId !== state.sessionId) throw new Error("Question event session identity mismatch");
  if (event.runId !== undefined && event.runId !== state.runId) return state;
  if (event.type !== "question.transition") return state;
  if (event.runId !== state.runId) throw new Error("Question event run identity mismatch");
  const payload = recordPayload(event);
  exactKeys(payload, ["formatVersion", "operation"], ["questionId", "nodeId", "taskId", "taskAttemptId", "definition", "provenance", "channel", "identity", "operationId", "inputHash", "deliveryId", "value", "questionIds", "reason", "promptHash", "attemptId", "transcriptRef"], "Question event");
  const operation = payload.operation;
  const questions = { ...state.questions };
  if (operation === "create") {
    if (event.producer !== "runtime") throw new Error("Question creation lacks runtime authority");
    exactKeys(payload, ["formatVersion", "operation", "questionId", "nodeId", "definition", "provenance"], ["taskId", "taskAttemptId"], "Question create event");
    const questionId = boundedString(payload.questionId, "Question ID", QUESTION_LIMITS.idBytes);
    if (questions[questionId]) throw new Error("Question ID is duplicated");
    if (Object.keys(questions).length >= QUESTION_LIMITS.questions) throw new Error("Questions exceed their per-run limit");
    const nodeId = boundedString(payload.nodeId, "Question node ID", QUESTION_LIMITS.idBytes);
    const taskId = payload.taskId === undefined ? undefined : boundedString(payload.taskId, "Question task ID", QUESTION_LIMITS.idBytes);
    const taskAttemptId = payload.taskAttemptId === undefined ? undefined : boundedString(payload.taskAttemptId, "Question task attempt ID", QUESTION_LIMITS.idBytes);
    if (Boolean(taskId) !== Boolean(taskAttemptId)) throw new Error("Task-bound question requires its exact task attempt identity");
    if (!plainRecord(payload.provenance)) throw new Error("Question provenance is invalid");
    exactKeys(payload.provenance, ["source", "toolCallId", "agentId"], [], "Question provenance");
    if (payload.provenance.source !== "human_question") throw new Error("Question provenance source is invalid");
    const provenance: QuestionCreationProvenance = deepFreeze({
      source: "human_question",
      toolCallId: boundedString(payload.provenance.toolCallId, "Question tool call ID", QUESTION_LIMITS.idBytes),
      agentId: boundedString(payload.provenance.agentId, "Question agent ID", QUESTION_LIMITS.idBytes),
    });
    questions[questionId] = deepFreeze({
      questionId, projectId: event.projectId, sessionId: event.sessionId, runId: event.runId,
      nodeId, ...(taskId ? { taskId, taskAttemptId } : {}), definition: normalizeQuestionDefinition(payload.definition), provenance,
      createdAt: event.timestamp, creationSequence: event.sequence, state: "pending" as const,
    });
  } else if (operation === "answer") {
    exactKeys(payload, ["formatVersion", "operation", "questionId", "channel", "identity", "operationId", "inputHash", "value"], [], "Question answer event");
    const questionId = boundedString(payload.questionId, "Question ID", QUESTION_LIMITS.idBytes);
    const question = questions[questionId];
    if (!question || question.state !== "pending") throw new Error("Question answer CAS requires exact pending state; question is answered, closed, or unknown");
    questions[questionId] = deepFreeze({ ...question, state: "answered" as const, answer: parseAnswer(payload, question, event) });
  } else if (operation === "tool-answer-returned") {
    if (event.producer !== "runtime") throw new Error("Question tool answer return lacks runtime authority");
    exactKeys(payload, ["formatVersion", "operation", "questionId", "nodeId"], ["taskId"], "Question tool answer return event");
    const questionId = boundedString(payload.questionId, "Question ID", QUESTION_LIMITS.idBytes);
    const nodeId = boundedString(payload.nodeId, "Question node ID", QUESTION_LIMITS.idBytes);
    const taskId = payload.taskId === undefined ? undefined : boundedString(payload.taskId, "Question task ID", QUESTION_LIMITS.idBytes);
    const question = questions[questionId];
    if (!question || question.nodeId !== nodeId || question.taskId !== taskId || question.state !== "answered" || !question.answer || question.toolAnswerReturnedSequence !== undefined) throw new Error("Question tool answer return requires its exact answered question");
    questions[questionId] = deepFreeze({ ...question, toolAnswerReturnedSequence: event.sequence });
  } else if (operation === "root-delivery-prepared") {
    if (event.producer !== "runtime") throw new Error("Root question delivery preparation lacks runtime authority");
    exactKeys(payload, ["formatVersion", "operation", "deliveryId", "nodeId", "questionIds"], [], "Root question delivery prepare event");
    const deliveryId = boundedString(payload.deliveryId, "Root question delivery ID", QUESTION_LIMITS.operationIdBytes);
    const nodeId = boundedString(payload.nodeId, "Root question delivery node ID", QUESTION_LIMITS.idBytes);
    if (!Array.isArray(payload.questionIds) || !payload.questionIds.length || new Set(payload.questionIds).size !== payload.questionIds.length) throw new Error("Root question delivery IDs are invalid");
    for (const rawId of payload.questionIds) {
      const questionId = boundedString(rawId, "Root question delivery question ID", QUESTION_LIMITS.idBytes);
      const question = questions[questionId];
      if (!question || question.taskId !== undefined || question.nodeId !== nodeId || question.state !== "answered" || !question.answer || question.rootDeliveryAcceptedSequence !== undefined
        || (question.rootDeliveryId !== undefined && question.rootDeliveryId !== deliveryId)) throw new Error("Root question delivery preparation requires exact undelivered answered questions");
      questions[questionId] = deepFreeze({ ...question, rootDeliveryId: deliveryId, rootDeliveryPreparedSequence: event.sequence });
    }
  } else if (operation === "root-delivery-consumed") {
    if (event.producer !== "runtime") throw new Error("Root question delivery receipt lacks runtime authority");
    exactKeys(payload, ["formatVersion", "operation", "deliveryId", "nodeId", "questionIds", "promptHash", "attemptId", "transcriptRef"], [], "Root question delivery receipt event");
    const deliveryId = boundedString(payload.deliveryId, "Root question delivery ID", QUESTION_LIMITS.operationIdBytes);
    const nodeId = boundedString(payload.nodeId, "Root question delivery node ID", QUESTION_LIMITS.idBytes);
    const receipt = parseDeliveryReceipt(payload, event);
    if (!Array.isArray(payload.questionIds) || !payload.questionIds.length || new Set(payload.questionIds).size !== payload.questionIds.length) throw new Error("Root question delivery receipt IDs are invalid");
    for (const rawId of payload.questionIds) {
      const questionId = boundedString(rawId, "Root question delivery question ID", QUESTION_LIMITS.idBytes);
      const question = questions[questionId];
      if (!question || question.nodeId !== nodeId || question.taskId !== undefined || question.rootDeliveryId !== deliveryId || question.rootDeliveryPreparedSequence === undefined
        || question.rootDeliveryReceipt !== undefined || question.rootDeliveryAcceptedSequence !== undefined) throw new Error("Root question delivery receipt requires its exact prepared batch");
      questions[questionId] = deepFreeze({ ...question, rootDeliveryReceipt: receipt });
    }
  } else if (operation === "root-delivery-accepted") {
    if (event.producer !== "runtime") throw new Error("Root question delivery acceptance lacks runtime authority");
    exactKeys(payload, ["formatVersion", "operation", "deliveryId", "nodeId", "questionIds"], [], "Root question delivery accept event");
    const deliveryId = boundedString(payload.deliveryId, "Root question delivery ID", QUESTION_LIMITS.operationIdBytes);
    const nodeId = boundedString(payload.nodeId, "Root question delivery node ID", QUESTION_LIMITS.idBytes);
    if (!Array.isArray(payload.questionIds) || !payload.questionIds.length || new Set(payload.questionIds).size !== payload.questionIds.length) throw new Error("Root question delivery IDs are invalid");
    for (const rawId of payload.questionIds) {
      const questionId = boundedString(rawId, "Root question delivery question ID", QUESTION_LIMITS.idBytes);
      const question = questions[questionId];
      if (!question || question.nodeId !== nodeId || question.rootDeliveryId !== deliveryId || question.rootDeliveryPreparedSequence === undefined || question.rootDeliveryReceipt === undefined || question.rootDeliveryAcceptedSequence !== undefined) throw new Error("Root question delivery acceptance requires its exact consumed batch");
      questions[questionId] = deepFreeze({ ...question, rootDeliveryAcceptedSequence: event.sequence });
    }
  } else if (operation === "task-delivery-prepared") {
    if (event.producer !== "runtime") throw new Error("Task question delivery preparation lacks runtime authority");
    exactKeys(payload, ["formatVersion", "operation", "deliveryId", "nodeId", "taskId", "questionIds"], [], "Task question delivery prepare event");
    const deliveryId = boundedString(payload.deliveryId, "Task question delivery ID", QUESTION_LIMITS.operationIdBytes);
    const nodeId = boundedString(payload.nodeId, "Task question delivery node ID", QUESTION_LIMITS.idBytes);
    const taskId = boundedString(payload.taskId, "Task question delivery task ID", QUESTION_LIMITS.idBytes);
    if (!Array.isArray(payload.questionIds) || !payload.questionIds.length || new Set(payload.questionIds).size !== payload.questionIds.length) throw new Error("Task question delivery IDs are invalid");
    for (const rawId of payload.questionIds) {
      const questionId = boundedString(rawId, "Task question delivery question ID", QUESTION_LIMITS.idBytes);
      const question = questions[questionId];
      if (!question || question.taskId !== taskId || question.nodeId !== nodeId || question.state !== "answered" || !question.answer || question.taskDeliveryAcceptedSequence !== undefined
        || (question.taskDeliveryId !== undefined && question.taskDeliveryId !== deliveryId)) throw new Error("Task question delivery preparation requires exact undelivered answered questions");
      questions[questionId] = deepFreeze({ ...question, taskDeliveryId: deliveryId, taskDeliveryPreparedSequence: event.sequence });
    }
  } else if (operation === "task-delivery-consumed") {
    if (event.producer !== "runtime") throw new Error("Task question delivery receipt lacks runtime authority");
    exactKeys(payload, ["formatVersion", "operation", "deliveryId", "nodeId", "taskId", "questionIds", "promptHash", "attemptId", "transcriptRef"], [], "Task question delivery receipt event");
    const deliveryId = boundedString(payload.deliveryId, "Task question delivery ID", QUESTION_LIMITS.operationIdBytes);
    const nodeId = boundedString(payload.nodeId, "Task question delivery node ID", QUESTION_LIMITS.idBytes);
    const taskId = boundedString(payload.taskId, "Task question delivery task ID", QUESTION_LIMITS.idBytes);
    const receipt = parseDeliveryReceipt(payload, event);
    if (!Array.isArray(payload.questionIds) || !payload.questionIds.length || new Set(payload.questionIds).size !== payload.questionIds.length) throw new Error("Task question delivery receipt IDs are invalid");
    for (const rawId of payload.questionIds) {
      const questionId = boundedString(rawId, "Task question delivery question ID", QUESTION_LIMITS.idBytes);
      const question = questions[questionId];
      if (!question || question.nodeId !== nodeId || question.taskId !== taskId || question.taskDeliveryId !== deliveryId || question.taskDeliveryPreparedSequence === undefined
        || question.taskDeliveryReceipt !== undefined || question.taskDeliveryAcceptedSequence !== undefined) throw new Error("Task question delivery receipt requires its exact prepared batch");
      questions[questionId] = deepFreeze({ ...question, taskDeliveryReceipt: receipt });
    }
  } else if (operation === "task-delivery-accepted") {
    if (event.producer !== "runtime") throw new Error("Task question delivery acceptance lacks runtime authority");
    exactKeys(payload, ["formatVersion", "operation", "deliveryId", "nodeId", "taskId", "questionIds"], [], "Task question delivery accept event");
    const deliveryId = boundedString(payload.deliveryId, "Task question delivery ID", QUESTION_LIMITS.operationIdBytes);
    const nodeId = boundedString(payload.nodeId, "Task question delivery node ID", QUESTION_LIMITS.idBytes);
    const taskId = boundedString(payload.taskId, "Task question delivery task ID", QUESTION_LIMITS.idBytes);
    if (!Array.isArray(payload.questionIds) || !payload.questionIds.length || new Set(payload.questionIds).size !== payload.questionIds.length) throw new Error("Task question delivery IDs are invalid");
    for (const rawId of payload.questionIds) {
      const questionId = boundedString(rawId, "Task question delivery question ID", QUESTION_LIMITS.idBytes);
      const question = questions[questionId];
      if (!question || question.nodeId !== nodeId || question.taskId !== taskId || question.taskDeliveryId !== deliveryId || question.taskDeliveryPreparedSequence === undefined || question.taskDeliveryReceipt === undefined || question.taskDeliveryAcceptedSequence !== undefined) throw new Error("Task question delivery acceptance requires its exact consumed batch");
      questions[questionId] = deepFreeze({ ...question, taskDeliveryAcceptedSequence: event.sequence });
    }
  } else if (operation === "close-pending") {
    if (event.producer !== "harness") throw new Error("Question terminal closure lacks harness authority");
    exactKeys(payload, ["formatVersion", "operation", "questionIds", "reason", "operationId"], [], "Question close event");
    if (!Array.isArray(payload.questionIds) || payload.questionIds.length > QUESTION_LIMITS.questions || new Set(payload.questionIds).size !== payload.questionIds.length) throw new Error("Question terminal closure IDs are invalid");
    const reason = boundedText(payload.reason, "Question closure reason", QUESTION_LIMITS.reasonBytes);
    const operationId = boundedString(payload.operationId, "Question closure operation ID", QUESTION_LIMITS.operationIdBytes);
    for (const rawId of payload.questionIds) {
      const questionId = boundedString(rawId, "Question closure ID", QUESTION_LIMITS.idBytes);
      const question = questions[questionId];
      if (!question || question.state !== "pending") throw new Error("Question terminal closure CAS requires every exact question to remain pending");
      questions[questionId] = deepFreeze({ ...question, state: "closed" as const, closure: deepFreeze({ reason, operationId, closedAt: event.timestamp }) });
    }
  } else throw new Error("Question transition operation is unsupported");
  return deepFreeze({ ...state, questions });
}

export function deriveQuestionRunStatus(input: Readonly<{ pendingQuestions: number; activeExecutions: number; runnableTasks: number; pendingRootInputs: number; rootQuestionSuspended: boolean }>): "running" | "waiting_for_human" {
  for (const [key, value] of Object.entries(input)) {
    if (key === "rootQuestionSuspended") {
      if (typeof value !== "boolean") throw new Error(`Question waiting derivation ${key} is invalid`);
    } else if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Question waiting derivation ${key} is invalid`);
  }
  const runnableRootInputs = input.rootQuestionSuspended ? 0 : input.pendingRootInputs;
  return input.pendingQuestions > 0 && input.activeExecutions === 0 && input.runnableTasks === 0 && runnableRootInputs === 0 ? "waiting_for_human" : "running";
}

function utf8Prefix(value: string, bytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= bytes) return value;
  let output = "", used = 0;
  for (const character of value) { const size = Buffer.byteLength(character, "utf8"); if (used + size > bytes) break; output += character; used += size; }
  return output;
}
function detailOffset(cursor: string | undefined, question: PersistedQuestion): { prompt: number; choice: number } {
  if (cursor === undefined) return { prompt: 0, choice: 0 };
  if (Buffer.byteLength(cursor, "utf8") > QUESTION_LIMITS.cursorBytes) throw new Error("Question detail cursor is invalid");
  const match = /^([1-9][0-9]*):(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/u.exec(cursor);
  if (!match || Number(match[1]) !== question.creationSequence) throw new Error("Question detail cursor is invalid or stale");
  const prompt = Number(match[2]), choice = Number(match[3]);
  if (!Number.isSafeInteger(prompt) || !Number.isSafeInteger(choice) || prompt > question.definition.prompt.length || choice > (question.definition.choices?.length ?? 0)) throw new Error("Question detail cursor is invalid or stale");
  return { prompt, choice };
}
function statusCursor(cursor: string | undefined, state: QuestionStateName | undefined, questions: readonly PersistedQuestion[]): number {
  if (cursor === undefined) return 0;
  if (Buffer.byteLength(cursor, "utf8") > QUESTION_LIMITS.cursorBytes) throw new Error("Question status cursor is invalid");
  const match = /^(all|pending|answered|closed):([1-9][0-9]*)$/u.exec(cursor);
  const expectedFilter = state ?? "all";
  const sequence = Number(match?.[2]);
  if (!match || match[1] !== expectedFilter || !Number.isSafeInteger(sequence) || !questions.some((question) => question.creationSequence === sequence)) {
    throw new Error("Question status cursor is invalid, stale, or bound to a different filter");
  }
  return sequence;
}

interface LivePresentation {
  readonly controller: AbortController;
  readonly settlement: Promise<QuestionPresentationAnswer | undefined>;
}

export class QuestionService {
  readonly options: QuestionServiceOptions;
  private readonly presentations = new Map<string, LivePresentation>();
  private closed = false;

  constructor(options: QuestionServiceOptions) {
    boundedString(options.projectId, "Question project ID", QUESTION_LIMITS.idBytes);
    boundedString(options.sessionId, "Question session ID", QUESTION_LIMITS.idBytes);
    boundedString(options.runId, "Question run ID", QUESTION_LIMITS.idBytes);
    if (typeof options.authenticateControl !== "function") throw new Error("Question control authentication is required");
    this.options = options;
  }

  restore(events = readWorkflowJournal(this.options.projectRoot, this.options.sessionId)): QuestionState {
    return replayWorkflowJournal(events, createEmptyQuestionState(this.options.sessionId, this.options.runId), reduceQuestionState).state;
  }

  private authority(nodeId: string): { nodeId: string; agentId: string } {
    const authority = this.options.snapshot.payload.authority.nodes.find((entry) => entry.nodeId === nodeId);
    const effective = plainRecord(authority?.capabilities) && plainRecord(authority.capabilities.effective) ? authority.capabilities.effective : undefined;
    if (!authority || !Array.isArray(authority.tools) || !authority.tools.includes("human_question") || effective?.["human-input"] !== true) {
      throw new Error(`Node ${nodeId} lacks effective human-input capability or human_question is not enabled`);
    }
    const team = this.options.snapshot.payload.workflow.team as { nodes?: unknown } | undefined;
    const node = Array.isArray(team?.nodes) ? team.nodes.find((entry) => plainRecord(entry) && entry.id === nodeId) : undefined;
    if (!plainRecord(node) || typeof node.agentId !== "string") throw new Error("Question node is absent from immutable topology");
    return { nodeId, agentId: node.agentId };
  }

  create(input: QuestionCreateRequest): PersistedQuestion {
    if (this.closed) throw new Error("Question service is shut down");
    if (!plainRecord(input)) throw new Error("Question creation request is invalid");
    exactKeys(input, ["nodeId", "definition", "provenance"], ["taskId"], "Question creation request");
    const nodeId = boundedString(input.nodeId, "Question node ID", QUESTION_LIMITS.idBytes);
    const taskId = input.taskId === undefined ? undefined : boundedString(input.taskId, "Question task ID", QUESTION_LIMITS.idBytes);
    const authority = this.authority(nodeId);
    if (!plainRecord(input.provenance)) throw new Error("Question creation provenance is invalid");
    exactKeys(input.provenance, ["source", "toolCallId"], [], "Question creation provenance");
    if (input.provenance.source !== "human_question") throw new Error("Question creation provenance source is invalid");
    const definition = normalizeQuestionDefinition(input.definition);
    let taskAttemptId: string | undefined;
    if (taskId) {
      const existingEvents = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
      const currentRun = replayWorkflowJournal(existingEvents, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
      if (currentRun && currentRun.runId !== this.options.runId) throw new Error("Question creation service is stale and does not target the current run identity");
      const delegation = replayWorkflowJournal(existingEvents, createDelegationState(this.options.sessionId, this.options.runId, this.options.snapshot), reduceDelegationState).state;
      const task = delegation.tasks[taskId];
      const questionSuspended = task?.queueState === "suspended" && Boolean(task.suspendedOnQuestionIds?.length) && !task.suspendedOn?.length;
      if (!task || task.runId !== this.options.runId || task.targetNodeId !== nodeId || (task.queueState !== "active" && !questionSuspended) || task.result) {
        throw new Error("Question creation requires the exact journal-active task and node");
      }
      taskAttemptId = boundedString(task.attempts.at(-1)?.attemptId, "Question task attempt ID", QUESTION_LIMITS.idBytes);
    }
    const questionId = boundedString(this.options.createQuestionId?.() ?? `question-${randomUUID()}`, "Question ID", QUESTION_LIMITS.idBytes);
    const timestamp = this.options.now?.() ?? new Date().toISOString();
    const draft = createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId,
      type: "question.transition", producer: "runtime", timestamp,
      payload: {
        formatVersion: FORMAT_VERSION, operation: "create", questionId, nodeId, ...(taskId ? { taskId, taskAttemptId } : {}),
        definition: structuredClone(definition) as unknown as JsonValue,
        provenance: { source: "human_question", toolCallId: boundedString(input.provenance.toolCallId, "Question tool call ID", QUESTION_LIMITS.idBytes), agentId: authority.agentId },
      },
    });
    try {
      appendWorkflowEventChecked(this.options.projectRoot, draft, (events) => {
        const state = this.restore(events);
        if (state.questions[questionId]) throw new Error("Question ID is duplicated");
        if (Object.keys(state.questions).length >= QUESTION_LIMITS.questions) throw new Error("Questions exceed their per-run limit");
        const run = replayWorkflowJournal(events, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
        if (run && run.runId !== this.options.runId) throw new Error("Question creation service is stale and does not target the current run");
        if (run && (!isOpenRunStatus(run.status) || run.cancellationRequested || run.pendingTerminal)) throw new Error("Question creation is denied for a terminal, cancelling, or finalizing run");
        if (taskId) {
          const delegation = replayWorkflowJournal(events, createDelegationState(this.options.sessionId, this.options.runId, this.options.snapshot), reduceDelegationState).state;
          const task = delegation.tasks[taskId];
          const questionSuspended = task?.queueState === "suspended" && Boolean(task.suspendedOnQuestionIds?.length) && !task.suspendedOn?.length;
          if (!delegation.admissionOpen || delegation.schedulerStatus !== "running") throw new Error("Question creation is denied while scheduler admission is paused or closed");
          if (!task || task.runId !== this.options.runId || task.targetNodeId !== nodeId || (task.queueState !== "active" && !questionSuspended)
            || task.attempts.at(-1)?.attemptId !== taskAttemptId || task.result) throw new Error("Question creation requires the exact journal-active task attempt and node");
        }
      }, { fault: (stage) => this.options.journalFault?.("question.transition", stage) });
    } catch (error) {
      const published = readWorkflowJournal(this.options.projectRoot, this.options.sessionId).some((event) => event.eventId === draft.eventId);
      if (!published) throw error;
    }
    return this.restore().questions[questionId];
  }

  async createAndPresent(input: QuestionCreateRequest, presenter: QuestionPresenter, signal?: AbortSignal): Promise<PersistedQuestion> {
    if (typeof presenter !== "function") throw new Error("Question presenter is required");
    const pending = this.create(input);
    const controller = new AbortController();
    let settleAbort!: () => void;
    const aborted = new Promise<undefined>((resolve) => {
      settleAbort = () => resolve(undefined);
      controller.signal.addEventListener("abort", settleAbort, { once: true });
    });
    const abortFromCaller = (): void => controller.abort(signal?.reason ?? "Question caller aborted");
    if (signal?.aborted) abortFromCaller(); else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const presentation = Promise.resolve().then(() => presenter(pending, controller.signal));
    void presentation.catch(() => undefined);
    let durablePoll: ReturnType<typeof setTimeout> | undefined;
    const durableSettlement = new Promise<undefined>((resolve, reject) => {
      const observe = (): void => {
        if (controller.signal.aborted) { resolve(undefined); return; }
        try {
          const current = this.restore().questions[pending.questionId];
          if (current?.state !== "pending") {
            controller.abort("Question settled by the durable winner");
            resolve(undefined);
            return;
          }
          durablePoll = setTimeout(observe, 10);
        } catch (error) {
          controller.abort("Durable question settlement observation failed");
          reject(error);
        }
      };
      durablePoll = setTimeout(observe, 10);
    });
    const settlement = Promise.race([presentation, aborted, durableSettlement]);
    this.presentations.set(pending.questionId, { controller, settlement });
    try {
      const proposed = await settlement;
      let answered: PersistedQuestion;
      if (proposed === undefined || controller.signal.aborted) answered = this.restore().questions[pending.questionId];
      else {
        try {
          answered = this.answer({
            projectId: pending.projectId, sessionId: pending.sessionId, runId: pending.runId, questionId: pending.questionId, expectedState: "pending",
            value: proposed.value, channel: "live", claimedIdentity: proposed.claimedIdentity, credential: proposed.credential, operationId: proposed.operationId,
          });
        } catch (error) {
          const winner = this.restore().questions[pending.questionId];
          if (winner?.state !== "answered" || !winner.answer) throw error;
          answered = winner;
        }
      }
      if (answered.state === "answered" && answered.answer) {
        if (answered.taskId === undefined) this.prepareRootAnswerDeliveries(answered.nodeId, [answered.questionId]);
        else this.prepareTaskAnswerDeliveries(answered.taskId, [answered.questionId]);
        this.markToolAnswerReturned(answered);
        answered = this.restore().questions[answered.questionId];
      }
      return answered;
    } finally {
      if (durablePoll) clearTimeout(durablePoll);
      signal?.removeEventListener("abort", abortFromCaller);
      controller.signal.removeEventListener("abort", settleAbort);
      this.presentations.delete(pending.questionId);
    }
  }

  answer(input: QuestionAnswerRequest): PersistedQuestion {
    if (this.closed) throw new Error("Question service is shut down");
    if (!plainRecord(input)) throw new Error("Question answer request is invalid");
    exactKeys(input, ["projectId", "sessionId", "runId", "questionId", "expectedState", "value", "channel", "claimedIdentity", "operationId"], ["credential"], "Question answer request");
    const projectId = boundedString(input.projectId, "Question project ID", QUESTION_LIMITS.idBytes);
    const sessionId = boundedString(input.sessionId, "Question session ID", QUESTION_LIMITS.idBytes);
    const runId = boundedString(input.runId, "Question run ID", QUESTION_LIMITS.idBytes);
    const questionId = boundedString(input.questionId, "Question ID", QUESTION_LIMITS.idBytes);
    if (input.expectedState !== "pending") throw new Error("Question answer expected state must be pending");
    const channel = answerChannel(input.channel);
    const operationId = boundedString(input.operationId, "Question answer operation ID", QUESTION_LIMITS.operationIdBytes);
    const claimedIdentity = boundedText(input.claimedIdentity, "Question claimed identity", QUESTION_LIMITS.identityBytes);
    const authenticationRequest: QuestionControlAuthenticationRequest = {
      projectId, sessionId, runId, questionId, expectedState: "pending", channel, operationId, claimedIdentity, credential: input.credential,
    };
    const identity = this.options.authenticateControl(authenticationRequest);
    if (!identity) throw new Error("Question answer is not authenticated or authorized");
    const authenticatedIdentity = boundedText(identity, "Question authenticated identity", QUESTION_LIMITS.identityBytes);
    if (projectId !== this.options.projectId || sessionId !== this.options.sessionId || runId !== this.options.runId) throw new Error("Question answer exact project/session/run identity does not match this control service");
    const state = this.restore();
    const current = state.questions[questionId];
    if (!current || current.projectId !== projectId || current.sessionId !== sessionId || current.runId !== runId) throw new Error("Question answer exact durable identity is unknown or mismatched");
    const value = validateQuestionAnswer(current.definition, input.value);
    const inputHash = answerInputHash({ projectId, sessionId, runId, questionId, expectedState: "pending", channel, identity: authenticatedIdentity, value });
    const existingOperation = Object.values(state.questions).find((question) => question.answer?.operationId === operationId)?.answer;
    if (existingOperation) {
      if (existingOperation.inputHash !== inputHash) throw new Error("Question answer operation ID reuse with different input is rejected");
      return current;
    }
    if (current.state !== "pending") throw new Error("Question answer CAS requires exact pending state; question is already answered, closed, or unknown");
    const answeredAt = this.options.now?.() ?? new Date().toISOString();
    const persistedAnswer = deepFreeze({ value, channel, identity: authenticatedIdentity, operationId, inputHash, answeredAt });
    assertQuestionAnswerDeliverable(current, persistedAnswer);
    assertQuestionAnswerDeliverableForSnapshot(this.options.snapshot, current, persistedAnswer);
    const draft = createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId,
      type: "question.transition", producer: questionAnswerProducer(channel), timestamp: answeredAt,
      payload: { formatVersion: FORMAT_VERSION, operation: "answer", questionId, channel, identity: authenticatedIdentity, operationId, inputHash, value: structuredClone(value) as JsonValue },
    });
    try {
      appendWorkflowEventChecked(this.options.projectRoot, draft, (events) => {
        const lockedState = this.restore(events);
        const operation = Object.values(lockedState.questions).find((question) => question.answer?.operationId === operationId)?.answer;
        if (operation) {
          if (operation.inputHash !== inputHash) throw new Error("Question answer operation ID reuse with different input is rejected");
          throw new Error("Question answer operation was recorded concurrently");
        }
        const locked = lockedState.questions[questionId];
        if (!locked || locked.projectId !== projectId || locked.sessionId !== sessionId || locked.runId !== runId || locked.state !== "pending") throw new Error("Question answer CAS lost: exact question identity is already answered, closed, or unknown");
        validateQuestionAnswer(locked.definition, value);
        assertQuestionAnswerDeliverable(locked, persistedAnswer);
        assertQuestionAnswerDeliverableForSnapshot(this.options.snapshot, locked, persistedAnswer);
        const run = replayWorkflowJournal(events, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
        if (run && run.runId !== this.options.runId) throw new Error("Question answer service is stale and does not target the current run");
        if (run && (!isOpenRunStatus(run.status) || run.cancellationRequested || run.pendingTerminal)) throw new Error("Question answer is late because the run is terminal, cancelling, or finalizing");
        if (locked.taskId) {
          const delegation = replayWorkflowJournal(events, createDelegationState(this.options.sessionId, this.options.runId, this.options.snapshot), reduceDelegationState).state;
          const task = delegation.tasks[locked.taskId];
          const questionSuspended = task?.queueState === "suspended" && task.suspendedOnQuestionIds?.includes(questionId) === true && !task.suspendedOn?.length;
          if (!task || task.runId !== this.options.runId || task.targetNodeId !== locked.nodeId || task.attempts.at(-1)?.attemptId !== locked.taskAttemptId
            || (task.queueState !== "active" && !questionSuspended) || task.result) {
            throw new Error("Task-bound question answer is late because its exact task attempt is no longer live");
          }
        }
      }, { fault: (stage) => this.options.journalFault?.("question.transition", stage) });
    } catch (error) {
      const reconciled = this.restore().questions[questionId];
      if (reconciled?.state === "answered" && reconciled.answer?.operationId === operationId && reconciled.answer.inputHash === inputHash) {
        this.presentations.get(questionId)?.controller.abort("Question answered by the durable winner");
        return reconciled;
      }
      throw error;
    }
    const answered = this.restore().questions[questionId];
    if (answered.state !== "answered" || answered.answer?.operationId !== operationId || answered.answer.inputHash !== inputHash) throw new Error("Published question answer could not be reconciled");
    this.presentations.get(questionId)?.controller.abort("Question answered by the durable winner");
    return answered;
  }

  closePending(input: QuestionCloseRequest): Readonly<{ closedQuestionIds: readonly string[] }> {
    if (!plainRecord(input)) throw new Error("Question closure request is invalid");
    exactKeys(input, ["reason", "operationId"], ["expectedQuestionIds"], "Question closure request");
    const reason = boundedText(input.reason, "Question closure reason", QUESTION_LIMITS.reasonBytes);
    const operationId = boundedString(input.operationId, "Question closure operation ID", QUESTION_LIMITS.operationIdBytes);
    const state = this.restore();
    const pending = Object.values(state.questions).filter((question) => question.state === "pending").map((question) => question.questionId).sort();
    let expected: string[] | undefined;
    if (input.expectedQuestionIds !== undefined) {
      if (!Array.isArray(input.expectedQuestionIds) || input.expectedQuestionIds.length > QUESTION_LIMITS.questions || new Set(input.expectedQuestionIds).size !== input.expectedQuestionIds.length
        || input.expectedQuestionIds.some((id) => typeof id !== "string")) throw new Error("Expected question closure IDs are invalid");
      expected = [...input.expectedQuestionIds].sort();
    }
    const operationQuestions = Object.values(state.questions).filter((question) => question.closure?.operationId === operationId).sort((a, b) => a.questionId.localeCompare(b.questionId));
    if (operationQuestions.length) {
      const operationIds = operationQuestions.map((question) => question.questionId);
      if (operationQuestions.some((question) => question.closure?.reason !== reason) || (expected && canonicalJson(expected) !== canonicalJson(operationIds))) {
        throw new Error("Question closure conflicts with the exact operation set or reason");
      }
      return deepFreeze({ closedQuestionIds: operationIds });
    }
    if (expected) {
      const conflicts = expected.some((questionId) => state.questions[questionId]?.state === "closed");
      if (conflicts) throw new Error("Question closure conflicts with a different operation or reason");
      if (canonicalJson(expected) !== canonicalJson(pending)) throw new Error("Question closure set changed before terminal settlement");
    }
    if (!pending.length) return deepFreeze({ closedQuestionIds: [] });
    const draft = createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId,
      type: "question.transition", producer: "harness", timestamp: this.options.now?.() ?? new Date().toISOString(),
      payload: { formatVersion: FORMAT_VERSION, operation: "close-pending", questionIds: pending, reason, operationId },
    });
    try {
      appendWorkflowEventChecked(this.options.projectRoot, draft, (events) => {
        const locked = Object.values(this.restore(events).questions).filter((question) => question.state === "pending").map((question) => question.questionId).sort();
        if (canonicalJson(locked) !== canonicalJson(pending)) throw new Error("Question terminal closure CAS lost because pending state changed");
        const run = replayWorkflowJournal(events, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
        if (run && run.runId !== this.options.runId) throw new Error("Question closure service is stale and does not target the current run");
      }, { fault: (stage) => this.options.journalFault?.("question.transition", stage) });
    } catch (error) {
      const published = readWorkflowJournal(this.options.projectRoot, this.options.sessionId).some((event) => event.eventId === draft.eventId);
      if (!published) throw error;
    }
    const restored = this.restore();
    if (pending.some((questionId) => restored.questions[questionId]?.state !== "closed" || restored.questions[questionId].closure?.operationId !== operationId)) throw new Error("Published question closure could not be reconciled");
    return deepFreeze({ closedQuestionIds: pending });
  }

  pendingForTask(taskId: string): readonly PersistedQuestion[] {
    const id = boundedString(taskId, "Question task ID", QUESTION_LIMITS.idBytes);
    return deepFreeze(Object.values(this.restore().questions).filter((question) => question.taskId === id && question.state === "pending").sort((a, b) => a.creationSequence - b.creationSequence));
  }

  acceptedAnswersForTask(taskId: string): readonly AcceptedQuestionForTask[] {
    const id = boundedString(taskId, "Question task ID", QUESTION_LIMITS.idBytes);
    return deepFreeze(Object.values(this.restore().questions).filter((question): question is PersistedQuestion & { taskId: string; answer: PersistedQuestionAnswer } => question.taskId === id && question.state === "answered" && question.answer !== undefined && question.taskDeliveryAcceptedSequence === undefined)
      .sort((a, b) => a.creationSequence - b.creationSequence)
      .map((question) => this.taskAnswer(question)));
  }

  private taskAnswer(question: PersistedQuestion & { taskId: string; answer: PersistedQuestionAnswer }): AcceptedQuestionForTask {
    if (!question.taskAttemptId) throw new Error("Task question is missing its immutable attempt identity");
    return deepFreeze({ questionId: question.questionId, runId: question.runId, nodeId: question.nodeId, taskId: question.taskId, taskAttemptId: question.taskAttemptId, definition: question.definition, answer: question.answer, transcriptRef: questionAnswerTranscriptRef(question) });
  }

  private rootAnswer(question: PersistedQuestion & { answer: PersistedQuestionAnswer }): AcceptedQuestionForRoot {
    return deepFreeze({ questionId: question.questionId, runId: question.runId, nodeId: question.nodeId, definition: question.definition, answer: question.answer, transcriptRef: questionAnswerTranscriptRef(question) });
  }

  private markToolAnswerReturned(question: PersistedQuestion): void {
    const current = this.restore().questions[question.questionId];
    if (current?.toolAnswerReturnedSequence !== undefined) return;
    const draft = createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId,
      type: "question.transition", producer: "runtime", timestamp: this.options.now?.() ?? new Date().toISOString(),
      payload: { formatVersion: FORMAT_VERSION, operation: "tool-answer-returned", questionId: question.questionId, nodeId: question.nodeId, ...(question.taskId ? { taskId: question.taskId } : {}) },
    });
    try {
      appendWorkflowEventChecked(this.options.projectRoot, draft, (events) => {
        const locked = this.restore(events).questions[question.questionId];
        if (!locked || locked.nodeId !== question.nodeId || locked.taskId !== question.taskId || locked.state !== "answered" || !locked.answer || locked.toolAnswerReturnedSequence !== undefined) throw new Error("Question tool answer return changed before publication");
      }, { fault: (stage) => this.options.journalFault?.("question.transition", stage) });
    } catch (error) {
      if (this.restore().questions[question.questionId]?.toolAnswerReturnedSequence === undefined) throw error;
    }
  }

  private appendDeliveryPreparation(input: Readonly<{ scope: "root" | "task"; nodeId: string; taskId?: string; questionIds: readonly string[] }>): void {
    if (!input.questionIds.length) return;
    const deliveryId = boundedString(`${input.scope}-question-delivery-${randomUUID()}`, "Question delivery ID", QUESTION_LIMITS.operationIdBytes);
    const operation = input.scope === "root" ? "root-delivery-prepared" : "task-delivery-prepared";
    const draft = createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId,
      type: "question.transition", producer: "runtime", timestamp: this.options.now?.() ?? new Date().toISOString(),
      payload: { formatVersion: FORMAT_VERSION, operation, deliveryId, nodeId: input.nodeId, ...(input.taskId ? { taskId: input.taskId } : {}), questionIds: [...input.questionIds] },
    });
    try {
      appendWorkflowEventChecked(this.options.projectRoot, draft, (events) => {
        const locked = this.restore(events);
        const task = input.scope === "task"
          ? replayWorkflowJournal(events, createDelegationState(this.options.sessionId, this.options.runId, this.options.snapshot), reduceDelegationState).state.tasks[input.taskId!]
          : undefined;
        if (input.scope === "task" && (!task || task.targetNodeId !== input.nodeId || task.result || (task.queueState !== "active" && task.queueState !== "suspended"))) {
          throw new Error("Task question delivery preparation requires its exact live task attempt");
        }
        for (const questionId of input.questionIds) {
          const question = locked.questions[questionId];
          const valid = input.scope === "root"
            ? question?.nodeId === input.nodeId && question.taskId === undefined && question.rootDeliveryId === undefined && question.rootDeliveryAcceptedSequence === undefined
            : question?.nodeId === input.nodeId && question.taskId === input.taskId && question.taskAttemptId === task?.attempts.at(-1)?.attemptId
              && question.taskDeliveryId === undefined && question.taskDeliveryAcceptedSequence === undefined;
          if (!valid || question.state !== "answered" || !question.answer) throw new Error(`${input.scope === "root" ? "Root" : "Task"} question answer delivery changed before preparation or belongs to a stale task attempt`);
        }
      }, { fault: (stage) => this.options.journalFault?.("question.transition", stage) });
    } catch (error) {
      const published = readWorkflowJournal(this.options.projectRoot, this.options.sessionId).some((event) => event.eventId === draft.eventId);
      if (!published) throw error;
    }
  }

  private appendDeliveryReceipt(input: Readonly<{ scope: "root" | "task"; deliveryId: string; nodeId: string; taskId?: string; questionIds: readonly string[]; receipt: QuestionDeliveryReceiptInput }>): void {
    const deliveryId = boundedString(input.deliveryId, "Question delivery receipt ID", QUESTION_LIMITS.operationIdBytes);
    const nodeId = boundedString(input.nodeId, "Question delivery receipt node ID", QUESTION_LIMITS.idBytes);
    const taskId = input.taskId === undefined ? undefined : boundedString(input.taskId, "Question delivery receipt task ID", QUESTION_LIMITS.idBytes);
    const questionIds = input.questionIds.map((questionId) => boundedString(questionId, "Question delivery receipt question ID", QUESTION_LIMITS.idBytes));
    if (!questionIds.length || new Set(questionIds).size !== questionIds.length) throw new Error("Question delivery receipt question IDs are invalid");
    const promptHash = input.receipt.promptHash;
    if (typeof promptHash !== "string" || !/^[0-9a-f]{64}$/u.test(promptHash)) throw new Error("Question delivery receipt prompt hash is invalid");
    const attemptId = boundedString(input.receipt.attemptId, "Question delivery receipt attempt ID", QUESTION_LIMITS.idBytes);
    const transcriptRef = boundedText(input.receipt.transcriptRef, "Question delivery receipt transcript reference", 2_048);
    const operation = input.scope === "root" ? "root-delivery-consumed" : "task-delivery-consumed";
    const receiptMatches = (question: PersistedQuestion): boolean => {
      const receipt = input.scope === "root" ? question.rootDeliveryReceipt : question.taskDeliveryReceipt;
      return Boolean(receipt && receipt.promptHash === promptHash && receipt.attemptId === attemptId && receipt.transcriptRef === transcriptRef);
    };
    const current = this.restore();
    if (input.scope === "task") {
      const delegation = replayWorkflowJournal(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), createDelegationState(this.options.sessionId, this.options.runId, this.options.snapshot), reduceDelegationState).state;
      const task = delegation.tasks[taskId!];
      if (!task || task.targetNodeId !== nodeId || task.result || (task.queueState !== "active" && task.queueState !== "suspended")
        || questionIds.some((questionId) => current.questions[questionId]?.taskAttemptId !== task.attempts.at(-1)?.attemptId)) {
        throw new Error("Task question delivery receipt requires the exact immutable task attempt");
      }
    }
    if (questionIds.every((questionId) => receiptMatches(current.questions[questionId]))) return;
    const draft = createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId,
      type: "question.transition", producer: "runtime", timestamp: this.options.now?.() ?? new Date().toISOString(), attemptId,
      payload: { formatVersion: FORMAT_VERSION, operation, deliveryId, nodeId, ...(taskId ? { taskId } : {}), questionIds, promptHash, attemptId, transcriptRef },
    });
    try {
      appendWorkflowEventChecked(this.options.projectRoot, draft, (events) => {
        const locked = this.restore(events);
        for (const questionId of questionIds) {
          const question = locked.questions[questionId];
          const valid = input.scope === "root"
            ? question?.nodeId === nodeId && question.taskId === undefined && question.rootDeliveryId === deliveryId && question.rootDeliveryPreparedSequence !== undefined && question.rootDeliveryReceipt === undefined && question.rootDeliveryAcceptedSequence === undefined
            : question?.nodeId === nodeId && question.taskId === taskId && question.taskDeliveryId === deliveryId && question.taskDeliveryPreparedSequence !== undefined && question.taskDeliveryReceipt === undefined && question.taskDeliveryAcceptedSequence === undefined;
          if (!valid) throw new Error(`${input.scope === "root" ? "Root" : "Task"} question delivery receipt changed before publication`);
        }
        if (input.scope === "task") {
          const delegation = replayWorkflowJournal(events, createDelegationState(this.options.sessionId, this.options.runId, this.options.snapshot), reduceDelegationState).state;
          const task = delegation.tasks[taskId!];
          const questionSuspended = task?.queueState === "suspended" && Boolean(task.suspendedOnQuestionIds?.length) && !task.suspendedOn?.length;
          if (!task || task.targetNodeId !== nodeId || (task.queueState !== "active" && !questionSuspended) || task.result
            || questionIds.some((questionId) => locked.questions[questionId]?.taskAttemptId !== task.attempts.at(-1)?.attemptId)) {
            throw new Error("Task question delivery receipt requires its exact journal-active immutable task attempt");
          }
        }
      }, { fault: (stage) => this.options.journalFault?.("question.transition", stage) });
    } catch (error) {
      const restored = this.restore();
      if (!questionIds.every((questionId) => receiptMatches(restored.questions[questionId]))) throw error;
    }
  }

  taskAnswerDeliveryReturnedByTool(delivery: TaskQuestionAnswerDelivery): boolean {
    if (!plainRecord(delivery) || !Array.isArray(delivery.questionIds)) throw new Error("Task question answer delivery is invalid");
    const state = this.restore();
    return delivery.questionIds.length > 0 && delivery.questionIds.every((questionId) => state.questions[questionId]?.taskDeliveryId === delivery.deliveryId && state.questions[questionId]?.toolAnswerReturnedSequence !== undefined);
  }

  rootAnswerDeliveryReturnedByTool(delivery: RootQuestionAnswerDelivery): boolean {
    if (!plainRecord(delivery) || !Array.isArray(delivery.questionIds)) throw new Error("Root question answer delivery is invalid");
    const state = this.restore();
    return delivery.questionIds.length > 0 && delivery.questionIds.every((questionId) => state.questions[questionId]?.rootDeliveryId === delivery.deliveryId && state.questions[questionId]?.toolAnswerReturnedSequence !== undefined);
  }

  recordTaskAnswerDeliveryReceipt(delivery: TaskQuestionAnswerDelivery, receipt: QuestionDeliveryReceiptInput): void {
    if (!plainRecord(delivery) || !Array.isArray(delivery.questionIds) || !plainRecord(receipt)) throw new Error("Task question delivery receipt is invalid");
    this.appendDeliveryReceipt({ scope: "task", deliveryId: delivery.deliveryId, nodeId: delivery.nodeId, taskId: delivery.taskId, questionIds: delivery.questionIds, receipt });
  }

  recordRootAnswerDeliveryReceipt(delivery: RootQuestionAnswerDelivery, receipt: QuestionDeliveryReceiptInput): void {
    if (!plainRecord(delivery) || !Array.isArray(delivery.questionIds) || !plainRecord(receipt)) throw new Error("Root question delivery receipt is invalid");
    this.appendDeliveryReceipt({ scope: "root", deliveryId: delivery.deliveryId, nodeId: delivery.nodeId, questionIds: delivery.questionIds, receipt });
  }

  reconcileTaskAnswerDeliveryReceipts(taskId: string): void {
    const id = boundedString(taskId, "Task question delivery task ID", QUESTION_LIMITS.idBytes);
    for (const delivery of this.preparedTaskAnswerDeliveries(id)) {
      const state = this.restore();
      if (delivery.questionIds.every((questionId) => state.questions[questionId]?.taskDeliveryReceipt !== undefined)) this.acceptTaskAnswerDelivery(delivery);
    }
  }

  reconcileRootAnswerDeliveryReceipts(nodeId: string): void {
    const id = boundedString(nodeId, "Root question delivery node ID", QUESTION_LIMITS.idBytes);
    for (const delivery of this.preparedRootAnswerDeliveries(id)) {
      const state = this.restore();
      if (delivery.questionIds.every((questionId) => state.questions[questionId]?.rootDeliveryReceipt !== undefined)) this.acceptRootAnswerDelivery(delivery);
    }
  }

  markTaskConsumerReplaySettled(taskId: string, taskAttemptId: string, questionIds: readonly string[]): void {
    const runtime = new DelegationRuntime({
      projectRoot: this.options.projectRoot, projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId,
      snapshot: this.options.snapshot, now: this.options.now,
    });
    runtime.recordQuestionContinuation(taskId, taskAttemptId, questionIds);
  }

  containingAttemptForTaskContinuation(taskId: string, resumedByQuestionSequence: number | undefined): string | undefined {
    const id = boundedString(taskId, "Task continuation question ID", QUESTION_LIMITS.idBytes);
    if (resumedByQuestionSequence === undefined) return undefined;
    if (!Number.isSafeInteger(resumedByQuestionSequence) || resumedByQuestionSequence < 1) throw new Error("Task question continuation sequence is invalid");
    const events = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
    const task = replayWorkflowJournal(events, createDelegationState(this.options.sessionId, this.options.runId, this.options.snapshot), reduceDelegationState).state.tasks[id];
    if (task?.continuedQuestionResumeSequence === resumedByQuestionSequence) return undefined;
    const attempts = new Set(Object.values(this.restore(events).questions)
      .filter((question) => question.taskId === id && question.taskDeliveryReceipt?.consumedSequence === resumedByQuestionSequence)
      .map((question) => question.taskDeliveryReceipt!.attemptId));
    if (attempts.size > 1) throw new Error("Task question continuation is bound to conflicting containing attempts");
    return [...attempts][0];
  }

  private reconcileCompletedAttemptReceipts(): void {
    const events = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
    const attempts = replayWorkflowJournal(events, createAttemptState(this.options.sessionId, this.options.runId), reduceAttemptState).state;
    for (const attempt of Object.values(attempts.attempts).sort((left, right) => left.startedSequence - right.startedSequence)) {
      if (attempt.status !== "completed" || !attempt.result?.ok || !attempt.consumerReceipt?.deliveryIds.length) continue;
      const receipt = { promptHash: attempt.consumerReceipt.promptHash, attemptId: attempt.attemptId, transcriptRef: attempt.consumerReceipt.transcriptRef };
      const taskDeliveries = new Map(this.preparedTaskAnswerDeliveriesForAll().map((delivery) => [delivery.deliveryId, delivery]));
      const rootDeliveries = new Map(this.preparedRootAnswerDeliveriesForAll().map((delivery) => [delivery.deliveryId, delivery]));
      for (const deliveryId of attempt.consumerReceipt.deliveryIds) {
        const task = taskDeliveries.get(deliveryId);
        if (task) this.recordTaskAnswerDeliveryReceipt(task, receipt);
        const root = rootDeliveries.get(deliveryId);
        if (root) this.recordRootAnswerDeliveryReceipt(root, receipt);
      }
    }
  }

  private preparedTaskAnswerDeliveriesForAll(): readonly TaskQuestionAnswerDelivery[] {
    const taskIds = new Set(Object.values(this.restore().questions).flatMap((question) => question.taskId ? [question.taskId] : []));
    return deepFreeze([...taskIds].sort().flatMap((taskId) => this.preparedTaskAnswerDeliveries(taskId)));
  }

  private preparedRootAnswerDeliveriesForAll(): readonly RootQuestionAnswerDelivery[] {
    const nodeIds = new Set(Object.values(this.restore().questions).filter((question) => question.taskId === undefined).map((question) => question.nodeId));
    return deepFreeze([...nodeIds].sort().flatMap((nodeId) => this.preparedRootAnswerDeliveries(nodeId)));
  }

  /** Retryable control settlement performed before worker admission after restart. */
  reconcileAnswerDeliveryReceipts(): void {
    this.reconcileCompletedAttemptReceipts();
    const state = this.restore();
    const taskIds = new Set<string>();
    const rootNodeIds = new Set<string>();
    for (const question of Object.values(state.questions)) {
      if (question.taskDeliveryReceipt && question.taskDeliveryAcceptedSequence === undefined && question.taskId) taskIds.add(question.taskId);
      if (question.rootDeliveryReceipt && question.rootDeliveryAcceptedSequence === undefined && question.taskId === undefined) rootNodeIds.add(question.nodeId);
    }
    for (const taskId of [...taskIds].sort()) this.reconcileTaskAnswerDeliveryReceipts(taskId);
    for (const nodeId of [...rootNodeIds].sort()) this.reconcileRootAnswerDeliveryReceipts(nodeId);
  }

  prepareTaskAnswerDeliveries(taskId: string, exactQuestionIds?: readonly string[]): readonly TaskQuestionAnswerDelivery[] {
    const id = boundedString(taskId, "Task question delivery task ID", QUESTION_LIMITS.idBytes);
    const events = readWorkflowJournal(this.options.projectRoot, this.options.sessionId);
    const beforePreparation = this.restore(events);
    const task = replayWorkflowJournal(events, createDelegationState(this.options.sessionId, this.options.runId, this.options.snapshot), reduceDelegationState).state.tasks[id];
    const undelivered = Object.values(beforePreparation.questions).filter((question) => question.taskId === id && question.state === "answered" && question.answer
      && question.taskDeliveryAcceptedSequence === undefined);
    if (undelivered.length && (!task || task.result || (task.queueState !== "active" && task.queueState !== "suspended")
      || undelivered.some((question) => question.taskAttemptId !== task.attempts.at(-1)?.attemptId))) {
      throw new Error("Task question delivery preparation requires the exact immutable live task attempt");
    }
    this.reconcileTaskAnswerDeliveryReceipts(id);
    const requested = exactQuestionIds === undefined ? undefined : new Set(exactQuestionIds.map((questionId) => boundedString(questionId, "Task question delivery question ID", QUESTION_LIMITS.idBytes)));
    const state = this.restore();
    if (requested && requested.size !== exactQuestionIds!.length) throw new Error("Task question delivery IDs are duplicated");
    const eligible = Object.values(state.questions).filter((question): question is PersistedQuestion & { taskId: string; answer: PersistedQuestionAnswer } => question.taskId === id && question.state === "answered" && question.answer !== undefined
      && question.taskDeliveryAcceptedSequence === undefined && question.taskDeliveryId === undefined && (!requested || requested.has(question.questionId))).sort((a, b) => a.creationSequence - b.creationSequence);
    if (requested && [...requested].some((questionId) => {
      const question = state.questions[questionId];
      return !question || question.taskId !== id || question.state !== "answered" || !question.answer || question.taskDeliveryAcceptedSequence !== undefined;
    })) throw new Error("Task question delivery requires exact undelivered answered questions");
    // Each containing turn receives one complete answer envelope. This is a
    // deliberate continuation page: prompt bounding may omit or truncate a
    // many-answer batch, but a single maximum-size W21 answer is losslessly
    // chunked by the prompt assembler before its receipt can be published.
    if (eligible.length) this.appendDeliveryPreparation({ scope: "task", nodeId: eligible[0].nodeId, taskId: id, questionIds: [eligible[0].questionId] });
    return this.preparedTaskAnswerDeliveries(id);
  }

  preparedTaskAnswerDeliveries(taskId: string): readonly TaskQuestionAnswerDelivery[] {
    const id = boundedString(taskId, "Task question delivery task ID", QUESTION_LIMITS.idBytes);
    const prepared = Object.values(this.restore().questions).filter((question): question is PersistedQuestion & { taskId: string; answer: PersistedQuestionAnswer; taskDeliveryId: string } => question.taskId === id && question.state === "answered" && question.answer !== undefined
      && question.taskDeliveryId !== undefined && question.taskDeliveryAcceptedSequence === undefined).sort((a, b) => a.creationSequence - b.creationSequence);
    const groups = new Map<string, typeof prepared>();
    for (const question of prepared) groups.set(question.taskDeliveryId, [...(groups.get(question.taskDeliveryId) ?? []), question]);
    return deepFreeze([...groups.entries()].map(([deliveryId, questions]) => ({
      deliveryId, nodeId: questions[0].nodeId, taskId: id, questionIds: questions.map((question) => question.questionId), answers: questions.map((question) => this.taskAnswer(question)),
    })));
  }

  acceptTaskAnswerDelivery(delivery: TaskQuestionAnswerDelivery): void {
    if (!plainRecord(delivery) || !Array.isArray(delivery.questionIds)) throw new Error("Task question answer delivery is invalid");
    const deliveryId = boundedString(delivery.deliveryId, "Task question delivery ID", QUESTION_LIMITS.operationIdBytes);
    const nodeId = boundedString(delivery.nodeId, "Task question delivery node ID", QUESTION_LIMITS.idBytes);
    const taskId = boundedString(delivery.taskId, "Task question delivery task ID", QUESTION_LIMITS.idBytes);
    const questionIds = delivery.questionIds.map((id) => boundedString(id, "Task question delivery question ID", QUESTION_LIMITS.idBytes));
    const state = this.restore();
    const delegation = replayWorkflowJournal(readWorkflowJournal(this.options.projectRoot, this.options.sessionId), createDelegationState(this.options.sessionId, this.options.runId, this.options.snapshot), reduceDelegationState).state;
    const task = delegation.tasks[taskId];
    if (!task || task.targetNodeId !== nodeId || task.result || (task.queueState !== "active" && task.queueState !== "suspended")
      || questionIds.some((questionId) => state.questions[questionId]?.taskAttemptId !== task.attempts.at(-1)?.attemptId)) {
      throw new Error("Task question delivery acceptance requires the exact immutable task attempt");
    }
    if (questionIds.every((questionId) => state.questions[questionId]?.taskDeliveryId === deliveryId && state.questions[questionId]?.taskDeliveryAcceptedSequence !== undefined)) return;
    const draft = createWorkflowEvent({ projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId,
      type: "question.transition", producer: "runtime", timestamp: this.options.now?.() ?? new Date().toISOString(),
      payload: { formatVersion: FORMAT_VERSION, operation: "task-delivery-accepted", deliveryId, nodeId, taskId, questionIds } });
    try {
      appendWorkflowEventChecked(this.options.projectRoot, draft, (events) => {
        const locked = this.restore(events);
        const lockedTask = replayWorkflowJournal(events, createDelegationState(this.options.sessionId, this.options.runId, this.options.snapshot), reduceDelegationState).state.tasks[taskId];
        if (!lockedTask || lockedTask.targetNodeId !== nodeId || lockedTask.result || (lockedTask.queueState !== "active" && lockedTask.queueState !== "suspended")) {
          throw new Error("Task question answer delivery acceptance lost its live task attempt");
        }
        for (const questionId of questionIds) {
          const question = locked.questions[questionId];
          if (!question || question.nodeId !== nodeId || question.taskId !== taskId || question.taskAttemptId !== lockedTask.attempts.at(-1)?.attemptId
            || question.taskDeliveryId !== deliveryId || question.taskDeliveryReceipt === undefined || question.taskDeliveryAcceptedSequence !== undefined) {
            throw new Error("Task question answer delivery acceptance CAS lost or targets a stale task attempt");
          }
        }
      }, { fault: (stage) => this.options.journalFault?.("question.transition", stage) });
    } catch (error) {
      const restored = this.restore();
      if (!questionIds.every((questionId) => restored.questions[questionId]?.taskDeliveryId === deliveryId && restored.questions[questionId]?.taskDeliveryAcceptedSequence !== undefined)) throw error;
    }
  }

  prepareRootAnswerDeliveries(nodeId: string, exactQuestionIds?: readonly string[]): readonly RootQuestionAnswerDelivery[] {
    const rootNodeId = boundedString(nodeId, "Root question delivery node ID", QUESTION_LIMITS.idBytes);
    this.reconcileRootAnswerDeliveryReceipts(rootNodeId);
    const requested = exactQuestionIds === undefined ? undefined : new Set(exactQuestionIds.map((questionId) => boundedString(questionId, "Root question delivery question ID", QUESTION_LIMITS.idBytes)));
    const state = this.restore();
    if (requested && requested.size !== exactQuestionIds!.length) throw new Error("Root question delivery IDs are duplicated");
    const eligible = Object.values(state.questions).filter((question): question is PersistedQuestion & { answer: PersistedQuestionAnswer } => question.nodeId === rootNodeId && question.taskId === undefined && question.state === "answered"
      && question.answer !== undefined && question.rootDeliveryAcceptedSequence === undefined && question.rootDeliveryId === undefined && (!requested || requested.has(question.questionId))).sort((a, b) => a.creationSequence - b.creationSequence);
    if (requested && [...requested].some((questionId) => {
      const question = state.questions[questionId];
      return !question || question.nodeId !== rootNodeId || question.taskId !== undefined || question.state !== "answered" || !question.answer || question.rootDeliveryAcceptedSequence !== undefined;
    })) throw new Error("Root question delivery requires exact undelivered answered questions");
    if (eligible.length) this.appendDeliveryPreparation({ scope: "root", nodeId: rootNodeId, questionIds: [eligible[0].questionId] });
    return this.preparedRootAnswerDeliveries(rootNodeId);
  }

  preparedRootAnswerDeliveries(nodeId: string): readonly RootQuestionAnswerDelivery[] {
    const rootNodeId = boundedString(nodeId, "Root question delivery node ID", QUESTION_LIMITS.idBytes);
    const prepared = Object.values(this.restore().questions).filter((question): question is PersistedQuestion & { answer: PersistedQuestionAnswer; rootDeliveryId: string } => question.nodeId === rootNodeId && question.taskId === undefined
      && question.state === "answered" && question.answer !== undefined && question.rootDeliveryId !== undefined && question.rootDeliveryAcceptedSequence === undefined).sort((a, b) => a.creationSequence - b.creationSequence);
    const groups = new Map<string, typeof prepared>();
    for (const question of prepared) groups.set(question.rootDeliveryId, [...(groups.get(question.rootDeliveryId) ?? []), question]);
    return deepFreeze([...groups.entries()].map(([deliveryId, questions]) => ({
      deliveryId, nodeId: rootNodeId, questionIds: questions.map((question) => question.questionId), answers: questions.map((question) => this.rootAnswer(question)),
    })));
  }

  prepareRootAnswerDelivery(nodeId: string): RootQuestionAnswerDelivery | undefined {
    return this.prepareRootAnswerDeliveries(nodeId)[0];
  }

  acceptRootAnswerDelivery(delivery: RootQuestionAnswerDelivery): void {
    if (!plainRecord(delivery) || !Array.isArray(delivery.questionIds)) throw new Error("Root question answer delivery is invalid");
    const deliveryId = boundedString(delivery.deliveryId, "Root question delivery ID", QUESTION_LIMITS.operationIdBytes);
    const nodeId = boundedString(delivery.nodeId, "Root question delivery node ID", QUESTION_LIMITS.idBytes);
    const questionIds = delivery.questionIds.map((id) => boundedString(id, "Root question delivery question ID", QUESTION_LIMITS.idBytes));
    const state = this.restore();
    if (questionIds.every((questionId) => state.questions[questionId]?.rootDeliveryId === deliveryId && state.questions[questionId]?.rootDeliveryAcceptedSequence !== undefined)) return;
    const draft = createWorkflowEvent({ projectId: this.options.projectId, sessionId: this.options.sessionId, runId: this.options.runId,
      type: "question.transition", producer: "runtime", timestamp: this.options.now?.() ?? new Date().toISOString(),
      payload: { formatVersion: FORMAT_VERSION, operation: "root-delivery-accepted", deliveryId, nodeId, questionIds } });
    try {
      appendWorkflowEventChecked(this.options.projectRoot, draft, (events) => {
        for (const questionId of questionIds) {
          const question = this.restore(events).questions[questionId];
          if (!question || question.nodeId !== nodeId || question.rootDeliveryId !== deliveryId || question.rootDeliveryReceipt === undefined || question.rootDeliveryAcceptedSequence !== undefined) throw new Error("Root question answer delivery acceptance CAS lost");
        }
      }, { fault: (stage) => this.options.journalFault?.("question.transition", stage) });
    } catch (error) {
      const restored = this.restore();
      if (!questionIds.every((questionId) => restored.questions[questionId]?.rootDeliveryId === deliveryId && restored.questions[questionId]?.rootDeliveryAcceptedSequence !== undefined)) throw error;
    }
  }

  private undeliveredAnswered(state: QuestionState, taskId?: string): readonly PersistedQuestion[] {
    return Object.values(state.questions).filter((question) => question.state === "answered" && question.answer
      && (taskId === undefined ? question.taskId === undefined && question.rootDeliveryAcceptedSequence === undefined
        : question.taskId === taskId && question.taskDeliveryAcceptedSequence === undefined));
  }

  assertTaskMayTerminal(events: readonly WorkflowEventEnvelope[], taskId: string, terminalStatus?: "completed" | "blocked" | "failed" | "cancelled"): void {
    const id = boundedString(taskId, "Terminal task question ID", QUESTION_LIMITS.idBytes);
    const state = this.restore(events);
    const pending = Object.values(state.questions).filter((question) => question.taskId === id && question.state === "pending");
    const undelivered = this.undeliveredAnswered(state, id);
    if (pending.length || undelivered.length) {
      const run = replayWorkflowJournal(events, createEmptyRunLifecycleState(this.options.sessionId), reduceRunLifecycle).state.latestRun;
      if (terminalStatus === "cancelled" && run?.runId === this.options.runId && (run.cancellationRequested || run.pendingTerminal)) return;
      throw new Error(`Worker terminal publication rejected: ${pending.length} pending and ${undelivered.length} answered-undelivered question(s) remain for the same task attempt`);
    }
  }

  assertPendingSet(events: readonly WorkflowEventEnvelope[], expectedQuestionIds: readonly string[]): void {
    const expected = [...expectedQuestionIds].sort();
    const state = this.restore(events);
    const pending = Object.values(state.questions).filter((question) => question.state === "pending").map((question) => question.questionId).sort();
    if (canonicalJson(pending) !== canonicalJson(expected)) throw new Error("Exact pending question set changed before journal publication");
  }

  assertRootMayTerminal(events: readonly WorkflowEventEnvelope[]): void {
    const undelivered = this.undeliveredAnswered(this.restore(events));
    if (undelivered.length) throw new Error(`Terminal publication rejected: ${undelivered.length} answered root question(s) remain undelivered`);
  }

  completionGate(): Readonly<{ state: "satisfied" | "unsatisfied"; issues?: readonly string[]; pendingQuestionIds?: readonly string[] }> {
    const state = this.restore();
    const pending = Object.values(state.questions).filter((question) => question.state === "pending").map((question) => question.questionId).sort();
    const undelivered = Object.values(state.questions).filter((question) => question.state === "answered" && question.answer
      && (question.taskId === undefined ? question.rootDeliveryAcceptedSequence === undefined : question.taskDeliveryAcceptedSequence === undefined));
    if (pending.length || undelivered.length) return deepFreeze({
      state: "unsatisfied",
      issues: [
        ...(pending.length ? [`${pending.length} human question(s) remain pending`] : []),
        ...(undelivered.length ? [`${undelivered.length} answered human question(s) have not reached their owning root or task transcript`] : []),
      ],
      ...(pending.length ? { pendingQuestionIds: pending } : {}),
    });
    return deepFreeze({ state: "satisfied" });
  }

  detail(request: QuestionDetailRequest): QuestionDetailPage {
    if (!plainRecord(request)) throw new Error("Question detail request is invalid");
    exactKeys(request, ["projectId", "sessionId", "runId", "questionId"], ["cursor", "choiceLimit"], "Question detail request");
    const projectId = boundedString(request.projectId, "Question detail project ID", QUESTION_LIMITS.idBytes);
    const sessionId = boundedString(request.sessionId, "Question detail session ID", QUESTION_LIMITS.idBytes);
    const runId = boundedString(request.runId, "Question detail run ID", QUESTION_LIMITS.idBytes);
    const questionId = boundedString(request.questionId, "Question detail question ID", QUESTION_LIMITS.idBytes);
    if (projectId !== this.options.projectId || sessionId !== this.options.sessionId || runId !== this.options.runId) throw new Error("Question detail exact identity does not match this control service");
    const question = this.restore().questions[questionId];
    if (!question) throw new Error("Question detail identity is unknown");
    const rawLimit = request.choiceLimit ?? QUESTION_LIMITS.choices;
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > QUESTION_LIMITS.choices) throw new Error("Question detail choice limit is invalid");
    if (request.cursor !== undefined && typeof request.cursor !== "string") throw new Error("Question detail cursor is invalid");
    const start = detailOffset(request.cursor, question);
    const remainingPrompt = question.definition.prompt.slice(start.prompt);
    const promptChunk = utf8Prefix(remainingPrompt, 8_192);
    const promptOffset = start.prompt + promptChunk.length;
    const allChoices = question.definition.choices ?? [];
    const choices: Array<{ value: string; label: string }> = [];
    const base = {
      questionId, projectId, sessionId, runId, nodeId: question.nodeId, ...(question.taskId ? { taskId: question.taskId } : {}),
      state: question.state, kind: question.definition.kind, required: question.definition.required,
      ...(question.definition.validation ? { validation: question.definition.validation } : {}),
      promptChunk, promptOffset: start.prompt, promptBytes: Buffer.byteLength(question.definition.prompt, "utf8"), promptComplete: promptOffset === question.definition.prompt.length,
      choiceOffset: start.choice, choiceCount: allChoices.length, createdAt: question.createdAt,
    };
    for (const choice of allChoices.slice(start.choice, start.choice + Number(rawLimit))) {
      const candidateChoices = [...choices, choice];
      const nextPrompt = promptOffset < question.definition.prompt.length;
      const nextChoice = start.choice + candidateChoices.length < allChoices.length;
      const candidate = { ...base, choices: candidateChoices, ...(nextPrompt || nextChoice ? { nextCursor: `${question.creationSequence}:${promptOffset}:${start.choice + candidateChoices.length}` } : {}) };
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > QUESTION_LIMITS.dtoBytes) break;
      choices.push(choice);
    }
    if (start.choice < allChoices.length && !choices.length) throw new Error("Question detail cannot make progress within its output bound");
    const nextPrompt = promptOffset < question.definition.prompt.length;
    const nextChoice = start.choice + choices.length < allChoices.length;
    const result = deepFreeze({ ...base, choices, ...(nextPrompt || nextChoice ? { nextCursor: `${question.creationSequence}:${promptOffset}:${start.choice + choices.length}` } : {}) });
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > QUESTION_LIMITS.dtoBytes) throw new Error("Question detail DTO exceeds its bounded output contract");
    return result;
  }

  status(request: QuestionStatusRequest = {}): QuestionStatusPage {
    if (!plainRecord(request)) throw new Error("Question status request is invalid");
    exactKeys(request, [], ["state", "limit", "cursor"], "Question status request");
    if (request.state !== undefined && request.state !== "pending" && request.state !== "answered" && request.state !== "closed") throw new Error("Question status filter is invalid");
    const rawLimit = request.limit;
    if (rawLimit !== undefined && !Number.isSafeInteger(rawLimit)) throw new Error("Question status limit is invalid");
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (limit < 1 || limit > QUESTION_LIMITS.dtoItems) throw new Error("Question status limit is invalid");
    if (request.cursor !== undefined && typeof request.cursor !== "string") throw new Error("Question status cursor is invalid");
    const questions = Object.values(this.restore().questions).sort((a, b) => a.creationSequence - b.creationSequence);
    const afterSequence = statusCursor(request.cursor as string | undefined, request.state, questions);
    const all = questions.filter((question) => (request.state === undefined || question.state === request.state) && question.creationSequence > afterSequence);
    const total = questions.filter((question) => request.state === undefined || question.state === request.state).length;
    const items: QuestionStatusItem[] = [];
    let lastSequence = afterSequence;
    for (const question of all.slice(0, limit)) {
      const preview = utf8Prefix(question.definition.prompt, 512);
      const item = deepFreeze({
        questionId: question.questionId, projectId: question.projectId, sessionId: question.sessionId,
        runId: question.runId, nodeId: question.nodeId, ...(question.taskId ? { taskId: question.taskId } : {}),
        kind: question.definition.kind, required: question.definition.required, state: question.state,
        promptPreview: preview, promptBytes: Buffer.byteLength(question.definition.prompt, "utf8"), promptTruncated: preview !== question.definition.prompt,
        choiceCount: question.definition.choices?.length ?? 0, createdAt: question.createdAt,
        ...(question.answer ? { answerChannel: question.answer.channel, answeredAt: question.answer.answeredAt } : {}),
        ...(question.closure ? { closedAt: question.closure.closedAt } : {}),
        readRef: `run:${question.runId}/question:${question.questionId}`,
      });
      const cursor = `${request.state ?? "all"}:${question.creationSequence}`;
      const candidate = { total, items: [...items, item], ...(items.length + 1 < all.length ? { nextCursor: cursor } : {}) };
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > QUESTION_LIMITS.dtoBytes) break;
      items.push(item);
      lastSequence = question.creationSequence;
    }
    if (all.length && !items.length) throw new Error("Question status cannot make progress within its output bound");
    const result = deepFreeze({ total, items, ...(items.length < all.length ? { nextCursor: `${request.state ?? "all"}:${lastSequence}` } : {}) });
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > QUESTION_LIMITS.dtoBytes) throw new Error("Question status DTO exceeds its bounded output contract");
    return result;
  }

  hasLiveHandles(): boolean { return this.presentations.size > 0; }
  isShutdown(): boolean { return this.closed; }

  async shutdown(): Promise<void> {
    this.closed = true;
    const tracked = [...this.presentations.values()];
    for (const { controller } of tracked) controller.abort("Question service shutdown");
    await Promise.allSettled(tracked.map(({ settlement }) => settlement));
  }
}
