import type { CancellationResult } from "./runs";
import { workflowJournalIdentity } from "./journal";
import { heartbeatCurrentRuntimeOwnership } from "./ownership";

export interface LiveWorkflowCancellationAuthority {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly snapshotId: string;
  readonly runtimeOwnerNonce: string;
  currentRunId(): string | undefined;
  cancel(reason: string): Promise<CancellationResult>;
}

export interface LiveWorkflowCancellationIdentity {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly snapshotId: string;
  readonly runId: string;
}

const authorities = new Map<string, Array<Readonly<{ token: symbol; authority: LiveWorkflowCancellationAuthority }>>>();

function key(projectRoot: string, sessionId: string): string {
  return workflowJournalIdentity(projectRoot, sessionId);
}

/**
 * Process-local bridge from command control to the runtime that owns worker and
 * lease settlement. Newer reconstructions are preferred, while token-bound
 * disposal cannot unregister another authority and an invalid entry cannot
 * shadow a still-current exact owner.
 */
export function registerLiveWorkflowCancellationAuthority(authority: LiveWorkflowCancellationAuthority): () => void {
  const token = Symbol("live-workflow-cancellation-authority");
  const authorityKey = key(authority.projectRoot, authority.sessionId);
  const entries = authorities.get(authorityKey) ?? [];
  entries.push(Object.freeze({ token, authority }));
  authorities.set(authorityKey, entries);
  return () => {
    const current = authorities.get(authorityKey);
    if (!current) return;
    const remaining = current.filter((entry) => entry.token !== token);
    if (remaining.length) authorities.set(authorityKey, remaining);
    else authorities.delete(authorityKey);
  };
}

/** Resolve only an exact journal/snapshot/run identity held by this process. */
export function resolveLiveWorkflowCancellationAuthority(identity: LiveWorkflowCancellationIdentity): LiveWorkflowCancellationAuthority | undefined {
  const entries = authorities.get(key(identity.projectRoot, identity.sessionId)) ?? [];
  for (const { authority } of [...entries].reverse()) {
    if (authority.projectId === identity.projectId
      && authority.sessionId === identity.sessionId
      && authority.snapshotId === identity.snapshotId
      && authority.currentRunId() === identity.runId
      && heartbeatCurrentRuntimeOwnership(identity.projectRoot, identity.sessionId, authority.runtimeOwnerNonce)) return authority;
  }
  return undefined;
}
