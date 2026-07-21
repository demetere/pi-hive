import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, opendirSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { CheckpointApprovalService } from "../../artifacts/approvals";
import type { CheckpointPolicy } from "../../artifacts/checkpoints";
import { hashArtifactWorkspace } from "../../artifacts/hashes";
import { BUILTIN_ARTIFACT_REGISTRY, type ResolvedArtifactProfile } from "../../artifacts/registry";
import type { ActivationSnapshotFileV1 } from "../../config/snapshot";
import { readActivationSnapshot } from "../../config/snapshot-store";
import { canonicalJson } from "../../config/snapshot-canonical";
import { KnowledgeProposalService } from "../../knowledge/proposals";
import { createWorkflowJournalPruneService } from "../journal-prune";
import { toWorkflowTelemetryEvent } from "../events";
import { encodeWorkflowHistoryCursor, type WorkflowCurrentPageQuery, type WorkflowHistoryQuery, type WorkflowUsageQuery } from "../projection";
import { QuestionService } from "../../workflows/questions";
import { WORKFLOW_EVENT_LIMITS, verifyWorkflowEvent, type WorkflowEventEnvelope } from "../../workflows/events";
import { listSessionLinks, type WorkflowSessionLink } from "../../workflows/sessions";
import { withCrossProcessFileLock } from "../../core/file-lock";
import { DAEMON_TOKEN, DB_PATH, PROJECT_CWD, REGISTRY_PATH, WORKFLOW_DB_PATH } from "./config";
import { openWorkflowProjectionDatabase, type WorkflowProjectionDatabase } from "./workflow-db";
import { readWorkflowProjectionRuntimeDiagnostics } from "./runtime";
import { closeWorkflowSubscribers, encoder, enqueueBounded, eventFrame, invalidateWorkflowSubscribers, registerSubscriber, removeSubscriber, SSE_BUFFER_BYTES, type WorkflowStreamLimits } from "./sse";
import type { WorkflowApiOptions, WorkflowControlApi, WorkflowProjectionApi } from "./workflow-routes";

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function finiteTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  return value;
}
interface SessionAuthority { readonly projectRoot: string; readonly projectId: string; readonly sessionId: string }

export const WORKFLOW_PROJECTION_REBUILD_LIMITS = Object.freeze({
  streams: 4_096,
  events: 262_144,
  bytes: 512 * 1_024 * 1_024,
  names: 270_336,
  pathBytes: 64 * 1_024 * 1_024,
});

export interface WorkflowProjectionRebuildLimits {
  readonly streams?: number;
  readonly events?: number;
  readonly bytes?: number;
  readonly names?: number;
  readonly pathBytes?: number;
}

export interface ProductionWorkflowServiceOptions {
  readonly token?: string;
  readonly databasePath?: string;
  readonly legacyPaths?: readonly string[];
  readonly projectCwd?: string;
  readonly diagnostics?: () => readonly unknown[];
  readonly rebuildLimits?: WorkflowProjectionRebuildLimits;
  readonly streamLimits?: WorkflowStreamLimits;
}

interface WorkflowJournalReference { readonly projectRoot: string; readonly sessionId: string; readonly journalPath: string; readonly link?: WorkflowSessionLink }
interface EffectiveRebuildLimits { readonly streams: number; readonly events: number; readonly bytes: number; readonly names: number; readonly pathBytes: number }
interface RebuildBudget { events: number; bytes: number; names: number; pathBytes: number }

function rebuildLimitError(message: string): Error {
  return Object.assign(new Error(message), { status: 413, code: "PROJECTION_REBUILD_LIMIT" });
}

function effectiveRebuildLimits(input: WorkflowProjectionRebuildLimits | undefined): EffectiveRebuildLimits {
  const limits = {
    streams: input?.streams ?? WORKFLOW_PROJECTION_REBUILD_LIMITS.streams,
    events: input?.events ?? WORKFLOW_PROJECTION_REBUILD_LIMITS.events,
    bytes: input?.bytes ?? WORKFLOW_PROJECTION_REBUILD_LIMITS.bytes,
    names: input?.names ?? WORKFLOW_PROJECTION_REBUILD_LIMITS.names,
    pathBytes: input?.pathBytes ?? WORKFLOW_PROJECTION_REBUILD_LIMITS.pathBytes,
  };
  for (const [name, value] of Object.entries(limits)) {
    const ceiling = WORKFLOW_PROJECTION_REBUILD_LIMITS[name as keyof EffectiveRebuildLimits];
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error(`Workflow projection rebuild ${name} limit is invalid`);
  }
  return Object.freeze(limits);
}

class ProductionWorkflowProjection implements WorkflowProjectionApi {
  private database?: WorkflowProjectionDatabase;
  private closed = false;
  constructor(private readonly options: Required<Pick<ProductionWorkflowServiceOptions, "databasePath" | "legacyPaths" | "projectCwd" | "diagnostics">> & Readonly<{ rebuildLimits: EffectiveRebuildLimits; streamLimits?: WorkflowStreamLimits }>) {}
  private db(): WorkflowProjectionDatabase {
    if (this.closed) throw new Error("Workflow projection service is closed");
    return this.database ??= openWorkflowProjectionDatabase({ path: this.options.databasePath, legacyPaths: this.options.legacyPaths });
  }
  currentPage(query: WorkflowCurrentPageQuery) { return this.db().currentPage(query); }
  resourcePage(resource: "projects" | "workflows", query: Omit<WorkflowCurrentPageQuery, "kind">) { return this.db().aggregateCurrentPage(resource, query); }
  history(query: WorkflowHistoryQuery) { return this.db().history(query); }
  usage(query: WorkflowUsageQuery) { return this.db().usage(query); }
  status() {
    const database = this.db();
    const rows = database.database.query(`SELECT stream_id FROM workflow_streams ORDER BY stream_id LIMIT 4097`).all() as Array<{ stream_id: string }>;
    if (rows.length > 4_096) throw new Error("Workflow projection stream status exceeds its bound");
    return Object.freeze({ streams: Object.freeze(rows.map((row) => database.streamStatus(row.stream_id))), diagnostics: this.options.diagnostics() });
  }
  stream(lastEventId?: string): Response {
    let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;
    const catchUpFromDatabase = (cursor: string) => this.db().streamCatchUp(cursor, 500);
    const streamLimits = this.options.streamLimits;
    const bufferBytes = streamLimits?.bufferBytes ?? SSE_BUFFER_BYTES;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        subscriber = controller;
        const catchUp = lastEventId === undefined ? undefined : catchUpFromDatabase(lastEventId);
        if (catchUp?.state === "resync-required") {
          controller.enqueue(encoder.encode(eventFrame("resync-required", { apiVersion: 1, reason: catchUp.reason, history: "/api/v1/history" })));
          controller.close();
          return;
        }
        // Avoid a live-event gap: compute the retained suffix and register in the
        // same synchronous turn, then enqueue the suffix before returning.
        const catchUpFrames = catchUp?.state === "ready"
          ? catchUp.events.map((event) => eventFrame("workflow", event, encodeWorkflowHistoryCursor(event))) : [];
        const encoded = [encoder.encode(eventFrame("hello", { apiVersion: 1, catchUp: "/api/v1/history" })), ...catchUpFrames.map((frame) => encoder.encode(frame))];
        if (encoded.reduce((sum, frame) => sum + frame.byteLength, 0) > bufferBytes) {
          controller.enqueue(encoder.encode(eventFrame("resync-required", { apiVersion: 1, reason: "catch-up-buffer-exceeded", history: "/api/v1/history" })));
          controller.close();
          return;
        }
        if (!registerSubscriber("workflow", controller, streamLimits)) {
          controller.enqueue(encoder.encode(eventFrame("resync-required", { apiVersion: 1, reason: "subscriber-capacity", history: "/api/v1/history" })));
          controller.close();
          return;
        }
        for (const frame of encoded) if (!enqueueBounded(controller, frame)) break;
      },
      cancel() { if (subscriber) removeSubscriber(subscriber); },
    }, { highWaterMark: bufferBytes, size(chunk) { return chunk?.byteLength ?? 0; } }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }
  runOperation<T>(scope: string, operationId: string, requestHash: string, invoke: () => T | Promise<T>): Promise<T> {
    return this.db().runOperation(scope, operationId, requestHash, invoke);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeWorkflowSubscribers();
    this.database?.close();
    this.database = undefined;
  }
  authority(projectId: string, sessionId: string): SessionAuthority {
    const rows = this.db().database.query(`SELECT project_id, session_id, project_root FROM workflow_streams WHERE project_id = ? AND session_id = ? LIMIT 2`).all(projectId, sessionId) as Array<{ project_id: string; session_id: string; project_root: string | null }>;
    if (rows.length !== 1 || !rows[0].project_root) throw new Error("Exact project/session object is missing from the workflow projection");
    return Object.freeze({ projectRoot: rows[0].project_root, projectId: rows[0].project_id, sessionId: rows[0].session_id });
  }
  private accountRebuildName(budget: RebuildBudget, name: string, path: string): void {
    budget.names += 1;
    budget.pathBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(path, "utf8");
    if (!Number.isSafeInteger(budget.pathBytes) || budget.names > this.options.rebuildLimits.names || budget.pathBytes > this.options.rebuildLimits.pathBytes) {
      throw rebuildLimitError("Workflow projection rebuild aggregate name or path-byte limit exceeded");
    }
  }

  private rebuildSources(): Readonly<{ references: readonly WorkflowJournalReference[]; events: number; bytes: number }> {
    const roots = new Set<string>([this.options.projectCwd]);
    for (const row of this.db().database.query(`SELECT DISTINCT project_root FROM workflow_streams WHERE project_root IS NOT NULL ORDER BY project_root LIMIT 4097`).all() as Array<{ project_root: string }>) roots.add(row.project_root);
    if (roots.size > WORKFLOW_PROJECTION_REBUILD_LIMITS.streams) throw rebuildLimitError("Workflow projection rebuild project limit exceeded");
    const references: WorkflowJournalReference[] = [];
    const budget: RebuildBudget = { events: 0, bytes: 0, names: 0, pathBytes: 0 };
    for (const projectRoot of [...roots].sort()) {
      const sessionsRoot = join(projectRoot, ".pi", "hive", "sessions");
      if (!existsSync(sessionsRoot)) continue;
      const rootStat = lstatSync(sessionsRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Workflow projection rebuild sessions root is invalid");
      const links = listSessionLinks(projectRoot).filter((entry): entry is WorkflowSessionLink => entry.kind === "workflow");
      const sessions = opendirSync(sessionsRoot);
      try {
        for (let entry = sessions.readSync(); entry; entry = sessions.readSync()) {
          const sessionId = entry.name;
          const sessionPath = join(sessionsRoot, sessionId);
          this.accountRebuildName(budget, sessionId, sessionPath);
          const stat = lstatSync(sessionPath);
          const journalPath = join(sessionPath, "journal");
          if (!stat.isDirectory() || stat.isSymbolicLink() || !existsSync(journalPath)) continue;
          if (references.length >= this.options.rebuildLimits.streams) throw rebuildLimitError("Workflow projection rebuild stream limit exceeded");
          const journalStat = lstatSync(journalPath);
          if (!journalStat.isDirectory() || journalStat.isSymbolicLink()) throw new Error("Workflow projection rebuild journal path is invalid");
          const journal = opendirSync(journalPath);
          try {
            for (let eventEntry = journal.readSync(); eventEntry; eventEntry = journal.readSync()) {
              const eventPath = join(journalPath, eventEntry.name);
              this.accountRebuildName(budget, eventEntry.name, eventPath);
              if (!eventEntry.name.endsWith(".json")) continue;
              const eventStat = lstatSync(eventPath);
              if (!eventStat.isFile() || eventStat.isSymbolicLink()) throw new Error("Workflow projection rebuild event path is invalid");
              budget.events += 1;
              budget.bytes += eventStat.size;
              if (!Number.isSafeInteger(budget.bytes) || budget.events > this.options.rebuildLimits.events || budget.bytes > this.options.rebuildLimits.bytes) {
                throw rebuildLimitError("Workflow projection rebuild aggregate event or byte limit exceeded");
              }
            }
          } finally { journal.closeSync(); }
          const matchingLinks = links.filter((link) => link.workflowSessionId === sessionId);
          if (matchingLinks.length > 1) throw new Error("Workflow projection rebuild session-link context is ambiguous");
          references.push(Object.freeze({ projectRoot, sessionId, journalPath, ...(matchingLinks[0] ? { link: matchingLinks[0] } : {}) }));
        }
      } finally { sessions.closeSync(); }
    }
    return Object.freeze({ references: Object.freeze(references), events: budget.events, bytes: budget.bytes });
  }

  private readRebuildJournal(reference: WorkflowJournalReference, budget: RebuildBudget): readonly WorkflowEventEnvelope[] {
    const names: string[] = [];
    const directory = opendirSync(reference.journalPath);
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        const path = join(reference.journalPath, entry.name);
        this.accountRebuildName(budget, entry.name, path);
        if (!entry.name.endsWith(".json")) continue;
        budget.events += 1;
        if (budget.events > this.options.rebuildLimits.events) throw rebuildLimitError("Workflow projection rebuild aggregate event limit changed during replay");
        names.push(entry.name);
      }
    } finally { directory.closeSync(); }
    names.sort();
    const output: WorkflowEventEnvelope[] = [];
    let previous: string | null = null;
    let projectId: string | undefined;
    for (const [index, name] of names.entries()) {
      const path = join(reference.journalPath, name);
      let descriptor: number | undefined;
      try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = fstatSync(descriptor, { bigint: true });
        const remaining = this.options.rebuildLimits.bytes - budget.bytes;
        if (!before.isFile() || before.size < 1n || before.size > BigInt(WORKFLOW_EVENT_LIMITS.eventBytes) || before.size > BigInt(remaining)) {
          if (before.size > BigInt(remaining)) throw rebuildLimitError("Workflow projection rebuild aggregate byte limit changed during replay");
          throw new Error("Workflow projection rebuild event size is invalid");
        }
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
          const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
          if (read < 1) throw new Error("Workflow projection rebuild event changed during read");
          offset += read;
        }
        const after = fstatSync(descriptor, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== after.size) throw new Error("Workflow projection rebuild event changed during read");
        budget.bytes += bytes.length;
        if (budget.bytes > this.options.rebuildLimits.bytes) throw rebuildLimitError("Workflow projection rebuild aggregate byte limit changed during replay");
        const event = JSON.parse(bytes.toString("utf8")) as WorkflowEventEnvelope;
        verifyWorkflowEvent(event);
        if (event.sequence !== index + 1 || event.previousHash !== previous || event.sessionId !== reference.sessionId || (projectId !== undefined && event.projectId !== projectId)
          || name !== `${String(event.sequence).padStart(16, "0")}-${event.eventHash}.json`) throw new Error("Workflow projection rebuild journal chain or identity is corrupt");
        previous = event.eventHash; projectId = event.projectId; output.push(event);
      } catch (error) {
        if ((error as { code?: unknown })?.code === "PROJECTION_REBUILD_LIMIT") throw error;
        throw new Error(`Workflow projection rebuild journal corruption: ${error instanceof Error ? error.message : String(error)}`);
      } finally { if (descriptor !== undefined) closeSync(descriptor); }
    }
    return Object.freeze(output);
  }

  rebuild(): Readonly<{ events: number; streams: number; diagnostics: readonly unknown[] }> {
    const database = this.db();
    const result = withCrossProcessFileLock(`${database.path}.projection`, () => {
      // Discovery uses bounded streaming iteration. Replay independently re-accounts
      // every name, event, and exact bytes read so concurrent growth cannot cross a limit.
      const sources = this.rebuildSources();
      const budget: RebuildBudget = { events: 0, bytes: 0, names: 0, pathBytes: 0 };
      return database.replaceProjectionAtomically(() => {
        let rebuiltStreams = 0;
        for (const reference of sources.references) {
          const source = this.readRebuildJournal(reference, budget);
          if (!source.length) continue;
          const link = reference.link;
          const context = {
            projectRoot: reference.projectRoot,
            projectLabel: basename(reference.projectRoot),
            ...(link ? {
              piSessionId: link.piSessionId,
              workflowId: link.workflowId,
              snapshotId: link.activationHash,
              workflowConfigHash: link.activationHash,
              workflowConfigVersion: String(link.formatVersion),
            } : {}),
          };
          const events = source.map((event) => toWorkflowTelemetryEvent(event, context));
          for (const event of events) database.ingest(event);
          rebuiltStreams += 1;
        }
        return Object.freeze({ events: budget.events, streams: rebuiltStreams, diagnostics: Object.freeze([]) });
      });
    }, { timeoutMs: 30_000, staleMs: 120_000 });
    invalidateWorkflowSubscribers("projection-rebuild");
    return result;
  }
  prune(cutoff: string) {
    const result = this.db().pruneProjection(cutoff);
    invalidateWorkflowSubscribers("projection-prune");
    return result;
  }
}

function selectedArtifact(snapshot: ActivationSnapshotFileV1): ResolvedArtifactProfile {
  const workflow = snapshot.payload.workflow as { artifact?: unknown };
  if (!record(workflow.artifact)) throw new Error("Activation snapshot has no artifact profile");
  const artifact = workflow.artifact;
  if (typeof artifact.contractVersion !== "string" || typeof artifact.adapter !== "string" || typeof artifact.adapterVersion !== "string"
    || typeof artifact.profile !== "string" || typeof artifact.profileVersion !== "string" || typeof artifact.optionsSchemaVersion !== "string"
    || artifact.viewVersion !== 1 || !Array.isArray(artifact.checkpoints) || !Array.isArray(artifact.actionIds)) throw new Error("Activation snapshot artifact selection is invalid");
  const resolved = BUILTIN_ARTIFACT_REGISTRY.resolveProfile({ contractVersion: artifact.contractVersion, adapterId: artifact.adapter, adapterVersion: artifact.adapterVersion, profileId: artifact.profile, profileVersion: artifact.profileVersion });
  if (resolved.profile.optionsSchemaVersion !== artifact.optionsSchemaVersion || resolved.profile.viewVersion !== artifact.viewVersion
    || canonicalJson(resolved.profile.checkpointIds) !== canonicalJson(artifact.checkpoints)
    || canonicalJson(resolved.profile.actions.map((action) => action.id)) !== canonicalJson(artifact.actionIds)) throw new Error("Activation snapshot artifact profile identity is incompatible");
  return resolved;
}
function checkpointPolicies(snapshot: ActivationSnapshotFileV1, selected: ResolvedArtifactProfile): Readonly<Record<string, CheckpointPolicy>> {
  const artifact = (snapshot.payload.workflow as { artifact?: unknown }).artifact;
  if (!record(artifact) || !record(artifact.approvals)) throw new Error("Activation snapshot checkpoint policies are invalid");
  const output: Record<string, CheckpointPolicy> = {};
  for (const checkpointId of selected.profile.checkpointIds) {
    const policy = artifact.approvals[checkpointId];
    if (policy !== "required" && policy !== "optional" && policy !== "none") throw new Error("Activation snapshot checkpoint policy is invalid");
    output[checkpointId] = policy;
  }
  if (Object.keys(artifact.approvals).some((checkpointId) => !selected.profile.checkpointIds.includes(checkpointId))) throw new Error("Activation snapshot checkpoint policy is unknown");
  return Object.freeze(output);
}
function snapshotFor(authority: SessionAuthority): ActivationSnapshotFileV1 {
  const links = listSessionLinks(authority.projectRoot).filter((entry): entry is import("../../workflows/sessions").WorkflowSessionLink => entry.kind === "workflow" && entry.workflowSessionId === authority.sessionId);
  if (links.length !== 1) throw new Error("Exact workflow session activation link is missing");
  return readActivationSnapshot(authority.projectRoot, links[0].activationHash);
}

class ProductionWorkflowControls implements WorkflowControlApi {
  constructor(private readonly projection: ProductionWorkflowProjection, private readonly token: string) {}
  private identity(credential: unknown): string | undefined { return credential === this.token ? "local-dashboard" : undefined; }
  readQuestion(input: Record<string, unknown>) {
    const authority = this.projection.authority(id(input.projectId, "projectId"), id(input.sessionId, "sessionId"));
    const runId = id(input.runId, "runId");
    const question = new QuestionService({ ...authority, runId, snapshot: snapshotFor(authority), authenticateControl: () => undefined }).restore().questions[id(input.questionId, "questionId")];
    if (!question || question.runId !== runId) throw new Error("Exact question object is missing");
    return question;
  }
  readCheckpoint(input: Record<string, unknown>) {
    const authority = this.projection.authority(id(input.projectId, "projectId"), id(input.sessionId, "sessionId"));
    const runId = id(input.runId, "runId");
    const snapshot = snapshotFor(authority);
    const selected = selectedArtifact(snapshot);
    const service = this.checkpointService(authority, snapshot, selected);
    const request = service.restore().requests[id(input.requestId, "requestId")];
    if (!request || request.runId !== runId) throw new Error("Exact approval request object is missing");
    return request;
  }
  readKnowledge(input: Record<string, unknown>) {
    const authority = this.projection.authority(id(input.projectId, "projectId"), id(input.sessionId, "sessionId"));
    return new KnowledgeProposalService({ ...authority, authenticateControl: () => undefined }).detail({ projectId: authority.projectId, sessionId: authority.sessionId, runId: id(input.runId, "runId"), proposalId: id(input.proposalId, "proposalId") });
  }
  answerQuestion(input: Record<string, unknown>) {
    const authority = this.projection.authority(id(input.projectId, "projectId"), id(input.sessionId, "sessionId"));
    const runId = id(input.runId, "runId");
    return new QuestionService({ ...authority, runId, snapshot: snapshotFor(authority), authenticateControl: (request) => this.identity(request.credential) }).answer(input as never);
  }
  private checkpointService(authority: SessionAuthority, snapshot: ActivationSnapshotFileV1, selected: ResolvedArtifactProfile): CheckpointApprovalService {
    return new CheckpointApprovalService({
      ...authority, adapterId: selected.adapter.id, adapterVersion: selected.adapter.version, profileId: selected.profile.id, profileVersion: selected.profile.version,
      profileSchemaVersion: selected.profile.optionsSchemaVersion, checkpointPolicies: checkpointPolicies(snapshot, selected),
      ...(selected.adapter.checkpointDescriptor ? { resolveDescriptor: ({ checkpointId, binding }: { checkpointId: string; binding: import("../../artifacts/types").ArtifactWorkspaceBinding }) => {
        if (!binding.path) throw new Error("Physical checkpoint descriptor requires a bound workspace path");
        return selected.adapter.checkpointDescriptor!({ binding, checkpointId, hashes: hashArtifactWorkspace(binding.path) });
      } } : {}),
      authenticateControl: ({ credential }) => this.identity(credential) ? { approverId: "local-dashboard", authenticationId: "daemon-token", mechanism: "bearer-csrf" } : undefined,
    });
  }
  async decideCheckpoint(input: Record<string, unknown>) {
    const authority = this.projection.authority(id(input.projectId, "projectId"), id(input.sessionId, "sessionId"));
    const runId = id(input.runId, "runId");
    const snapshot = snapshotFor(authority);
    const selected = selectedArtifact(snapshot);
    const service = this.checkpointService(authority, snapshot, selected);
    const { projectId: _projectId, sessionId: _sessionId, runId: _runId, credential, ...decision } = input;
    const current = service.restore().requests[id(input.requestId, "requestId")];
    if (!current || current.runId !== runId) throw new Error("Exact approval request object is missing");
    return service.decide(decision as never, { channel: "dashboard", mode: "headless", dashboardAvailable: true, credential });
  }
  decideKnowledge(input: Record<string, unknown>) {
    const authority = this.projection.authority(id(input.projectId, "projectId"), id(input.sessionId, "sessionId"));
    id(input.runId, "runId");
    return new KnowledgeProposalService({ ...authority, authenticateControl: (request) => this.identity(request.credential) }).decide(input as never);
  }
  rebuildProjection(_input: Record<string, unknown>) { return this.projection.rebuild(); }
  pruneProjection(input: Record<string, unknown>) { return this.projection.prune(finiteTimestamp(input.cutoff, "projection cutoff")); }
  pruneJournal(input: Record<string, unknown>) {
    const authority = this.projection.authority(id(input.projectId, "projectId"), id(input.sessionId, "sessionId"));
    return createWorkflowJournalPruneService({ authenticate: (credential) => this.identity(credential) }).prune({
      projectRoot: authority.projectRoot, sessionId: authority.sessionId, credential: String(input.credential ?? ""),
      operationId: id(input.operationId, "operationId"), confirmIrrecoverable: input.confirmIrrecoverable === true,
    });
  }
}

export function createProductionWorkflowApiOptions(options: ProductionWorkflowServiceOptions = {}): WorkflowApiOptions {
  const token = options.token ?? DAEMON_TOKEN;
  const projection = new ProductionWorkflowProjection({
    databasePath: options.databasePath ?? WORKFLOW_DB_PATH,
    legacyPaths: options.legacyPaths ?? [DB_PATH, REGISTRY_PATH],
    projectCwd: options.projectCwd ?? PROJECT_CWD,
    diagnostics: options.diagnostics ?? readWorkflowProjectionRuntimeDiagnostics,
    rebuildLimits: effectiveRebuildLimits(options.rebuildLimits),
    ...(options.streamLimits ? { streamLimits: options.streamLimits } : {}),
  });
  return Object.freeze({ token, projection, controls: new ProductionWorkflowControls(projection, token) });
}
