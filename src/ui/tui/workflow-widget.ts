import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createEmptyCheckpointApprovalState, reduceCheckpointApprovalState } from "../../artifacts/approvals";
import { readActivationSnapshot } from "../../config/index";
import { createBudgetState, effectiveRuntimeBudgetLimitsFromSnapshot, reduceBudgetState } from "../../workflows/budgets";
import { createDelegationState, reduceDelegationState } from "../../workflows/delegation";
import { readWorkflowJournal } from "../../workflows/journal";
import { createEmptyQuestionState, reduceQuestionState } from "../../workflows/questions";
import { createEmptyRunLifecycleState, reduceRunLifecycle } from "../../workflows/runs";
import type { WorkflowSessionLink } from "../../workflows/sessions";

export interface WorkflowStatusSummary {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly activationHash?: string;
  readonly sessionState?: "current" | "archived" | "stale" | "orphaned";
  readonly runId?: string;
  readonly runStatus?: string;
  readonly workspaceId?: string;
  readonly tasks?: Readonly<{ done: number; total: number; active?: number }>;
  readonly pendingQuestions?: number;
  readonly pendingApprovals?: number;
  readonly budget?: Readonly<{ tokensUsed?: number; tokensLimit?: number; costMicroUsd?: number; activeMs?: number }>;
}

const WIDGET_ID = "hive-workflow";
const MAX_LINE_CHARS = 240;
const MAX_LINES = 3;

/** Restore widget state exclusively from the immutable activation and durable journal. */
export function restoreWorkflowStatusSummary(projectRoot: string, link: WorkflowSessionLink): WorkflowStatusSummary {
  const snapshot = readActivationSnapshot(projectRoot, link.activationHash);
  const events = readWorkflowJournal(projectRoot, link.workflowSessionId);
  const run = events.reduce(reduceRunLifecycle, createEmptyRunLifecycleState(link.workflowSessionId)).latestRun;
  const workflow = snapshot.payload.workflow as { name?: unknown; team?: { rootId?: unknown } };
  const base: WorkflowStatusSummary = {
    workflowId: link.workflowId,
    workflowName: typeof workflow.name === "string" && workflow.name ? workflow.name : link.workflowId,
    activationHash: link.activationHash,
    sessionState: link.orphaned ? "orphaned" : link.stale ? "stale" : link.status,
    ...(run ? { runId: run.runId, runStatus: run.status } : {}),
    ...(run?.artifactWorkspace ? { workspaceId: run.artifactWorkspace.workspace.id } : {}),
  };
  if (!run) return base;
  const delegation = events.reduce(reduceDelegationState, createDelegationState(link.workflowSessionId, run.runId, snapshot));
  const tasks = Object.values(delegation.tasks);
  const questions = events.reduce(reduceQuestionState, createEmptyQuestionState(link.workflowSessionId, run.runId));
  const approvals = events.reduce(reduceCheckpointApprovalState, createEmptyCheckpointApprovalState());
  const limits = effectiveRuntimeBudgetLimitsFromSnapshot(snapshot);
  const rootNodeId = String(workflow.team?.rootId ?? "");
  const budget = events.reduce(reduceBudgetState, createBudgetState(link.workflowSessionId, run.runId, rootNodeId, limits));
  return {
    ...base,
    tasks: { done: tasks.filter((task) => task.queueState === "terminal").length, total: tasks.length, active: tasks.filter((task) => task.queueState === "active").length },
    pendingQuestions: Object.values(questions.questions).filter((question) => question.state === "pending").length,
    pendingApprovals: approvals.requestOrder.map((id) => approvals.requests[id]).filter((request) => request?.runId === run.runId && !request.decision).length,
    budget: { tokensUsed: budget.run.tokens, tokensLimit: budget.limits.run.tokenBudget, activeMs: budget.run.activeWallTimeMs },
  };
}

function short(value: string | undefined, length = 20): string | undefined {
  if (!value) return undefined;
  return value.length <= length ? value : `${value.slice(0, Math.max(1, length - 1))}…`;
}

function amount(value: number | undefined): string | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.floor(value)).toLocaleString("en-US");
}

export function renderWorkflowStatusLines(summary: WorkflowStatusSummary): readonly string[] {
  const state = [summary.sessionState, summary.runStatus].filter(Boolean).join(" / ") || "idle";
  const title = `${summary.workflowName} (${summary.workflowId}) · ${state}`;
  const work = [
    summary.runId ? `run ${short(summary.runId)}` : "no open run",
    summary.workspaceId ? `workspace ${short(summary.workspaceId)}` : undefined,
    summary.tasks ? `tasks ${amount(summary.tasks.done)}/${amount(summary.tasks.total)}${summary.tasks.active ? ` (${amount(summary.tasks.active)} active)` : ""}` : undefined,
    `questions ${amount(summary.pendingQuestions ?? 0)}`,
    `approvals ${amount(summary.pendingApprovals ?? 0)}`,
  ].filter(Boolean).join(" · ");
  const budget = summary.budget ? [
    summary.budget.tokensUsed !== undefined ? `tokens ${amount(summary.budget.tokensUsed)}${summary.budget.tokensLimit !== undefined ? `/${amount(summary.budget.tokensLimit)}` : ""}` : undefined,
    summary.budget.costMicroUsd !== undefined ? `cost $${(summary.budget.costMicroUsd / 1_000_000).toFixed(4)}` : undefined,
    summary.budget.activeMs !== undefined ? `active ${amount(summary.budget.activeMs)}ms` : undefined,
    summary.activationHash ? `activation ${short(summary.activationHash, 12)}` : undefined,
  ].filter(Boolean).join(" · ") : (summary.activationHash ? `activation ${short(summary.activationHash, 12)}` : "");
  return [title, work, budget].filter(Boolean).slice(0, MAX_LINES).map((line) => line.slice(0, MAX_LINE_CHARS));
}

export function clearWorkflowStatusUi(ctx: ExtensionContext): boolean {
  if (ctx.mode !== "tui" || !ctx.hasUI) return true;
  let restored = true;
  try { ctx.ui.setWidget(WIDGET_ID, undefined); } catch { restored = false; }
  try { ctx.ui.setStatus(WIDGET_ID, undefined); } catch { restored = false; }
  return restored;
}

export function updateWorkflowStatusUi(ctx: ExtensionContext, summary: WorkflowStatusSummary | undefined): boolean {
  if (ctx.mode !== "tui" || !ctx.hasUI) return true;
  if (!summary) return clearWorkflowStatusUi(ctx);
  try {
    const lines = renderWorkflowStatusLines(summary);
    ctx.ui.setStatus(WIDGET_ID, `${summary.workflowId}: ${summary.runStatus || "idle"}`);
    ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        return lines.map((line, index) => truncateToWidth(index === 0 ? theme.fg("accent", theme.bold(line)) : theme.fg("dim", line), Math.max(0, width)));
      },
    }));
    return true;
  } catch {
    clearWorkflowStatusUi(ctx);
    return false;
  }
}
