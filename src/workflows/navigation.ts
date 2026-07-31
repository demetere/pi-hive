import { randomUUID } from "node:crypto";
import { acquireRuntimeOwnership, captureRuntimeOwnership, heartbeatRuntimeOwnership, settleRuntimeOwnershipRelease, type AcquireOwnershipOptions, type RuntimeOwner } from "./ownership";
import { appendWorkflowEvent, readWorkflowJournal, withWorkflowJournalTransaction } from "./journal";
import { createWorkflowEvent, type WorkflowEventEnvelope } from "./events";
import { commitWorkflowSelection, listSessionLinks, rollbackWorkflowSelection, workflowLinkGenerationHash, type NormalSessionLink, type WorkflowSessionLink } from "./sessions";
import { createEmptyRunLifecycleState, reduceRunLifecycle, terminalEnvelopeFromEvent } from "./runs";
import { replayWorkflowJournal } from "./replay";
import { clearStagedHandoff, createHandoffPacket, hasOpenRun, readHandoffState, restoreHandoffState, stageHandoff, verifyHandoffPacketSource, type HandoffPacket } from "./handoff";

export interface SelectableWorkflow { readonly workflowId: string; readonly activationHash: string; readonly source: "current" | "stale" | "missing" | "invalid"; readonly resumable: boolean; readonly freshEnabled: boolean; readonly model: string; readonly thinking: string; readonly tools: readonly string[] }
export interface CreatedNavigationSession { readonly piSessionId: string; readonly piSessionFile: string }
export interface CommittedNavigationGeneration { readonly workflowSessionId: string; readonly linkGenerationHash: string }
export class UnprovenSessionRestorationError extends AggregateError {
  readonly restorationProven = false as const;
  constructor(errors: readonly unknown[], message = "Workflow Pi session replacement failed and restoration could not be proven") { super(errors, message); this.name = "UnprovenSessionRestorationError"; }
}
export function isUnprovenSessionRestoration(error: unknown): error is UnprovenSessionRestorationError { return error instanceof UnprovenSessionRestorationError; }
export interface SessionReplacementExpectation {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly piSessionId: string;
  readonly restoreSession?: string;
  readonly generation: CommittedNavigationGeneration;
}
export interface SessionNavigationAdapter {
  /** Precreate and durably materialize a Pi session without replacing the active context. */
  create(input: { projectRoot: string; parentSession: string; name: string; workflowId: string; activationHash: string; recovery?: Readonly<{ workflowSessionId: string; previousPiSessionId: string; previousPiSessionFile: string }> }): Promise<CreatedNavigationSession>;
  /** Remove only the exact precreated session after durable workflow authority has rolled back. */
  cleanup?(input: { projectRoot: string; created: CreatedNavigationSession }): void | Promise<void>;
  switch(input: { piSessionFile: string; withSession: (ctx: unknown) => Promise<void> | void; replacement?: SessionReplacementExpectation }): Promise<{ cancelled: boolean }>;
}
interface ReloadSourceGuard { readonly workflowSessionId: string; readonly workflowId: string; readonly piSessionId: string; readonly activationHash: string; readonly eventCount: number; readonly lastEventHash: string | null; readonly stagedPacketHash?: string }
export interface SelectionInput { projectRoot: string; projectId: string; currentPiSessionId: string; workflow: SelectableWorkflow; fresh?: boolean; stagedHandoff?: HandoffPacket; adapter: SessionNavigationAdapter; owner: AcquireOwnershipOptions & { nonce: string }; /** Reload's second source-validation phase, run after Pi-session creation and immediately before the link CAS. */ beforeCommit?: () => void | Promise<void>; /** Internal reload CAS guard captured before asynchronous activation preparation. */ reloadGuard?: ReloadSourceGuard }
export type SelectionResult = Readonly<{ kind: "created" | "resumed"; link: WorkflowSessionLink }>;
function navigationInvariant(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function normalLink(root: string): NormalSessionLink { const normal = listSessionLinks(root).find((entry): entry is NormalSessionLink => entry.kind === "normal"); navigationInvariant(normal, "Canonical normal parent is missing"); return normal; }
interface NavigationOwnership { readonly state: "existing" | "acquired"; readonly generation: RuntimeOwner }
function own(root: string, id: string, owner: SelectionInput["owner"]): NavigationOwnership {
  try {
    if (heartbeatRuntimeOwnership(root, id, owner.nonce)) {
      const generation = captureRuntimeOwnership(root, id, owner.nonce);
      navigationInvariant(generation, "Runtime ownership changed after heartbeat");
      return Object.freeze({ state: "existing", generation });
    }
  } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const result = acquireRuntimeOwnership(root, id, owner);
  if (!result.ok || !result.owner) throw new Error(`Runtime ownership rejected: ${result.reason}`);
  return Object.freeze({ state: "acquired", generation: result.owner });
}
function event(root: string, projectId: string, sessionId: string, type: "session.created" | "session.linked" | "session.selected", payload: Record<string, string | boolean>): void { appendWorkflowEvent(root, createWorkflowEvent({ projectId, sessionId, type, payload, producer: "runtime" })); }
function reloadGuardFor(link: WorkflowSessionLink, events: readonly WorkflowEventEnvelope[], stagedPacketHash?: string): ReloadSourceGuard {
  return Object.freeze({ workflowSessionId: link.workflowSessionId, workflowId: link.workflowId, piSessionId: link.piSessionId, activationHash: link.activationHash, eventCount: events.length, lastEventHash: events.at(-1)?.eventHash ?? null, ...(stagedPacketHash ? { stagedPacketHash } : {}) });
}
function assertReloadGuard(projectRoot: string, guard: ReloadSourceGuard, events?: readonly WorkflowEventEnvelope[]): WorkflowSessionLink {
  const current = listSessionLinks(projectRoot).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.workflowId === guard.workflowId && entry.status === "current");
  navigationInvariant(current && current.workflowSessionId === guard.workflowSessionId && current.piSessionId === guard.piSessionId && current.activationHash === guard.activationHash, "Reload source session changed before compare-and-swap commit");
  const journal = events ?? readWorkflowJournal(projectRoot, guard.workflowSessionId);
  navigationInvariant(journal.length === guard.eventCount && (journal.at(-1)?.eventHash ?? null) === guard.lastEventHash && !hasOpenRun(journal), "Reload source run or journal changed before compare-and-swap commit");
  navigationInvariant(restoreHandoffState(journal).staged?.packetHash === guard.stagedPacketHash, "Reload source staged handoff changed before compare-and-swap commit");
  return current;
}
export async function selectWorkflowSession(input: SelectionInput): Promise<SelectionResult> {
  const normal = normalLink(input.projectRoot);
  navigationInvariant(normal.projectId === input.projectId, "Selection project identity does not match the canonical normal parent");
  const links = listSessionLinks(input.projectRoot); const current = links.find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.workflowId === input.workflow.workflowId && entry.status === "current");
  const packet = input.stagedHandoff ? verifyHandoffPacketSource(input.projectRoot, input.projectId, input.stagedHandoff) : undefined;
  if (input.reloadGuard) assertReloadGuard(input.projectRoot, input.reloadGuard);
  navigationInvariant(packet?.source.workflowId !== input.workflow.workflowId, "Handoff target must be a different workflow");
  if (packet && current) {
    const currentEvents = readWorkflowJournal(input.projectRoot, current.workflowSessionId);
    navigationInvariant(!hasOpenRun(currentEvents), "Existing target workflow session has an open run");
    const staged = readHandoffState(input.projectRoot, current.workflowSessionId).staged;
    if (staged && staged.packetHash !== packet.packetHash) throw new Error("Target workflow session has a conflicting staged handoff");
  }
  if (!input.fresh && current) {
    if (!input.workflow.resumable || current.activationHash !== input.workflow.activationHash) throw new Error("Workflow activation is not resumable or compatible");
    const ownership = own(input.projectRoot, current.workflowSessionId, input.owner);
    let staged: ReturnType<typeof stageHandoff> | undefined;
    try {
      staged = packet ? stageHandoff({ projectRoot: input.projectRoot, projectId: input.projectId, targetSessionId: current.workflowSessionId, targetWorkflowId: current.workflowId, packet }) : undefined;
      const result = await input.adapter.switch({ piSessionFile: current.piSessionFile, withSession: async () => {} });
      if (result.cancelled) throw new Error("Session switch cancelled");
    } catch (error) {
      if (isUnprovenSessionRestoration(error)) throw error;
      if (ownership.state === "acquired") settleRuntimeOwnershipRelease(input.projectRoot, current.workflowSessionId, ownership.generation);
      if (staged?.staged) clearStagedHandoff({ projectRoot: input.projectRoot, projectId: input.projectId, targetSessionId: current.workflowSessionId, expectedPacketHash: packet!.packetHash });
      throw error;
    }
    event(input.projectRoot, input.projectId, current.workflowSessionId, "session.selected", { resumed: true }); return Object.freeze({ kind: "resumed", link: current });
  }
  if (input.workflow.source !== "current" || !input.workflow.freshEnabled) throw new Error("Fresh selection blocked by invalid or stale source");
  const previousOwnership = current ? own(input.projectRoot, current.workflowSessionId, input.owner) : undefined;
  const workflowSessionId = `workflow-${randomUUID()}`;
  const replacementOwnership = own(input.projectRoot, workflowSessionId, input.owner);
  let link: WorkflowSessionLink | undefined;
  let staged: ReturnType<typeof stageHandoff> | undefined;
  let created: CreatedNavigationSession | undefined;
  const restoreSession = links.find((entry) => entry.piSessionId === input.currentPiSessionId)?.piSessionFile;
  const commitCreated = async (candidate: CreatedNavigationSession): Promise<void> => {
    if (created && (created.piSessionId !== candidate.piSessionId || created.piSessionFile !== candidate.piSessionFile)) throw new Error("Workflow Pi session identity changed before commit");
    created = candidate;
    if (link) return;
    const now = new Date().toISOString();
    const next: WorkflowSessionLink = Object.freeze({ kind: "workflow", formatVersion: 1, workflowSessionId, workflowId: input.workflow.workflowId, activationHash: input.workflow.activationHash, piSessionId: candidate.piSessionId, piSessionFile: candidate.piSessionFile, normalParentId: normal.piSessionId, normalParentFile: normal.piSessionFile, status: "current", stale: false, model: input.workflow.model, thinking: input.workflow.thinking, tools: [...new Set(input.workflow.tools)].sort(), createdAt: now, updatedAt: now, name: `hive:${input.workflow.workflowId}:${input.workflow.activationHash.slice(0, 8)}` });
    const archived = current ? Object.freeze({ ...current, status: "archived" as const, name: `${current.name}:archived:${current.activationHash.slice(0, 8)}`, updatedAt: now }) : undefined;
    await input.beforeCommit?.();
    const commit = (): void => {
      if (packet) staged = stageHandoff({ projectRoot: input.projectRoot, projectId: input.projectId, targetSessionId: workflowSessionId, targetWorkflowId: input.workflow.workflowId, packet });
      commitWorkflowSelection(input.projectRoot, input.workflow.workflowId, current?.workflowSessionId, archived, next);
    };
    if (input.reloadGuard) {
      withWorkflowJournalTransaction(input.projectRoot, input.reloadGuard.workflowSessionId, (events) => { assertReloadGuard(input.projectRoot, input.reloadGuard!, events); commit(); });
    } else commit();
    link = next;
  };
  try {
    created = await input.adapter.create({
      projectRoot: input.projectRoot,
      parentSession: normal.piSessionFile,
      name: `hive:${input.workflow.workflowId}:${input.workflow.activationHash.slice(0, 8)}`,
      workflowId: input.workflow.workflowId,
      activationHash: input.workflow.activationHash,
    });
    await commitCreated(created);
    navigationInvariant(link, "Workflow link generation is unavailable after durable commit");
    const result = await input.adapter.switch({
      piSessionFile: created.piSessionFile,
      withSession: async () => {},
      replacement: {
        projectRoot: input.projectRoot,
        projectId: input.projectId,
        piSessionId: created.piSessionId,
        ...(restoreSession ? { restoreSession } : {}),
        generation: Object.freeze({ workflowSessionId: link.workflowSessionId, linkGenerationHash: workflowLinkGenerationHash(link) }),
      },
    });
    if (result.cancelled) throw new Error("Workflow Pi session creation cancelled");
  } catch (error) {
    // A replacement whose restoration cannot be proven remains recovery
    // authority; every failure while the original/compensated context is valid
    // rolls back before the exact precreated transcript is removed.
    if (link && isUnprovenSessionRestoration(error)) throw error;
    const cleanupErrors: unknown[] = [];
    if (staged?.staged) {
      try { clearStagedHandoff({ projectRoot: input.projectRoot, projectId: input.projectId, targetSessionId: workflowSessionId, expectedPacketHash: packet!.packetHash }); }
      catch (cleanupError) { cleanupErrors.push(new Error(`staged handoff compensation failed: ${String(cleanupError instanceof Error ? cleanupError.message : cleanupError)}`)); }
    }
    if (link) {
      try { rollbackWorkflowSelection(input.projectRoot, link, current); link = undefined; }
      catch (cleanupError) { cleanupErrors.push(new Error(`workflow link compensation failed: ${String(cleanupError instanceof Error ? cleanupError.message : cleanupError)}`)); }
    }
    if (!settleRuntimeOwnershipRelease(input.projectRoot, workflowSessionId, replacementOwnership.generation)) cleanupErrors.push(new Error("new workflow runtime ownership release failed"));
    if (current && previousOwnership?.state === "acquired" && !settleRuntimeOwnershipRelease(input.projectRoot, current.workflowSessionId, previousOwnership.generation)) cleanupErrors.push(new Error("previous workflow runtime ownership release failed"));
    if (created && input.adapter.cleanup) {
      try { await input.adapter.cleanup({ projectRoot: input.projectRoot, created }); }
      catch (cleanupError) { cleanupErrors.push(new Error(`precreated Pi session cleanup failed: ${String(cleanupError instanceof Error ? cleanupError.message : cleanupError)}`)); }
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "Workflow selection failed and compensation was incomplete");
    throw error;
  }
  navigationInvariant(link, "Workflow session link was not committed before session restoration");
  navigationInvariant(!current || (previousOwnership && settleRuntimeOwnershipRelease(input.projectRoot, current.workflowSessionId, previousOwnership.generation)), "Previous runtime ownership could not be released");
  event(input.projectRoot, input.projectId, workflowSessionId, "session.created", { workflowId: input.workflow.workflowId }); event(input.projectRoot, input.projectId, workflowSessionId, "session.linked", { normalParentId: normal.piSessionId }); return Object.freeze({ kind: "created", link });
}
export interface ResolveHandoffSourceInput {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly runId: string | "last";
  readonly currentPiSessionId: string;
}
export function resolveHandoffSource(input: ResolveHandoffSourceInput): HandoffPacket {
  const normal = normalLink(input.projectRoot);
  navigationInvariant(normal.projectId === input.projectId, "Handoff source belongs to a different canonical project");
  const workflowLinks = listSessionLinks(input.projectRoot).filter((entry): entry is WorkflowSessionLink => entry.kind === "workflow");
  const candidates = input.runId === "last"
    ? (() => {
        const selected = workflowLinks.find((entry) => entry.piSessionId === input.currentPiSessionId);
        if (!selected) throw new Error("Handoff 'last' requires a currently selected source workflow; normal chat must use an explicit run ID");
        return [selected];
      })()
    : workflowLinks;
  const matches: Array<{ link: WorkflowSessionLink; terminal: ReturnType<typeof terminalEnvelopeFromEvent>; sequence: number }> = [];
  let sawNonterminal = false;
  for (const link of candidates) {
    const events = readWorkflowJournal(input.projectRoot, link.workflowSessionId);
    navigationInvariant(!events.some((event) => event.projectId !== input.projectId), "Handoff source journal belongs to a different canonical project");
    replayWorkflowJournal(events, createEmptyRunLifecycleState(link.workflowSessionId), reduceRunLifecycle);
    const terminals = events.filter((event) => event.type === "terminal.recorded" && event.runId);
    if (input.runId === "last") {
      const latest = terminals.at(-1);
      if (latest) matches.push({ link, terminal: terminalEnvelopeFromEvent(latest), sequence: latest.sequence });
      else sawNonterminal = events.some((event) => event.type === "run.started");
      continue;
    }
    const terminal = terminals.find((event) => event.runId === input.runId);
    if (terminal) matches.push({ link, terminal: terminalEnvelopeFromEvent(terminal), sequence: terminal.sequence });
    else if (events.some((event) => event.type === "run.started" && event.runId === input.runId)) sawNonterminal = true;
  }
  navigationInvariant(matches.length, sawNonterminal ? "Handoff source run is not terminal" : "Handoff source run is missing");
  navigationInvariant(matches.length === 1, "Handoff source run ID is ambiguous within the project");
  const match = matches.sort((left, right) => right.sequence - left.sequence)[0];
  navigationInvariant(match.terminal.snapshotId === match.link.activationHash, "Handoff source terminal snapshot does not match its linked activation");
  return createHandoffPacket({ projectId: input.projectId, workflowId: match.link.workflowId, sessionId: match.link.workflowSessionId, terminal: match.terminal, createdAt: match.terminal.finishedAt });
}

export interface PreparedReloadActivation {
  readonly workflow: SelectableWorkflow;
  /** Re-probe the prepared source identity after Pi session creation and before the link CAS. */
  readonly validateBeforeCommit?: () => void | Promise<void>;
}
export interface ReloadWorkflowSessionInput {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly currentPiSessionId: string;
  readonly adapter: SessionNavigationAdapter;
  readonly owner: AcquireOwnershipOptions & { nonce: string };
  readonly prepareActivation: () => PreparedReloadActivation | Promise<PreparedReloadActivation>;
}
export async function reloadWorkflowSession(input: ReloadWorkflowSessionInput): Promise<SelectionResult> {
  const current = listSessionLinks(input.projectRoot).find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.status === "current" && entry.piSessionId === input.currentPiSessionId);
  if (!current) throw new Error("Reload requires the currently selected workflow session");
  const events = readWorkflowJournal(input.projectRoot, current.workflowSessionId);
  if (hasOpenRun(events)) throw new Error("Reload requires an idle workflow session");
  const staged = restoreStagedForReload(input.projectRoot, current.workflowSessionId);
  const guard = reloadGuardFor(current, events, staged?.packetHash);
  const prepared = await input.prepareActivation();
  if (prepared.workflow.workflowId !== current.workflowId || prepared.workflow.source !== "current" || !prepared.workflow.freshEnabled) throw new Error("Reload activation validation did not produce a current fresh-compatible workflow");
  assertReloadGuard(input.projectRoot, guard);
  return selectWorkflowSession({
    projectRoot: input.projectRoot, projectId: input.projectId, currentPiSessionId: input.currentPiSessionId,
    workflow: prepared.workflow, fresh: true, ...(staged ? { stagedHandoff: staged } : {}), adapter: input.adapter, owner: input.owner, reloadGuard: guard,
    ...(prepared.validateBeforeCommit ? { beforeCommit: prepared.validateBeforeCommit } : {}),
  });
}
function restoreStagedForReload(projectRoot: string, sessionId: string): HandoffPacket | undefined {
  return readHandoffState(projectRoot, sessionId).staged;
}

export async function exitWorkflowSession(input: { projectRoot: string; currentPiSessionId: string; ownerNonce: string; adapter: SessionNavigationAdapter }): Promise<{ piSessionId: string; activeTools: readonly string[] }> {
  const links = listSessionLinks(input.projectRoot); const current = links.find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.piSessionId === input.currentPiSessionId); const normal = normalLink(input.projectRoot);
  let ownership: RuntimeOwner | undefined;
  if (current) {
    if (!heartbeatRuntimeOwnership(input.projectRoot, current.workflowSessionId, input.ownerNonce)) throw new Error("Runtime ownership does not match exit request");
    ownership = captureRuntimeOwnership(input.projectRoot, current.workflowSessionId, input.ownerNonce);
    navigationInvariant(ownership, "Runtime ownership changed before exit");
  }
  const result = await input.adapter.switch({ piSessionFile: normal.piSessionFile, withSession: async () => {} }); if (result.cancelled) throw new Error("Session switch cancelled");
  navigationInvariant(!current || (ownership && settleRuntimeOwnershipRelease(input.projectRoot, current.workflowSessionId, ownership)), "Runtime ownership release failed");
  return Object.freeze({ piSessionId: normal.piSessionId, activeTools: normal.normalTools });
}
