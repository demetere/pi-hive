import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfigProject } from "../../config/manifest";
import { readWorkflowJournal, readWorkflowJournalFrom, workflowJournalDirectory } from "../../workflows/journal";
import { toWorkflowTelemetryEvent, type WorkflowTelemetryEvent } from "../events";
import { WorkflowProjectionIntegrityError, openWorkflowProjectionDatabase } from "./workflow-db";

export interface SyncConfiguredWorkflowProjectionInput {
  readonly databasePath: string;
  readonly projectRoots: readonly string[];
  readonly legacyPaths?: readonly string[];
  readonly retentionDays?: number;
  readonly now?: () => Date;
}
export interface ConfiguredWorkflowProjectionSynchronizerOptions {
  readonly databasePath: string;
  readonly legacyPaths?: readonly string[];
  readonly retentionDays?: number;
  readonly now?: () => Date;
  readonly pruneIntervalMs?: number;
}
export interface WorkflowProjectionSyncDiagnostic { readonly projectRoot: string; readonly sessionId: string; readonly diagnostic: string }
export interface SyncConfiguredWorkflowProjectionResult { readonly active: boolean; readonly events: number; readonly streams: number; readonly diagnostics?: readonly WorkflowProjectionSyncDiagnostic[] }
export interface ConfiguredWorkflowProjectionSynchronizer {
  sync(projectRoots: readonly string[]): SyncConfiguredWorkflowProjectionResult;
  close(): void;
}

interface JournalReference { readonly projectRoot: string; readonly sessionId: string; readonly journalPath: string }
interface JournalFingerprint {
  readonly directory: string;
  readonly eventCount: number;
  /** Fixed-size digest of every committed event filename and metadata identity. */
  readonly identities: string;
  /** Digest of the current prefix corresponding to the prior fingerprint, when supplied. */
  readonly priorIdentities?: string;
}

export function workflowProjectionRootCandidates(projectCwd: string, discoveredRoots: readonly string[]): readonly string[] {
  return Object.freeze([...new Set([projectCwd, ...discoveredRoots].filter(Boolean))]);
}

function configuredRoots(inputs: readonly string[]): readonly string[] {
  const output = new Set<string>();
  for (const cwd of inputs) {
    if (!cwd || !existsSync(cwd)) continue;
    const project = loadConfigProject(cwd);
    if (project.status === "configured") output.add(project.projectRoot);
  }
  return [...output].sort();
}

function boundedDiagnostic(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 2_048);
}

function journalReferences(projectRoot: string): Readonly<{ references: JournalReference[]; diagnostics: WorkflowProjectionSyncDiagnostic[] }> {
  const sessionsRoot = join(projectRoot, ".pi", "hive", "sessions");
  if (!existsSync(sessionsRoot) || !lstatSync(sessionsRoot).isDirectory() || lstatSync(sessionsRoot).isSymbolicLink()) return { references: [], diagnostics: [] };
  const references: JournalReference[] = [];
  const diagnostics: WorkflowProjectionSyncDiagnostic[] = [];
  for (const sessionId of readdirSync(sessionsRoot).sort()) {
    try {
      const sessionPath = join(sessionsRoot, sessionId);
      const journalPath = workflowJournalDirectory(projectRoot, sessionId);
      if (!lstatSync(sessionPath).isDirectory() || lstatSync(sessionPath).isSymbolicLink() || !existsSync(journalPath)) continue;
      const journalStat = lstatSync(journalPath);
      if (!journalStat.isDirectory() || journalStat.isSymbolicLink()) throw new Error("Workflow journal path invalid");
      references.push(Object.freeze({ projectRoot, sessionId, journalPath }));
    } catch (error) {
      diagnostics.push(Object.freeze({ projectRoot, sessionId: sessionId.slice(0, 256), diagnostic: boundedDiagnostic(error) }));
    }
  }
  return { references, diagnostics };
}

function statIdentity(path: string): string {
  const value = statSync(path, { bigint: true });
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
}

function updateIdentity(hash: ReturnType<typeof createHash>, name: string, identity: string): void {
  hash.update(`${Buffer.byteLength(name, "utf8")}:`).update(name).update(`${Buffer.byteLength(identity, "utf8")}:`).update(identity);
}

function fingerprint(reference: JournalReference, prior?: JournalFingerprint): JournalFingerprint {
  const directory = statIdentity(reference.journalPath);
  const names = readdirSync(reference.journalPath).filter((name) => name.endsWith(".json")).sort();
  const identities = createHash("sha256").update("pi-hive-workflow-journal-metadata-v1\0");
  const priorIdentities = prior ? createHash("sha256").update("pi-hive-workflow-journal-metadata-v1\0") : undefined;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const identity = statIdentity(join(reference.journalPath, name));
    updateIdentity(identities, name, identity);
    if (priorIdentities && index < prior!.eventCount) updateIdentity(priorIdentities, name, identity);
  }
  return Object.freeze({
    directory,
    eventCount: names.length,
    identities: identities.digest("hex"),
    ...(priorIdentities ? { priorIdentities: priorIdentities.digest("hex") } : {}),
  });
}

function sameFingerprint(left: JournalFingerprint | undefined, right: JournalFingerprint): boolean {
  return left?.directory === right.directory && left.eventCount === right.eventCount && left.identities === right.identities;
}

function priorEventsUnchanged(prior: JournalFingerprint | undefined, current: JournalFingerprint): boolean {
  return !!prior && current.eventCount >= prior.eventCount && current.priorIdentities === prior.identities;
}

function telemetry(events: readonly import("../../workflows/events").WorkflowEventEnvelope[], reference: JournalReference): WorkflowTelemetryEvent[] {
  return events.map((event) => toWorkflowTelemetryEvent(event, {
    projectRoot: reference.projectRoot,
    projectLabel: basename(reference.projectRoot),
    workflowConfigVersion: "1",
  }));
}

class PersistentConfiguredWorkflowProjectionSynchronizer implements ConfiguredWorkflowProjectionSynchronizer {
  private projection?: ReturnType<typeof openWorkflowProjectionDatabase>;
  private readonly fingerprints = new Map<string, JournalFingerprint>();
  private initial = true;
  private closed = false;
  private lastPruneAt: number | undefined;

  constructor(private readonly options: ConfiguredWorkflowProjectionSynchronizerOptions) {
    if (options.retentionDays !== undefined && (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 1 || options.retentionDays > 3_650)) {
      throw new Error("Workflow projection retention days must be 1..3650");
    }
    if (options.pruneIntervalMs !== undefined && (!Number.isSafeInteger(options.pruneIntervalMs) || options.pruneIntervalMs < 1_000)) {
      throw new Error("Workflow projection prune interval is invalid");
    }
  }

  private openProjection(): ReturnType<typeof openWorkflowProjectionDatabase> {
    if (this.projection) return this.projection;
    try { this.projection = openWorkflowProjectionDatabase({ path: this.options.databasePath, legacyPaths: this.options.legacyPaths }); }
    catch (error) {
      if (!(error instanceof WorkflowProjectionIntegrityError)) throw error;
      for (const path of [this.options.databasePath, `${this.options.databasePath}-wal`, `${this.options.databasePath}-shm`]) rmSync(path, { force: true });
      this.projection = openWorkflowProjectionDatabase({ path: this.options.databasePath, legacyPaths: this.options.legacyPaths });
    }
    return this.projection;
  }

  private pruneIfDue(projection: ReturnType<typeof openWorkflowProjectionDatabase>): void {
    if (this.options.retentionDays === undefined) return;
    const now = (this.options.now ?? (() => new Date()))();
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new Error("Workflow projection retention clock is invalid");
    const interval = this.options.pruneIntervalMs ?? 60 * 60 * 1_000;
    if (this.lastPruneAt !== undefined && nowMs - this.lastPruneAt < interval) return;
    projection.pruneProjection(new Date(nowMs - this.options.retentionDays * 86_400_000).toISOString());
    this.lastPruneAt = nowMs;
  }

  sync(projectRoots: readonly string[]): SyncConfiguredWorkflowProjectionResult {
    if (this.closed) throw new Error("Workflow projection synchronizer is closed");
    const roots = configuredRoots(projectRoots);
    if (!roots.length) return Object.freeze({ active: false, events: 0, streams: 0 });
    const projection = this.openProjection();
    const discovered = roots.map(journalReferences);
    const references = discovered.flatMap((entry) => entry.references);
    const diagnostics = discovered.flatMap((entry) => entry.diagnostics);
    let processed = 0;

    if (this.initial) {
      const readable: Array<{ reference: JournalReference; events: WorkflowTelemetryEvent[] }> = [];
      for (const reference of references) {
        try {
          const before = fingerprint(reference);
          const events = telemetry(readWorkflowJournal(reference.projectRoot, reference.sessionId), reference);
          if (events.length) readable.push({ reference, events });
          const after = fingerprint(reference, before);
          if (sameFingerprint(before, after)) this.fingerprints.set(reference.journalPath, after);
        } catch (error) {
          const diagnostic = boundedDiagnostic(error);
          projection.markExistingStreamBlocked(reference.projectRoot, reference.sessionId, diagnostic);
          diagnostics.push(Object.freeze({ projectRoot: reference.projectRoot, sessionId: reference.sessionId, diagnostic }));
        }
      }
      readable.sort((left, right) => left.events[0].streamId.localeCompare(right.events[0].streamId));
      for (const { reference, events } of readable) {
        const existing = projection.existingStream(reference.projectRoot, reference.sessionId);
        if (existing?.status.state === "blocked") {
          diagnostics.push(Object.freeze({ projectRoot: reference.projectRoot, sessionId: reference.sessionId, diagnostic: existing.status.diagnostic ?? "Workflow projection stream is blocked" }));
          continue;
        }
        const boundary = existing?.status.lastSequence ? events[existing.status.lastSequence - 1] : undefined;
        if (existing && (existing.status.lastSequence > events.length || boundary?.sourceEventHash !== existing.status.lastHash)) {
          const diagnostic = "Workflow projection cursor differs from authoritative journal source";
          projection.markStreamBlocked(existing.streamId, existing.projectId, reference.sessionId, diagnostic, reference.projectRoot);
          diagnostics.push(Object.freeze({ projectRoot: reference.projectRoot, sessionId: reference.sessionId, diagnostic }));
          continue;
        }
        try {
          for (const event of events.slice(existing?.status.lastSequence ?? 0)) if (projection.ingest(event) === "inserted") processed += 1;
        } catch (error) {
          const diagnostic = boundedDiagnostic(error);
          diagnostics.push(Object.freeze({ projectRoot: reference.projectRoot, sessionId: reference.sessionId, diagnostic }));
        }
      }
      this.initial = false;
    } else {
      for (const reference of references) {
        const priorFingerprint = this.fingerprints.get(reference.journalPath);
        let currentFingerprint: JournalFingerprint;
        try { currentFingerprint = fingerprint(reference, priorFingerprint); }
        catch (error) {
          const diagnostic = boundedDiagnostic(error);
          projection.markExistingStreamBlocked(reference.projectRoot, reference.sessionId, diagnostic);
          diagnostics.push(Object.freeze({ projectRoot: reference.projectRoot, sessionId: reference.sessionId, diagnostic }));
          continue;
        }
        const existing = projection.existingStream(reference.projectRoot, reference.sessionId);
        if (sameFingerprint(priorFingerprint, currentFingerprint)) {
          if (existing?.status.state === "blocked") diagnostics.push(Object.freeze({ projectRoot: reference.projectRoot, sessionId: reference.sessionId, diagnostic: existing.status.diagnostic ?? "Workflow projection stream is blocked" }));
          continue;
        }
        try {
          const verifyAll = !!existing && !priorEventsUnchanged(priorFingerprint, currentFingerprint);
          const source = verifyAll || !existing
            ? readWorkflowJournal(reference.projectRoot, reference.sessionId)
            : readWorkflowJournalFrom(reference.projectRoot, reference.sessionId, { sequence: existing.status.lastSequence, hash: existing.status.lastHash, projectId: existing.projectId }, { verifyBoundary: true });
          const authoritative = telemetry(source, reference);
          if (verifyAll) projection.assertAuthoritativeEvents([authoritative]);
          const events = verifyAll && existing ? authoritative.slice(existing.status.lastSequence) : authoritative;
          if (existing?.status.state === "blocked") {
            diagnostics.push(Object.freeze({ projectRoot: reference.projectRoot, sessionId: reference.sessionId, diagnostic: existing.status.diagnostic ?? "Workflow projection stream is blocked" }));
          } else {
            for (const event of events) if (projection.ingest(event) === "inserted") processed += 1;
          }
          const after = fingerprint(reference, currentFingerprint);
          if (sameFingerprint(currentFingerprint, after)) this.fingerprints.set(reference.journalPath, after);
        } catch (error) {
          const diagnostic = boundedDiagnostic(error);
          projection.markExistingStreamBlocked(reference.projectRoot, reference.sessionId, diagnostic);
          diagnostics.push(Object.freeze({ projectRoot: reference.projectRoot, sessionId: reference.sessionId, diagnostic }));
          // Preserve the prior fingerprint so a repaired source is retried.
        }
      }
    }

    this.pruneIfDue(projection);
    return Object.freeze({ active: true, events: processed, streams: references.length, ...(diagnostics.length ? { diagnostics: Object.freeze(diagnostics.slice(0, 256)) } : {}) });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fingerprints.clear();
    this.projection?.close();
    this.projection = undefined;
  }
}

export function createConfiguredWorkflowProjectionSynchronizer(options: ConfiguredWorkflowProjectionSynchronizerOptions): ConfiguredWorkflowProjectionSynchronizer {
  return new PersistentConfiguredWorkflowProjectionSynchronizer(options);
}

/** One-shot compatibility helper. Production owns a persistent synchronizer. */
export function syncConfiguredWorkflowProjection(input: SyncConfiguredWorkflowProjectionInput): SyncConfiguredWorkflowProjectionResult {
  const synchronizer = createConfiguredWorkflowProjectionSynchronizer(input);
  try { return synchronizer.sync(input.projectRoots); }
  finally { synchronizer.close(); }
}
