export const WORKFLOW_SELECTOR_LIMITS = Object.freeze({ items: 4_096, diagnosticBytes: 2_048, aggregateBytes: 262_144 });
export interface WorkflowSelectorHandoffStatus { readonly packetHash: string; readonly sourceWorkflowId: string; readonly sourceRunId: string }
export type WorkflowSelectorSessionState = "none" | "idle" | "open" | "orphaned" | "archived";
export type WorkflowSelectorRecoveryState = "none" | "available" | "blocked" | "recovered";
export interface WorkflowSelectorInput {
  readonly workflowId: string;
  readonly name?: string;
  readonly source: "current" | "stale" | "missing" | "invalid";
  readonly resumable: boolean;
  readonly freshEnabled: boolean;
  readonly diagnostics: readonly string[];
  readonly prompt?: string;
  readonly stagedHandoff?: WorkflowSelectorHandoffStatus;
  readonly currentSessionState?: WorkflowSelectorSessionState;
  readonly archiveCount?: number;
  readonly recoveryState?: WorkflowSelectorRecoveryState;
  /** Presentation hint only. Deliberately not copied to the selector status DTO. */
  readonly suggestedNext?: readonly string[];
}
export interface WorkflowSelectorRow {
  readonly id: string;
  readonly name?: string;
  readonly source: WorkflowSelectorInput["source"];
  readonly sourceStale: boolean;
  readonly status: "available" | "invalid" | "resumable-stale";
  readonly resumable: boolean;
  readonly freshEnabled: boolean;
  readonly stagedHandoff?: WorkflowSelectorHandoffStatus;
  readonly currentSessionState: WorkflowSelectorSessionState;
  readonly archiveCount: number;
  readonly recoveryState: WorkflowSelectorRecoveryState;
  readonly diagnostics: readonly string[];
  readonly truncated: boolean;
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function truncateUtf8(value: string, bytes: number): string { if (Buffer.byteLength(value) <= bytes) return value; let out = ""; for (const char of value) { if (Buffer.byteLength(out + char + "…") > bytes) break; out += char; } return `${out}…`; }
function handoffStatus(input: WorkflowSelectorHandoffStatus | undefined): WorkflowSelectorHandoffStatus | undefined {
  if (!input) return undefined;
  return Object.freeze({ packetHash: truncateUtf8(String(input.packetHash), 64), sourceWorkflowId: truncateUtf8(String(input.sourceWorkflowId), 256), sourceRunId: truncateUtf8(String(input.sourceRunId), 256) });
}
export function buildWorkflowSelector(inputs: readonly WorkflowSelectorInput[]): readonly WorkflowSelectorRow[] {
  const rows: WorkflowSelectorRow[] = [];
  let bytes = 2;
  for (const input of [...inputs].sort((a, b) => compare(a.workflowId, b.workflowId)).slice(0, WORKFLOW_SELECTOR_LIMITS.items)) {
    const diagnostics = input.diagnostics.slice(0, 16).map((value) => truncateUtf8(value, WORKFLOW_SELECTOR_LIMITS.diagnosticBytes));
    const archiveCount = Number.isSafeInteger(input.archiveCount) && Number(input.archiveCount) >= 0 ? Math.min(Number(input.archiveCount), 4_096) : 0;
    const currentSessionState = input.currentSessionState ?? "none";
    const recoveryState = input.recoveryState ?? (currentSessionState === "orphaned" ? "available" : "none");
    const stagedHandoff = handoffStatus(input.stagedHandoff);
    const row: WorkflowSelectorRow = Object.freeze({
      id: truncateUtf8(input.workflowId, 256),
      ...(input.name ? { name: truncateUtf8(input.name, 512) } : {}),
      source: input.source,
      sourceStale: input.source === "stale",
      status: input.resumable && input.source !== "current" ? "resumable-stale" : input.source === "current" ? "available" : "invalid",
      resumable: input.resumable,
      freshEnabled: input.freshEnabled,
      ...(stagedHandoff ? { stagedHandoff } : {}),
      currentSessionState,
      archiveCount,
      recoveryState,
      diagnostics: Object.freeze(diagnostics),
      truncated: diagnostics.length < input.diagnostics.length,
    });
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > WORKFLOW_SELECTOR_LIMITS.aggregateBytes) break;
    rows.push(row);
    bytes += size;
  }
  return Object.freeze(rows);
}
