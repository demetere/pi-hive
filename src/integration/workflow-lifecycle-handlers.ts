import type { SnapshotCompatibilityRuntime } from "../config/snapshot-compat";
import type { AcquireOwnershipOptions } from "../workflows/ownership";
import {
  reloadWorkflowSession,
  resolveHandoffSource,
  selectWorkflowSession,
  type PreparedReloadActivation,
  type SelectableWorkflow,
  type SelectionResult,
  type SessionNavigationAdapter,
} from "../workflows/navigation";
import { clearStagedHandoff, type HandoffPacket } from "../workflows/handoff";
import {
  detectOrphanedWorkflowSessions,
  recoverOrphanedWorkflowSession,
  type RecoverOrphanedWorkflowSessionInput,
} from "../workflows/recovery";

export interface WorkflowLifecycleRecoveryDependencies {
  readonly runtime: () => SnapshotCompatibilityRuntime;
  readonly currentPiSessionFile: () => string;
}
export interface WorkflowLifecycleServiceHandlerOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly currentPiSessionId: () => string;
  readonly adapter: SessionNavigationAdapter;
  readonly owner: () => AcquireOwnershipOptions & { nonce: string };
  /** Recovery remains unavailable unless every mandatory compatibility/navigation dependency is bound. */
  readonly recovery?: WorkflowLifecycleRecoveryDependencies;
}
export interface WorkflowLifecycleSelectRequest {
  readonly workflow: SelectableWorkflow;
  readonly fresh?: boolean;
  readonly from?: string | "last";
  /** Packet-shaped input is always re-derived from its same-project source journal before use. */
  readonly packet?: HandoffPacket;
}
export interface WorkflowLifecycleServiceHandlers {
  select(input: WorkflowLifecycleSelectRequest): Promise<SelectionResult>;
  clearHandoff(targetSessionId: string, expectedPacketHash?: string): ReturnType<typeof clearStagedHandoff>;
  reload(prepareActivation: () => PreparedReloadActivation | Promise<PreparedReloadActivation>): Promise<SelectionResult>;
  detectOrphans(): ReturnType<typeof detectOrphanedWorkflowSessions>;
  recover(workflowSessionId: string, options?: Pick<RecoverOrphanedWorkflowSessionInput, "validateActivation">): ReturnType<typeof recoverOrphanedWorkflowSession>;
}

/**
 * Typed schema-v1 command services. W26 owns argument parsing, registration, and
 * TUI/headless presentation; constructing these handlers has no side effects.
 */
export function createWorkflowLifecycleServiceHandlers(options: WorkflowLifecycleServiceHandlerOptions): WorkflowLifecycleServiceHandlers {
  return Object.freeze({
    async select(input: WorkflowLifecycleSelectRequest): Promise<SelectionResult> {
      if (input.from !== undefined && input.packet !== undefined) throw new Error("Select accepts either a source selector or a verified packet, not both");
      const stagedHandoff = input.packet ?? (input.from === undefined ? undefined : resolveHandoffSource({
        projectRoot: options.projectRoot, projectId: options.projectId, runId: input.from, currentPiSessionId: options.currentPiSessionId(),
      }));
      return selectWorkflowSession({
        projectRoot: options.projectRoot, projectId: options.projectId, currentPiSessionId: options.currentPiSessionId(), workflow: input.workflow,
        ...(input.fresh ? { fresh: true } : {}), ...(stagedHandoff ? { stagedHandoff } : {}), adapter: options.adapter, owner: options.owner(),
      });
    },
    clearHandoff(targetSessionId: string, expectedPacketHash?: string) {
      return clearStagedHandoff({ projectRoot: options.projectRoot, projectId: options.projectId, targetSessionId, ...(expectedPacketHash ? { expectedPacketHash } : {}) });
    },
    reload(prepareActivation: () => PreparedReloadActivation | Promise<PreparedReloadActivation>) {
      return reloadWorkflowSession({ projectRoot: options.projectRoot, projectId: options.projectId, currentPiSessionId: options.currentPiSessionId(), adapter: options.adapter, owner: options.owner(), prepareActivation });
    },
    detectOrphans() { return detectOrphanedWorkflowSessions({ projectRoot: options.projectRoot, projectId: options.projectId }); },
    recover(workflowSessionId: string, recoveryOptions: Pick<RecoverOrphanedWorkflowSessionInput, "validateActivation"> = {}) {
      if (!options.recovery) throw new Error("Workflow recovery is blocked because mandatory runtime and Pi navigation dependencies are unavailable");
      const runtime = options.recovery.runtime();
      const restorePiSessionFile = options.recovery.currentPiSessionFile();
      if (!runtime || !restorePiSessionFile) throw new Error("Workflow recovery is blocked because mandatory runtime and Pi navigation dependencies are incomplete");
      return recoverOrphanedWorkflowSession({ projectRoot: options.projectRoot, projectId: options.projectId, workflowSessionId, adapter: options.adapter, owner: options.owner(), runtime, restorePiSessionFile, ...recoveryOptions });
    },
  });
}
