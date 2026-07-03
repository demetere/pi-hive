import { randomUUID } from "node:crypto";
import { handleReviewSurface, registerReviewSurface, type ReviewContext, type ReviewSurface } from "../../engine/review";
import { parseRid } from "../../engine/review";
import * as openspec from "../../engine/openspec";
import { insertPlanVerdict } from "./db";
import { enqueueDashboardAction, resolveProjectCwd } from "./plan-bridge";

// Bun-side wiring for the self-hosted Plannotator plan-review surface. Builds the
// ReviewHooks with SQLite verdict persistence + the dashboard-actions bridge, and
// exposes a single dispatcher the server calls early in its fetch handler.
//
// pi-hive OWNS the approval gate: approve/deny record a verdict in plan_verdicts
// (keyed on the OpenSpec change name, reviewer "ui") and round-trip to the live
// session via dashboard-actions. There is no OpenSpec mutation — OpenSpec is the
// store + validator; approval is pi-hive state.

const PLAN_REVIEW_MOUNT = "/pl-review/";

function isTasksArtifact(artifact: string): boolean {
  return artifact === "tasks.md" || artifact === "tasks";
}

function recordVerdict(ctx: ReviewContext, verdict: "green" | "red", feedback: string): void {
  insertPlanVerdict({
    id: randomUUID(),
    changeId: ctx.change,
    reviewer: "ui",
    verdict,
    summary: feedback ? feedback.slice(0, 2000) : undefined,
    cwd: ctx.cwd,
    createdAt: new Date().toISOString(),
  });
}

const surface: ReviewSurface | null = registerReviewSurface({
  mountPath: PLAN_REVIEW_MOUNT,
  hooks: {
    resolveContext(rid, cwdParam) {
      const parsed = parseRid(rid);
      if (!parsed) return null;
      const cwd = resolveProjectCwd(cwdParam);
      if (!cwd || !openspec.changeExists(cwd, parsed.change)) return null;
      return { cwd, change: parsed.change, artifact: parsed.artifact };
    },
    onApprove(ctx, feedback) {
      recordVerdict(ctx, "green", feedback);
      // Approving the tasks artifact opens pi-hive's execution gate (the sidecar
      // the core dispatch gate reads). Other artifacts just advance the planning
      // loop.
      if (isTasksArtifact(ctx.artifact)) openspec.setExecutionApproval(ctx.cwd, ctx.change, true);
      // Unblock the live session: the artifact's gate is satisfied; the planner
      // proceeds to the next ready artifact (or /hive-execute once tasks pass).
      enqueueDashboardAction(ctx.cwd, {
        type: "plan_review_approved",
        changeId: ctx.change,
        artifact: ctx.artifact,
        readyToExecute: isTasksArtifact(ctx.artifact) && openspec.isReadyToExecute(ctx.cwd, ctx.change),
        feedback: feedback || undefined,
      });
    },
    onDeny(ctx, feedback) {
      recordVerdict(ctx, "red", feedback);
      // Denying the tasks artifact revokes execution approval; the gate holds
      // until a revised artifact is re-approved.
      if (isTasksArtifact(ctx.artifact)) openspec.setExecutionApproval(ctx.cwd, ctx.change, false);
      // Route feedback back to the planning agent.
      enqueueDashboardAction(ctx.cwd, {
        type: "plan_review_denied",
        changeId: ctx.change,
        artifact: ctx.artifact,
        feedback: feedback || "Artifact rejected by reviewer.",
      });
    },
  },
});

// Whether the plan-review surface is available (vendored HTML present).
export function planReviewAvailable(): boolean {
  return surface !== null;
}

// Dispatch a request to the plan-review surface. Returns null if the path is not
// part of the surface (server continues its own routing). Applies no token check
// — the surface enforces same-origin at the caller; see review.ts.
export async function handlePlanReview(req: Request, url: URL): Promise<Response | null> {
  if (!surface) return null;
  return handleReviewSurface(surface, req, url);
}
