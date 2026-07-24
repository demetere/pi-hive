import type { WorkflowTelemetryEvent } from "../observability/events";
import type { ProjectionStreamStatus, WorkflowProjectionCurrent, WorkflowProjectionCurrentRow, WorkflowProjectionUsageTotals } from "../observability/projection";

export const WORKFLOW_DASHBOARD_API_VERSION = 1 as const;
export const WORKFLOW_DASHBOARD_MAX_PAGE_SIZE = 500 as const;
export const WORKFLOW_DASHBOARD_MAX_BODY_BYTES = 65_536 as const;
export type WorkflowDashboardResource = "projects" | "workflows" | "sessions" | "runs" | "nodes" | "tasks" | "artifacts" | "checkpoints" | "questions" | "approvals" | "knowledge";
export interface WorkflowDashboardResourcePage { readonly apiVersion: 1; readonly resource: WorkflowDashboardResource; readonly items: readonly WorkflowProjectionCurrentRow[]; readonly nextCursor?: string; readonly hasMore: boolean }
export interface WorkflowDashboardError { readonly apiVersion: 1; readonly error: Readonly<{ code: string; message: string }> }
export interface WorkflowDashboardHistoryPage { readonly apiVersion: 1; readonly items: readonly WorkflowTelemetryEvent[]; readonly nextCursor?: string; readonly hasMore: boolean }
export interface WorkflowDashboardCurrentResponse { readonly apiVersion: 1; readonly current: WorkflowProjectionCurrent; readonly streams: readonly ProjectionStreamStatus[] }
export interface WorkflowDashboardCurrentPage { readonly apiVersion: 1; readonly kind: keyof WorkflowProjectionCurrent; readonly items: readonly WorkflowProjectionCurrentRow[]; readonly nextCursor?: string; readonly hasMore: boolean }
export interface WorkflowDashboardUsageResponse { readonly apiVersion: 1; readonly usage: WorkflowProjectionUsageTotals }
export interface WorkflowDashboardProjectionMaintenance { readonly apiVersion: 1; readonly operation: "rebuild" | "prune"; readonly events: number; readonly streams: number; readonly completedAt: string }
