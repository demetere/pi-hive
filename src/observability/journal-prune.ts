import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalJson } from "../config/snapshot-canonical";
import { withCrossProcessFileLock } from "../core/file-lock";
import { readWorkflowJournal, withWorkflowJournalTransaction, workflowJournalDirectory, workflowSessionDirectory } from "../workflows/journal";
import type { WorkflowEventEnvelope } from "../workflows/events";

export interface WorkflowJournalPrunePreview {
  readonly sessionId: string;
  readonly eventCount: number;
  readonly runIds: readonly string[];
  readonly firstTimestamp?: string;
  readonly lastTimestamp?: string;
  readonly warning: string;
}

export interface WorkflowJournalPruneRequest {
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly credential: string;
  readonly operationId: string;
  readonly confirmIrrecoverable: boolean;
}

export interface WorkflowJournalPruneAuthority {
  readonly authenticate: (credential: string) => string | undefined;
}

export type WorkflowJournalPruneFaultStage = "afterReceipt" | "afterDetach" | "duringCleanup";
export interface WorkflowJournalPruneServiceOptions extends WorkflowJournalPruneAuthority {
  readonly fault?: (stage: WorkflowJournalPruneFaultStage) => void;
}

type PruneResult = Readonly<WorkflowJournalPrunePreview & { deletedEvents: number; authenticatedIdentity: string }>;
type ReceiptStatus = "prepared" | "detached" | "completed";
interface JournalIdentity {
  readonly eventCount: number;
  readonly firstEventHash: string | null;
  readonly lastEventHash: string | null;
  readonly eventHashesHash: string;
  readonly contentHash: string;
}
interface PruneReceipt {
  readonly protocolVersion: 1;
  readonly status: ReceiptStatus;
  readonly journal: JournalIdentity;
  readonly result: PruneResult;
}

function latestRunTransition(events: readonly WorkflowEventEnvelope[], runId: string): WorkflowEventEnvelope | undefined {
  return events.filter((event) => event.runId === runId && (event.type === "terminal.recorded" || event.type === "run.started" || event.type === "run.transition"
    || event.type === "run.cancel.requested" || event.type === "run.cancel.settlement.failed" || event.type === "run.terminal.prepared")).at(-1);
}

function preview(events: readonly WorkflowEventEnvelope[], sessionId: string): WorkflowJournalPrunePreview {
  const missingRunIdentity = events.find((event) => (event.type.startsWith("run.") || event.type === "terminal.recorded") && !event.runId);
  if (missingRunIdentity) throw new Error(`Journal prune refuses lifecycle event ${missingRunIdentity.eventId} without run identity`);
  const runIds = [...new Set(events.flatMap((event) => event.runId ? [event.runId] : []))].sort();
  const open = runIds.filter((runId) => latestRunTransition(events, runId)?.type !== "terminal.recorded");
  if (open.length) throw new Error(`Journal prune refuses open/nonterminal runs: ${open.join(", ")}`);
  return Object.freeze({
    sessionId,
    eventCount: events.length,
    runIds: Object.freeze(runIds),
    ...(events[0] ? { firstTimestamp: events[0].timestamp, lastTimestamp: events.at(-1)!.timestamp } : {}),
    warning: "Deleting this authoritative journal is irrecoverable: run audit, recovery, approvals, questions, and projection rebuild history will be lost.",
  });
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function safeOperation(value: string): string {
  let unsafe = false;
  for (const character of value) if (character === "/" || character === "\\" || character.codePointAt(0)! <= 0x1f) unsafe = true;
  if (!value || Buffer.byteLength(value, "utf8") > 256 || unsafe) throw new Error("Journal prune operation ID is invalid");
  return createHash("sha256").update("pi-hive-journal-prune-operation-v1\0").update(value).digest("hex");
}

function exactRequest(value: WorkflowJournalPruneRequest): void {
  const allowed = new Set(["projectRoot", "sessionId", "credential", "operationId", "confirmIrrecoverable"]);
  if (!value || typeof value !== "object" || Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Journal prune request has an unknown field");
}

function journalIdentity(events: readonly WorkflowEventEnvelope[]): JournalIdentity {
  const eventHashes = createHash("sha256").update("pi-hive-journal-prune-event-hashes-v1\0");
  const content = createHash("sha256").update("pi-hive-journal-prune-content-v1\0");
  for (const event of events) {
    eventHashes.update(String(event.sequence)).update("\0").update(event.eventHash).update("\0");
    content.update(canonicalJson(event)).update("\n");
  }
  return Object.freeze({
    eventCount: events.length,
    firstEventHash: events[0]?.eventHash ?? null,
    lastEventHash: events.at(-1)?.eventHash ?? null,
    eventHashesHash: eventHashes.digest("hex"),
    contentHash: content.digest("hex"),
  });
}

function sameJournal(left: JournalIdentity, right: JournalIdentity): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function writeReceipt(path: string, receipt: PruneReceipt, sessionDirectory: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${canonicalJson(receipt)}\n`, { mode: 0o600, flag: "wx" });
  const fd = openSync(temporary, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  fsyncDirectory(sessionDirectory);
}

function validHash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }

function readReceipt(path: string, sessionId: string): PruneReceipt | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Journal prune receipt is invalid"); }
  const value = parsed as Partial<PruneReceipt>;
  const result = value?.result as PruneResult | undefined;
  const identity = value?.journal as JournalIdentity | undefined;
  if (value?.protocolVersion === 1 && (value.status === "prepared" || value.status === "detached" || value.status === "completed")
    && identity && Number.isSafeInteger(identity.eventCount) && identity.eventCount >= 0
    && (identity.firstEventHash === null || validHash(identity.firstEventHash)) && (identity.lastEventHash === null || validHash(identity.lastEventHash))
    && validHash(identity.eventHashesHash) && validHash(identity.contentHash)
    && result && result.sessionId === sessionId && result.eventCount === identity.eventCount && result.deletedEvents === identity.eventCount
    && typeof result.authenticatedIdentity === "string" && Array.isArray(result.runIds)) return value as PruneReceipt;
  // Receipts written before the state protocol are completed-only evidence. They
  // can satisfy an idempotent empty-journal retry, but can never select authority.
  const legacy = parsed as PruneResult;
  if (legacy && legacy.sessionId === sessionId && Number.isSafeInteger(legacy.deletedEvents) && legacy.deletedEvents >= 0 && typeof legacy.authenticatedIdentity === "string") return undefined;
  throw new Error("Journal prune receipt is invalid");
}

function regularJournalFiles(events: readonly WorkflowEventEnvelope[], journalDirectory: string): void {
  for (const event of events) {
    const name = `${String(event.sequence).padStart(16, "0")}-${event.eventHash}.json`;
    const stat = lstatSync(join(journalDirectory, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Journal prune refuses a non-regular event file");
  }
}

export function previewWorkflowJournalPrune(projectRoot: string, sessionId: string): WorkflowJournalPrunePreview {
  return preview(readWorkflowJournal(projectRoot, sessionId), sessionId);
}

export function createWorkflowJournalPruneService(options: WorkflowJournalPruneServiceOptions): Readonly<{ prune(request: WorkflowJournalPruneRequest): PruneResult }> {
  if (!options || typeof options.authenticate !== "function") throw new Error("Journal prune requires a trusted authentication authority");
  return Object.freeze({
    prune(request: WorkflowJournalPruneRequest): PruneResult {
      exactRequest(request);
      const authenticatedIdentity = options.authenticate(request.credential);
      if (!authenticatedIdentity || Buffer.byteLength(authenticatedIdentity, "utf8") > 512) throw new Error("Journal prune authentication failed");
      if (!request.confirmIrrecoverable) throw new Error("Journal prune requires explicit irrecoverability confirmation");
      const operationHash = safeOperation(request.operationId);
      const sessionDirectory = workflowSessionDirectory(request.projectRoot, request.sessionId);
      const journalDirectory = workflowJournalDirectory(request.projectRoot, request.sessionId);
      const detached = join(sessionDirectory, `.journal-pruned-${operationHash}`);
      const receiptPath = join(sessionDirectory, `.journal-prune-receipt-${operationHash}.json`);

      return withCrossProcessFileLock(join(sessionDirectory, ".journal-prune-session"), () => withWorkflowJournalTransaction(request.projectRoot, request.sessionId, (events) => {
        let authorityEvents = events;
        const recoveryNames = readdirSync(sessionDirectory).filter((name) => /^\.journal-prune-receipt-[0-9a-f]{64}\.json$/u.test(name) || /^\.journal-pruned-[0-9a-f]{64}$/u.test(name));
        if (recoveryNames.length > 128) throw new Error("Journal prune recovery artifact limit exceeded");
        const receiptNames = recoveryNames.filter((name) => name.startsWith(".journal-prune-receipt-")).sort();
        const detachedNames = new Set(recoveryNames.filter((name) => name.startsWith(".journal-pruned-")));
        for (const name of detachedNames) {
          const hash = name.slice(".journal-pruned-".length);
          if (!receiptNames.includes(`.journal-prune-receipt-${hash}.json`)) throw new Error("Journal prune detached authority lacks a durable receipt");
        }

        for (const name of receiptNames) {
          const hash = name.slice(".journal-prune-receipt-".length, -".json".length);
          const path = join(sessionDirectory, name);
          let receipt = readReceipt(path, request.sessionId);
          const recoveryDetached = join(sessionDirectory, `.journal-pruned-${hash}`);
          if (!receipt) {
            if (existsSync(recoveryDetached)) {
              options.fault?.("duringCleanup"); rmSync(recoveryDetached, { recursive: true, force: true }); fsyncDirectory(sessionDirectory);
            }
            continue;
          }
          if (receipt.status === "completed") {
            if (existsSync(recoveryDetached)) throw new Error("Journal prune completed receipt has a detached authority artifact");
            continue;
          }
          if (receipt.status === "prepared") {
            if (!existsSync(recoveryDetached)) {
              if (!sameJournal(receipt.journal, journalIdentity(authorityEvents))) throw new Error("Journal prune prepared receipt conflicts with authoritative journal identity");
              regularJournalFiles(authorityEvents, journalDirectory);
              renameSync(journalDirectory, recoveryDetached); fsyncDirectory(sessionDirectory);
              authorityEvents = [];
            }
            receipt = Object.freeze({ ...receipt, status: "detached" });
            writeReceipt(path, receipt, sessionDirectory);
          }
          if (receipt.status === "detached") {
            if (existsSync(recoveryDetached)) { options.fault?.("duringCleanup"); rmSync(recoveryDetached, { recursive: true, force: true }); fsyncDirectory(sessionDirectory); }
            writeReceipt(path, Object.freeze({ ...receipt, status: "completed" }), sessionDirectory);
          }
        }

        let prior: PruneReceipt | undefined;
        if (existsSync(receiptPath)) prior = readReceipt(receiptPath, request.sessionId);
        if (!prior && existsSync(receiptPath)) {
          const legacy = JSON.parse(readFileSync(receiptPath, "utf8")) as PruneResult;
          if (legacy.authenticatedIdentity !== authenticatedIdentity) throw new Error("Journal prune operation belongs to a different authenticated identity");
          if (!authorityEvents.length) return Object.freeze(legacy);
          throw new Error("Journal prune legacy completed receipt conflicts with current authoritative journal");
        }
        if (prior && prior.result.authenticatedIdentity !== authenticatedIdentity) throw new Error("Journal prune operation belongs to a different authenticated identity");
        if (prior) {
          if (!authorityEvents.length && prior.status === "completed") return Object.freeze(prior.result);
          throw new Error("Journal prune completed operation receipt conflicts with current authoritative journal");
        }

        const checked = preview(authorityEvents, request.sessionId);
        const result = Object.freeze({ ...checked, deletedEvents: authorityEvents.length, authenticatedIdentity });
        const identity = journalIdentity(authorityEvents);
        regularJournalFiles(authorityEvents, journalDirectory);
        let receipt: PruneReceipt = Object.freeze({ protocolVersion: 1, status: "prepared", journal: identity, result });
        writeReceipt(receiptPath, receipt, sessionDirectory); options.fault?.("afterReceipt");
        if (existsSync(detached)) throw new Error("Journal prune detached target unexpectedly exists");
        renameSync(journalDirectory, detached); fsyncDirectory(sessionDirectory);
        receipt = Object.freeze({ ...receipt, status: "detached" });
        writeReceipt(receiptPath, receipt, sessionDirectory); options.fault?.("afterDetach");
        options.fault?.("duringCleanup"); rmSync(detached, { recursive: true, force: true }); fsyncDirectory(sessionDirectory);
        writeReceipt(receiptPath, Object.freeze({ ...receipt, status: "completed" }), sessionDirectory);
        return result;
      }), { timeoutMs: 5_000, staleMs: 30_000 });
    },
  });
}
