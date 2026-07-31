import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SessionReplacementLinkGeneration {
  readonly workflowSessionId: string;
  readonly linkGenerationHash: string;
}

interface SessionReplacementIdentity extends SessionReplacementLinkGeneration {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly piSessionId: string;
  readonly nonce: string;
}

interface ObservedSessionStart {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly piSessionId: string;
}

interface PendingSessionReplacementAcknowledgement {
  readonly expected: SessionReplacementIdentity;
  observed?: ObservedSessionStart;
  observationMismatch?: boolean;
  acknowledged?: SessionReplacementIdentity;
}

const SESSION_REPLACEMENT_ACKNOWLEDGEMENTS_KEY = Symbol.for("pi-hive.session-replacement-acknowledgements.v1");
type ProcessSessionReplacementState = typeof globalThis & { [SESSION_REPLACEMENT_ACKNOWLEDGEMENTS_KEY]?: Map<string, PendingSessionReplacementAcknowledgement> };
const processSessionReplacementState = globalThis as ProcessSessionReplacementState;
const existingSessionReplacementAcknowledgements = processSessionReplacementState[SESSION_REPLACEMENT_ACKNOWLEDGEMENTS_KEY];
if (existingSessionReplacementAcknowledgements !== undefined && !(existingSessionReplacementAcknowledgements instanceof Map)) {
  throw new Error("Process session replacement acknowledgement state is invalid");
}
const sessionReplacementAcknowledgements = existingSessionReplacementAcknowledgements ?? new Map<string, PendingSessionReplacementAcknowledgement>();
processSessionReplacementState[SESSION_REPLACEMENT_ACKNOWLEDGEMENTS_KEY] = sessionReplacementAcknowledgements;

function sameIdentity(left: SessionReplacementIdentity, right: SessionReplacementIdentity): boolean {
  return left.projectRoot === right.projectRoot
    && left.projectId === right.projectId
    && left.piSessionId === right.piSessionId
    && left.workflowSessionId === right.workflowSessionId
    && left.linkGenerationHash === right.linkGenerationHash
    && left.nonce === right.nonce;
}

export interface SessionReplacementAcknowledgementResult {
  readonly acknowledged: boolean;
  readonly sessionStartObserved: boolean;
  readonly observed?: ObservedSessionStart;
}

/** Register an exact process-local expectation after commit and before native replacement. */
export function expectSessionReplacementAcknowledgement(input: Readonly<{
  projectRoot: string;
  projectId: string;
  piSessionId: string;
  generation: SessionReplacementLinkGeneration;
}>): Readonly<{ finish(): SessionReplacementAcknowledgementResult }> {
  const expected: SessionReplacementIdentity = Object.freeze({
    projectRoot: input.projectRoot,
    projectId: input.projectId,
    piSessionId: input.piSessionId,
    workflowSessionId: input.generation.workflowSessionId,
    linkGenerationHash: input.generation.linkGenerationHash,
    nonce: randomUUID(),
  });
  const pending: PendingSessionReplacementAcknowledgement = { expected };
  sessionReplacementAcknowledgements.set(expected.nonce, pending);
  let finished = false;
  return Object.freeze({
    finish(): SessionReplacementAcknowledgementResult {
      if (finished) return Object.freeze({ acknowledged: false, sessionStartObserved: false });
      finished = true;
      if (sessionReplacementAcknowledgements.get(expected.nonce) === pending) sessionReplacementAcknowledgements.delete(expected.nonce);
      const acknowledged = pending.observationMismatch !== true && pending.acknowledged !== undefined && sameIdentity(pending.acknowledged, expected);
      return Object.freeze({
        acknowledged,
        sessionStartObserved: pending.observed !== undefined,
        ...(pending.observed ? { observed: pending.observed } : {}),
      });
    },
  });
}

/** Record that replacement reached a newly loaded extension, without granting success. */
export function observeSessionReplacementStart(projectRoot: string, projectId: string, ctx: ExtensionContext): void {
  if (!sessionReplacementAcknowledgements.size) return;
  const observed = Object.freeze({ projectRoot, projectId, piSessionId: ctx.sessionManager.getSessionId() });
  for (const pending of sessionReplacementAcknowledgements.values()) {
    pending.observed = observed;
    if (pending.expected.projectRoot !== projectRoot || pending.expected.projectId !== projectId || pending.expected.piSessionId !== observed.piSessionId) pending.observationMismatch = true;
  }
}

/** Publish success only after the selected session has restored every runtime surface. */
export function acknowledgeSessionReplacementStart(
  projectRoot: string,
  projectId: string,
  ctx: ExtensionContext,
  generation: SessionReplacementLinkGeneration,
): void {
  if (!sessionReplacementAcknowledgements.size) return;
  const piSessionId = ctx.sessionManager.getSessionId();
  for (const pending of sessionReplacementAcknowledgements.values()) {
    const actual: SessionReplacementIdentity = Object.freeze({
      projectRoot,
      projectId,
      piSessionId,
      workflowSessionId: generation.workflowSessionId,
      linkGenerationHash: generation.linkGenerationHash,
      nonce: pending.expected.nonce,
    });
    if (sameIdentity(actual, pending.expected)) pending.acknowledged = actual;
  }
}
