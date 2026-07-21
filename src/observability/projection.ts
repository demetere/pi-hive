import { createHash } from "node:crypto";
import { readWorkflowJournal } from "../workflows/journal";
import { toWorkflowTelemetryEvent, verifyWorkflowTelemetryEvent, type WorkflowTelemetryContext, type WorkflowTelemetryDimensions, type WorkflowTelemetryEvent, type WorkflowTelemetryUsage } from "./events";

export const WORKFLOW_PROJECTION_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_PROJECTION_PAGE_LIMIT = 500;
/** Safe internal replay ceiling; public history/current output remains capped at 500 rows. */
export const WORKFLOW_PROJECTION_IN_MEMORY_EVENT_LIMIT = 100_000;
export const WORKFLOW_PROJECTION_QUERY_BYTES = 8_192;
export const WORKFLOW_PROJECTION_VALUE_BYTES = 1_024;

export interface ProjectionStreamStatus {
  readonly streamId: string;
  readonly state: "ready" | "blocked";
  readonly lastSequence: number;
  readonly lastHash: string | null;
  readonly diagnostic?: string;
}

export interface WorkflowProjectionCurrentRow extends WorkflowTelemetryDimensions {
  readonly eventId: string;
  readonly eventType: string;
  readonly timestamp: string;
  readonly sequence: number;
  readonly status?: string;
  readonly operation?: string;
}

export interface WorkflowProjectionCurrent {
  readonly sessions: readonly WorkflowProjectionCurrentRow[];
  readonly runs: readonly WorkflowProjectionCurrentRow[];
  readonly nodes: readonly WorkflowProjectionCurrentRow[];
  readonly tasks: readonly WorkflowProjectionCurrentRow[];
  readonly workspaces: readonly WorkflowProjectionCurrentRow[];
  readonly questions: readonly WorkflowProjectionCurrentRow[];
  readonly approvals: readonly WorkflowProjectionCurrentRow[];
  readonly knowledge: readonly WorkflowProjectionCurrentRow[];
}

export interface WorkflowProjectionUsageTotals {
  readonly estimated: Readonly<{ inputTokens: number; outputTokens: number; costMicroUsd: number }>;
  readonly providerConfirmed: Readonly<{ inputTokens: number; outputTokens: number; costMicroUsd: number }>;
}

export interface WorkflowHistoryQuery {
  readonly limit: number;
  readonly cursor?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly workflowId?: string;
  readonly runId?: string;
  readonly nodeId?: string;
  readonly taskId?: string;
  readonly eventType?: string;
}

export interface WorkflowHistoryPage {
  readonly items: readonly WorkflowTelemetryEvent[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export interface WorkflowCurrentPageQuery {
  readonly kind: keyof WorkflowProjectionCurrent;
  readonly limit: number;
  readonly cursor?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly workflowId?: string;
  readonly runId?: string;
  readonly nodeId?: string;
  readonly taskId?: string;
  readonly status?: string;
}
export interface WorkflowCurrentPage { readonly items: readonly WorkflowProjectionCurrentRow[]; readonly nextCursor?: string; readonly hasMore: boolean }
export interface WorkflowUsageQuery {
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly workflowId?: string;
  readonly runId?: string;
  readonly nodeId?: string;
}

export class ProjectionStreamError extends Error {
  readonly streamId: string;
  constructor(streamId: string, message: string) {
    super(`Workflow projection stream ${streamId} ${message}`);
    this.name = "ProjectionStreamError";
    this.streamId = streamId;
  }
}

interface MutableStream {
  state: "ready" | "blocked";
  lastSequence: number;
  lastHash: string | null;
  diagnostic?: string;
}

type CurrentKind = keyof WorkflowProjectionCurrent;

function compareEvents(a: WorkflowTelemetryEvent, b: WorkflowTelemetryEvent): number {
  return a.timestamp.localeCompare(b.timestamp) || a.streamId.localeCompare(b.streamId) || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId);
}

type CurrentCursorKey = readonly [string, string, string, string, string];

function currentEntityId(row: WorkflowProjectionCurrentRow): string {
  return String(row.nodeId ?? row.taskId ?? row.questionId ?? row.approvalId ?? row.knowledgeJobId ?? row.knowledgeUpdateId ?? row.workspaceId ?? "");
}

function currentCursorKey(row: WorkflowProjectionCurrentRow, entityKey: string): CurrentCursorKey {
  return [row.projectId, row.sessionId, String(row.runId ?? ""), currentEntityId(row), entityKey];
}

function framedUtf8OrderKey(parts: CurrentCursorKey): string {
  return parts.map((part) => `${Buffer.from(part, "utf8").toString("hex")}!`).join("");
}

/** ASCII key whose lexical order is the framed UTF-8 byte order of every current identity component. */
export function workflowProjectionCurrentOrderKey(row: WorkflowProjectionCurrentRow, entityKey: string): string {
  return framedUtf8OrderKey(currentCursorKey(row, entityKey));
}

function cursorKey(event: WorkflowTelemetryEvent): readonly [string, string, number, string] {
  return [event.timestamp, event.streamId, event.sequence, event.eventId];
}

function strictBase64Url(value: string, label: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`${label} cursor is invalid`);
  const bytes = Buffer.from(value, "base64url");
  if (!bytes.length || bytes.toString("base64url") !== value) throw new Error(`${label} cursor is invalid`);
  return bytes;
}

export function encodeWorkflowHistoryCursor(event: WorkflowTelemetryEvent): string {
  return Buffer.from(JSON.stringify(cursorKey(event)), "utf8").toString("base64url");
}

export function decodeWorkflowHistoryCursor(value: string): readonly [string, string, number, string] {
  try {
    const parsed: unknown = JSON.parse(strictBase64Url(value, "Workflow history").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 4 || typeof parsed[0] !== "string" || !Number.isFinite(Date.parse(parsed[0]))
      || typeof parsed[1] !== "string" || !/^wfs1-[0-9a-f]{64}$/u.test(parsed[1])
      || !Number.isSafeInteger(parsed[2]) || parsed[2] < 1 || typeof parsed[3] !== "string" || !parsed[3]) throw new Error();
    return parsed as [string, string, number, string];
  } catch {
    throw new Error("Workflow history cursor is invalid");
  }
}

export function encodeWorkflowCurrentCursor(row: WorkflowProjectionCurrentRow, entityKey: string): string {
  return Buffer.from(JSON.stringify(currentCursorKey(row, entityKey)), "utf8").toString("base64url");
}

export function decodeWorkflowCurrentCursor(value: string): CurrentCursorKey {
  try {
    const parsed: unknown = JSON.parse(strictBase64Url(value, "Workflow current").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 5 || parsed.some((entry) => typeof entry !== "string")
      || !/^(?:wfs1|wfe1)-[0-9a-f]{64}$/u.test(parsed[4])
      || parsed.reduce((sum, entry) => sum + Buffer.byteLength(entry, "utf8"), 0) > WORKFLOW_PROJECTION_QUERY_BYTES) throw new Error();
    return parsed as [string, string, string, string, string];
  } catch { throw new Error("Workflow current cursor is invalid"); }
}

export function workflowProjectionCurrentCursorOrderKey(value: string): string {
  return framedUtf8OrderKey(decodeWorkflowCurrentCursor(value));
}

function compareKey(event: WorkflowTelemetryEvent, key: readonly [string, string, number, string]): number {
  return event.timestamp.localeCompare(key[0]) || event.streamId.localeCompare(key[1]) || event.sequence - key[2] || event.eventId.localeCompare(key[3]);
}

function derivedStatus(event: WorkflowTelemetryEvent): string | undefined {
  if (event.terminal?.status) return event.terminal.status;
  if (event.status) return event.status;
  if (event.eventType === "run.started" || event.eventType === "task.started") return "running";
  if (event.eventType === "question.transition" && event.operation === "create") return "pending";
  return undefined;
}

function row(event: WorkflowTelemetryEvent, existing?: WorkflowProjectionCurrentRow, includeStatus = true): WorkflowProjectionCurrentRow {
  const status = includeStatus ? derivedStatus(event) : undefined;
  return Object.freeze({
    ...(existing ?? {}), ...event.dimensions,
    eventId: event.eventId,
    eventType: event.eventType,
    timestamp: event.timestamp,
    sequence: event.sequence,
    ...(status ? { status } : {}),
    ...(event.operation ? { operation: event.operation } : {}),
  });
}

function authoritativeFor(kind: CurrentKind, event: WorkflowTelemetryEvent): boolean {
  if (kind === "sessions") return event.eventType.startsWith("session.") || event.eventType === "run.started";
  if (kind === "runs") return event.eventType.startsWith("run.") || event.eventType === "terminal.recorded";
  if (kind === "nodes") return event.eventType === "run.started" || event.eventType.startsWith("task.");
  if (kind === "tasks") return event.eventType.startsWith("task.");
  if (kind === "workspaces") return event.eventType === "artifact.recorded";
  if (kind === "questions") return event.eventType === "question.transition";
  if (kind === "approvals") return event.eventType === "approval.recorded";
  return event.eventType === "knowledge.transition";
}

function validateQueryValues(query: WorkflowHistoryQuery): void {
  const values = [query.cursor, query.projectId, query.sessionId, query.workflowId, query.runId, query.nodeId, query.taskId, query.eventType].filter((value): value is string => value !== undefined);
  if (values.some((value) => Buffer.byteLength(value, "utf8") > WORKFLOW_PROJECTION_VALUE_BYTES)
    || values.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0) > WORKFLOW_PROJECTION_QUERY_BYTES) throw new Error("Workflow projection query exceeds its byte limit");
}

function framedEntityKey(parts: readonly string[]): string {
  const hash = createHash("sha256").update("pi-hive-workflow-entity-key-v1\0");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length).update(bytes);
  }
  return `wfe1-${hash.digest("hex")}`;
}

export function workflowProjectionCurrentKey(kind: CurrentKind, event: WorkflowTelemetryEvent): string | undefined {
  const d = event.dimensions;
  switch (kind) {
    case "sessions": return event.streamId;
    case "runs": return d.runId ? framedEntityKey([event.streamId, d.runId]) : undefined;
    case "nodes": return d.nodeId ? framedEntityKey([event.streamId, d.runId ?? "", d.nodeId]) : undefined;
    case "tasks": return d.taskId ? framedEntityKey([event.streamId, d.runId ?? "", d.taskId]) : undefined;
    case "workspaces": return d.workspaceId ? framedEntityKey([event.streamId, d.runId ?? "", d.workspaceId]) : undefined;
    case "questions": return d.questionId ? framedEntityKey([event.streamId, d.runId ?? "", d.questionId]) : undefined;
    case "approvals": return d.approvalId ? framedEntityKey([event.streamId, d.runId ?? "", d.approvalId]) : undefined;
    case "knowledge": {
      const id = d.knowledgeJobId ?? d.knowledgeUpdateId;
      return id ? framedEntityKey([event.streamId, d.runId ?? "", id]) : undefined;
    }
  }
}

function safeTotal(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Workflow projection usage total exceeds its safe magnitude");
  return total;
}

function usageBucket(input: WorkflowTelemetryUsage, totals: WorkflowProjectionUsageTotals): void {
  const key = input.precision === "provider-confirmed" ? "providerConfirmed" : "estimated";
  const bucket = totals[key] as { inputTokens: number; outputTokens: number; costMicroUsd: number };
  bucket.inputTokens = safeTotal(bucket.inputTokens, input.inputTokens);
  bucket.outputTokens = safeTotal(bucket.outputTokens, input.outputTokens);
  bucket.costMicroUsd = safeTotal(bucket.costMicroUsd, input.costMicroUsd);
}

export class WorkflowTelemetryProjection {
  private events: WorkflowTelemetryEvent[] = [];
  private readonly eventLimit: number;
  private readonly eventHashes = new Map<string, string>();
  private readonly streams = new Map<string, MutableStream>();
  private readonly materialized: Record<CurrentKind, Map<string, WorkflowProjectionCurrentRow>> = {
    sessions: new Map(), runs: new Map(), nodes: new Map(), tasks: new Map(), workspaces: new Map(),
    questions: new Map(), approvals: new Map(), knowledge: new Map(),
  };
  private readonly totals: WorkflowProjectionUsageTotals = {
    estimated: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
    providerConfirmed: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
  };

  constructor(options: Readonly<{ eventLimit?: number }> = {}) {
    const limit = options.eventLimit ?? WORKFLOW_PROJECTION_IN_MEMORY_EVENT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKFLOW_PROJECTION_IN_MEMORY_EVENT_LIMIT) throw new Error("Workflow in-memory projection event limit is invalid");
    this.eventLimit = limit;
  }

  ingest(event: WorkflowTelemetryEvent): "inserted" | "duplicate" {
    verifyWorkflowTelemetryEvent(event);
    const stream = this.streams.get(event.streamId) ?? { state: "ready" as const, lastSequence: 0, lastHash: null };
    const duplicateHash = this.eventHashes.get(event.eventId);
    if (duplicateHash !== undefined) {
      if (duplicateHash === event.eventHash) return "duplicate";
      return this.block(event.streamId, stream, "reused an event ID with a different hash");
    }
    if (stream.state === "blocked") throw new ProjectionStreamError(event.streamId, `is blocked: ${stream.diagnostic ?? "integrity failure"}`);
    if (this.events.length >= this.eventLimit) throw new Error("Workflow in-memory projection event limit exceeded");
    const expectedSequence = stream.lastSequence + 1;
    if (event.sequence !== expectedSequence) return this.block(event.streamId, stream, `sequence gap: expected ${expectedSequence}, received ${event.sequence}`);
    if (event.previousHash !== stream.lastHash) return this.block(event.streamId, stream, "previous hash mismatch");

    this.eventHashes.set(event.eventId, event.eventHash);
    this.events.push(event);
    stream.lastSequence = event.sequence;
    stream.lastHash = event.sourceEventHash;
    this.streams.set(event.streamId, stream);
    for (const kind of Object.keys(this.materialized) as CurrentKind[]) {
      const key = workflowProjectionCurrentKey(kind, event);
      if (key && authoritativeFor(kind, event)) this.materialized[kind].set(key, row(event, this.materialized[kind].get(key), kind !== "sessions" || event.eventType.startsWith("session.")));
    }
    if (event.usage) usageBucket(event.usage, this.totals);
    return "inserted";
  }

  private block(streamId: string, stream: MutableStream, diagnostic: string): never {
    stream.state = "blocked";
    stream.diagnostic = diagnostic.slice(0, 2_048);
    this.streams.set(streamId, stream);
    throw new ProjectionStreamError(streamId, diagnostic);
  }

  streamStatus(streamId: string): ProjectionStreamStatus {
    const stream = this.streams.get(streamId) ?? { state: "ready" as const, lastSequence: 0, lastHash: null };
    return Object.freeze({ streamId, state: stream.state, lastSequence: stream.lastSequence, lastHash: stream.lastHash, ...(stream.diagnostic ? { diagnostic: stream.diagnostic } : {}) });
  }

  current(): WorkflowProjectionCurrent {
    const output = {} as Record<CurrentKind, readonly WorkflowProjectionCurrentRow[]>;
    for (const kind of Object.keys(this.materialized) as CurrentKind[]) output[kind] = this.currentPage({ kind, limit: WORKFLOW_PROJECTION_PAGE_LIMIT }).items;
    return Object.freeze(output) as unknown as WorkflowProjectionCurrent;
  }

  currentPage(query: WorkflowCurrentPageQuery): WorkflowCurrentPage {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > WORKFLOW_PROJECTION_PAGE_LIMIT) throw new Error(`Workflow current limit must be 1..${WORKFLOW_PROJECTION_PAGE_LIMIT}`);
    if (!(query.kind in this.materialized)) throw new Error("Workflow current kind is invalid");
    const values = [query.cursor, query.projectId, query.sessionId, query.workflowId, query.runId, query.nodeId, query.taskId, query.status].filter((value): value is string => value !== undefined);
    if (values.some((value) => Buffer.byteLength(value, "utf8") > WORKFLOW_PROJECTION_VALUE_BYTES) || values.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0) > WORKFLOW_PROJECTION_QUERY_BYTES) throw new Error("Workflow current query exceeds its byte limit");
    const cursorOrder = query.cursor ? workflowProjectionCurrentCursorOrderKey(query.cursor) : undefined;
    const entries = [...this.materialized[query.kind]].map(([key, value]) => ({ key, value, order: workflowProjectionCurrentOrderKey(value, key) }))
      .sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : 0)
      .filter((entry) => (!cursorOrder || entry.order > cursorOrder)
        && (!query.projectId || entry.value.projectId === query.projectId)
        && (!query.sessionId || entry.value.sessionId === query.sessionId)
        && (!query.workflowId || entry.value.workflowId === query.workflowId)
        && (!query.runId || entry.value.runId === query.runId)
        && (!query.nodeId || entry.value.nodeId === query.nodeId)
        && (!query.taskId || entry.value.taskId === query.taskId)
        && (!query.status || entry.value.status === query.status));
    const selected = entries.slice(0, query.limit + 1);
    const hasMore = selected.length > query.limit;
    const page = selected.slice(0, query.limit);
    return Object.freeze({ items: Object.freeze(page.map((entry) => entry.value)), ...(hasMore && page.length ? { nextCursor: encodeWorkflowCurrentCursor(page.at(-1)!.value, page.at(-1)!.key) } : {}), hasMore });
  }

  usage(query: WorkflowUsageQuery = {}): WorkflowProjectionUsageTotals {
    const values = Object.values(query).filter((value): value is string => value !== undefined);
    if (values.some((value) => Buffer.byteLength(value, "utf8") > WORKFLOW_PROJECTION_VALUE_BYTES) || values.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0) > WORKFLOW_PROJECTION_QUERY_BYTES) throw new Error("Workflow usage query exceeds its byte limit");
    if (!values.length) return structuredClone(this.totals);
    const output: WorkflowProjectionUsageTotals = { estimated: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 }, providerConfirmed: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 } };
    for (const event of this.events) {
      const d = event.dimensions;
      if (event.usage && (!query.projectId || d.projectId === query.projectId) && (!query.sessionId || d.sessionId === query.sessionId)
        && (!query.workflowId || d.workflowId === query.workflowId) && (!query.runId || d.runId === query.runId) && (!query.nodeId || d.nodeId === query.nodeId)) usageBucket(event.usage, output);
    }
    return output;
  }

  history(query: WorkflowHistoryQuery): WorkflowHistoryPage {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > WORKFLOW_PROJECTION_PAGE_LIMIT) throw new Error(`Workflow history limit must be 1..${WORKFLOW_PROJECTION_PAGE_LIMIT}`);
    validateQueryValues(query);
    const cursor = query.cursor ? decodeWorkflowHistoryCursor(query.cursor) : undefined;
    const filtered = this.events.filter((event) => {
      const d = event.dimensions;
      return (!cursor || compareKey(event, cursor) > 0)
        && (!query.projectId || d.projectId === query.projectId)
        && (!query.sessionId || d.sessionId === query.sessionId)
        && (!query.workflowId || d.workflowId === query.workflowId)
        && (!query.runId || d.runId === query.runId)
        && (!query.nodeId || d.nodeId === query.nodeId)
        && (!query.taskId || d.taskId === query.taskId)
        && (!query.eventType || event.eventType === query.eventType);
    }).sort(compareEvents);
    const items = filtered.slice(0, query.limit);
    const hasMore = filtered.length > items.length;
    return Object.freeze({ items: Object.freeze(items), ...(hasMore && items.length ? { nextCursor: encodeWorkflowHistoryCursor(items.at(-1)!) } : {}), hasMore });
  }

  pruneProjection(cutoffIso: string): Readonly<{ removed: number; retained: number }> {
    const cutoffMs = Date.parse(cutoffIso);
    if (!Number.isFinite(cutoffMs)) throw new Error("Projection prune cutoff is invalid");
    const before = this.events.length;
    const removableIds = new Set<string>();
    const stoppedStreams = new Set<string>();
    for (const event of [...this.events].sort((a, b) => a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : a.sequence - b.sequence)) {
      if (stoppedStreams.has(event.streamId)) continue;
      if (Date.parse(event.timestamp) < cutoffMs) removableIds.add(event.eventId);
      else stoppedStreams.add(event.streamId);
    }
    this.events = this.events.filter((event) => !removableIds.has(event.eventId));
    // Event identities are an integrity boundary, not retained history. Keep them
    // permanently so a pruned ID can never acquire a different meaning later.
    for (const bucket of [this.totals.estimated, this.totals.providerConfirmed]) { (bucket as any).inputTokens = 0; (bucket as any).outputTokens = 0; (bucket as any).costMicroUsd = 0; }
    for (const event of this.events) if (event.usage) usageBucket(event.usage, this.totals);
    return Object.freeze({ removed: before - this.events.length, retained: this.events.length });
  }

  snapshot(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      schemaVersion: WORKFLOW_PROJECTION_SCHEMA_VERSION,
      streams: [...this.streams.keys()].sort().map((streamId) => this.streamStatus(streamId)),
      current: this.current(),
      history: this.history({ limit: Math.max(1, Math.min(WORKFLOW_PROJECTION_PAGE_LIMIT, this.events.length || 1)) }).items,
      usage: this.usage(),
    });
  }
}

export function rebuildWorkflowProjection(streams: readonly (readonly WorkflowTelemetryEvent[])[]): WorkflowTelemetryProjection {
  const projection = new WorkflowTelemetryProjection();
  const ordered = [...streams].map((events) => [...events].sort((a, b) => a.sequence - b.sequence))
    .sort((a, b) => String(a[0]?.streamId ?? "").localeCompare(String(b[0]?.streamId ?? "")));
  for (const events of ordered) for (const event of events) projection.ingest(event);
  return projection;
}

export interface WorkflowJournalProjectionRegistration {
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly context?: WorkflowTelemetryContext;
}

export function rebuildWorkflowProjectionFromJournals(registrations: readonly WorkflowJournalProjectionRegistration[]): WorkflowTelemetryProjection {
  const streams = [...registrations]
    .sort((a, b) => a.projectRoot.localeCompare(b.projectRoot) || a.sessionId.localeCompare(b.sessionId))
    .map((registration) => readWorkflowJournal(registration.projectRoot, registration.sessionId)
      .map((event) => toWorkflowTelemetryEvent(event, { projectRoot: registration.projectRoot, ...(registration.context ?? {}) })));
  return rebuildWorkflowProjection(streams);
}
