import { createHash } from "node:crypto";
import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";
import { verifyWorkflowEvent, type WorkflowEventEnvelope } from "../workflows/events";
import { redactProjectionValue, type WorkflowRedactionOptions } from "./redaction";

export const WORKFLOW_TELEMETRY_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_TELEMETRY_LIMITS = Object.freeze({ summaryBytes: 2_048, refs: 64, refBytes: 1_024, dimensionBytes: 1_024, numericMagnitude: 1_000_000_000_000 });

export interface WorkflowTelemetryContext {
  readonly projectRoot?: string;
  readonly projectLabel?: string;
  readonly piSessionId?: string;
  readonly workflowId?: string;
  readonly snapshotId?: string;
  readonly workflowConfigHash?: string;
  readonly workflowConfigVersion?: string;
  readonly redaction?: WorkflowRedactionOptions;
}

export interface WorkflowTelemetryDimensions {
  readonly projectId: string;
  readonly projectRoot?: string;
  readonly projectLabel?: string;
  readonly sessionId: string;
  readonly piSessionId?: string;
  readonly workflowId?: string;
  readonly snapshotId?: string;
  readonly workflowConfigHash?: string;
  readonly workflowConfigVersion?: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly agentName?: string;
  readonly nodeId?: string;
  readonly parentNodeId?: string;
  readonly taskId?: string;
  readonly adapterId?: string;
  readonly adapterVersion?: string;
  readonly profileId?: string;
  readonly profileVersion?: string;
  readonly workspaceId?: string;
  readonly workspaceHash?: string;
  readonly leaseState?: string;
  readonly questionId?: string;
  readonly checkpointId?: string;
  readonly approvalId?: string;
  readonly knowledgeJobId?: string;
  readonly knowledgeUpdateId?: string;
  readonly modelId?: string;
  readonly thinking?: string;
  readonly toolName?: string;
  readonly capabilityId?: string;
  readonly attemptId?: string;
  readonly operationId?: string;
}

export interface WorkflowTelemetryUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicroUsd: number;
  readonly precision: "estimated" | "provider-confirmed";
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export interface WorkflowTelemetryMetrics {
  readonly elapsedMs?: number;
  readonly activeWallTimeMs?: number;
  readonly budgetScope?: string;
  readonly budgetUsed?: number;
  readonly budgetLimit?: number;
  readonly budgetRemaining?: number;
}

export interface WorkflowTelemetryTerminal {
  readonly status?: string;
  readonly changeCoverage?: string;
  readonly terminalEventHash?: string;
  readonly refs: readonly string[];
}

export interface WorkflowTelemetryEvent {
  readonly schemaVersion: 1;
  readonly streamId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly timestamp: string;
  readonly producer: string;
  readonly sequence: number;
  readonly previousHash: string | null;
  readonly payloadHash: string;
  /** Hash of the verified authoritative journal envelope. */
  readonly sourceEventHash: string;
  /** Hash of every projected field, including the source journal linkage. */
  readonly eventHash: string;
  readonly correlationId?: string;
  readonly dimensions: WorkflowTelemetryDimensions;
  readonly status?: string;
  readonly operation?: string;
  readonly summary?: string;
  readonly refs: readonly string[];
  readonly usage?: WorkflowTelemetryUsage;
  readonly metrics?: WorkflowTelemetryMetrics;
  readonly terminal?: WorkflowTelemetryTerminal;
  readonly metadata: JsonValue;
}

const TRUSTED_WORKFLOW_TELEMETRY_EVENT = Symbol("trusted-workflow-telemetry-event");
const SHA256 = /^[0-9a-f]{64}$/u;
type TrustedWorkflowTelemetryEvent = WorkflowTelemetryEvent & { readonly [TRUSTED_WORKFLOW_TELEMETRY_EVENT]: true };

type RecordValue = Record<string, unknown>;

function projectionHash(value: Omit<WorkflowTelemetryEvent, "eventHash">): string {
  return createHash("sha256").update("pi-hive-workflow-telemetry-event-v1\0").update(canonicalJson(value)).digest("hex");
}

function frame(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

function verifyProjectedIdentity(value: WorkflowTelemetryEvent): void {
  const dimensionValues = value?.dimensions && typeof value.dimensions === "object" ? Object.values(value.dimensions) : [];
  const numericValues = [value?.usage?.inputTokens, value?.usage?.outputTokens, value?.usage?.costMicroUsd, value?.usage?.cacheReadTokens,
    value?.usage?.cacheWriteTokens, value?.usage?.reasoningTokens, value?.metrics?.elapsedMs, value?.metrics?.activeWallTimeMs,
    value?.metrics?.budgetUsed, value?.metrics?.budgetLimit, value?.metrics?.budgetRemaining].filter((entry): entry is number => entry !== undefined);
  if (!value || typeof value !== "object" || !value.dimensions || typeof value.dimensions !== "object"
    || typeof value.dimensions.projectId !== "string" || typeof value.dimensions.sessionId !== "string"
    || dimensionValues.some((entry) => typeof entry !== "string" || !entry || Buffer.byteLength(entry, "utf8") > WORKFLOW_TELEMETRY_LIMITS.dimensionBytes)
    || typeof value.streamId !== "string" || typeof value.eventId !== "string" || typeof value.eventType !== "string"
    || typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp)) || typeof value.producer !== "string" || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || !Array.isArray(value.refs) || value.refs.length > WORKFLOW_TELEMETRY_LIMITS.refs || value.refs.some((entry) => typeof entry !== "string" || Buffer.byteLength(entry, "utf8") > WORKFLOW_TELEMETRY_LIMITS.refBytes)
    || numericValues.some((entry) => !Number.isFinite(entry) || entry < 0 || entry > WORKFLOW_TELEMETRY_LIMITS.numericMagnitude)
    || (value.usage && [value.usage.inputTokens, value.usage.outputTokens, value.usage.costMicroUsd, value.usage.cacheReadTokens, value.usage.cacheWriteTokens, value.usage.reasoningTokens]
      .filter((entry): entry is number => entry !== undefined).some((entry) => !Number.isSafeInteger(entry)))) throw new Error("Workflow telemetry persisted event shape is invalid");
  const dimensionHashes = [value.dimensions.workflowConfigHash, value.dimensions.workspaceHash, value.terminal?.terminalEventHash].filter((hash): hash is string => hash !== undefined);
  if (value.schemaVersion !== 1 || !SHA256.test(value.eventHash) || !SHA256.test(value.payloadHash) || !SHA256.test(value.sourceEventHash)
    || (value.previousHash !== null && !SHA256.test(value.previousHash))
    || dimensionHashes.some((hash) => !SHA256.test(hash) && !/^sha256:[0-9a-f]{64}$/u.test(hash))) throw new Error("Workflow telemetry hash format is invalid");
  if (value.streamId !== workflowTelemetryStreamId(value.dimensions.projectId, value.dimensions.sessionId)) throw new Error("Workflow telemetry stream identity mismatch");
  const { eventHash, ...identity } = value;
  if (projectionHash(identity) !== eventHash) throw new Error("Workflow telemetry projected event hash mismatch");
}

export function verifyWorkflowTelemetryEvent(value: WorkflowTelemetryEvent): asserts value is TrustedWorkflowTelemetryEvent {
  if ((value as Partial<TrustedWorkflowTelemetryEvent>)[TRUSTED_WORKFLOW_TELEMETRY_EVENT] !== true) throw new Error("Workflow telemetry event lacks trusted journal authentication");
  verifyProjectedIdentity(value);
}

/** Re-authenticates a persisted projection row from its complete committed event hash. */
export function restoreWorkflowTelemetryEvent(value: unknown): WorkflowTelemetryEvent {
  const event = value as WorkflowTelemetryEvent;
  verifyProjectedIdentity(event);
  Object.defineProperty(event, TRUSTED_WORKFLOW_TELEMETRY_EVENT, { value: true, enumerable: false, writable: false });
  return Object.freeze(event);
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function findValue(root: RecordValue, keys: readonly string[], depth = 0): unknown {
  for (const key of keys) if (root[key] !== undefined) return root[key];
  if (depth >= 4) return undefined;
  for (const child of Object.values(root)) {
    const nested = record(child);
    if (!nested) continue;
    const found = findValue(nested, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function stringValue(root: RecordValue, keys: readonly string[], maxBytes = 1_024): string | undefined {
  const value = findValue(root, keys);
  if (typeof value !== "string" || !value) return undefined;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output || undefined;
}

function boundedNonnegative(value: unknown, label: string, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > WORKFLOW_TELEMETRY_LIMITS.numericMagnitude) throw new Error(`Workflow telemetry ${label} magnitude is invalid`);
  return value;
}

function optionalNonnegative(root: RecordValue, keys: readonly string[], label: string): number | undefined {
  return boundedNonnegative(findValue(root, keys), label);
}

function boundedUsage(value: unknown, label: string, fallback?: number): number {
  const result = boundedNonnegative(value, label, fallback);
  if (result === undefined || !Number.isSafeInteger(result)) throw new Error(`Workflow telemetry ${label} must be a safe integer`);
  return result;
}

function metrics(root: RecordValue): WorkflowTelemetryMetrics | undefined {
  const result: WorkflowTelemetryMetrics = {
    ...(optionalNonnegative(root, ["elapsedMs", "durationMs"], "elapsed metric") !== undefined ? { elapsedMs: optionalNonnegative(root, ["elapsedMs", "durationMs"], "elapsed metric") } : {}),
    ...(optionalNonnegative(root, ["activeWallTimeMs"], "active wall-time metric") !== undefined ? { activeWallTimeMs: optionalNonnegative(root, ["activeWallTimeMs"], "active wall-time metric") } : {}),
    ...(stringValue(root, ["budgetScope"]) ? { budgetScope: stringValue(root, ["budgetScope"]) } : {}),
    ...(optionalNonnegative(root, ["budgetUsed"], "budget-used metric") !== undefined ? { budgetUsed: optionalNonnegative(root, ["budgetUsed"], "budget-used metric") } : {}),
    ...(optionalNonnegative(root, ["budgetLimit"], "budget-limit metric") !== undefined ? { budgetLimit: optionalNonnegative(root, ["budgetLimit"], "budget-limit metric") } : {}),
    ...(optionalNonnegative(root, ["budgetRemaining"], "budget-remaining metric") !== undefined ? { budgetRemaining: optionalNonnegative(root, ["budgetRemaining"], "budget-remaining metric") } : {}),
  };
  return Object.keys(result).length ? Object.freeze(result) : undefined;
}

function usage(root: RecordValue): WorkflowTelemetryUsage | undefined {
  const candidate = record(findValue(root, ["usage", "providerUsage"]));
  if (!candidate) return undefined;
  const precision: WorkflowTelemetryUsage["precision"] | undefined = candidate.precision === "provider-confirmed" ? "provider-confirmed" : candidate.precision === "estimated" ? "estimated" : undefined;
  if (!precision) return undefined;
  const base = {
    inputTokens: boundedUsage(candidate.inputTokens ?? candidate.input, "input-token usage", 0),
    outputTokens: boundedUsage(candidate.outputTokens ?? candidate.output, "output-token usage", 0),
    costMicroUsd: boundedUsage(candidate.costMicroUsd, "cost usage", 0),
    precision,
  };
  return Object.freeze({
    ...base,
    ...(candidate.cacheReadTokens !== undefined ? { cacheReadTokens: boundedUsage(candidate.cacheReadTokens, "cache-read usage") } : {}),
    ...(candidate.cacheWriteTokens !== undefined ? { cacheWriteTokens: boundedUsage(candidate.cacheWriteTokens, "cache-write usage") } : {}),
    ...(candidate.reasoningTokens !== undefined ? { reasoningTokens: boundedUsage(candidate.reasoningTokens, "reasoning-token usage") } : {}),
  });
}

const REFERENCE_ARRAY_KEYS = new Set(["refs", "references", "artifactRefs", "evidenceRefs", "checkpointRefs", "knowledgeRefs", "knowledgeJobRefs", "knowledgeUpdateRefs"]);
const REFERENCE_ID_KEYS = new Set(["id", "workspaceId", "checkpoint", "checkpointId", "toolCallId", "eventId", "candidateId", "knowledgeJobId", "knowledgeUpdateId", "jobId", "updateId"]);
const REFERENCE_HASH_KEYS = new Set(["digest", "hash", "contentHash", "eventHash", "payloadHash", "sourceHash", "terminalEventHash"]);

function referenceArrays(root: RecordValue, depth = 0): ReadonlyArray<readonly [string, readonly unknown[]]> {
  const output: Array<readonly [string, readonly unknown[]]> = [];
  for (const [key, value] of Object.entries(root)) {
    if (REFERENCE_ARRAY_KEYS.has(key) && Array.isArray(value)) output.push([key, value]);
    if (depth >= 4) continue;
    const nested = record(value);
    if (nested) output.push(...referenceArrays(nested, depth + 1));
  }
  return output;
}

function refs(root: RecordValue, options: WorkflowRedactionOptions): readonly string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    if (!raw || output.length >= WORKFLOW_TELEMETRY_LIMITS.refs) return;
    const value = String(redactProjectionValue(raw, { ...options, maxStringBytes: WORKFLOW_TELEMETRY_LIMITS.refBytes }));
    if (!value || seen.has(value)) return;
    seen.add(value); output.push(value);
  };
  for (const [field, values] of referenceArrays(root)) {
    for (const value of values) {
      if (typeof value === "string") { push(value); continue; }
      const structured = record(value);
      if (!structured) continue;
      for (const [key, candidate] of Object.entries(structured)) {
        if (typeof candidate !== "string" || !candidate) continue;
        if (REFERENCE_ID_KEYS.has(key)) push(candidate);
        else if (REFERENCE_HASH_KEYS.has(key) && (/^sha256:[0-9a-f]{64}$/u.test(candidate) || SHA256.test(candidate))) push(candidate);
      }
      // Evidence claims are useful only through their authenticated identity;
      // never copy the raw claim into telemetry when no external ID exists.
      if (field === "evidenceRefs") push(`sha256:${createHash("sha256").update("pi-hive-workflow-evidence-ref-v1\0").update(canonicalJson(structured)).digest("hex")}`);
    }
  }
  return Object.freeze(output);
}

function dimensions(source: WorkflowEventEnvelope, payload: RecordValue, context: WorkflowTelemetryContext): WorkflowTelemetryDimensions {
  const optional = (key: keyof WorkflowTelemetryDimensions, value: string | undefined): Record<string, string> => {
    if (!value) return {};
    if (Buffer.byteLength(value, "utf8") > WORKFLOW_TELEMETRY_LIMITS.dimensionBytes) throw new Error(`Workflow telemetry ${key} dimension exceeds its byte limit`);
    return { [key]: value };
  };
  return Object.freeze({
    projectId: source.projectId,
    ...optional("projectRoot", context.projectRoot), ...optional("projectLabel", context.projectLabel),
    sessionId: source.sessionId, ...optional("piSessionId", context.piSessionId),
    ...optional("workflowId", context.workflowId ?? stringValue(payload, ["workflowId"])),
    ...optional("snapshotId", context.snapshotId ?? stringValue(payload, ["snapshotId"])),
    ...optional("workflowConfigHash", context.workflowConfigHash ?? stringValue(payload, ["workflowConfigHash", "configHash"])),
    ...optional("workflowConfigVersion", context.workflowConfigVersion ?? stringValue(payload, ["workflowConfigVersion", "configVersion"])),
    ...optional("runId", source.runId),
    ...optional("agentId", stringValue(payload, ["agentId"])),
    ...optional("agentName", stringValue(payload, ["agentName", "displayName"])),
    ...optional("nodeId", stringValue(payload, ["nodeId", "targetNodeId"])),
    ...optional("parentNodeId", stringValue(payload, ["parentNodeId"])),
    ...optional("taskId", stringValue(payload, ["taskId"])),
    ...optional("adapterId", stringValue(payload, ["adapterId"])),
    ...optional("adapterVersion", stringValue(payload, ["adapterVersion"])),
    ...optional("profileId", stringValue(payload, ["profileId"])),
    ...optional("profileVersion", stringValue(payload, ["profileVersion"])),
    ...optional("workspaceId", stringValue(payload, ["workspaceId"]) ?? stringValue(record(payload.workspace) ?? {}, ["id"])),
    ...optional("workspaceHash", stringValue(payload, ["workspaceHash", "finalWorkspaceHash"])),
    ...optional("leaseState", stringValue(payload, ["leaseState"])),
    ...optional("questionId", stringValue(payload, ["questionId"])),
    ...optional("checkpointId", stringValue(payload, ["checkpointId"])),
    ...optional("approvalId", stringValue(payload, ["approvalId", "requestId", "decisionId"])),
    ...optional("knowledgeJobId", stringValue(payload, ["knowledgeJobId", "jobId"])),
    ...optional("knowledgeUpdateId", stringValue(payload, ["knowledgeUpdateId", "updateId"])),
    ...optional("modelId", stringValue(payload, ["modelId", "model"])),
    ...optional("thinking", stringValue(payload, ["thinking"])),
    ...optional("toolName", stringValue(payload, ["toolName"])),
    ...optional("capabilityId", stringValue(payload, ["capabilityId", "capability"])),
    ...optional("attemptId", source.attemptId ?? stringValue(payload, ["attemptId"])),
    ...optional("operationId", source.correlationId ?? stringValue(payload, ["operationId"])),
  }) as unknown as WorkflowTelemetryDimensions;
}

export function workflowTelemetryStreamId(projectId: string, sessionId: string): string {
  const digest = createHash("sha256").update("pi-hive-workflow-telemetry-stream-v1\0").update(frame(projectId)).update(frame(sessionId)).digest("hex");
  return `wfs1-${digest}`;
}

function eventStatus(eventType: string, payload: RecordValue, operation: string | undefined): string | undefined {
  const explicit = stringValue(payload, ["status", "to", "state"]);
  if (explicit) return explicit;
  if (eventType === "question.transition") {
    if (operation === "create") return "pending";
    if (operation === "answer") return "answered";
    if (operation === "close-pending") return "closed";
  }
  if (eventType === "approval.recorded") {
    if (operation === "request") return "pending";
    if (operation === "decision") return stringValue(payload, ["verdict", "decisionStatus"]) ?? "decided";
  }
  if (eventType === "run.started" || eventType === "task.started") return "running";
  if (eventType === "session.created" || eventType === "session.linked" || eventType === "session.recovered") return "active";
  if (eventType === "session.orphaned") return "orphaned";
  return undefined;
}

export function toWorkflowTelemetryEvent(source: WorkflowEventEnvelope, context: WorkflowTelemetryContext = {}): WorkflowTelemetryEvent {
  verifyWorkflowEvent(source);
  const payload = record(source.payload) ?? {};
  const redaction = context.redaction ?? {};
  const operation = stringValue(payload, ["operation"]);
  const status = eventStatus(source.type, payload, operation);
  const rawSummary = stringValue(payload, ["summary", "reason", "diagnostic"], WORKFLOW_TELEMETRY_LIMITS.summaryBytes);
  const summary = rawSummary === undefined ? undefined : String(redactProjectionValue(rawSummary, { ...redaction, maxStringBytes: WORKFLOW_TELEMETRY_LIMITS.summaryBytes }));
  const eventRefs = refs(payload, redaction);
  const terminal = source.type === "terminal.recorded" ? Object.freeze({
    ...(status ? { status } : {}),
    ...(stringValue(payload, ["changeCoverage"]) ? { changeCoverage: stringValue(payload, ["changeCoverage"]) } : {}),
    ...(stringValue(payload, ["terminalEventHash"]) ? { terminalEventHash: stringValue(payload, ["terminalEventHash"]) } : {}),
    refs: eventRefs,
  }) : undefined;
  const metadata = redactProjectionValue({ formatVersion: payload.formatVersion, operation, status }, redaction);
  const identity: Omit<WorkflowTelemetryEvent, "eventHash"> = {
    schemaVersion: WORKFLOW_TELEMETRY_SCHEMA_VERSION,
    streamId: workflowTelemetryStreamId(source.projectId, source.sessionId),
    eventId: source.eventId,
    eventType: source.type,
    timestamp: source.timestamp,
    producer: source.producer,
    sequence: source.sequence,
    previousHash: source.previousHash,
    payloadHash: source.payloadHash,
    sourceEventHash: source.eventHash,
    ...(source.correlationId ? { correlationId: source.correlationId } : {}),
    dimensions: dimensions(source, payload, context),
    ...(status ? { status } : {}), ...(operation ? { operation } : {}), ...(summary ? { summary } : {}),
    refs: eventRefs,
    ...(usage(payload) ? { usage: usage(payload) } : {}),
    ...(metrics(payload) ? { metrics: metrics(payload) } : {}),
    ...(terminal ? { terminal } : {}),
    metadata,
  };
  const result = { ...identity, eventHash: projectionHash(identity) } as TrustedWorkflowTelemetryEvent;
  Object.defineProperty(result, TRUSTED_WORKFLOW_TELEMETRY_EVENT, { value: true, enumerable: false, writable: false });
  return Object.freeze(result);
}
